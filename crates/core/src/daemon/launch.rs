//! Ligne de commande et environnement du processus `claude` (architecture § 7).
//!
//! ```text
//! [CLAUDE_CONFIG_DIR=<profil>] ORCH_SOCKET=<relay.sock> ORCH_TOKEN=… ORCH_SESSION=…
//! claude (--session-id <uuid> | --resume <id>) --permission-mode <mode>
//!        [--model <modèle>] --plugin-dir <plugin> --settings <réglages> ["<prompt>"]
//! ```
//!
//! - Le mode `Default` s'écrit `manual` (claude 2.1.303 refuse `default`,
//!   prototype n° 1).
//! - `CLAUDE_CONFIG_DIR` n'est passé que pour les profils autres que le
//!   profil par défaut, et il est **retiré** de l'environnement hérité pour
//!   le profil par défaut (sinon Claude Code chercherait `~/.claude/.claude.json`).
//! - `ORCH_SOCKET` est le socket des **relais** : le chemin du socket de
//!   contrôle n'est jamais passé à `claude`. Les variables `ORCH_*` et
//!   `DEVMAESTRO_*` héritées du démon sont retirées.
//! - Si un gestionnaire systemd utilisateur répond, `claude` est lancé dans
//!   un scope transitoire : `systemd-run --user --scope --quiet --collect
//!   --unit=devmaestro-session-<id>.scope -- claude …` ; le socket de
//!   contrôle refuse tout processus de ce cgroup (voir [`super::peer`]).
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

/// Marqueurs de session Claude Code (noms exacts) retirés de l'environnement
/// hérité par `claude`, et de celui du démon lui-même au démarrage.
///
/// Un démon lancé depuis un processus d'une session Claude Code (terminal
/// d'une session, app de développement lancée par l'outil Bash…) hérite des
/// variables que Claude Code pose pour **ses** sous-processus. Transmises à
/// nos `claude`, elles les font passer pour des sessions enfants : avec
/// `CLAUDE_CODE_CHILD_SESSION`, la TUI n'enregistre plus de transcript
/// (« Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION
/// marker »), exclut la session de `--resume`, etc. Sources : la page
/// « Environment variables » de la documentation de Claude Code (variables
/// « set automatically / set by Claude Code » dans ses sous-processus) et
/// l'environnement relevé dans un shell d'une session Claude Code 2.1.304 :
///
/// - `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION` : « je tourne sous Claude Code » ;
/// - `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_EXECPATH` : point d'entrée et
///   binaire de la session parente ;
/// - `CLAUDE_CODE_SSE_PORT` : port de l'extension IDE de la session parente ;
/// - `CLAUDE_CODE_HOST_SESSION_ID`, `CLAUDE_CODE_BRIDGE_SESSION_ID`,
///   `CLAUDE_CODE_REMOTE`, `CLAUDE_CODE_REMOTE_SESSION_ID` : identifiants et
///   contexte (Remote Control, session cloud) de la session parente ;
/// - `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN` : boîte de
///   réception (et son jeton) de la session parente, « jamais héritée » selon
///   la documentation ;
/// - `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` : posée par une plateforme qui
///   embarque Claude Code pour **son** processus ;
/// - `CLAUDE_PID`, `CLAUDE_EFFORT`, `CLAUDE_JOB_DIR` : pid, effort et dossier
///   de tâche de la session parente ;
/// - `TRACEPARENT` : contexte de trace propagé par la session parente ;
/// - `AI_AGENT` : posée par Claude Code pour son outil Bash (« lancé par un
///   agent »), fausse pour une session pilotée par l'utilisateur ;
/// - `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` : réglages
///   documentés, mais héritées de l'hôte elles connecteraient **toutes** les
///   sessions au compte de l'hôte, quel que soit le profil choisi
///   (`CLAUDE_CONFIG_DIR`) : les profils sont la seule source de compte ;
/// - `CLAUDE_CODE_SIMPLE` : réglage documenté (mode dépouillé), qui risque de
///   désactiver les hooks et le plugin dont dépend le suivi des sessions ;
/// - variables posées par l'app de bureau Claude (Claude Desktop) pour **sa**
///   session, relevées en vrai quand l'app DevMaestro est lancée depuis une
///   session Claude Desktop : compte et organisation de l'hôte
///   (`CLAUDE_CODE_ACCOUNT_UUID`, `CLAUDE_CODE_ORGANIZATION_UUID`,
///   `CLAUDE_CODE_USER_EMAIL`, `CLAUDE_CODE_OAUTH_SCOPES`), qui peuvent
///   contredire le profil, et réglages de comportement propres à cet hôte
///   (`CLAUDE_CODE_DISABLE_CRON`, `CLAUDE_CODE_DISABLE_TERMINAL_TITLE`,
///   `CLAUDE_CODE_EAGER_FLUSH`, `CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES`,
///   `CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL`,
///   `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING`,
///   `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`, `CLAUDE_CODE_REPORT_FINDINGS`,
///   `CLAUDE_CODE_STARTUP_FAILURE_RESULTS`, `CLAUDE_CODE_TERMINAL_MCP_TOOLS`).
///
/// Les variables de **configuration** documentées (`CLAUDE_CODE_USE_BEDROCK`,
/// `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, `ANTHROPIC_*`, mandataires, clés d'API,
/// `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`…) sont gardées.
pub const CLAUDE_SESSION_MARKERS: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_SSE_PORT",
    "CLAUDE_CODE_HOST_SESSION_ID",
    "CLAUDE_CODE_BRIDGE_SESSION_ID",
    "CLAUDE_CODE_REMOTE",
    "CLAUDE_CODE_REMOTE_SESSION_ID",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
    "CLAUDE_PID",
    "CLAUDE_EFFORT",
    "CLAUDE_JOB_DIR",
    "TRACEPARENT",
    "AI_AGENT",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
    "CLAUDE_CODE_SIMPLE",
    "CLAUDE_CODE_ACCOUNT_UUID",
    "CLAUDE_CODE_ORGANIZATION_UUID",
    "CLAUDE_CODE_USER_EMAIL",
    "CLAUDE_CODE_OAUTH_SCOPES",
    "CLAUDE_CODE_DISABLE_CRON",
    "CLAUDE_CODE_DISABLE_TERMINAL_TITLE",
    "CLAUDE_CODE_EAGER_FLUSH",
    "CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES",
    "CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL",
    "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING",
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS",
    "CLAUDE_CODE_REPORT_FINDINGS",
    "CLAUDE_CODE_STARTUP_FAILURE_RESULTS",
    "CLAUDE_CODE_TERMINAL_MCP_TOOLS",
];

