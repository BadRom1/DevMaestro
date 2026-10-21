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
//! - Historique (v0.3, lot 9) : `git log -z` de `<base>..HEAD` (shas
//!   résolus d'abord : la liste et ses compteurs portent sur le même `HEAD`),
//!   format à champs séparés par des octets nuls
//!   ([`crate::domain::commits::LOG_FORMAT`]), `--encoding=UTF-8`,
//!   `--no-show-signature`, `--no-notes` ; compteurs par `--numstat -M
//!   --diff-merges=first-parent --root` (une fusion contre son premier
//!   parent, un commit racine contre l'arbre vide). Diff d'un commit :
//!   `git diff -M <premier parent ou arbre vide> <commit>`, jamais contre
//!   l'arbre de travail.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use super::git_exec::{GitExec, Out, failed};
use crate::domain::commits::{
    Commit, CommitLog, CommitRange, LOG_FORMAT, MAX_LOG_JSON_BYTES, fit_commits, parse_log,
};
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
    /// Délai de `git log --numstat` (au-delà : liste relue sans compteurs).
    stats_timeout: std::time::Duration,
}

impl Default for GitDiff {
    fn default() -> Self {
        Self {
            git: GitExec::default(),
            lines: Mutex::new(HashMap::new()),
            stats_timeout: GIT_TIMEOUT,
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

    /// Arbre vide (son identifiant dépend du format d'objets du dépôt).
    fn empty_tree(&self, top: &Path) -> Result<String, DiffError> {
        self.line(top, &["hash-object", "-t", "tree", "/dev/null"])
            .ok_or_else(|| failed("hash-object", "arbre vide introuvable"))
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
            None => self.empty_tree(top)?,
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
            target: None,
            files,
            truncated,
            skipped_non_utf8: skipped,
        })
    }

    fn root(&self, cwd: &Path) -> Result<PathBuf, DiffError> {
        self.toplevel(cwd)
    }

