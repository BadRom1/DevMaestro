//! Lecture du dossier d'une session pour l'onglet Fichiers (v0.2, lot 3),
//! confinée à sa racine.
//!
//! Tout passe par `openat2(2)` depuis un descripteur de la racine, avec
//! `RESOLVE_BENEATH` (aucune résolution ne peut sortir de la racine : ni
//! `..`, ni chemin absolu, ni lien symbolique qui pointe dehors, y compris
//! s'il est remplacé entre deux appels) et `RESOLVE_NO_MAGICLINKS` :
//! - lire un fichier suit les liens symboliques **dans** la racine ; le
//!   fichier est d'abord ouvert en `O_PATH` (sans effet de bord) et doit être
//!   un fichier ordinaire (ni FIFO, ni périphérique, ni socket), puis rouvert
//!   pour la lecture ;
//! - lister un dossier et décrire une entrée ne suivent **aucun** lien
//!   (`RESOLVE_NO_SYMLINKS`, `O_NOFOLLOW`) : un lien vers un dossier est
//!   montré comme `symlink`, jamais parcouru.
//!
//! - écrire un fichier (v0.3, lot 7) ouvre son dossier parent sous la racine
//!   (liens internes suivis, jamais sous `.git`), puis tout se fait par
//!   rapport à ce descripteur, sur le seul dernier composant, sans suivre de
//!   lien : temporaire `O_EXCL` dans le même dossier, `fsync`, empreinte
//!   revérifiée, puis `renameat`.
//!
//! Noyau sans `openat2` (avant 5.6) : repli sur la résolution du chemin
//! (`canonicalize`) et une vérification qu'il reste dans la racine.

use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

use nix::errno::Errno;
use nix::fcntl::{OFlag, OpenHow, RenameFlags, ResolveFlag, open, openat, openat2, renameat2};
use nix::sys::stat::{Mode, SFlag, fchmod, fstat};
use nix::unistd::{AccessFlags, UnlinkatFlags, faccessat, unlinkat};

use crate::domain::diff::looks_binary;
use crate::domain::files::{EntryKind, FileVersion, MAX_READ_BYTES, is_git_dir, split_rel};
use crate::ports::{FileAccess, FileError, RawEntry, ReadFile};

/// Noms lus au plus dans un dossier (hors dépôt) avant tri et coupe.
const MAX_SCANNED: usize = 20_000;

/// [`FileAccess`] sur le système de fichiers.
#[derive(Debug, Clone, Copy, Default)]
pub struct FsFiles;

fn io(e: impl std::fmt::Display) -> FileError {
    FileError::Io(e.to_string())
}

fn from_errno(e: Errno) -> FileError {
    match e {
        Errno::ENOENT => FileError::NotFound,
        Errno::ENOTDIR => FileError::NotDir,
        Errno::EACCES | Errno::EPERM => FileError::Denied,
        Errno::EXDEV | Errno::ELOOP => {
            FileError::Outside("le chemin sort de la racine ou passe par un lien refusé".into())
        }
        e => io(e),
    }
}

fn root_fd(root: &Path) -> Result<OwnedFd, FileError> {
    open(
        root,
        OFlag::O_PATH | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC,
        Mode::empty(),
    )
    .map_err(from_errno)
}

/// `openat2` sous la racine ; `rel` vide : la racine elle-même.
fn open_beneath(
    root: &Path,
    rel: &str,
    flags: OFlag,
    resolve: ResolveFlag,
) -> Result<OwnedFd, FileError> {
    let rfd = root_fd(root)?;
    let target = if rel.is_empty() { "." } else { rel };
    let how = OpenHow::new()
        .flags(flags | OFlag::O_CLOEXEC)
        .resolve(resolve | ResolveFlag::RESOLVE_BENEATH | ResolveFlag::RESOLVE_NO_MAGICLINKS);
    match openat2(&rfd, target, how) {
        Err(Errno::ENOSYS) => {
            static WARNED: std::sync::atomic::AtomicBool =
                std::sync::atomic::AtomicBool::new(false);
            if !WARNED.swap(true, std::sync::atomic::Ordering::SeqCst) {
                crate::daemon::log::warning!(
                    "openat2 indisponible (noyau antérieur à 5.6) : onglet Fichiers confiné par \
                     résolution des chemins, moins robuste face à un lien remplacé entre deux appels"
                );
            }
            open_fallback(root, rel, flags, resolve)
        }
        r => r.map_err(from_errno),
    }
}

