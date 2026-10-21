//! Lecture des slash commands sur le disque (v0.3, lot 17) : commandes
//! `.md`, skills `SKILL.md`, réglages et manifestes des plugins.
//!
//! **Lecture seule**, bornée : la racine parcourue est d'abord résolue (un
//! dossier de profil lié à un autre reste accepté), puis un lien symbolique
//! rencontré dedans n'est suivi que si sa cible résolue reste sous la racine
//! résolue ; noms cachés ignorés ; seuls des fichiers ordinaires sont
//! ouverts (`O_NONBLOCK | O_NOFOLLOW`, genre vérifié sur le descripteur : une
//! FIFO ne bloque pas), et seulement leurs premiers octets lus. Un dossier
//! ou un fichier déjà vu (chemin résolu) n'est pas relu sous un autre nom.
//! Les noms d'un dossier sont triés avant toute coupe : le résultat ne
//! dépend pas de l'ordre de `readdir`.

use std::collections::HashSet;
use std::fs::File;
use std::io::Read;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use crate::domain::commands::{
    MAX_DEPTH, MAX_DIR_ENTRIES_PER_ROOT, MAX_FILES_PER_ROOT, MAX_HEAD_BYTES, MAX_JSON_BYTES,
};
use crate::ports::{CommandFiles, CommandLayout, CommandScan, FoundCommandFile};

/// [`CommandFiles`] sur le système de fichiers.
#[derive(Debug, Clone, Copy, Default)]
pub struct FsCommandFiles;

/// Entrées lues au plus dans un même dossier avant tri (au-delà : coupé).
const MAX_SCANNED_PER_DIR: usize = 10_000;

/// Ouvre un fichier ordinaire sans suivre de lien final ni bloquer, et lit
/// au plus `max` octets ; `None` si ce n'est pas un fichier ordinaire, s'il
/// dépasse `max` (avec `whole`) ou en cas d'erreur.
///
/// `path` vient de `canonicalize` : seul son dernier composant est protégé
/// d'un remplacement par un lien (`O_NOFOLLOW`) ; un dossier intermédiaire
/// remplacé entre la résolution et l'ouverture n'est pas détecté (risque
/// accepté en lecture seule : au pire une description lue ailleurs ; à
/// reprendre avec `openat2` et `RESOLVE_BENEATH`, comme `fs_files.rs`).
fn read_regular(path: &Path, max: u64, whole: bool) -> Option<Vec<u8>> {
    let f = File::options()
        .read(true)
        .custom_flags(open_flags())
        .open(path)
        .ok()?;
    let meta = f.metadata().ok()?;
    if !meta.file_type().is_file() {
        return None;
    }
    if whole && meta.len() > max {
        return None;
    }
    let mut buf = Vec::new();
    f.take(max).read_to_end(&mut buf).ok()?;
    Some(buf)
}

/// Drapeaux d'ouverture : non bloquante (FIFO), sans suivre de lien final.
fn open_flags() -> i32 {
    use nix::fcntl::OFlag;
    (OFlag::O_NONBLOCK | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC).bits()
}

/// Genre d'une entrée, liens résolus seulement s'ils restent sous `root`.
enum Kind {
    Dir(PathBuf),
    File(PathBuf),
    Other,
}

fn kind_of(path: &Path, root: &Path) -> Kind {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return Kind::Other;
    };
    let ft = meta.file_type();
    if ft.is_dir() {
        return Kind::Dir(path.to_path_buf());
    }
    if ft.is_file() {
        return Kind::File(path.to_path_buf());
    }
    if ft.is_symlink() {
        let Ok(target) = std::fs::canonicalize(path) else {
            return Kind::Other;
        };
        if !target.starts_with(root) {
            return Kind::Other;
        }
        return match std::fs::metadata(&target) {
            Ok(m) if m.is_dir() => Kind::Dir(target),
            Ok(m) if m.is_file() => Kind::File(target),
            _ => Kind::Other,
        };
    }
    Kind::Other
}

struct Walk<'a> {
    root: &'a Path,
    layout: CommandLayout,
    budget: usize,
    out: CommandScan,
    /// Plus rien à retenir : une candidate a été écartée faute de place.
    stop: bool,
    /// Dossiers et fichiers déjà vus (chemins résolus) : un lien interne vers
    /// un dossier déjà parcouru ne donne pas de seconds noms.
    seen: HashSet<PathBuf>,
}

