//! Git par la CLI `git` (architecture § 10).

use std::path::{Path, PathBuf};

use super::git_exec::GitExec;
use crate::ports::{RepoInfo, Vcs};

/// [`Vcs`] qui appelle `git -C <dossier> rev-parse …`, par le lanceur durci
/// du diff (configuration imposée, environnement, délai de 10 s).
#[derive(Debug, Clone, Default)]
pub struct GitCli {
    git: GitExec,
}

impl GitCli {
    fn rev_parse(&self, dir: &Path, args: &[&str]) -> Option<String> {
        let mut all = vec!["rev-parse"];
        all.extend_from_slice(args);
        self.git.line(dir, &all)
    }
}

impl Vcs for GitCli {
    fn resolve(&self, path: &Path) -> Option<RepoInfo> {
        let worktree_root = PathBuf::from(self.rev_parse(path, &["--show-toplevel"])?);
        let common_dir =
            PathBuf::from(self.rev_parse(path, &["--path-format=absolute", "--git-common-dir"])?);
        let branch = self
            .rev_parse(path, &["--abbrev-ref", "HEAD"])
            .filter(|b| b != "HEAD");
        let project_root = project_root(&common_dir, &worktree_root);
        Some(RepoInfo {
            worktree_root,
            common_dir,
            project_root,
            branch,
        })
    }
}

/// Worktree principal : parent du dossier commun quand il s'appelle `.git`
/// (dépôt ordinaire), sinon la racine du worktree (dépôt nu, cas rares).
fn project_root(common_dir: &Path, worktree_root: &Path) -> PathBuf {
    match (common_dir.file_name(), common_dir.parent()) {
        (Some(name), Some(parent)) if name == ".git" => parent.to_path_buf(),
        _ => worktree_root.to_path_buf(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};

    fn git(dir: &Path, args: &[&str]) -> bool {
        Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    }

    #[test]
    fn project_root_of_worktrees() {
        assert_eq!(
            project_root(Path::new("/p/.git"), Path::new("/p-wt")),
            Path::new("/p")
        );
        assert_eq!(
            project_root(Path::new("/srv/p.git"), Path::new("/srv/wt")),
            Path::new("/srv/wt")
        );
    }

    #[test]
    fn resolves_repository_and_degrades_outside() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        // Hors dépôt (ou sans git) : None, jamais d'erreur.
        assert_eq!(GitCli::default().resolve(&root), None);
        if !git(&root, &["init", "-q", "-b", "principale"]) {
            eprintln!("git absent : test partiel");
            return;
        }
        std::fs::create_dir(root.join("sous")).unwrap();
        let info = GitCli::default().resolve(&root.join("sous")).unwrap();
        assert_eq!(info.worktree_root, root);
        assert_eq!(info.project_root, root);
        assert_eq!(info.common_dir, root.join(".git"));
        // Pas encore de commit : la branche n'est pas lisible par rev-parse.
        assert!(info.branch.is_none() || info.branch.as_deref() == Some("principale"));
        let ok = git(
            &root,
            &[
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "x",
            ],
        );
        if ok {
            let info = GitCli::default().resolve(&root).unwrap();
            assert_eq!(info.branch.as_deref(), Some("principale"));
        }
    }
}
