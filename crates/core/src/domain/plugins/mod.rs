//! Plugins (v0.3, lot 22a, [ADR 0007](../../../../docs/adr/0007-plugins.md)) :
//! règles pures de l'hôte.
//!
//! - [`manifest`] : analyse et validation **stricte** de `plugin.json`,
//!   empreinte ;
//! - [`document`] : validation et normalisation des documents déclaratifs
//!   et du résultat d'`action.run` ;
//! - ici : permissions, nettoyage du texte tiers, liste d'autorisation de
//!   l'environnement, états d'acceptation et de processus.
//!
//! Aucun accès au disque ni aux processus : le démon lit les octets
//! (adaptateurs) et les donne à ces fonctions.

pub mod document;
pub mod manifest;

use std::ffi::OsString;

use super::forge::invisible;

/// Version de l'API des plugins (`api_version` du manifeste et
/// d'`initialize`).
pub const API_VERSION: u64 = 1;
/// Plugins lus au plus dans le dossier (noms triés, coupe déterministe).
pub const MAX_PLUGINS: usize = 32;
/// Taille maximale de `plugin.json`.
pub const MAX_MANIFEST_BYTES: usize = 64 * 1024;
/// Taille maximale d'un fichier haché.
pub const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
/// Taille maximale de l'ensemble des fichiers hachés.
pub const MAX_TOTAL_FILE_BYTES: u64 = 16 * 1024 * 1024;
/// Taille maximale d'une ligne JSON reçue d'un plugin (sans le saut de ligne).
pub const MAX_LINE_BYTES: usize = 1024 * 1024;
/// Fin de stderr gardée.
pub const STDERR_TAIL_BYTES: usize = 4 * 1024;
/// Notifications acceptées au plus pendant une requête.
pub const MAX_NOTIFICATIONS: usize = 1000;
/// Longueur maximale (caractères) du message d'une erreur renvoyée par un plugin.
pub const MAX_ERROR_MESSAGE_CHARS: usize = 500;

/// Une permission demandée par un manifeste (liste fermée).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Permission {
    DiffRead,
    WorktreeRead,
    WorktreeWrite,
    SessionsRead,
    ClaudePropose,
    Network,
}

impl Permission {
    pub const ALL: [Permission; 6] = [
        Self::DiffRead,
        Self::WorktreeRead,
        Self::WorktreeWrite,
        Self::SessionsRead,
        Self::ClaudePropose,
        Self::Network,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::DiffRead => "diff.read",
            Self::WorktreeRead => "worktree.read",
            Self::WorktreeWrite => "worktree.write",
            Self::SessionsRead => "sessions.read",
            Self::ClaudePropose => "claude.propose",
            Self::Network => "network",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|p| p.as_str() == s)
    }
}

/// Noms des permissions, dans l'ordre donné.
pub fn permission_names(perms: &[Permission]) -> Vec<String> {
    perms.iter().map(|p| p.as_str().to_owned()).collect()
}

/// Accord de l'utilisateur pour un plugin, tel qu'enregistré par le démon.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Acceptance {
    pub name: String,
    pub fingerprint: String,
    /// Noms des permissions acceptées (tels qu'enregistrés).
    pub permissions: Vec<String>,
    /// Date de l'accord (RFC 3339).
    pub accepted_at: String,
}

/// État d'acceptation d'un plugin (`acceptance` de `plugins.list`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcceptanceState {
    /// Jamais accepté (ou révoqué).
    None,
    /// Empreinte **et** permissions actuelles égales à celles acceptées.
    Accepted,
    /// Accepté, puis modifié (manifeste, fichier, permission) ou devenu invalide.
    Changed,
}

impl AcceptanceState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Accepted => "accepted",
            Self::Changed => "changed",
        }
    }

    /// État d'un plugin d'empreinte `fingerprint` (`None` : manifeste
    /// invalide) et de permissions `permissions`, au vu de l'accord
    /// enregistré.
    pub fn of(
        accepted: Option<&Acceptance>,
        fingerprint: Option<&str>,
        permissions: &[Permission],
    ) -> Self {
        let Some(a) = accepted else {
            return Self::None;
        };
        let mut now = permission_names(permissions);
        now.sort();
        let mut then = a.permissions.clone();
        then.sort();
        if fingerprint == Some(a.fingerprint.as_str()) && now == then {
            Self::Accepted
        } else {
            Self::Changed
        }
    }
}