/// Repli sans `openat2` : chemin résolu, qui doit rester dans la racine.
fn open_fallback(
    root: &Path,
    rel: &str,
    flags: OFlag,
    resolve: ResolveFlag,
) -> Result<OwnedFd, FileError> {
    let lexical = root.join(rel);
    let no_symlinks = resolve.contains(ResolveFlag::RESOLVE_NO_SYMLINKS);
    // Dossier parent résolu, puis le dernier composant tel quel.
    let (parent, name) = match (lexical.parent(), lexical.file_name()) {
        (Some(p), Some(n)) if !rel.is_empty() => (p.to_path_buf(), Some(n.to_owned())),
        _ => (lexical.clone(), None),
    };
    let real_parent = parent.canonicalize().map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => FileError::NotFound,
        std::io::ErrorKind::PermissionDenied => FileError::Denied,
        _ => io(e),
    })?;
    if !real_parent.starts_with(root) || (no_symlinks && real_parent != parent) {
        return Err(FileError::Outside("le chemin sort de la racine".into()));
    }
    let path = match name {
        Some(n) => real_parent.join(n),
        None => real_parent,
    };
    if !flags.contains(OFlag::O_NOFOLLOW) && !no_symlinks {
        let real = path.canonicalize().map_err(|_| FileError::NotFound)?;
        if !real.starts_with(root) {
            return Err(FileError::Outside("le lien sort de la racine".into()));
        }
        return open(&real, flags | OFlag::O_CLOEXEC, Mode::empty()).map_err(from_errno);
    }
    open(
        &path,
        flags | OFlag::O_CLOEXEC | OFlag::O_NOFOLLOW,
        Mode::empty(),
    )
    .map_err(from_errno)
}

fn kind_of(mode: u32) -> Option<EntryKind> {
    match SFlag::from_bits_truncate(mode) & SFlag::S_IFMT {
        SFlag::S_IFDIR => Some(EntryKind::Dir),
        SFlag::S_IFREG => Some(EntryKind::File),
        SFlag::S_IFLNK => Some(EntryKind::Symlink),
        _ => None,
    }
}

fn proc_fd(fd: &OwnedFd) -> PathBuf {
    PathBuf::from(format!("/proc/self/fd/{}", fd.as_raw_fd()))
}

/// Date de modification en nanosecondes depuis l'époque Unix.
fn mtime_ns(meta: &std::fs::Metadata) -> i64 {
    meta.mtime()
        .saturating_mul(1_000_000_000)
        .saturating_add(meta.mtime_nsec())
}

/// Chemin réel d'un descripteur, relatif à la racine ; refusé hors de la
/// racine ou sous `.git`.
fn resolved_beneath(fd: &OwnedFd, root: &Path) -> Result<String, FileError> {
    let real = std::fs::read_link(proc_fd(fd)).map_err(io)?;
    let resolved = real
        .strip_prefix(root)
        .map_err(|_| FileError::Outside("le lien sort de la racine".into()))?
        .to_string_lossy()
        .into_owned();
    if resolved.split('/').any(is_git_dir) {
        return Err(FileError::Outside(
            "le dossier .git n'est pas accessible".into(),
        ));
    }
    Ok(resolved)
}

/// Ce qui ferait refuser d'avance l'écriture du fichier `rel` (déjà lu
/// comme fichier ordinaire sous la racine) : lien final, fichier ou dossier
/// en lecture seule. Indicatif : `write_beneath` revérifie tout.
fn write_obstacle(root: &Path, rel: &str) -> Option<String> {
    let (parent, name) = split_rel(rel);
    let Ok(dir) = open_beneath(
        root,
        parent,
        OFlag::O_PATH | OFlag::O_DIRECTORY,
        ResolveFlag::empty(),
    ) else {
        return Some("dossier parent inaccessible".into());
    };
    let Ok(fd) = openat(
        &dir,
        name,
        OFlag::O_PATH | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
        Mode::empty(),
    ) else {
        return Some("fichier inaccessible".into());
    };
    match fstat(&fd).ok().and_then(|st| kind_of(st.st_mode)) {
        Some(EntryKind::File) => {}
        Some(EntryKind::Symlink) => {
            return Some("c'est un lien symbolique : il n'est pas suivi pour écrire".into());
        }
        _ => return Some("pas un fichier ordinaire".into()),
    }
    if faccessat(&dir, name, AccessFlags::W_OK, nix::fcntl::AtFlags::empty()).is_err() {
        return Some("fichier en lecture seule".into());
    }
    if faccessat(&dir, ".", AccessFlags::W_OK, nix::fcntl::AtFlags::empty()).is_err() {
        return Some("dossier en lecture seule".into());
    }
    None
}

