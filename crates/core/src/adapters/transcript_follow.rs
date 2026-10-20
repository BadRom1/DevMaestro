//! Suivi en direct des transcripts (vue conversation, ADR 0005) : lecture
//! incrémentale par décalage et surveillance des dossiers par `notify`
//! (inotify sous Linux).
//!
//! - La position est un décalage en octets ; le reste d'une ligne pas encore
//!   terminée est gardé jusqu'au prochain saut de ligne. La date de
//!   modification n'est jamais lue (une reprise la change sans rien écrire,
//!   prototype n° 5, Q4).
//! - Une ligne de plus de [`MAX_LINE_BYTES`] est ignorée (jusqu'à son saut
//!   de ligne) et comptée.
//! - Un fichier qui raccourcit ou qui est remplacé (autre `dev`/`ino`) est
//!   relu depuis le début : les lignes déjà vues sont reconnues par le
//!   domaine (même `uuid`).
//! - Un `stat` d'abord : un fichier dont la taille et l'identité n'ont pas
//!   changé n'est pas ouvert. Lecture par lots de [`TAIL_BATCH_BYTES`].
//! - La surveillance ne fait que réveiller le démon, et seulement pour une
//!   création, une écriture ou un retrait (jamais pour une ouverture ou une
//!   lecture : le démon qui lit ne se réveille pas lui-même). Sa scrutation
//!   de secours (taille comparée au décalage) couvre ce que `notify` manque.
//!
//! Aucun contenu lu n'est journalisé.

use std::collections::HashSet;
use std::fs;
use std::io::{self, Read, Seek, SeekFrom};
use std::os::unix::fs::{FileExt, MetadataExt};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::domain::conversation::MAX_LINE_BYTES;
use crate::ports::{TAIL_BATCH_BYTES, TailLine, TailPos, TailRead, TranscriptFollower};

/// Octets lus au plus par appel à `read` (le fichier est lu jusqu'au bout,
/// par morceaux).
const CHUNK: usize = 1024 * 1024;

type Waker = Arc<dyn Fn() + Send + Sync>;

/// [`TranscriptFollower`] sur le système de fichiers.
#[derive(Default)]
pub struct FsTranscriptFollower {
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
    watched: Mutex<HashSet<PathBuf>>,
    waker: Arc<Mutex<Option<Waker>>>,
    /// La création du surveillant a échoué : plus d'essai (scrutation seule).
    unavailable: std::sync::atomic::AtomicBool,
}

impl FsTranscriptFollower {
    fn ensure_watcher(&self) -> bool {
        use std::sync::atomic::Ordering;
        let mut w = self.watcher.lock().unwrap_or_else(|e| e.into_inner());
        if w.is_some() {
            return true;
        }
        if self.unavailable.load(Ordering::SeqCst) {
            return false;
        }
        let waker = self.waker.clone();
        let handler = move |res: notify::Result<notify::Event>| {
            // Ouvertures, lectures, fermetures : ignorées (la pompe ouvre les
            // fichiers ; s'en réveiller ferait une boucle).
            let wakes = res.is_ok_and(|ev| {
                matches!(
                    ev.kind,
                    notify::EventKind::Create(_)
                        | notify::EventKind::Modify(_)
                        | notify::EventKind::Remove(_)
                        | notify::EventKind::Any
                        | notify::EventKind::Other
                )
            });
            if wakes && let Some(f) = waker.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
                f();
            }
        };
        match notify::recommended_watcher(handler) {
            Ok(watcher) => {
                *w = Some(watcher);
                true
            }
            Err(_) => {
                // Scrutation seule (le démon relit les tailles toutes les 250 ms).
                self.unavailable.store(true, Ordering::SeqCst);
                false
            }
        }
    }
}

/// `~/…` développé avec `HOME`.
fn expand_home(path: &Path) -> PathBuf {
    match path.strip_prefix("~") {
        Ok(rest) => match std::env::var_os("HOME") {
            Some(home) => PathBuf::from(home).join(rest),
            None => path.to_path_buf(),
        },
        Err(_) => path.to_path_buf(),
    }
}

