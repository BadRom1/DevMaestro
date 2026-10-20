//! Worktrees par la CLI `git` (v0.2, lot 6), avec les mêmes appels durcis
//! que le diff ([`GitExec`] : configuration imposée dont
//! `core.hooksPath=/dev/null`, donc aucun hook `post-checkout` ;
//! environnement ; délai).
//!
//! - Jamais de `git fetch` : « intégrée » se juge sur les références locales.
//! - `git merge-tree --write-tree` écrit des objets arbre dans la base
//!   d'objets du dépôt (jamais l'index ni les références) ; `git gc` les
//!   ramasse.
//! - Risque résiduel : l'extraction d'un nouveau worktree applique les
//!   filtres `filter.<pilote>.smudge` du dépôt (Git LFS…), comme un `git
//!   checkout` de l'utilisateur.

use std::io::Write;
use std::path::Path;

use super::git_exec::{GIT_WRITE_TIMEOUT, GitExec, failed};
use crate::domain::worktree::{
    IN_REPO_DIR, Integrated, MERGE_TREE_WRITE_TREE_MIN, MergeTree, RefSide, Reference,
    WorktreeEntry, clean_git_message, integration, looks_like_option, parse_git_version,
    parse_status_paths, parse_worktree_list, pick_reference,
};
use crate::ports::{DiffError, WorktreeGit, WorktreeStart};

/// [`WorktreeGit`] par la CLI `git`.
#[derive(Debug, Default)]
pub struct GitWorktrees {
    git: GitExec,
    /// `git merge-tree --write-tree` disponible (détecté une fois).
    merge_tree: std::sync::OnceLock<bool>,
}

impl GitWorktrees {
    #[cfg(test)]
    fn isolated() -> Self {
        Self {
            git: GitExec::without_global_config(),
            merge_tree: std::sync::OnceLock::new(),
        }
    }

    fn is_ancestor(&self, root: &Path, a: &str, b: &str) -> bool {
        self.git
            .succeeds(root, &["merge-base", "--is-ancestor", a, b])
    }

    /// Commande d'écriture : échec → message de `git` nettoyé.
    fn write(&self, root: &Path, args: &[&str]) -> Result<(), DiffError> {
        let out = self.git.run_with(root, args, GIT_WRITE_TIMEOUT)?;
        if out.ok {
            Ok(())
        } else {
            Err(DiffError::Failed(clean_git_message(&out.stderr)))
        }
    }
}

impl WorktreeGit for GitWorktrees {
    fn list(&self, root: &Path) -> Result<Vec<WorktreeEntry>, DiffError> {
        let out = self
            .git
            .run(root, &["worktree", "list", "--porcelain", "-z"])?;
        if !out.ok {
            return Err(DiffError::Failed(clean_git_message(&out.stderr)));
        }
        Ok(parse_worktree_list(&out.stdout))
    }

    fn reference(&self, root: &Path) -> Option<Reference> {
        let (full, _) = self.git.default_branch(root)?;
        let name = full
            .strip_prefix("refs/remotes/origin/")
            .or_else(|| full.strip_prefix("refs/heads/"))?
            .to_owned();
        let remote = format!("refs/remotes/origin/{name}");
        let local = format!("refs/heads/{name}");
        let has_remote = self.git.commit_of(root, &remote).is_some();
        let has_local = self.git.commit_of(root, &local).is_some();
        let both = has_remote && has_local;
        let side = pick_reference(
            has_remote,
            has_local,
            both && self.is_ancestor(root, &local, &remote),
            both && self.is_ancestor(root, &remote, &local),
        )?;
        Some(match side {
            RefSide::Remote => Reference {
                full: remote,
                short: format!("origin/{name}"),
                default_branch: name,
            },
            RefSide::Local => Reference {
                full: local,
                short: name.clone(),
                default_branch: name,
            },
        })
    }