/// Un fichier existant tel que lu avant d'écrire : inode, droits, contenu.
struct Current {
    dev: u64,
    ino: u64,
    mode: u32,
    bytes: Vec<u8>,
    version: FileVersion,
}

/// Fichier `name` du dossier `dir`, sans suivre de lien ; `None` s'il
/// n'existe pas. `writable` : il doit aussi être accessible en écriture
/// (`faccessat`, comme `editable` de `files.read` ; un fichier en lecture
/// seule n'est pas remplacé par renommage). Toujours ouvert en lecture seule.
fn current(dir: &OwnedFd, name: &str, writable: bool) -> Result<Option<Current>, FileError> {
    let fd = match openat(
        dir,
        name,
        OFlag::O_PATH | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
        Mode::empty(),
    ) {
        Err(Errno::ENOENT) => return Ok(None),
        // Pas de droit de traversée sur le dossier.
        Err(Errno::EACCES | Errno::EPERM) => {
            return Err(FileError::Refused("dossier parent inaccessible".into()));
        }
        r => r.map_err(from_errno)?,
    };
    let st = fstat(&fd).map_err(from_errno)?;
    match kind_of(st.st_mode) {
        Some(EntryKind::File) => {}
        Some(EntryKind::Symlink) => {
            return Err(FileError::Refused(
                "c'est un lien symbolique : il n'est pas suivi pour écrire".into(),
            ));
        }
        _ => return Err(FileError::NotRegular),
    }
    if st.st_size.max(0) as u64 > MAX_READ_BYTES {
        return Err(FileError::Refused(
            "fichier trop gros pour être modifié (2 Mio au plus)".into(),
        ));
    }
    // Droit d'écriture testé sans ouvrir le fichier en écriture : une
    // ouverture en écriture, même sans écrire, réveillerait les surveillants
    // (`IN_CLOSE_WRITE` : serveurs de développement, `cargo watch`…).
    if writable {
        match faccessat(dir, name, AccessFlags::W_OK, nix::fcntl::AtFlags::empty()) {
            Ok(()) => {}
            Err(Errno::EACCES | Errno::EPERM | Errno::EROFS) => {
                return Err(FileError::Refused("fichier en lecture seule".into()));
            }
            Err(e) => return Err(from_errno(e)),
        }
    }
    // Rouvert par le descripteur (pas de nouvelle résolution du chemin), en
    // lecture seule.
    let mut file = File::open(proc_fd(&fd)).map_err(io)?;
    let meta = file.metadata().map_err(io)?;
    if meta.ino() != st.st_ino || meta.dev() != st.st_dev || !meta.is_file() {
        return Err(FileError::NotRegular);
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_READ_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(io)?;
    if bytes.len() as u64 > MAX_READ_BYTES {
        return Err(FileError::Refused(
            "fichier trop gros pour être modifié (2 Mio au plus)".into(),
        ));
    }
    let version = FileVersion::of(&bytes, mtime_ns(&meta));
    Ok(Some(Current {
        dev: meta.dev(),
        ino: meta.ino(),
        mode: meta.mode(),
        bytes,
        version,
    }))
}

/// Temporaire du dossier, supprimé s'il n'a pas été renommé.
struct TempFile<'a> {
    dir: &'a OwnedFd,
    name: String,
    renamed: bool,
}

impl Drop for TempFile<'_> {
    fn drop(&mut self) {
        if !self.renamed {
            let _ = unlinkat(self.dir, self.name.as_str(), UnlinkatFlags::NoRemoveDir);
        }
    }
}