impl Walk<'_> {
    /// Entrée qui pourrait donner une commande (et dont la perte compte).
    fn candidate(&self, name: &[u8], ft: Option<std::fs::FileType>) -> bool {
        let dirish = ft.is_none_or(|t| t.is_dir() || t.is_symlink());
        match self.layout {
            CommandLayout::Commands => dirish || name.ends_with(b".md"),
            CommandLayout::Skills => dirish,
        }
    }

    /// Noms d'un dossier, **triés avant d'être coupés** (le parcours ne
    /// dépend pas de l'ordre de `readdir`) : cachés écartés, budget
    /// d'entrées de la racine décompté. `truncated` seulement si une entrée
    /// écartée pouvait donner une commande ; un nom qui n'est pas de l'UTF-8
    /// est compté dans `ignored`.
    fn entries(&mut self, dir: &Path) -> Vec<String> {
        use std::os::unix::ffi::OsStrExt;
        let Ok(rd) = std::fs::read_dir(dir) else {
            return Vec::new();
        };
        let mut all: Vec<(String, Option<std::fs::FileType>)> = Vec::new();
        for (i, e) in rd.enumerate() {
            if i >= MAX_SCANNED_PER_DIR {
                self.out.truncated = true;
                break;
            }
            let Ok(e) = e else { continue };
            let raw = e.file_name();
            if raw.as_bytes().starts_with(b".") {
                continue;
            }
            let ft = e.file_type().ok();
            match raw.to_str() {
                Some(n) => all.push((n.to_owned(), ft)),
                None if self.candidate(raw.as_bytes(), ft) => self.out.ignored += 1,
                None => {}
            }
        }
        all.sort_by(|a, b| a.0.cmp(&b.0));
        let keep = all.len().min(self.budget);
        self.budget -= keep;
        if all[keep..]
            .iter()
            .any(|(n, ft)| self.candidate(n.as_bytes(), *ft))
        {
            self.out.truncated = true;
        }
        all.truncate(keep);
        all.into_iter().map(|(n, _)| n).collect()
    }

    fn push(&mut self, rel: String, file: &Path) {
        if !self.seen.insert(file.to_path_buf()) {
            return;
        }
        if self.out.files.len() >= MAX_FILES_PER_ROOT {
            // Une vraie candidate écartée : coupé, et rien de plus à lire.
            self.out.truncated = true;
            self.stop = true;
            return;
        }
        if let Some(head) = read_regular(file, MAX_HEAD_BYTES as u64, false) {
            self.out.files.push(FoundCommandFile { rel, head });
        }
    }

    /// `**/*.md`, profondeur d'abord, noms triés.
    fn commands(&mut self, dir: &Path, prefix: &str, depth: usize) {
        if !self.seen.insert(dir.to_path_buf()) {
            return;
        }
        for name in self.entries(dir) {
            if self.stop {
                return;
            }
            let rel = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            match kind_of(&dir.join(&name), self.root) {
                Kind::Dir(d) if depth < MAX_DEPTH => self.commands(&d, &rel, depth + 1),
                Kind::File(f) if name.ends_with(".md") => self.push(rel, &f),
                _ => {}
            }
        }
    }

    /// `<dossier>/SKILL.md`.
    fn skills(&mut self, dir: &Path) {
        for name in self.entries(dir) {
            if self.stop {
                return;
            }
            let Kind::Dir(d) = kind_of(&dir.join(&name), self.root) else {
                continue;
            };
            if let Kind::File(f) = kind_of(&d.join("SKILL.md"), self.root) {
                self.push(name, &f);
            }
        }
    }
}

impl CommandFiles for FsCommandFiles {
    fn scan(&self, root: &Path, layout: CommandLayout) -> CommandScan {
        let Ok(root) = std::fs::canonicalize(root) else {
            return CommandScan::default();
        };
        if !root.is_dir() {
            return CommandScan::default();
        }
        let mut w = Walk {
            root: &root,
            layout,
            budget: MAX_DIR_ENTRIES_PER_ROOT,
            out: CommandScan::default(),
            stop: false,
            seen: HashSet::new(),
        };
        match layout {
            CommandLayout::Commands => w.commands(&root, "", 0),
            CommandLayout::Skills => w.skills(&root),
        }
        w.out
    }