/// État du processus d'un plugin (`process.state` de `plugins.list`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessState {
    Stopped,
    Running,
    Failed,
}

impl ProcessState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stopped => "stopped",
            Self::Running => "running",
            Self::Failed => "failed",
        }
    }
}

/// Variables de l'environnement du démon reprises pour un plugin (liste
/// d'autorisation) ; toutes les autres sont retirées (`ORCH_*`,
/// `DEVMAESTRO_*`, `ANTHROPIC_*`, `CLAUDE_*`, jetons…).
pub const ENV_ALLOWED: &[&str] = &["PATH", "HOME", "LANG", "XDG_RUNTIME_DIR", "TERM"];

/// Variable reprise pour un plugin ? `PATH`, `HOME`, `LANG`, `LC_*`,
/// `XDG_RUNTIME_DIR`, `TERM` seulement.
pub fn env_allowed(name: &str) -> bool {
    ENV_ALLOWED.contains(&name)
        || name
            .strip_prefix("LC_")
            .is_some_and(|rest| !rest.is_empty())
}

/// Environnement d'un plugin à partir de celui du démon (liste
/// d'autorisation, ordre gardé). Le processus est lancé avec un
/// environnement **vidé**, puis ces seules variables.
pub fn plugin_env(
    daemon_env: impl IntoIterator<Item = (OsString, OsString)>,
) -> Vec<(String, OsString)> {
    daemon_env
        .into_iter()
        .filter_map(|(k, v)| {
            let k = k.into_string().ok()?;
            env_allowed(&k).then_some((k, v))
        })
        .collect()
}

/// Nombre de caractères (points de code) d'un texte.
pub fn char_len(s: &str) -> usize {
    s.chars().count()
}

/// Traitement des sauts de ligne d'un texte tiers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextMode {
    /// Gardés (`markdown`, `detail`, `notice`).
    Multiline,
    /// Remplacés par une espace (`title`, `label`, `key`, `caption`).
    OneLine,
    /// Retirés comme les autres contrôles (autres champs).
    Plain,
}

/// Texte tiers nettoyé : invisibles et caractères de direction retirés
/// ([`invisible`]), tabulation → espace, sauts de ligne selon `mode`,
/// autres contrôles retirés. Les bornes se comptent en caractères **après**
/// ce nettoyage (comme l'app).
pub fn clean_third_party(text: &str, mode: TextMode) -> String {
    text.chars()
        .filter(|c| !invisible(*c))
        .filter_map(|c| match c {
            '\t' => Some(' '),
            '\n' => match mode {
                TextMode::Multiline => Some('\n'),
                TextMode::OneLine => Some(' '),
                TextMode::Plain => None,
            },
            c if c.is_control() => None,
            c => Some(c),
        })
        .collect()
}

/// Texte d'une ligne venu d'un manifeste : sans contrôle ni invisible (le
/// manifeste est **refusé**, pas nettoyé).
pub fn is_clean_line(s: &str) -> bool {
    !s.chars().any(|c| c.is_control() || invisible(c))
}

/// `^[a-z0-9][a-z0-9-]{0,max}$` (noms de plugin, identifiants d'action).
pub fn is_slug(s: &str, max_tail: usize) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= max_tail + 1
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b[1..]
            .iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// Nom de plugin valide (`^[a-z0-9][a-z0-9-]{0,39}$`).
pub fn is_plugin_name(s: &str) -> bool {
    is_slug(s, 39)
}

/// Identifiant d'action valide (`^[a-z0-9][a-z0-9-]{0,31}$`).
pub fn is_action_id(s: &str) -> bool {
    is_slug(s, 31)
}