/// Crée un temporaire (`O_EXCL`, jamais un lien) dans le dossier ; `mode` :
/// droits de l'original, sinon `0o666` moins le masque du démon.
fn create_temp(dir: &OwnedFd, mode: Option<u32>) -> Result<(TempFile<'_>, File), FileError> {
    for _ in 0..8 {
        let mut rnd = [0u8; 8];
        getrandom::fill(&mut rnd).map_err(io)?;
        let name = format!(
            ".devmaestro-{}.tmp",
            rnd.iter().map(|b| format!("{b:02x}")).collect::<String>()
        );
        let create_mode = if mode.is_some() { 0o600 } else { 0o666 };
        match openat(
            dir,
            name.as_str(),
            OFlag::O_WRONLY | OFlag::O_CREAT | OFlag::O_EXCL | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::from_bits_truncate(create_mode),
        ) {
            Err(Errno::EEXIST) => continue,
            Err(Errno::EACCES) | Err(Errno::EROFS) | Err(Errno::EPERM) => {
                return Err(FileError::Refused("dossier en lecture seule".into()));
            }
            Err(e) => return Err(io(e)),
            Ok(fd) => {
                let temp = TempFile {
                    dir,
                    name,
                    renamed: false,
                };
                if let Some(m) = mode {
                    // Droits de l'original (le masque ne s'applique pas à fchmod).
                    fchmod(&fd, Mode::from_bits_truncate(m & 0o777)).map_err(io)?;
                }
                return Ok((temp, File::from(fd)));
            }
        }
    }
    Err(FileError::Io(
        "impossible de créer un fichier temporaire".into(),
    ))
}

impl FileAccess for FsFiles {
    fn hash_beneath(
        &self,
        root: &Path,
        rel: &str,
        max: u64,
    ) -> Result<(u64, Option<String>), FileError> {
        let fd = open_beneath(root, rel, OFlag::O_PATH, ResolveFlag::empty())?;
        let st = fstat(&fd).map_err(from_errno)?;
        if kind_of(st.st_mode) != Some(EntryKind::File) {
            return Err(FileError::NotRegular);
        }
        // Chemin réel (liens suivis) : jamais dans un dossier `.git`.
        resolved_beneath(&fd, root)?;
        let size = st.st_size.max(0) as u64;
        if size > max {
            return Ok((size, None));
        }
        let file = File::open(proc_fd(&fd)).map_err(io)?;
        let meta = file.metadata().map_err(io)?;
        if meta.ino() != st.st_ino || meta.dev() != st.st_dev || !meta.is_file() {
            return Err(FileError::NotRegular);
        }
        crate::domain::files::sha256_stream(file, max).map_err(io)
    }

    fn read_beneath(&self, root: &Path, rel: &str, max: u64) -> Result<ReadFile, FileError> {
        // O_PATH : aucun effet de bord, même sur un périphérique ou une FIFO.
        let fd = open_beneath(root, rel, OFlag::O_PATH, ResolveFlag::empty())?;
        let st = fstat(&fd).map_err(from_errno)?;
        if kind_of(st.st_mode) != Some(EntryKind::File) {
            return Err(FileError::NotRegular);
        }
        // Chemin réel (liens suivis) : jamais dans un dossier `.git`.
        let resolved = resolved_beneath(&fd, root)?;
        let not_editable = write_obstacle(root, rel);
        let size = st.st_size.max(0) as u64;
        if size > max {
            return Ok(ReadFile {
                size,
                bytes: None,
                resolved,
                version: None,
                not_editable,
            });
        }
        let mut file = File::open(proc_fd(&fd)).map_err(io)?;
        let meta = file.metadata().map_err(io)?;
        if meta.ino() != st.st_ino || meta.dev() != st.st_dev || !meta.is_file() {
            return Err(FileError::NotRegular);
        }
        let mut bytes = Vec::new();
        (&mut file)
            .take(max + 1)
            .read_to_end(&mut bytes)
            .map_err(io)?;
        if bytes.len() as u64 > max {
            return Ok(ReadFile {
                size: bytes.len() as u64,
                bytes: None,
                resolved,
                version: None,
                not_editable,
            });
        }
        Ok(ReadFile {
            size: bytes.len() as u64,
            version: Some(FileVersion::of(&bytes, mtime_ns(&meta))),
            bytes: Some(bytes),
            resolved,
            not_editable,
        })
    }