    fn read_json(&self, path: &Path) -> Option<serde_json::Value> {
        // Le fichier lui-même peut être un lien (réglages partagés entre profils).
        let real = std::fs::canonicalize(path).ok()?;
        let bytes = read_regular(&real, MAX_JSON_BYTES, true)?;
        serde_json::from_slice(&bytes).ok()
    }

    fn dir_within(&self, path: &Path, base: &Path) -> Option<PathBuf> {
        let base = std::fs::canonicalize(base).ok()?;
        let p = std::fs::canonicalize(path).ok()?;
        (p.starts_with(&base) && p.is_dir()).then_some(p)
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::symlink;

    use super::*;

    fn write(p: &Path, s: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, s).unwrap();
    }

    fn rels(s: &CommandScan) -> Vec<&str> {
        s.files.iter().map(|f| f.rel.as_str()).collect()
    }

    #[test]
    fn commands_are_walked_sorted_and_bounded_in_depth() {
        let t = tempfile::tempdir().unwrap();
        let r = t.path().join("commands");
        write(&r.join("b.md"), "b");
        write(&r.join("a/x.md"), "x");
        write(&r.join("notes.txt"), "n");
        write(&r.join(".cache/y.md"), "y");
        write(&r.join(".z.md"), "z");
        write(&r.join("1/2/3/4/ok.md"), "ok");
        write(&r.join("1/2/3/4/5/trop.md"), "trop");
        let s = FsCommandFiles.scan(&r, CommandLayout::Commands);
        assert_eq!(rels(&s), ["1/2/3/4/ok.md", "a/x.md", "b.md"]);
        assert!(!s.truncated);
        assert_eq!(s.files[2].head, b"b");
    }

    #[test]
    fn head_is_bounded() {
        let t = tempfile::tempdir().unwrap();
        write(&t.path().join("gros.md"), &"x".repeat(100_000));
        let s = FsCommandFiles.scan(t.path(), CommandLayout::Commands);
        assert_eq!(s.files[0].head.len(), MAX_HEAD_BYTES);
    }

    #[test]
    fn file_count_is_bounded() {
        let t = tempfile::tempdir().unwrap();
        for i in 0..MAX_FILES_PER_ROOT + 10 {
            write(&t.path().join(format!("c{i:04}.md")), "");
        }
        let s = FsCommandFiles.scan(t.path(), CommandLayout::Commands);
        assert_eq!(s.files.len(), MAX_FILES_PER_ROOT);
        assert!(s.truncated);
    }

    #[test]
    fn symlinks_are_followed_only_inside_the_root() {
        let t = tempfile::tempdir().unwrap();
        let r = t.path().join("commands");
        let outside = t.path().join("dehors");
        write(&outside.join("secret.md"), "secret");
        write(&r.join("vrai/dedans.md"), "dedans");
        symlink(&outside, r.join("lien-dehors")).unwrap();
        symlink(outside.join("secret.md"), r.join("fichier-dehors.md")).unwrap();
        symlink(r.join("vrai"), r.join("lien-dedans")).unwrap();
        symlink(r.join("vrai/dedans.md"), r.join("alias.md")).unwrap();
        symlink(r.join("absent.md"), r.join("casse.md")).unwrap();
        let s = FsCommandFiles.scan(&r, CommandLayout::Commands);
        // Liens internes suivis, mais un même fichier ou dossier une seule fois
        // (le premier nom dans l'ordre du parcours).
        assert_eq!(rels(&s), ["alias.md"]);
        symlink(&r, r.join("boucle")).unwrap();
        let s = FsCommandFiles.scan(&r, CommandLayout::Commands);
        assert_eq!(rels(&s), ["alias.md"]);
    }

    #[test]
    fn a_linked_root_is_resolved() {
        let t = tempfile::tempdir().unwrap();
        let real = t.path().join("profil/skills");
        write(&real.join("grill/SKILL.md"), "---\ndescription: d\n---\n");
        write(&real.join("vide/README.md"), "");
        symlink(&real, t.path().join("skills-lien")).unwrap();
        let s = FsCommandFiles.scan(&t.path().join("skills-lien"), CommandLayout::Skills);
        assert_eq!(rels(&s), ["grill"]);
    }