/// Découpe `data` (lu à partir de `start`) en lignes complètes ; le reste va
/// dans `pos.partial`.
fn split(pos: &mut TailPos, start: u64, data: &[u8], out: &mut TailRead) {
    let mut line_start = start - pos.partial.len() as u64;
    let mut rest = data;
    while let Some(nl) = rest.iter().position(|b| *b == b'\n') {
        let (head, tail) = (&rest[..nl], &rest[nl + 1..]);
        if pos.skipping {
            pos.skipping = false;
        } else if pos.partial.len() + head.len() > MAX_LINE_BYTES {
            pos.partial.clear();
            out.oversized += 1;
        } else {
            let mut line = std::mem::take(&mut pos.partial);
            line.extend_from_slice(head);
            out.lines.push(TailLine {
                offset: line_start,
                len: line.len() as u64,
                text: String::from_utf8_lossy(&line).into_owned(),
            });
        }
        // `pos.partial` est vide ici : pris, vidé, ou déjà vide (`skipping`).
        line_start = start + (data.len() - tail.len()) as u64;
        rest = tail;
    }
    if !pos.skipping {
        if pos.partial.len() + rest.len() > MAX_LINE_BYTES {
            pos.partial.clear();
            pos.skipping = true;
            out.oversized += 1;
        } else {
            pos.partial.extend_from_slice(rest);
        }
    }
}