    fn write_beneath(
        &self,
        root: &Path,
        rel: &str,
        content: &[u8],
        expected: Option<&str>,
    ) -> Result<FileVersion, FileError> {
        let (parent, name) = split_rel(rel);
        if name.is_empty() || name == "." || name == ".." || is_git_dir(name) {
            return Err(FileError::Outside("nom de fichier refusé".into()));
        }
        // Dossier parent sous la racine (liens internes suivis), gardé ouvert
        // d'un bout à l'autre : tout le reste se fait par rapport à lui.
        let dir = open_beneath(
            root,
            parent,
            OFlag::O_PATH | OFlag::O_DIRECTORY,
            ResolveFlag::empty(),
        )
        .map_err(|e| match e {
            FileError::NotFound => FileError::Refused("le dossier parent n'existe pas".into()),
            FileError::Denied => FileError::Refused("dossier parent inaccessible".into()),
            FileError::NotDir => {
                FileError::Refused("le dossier parent n'est pas un dossier".into())
            }
            e => e,
        })?;
        resolved_beneath(&dir, root)?;

        let before = current(&dir, name, true)?;
        if let Some(b) = &before {
            if looks_binary(&b.bytes) {
                return Err(FileError::Refused("fichier binaire".into()));
            }
            if std::str::from_utf8(&b.bytes).is_err() {
                return Err(FileError::Refused(
                    "le fichier n'est pas un texte UTF-8 valide".into(),
                ));
            }
        }
        match (&before, expected) {
            (None, Some(_)) => return Err(FileError::Conflict(None)),
            (Some(b), None) => return Err(FileError::Conflict(Some(b.version.clone()))),
            (Some(b), Some(e)) if b.version.sha256 != e => {
                return Err(FileError::Conflict(Some(b.version.clone())));
            }
            _ => {}
        }

        let (mut temp, mut file) = create_temp(&dir, before.as_ref().map(|b| b.mode))?;
        file.write_all(content).map_err(io)?;
        file.sync_all().map_err(io)?;
        let meta = file.metadata().map_err(io)?;
        let written = FileVersion {
            size: content.len() as u64,
            mtime_ns: mtime_ns(&meta),
            sha256: crate::domain::files::sha256_hex(content),
        };
        drop(file);

        // Empreinte revérifiée juste avant le renommage.
        let now = current(&dir, name, false)?;
        match (&before, &now) {
            (None, None) => {}
            (Some(b), Some(n))
                if n.version.sha256 == b.version.sha256 && (n.dev, n.ino) == (b.dev, b.ino) => {}
            (_, n) => return Err(FileError::Conflict(n.as_ref().map(|n| n.version.clone()))),
        }
        let flags = if before.is_none() {
            // Création : échoue si le fichier est apparu entre-temps.
            RenameFlags::RENAME_NOREPLACE
        } else {
            RenameFlags::empty()
        };
        match renameat2(&dir, temp.name.as_str(), &dir, name, flags) {
            Ok(()) => {}
            Err(Errno::EEXIST) => {
                let now = current(&dir, name, false).ok().flatten();
                return Err(FileError::Conflict(now.map(|n| n.version)));
            }
            // Système de fichiers sans RENAME_NOREPLACE : absence vérifiée
            // juste avant.
            Err(Errno::EINVAL) if before.is_none() => {
                renameat2(&dir, temp.name.as_str(), &dir, name, RenameFlags::empty()).map_err(io)?
            }
            Err(e) => return Err(io(e)),
        }
        temp.renamed = true;
        // Le renommage lui-même sur le disque (au mieux).
        if let Ok(d) = File::open(proc_fd(&dir)) {
            let _ = d.sync_all();
        }
        Ok(written)
    }

    fn check_dir(&self, root: &Path, rel: &str) -> Result<(), FileError> {
        open_beneath(
            root,
            rel,
            OFlag::O_PATH | OFlag::O_DIRECTORY,
            ResolveFlag::RESOLVE_NO_SYMLINKS,
        )
        .map(drop)
    }

    fn lstat(&self, root: &Path, rel: &str) -> Option<RawEntry> {
        let fd = open_beneath(
            root,
            rel,
            OFlag::O_PATH | OFlag::O_NOFOLLOW,
            ResolveFlag::RESOLVE_NO_SYMLINKS,
        )
        .ok()?;
        let st = fstat(&fd).ok()?;
        let kind = kind_of(st.st_mode)?;
        Some(RawEntry {
            name: rel.rsplit('/').next().unwrap_or(rel).to_owned(),
            kind,
            size: (kind == EntryKind::File).then_some(st.st_size.max(0) as u64),
            modified: std::time::UNIX_EPOCH.checked_add(std::time::Duration::new(
                st.st_mtime.max(0) as u64,
                st.st_mtime_nsec.clamp(0, 999_999_999) as u32,
            )),
        })
    }