    fn status_paths(&self, dir: &Path) -> Result<Vec<String>, DiffError> {
        // Indépendant de `status.showUntrackedFiles` et de
        // `status.ignoreSubmodules` de l'utilisateur ou du dépôt.
        let out = self.git.run(
            dir,
            &[
                "status",
                "--porcelain=v2",
                "-z",
                "--untracked-files=normal",
                "--ignore-submodules=none",
            ],
        )?;
        if !out.ok {
            return Err(DiffError::Failed(clean_git_message(&out.stderr)));
        }
        Ok(parse_status_paths(&out.stdout))
    }

    fn ahead(&self, root: &Path, reference: &str, branch: &str) -> Option<u64> {
        let range = format!("{reference}..refs/heads/{branch}");
        self.git
            .line(root, &["rev-list", "--count", &range])?
            .parse()
            .ok()
    }

    fn merge_tree_supported(&self) -> bool {
        *self.merge_tree.get_or_init(|| {
            self.git
                .line(Path::new("/"), &["version"])
                .and_then(|v| parse_git_version(&v))
                .is_some_and(|v| v >= MERGE_TREE_WRITE_TREE_MIN)
        })
    }

    fn integrated(&self, root: &Path, reference: &str, branch: &str) -> Option<Integrated> {
        let head = format!("refs/heads/{branch}");
        // `merge-tree` répond aussi 1 pour une référence inconnue : les deux
        // sont vérifiées avant.
        self.git.commit_of(root, reference)?;
        self.git.commit_of(root, &head)?;
        integration(
            self.is_ancestor(root, &head, reference),
            || match self.merge_tree_supported().then(|| {
                self.git
                    .run(root, &["merge-tree", "--write-tree", reference, &head])
            }) {
                None => MergeTree::Unsupported,
                Some(out) => match out {
                    Ok(out) if out.ok => String::from_utf8_lossy(&out.stdout)
                        .lines()
                        .next()
                        .map(|l| MergeTree::Clean(l.trim().to_owned()))
                        .unwrap_or(MergeTree::Failed),
                    Ok(out) if out.code == Some(1) => MergeTree::Conflict,
                    _ => MergeTree::Failed,
                },
            },
            || {
                self.git.line(
                    root,
                    &[
                        "rev-parse",
                        "--verify",
                        "-q",
                        &format!("{reference}^{{tree}}"),
                    ],
                )
            },
        )
    }

    fn check_branch_name(&self, root: &Path, name: &str) -> Result<(), String> {
        let refused = || format!("nom de branche invalide : « {name} »");
        if name.is_empty() || looks_like_option(name) {
            return Err(refused());
        }
        // `--branch` développe `@{-1}` : le nom doit ressortir tel quel.
        match self.git.line(root, &["check-ref-format", "--branch", name]) {
            Some(n) if n == name => Ok(()),
            _ => Err(refused()),
        }
    }

    fn branch_exists(&self, root: &Path, name: &str) -> bool {
        self.git
            .commit_of(root, &format!("refs/heads/{name}"))
            .is_some()
    }

    fn resolve_commit(&self, root: &Path, rev: &str) -> Option<String> {
        if rev.is_empty() || looks_like_option(rev) {
            return None;
        }
        self.git.commit_of(root, rev)
    }

    fn add(
        &self,
        root: &Path,
        path: &Path,
        branch: &str,
        start: WorktreeStart<'_>,
    ) -> Result<(), DiffError> {
        let path = path
            .to_str()
            .ok_or_else(|| failed("worktree add", "chemin non UTF-8"))?;
        match start {
            // `--no-track` : la nouvelle branche ne suit pas la base (un
            // `git push` de Claude ne viserait pas `origin/main`).
            WorktreeStart::NewBranch { base } => self.write(
                root,
                &["worktree", "add", "--no-track", "-b", branch, path, base],
            ),
            WorktreeStart::Existing => self.write(root, &["worktree", "add", path, branch]),
        }
    }

    fn remove(&self, root: &Path, path: &Path, force: bool, locked: bool) -> Result<(), DiffError> {
        let path = path
            .to_str()
            .ok_or_else(|| failed("worktree remove", "chemin non UTF-8"))?;
        let mut args = vec!["worktree", "remove"];
        if force {
            args.push("--force");
            if locked {
                args.push("--force");
            }
        }
        args.push(path);
        self.write(root, &args)
    }

