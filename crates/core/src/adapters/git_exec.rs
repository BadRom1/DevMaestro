//! Appel durci de la CLI `git`, partagé par le diff (lot 1) et les worktrees
//! (lot 6) : configuration imposée, environnement, délai, sorties bornées.
//! Arguments séparés, jamais de shell.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::ports::DiffError;

/// Délai maximal d'une commande `git` de lecture.
pub const GIT_TIMEOUT: Duration = Duration::from_secs(10);
/// Délai maximal d'une commande `git` qui écrit un arbre de travail
/// (`worktree add`, `worktree remove`) : l'extraction d'un gros dépôt est
/// plus longue qu'une lecture.
pub const GIT_WRITE_TIMEOUT: Duration = Duration::from_secs(120);
/// Sortie maximale lue d'une commande `git` (au-delà : liste tronquée).
pub const MAX_OUTPUT: usize = 32 * 1024 * 1024;
/// Sortie d'erreur gardée au plus (message rendu au client).
const MAX_STDERR: u64 = 64 * 1024;

/// Configuration imposée à chaque appel de `git`.
pub const HARDENING: &[&str] = &[
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "diff.relative=false",
    "-c",
    "diff.submodule=short",
    "-c",
    "core.quotePath=false",
    "-c",
    "diff.external=",
    "-c",
    "core.pager=cat",
];

/// Résultat d'une commande `git`.
pub struct Out {
    pub ok: bool,
    /// Code de sortie (`None` : tué par un signal).
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    /// Début de la sortie d'erreur (au plus 64 Kio).
    pub stderr: Vec<u8>,
    /// Sortie coupée à [`MAX_OUTPUT`].
    pub truncated: bool,
}

pub fn failed(what: &str, detail: impl std::fmt::Display) -> DiffError {
    DiffError::Failed(format!("git {what} : {detail}"))
}

/// Lanceur de `git` durci.
#[derive(Debug, Clone)]
pub struct GitExec {
    program: PathBuf,
    /// Variables posées en plus (tests : configuration globale isolée).
    extra_env: Vec<(&'static str, PathBuf)>,
}

impl Default for GitExec {
    fn default() -> Self {
        Self {
            program: PathBuf::from("git"),
            extra_env: Vec::new(),
        }
    }
}

impl GitExec {
    /// Lanceur qui ignore la configuration globale de l'utilisateur
    /// (`GIT_CONFIG_GLOBAL=/dev/null`) : pour les tests.
    #[cfg(test)]
    pub fn without_global_config() -> Self {
        Self {
            program: PathBuf::from("git"),
            extra_env: vec![("GIT_CONFIG_GLOBAL", PathBuf::from("/dev/null"))],
        }
    }

    /// Lance `git -C <dir> <durcissement> <args>` avec le délai de lecture.
    pub fn run(&self, dir: &Path, args: &[&str]) -> Result<Out, DiffError> {
        self.run_with(dir, args, GIT_TIMEOUT)
    }

    /// Lance `git -C <dir> --literal-pathspecs --no-pager <durcissement>
    /// <args>`, tué au bout de `timeout`. Environnement : pas de
    /// configuration système, aucun verrou facultatif (l'index n'est jamais
    /// écrit par une lecture), jamais d'invite, messages en anglais.
    pub fn run_with(&self, dir: &Path, args: &[&str], timeout: Duration) -> Result<Out, DiffError> {
        self.spawn(dir, args, timeout, true)
    }

    /// Comme [`GitExec::run_with`], mais un délai dépassé rend `Ok(None)`
    /// (l'appelant peut se rabattre sur une commande moins coûteuse).
    pub fn run_or_timeout(
        &self,
        dir: &Path,
        args: &[&str],
        timeout: Duration,
    ) -> Result<Option<Out>, DiffError> {
        self.spawn_inner(dir, args, timeout, true)
    }

    /// Comme [`GitExec::run`], sans `--literal-pathspecs` : pour les commandes
    /// qui le refusent (`check-ignore`), avec des chemins fixés par le démon.
    pub fn run_without_literal_pathspecs(
        &self,
        dir: &Path,
        args: &[&str],
    ) -> Result<Out, DiffError> {
        self.spawn(dir, args, GIT_TIMEOUT, false)
    }