    fn list_dir(&self, root: &Path, rel: &str) -> Result<(Vec<RawEntry>, bool), FileError> {
        let fd = open_beneath(
            root,
            rel,
            OFlag::O_RDONLY | OFlag::O_DIRECTORY,
            ResolveFlag::RESOLVE_NO_SYMLINKS,
        )?;
        let dir = proc_fd(&fd);
        let mut out = Vec::new();
        let mut truncated = false;
        for e in std::fs::read_dir(&dir).map_err(io)? {
            let Ok(e) = e else { continue };
            if out.len() == MAX_SCANNED {
                truncated = true;
                break;
            }
            let Ok(name) = e.file_name().into_string() else {
                continue; // nom non UTF-8 : ignoré
            };
            if is_git_dir(&name) {
                continue;
            }
            let Ok(ft) = e.file_type() else { continue };
            let kind = if ft.is_symlink() {
                EntryKind::Symlink
            } else if ft.is_dir() {
                EntryKind::Dir
            } else if ft.is_file() {
                EntryKind::File
            } else {
                continue; // FIFO, socket, périphérique : jamais montrés
            };
            // Taille lue plus tard, pour les seules entrées gardées (`lstat`).
            out.push(RawEntry {
                name,
                kind,
                size: None,
                modified: None,
            });
        }
        Ok((out, truncated))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    fn tree() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("racine");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join(".git/config"), "secret").unwrap();
        std::fs::write(root.join("src/a.rs"), "fn main() {}\n").unwrap();
        std::fs::write(dir.path().join("dehors.txt"), "secret").unwrap();
        symlink("src/a.rs", root.join("lien-interne")).unwrap();
        symlink("../dehors.txt", root.join("lien-dehors")).unwrap();
        symlink(dir.path().join("dehors.txt"), root.join("lien-absolu")).unwrap();
        symlink("src", root.join("lien-dossier")).unwrap();
        symlink(".git/config", root.join("lien-git")).unwrap();
        nix::unistd::mkfifo(&root.join("fifo"), Mode::from_bits_truncate(0o600)).unwrap();
        let root = root.canonicalize().unwrap();
        (dir, root)
    }

    #[test]
    fn reads_only_regular_files_beneath_the_root() {
        let (_d, root) = tree();
        let f = FsFiles;
        let r = f.read_beneath(&root, "src/a.rs", 1024).unwrap();
        assert_eq!(r.bytes.as_deref(), Some(&b"fn main() {}\n"[..]));
        assert_eq!(r.resolved, "src/a.rs");
        let r = f.read_beneath(&root, "lien-interne", 1024).unwrap();
        assert_eq!(r.resolved, "src/a.rs");
        for bad in ["lien-dehors", "lien-absolu", "../dehors.txt", "/etc/passwd"] {
            assert!(
                matches!(f.read_beneath(&root, bad, 1024), Err(FileError::Outside(_))),
                "{bad}"
            );
        }
        assert!(matches!(
            f.read_beneath(&root, "lien-git", 1024),
            Err(FileError::Outside(_))
        ));
        assert!(matches!(
            f.read_beneath(&root, "fifo", 1024),
            Err(FileError::NotRegular)
        ));
        assert!(matches!(
            f.read_beneath(&root, "src", 1024),
            Err(FileError::NotRegular)
        ));
        assert!(matches!(
            f.read_beneath(&root, "absent", 1024),
            Err(FileError::NotFound)
        ));
        let big = f.read_beneath(&root, "src/a.rs", 4).unwrap();
        assert_eq!((big.size, big.bytes), (13, None));
    }

    #[test]
    fn lists_without_following_links() {
        let (_d, root) = tree();
        let f = FsFiles;
        let (entries, truncated) = f.list_dir(&root, "").unwrap();
        assert!(!truncated);
        let kind = |n: &str| entries.iter().find(|e| e.name == n).map(|e| e.kind);
        assert_eq!(kind("src"), Some(EntryKind::Dir));
        assert_eq!(kind("lien-dossier"), Some(EntryKind::Symlink));
        assert_eq!(kind(".git"), None);
        assert_eq!(kind("fifo"), None);
        // Un lien vers un dossier n'est jamais parcouru.
        assert!(matches!(
            f.list_dir(&root, "lien-dossier"),
            Err(FileError::Outside(_))
        ));
        assert!(f.check_dir(&root, "src").is_ok());
        assert!(matches!(
            f.check_dir(&root, "src/a.rs"),
            Err(FileError::NotDir)
        ));
        assert!(matches!(
            f.check_dir(&root, "lien-dossier"),
            Err(FileError::Outside(_))
        ));
        assert_eq!(
            f.lstat(&root, "lien-dossier").unwrap().kind,
            EntryKind::Symlink
        );
        assert_eq!(f.lstat(&root, "src/a.rs").unwrap().size, Some(13));
        assert!(f.lstat(&root, "lien-dossier/a.rs").is_none());
        assert!(f.lstat(&root, "absent").is_none());
    }

    #[test]
    fn temp_file_is_removed_unless_renamed() {
        use std::os::unix::fs::PermissionsExt;
        let (_d, root) = tree();
        let dir = open(
            &root.join("src"),
            OFlag::O_PATH | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC,
            Mode::empty(),
        )
        .unwrap();
        let (temp, mut file) = create_temp(&dir, Some(0o100640)).unwrap();
        let path = root.join("src").join(&temp.name);
        file.write_all(b"x").unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o640
        );
        drop(temp);
        assert!(!path.exists(), "temporaire supprimé après un échec");
    }

    #[test]
    fn writes_atomically_with_fingerprint() {
        let (_d, root) = tree();
        let f = FsFiles;
        let v0 = f
            .read_beneath(&root, "src/a.rs", 1024)
            .unwrap()
            .version
            .unwrap();
        assert_eq!(
            v0.sha256,
            crate::domain::files::sha256_hex(b"fn main() {}\n")
        );
        let v1 = f
            .write_beneath(&root, "src/a.rs", b"fn b() {}\n", Some(&v0.sha256))
            .unwrap();
        assert_eq!(
            f.read_beneath(&root, "src/a.rs", 1024).unwrap().version,
            Some(v1.clone())
        );
        // Empreinte périmée : conflit avec la version actuelle.
        assert_eq!(
            f.write_beneath(&root, "src/a.rs", b"x", Some(&v0.sha256)),
            Err(FileError::Conflict(Some(v1)))
        );
        // Création, puis création refusée.
        let n = f
            .write_beneath(&root, "lien-dossier/n.rs", b"n", None)
            .unwrap();
        assert!(matches!(
            f.write_beneath(&root, "src/n.rs", b"m", None),
            Err(FileError::Conflict(Some(v))) if v == n
        ));
        assert!(matches!(
            f.write_beneath(&root, "lien-interne", b"x", Some(&n.sha256)),
            Err(FileError::Refused(_))
        ));
        assert!(matches!(
            f.write_beneath(&root, "lien-git", b"x", Some(&n.sha256)),
            Err(FileError::Refused(_))
        ));
        assert!(matches!(
            f.write_beneath(&root, "fifo", b"x", Some(&n.sha256)),
            Err(FileError::NotRegular)
        ));
        let names: Vec<_> = std::fs::read_dir(root.join("src"))
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert!(
            names.iter().all(|n| !n.starts_with(".devmaestro-")),
            "{names:?}"
        );
    }

    #[test]
    fn fallback_without_openat2_stays_beneath() {
        let (_d, root) = tree();
        let read = |rel: &str| open_fallback(&root, rel, OFlag::O_PATH, ResolveFlag::empty());
        assert!(read("src/a.rs").is_ok());
        assert!(read("lien-interne").is_ok());
        assert!(matches!(read("lien-dehors"), Err(FileError::Outside(_))));
        assert!(matches!(read("lien-absolu"), Err(FileError::Outside(_))));
        let nofollow = |rel: &str| {
            open_fallback(
                &root,
                rel,
                OFlag::O_PATH | OFlag::O_NOFOLLOW,
                ResolveFlag::RESOLVE_NO_SYMLINKS,
            )
        };
        assert!(nofollow("lien-dossier").is_ok(), "le lien lui-même");
        assert!(matches!(
            nofollow("lien-dossier/a.rs"),
            Err(FileError::Outside(_))
        ));
    }
}