    fn delete_branch(&self, root: &Path, branch: &str, force: bool) -> Result<(), DiffError> {
        if looks_like_option(branch) {
            return Err(failed("branch", "nom de branche invalide"));
        }
        self.write(root, &["branch", if force { "-D" } else { "-d" }, branch])
    }

    fn exclude_in_repo_dir(&self, root: &Path, common_dir: &Path) -> Result<bool, DiffError> {
        let dir = format!("{IN_REPO_DIR}/");
        let out = self
            .git
            .run_without_literal_pathspecs(root, &["check-ignore", "-q", &dir])?;
        match out.code {
            Some(0) => return Ok(false),
            Some(1) => {}
            _ => return Err(DiffError::Failed(clean_git_message(&out.stderr))),
        }
        let info = common_dir.join("info");
        std::fs::create_dir_all(&info).map_err(|e| failed("info/exclude", e))?;
        let file = info.join("exclude");
        let ends_with_newline = std::fs::read(&file)
            .map(|c| c.is_empty() || c.ends_with(b"\n"))
            .unwrap_or(true);
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&file)
            .map_err(|e| failed("info/exclude", e))?;
        let line = if ends_with_newline {
            format!("{dir}\n")
        } else {
            format!("\n{dir}\n")
        };
        f.write_all(line.as_bytes())
            .map_err(|e| failed("info/exclude", e))?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::{Command, Stdio};

    fn git(dir: &Path, args: &[&str]) -> bool {
        Command::new("git")
            .arg("-C")
            .arg(dir)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
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

    fn commit(dir: &Path, file: &str, content: &str, msg: &str) {
        std::fs::write(dir.join(file), content).unwrap();
        assert!(git(dir, &["add", "."]));
        assert!(git(dir, &["commit", "-q", "-m", msg]));
    }

    /// Dépôt `main` avec un commit ; `None` sans git.
    fn repo() -> Option<(tempfile::TempDir, PathBuf)> {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap().join("proj");
        std::fs::create_dir(&root).unwrap();
        if !git(&root, &["init", "-q", "-b", "main"]) {
            eprintln!("git absent : test sauté");
            return None;
        }
        commit(&root, "a.txt", "a\n", "base");
        Some((dir, root))
    }

    #[test]
    fn add_list_status_remove() {
        let Some((_d, root)) = repo() else { return };
        let g = GitWorktrees::isolated();
        let r = g.reference(&root).unwrap();
        assert_eq!(
            (r.full.as_str(), r.short.as_str()),
            ("refs/heads/main", "main")
        );
        assert_eq!(r.default_branch, "main");
        assert!(g.check_branch_name(&root, "feat/x").is_ok());
        for bad in ["", "-D", "a..b", "@{-1}", "fin.lock", "a b"] {
            assert!(g.check_branch_name(&root, bad).is_err(), "{bad}");
        }
        let base = g.resolve_commit(&root, &r.full).unwrap();
        assert!(g.resolve_commit(&root, "--all").is_none());
        assert!(g.resolve_commit(&root, "inconnue").is_none());

        let wt = root.parent().unwrap().join("proj-feat-x");
        g.add(
            &root,
            &wt,
            "feat/x",
            WorktreeStart::NewBranch { base: &base },
        )
        .unwrap();
        assert!(g.branch_exists(&root, "feat/x"));
        // Pas de suivi de la base.
        assert!(!git(&root, &["config", "branch.feat/x.merge"]));
        let list = g.list(&root).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].path, root);
        assert_eq!(list[1].path, wt);
        assert_eq!(list[1].branch.as_deref(), Some("feat/x"));
        // Branche déjà extraite : git refuse.
        let other = root.parent().unwrap().join("autre");
        assert!(
            g.add(&root, &other, "feat/x", WorktreeStart::Existing)
                .is_err()
        );

