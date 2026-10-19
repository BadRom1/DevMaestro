//! Ligne de commande et environnement du processus `claude` (architecture § 7).
//!
//! ```text
//! [CLAUDE_CONFIG_DIR=<profil>] ORCH_SOCKET=… ORCH_TOKEN=… ORCH_SESSION=…
//! claude (--session-id <uuid> | --resume <id>) --permission-mode <mode>
//!        [--model <modèle>] --plugin-dir <plugin> --settings <réglages> ["<prompt>"]
//! ```
//!
//! - Le mode `Default` s'écrit `manual` (claude 2.1.303 refuse `default`,
//!   prototype n° 1).
//! - `CLAUDE_CONFIG_DIR` n'est passé que pour les profils autres que le
//!   profil par défaut, et il est **retiré** de l'environnement hérité pour
//!   le profil par défaut (sinon Claude Code chercherait `~/.claude/.claude.json`).
//! - `--plugin-dir` et `--settings` sont repassés à chaque reprise : Claude
//!   Code ne les restaure pas.
//! - Le prompt initial vient en dernier, après `--` : `claude` analyse ses
//!   arguments à la manière de commander.js (`claude --help` : « Usage: claude
//!   [options] [command] [prompt] »), où `--` termine les options. Un prompt
//!   comme `--dangerously-skip-permissions` ou `- liste` reste donc un prompt.
//!   **À vérifier avec le vrai CLI** : que `--` est bien accepté, et qu'un
//!   prompt égal au nom d'une sous-commande (`mcp`, `update`…) n'est pas
//!   lancé comme telle.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use crate::domain::{PermissionMode, Profile};
pub use crate::ports::CommandLine;
use crate::protocol::{ENV_SESSION, ENV_SOCKET, ENV_TOKEN};

/// Variables héritées du démon retirées de l'environnement de `claude` :
/// celles que Claude Code pose pour ses propres sous-processus (un démon
/// lancé depuis une session Claude Code ne doit pas les transmettre). Nos
/// variables `ORCH_*` sont, elles, toujours reposées et remplacent l'héritage.
const INHERITED_ENV_REMOVED: &[&str] = &["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"];

/// Nouvelle session ou reprise.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LaunchKind {
    /// `--session-id <uuid>`.
    New { claude_session_id: String },
    /// `--resume <id>`.
    Resume { claude_session_id: String },
}

/// Ce qu'il faut pour construire la commande.
#[derive(Debug, Clone)]
pub struct LaunchSpec<'a> {
    pub claude_bin: &'a Path,
    pub kind: LaunchKind,
    pub profile: &'a Profile,
    pub cwd: &'a Path,
    pub mode: Option<&'a PermissionMode>,
    pub model: Option<&'a str>,
    pub prompt: Option<&'a str>,
    pub plugin_dir: &'a Path,
    pub settings: &'a Path,
    pub socket: &'a Path,
    pub token: &'a str,
    /// Identifiant interne de la session (`ORCH_SESSION`).
    pub session: &'a str,
}

/// Valeur de `--permission-mode` pour un mode.
pub fn cli_mode(mode: &PermissionMode) -> &str {
    match mode {
        PermissionMode::Default => "manual",
        other => other.as_str(),
    }
}

/// Construit la commande.
pub fn build(spec: &LaunchSpec<'_>) -> CommandLine {
    let mut args: Vec<OsString> = Vec::new();
    match &spec.kind {
        LaunchKind::New { claude_session_id } => {
            args.push("--session-id".into());
            args.push(claude_session_id.into());
        }
        LaunchKind::Resume { claude_session_id } => {
            args.push("--resume".into());
            args.push(claude_session_id.into());
        }
    }
    if let Some(mode) = spec.mode {
        args.push("--permission-mode".into());
        args.push(cli_mode(mode).into());
    }
    if let Some(model) = spec.model.filter(|m| !m.is_empty()) {
        args.push("--model".into());
        args.push(model.into());
    }
    args.push("--plugin-dir".into());
    args.push(spec.plugin_dir.into());
    args.push("--settings".into());
    args.push(spec.settings.into());
    if let Some(prompt) = spec.prompt.filter(|p| !p.is_empty()) {
        // `--` : un prompt qui commence par « - » n'est pas lu comme une option.
        args.push("--".into());
        args.push(prompt.into());
    }

    let mut env: Vec<(String, OsString)> = vec![
        (ENV_SOCKET.into(), spec.socket.into()),
        (ENV_TOKEN.into(), spec.token.into()),
        (ENV_SESSION.into(), spec.session.into()),
        ("TERM".into(), "xterm-256color".into()),
        ("COLORTERM".into(), "truecolor".into()),
    ];
    let mut env_remove: Vec<String> = INHERITED_ENV_REMOVED
        .iter()
        .map(|s| (*s).to_owned())
        .collect();
    match spec.profile.config_dir_env() {
        Some(dir) => env.push(("CLAUDE_CONFIG_DIR".into(), dir.into())),
        None => env_remove.push("CLAUDE_CONFIG_DIR".into()),
    }
    CommandLine {
        program: spec.claude_bin.to_path_buf(),
        args,
        cwd: spec.cwd.to_path_buf(),
        env,
        env_remove,
    }
}