impl TranscriptFollower for FsTranscriptFollower {
    fn read_new(&self, path: &Path, pos: &mut TailPos) -> io::Result<TailRead> {
        let mut out = TailRead::default();
        let meta = match fs::metadata(path) {
            Ok(m) => m,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(out),
            Err(e) => return Err(e),
        };
        let id = Some((meta.dev(), meta.ino()));
        if meta.len() < pos.offset || (pos.file_id.is_some() && pos.file_id != id) {
            // Fichier réécrit plus court, ou remplacé : relu depuis le début.
            *pos = TailPos::default();
        }
        pos.file_id = id;
        if meta.len() == pos.offset {
            return Ok(out); // Rien de nouveau : pas d'ouverture.
        }
        let mut file = match fs::File::open(path) {
            Ok(f) => f,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(out),
            Err(e) => return Err(e),
        };
        let opened = file.metadata()?;
        if Some((opened.dev(), opened.ino())) != pos.file_id {
            return Ok(out); // Remplacé entre le `stat` et l'ouverture : au prochain tour.
        }
        file.seek(SeekFrom::Start(pos.offset))?;
        let mut buf = vec![0u8; CHUNK];
        let mut read = 0u64;
        loop {
            if read >= TAIL_BATCH_BYTES {
                out.more = true;
                break;
            }
            let n = match file.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e),
            };
            let start = pos.offset;
            pos.offset += n as u64;
            read += n as u64;
            split(pos, start, &buf[..n], &mut out);
        }
        Ok(out)
    }

    fn read_lines(&self, path: &Path, lines: &[(u64, u64)]) -> io::Result<Vec<String>> {
        let file = fs::File::open(path)?;
        lines
            .iter()
            .map(|&(offset, len)| {
                let len = len.min(MAX_LINE_BYTES as u64) as usize;
                let mut buf = vec![0u8; len];
                file.read_exact_at(&mut buf, offset)?;
                Ok(String::from_utf8_lossy(&buf).into_owned())
            })
            .collect()
    }

    fn read_small(&self, path: &Path, max: u64) -> Option<String> {
        let f = fs::File::open(path).ok()?;
        if !f.metadata().ok()?.is_file() {
            return None;
        }
        let mut s = String::new();
        f.take(max).read_to_string(&mut s).ok()?;
        Some(s)
    }

    fn list_dir(&self, dir: &Path) -> Vec<String> {
        let Ok(entries) = fs::read_dir(dir) else {
            return Vec::new();
        };
        let mut names: Vec<String> = entries
            .flatten()
            .filter_map(|e| e.file_name().into_string().ok())
            .collect();
        names.sort();
        names
    }

    fn confine(&self, path: &Path, root: &Path) -> Option<PathBuf> {
        let root = self.resolve(root)?;
        let full = self.resolve(path)?;
        full.starts_with(&root).then_some(full)
    }

    fn resolve(&self, path: &Path) -> Option<PathBuf> {
        let path = expand_home(path);
        if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir)) {
            return None;
        }
        // Le chemin, sinon son ancêtre existant le plus proche.
        let mut existing = path.as_path();
        let mut missing: Vec<&std::ffi::OsStr> = Vec::new();
        let mut full = loop {
            match fs::canonicalize(existing) {
                Ok(p) => break p,
                Err(_) => {
                    missing.push(existing.file_name()?);
                    existing = existing.parent()?;
                }
            }
        };
        for part in missing.iter().rev() {
            full.push(part);
        }
        Some(full)
    }

    fn watch(&self, dir: &Path) {
        if !dir.is_dir() {
            return;
        }
        let mut watched = self.watched.lock().unwrap_or_else(|e| e.into_inner());
        if watched.contains(dir) || !self.ensure_watcher() {
            return;
        }
        use notify::Watcher;
        let mut w = self.watcher.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(watcher) = w.as_mut()
            && watcher
                .watch(dir, notify::RecursiveMode::NonRecursive)
                .is_ok()
        {
            watched.insert(dir.to_path_buf());
        }
    }

    fn unwatch(&self, dir: &Path) {
        let mut watched = self.watched.lock().unwrap_or_else(|e| e.into_inner());
        if watched.remove(dir) {
            use notify::Watcher;
            if let Some(w) = self
                .watcher
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .as_mut()
            {
                let _ = w.unwatch(dir);
            }
        }
    }

    fn set_waker(&self, waker: Box<dyn Fn() + Send + Sync>) {
        *self.waker.lock().unwrap_or_else(|e| e.into_inner()) = Some(Arc::from(waker));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{Duration, Instant};

    fn append(path: &Path, bytes: &[u8]) {
        let mut f = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap();
        f.write_all(bytes).unwrap();
    }

    #[test]
    fn reads_complete_lines_incrementally_with_offsets() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        let f = FsTranscriptFollower::default();
        let mut pos = TailPos::default();
        // Absent : vide.
        assert_eq!(f.read_new(&path, &mut pos).unwrap(), TailRead::default());
        append(&path, b"{\"a\":1}\n{\"b\":");
        let r = f.read_new(&path, &mut pos).unwrap();
        assert_eq!(r.lines, [line(0, 7, "{\"a\":1}")]);
        assert_eq!(pos.partial, b"{\"b\":");
        // Rien de nouveau.
        assert!(f.read_new(&path, &mut pos).unwrap().lines.is_empty());
        append(&path, b"2}\n\xff\n");
        let r = f.read_new(&path, &mut pos).unwrap();
        // Longueur sur le disque : l'octet invalide en compte un, pas trois.
        assert_eq!(r.lines, [line(8, 7, "{\"b\":2}"), line(16, 1, "\u{fffd}")]);
        assert_eq!(pos.offset, 18);
        assert!(pos.partial.is_empty());
        // Relecture d'une ligne par sa position.
        assert_eq!(f.read_lines(&path, &[(8, 7)]).unwrap(), ["{\"b\":2}"]);
        // Fichier réécrit plus court : relu depuis le début.
        fs::write(&path, b"{\"c\":3}\n").unwrap();
        let r = f.read_new(&path, &mut pos).unwrap();
        assert_eq!(r.lines, [line(0, 7, "{\"c\":3}")]);
        // Remplacé par un autre fichier, même plus long : relu depuis le début.
        let other = dir.path().join("autre.jsonl");
        fs::write(&other, b"{\"d\":4}\n{\"e\":5}\n").unwrap();
        fs::rename(&other, &path).unwrap();
        let r = f.read_new(&path, &mut pos).unwrap();
        assert_eq!(r.lines, [line(0, 7, "{\"d\":4}"), line(8, 7, "{\"e\":5}")]);
    }

    fn line(offset: u64, len: u64, text: &str) -> TailLine {
        TailLine {
            offset,
            len,
            text: text.to_owned(),
        }
    }

    #[test]
    fn big_files_are_read_in_batches() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        let row = format!("{}\n", "x".repeat(1023));
        let n = (TAIL_BATCH_BYTES as usize * 2 + 10) / row.len() + 1;
        fs::write(&path, row.repeat(n)).unwrap();
        let f = FsTranscriptFollower::default();
        let mut pos = TailPos::default();
        let mut total = 0;
        let mut calls = 0;
        loop {
            let r = f.read_new(&path, &mut pos).unwrap();
            total += r.lines.len();
            calls += 1;
            if !r.more {
                break;
            }
        }
        assert_eq!(total, n);
        assert!(calls >= 3, "{calls} lots");
    }

    /// Lit jusqu'au bout (tous les lots).
    fn read_all(f: &FsTranscriptFollower, path: &Path, pos: &mut TailPos) -> TailRead {
        let mut all = TailRead::default();
        loop {
            let r = f.read_new(path, pos).unwrap();
            all.lines.extend(r.lines);
            all.oversized += r.oversized;
            if !r.more {
                return all;
            }
        }
    }

    #[test]
    fn oversized_lines_are_skipped_and_counted() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        let f = FsTranscriptFollower::default();
        let mut pos = TailPos::default();
        let big = vec![b'x'; MAX_LINE_BYTES + 10];
        append(&path, &big);
        let r = read_all(&f, &path, &mut pos);
        assert_eq!((r.lines.len(), r.oversized), (0, 1));
        assert!(pos.skipping && pos.partial.is_empty());
        append(&path, b"fin de la grande\n{\"ok\":1}\n");
        let r = read_all(&f, &path, &mut pos);
        assert_eq!(r.oversized, 0);
        let offset = (MAX_LINE_BYTES + 10 + "fin de la grande\n".len()) as u64;
        assert_eq!(r.lines, [line(offset, 8, "{\"ok\":1}")]);
        // Une grande ligne terminée d'un coup.
        let mut big = vec![b'y'; MAX_LINE_BYTES + 1];
        big.push(b'\n');
        append(&path, &big);
        let r = read_all(&f, &path, &mut pos);
        assert_eq!((r.lines.len(), r.oversized), (0, 1));
        assert!(!pos.skipping);
    }

    #[test]
    fn confine_keeps_paths_under_the_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("projects");
        fs::create_dir_all(root.join("-p")).unwrap();
        fs::write(root.join("-p/a.jsonl"), "").unwrap();
        fs::create_dir_all(dir.path().join("ailleurs")).unwrap();
        std::os::unix::fs::symlink(dir.path().join("ailleurs"), root.join("lien")).unwrap();
        let f = FsTranscriptFollower::default();
        let canon = fs::canonicalize(&root).unwrap();
        assert_eq!(
            f.confine(&root.join("-p/a.jsonl"), &root),
            Some(canon.join("-p/a.jsonl"))
        );
        // Pas encore créé : jugé sur son dossier.
        assert_eq!(
            f.confine(&root.join("-p/b/subagents/agent-1.jsonl"), &root),
            Some(canon.join("-p/b/subagents/agent-1.jsonl"))
        );
        assert_eq!(f.confine(&root.join("lien/x.jsonl"), &root), None);
        assert_eq!(f.confine(&root.join("-p/../../x.jsonl"), &root), None);
        assert_eq!(f.confine(Path::new("relatif.jsonl"), &root), None);
        assert_eq!(f.confine(&dir.path().join("x.jsonl"), &root), None);
        // `projects/` pas encore créé : jugé sur l'ancêtre existant.
        let absent = dir.path().join("profil/projects");
        assert_eq!(
            f.confine(&absent.join("-p/a.jsonl"), &absent),
            Some(
                fs::canonicalize(dir.path())
                    .unwrap()
                    .join("profil/projects/-p/a.jsonl")
            )
        );
    }

    #[test]
    fn watching_wakes_the_daemon() {
        let dir = tempfile::tempdir().unwrap();
        let f = FsTranscriptFollower::default();
        let hits = Arc::new(AtomicUsize::new(0));
        let h = hits.clone();
        f.set_waker(Box::new(move || {
            h.fetch_add(1, Ordering::SeqCst);
        }));
        f.watch(&dir.path().join("absent"));
        f.watch(dir.path());
        f.watch(dir.path());
        append(&dir.path().join("t.jsonl"), b"{}\n");
        let start = Instant::now();
        while hits.load(Ordering::SeqCst) == 0 && start.elapsed() < Duration::from_secs(5) {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(hits.load(Ordering::SeqCst) > 0, "aucun réveil");
        // Lire sans écrire (ouverture, lecture, fermeture) ne réveille pas.
        std::thread::sleep(Duration::from_millis(200));
        hits.store(0, Ordering::SeqCst);
        let mut pos = TailPos::default();
        f.read_new(&dir.path().join("t.jsonl"), &mut pos).unwrap();
        let _ = fs::read(dir.path().join("t.jsonl")).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(hits.load(Ordering::SeqCst), 0, "réveil sur une lecture");
        // Et ne plus surveiller.
        f.unwatch(dir.path());
        append(&dir.path().join("t.jsonl"), b"{}\n");
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(hits.load(Ordering::SeqCst), 0, "réveil après unwatch");
    }
}