    fn user_email(&self, cwd: &Path) -> Option<String> {
        self.line(cwd, &["config", "--get", "user.email"])
            .filter(|e| !e.trim().is_empty())
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
        let target = changes.target.as_deref();
        if file.status == FileStatus::Untracked && target.is_none() {
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
        let too_big = |rev: &str, path: &str| {
            let spec = format!("{rev}:{path}");
            self.line(top, &["cat-file", "-s", &spec])
                .is_some_and(|s| s.parse::<u64>().is_ok_and(|s| s > MAX_FILE_BYTES))
        };
        let new_too_big = match target {
            None => stamp(&work).is_some_and(|(s, _)| s > MAX_FILE_BYTES),
            Some(t) => file.status != FileStatus::Deleted && too_big(t, &file.path),
        };
        if new_too_big {
            return Ok(FileDiff::too_large());
        }
        let old = file.old_path.as_deref().unwrap_or(&file.path);
        if file.status != FileStatus::Added && too_big(&base.sha, old) {
            return Ok(FileDiff::too_large());
        }
        let mut args = Self::diff_args(&base.sha, &["-U3"]);
        if let Some(t) = target {
            args.push(t);
        }
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

    fn commits(
        &self,
        cwd: &Path,
        limit: usize,
        stats: bool,
        range: Option<CommitRange>,
    ) -> Result<CommitLog, DiffError> {
        let top = self.toplevel(cwd)?;
        let (base, head) = self.base(&top)?;
        let mut log = CommitLog {
            root: top,
            // Sans commit : comme une base égale à `HEAD`.
            range: CommitRange::resolve(range, &base.sha, head.as_deref().unwrap_or(&base.sha)),
            base,
            head,
            commits: Vec::new(),
            truncated: false,
            stats,
        };
        // Pas de commit : rien à lister.
        let Some(head) = log.head.clone() else {
            return Ok(log);
        };
        // Plage de la branche vide (base = `HEAD`) : pas de `git log`.
        if log.range == CommitRange::Branch && head == log.base.sha {
            return Ok(log);
        }
        let max = format!("--max-count={}", limit.saturating_add(1));
        let exclude = format!("^{}", log.base.sha);
        let args = |stats: bool| {
            let mut args = vec![
                "log",
                "-z",
                "--no-color",
                "--encoding=UTF-8",
                "--no-show-signature",
                "--no-notes",
                LOG_FORMAT,
                &max,
            ];
            if stats {
                args.extend_from_slice(&[
                    "--numstat",
                    "--no-ext-diff",
                    "--no-textconv",
                    "-M",
                    "--diff-merges=first-parent",
                    "--root",
                ]);
            }
            args.extend_from_slice(&["--end-of-options", &head]);
            if log.range == CommitRange::Branch {
                args.push(&exclude);
            }
            args.push("--");
            args
        };
        // Compteurs trop lents (gros commits, dépôt énorme) : la liste est
        // relue sans eux plutôt que d'échouer.
        let timed = if stats {
            self.git
                .run_or_timeout(&log.root, &args(true), self.stats_timeout)?
        } else {
            None
        };
        let out = match timed {
            Some(out) => out,
            None => {
                log.stats = false;
                self.git.run(&log.root, &args(false))?
            }
        };
        if !out.ok {
            return Err(failed("log", "échec"));
        }
        let (mut commits, stopped) = parse_log(&out.stdout);
        if out.truncated {
            // Dernier commit peut-être incomplet (compteurs).
            commits.pop();
        }
        log.truncated = out.truncated || stopped || commits.len() > limit;
        commits.truncate(limit);
        log.truncated |= fit_commits(&mut commits, MAX_LOG_JSON_BYTES);
        log.commits = commits;
        Ok(log)
    }

    fn commit_changes(&self, root: &Path, commit: &Commit) -> Result<ChangeSet, DiffError> {
        let (parent, kind, reference) = match commit.first_parent() {
            Some(p) => (
                p.to_owned(),
                BaseKind::Parent,
                crate::domain::commits::short_sha(p).to_owned(),
            ),
            None => (
                self.empty_tree(root)?,
                BaseKind::Root,
                "arbre vide".to_owned(),
            ),
        };
        let diff = |extra: &[&str]| {
            let mut args = Self::diff_args(&parent, extra);
            args.extend_from_slice(&[&commit.sha, "--"]);
            self.run(root, &args)
        };
        let ns = diff(&["--name-status", "-z"])?;
        let num = diff(&["--numstat", "-z"])?;
        if !ns.ok || !num.ok {
            return Err(failed("diff", "échec"));
        }
        let (mut files, skipped) = tracked_files(&ns.stdout, &num.stdout);
        files.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(ChangeSet {
            root: root.to_path_buf(),
            base: DiffBase {
                reference,
                sha: parent,
                kind,
            },
            head: Some(commit.sha.clone()),
            target: Some(commit.sha.clone()),
            files,
            truncated: ns.truncated || num.truncated,
            skipped_non_utf8: skipped,
        })
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

    #[test]
    fn commits_since_the_base_with_merge_root_and_counters() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let g = GitDiff::default();
        assert_eq!(g.commits(&root, 10, true, None), Err(DiffError::NotARepo));
        if !git(&root, &["init", "-q", "-b", "main"]) {
            eprintln!("git absent : test sauté");
            return;
        }
        // Dépôt sans commit : liste vide.
        let log = g.commits(&root, 10, true, None).unwrap();
        assert!(log.commits.is_empty() && log.head.is_none() && !log.truncated);
        std::fs::write(root.join("a.txt"), "1\n2\n3\n4\n5\n6\n7\n8\n").unwrap();
        assert!(git(&root, &["add", "."]));
        assert!(git(&root, &["commit", "-q", "-m", "base"]));
        // Sur la branche par défaut elle-même : rien sur la branche, donc
        // les derniers commits de `HEAD` en automatique.
        let branch = g
            .commits(&root, 10, true, Some(CommitRange::Branch))
            .unwrap();
        assert!(branch.commits.is_empty() && branch.range == CommitRange::Branch);
        let recent = g.commits(&root, 10, true, None).unwrap();
        assert_eq!(recent.range, CommitRange::Recent);
        assert_eq!(recent.commits.len(), 1);
        assert_eq!(recent.commits[0].subject, "base");
        assert_eq!(
            (recent.commits[0].files, recent.commits[0].additions),
            (1, 8)
        );
        // Configuration du dépôt qui changerait la sortie si elle était lue.
        for (k, v) in [
            ("i18n.logOutputEncoding", "ISO-8859-1"),
            ("log.showRoot", "false"),
            ("log.showSignature", "true"),
            ("color.ui", "always"),
            ("diff.renames", "false"),
            ("format.pretty", "oneline"),
            ("log.diffMerges", "separate"),
        ] {
            assert!(git(&root, &["config", k, v]));
        }
        assert!(git(&root, &["checkout", "-q", "-b", "fonction"]));
        std::fs::write(root.join("a.txt"), "1\nDEUX\n3\n4\n5\n6\n7\n8\n").unwrap();
        std::fs::write(root.join("bin.dat"), b"\0\x01").unwrap();
        assert!(git(&root, &["add", "."]));
        let message =
            "Sujet « accentué »\n\nCorps ligne 1\n 3 files changed, 1 insertion(+)\n\n`fin`\n";
        assert!(git(
            &root,
            &[
                "commit",
                "-q",
                "--author=Élodie Ü <e@exemple.fr>",
                "-m",
                message
            ]
        ));
        assert!(git(&root, &["mv", "a.txt", "b.txt"]));
        assert!(git(&root, &["commit", "-q", "-m", "renommage"]));
        // Historique sans lien (sa racine entre dans la liste), puis fusion.
        assert!(git(&root, &["checkout", "-q", "--orphan", "autre"]));
        assert!(git(&root, &["rm", "-q", "-rf", "."]));
        std::fs::write(root.join("o.txt"), "x\ny\n").unwrap();
        assert!(git(&root, &["add", "."]));
        assert!(git(&root, &["commit", "-q", "-m", "racine sans lien"]));
        assert!(git(&root, &["checkout", "-q", "fonction"]));
        assert!(git(
            &root,
            &[
                "merge",
                "-q",
                "--no-edit",
                "--allow-unrelated-histories",
                "autre"
            ]
        ));

        let log = g.commits(&root, 10, true, None).unwrap();
        assert_eq!(log.base.kind, BaseKind::MergeBase);
        assert_eq!(log.range, CommitRange::Branch);
        // Forcé en récent : toute l'histoire de `HEAD`, base comprise.
        let recent = g
            .commits(&root, 10, false, Some(CommitRange::Recent))
            .unwrap();
        assert_eq!(recent.range, CommitRange::Recent);
        assert_eq!(recent.commits.len(), 5);
        assert!(recent.commits.iter().any(|c| c.subject == "base"));
        let subjects: Vec<_> = log.commits.iter().map(|c| c.subject.as_str()).collect();
        assert_eq!(subjects.len(), 4, "{subjects:?}");
        assert!(
            subjects[0].starts_with("Merge branch 'autre'"),
            "{subjects:?}"
        );
        assert!(subjects.contains(&"racine sans lien"));
        assert!(!subjects.contains(&"base"), "la base n'en fait pas partie");
        let by = |s: &str| log.commits.iter().find(|c| c.subject == s).unwrap().clone();
        let merge = log.commits[0].clone();
        assert_eq!(merge.parents.len(), 2);
        // Fusion contre son premier parent : o.txt ajouté.
        assert_eq!((merge.files, merge.additions, merge.deletions), (1, 2, 0));
        let first = by("Sujet « accentué »");
        assert_eq!(first.author, "Élodie Ü");
        assert_eq!(
            first.body,
            "Corps ligne 1\n 3 files changed, 1 insertion(+)\n\n`fin`"
        );
        assert_eq!((first.files, first.additions, first.deletions), (2, 1, 1));
        assert!(first.date.contains('T'), "{}", first.date);
        let rename = by("renommage");
        assert_eq!(
            (rename.files, rename.additions, rename.deletions),
            (1, 0, 0)
        );
        let orphan = by("racine sans lien");
        assert!(orphan.parents.is_empty());
        assert_eq!((orphan.files, orphan.additions), (1, 2));
        assert_eq!(log.head.as_deref(), Some(merge.sha.as_str()));
        // Limite et liste sans compteurs.
        let short = g.commits(&root, 2, false, None).unwrap();
        assert!(short.truncated);
        assert_eq!(short.commits.len(), 2);
        assert_eq!(short.commits[0].sha, merge.sha);
        assert_eq!(short.commits[0].files, 0);

        // Diff d'un commit : contre son premier parent.
        let c = g.commit_changes(&log.root, &first).unwrap();
        assert_eq!(c.base.kind, BaseKind::Parent);
        assert_eq!(c.base.sha, first.parents[0]);
        assert_eq!(c.target.as_deref(), Some(first.sha.as_str()));
        let paths: Vec<_> = c
            .files
            .iter()
            .map(|f| (f.path.as_str(), f.status))
            .collect();
        assert_eq!(
            paths,
            [
                ("a.txt", FileStatus::Modified),
                ("bin.dat", FileStatus::Added)
            ]
        );
        let d = g.file_diff(&c, c.file("a.txt").unwrap()).unwrap();
        let lines: Vec<_> = d.hunks[0]
            .lines
            .iter()
            .map(|l| (l.kind, l.text.as_str()))
            .collect();
        assert_eq!(lines[1], ('-', "2"));
        assert_eq!(lines[2], ('+', "DEUX"));
        assert!(g.file_diff(&c, c.file("bin.dat").unwrap()).unwrap().binary);
        // L'arbre de travail n'entre pas en jeu.
        std::fs::write(root.join("b.txt"), "tout autre chose\n").unwrap();
        let r = g.commit_changes(&log.root, &rename).unwrap();
        let f = r.file("b.txt").unwrap();
        assert_eq!(f.status, FileStatus::Renamed);
        assert!(g.file_diff(&r, f).unwrap().hunks.is_empty());
        // Commit racine : contre l'arbre vide.
        let o = g.commit_changes(&log.root, &orphan).unwrap();
        assert_eq!(o.base.kind, BaseKind::Root);
        assert_eq!(o.files[0].status, FileStatus::Added);
        let d = g.file_diff(&o, &o.files[0]).unwrap();
        assert_eq!(d.hunks[0].header, "@@ -0,0 +1,2 @@");
        // Fusion : contre le premier parent.
        let m = g.commit_changes(&log.root, &merge).unwrap();
        assert_eq!(m.files.len(), 1);
        assert_eq!(m.files[0].path, "o.txt");
    }

    #[test]
    fn slow_counters_fall_back_to_a_plain_list() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        if !git(&root, &["init", "-q", "-b", "main"]) {
            eprintln!("git absent : test sauté");
            return;
        }
        std::fs::write(root.join("a.txt"), "a\n").unwrap();
        assert!(git(&root, &["add", "."]));
        assert!(git(&root, &["commit", "-q", "-m", "base"]));
        // Délai nul : `git log --numstat` est toujours tué.
        let g = GitDiff {
            stats_timeout: std::time::Duration::ZERO,
            ..GitDiff::default()
        };
        let log = g.commits(&root, 5, true, None).unwrap();
        assert!(!log.stats);
        assert_eq!(log.commits.len(), 1);
        assert_eq!(log.commits[0].subject, "base");
        assert_eq!(log.commits[0].files, 0);
        // Délai normal : compteurs.
        let log = GitDiff::default().commits(&root, 5, true, None).unwrap();
        assert!(log.stats);
        assert_eq!(log.commits[0].files, 1);
        // Sans compteurs demandés.
        assert!(
            !GitDiff::default()
                .commits(&root, 5, false, None)
                .unwrap()
                .stats
        );
    }

    #[test]
    fn commit_file_too_large() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        if !git(&root, &["init", "-q", "-b", "main"]) {
            eprintln!("git absent : test sauté");
            return;
        }
        std::fs::write(root.join("a.txt"), "a\n").unwrap();
        assert!(git(&root, &["add", "."]));
        assert!(git(&root, &["commit", "-q", "-m", "base"]));
        assert!(git(&root, &["checkout", "-q", "-b", "f"]));
        std::fs::write(root.join("a.txt"), "x".repeat(MAX_FILE_BYTES as usize + 1)).unwrap();
        assert!(git(&root, &["commit", "-q", "-am", "gros"]));
        // Petit dans l'arbre de travail, gros dans le commit.
        std::fs::write(root.join("a.txt"), "a\n").unwrap();
        let g = GitDiff::default();
        let log = g.commits(&root, 5, true, None).unwrap();
        let c = g.commit_changes(&log.root, &log.commits[0]).unwrap();
        assert!(g.file_diff(&c, &c.files[0]).unwrap().too_large);
    }
}