        assert!(g.status_paths(&wt).unwrap().is_empty());
        // Réglages du dépôt qui masqueraient des fichiers : sans effet.
        assert!(git(&root, &["config", "status.showUntrackedFiles", "no"]));
        assert!(git(&root, &["config", "status.ignoreSubmodules", "all"]));
        std::fs::write(wt.join("neuf.txt"), "n\n").unwrap();
        std::fs::write(wt.join("a.txt"), "b\n").unwrap();
        assert_eq!(g.status_paths(&wt).unwrap(), ["a.txt", "neuf.txt"]);
        // Sans force : refusé (modifications) avec le message de git.
        let Err(DiffError::Failed(msg)) = g.remove(&root, &wt, false, false) else {
            panic!("suppression d'un worktree modifié acceptée");
        };
        assert!(msg.contains("modified or untracked"), "{msg}");
        g.remove(&root, &wt, true, false).unwrap();
        assert!(!wt.exists());
        assert!(g.delete_branch(&root, "feat/x", false).is_ok());
        assert!(!g.branch_exists(&root, "feat/x"));

        // Branche existante, extraite nulle part ; worktree verrouillé.
        assert!(git(&root, &["branch", "existante"]));
        g.add(&root, &wt, "existante", WorktreeStart::Existing)
            .unwrap();
        assert!(git(&root, &["worktree", "lock", wt.to_str().unwrap()]));
        assert!(g.list(&root).unwrap()[1].locked);
        assert!(g.remove(&root, &wt, true, false).is_err());
        g.remove(&root, &wt, true, true).unwrap();
        // Dossier disparu : `git worktree remove` le retire de la liste.
        g.add(&root, &wt, "existante", WorktreeStart::Existing)
            .unwrap();
        std::fs::remove_dir_all(&wt).unwrap();
        assert!(g.list(&root).unwrap()[1].prunable);
        g.remove(&root, &wt, false, false).unwrap();
        assert_eq!(g.list(&root).unwrap().len(), 1);
    }

    #[test]
    fn integration_states() {
        let Some((_d, root)) = repo() else { return };
        let g = GitWorktrees::isolated();
        let main = "refs/heads/main";
        // Fusionnée (fast-forward).
        assert!(git(&root, &["checkout", "-q", "-b", "ff"]));
        commit(&root, "ff.txt", "ff\n", "ff");
        assert!(git(&root, &["checkout", "-q", "main"]));
        assert_eq!(g.integrated(&root, main, "ff"), Some(Integrated::No));
        assert_eq!(g.ahead(&root, main, "ff"), Some(1));
        assert!(git(&root, &["merge", "-q", "--ff-only", "ff"]));
        assert_eq!(g.integrated(&root, main, "ff"), Some(Integrated::Merged));
        assert_eq!(g.ahead(&root, main, "ff"), Some(0));
        // Squash.
        assert!(git(&root, &["checkout", "-q", "-b", "sq"]));
        commit(&root, "sq.txt", "sq\n", "sq 1");
        commit(&root, "sq.txt", "sq\nsq\n", "sq 2");
        assert!(git(&root, &["checkout", "-q", "main"]));
        assert!(git(&root, &["merge", "-q", "--squash", "sq"]));
        assert!(git(&root, &["commit", "-q", "-m", "squash"]));
        assert_eq!(g.integrated(&root, main, "sq"), Some(Integrated::Squashed));
        assert_eq!(g.ahead(&root, main, "sq"), Some(2));
        // Conflit : pas intégrée.
        assert!(git(&root, &["checkout", "-q", "-b", "conflit"]));
        commit(&root, "a.txt", "conflit\n", "c");
        assert!(git(&root, &["checkout", "-q", "main"]));
        commit(&root, "a.txt", "main\n", "m");
        assert_eq!(g.integrated(&root, main, "conflit"), Some(Integrated::No));
        // Branche à fusionner proprement mais pas intégrée.
        assert!(git(&root, &["checkout", "-q", "-b", "propre"]));
        commit(&root, "p.txt", "p\n", "p");
        assert!(git(&root, &["checkout", "-q", "main"]));
        assert_eq!(g.integrated(&root, main, "propre"), Some(Integrated::No));
        // Branche ou référence inconnue : inconnu.
        assert_eq!(g.integrated(&root, main, "absente"), None);
        assert_eq!(g.integrated(&root, "refs/heads/absente", "propre"), None);
    }

    #[test]
    fn reference_prefers_the_branch_that_descends() {
        let Some((d, root)) = repo() else { return };
        let g = GitWorktrees::isolated();
        // Clone : origin/HEAD → origin/main.
        let clone = d.path().canonicalize().unwrap().join("clone");
        assert!(git(
            d.path(),
            &[
                "clone",
                "-q",
                root.to_str().unwrap(),
                clone.to_str().unwrap()
            ]
        ));
        let r = g.reference(&clone).unwrap();
        assert_eq!(r.short, "origin/main");
        assert_eq!(r.default_branch, "main");
        // Merge local pas encore poussé : la locale est en avance.
        commit(&clone, "local.txt", "l\n", "local");
        assert_eq!(g.reference(&clone).unwrap().short, "main");
        // Distante en avance (PR mergée puis récupérée), locale en retard.
        assert!(git(&clone, &["reset", "-q", "--hard", "origin/main"]));
        commit(&root, "pr.txt", "pr\n", "pr");
        assert!(git(&clone, &["fetch", "-q"]));
        let r = g.reference(&clone).unwrap();
        assert_eq!(
            (r.short.as_str(), r.full.as_str()),
            ("origin/main", "refs/remotes/origin/main")
        );
        // Divergentes : la distante.
        commit(&clone, "div.txt", "d\n", "div");
        assert_eq!(g.reference(&clone).unwrap().short, "origin/main");
        // Sans branche par défaut : rien.
        let empty = d.path().canonicalize().unwrap().join("vide");
        std::fs::create_dir(&empty).unwrap();
        assert!(git(&empty, &["init", "-q", "-b", "autre"]));
        commit(&empty, "x", "x\n", "x");
        assert_eq!(g.reference(&empty), None);
    }

    #[test]
    fn in_repo_dir_is_excluded_once() {
        let Some((_d, root)) = repo() else { return };
        let g = GitWorktrees::isolated();
        let common = root.join(".git");
        std::fs::write(common.join("info/exclude"), "*.tmp").unwrap();
        assert!(g.exclude_in_repo_dir(&root, &common).unwrap());
        assert!(!g.exclude_in_repo_dir(&root, &common).unwrap());
        assert_eq!(
            std::fs::read_to_string(common.join("info/exclude")).unwrap(),
            "*.tmp\n.worktrees/\n"
        );
        // Déjà ignoré par le `.gitignore` suivi : rien n'est écrit.
        let Some((_d2, other)) = repo() else { return };
        std::fs::write(other.join(".gitignore"), ".worktrees\n").unwrap();
        std::fs::remove_dir_all(other.join(".git/info")).unwrap();
        assert!(!g.exclude_in_repo_dir(&other, &other.join(".git")).unwrap());
        assert!(!other.join(".git/info/exclude").exists());
        // Le principal reste propre avec un worktree dans `.worktrees/`.
        assert!(g.exclude_in_repo_dir(&root, &common).is_ok());
        let wt = root.join(".worktrees/x");
        let base = g.resolve_commit(&root, "HEAD").unwrap();
        g.add(&root, &wt, "x", WorktreeStart::NewBranch { base: &base })
            .unwrap();
        assert!(g.status_paths(&root).unwrap().is_empty());
    }

    #[test]
    fn hooks_never_run() {
        let Some((_d, root)) = repo() else { return };
        let marker = root.join("piege");
        let hooks = root.join(".git/hooks");
        std::fs::create_dir_all(&hooks).unwrap();
        let script = hooks.join("post-checkout");
        std::fs::write(
            &script,
            format!("#!/bin/sh\ntouch '{}'\n", marker.display()),
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let g = GitWorktrees::isolated();
        let base = g.resolve_commit(&root, "HEAD").unwrap();
        let wt = root.parent().unwrap().join("wt");
        g.add(&root, &wt, "h", WorktreeStart::NewBranch { base: &base })
            .unwrap();
        assert!(wt.join("a.txt").exists());
        assert!(!marker.exists(), "le hook post-checkout a tourné");
    }
}
