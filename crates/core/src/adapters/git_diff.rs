//! Diff d'un worktree par la CLI `git` (v0.2, lot 1).
//!
//! - Chaque commande est lancée avec ses arguments séparés (jamais par un
//!   shell), depuis la racine du worktree, avec `--literal-pathspecs` (un nom
//!   de fichier n'est jamais lu comme un motif), `--no-pager`, et une
//!   configuration durcie ([`HARDENING`] : ni fsmonitor, ni hooks, ni diff
//!   externe, ni pager, chemins non échappés, diff jamais relatif) ;
//!   environnement : `GIT_CONFIG_NOSYSTEM=1`, `GIT_OPTIONAL_LOCKS=0` (aucune
//!   écriture de l'index), `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C`. Chaque
//!   commande est tuée au bout de [`GIT_TIMEOUT`].
//! - Risque résiduel : comparer à l'arbre de travail peut lancer les filtres
//!   `filter.<pilote>.clean` déclarés par le dépôt (`.gitattributes` et
//!   configuration du dépôt, comme Git LFS). Ils ne peuvent pas être coupés de
//!   façon générique ; un dépôt non fiable peut donc exécuter du code à chaque
//!   calcul, comme il le ferait avec un `git status` de l'utilisateur.
//! - Base : `git merge-base HEAD <branche par défaut>` (`origin/HEAD`, sinon
//!   `main`, sinon `master`, toujours par leur référence complète
//!   `refs/…`), à défaut `HEAD`, et l'arbre vide pour un dépôt sans commit.
//! - Fichiers : `git diff -M --name-status -z <base>` et `--numstat -z`
//!   (base contre l'arbre de travail : commits depuis la base, index et
//!   modifications non indexées), plus `git ls-files --others
//!   --exclude-standard -z` pour les fichiers non suivis (au plus
//!   [`MAX_UNTRACKED`] ; les lignes ne sont comptées que pour les
//!   [`MAX_COUNTED_UNTRACKED`] plus récents, avec un cache par taille et date).

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use super::git_exec::{GitExec, Out, failed};
use crate::domain::diff::{
    BaseKind, ChangeSet, ChangedFile, DiffBase, FileDiff, FileStatus, MAX_COUNTED_UNTRACKED,
    MAX_FILE_BYTES, count_lines, looks_binary, parse_unified, tracked_files, untracked_diff,
};
use crate::ports::{DiffError, DiffSource};

pub use super::git_exec::{GIT_TIMEOUT, HARDENING, MAX_OUTPUT};

/// Nombre maximal de fichiers non suivis listés.
pub const MAX_UNTRACKED: usize = 2000;
/// Entrées gardées au plus dans le cache des lignes des fichiers non suivis.
const LINE_CACHE_MAX: usize = 20_000;

/// Lignes et binarité d'un fichier non suivi, pour une taille et une date.
type LineCache = HashMap<PathBuf, (u64, i128, u64, bool)>;

/// [`DiffSource`] par la CLI `git` (appels durcis de [`GitExec`]).
#[derive(Debug)]
pub struct GitDiff {
    git: GitExec,
    lines: Mutex<LineCache>,
}

impl Default for GitDiff {
    fn default() -> Self {
        Self {
            git: GitExec::default(),
            lines: Mutex::new(HashMap::new()),
        }
    }
}

/// Taille et date de modification (ns) d'un fichier, sans suivre de lien.
fn stamp(p: &Path) -> Option<(u64, i128)> {
    let m = std::fs::symlink_metadata(p).ok()?;
    let t = m.modified().ok()?;
    let ns = match t.duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => d.as_nanos() as i128,
        Err(e) => -(e.duration().as_nanos() as i128),
    };
    Some((m.len(), ns))
}

/// Lit au plus `MAX_FILE_BYTES + 1` octets d'un fichier ordinaire.
fn read_capped(p: &Path) -> Option<Vec<u8>> {
    let meta = std::fs::symlink_metadata(p).ok()?;
    if !meta.is_file() {
        return None;
    }
    let mut buf = Vec::new();
    std::fs::File::open(p)
        .ok()?
        .take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut buf)
        .ok()?;
    Some(buf)
}