/// Empreinte au format attendu (sha256 en hexadécimal minuscule).
pub fn is_fingerprint(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Message d'erreur d'un plugin montrable : texte tiers nettoyé, d'une
/// ligne, [`MAX_ERROR_MESSAGE_CHARS`] caractères au plus.
pub fn clean_error_message(message: &str) -> String {
    let one = clean_third_party(message, TextMode::OneLine);
    let one = one.split_whitespace().collect::<Vec<_>>().join(" ");
    one.chars().take(MAX_ERROR_MESSAGE_CHARS).collect()
}

/// Fin de stderr montrable : décodée (octets invalides remplacés), coupée
/// au début sur un caractère entier, nettoyée (sauts de ligne gardés).
pub fn clean_stderr_tail(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    clean_third_party(&text, TextMode::Multiline)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permissions_round_trip() {
        for p in Permission::ALL {
            assert_eq!(Permission::parse(p.as_str()), Some(p));
        }
        assert_eq!(Permission::parse("fs.write"), None);
    }

    #[test]
    fn acceptance_needs_same_fingerprint_and_permissions() {
        let a = Acceptance {
            name: "x".into(),
            fingerprint: "f".repeat(64),
            permissions: vec!["worktree.read".into(), "diff.read".into()],
            accepted_at: "2026-10-21T00:00:00Z".into(),
        };
        let fp = "f".repeat(64);
        let perms = [Permission::DiffRead, Permission::WorktreeRead];
        assert_eq!(
            AcceptanceState::of(None, Some(&fp), &perms),
            AcceptanceState::None
        );
        assert_eq!(
            AcceptanceState::of(Some(&a), Some(&fp), &perms),
            AcceptanceState::Accepted
        );
        assert_eq!(
            AcceptanceState::of(Some(&a), Some(&"e".repeat(64)), &perms),
            AcceptanceState::Changed
        );
        assert_eq!(
            AcceptanceState::of(Some(&a), Some(&fp), &[Permission::DiffRead]),
            AcceptanceState::Changed
        );
        assert_eq!(
            AcceptanceState::of(Some(&a), None, &[]),
            AcceptanceState::Changed
        );
    }

    #[test]
    fn environment_is_an_allowlist() {
        let env: Vec<(OsString, OsString)> = [
            "PATH",
            "HOME",
            "LANG",
            "LC_ALL",
            "LC_CTYPE",
            "XDG_RUNTIME_DIR",
            "TERM",
            "LC_",
            "DEVMAESTRO_X",
            "ORCH_TOKEN",
            "ANTHROPIC_API_KEY",
            "CLAUDE_CONFIG_DIR",
            "GH_TOKEN",
            "FOO",
            "XDG_CONFIG_HOME",
            "DBUS_SESSION_BUS_ADDRESS",
            "LANGUAGE",
        ]
        .iter()
        .map(|k| (OsString::from(k), OsString::from("v")))
        .collect();
        let kept: Vec<String> = plugin_env(env).into_iter().map(|(k, _)| k).collect();
        assert_eq!(
            kept,
            [
                "PATH",
                "HOME",
                "LANG",
                "LC_ALL",
                "LC_CTYPE",
                "XDG_RUNTIME_DIR",
                "TERM"
            ]
        );
    }

    #[test]
    fn third_party_text_is_cleaned() {
        assert_eq!(
            clean_third_party("a\u{202E}b\tc\u{7}\nd\u{200B}", TextMode::Multiline),
            "ab c\nd"
        );
        assert_eq!(clean_third_party("a\nb\r\nc", TextMode::OneLine), "a b c");
        assert_eq!(clean_third_party("a\nb\r\nc", TextMode::Plain), "abc");
        assert_eq!(clean_error_message("  x\n\u{1b}[31my  "), "x [31my");
        assert_eq!(char_len(&clean_error_message(&"é".repeat(900))), 500);
    }

    #[test]
    fn slugs() {
        assert!(is_plugin_name("codegraph-impact"));
        assert!(is_plugin_name("0"));
        assert!(!is_plugin_name("-x"));
        assert!(!is_plugin_name("Codegraph"));
        assert!(!is_plugin_name(&"a".repeat(41)));
        assert!(is_plugin_name(&"a".repeat(40)));
        assert!(is_action_id(&"a".repeat(32)));
        assert!(!is_action_id(&"a".repeat(33)));
        assert!(is_fingerprint(&"0a".repeat(32)));
        assert!(!is_fingerprint(&"0A".repeat(32)));
    }
}