    fn spawn(
        &self,
        dir: &Path,
        args: &[&str],
        timeout: Duration,
        literal: bool,
    ) -> Result<Out, DiffError> {
        let what = args.first().copied().unwrap_or("");
        self.spawn_inner(dir, args, timeout, literal)?
            .ok_or_else(|| failed(what, "délai dépassé"))
    }

    /// Lance la commande ; `Ok(None)` si elle a été tuée au bout de `timeout`.
    fn spawn_inner(
        &self,
        dir: &Path,
        args: &[&str],
        timeout: Duration,
        literal: bool,
    ) -> Result<Option<Out>, DiffError> {
        let what = args.first().copied().unwrap_or("");
        let mut command = Command::new(&self.program);
        command.arg("-C").arg(dir);
        if literal {
            command.arg("--literal-pathspecs");
        }
        let mut child = command
            .arg("--no-pager")
            .args(HARDENING)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("LC_ALL", "C")
            .envs(self.extra_env.iter().map(|(k, v)| (k, v)))
            .spawn()
            .map_err(|e| failed(what, e))?;
        let mut stdout = child.stdout.take().expect("piped");
        let mut stderr = child.stderr.take().expect("piped");
        let reader = std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = (&mut stdout).take(MAX_OUTPUT as u64).read_to_end(&mut buf);
            let _ = std::io::copy(&mut stdout, &mut std::io::sink());
            buf
        });
        let err_reader = std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = (&mut stderr).take(MAX_STDERR).read_to_end(&mut buf);
            let _ = std::io::copy(&mut stderr, &mut std::io::sink());
            buf
        });
        let deadline = Instant::now() + timeout;
        let status = loop {
            // Délai d'abord : un délai nul tue toujours le processus, même
            // s'il a fini avant le premier coup d'œil (machine chargée).
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                return Ok(None);
            }
            match child.try_wait() {
                Ok(Some(s)) => break s,
                Ok(None) => std::thread::sleep(Duration::from_millis(5)),
                Err(e) => return Err(failed(what, e)),
            }
        };
        let stdout = reader.join().unwrap_or_default();
        let stderr = err_reader.join().unwrap_or_default();
        Ok(Some(Out {
            ok: status.success(),
            code: status.code(),
            truncated: stdout.len() >= MAX_OUTPUT,
            stdout,
            stderr,
        }))
    }

    /// Première ligne de la sortie d'une commande réussie, si elle n'est pas vide.
    pub fn line(&self, dir: &Path, args: &[&str]) -> Option<String> {
        let out = self.run(dir, args).ok()?;
        let s = String::from_utf8(out.stdout).ok()?;
        let s = s.trim_end_matches(['\n', '\r']);
        (out.ok && !s.is_empty()).then(|| s.to_owned())
    }

    /// La commande réussit-elle (code 0) ?
    pub fn succeeds(&self, dir: &Path, args: &[&str]) -> bool {
        self.run(dir, args).is_ok_and(|o| o.ok)
    }

    /// Branche par défaut, en référence complète et en nom court :
    /// `origin/HEAD`, sinon `main`, sinon `master`.
    pub fn default_branch(&self, top: &Path) -> Option<(String, String)> {
        if let Some(r) = self.line(top, &["symbolic-ref", "-q", "refs/remotes/origin/HEAD"])
            && let Some(short) = r.strip_prefix("refs/remotes/")
        {
            return Some((r.clone(), short.to_owned()));
        }
        ["main", "master"].into_iter().find_map(|b| {
            let full = format!("refs/heads/{b}");
            self.commit_of(top, &full).map(|_| (full, b.to_owned()))
        })
    }

    /// Commit désigné par une référence ou une révision (`None` s'il n'existe pas).
    pub fn commit_of(&self, dir: &Path, rev: &str) -> Option<String> {
        self.line(
            dir,
            &[
                "rev-parse",
                "--verify",
                "-q",
                "--end-of-options",
                &format!("{rev}^{{commit}}"),
            ],
        )
    }
}