/// Préfixes des marqueurs de session Claude Code (voir
/// [`CLAUDE_SESSION_MARKERS`]) : `CLAUDE_CODE_SESSION_*` (identifiant de la
/// session parente, `…_ATTENDED`…), `CLAUDE_CODE_PARENT_*`, et
/// `CLAUDE_CODE_SDK_*` et `CLAUDE_AGENT_SDK_*` (posées par un hôte Agent SDK,
/// comme l'app de bureau, pour **son** processus : rafraîchissement de
/// l'authentification par l'hôte, version du SDK, nommage des outils MCP…),
/// `CLAUDE_CODE_DESKTOP_*` (version de l'app de bureau hôte) et
/// `CLAUDE_PREVIEW_*` (réglages de préversion de l'hôte). Toujours avec le
/// `_` final : `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` est un réglage,
/// gardé. Les autres `CLAUDE_CODE_*` sont des réglages que l'utilisateur peut
/// poser dans son shell : gardés.
pub const CLAUDE_SESSION_MARKER_PREFIXES: &[&str] = &[
    "CLAUDE_CODE_SESSION_",
    "CLAUDE_CODE_PARENT_",
    "CLAUDE_CODE_SDK_",
    "CLAUDE_AGENT_SDK_",
    "CLAUDE_CODE_DESKTOP_",
    "CLAUDE_PREVIEW_",
];

/// Marqueur de session Claude Code (voir [`CLAUDE_SESSION_MARKERS`]) ?
pub fn is_claude_session_marker(name: &str) -> bool {
    CLAUDE_SESSION_MARKERS.contains(&name)
        || CLAUDE_SESSION_MARKER_PREFIXES
            .iter()
            .any(|p| name.starts_with(p))
}

/// Préfixes des variables héritées du démon toujours retirées : les
/// variables `ORCH_*` d'une autre session (si le démon a été lancé depuis une
/// session) et les réglages `DEVMAESTRO_*` du démon (binaire `claude`,
/// délais…), qui ne regardent pas `claude` ni ses outils. Seules les trois
/// variables des relais sont reposées.
const INHERITED_ENV_PREFIXES: &[&str] = &["ORCH_", "DEVMAESTRO_"];

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
    /// Noms des variables de l'environnement du démon (hérité par `claude`) :
    /// celles de [`INHERITED_ENV_PREFIXES`] et les marqueurs de session Claude
    /// Code ([`is_claude_session_marker`]) sont retirés.
    pub inherited_env: &'a [String],
    /// Lancement dans un scope systemd.
    pub scope: Option<ScopeSpec<'a>>,
}