    #[test]
    fn fifos_are_not_opened() {
        let t = tempfile::tempdir().unwrap();
        let fifo = t.path().join("tube.md");
        nix::unistd::mkfifo(&fifo, nix::sys::stat::Mode::from_bits_truncate(0o600)).unwrap();
        // Ouverte directement : refusée sans bloquer (sans écrivain, une
        // ouverture bloquante attendrait indéfiniment).
        let (tx, rx) = std::sync::mpsc::channel();
        let p = fifo.clone();
        std::thread::spawn(move || {
            let _ = tx.send(read_regular(&p, 64, false));
        });
        let got = rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("read_regular a bloqué sur une FIFO");
        assert_eq!(got, None);
        // Et le parcours ne la retient pas.
        let s = FsCommandFiles.scan(t.path(), CommandLayout::Commands);
        assert!(s.files.is_empty());
    }

    #[test]
    fn truncation_is_sorted_and_only_for_real_candidates() {
        let t = tempfile::tempdir().unwrap();
        for i in 0..MAX_FILES_PER_ROOT {
            write(&t.path().join(format!("c{i:04}.md")), "");
        }
        // Après les 300 `.md` dans l'ordre des noms : seulement des non-candidats.
        for i in 0..20 {
            write(&t.path().join(format!("z{i}.txt")), "");
        }
        let s = FsCommandFiles.scan(t.path(), CommandLayout::Commands);
        assert_eq!(s.files.len(), MAX_FILES_PER_ROOT);
        assert!(!s.truncated, "aucun .md écarté");
        assert_eq!(s.files[0].rel, "c0000.md");
        // Un `.md` de plus : écarté, coupé ; toujours les premiers par nom.
        write(&t.path().join("d.md"), "");
        let s = FsCommandFiles.scan(t.path(), CommandLayout::Commands);
        assert!(s.truncated);
        assert_eq!(
            s.files.last().unwrap().rel,
            format!("c{:04}.md", MAX_FILES_PER_ROOT - 1)
        );
    }

    #[test]
    fn non_utf8_names_are_counted() {
        use std::os::unix::ffi::OsStrExt;
        let t = tempfile::tempdir().unwrap();
        let bad = std::ffi::OsStr::from_bytes(b"\xff\xfe.md");
        std::fs::write(t.path().join(bad), "").unwrap();
        std::fs::write(t.path().join(std::ffi::OsStr::from_bytes(b"\xff.txt")), "").unwrap();
        write(&t.path().join("ok.md"), "");
        let s = FsCommandFiles.scan(t.path(), CommandLayout::Commands);
        assert_eq!(rels(&s), ["ok.md"]);
        assert_eq!(s.ignored, 1);
    }

    #[test]
    fn missing_root_is_empty() {
        let s = FsCommandFiles.scan(Path::new("/nulle/part/commands"), CommandLayout::Commands);
        assert_eq!(s, CommandScan::default());
    }

    #[test]
    fn json_and_dir_within() {
        let t = tempfile::tempdir().unwrap();
        write(&t.path().join("a.json"), r#"{"x": 1}"#);
        write(&t.path().join("bad.json"), "{");
        write(
            &t.path().join("big.json"),
            &" ".repeat(MAX_JSON_BYTES as usize + 1),
        );
        assert_eq!(
            FsCommandFiles.read_json(&t.path().join("a.json")),
            Some(serde_json::json!({"x": 1}))
        );
        assert_eq!(FsCommandFiles.read_json(&t.path().join("bad.json")), None);
        assert_eq!(FsCommandFiles.read_json(&t.path().join("big.json")), None);
        assert_eq!(
            FsCommandFiles.read_json(&t.path().join("absent.json")),
            None
        );

        let base = t.path().join("plugins");
        std::fs::create_dir_all(base.join("cache/p/1")).unwrap();
        symlink(&base, t.path().join("plugins-lien")).unwrap();
        let canon = base.canonicalize().unwrap();
        assert_eq!(
            FsCommandFiles.dir_within(&t.path().join("plugins-lien/cache/p/1"), &base),
            Some(canon.join("cache/p/1"))
        );
        assert_eq!(FsCommandFiles.dir_within(t.path(), &base), None);
        assert_eq!(FsCommandFiles.dir_within(&base.join("absent"), &base), None);
    }
}
