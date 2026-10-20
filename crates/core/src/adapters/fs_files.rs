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
//! Noyau sans `openat2` (avant 5.6) : repli sur la résolution du chemin
//! (`canonicalize`) et une vérification qu'il reste dans la racine.

use std::fs::File;
use std::io::Read;
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

use nix::errno::Errno;
use nix::fcntl::{OFlag, OpenHow, ResolveFlag, open, openat2};
use nix::sys::stat::{Mode, SFlag, fstat};

use crate::domain::files::EntryKind;
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

impl FileAccess for FsFiles {
    fn read_beneath(&self, root: &Path, rel: &str, max: u64) -> Result<ReadFile, FileError> {
        // O_PATH : aucun effet de bord, même sur un périphérique ou une FIFO.
        let fd = open_beneath(root, rel, OFlag::O_PATH, ResolveFlag::empty())?;
        let st = fstat(&fd).map_err(from_errno)?;
        if kind_of(st.st_mode) != Some(EntryKind::File) {
            return Err(FileError::NotRegular);
        }
        // Chemin réel (liens suivis) : jamais dans un dossier `.git`.
        let real = std::fs::read_link(proc_fd(&fd)).map_err(io)?;
        let resolved = real
            .strip_prefix(root)
            .map_err(|_| FileError::Outside("le lien sort de la racine".into()))?
            .to_string_lossy()
            .into_owned();
        if resolved.split('/').any(crate::domain::files::is_git_dir) {
            return Err(FileError::Outside(
                "le dossier .git n'est pas accessible".into(),
            ));
        }
        let size = st.st_size.max(0) as u64;
        if size > max {
            return Ok(ReadFile {
                size,
                bytes: None,
                resolved,
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
            });
        }
        Ok(ReadFile {
            size: bytes.len() as u64,
            bytes: Some(bytes),
            resolved,
        })
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
            if crate::domain::files::is_git_dir(&name) {
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