impl GitDiff {
    fn run(&self, dir: &Path, args: &[&str]) -> Result<Out, DiffError> {
        self.git.run(dir, args)
    }

    fn line(&self, dir: &Path, args: &[&str]) -> Option<String> {
        self.git.line(dir, args)
    }

    fn toplevel(&self, cwd: &Path) -> Result<PathBuf, DiffError> {
        self.line(cwd, &["rev-parse", "--show-toplevel"])
            .map(PathBuf::from)
            .ok_or(DiffError::NotARepo)
    }

    fn default_branch(&self, top: &Path) -> Option<(String, String)> {
        self.git.default_branch(top)
    }

    /// Base du diff et `HEAD`.
    fn base(&self, top: &Path) -> Result<(DiffBase, Option<String>), DiffError> {
        let head = self.line(top, &["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
        if let Some(h) = &head
            && let Some((full, short)) = self.default_branch(top)
            && let Some(sha) = self.line(top, &["merge-base", h, &full])
        {
            return Ok((
                DiffBase {
                    reference: short,
                    sha,
                    kind: BaseKind::MergeBase,
                },
                head,
            ));
        }
        let sha = match &head {
            Some(h) => h.clone(),
            // Dépôt sans commit : l'arbre vide (son identifiant dépend du
            // format d'objets du dépôt).
            None => self
                .line(top, &["hash-object", "-t", "tree", "/dev/null"])
                .ok_or_else(|| failed("hash-object", "arbre vide introuvable"))?,
        };
        Ok((
            DiffBase {
                reference: "HEAD".into(),
                sha,
                kind: BaseKind::Head,
            },
            head,
        ))
    }

    fn diff_args<'a>(base: &'a str, extra: &[&'a str]) -> Vec<&'a str> {
        let mut v = vec!["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-M"];
        v.extend_from_slice(extra);
        v.push(base);
        v
    }

    /// Lignes et binarité d'un fichier non suivi (cache par taille et date).
    fn count_untracked(&self, abs: &Path, st: (u64, i128)) -> (Option<u64>, bool) {
        let cache = self.lines.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((size, mtime, lines, binary)) = cache.get(abs)
            && (*size, *mtime) == st
        {
            return (Some(*lines), *binary);
        }
        drop(cache);
        let Some(content) = read_capped(abs) else {
            return (None, false);
        };
        if content.len() as u64 > MAX_FILE_BYTES {
            return (None, looks_binary(&content));
        }
        let (lines, binary) = (count_lines(&content), looks_binary(&content));
        let mut cache = self.lines.lock().unwrap_or_else(|e| e.into_inner());
        if cache.len() >= LINE_CACHE_MAX {
            cache.clear();
        }
        cache.insert(abs.to_path_buf(), (st.0, st.1, lines, binary));
        (Some(lines), binary)
    }
}

impl DiffSource for GitDiff {
    fn changes(&self, cwd: &Path) -> Result<ChangeSet, DiffError> {
        let top = self.toplevel(cwd)?;
        let (base, head) = self.base(&top)?;
        let ns = self.run(&top, &Self::diff_args(&base.sha, &["--name-status", "-z"]))?;
        let num = self.run(&top, &Self::diff_args(&base.sha, &["--numstat", "-z"]))?;
        if !ns.ok || !num.ok {
            return Err(failed("diff", "échec"));
        }
        let mut truncated = ns.truncated || num.truncated;
        let (mut files, mut skipped) = tracked_files(&ns.stdout, &num.stdout);
        for f in &mut files {
            if f.status != FileStatus::Deleted {
                f.stamp = stamp(&top.join(&f.path));
            }
        }
        let untracked = self.run(&top, &["ls-files", "--others", "--exclude-standard", "-z"])?;
        if untracked.ok {
            truncated |= untracked.truncated;
            let mut found: Vec<(String, Option<(u64, i128)>)> = Vec::new();
            for raw in untracked
                .stdout
                .split(|b| *b == 0)
                .filter(|p| !p.is_empty())
            {
                if found.len() == MAX_UNTRACKED {
                    truncated = true;
                    break;
                }
                match std::str::from_utf8(raw) {
                    Ok(p) => found.push((p.to_owned(), stamp(&top.join(p)))),
                    Err(_) => skipped += 1,
                }
            }
            // Lignes comptées pour les plus récents seulement.
            let mut by_recent: Vec<usize> = (0..found.len()).collect();
            by_recent.sort_by_key(|i| std::cmp::Reverse(found[*i].1.map_or(i128::MIN, |s| s.1)));
            let counted: std::collections::HashSet<usize> =
                by_recent.into_iter().take(MAX_COUNTED_UNTRACKED).collect();
            for (i, (path, st)) in found.into_iter().enumerate() {
                let (additions, binary) = match st {
                    Some(st) if counted.contains(&i) => self.count_untracked(&top.join(&path), st),
                    _ => (None, false),
                };
                files.push(ChangedFile {
                    path,
                    old_path: None,
                    status: FileStatus::Untracked,
                    additions,
                    deletions: 0,
                    binary,
                    stamp: st,
                });
            }
        }
        files.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(ChangeSet {
            root: top,
            base,
            head,
            files,
            truncated,
            skipped_non_utf8: skipped,
        })
    }

    fn root(&self, cwd: &Path) -> Result<PathBuf, DiffError> {
        self.toplevel(cwd)
    }

    fn repo_files(&self, root: &Path) -> Result<(Vec<String>, bool), DiffError> {
        let out = self.run(
            root,
            &[
                "ls-files",
                "--cached",
                "--others",
                "--exclude-standard",
                "-z",
            ],
        )?;
        if !out.ok {
            return Err(failed("ls-files", "échec"));
        }
        let mut truncated = out.truncated;
        let mut files = Vec::new();
        for raw in out.stdout.split(|b| *b == 0).filter(|p| !p.is_empty()) {
            if files.len() == crate::domain::files::MAX_REPO_FILES {
                truncated = true;
                break;
            }
            // Chemin non UTF-8 : ignoré (jamais montré déformé).
            if let Ok(p) = std::str::from_utf8(raw) {
                files.push(p.to_owned());
            }
        }
        files.dedup();
        Ok((files, truncated))
    }

    fn file_diff(&self, changes: &ChangeSet, file: &ChangedFile) -> Result<FileDiff, DiffError> {
        let top = &changes.root;
        let base = &changes.base;
        let work = top.join(&file.path);
        if file.status == FileStatus::Untracked {
            return Ok(match read_capped(&work) {
                Some(c) if c.len() as u64 > MAX_FILE_BYTES => FileDiff::too_large(),
                Some(c) => untracked_diff(&c),
                None => FileDiff::default(),
            });
        }
        if file.binary {
            return Ok(FileDiff::binary());
        }
        // Taille de chaque côté avant de demander le diff.
        if stamp(&work).is_some_and(|(s, _)| s > MAX_FILE_BYTES) {
            return Ok(FileDiff::too_large());
        }
        let old = file.old_path.as_deref().unwrap_or(&file.path);
        if file.status != FileStatus::Added {
            let spec = format!("{}:{old}", base.sha);
            if let Some(s) = self.line(top, &["cat-file", "-s", &spec])
                && s.parse::<u64>().is_ok_and(|s| s > MAX_FILE_BYTES)
            {
                return Ok(FileDiff::too_large());
            }
        }
        let mut args = Self::diff_args(&base.sha, &["-U3"]);
        args.push("--");
        if file.old_path.is_some() {
            args.push(old);
        }
        args.push(&file.path);
        let out = self.run(top, &args)?;
        if !out.ok {
            return Err(failed("diff", "échec"));
        }
        if out.truncated {
            return Ok(FileDiff::too_large());
        }
        Ok(parse_unified(&out.stdout))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};
    use std::time::Duration;

    fn git(dir: &Path, args: &[&str]) -> bool {
        Command::new("git")
            .arg("-C")
            .arg(dir)
            .args([
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    }

    #[test]
    fn changes_since_the_branch_point() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let g = GitDiff::default();
        assert_eq!(g.changes(&root), Err(DiffError::NotARepo));
        if !git(&root, &["init", "-q", "-b", "main"]) {
            eprintln!("git absent : test sauté");
            return;
        }
        // Dépôt sans commit : base = arbre vide, tout est non suivi.
        std::fs::write(root.join("a.txt"), "un\n").unwrap();
        let c = g.changes(&root).unwrap();
        assert_eq!(c.base.kind, BaseKind::Head);
        assert_eq!(c.files[0].status, FileStatus::Untracked);
        assert_eq!(c.files[0].additions, Some(1));
        assert!(c.head.is_none());

        std::fs::write(root.join("a.txt"), "un\ndeux\ntrois\n").unwrap();
        std::fs::write(
            root.join("vieux.txt"),
            "contenu assez long pour un renommage\n".repeat(5),
        )
        .unwrap();
        std::fs::write(root.join("parti.txt"), "x\n").unwrap();
        assert!(git(&root, &["add", "."]));
        assert!(git(&root, &["commit", "-q", "-m", "base"]));
        assert!(git(&root, &["checkout", "-q", "-b", "fonction"]));
        // Commit sur la branche, plus du travail non commité et non suivi.
        std::fs::write(root.join("a.txt"), "un\nDEUX\ntrois\nquatre\n").unwrap();
        assert!(git(&root, &["commit", "-q", "-am", "modif"]));
        assert!(git(&root, &["mv", "vieux.txt", "neuf.txt"]));
        std::fs::remove_file(root.join("parti.txt")).unwrap();
        std::fs::write(root.join("bin.dat"), b"\0\x01\x02").unwrap();
        std::fs::create_dir(root.join("sous")).unwrap();
        std::fs::write(root.join("sous/-n.txt"), "a\nb\n").unwrap();
        std::fs::write(root.join(".gitignore"), "ignoré.log\n").unwrap();
        std::fs::write(root.join("ignoré.log"), "x\n").unwrap();

        // Depuis un sous-dossier : chemins relatifs à la racine.
        let c = g.changes(&root.join("sous")).unwrap();
        assert_eq!(c.base.kind, BaseKind::MergeBase);
        assert_eq!(c.base.reference, "main");
        let by = |p: &str| {
            c.file(p)
                .unwrap_or_else(|| panic!("{p} : {:?}", c.files))
                .clone()
        };
        let a = by("a.txt");
        assert_eq!(
            (a.status, a.additions, a.deletions),
            (FileStatus::Modified, Some(2), 1)
        );
        let r = by("neuf.txt");
        assert_eq!(r.status, FileStatus::Renamed);
        assert_eq!(r.old_path.as_deref(), Some("vieux.txt"));
        assert_eq!(by("parti.txt").status, FileStatus::Deleted);
        let b = by("bin.dat");
        assert!(b.binary && b.status == FileStatus::Untracked);
        assert_eq!(by("sous/-n.txt").additions, Some(2));
        assert!(a.stamp.is_some() && by("parti.txt").stamp.is_none());
        assert!(c.head.is_some() && !c.truncated && c.skipped_non_utf8 == 0);
        assert!(c.file("ignoré.log").is_none());
        assert_eq!(by(".gitignore").status, FileStatus::Untracked);

        // Diff d'un fichier.
        let d = g.file_diff(&c, &a).unwrap();
        let lines: Vec<_> = d.hunks[0]
            .lines
            .iter()
            .map(|l| (l.kind, l.text.as_str()))
            .collect();
        assert_eq!(
            lines,
            [
                (' ', "un"),
                ('-', "deux"),
                ('+', "DEUX"),
                (' ', "trois"),
                ('+', "quatre")
            ]
        );
        assert!(g.file_diff(&c, &b).unwrap().binary);
        let n = g.file_diff(&c, &by("sous/-n.txt")).unwrap();
        assert_eq!(n.hunks[0].lines.len(), 2);
        let r = g.file_diff(&c, &r).unwrap();
        assert!(r.hunks.is_empty(), "renommage pur : {r:?}");
        // Trop gros.
        std::fs::write(root.join("a.txt"), "x".repeat(MAX_FILE_BYTES as usize + 10)).unwrap();
        let c = g.changes(&root).unwrap();
        assert!(g.file_diff(&c, c.file("a.txt").unwrap()).unwrap().too_large);
        // Sur la branche par défaut elle-même, sans rien de neuf : rien.
        assert!(git(&root, &["checkout", "-q", "-f", "main"]));
        assert!(git(&root, &["clean", "-q", "-fdx"]));
        let c = g.changes(&root).unwrap();
        assert!(c.files.is_empty(), "{:?}", c.files);
    }

    #[test]
    fn untracked_caps_cache_non_utf8_and_stamps() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        if !git(&root, &["init", "-q", "-b", "main"]) {
            eprintln!("git absent : test sauté");
            return;
        }
        std::fs::write(root.join("suivi.txt"), "a\n").unwrap();
        assert!(git(&root, &["add", "."]));
        assert!(git(&root, &["commit", "-q", "-m", "base"]));
        let g = GitDiff::default();

        // Même compteurs, contenu différent : l'empreinte change.
        std::fs::write(root.join("suivi.txt"), "b\n").unwrap();
        let before = g.changes(&root).unwrap();
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(root.join("suivi.txt"), "cc\n").unwrap();
        let after = g.changes(&root).unwrap();
        assert_eq!(before.files[0].additions, after.files[0].additions);
        assert_ne!(before.fingerprint(), after.fingerprint());

        // Chemin non UTF-8 : écarté et compté.
        {
            use std::os::unix::ffi::OsStrExt;
            let name = std::ffi::OsStr::from_bytes(b"mauvais-\xff.txt");
            std::fs::write(root.join(name), "x\n").unwrap();
        }
        let c = g.changes(&root).unwrap();
        assert_eq!(c.skipped_non_utf8, 1);
        assert!(c.files.iter().all(|f| !f.path.contains('\u{fffd}')));

        // Au-delà de 200 non suivis : lignes non comptées (les plus anciens).
        let many = root.join("beaucoup");
        std::fs::create_dir(&many).unwrap();
        for i in 0..(MAX_COUNTED_UNTRACKED + 5) {
            std::fs::write(many.join(format!("f{i:04}.txt")), "1\n2\n").unwrap();
        }
        let c = g.changes(&root).unwrap();
        let untracked: Vec<_> = c
            .files
            .iter()
            .filter(|f| f.status == FileStatus::Untracked)
            .collect();
        let counted = untracked.iter().filter(|f| f.additions.is_some()).count();
        assert_eq!(counted, MAX_COUNTED_UNTRACKED);
        assert!(!c.truncated);
        // Cache : un deuxième calcul donne la même chose.
        assert_eq!(g.changes(&root).unwrap().files, c.files);

        // Au-delà de 2 000 : liste tronquée.
        for i in 0..MAX_UNTRACKED {
            std::fs::write(many.join(format!("g{i:04}")), "").unwrap();
        }
        let c = g.changes(&root).unwrap();
        assert!(c.truncated);
        assert_eq!(
            c.files
                .iter()
                .filter(|f| f.status == FileStatus::Untracked)
                .count(),
            MAX_UNTRACKED
        );
    }

    #[test]
    fn repository_config_cannot_run_commands_or_change_paths() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        if !git(&root, &["init", "-q", "-b", "main"]) {
            eprintln!("git absent : test sauté");
            return;
        }
        std::fs::create_dir(root.join("sous")).unwrap();
        std::fs::write(root.join("sous/f.txt"), "a\n").unwrap();
        assert!(git(&root, &["add", "."]));
        assert!(git(&root, &["commit", "-q", "-m", "base"]));
        // Configuration hostile du dépôt : chaque commande laisserait une trace.
        let marker = root.join("piege");
        let script = root.join("piege.sh");
        std::fs::write(
            &script,
            format!("#!/bin/sh\ntouch '{}'\n", marker.display()),
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let s = script.to_str().unwrap();
        for (k, v) in [
            ("core.fsmonitor", s),
            ("diff.external", s),
            ("core.pager", s),
            ("diff.relative", "true"),
        ] {
            assert!(git(&root, &["config", k, v]));
        }
        std::fs::write(root.join("sous/f.txt"), "b\n").unwrap();
        let g = GitDiff::default();
        let c = g.changes(&root.join("sous")).unwrap();
        let f = c
            .file("sous/f.txt")
            .expect("chemin depuis la racine malgré diff.relative");
        let d = g.file_diff(&c, f).unwrap();
        assert_eq!(d.hunks[0].lines.len(), 2);
        assert!(!marker.exists(), "une commande du dépôt a été lancée");
    }
}