/// Chemin du binaire `claude` : `DEVMAESTRO_CLAUDE_BIN`, sinon le premier
/// `claude` exécutable du `PATH`.
pub fn find_claude(env_bin: Option<OsString>, path: Option<OsString>) -> Option<PathBuf> {
    if let Some(bin) = env_bin.filter(|b| !b.is_empty()) {
        return Some(PathBuf::from(bin));
    }
    std::env::split_paths(&path?)
        .map(|dir| dir.join("claude"))
        .find(|p| is_executable(p))
}

fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec<'a>(profile: &'a Profile, kind: LaunchKind) -> LaunchSpec<'a> {
        LaunchSpec {
            claude_bin: Path::new("/usr/bin/claude"),
            kind,
            profile,
            cwd: Path::new("/home/u/p"),
            mode: None,
            model: None,
            prompt: None,
            plugin_dir: Path::new("/d/claude-plugin"),
            settings: Path::new("/d/settings/default.json"),
            socket: Path::new("/run/orchd.sock"),
            token: "jeton",
            session: "interne",
        }
    }

    fn args(c: &CommandLine) -> Vec<String> {
        c.args
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }

    fn env<'a>(c: &'a CommandLine, k: &str) -> Option<&'a OsString> {
        c.env.iter().find(|(key, _)| key == k).map(|(_, v)| v)
    }

    #[test]
    fn new_session_default_profile() {
        let p = Profile::default_for("/home/u/.claude");
        let mode = PermissionMode::Default;
        let mut s = spec(
            &p,
            LaunchKind::New {
                claude_session_id: "uuid-1".into(),
            },
        );
        s.mode = Some(&mode);
        s.model = Some("opus");
        s.prompt = Some("Dis bonjour --model x");
        let c = build(&s);
        assert_eq!(
            args(&c),
            [
                "--session-id",
                "uuid-1",
                "--permission-mode",
                "manual",
                "--model",
                "opus",
                "--plugin-dir",
                "/d/claude-plugin",
                "--settings",
                "/d/settings/default.json",
                "--",
                "Dis bonjour --model x",
            ]
        );
        assert_eq!(c.cwd, Path::new("/home/u/p"));
        // Profil par défaut : pas de CLAUDE_CONFIG_DIR, et celui hérité est retiré.
        assert!(env(&c, "CLAUDE_CONFIG_DIR").is_none());
        assert!(c.env_remove.iter().any(|k| k == "CLAUDE_CONFIG_DIR"));
        assert_eq!(env(&c, "ORCH_TOKEN").unwrap(), "jeton");
        assert_eq!(env(&c, "ORCH_SOCKET").unwrap(), "/run/orchd.sock");
        assert_eq!(env(&c, "ORCH_SESSION").unwrap(), "interne");
        assert_eq!(env(&c, "TERM").unwrap(), "xterm-256color");
        assert_eq!(env(&c, "COLORTERM").unwrap(), "truecolor");
        assert!(c.env_remove.iter().any(|k| k == "CLAUDECODE"));
    }

    #[test]
    fn resume_named_profile() {
        let p = Profile::named("work", "/home/u/.claude-work");
        let mode = PermissionMode::AcceptEdits;
        let mut s = spec(
            &p,
            LaunchKind::Resume {
                claude_session_id: "ancien".into(),
            },
        );
        s.mode = Some(&mode);
        s.prompt = Some("");
        let c = build(&s);
        assert_eq!(
            args(&c),
            [
                "--resume",
                "ancien",
                "--permission-mode",
                "acceptEdits",
                "--plugin-dir",
                "/d/claude-plugin",
                "--settings",
                "/d/settings/default.json",
            ]
        );
        assert_eq!(
            env(&c, "CLAUDE_CONFIG_DIR").unwrap(),
            "/home/u/.claude-work"
        );
        assert!(!c.env_remove.iter().any(|k| k == "CLAUDE_CONFIG_DIR"));
    }

    #[test]
    fn prompt_starting_with_a_dash_stays_a_prompt() {
        let p = Profile::default_for("/home/u/.claude");
        for prompt in ["--dangerously-skip-permissions", "- liste"] {
            let mut s = spec(
                &p,
                LaunchKind::New {
                    claude_session_id: "u".into(),
                },
            );
            s.prompt = Some(prompt);
            let a = args(&build(&s));
            assert_eq!(&a[a.len() - 2..], ["--", prompt]);
        }
    }

    #[test]
    fn mode_mapping() {
        assert_eq!(cli_mode(&PermissionMode::Default), "manual");
        assert_eq!(cli_mode(&PermissionMode::parse("manual")), "manual");
        assert_eq!(cli_mode(&PermissionMode::Plan), "plan");
        assert_eq!(cli_mode(&PermissionMode::Auto), "auto");
        assert_eq!(cli_mode(&PermissionMode::parse("dontAsk")), "dontAsk");
    }

    #[test]
    fn finds_claude_binary() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            find_claude(Some("/x/claude".into()), None),
            Some(PathBuf::from("/x/claude"))
        );
        assert_eq!(find_claude(None, Some(dir.path().into())), None);
        let bin = dir.path().join("claude");
        std::fs::write(&bin, "#!/bin/sh\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let path = std::env::join_paths([Path::new("/nulle/part"), dir.path()]).unwrap();
        assert_eq!(find_claude(Some("".into()), Some(path)), Some(bin));
    }
}