/// Scope systemd d'un lancement.
#[derive(Debug, Clone, Copy)]
pub struct ScopeSpec<'a> {
    /// Binaire `systemd-run`.
    pub systemd_run: &'a Path,
    /// Nom de l'unité (`devmaestro-session-….scope`).
    pub unit: &'a str,
    /// `XDG_RUNTIME_DIR` à donner à `systemd-run` pour joindre le
    /// gestionnaire systemd utilisateur, s'il diffère de celui du démon
    /// (tests seulement).
    pub runtime_dir: Option<&'a std::ffi::OsStr>,
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
    // Les noms exacts sont toujours retirés (même absents de la liste
    // héritée : défense en profondeur), les préfixes selon l'héritage.
    let mut env_remove: Vec<String> = CLAUDE_SESSION_MARKERS
        .iter()
        .map(|s| (*s).to_owned())
        .collect();
    let ours = [ENV_SOCKET, ENV_TOKEN, ENV_SESSION];
    for key in spec.inherited_env {
        let removed = INHERITED_ENV_PREFIXES.iter().any(|p| key.starts_with(p))
            || is_claude_session_marker(key);
        if removed && !ours.contains(&key.as_str()) && !env_remove.contains(key) {
            env_remove.push(key.clone());
        }
    }
    match spec.profile.config_dir_env() {
        Some(dir) => env.push(("CLAUDE_CONFIG_DIR".into(), dir.into())),
        None => env_remove.push("CLAUDE_CONFIG_DIR".into()),
    }
    let (program, args) = match spec.scope {
        // `systemd-run --scope` s'inscrit dans le scope puis exécute la
        // commande à sa place (même pid, même environnement, même dossier,
        // même terminal).
        Some(ScopeSpec {
            systemd_run, unit, ..
        }) => {
            let mut wrapped: Vec<OsString> = vec![
                "--user".into(),
                "--scope".into(),
                "--quiet".into(),
                "--collect".into(),
                format!("--unit={unit}").into(),
                "--".into(),
                spec.claude_bin.into(),
            ];
            wrapped.extend(args);
            (systemd_run.to_path_buf(), wrapped)
        }
        None => (spec.claude_bin.to_path_buf(), args),
    };
    if let Some(dir) = spec.scope.and_then(|s| s.runtime_dir) {
        env.push(("XDG_RUNTIME_DIR".into(), dir.into()));
    }
    CommandLine {
        program,
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

/// Fichier exécutable ?
pub fn is_executable(p: &Path) -> bool {
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
            inherited_env: &[],
            scope: None,
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
    fn inherited_control_variables_are_removed() {
        let p = Profile::default_for("/home/u/.claude");
        let inherited: Vec<String> = [
            "ORCH_SOCKET",
            "ORCH_TOKEN",
            "ORCH_AUTRE",
            "DEVMAESTRO_CLAUDE_BIN",
            "DEVMAESTRO_PERMISSION_TIMEOUT_SECS",
            "PATH",
            "HOME",
        ]
        .map(String::from)
        .to_vec();
        let mut s = spec(
            &p,
            LaunchKind::New {
                claude_session_id: "u".into(),
            },
        );
        s.inherited_env = &inherited;
        let c = build(&s);
        for k in [
            "ORCH_AUTRE",
            "DEVMAESTRO_CLAUDE_BIN",
            "DEVMAESTRO_PERMISSION_TIMEOUT_SECS",
        ] {
            assert!(c.env_remove.iter().any(|r| r == k), "{k}");
        }
        for k in ["ORCH_SOCKET", "ORCH_TOKEN", "PATH", "HOME"] {
            assert!(!c.env_remove.iter().any(|r| r == k), "{k}");
        }
        assert_eq!(env(&c, "ORCH_SOCKET").unwrap(), "/run/orchd.sock");
    }

    #[test]
    fn claude_desktop_host_variables_are_markers() {
        // Relevées dans une session lancée par l'app, elle-même démarrée
        // depuis une session Claude Desktop.
        for k in [
            "CLAUDE_AGENT_SDK_MCP_NO_PREFIX",
            "CLAUDE_AGENT_SDK_VERSION",
            "CLAUDE_CODE_ACCOUNT_UUID",
            "CLAUDE_CODE_DESKTOP_APP_VERSION",
            "CLAUDE_CODE_DISABLE_CRON",
            "CLAUDE_CODE_DISABLE_TERMINAL_TITLE",
            "CLAUDE_CODE_EAGER_FLUSH",
            "CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES",
            "CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL",
            "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING",
            "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS",
            "CLAUDE_CODE_OAUTH_SCOPES",
            "CLAUDE_CODE_ORGANIZATION_UUID",
            "CLAUDE_CODE_REPORT_FINDINGS",
            "CLAUDE_CODE_STARTUP_FAILURE_RESULTS",
            "CLAUDE_CODE_TERMINAL_MCP_TOOLS",
            "CLAUDE_CODE_USER_EMAIL",
            "CLAUDE_PREVIEW_CLASSIFIER_FLOOR",
        ] {
            assert!(is_claude_session_marker(k), "{k} doit être retirée");
        }
        // Réglages que l'utilisateur pose lui-même : gardés.
        for k in [
            "CLAUDE_CODE_USE_VERTEX",
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
            "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
            "CLAUDE_AGENT_SDK",
            "CLAUDE_CONFIG_DIR",
        ] {
            assert!(!is_claude_session_marker(k), "{k} doit être gardée");
        }
    }

    #[test]
    fn inherited_claude_code_session_markers_are_removed() {
        let p = Profile::default_for("/home/u/.claude");
        let markers = [
            "CLAUDECODE",
            "CLAUDE_CODE_ENTRYPOINT",
            "CLAUDE_CODE_CHILD_SESSION",
            "CLAUDE_CODE_SSE_PORT",
            "CLAUDE_CODE_SESSION_ID",
            "CLAUDE_CODE_SESSION_ATTENDED",
            "CLAUDE_CODE_PARENT_SESSION_ID",
            "CLAUDE_CODE_HOST_SESSION_ID",
            "CLAUDE_CODE_EXECPATH",
            "CLAUDE_CODE_MESSAGING_SOCKET",
            "CLAUDE_CODE_MESSAGING_TOKEN",
            "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH",
            "CLAUDE_PID",
            "CLAUDE_EFFORT",
            "AI_AGENT",
        ];
        let kept = [
            "CLAUDE_CODE_USE_BEDROCK",
            "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
            "CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS",
            "CLAUDE_CODE_DISABLE_AUTOUPDATER",
            "CLAUDE_CODE_DESKTOP",
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_BASE_URL",
            "HTTPS_PROXY",
            "CLAUDE_ENV_FILE",
            "PATH",
        ];
        let inherited: Vec<String> = markers.iter().chain(&kept).map(|s| s.to_string()).collect();
        let mut s = spec(
            &p,
            LaunchKind::New {
                claude_session_id: "u".into(),
            },
        );
        s.inherited_env = &inherited;
        let c = build(&s);
        for k in markers {
            assert!(c.env_remove.iter().any(|r| r == k), "{k} doit être retirée");
            assert!(is_claude_session_marker(k), "{k}");
        }
        for k in kept {
            assert!(!c.env_remove.iter().any(|r| r == k), "{k} doit être gardée");
            assert!(!is_claude_session_marker(k), "{k}");
        }
        // Les noms exacts sont retirés même s'ils n'étaient pas hérités.
        let c = build(&spec(
            &p,
            LaunchKind::New {
                claude_session_id: "u".into(),
            },
        ));
        for k in CLAUDE_SESSION_MARKERS {
            assert!(c.env_remove.iter().any(|r| r == k), "{k}");
        }
    }

    #[test]
    fn scope_wraps_the_command_in_systemd_run() {
        let p = Profile::default_for("/home/u/.claude");
        let mut s = spec(
            &p,
            LaunchKind::New {
                claude_session_id: "u".into(),
            },
        );
        s.scope = Some(ScopeSpec {
            systemd_run: Path::new("/usr/bin/systemd-run"),
            unit: "devmaestro-session-ab.scope",
            runtime_dir: None,
        });
        let c = build(&s);
        assert_eq!(c.program, Path::new("/usr/bin/systemd-run"));
        let a = args(&c);
        assert_eq!(
            &a[..8],
            [
                "--user",
                "--scope",
                "--quiet",
                "--collect",
                "--unit=devmaestro-session-ab.scope",
                "--",
                "/usr/bin/claude",
                "--session-id"
            ]
        );
        assert_eq!(env(&c, "ORCH_TOKEN").unwrap(), "jeton");
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
