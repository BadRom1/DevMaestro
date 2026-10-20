//! Réglages du démon : `$XDG_CONFIG_HOME/devmaestro/config.toml`
//! (facultatif, jamais écrit par le démon).
//!
//! ```toml
//! # Autorise les modes qui suppriment les demandes de permission
//! # (`bypassPermissions`, `dontAsk`) au lancement, à la reprise et par
//! # `sessions.setMode`. Faux par défaut.
//! allow_dangerous_modes = true
//! ```
//!
//! Le fichier est lu **une fois, au démarrage du démon** : un changement
//! demande de redémarrer le démon (l'app le fera après avoir changé le
//! réglage). Un fichier absent donne les valeurs par défaut ; un fichier
//! illisible ou invalide aussi (avec un avertissement au journal) : en cas
//! de doute, les modes dangereux restent refusés.

use std::path::Path;

use super::log::warning;

/// Réglages lus.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DaemonSettings {
    /// `allow_dangerous_modes` : faux par défaut.
    pub allow_dangerous_modes: bool,
    /// `[quotas] usage_api` : interroger l'API d'usage (non documentée) de
    /// Claude Code pour les quotas ; vrai par défaut.
    pub usage_api: bool,
}

impl Default for DaemonSettings {
    fn default() -> Self {
        Self {
            allow_dangerous_modes: false,
            usage_api: true,
        }
    }
}

impl DaemonSettings {
    /// Lit les réglages ; ne renvoie jamais d'erreur (voir le module).
    pub fn load(path: &Path) -> Self {
        let text = match std::fs::read_to_string(path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Self::default(),
            Err(e) => {
                warning!("réglages {} illisibles : {e}", path.display());
                return Self::default();
            }
        };
        match Self::parse(&text) {
            Ok(s) => s,
            Err(e) => {
                warning!("réglages {} invalides : {e}", path.display());
                Self::default()
            }
        }
    }

    /// Lit le contenu d'un `config.toml`. Les clés inconnues sont ignorées.
    pub fn parse(text: &str) -> Result<Self, String> {
        let table: toml::Table = text.parse().map_err(|e: toml::de::Error| e.to_string())?;
        let allow = match table.get("allow_dangerous_modes") {
            None => false,
            Some(toml::Value::Boolean(b)) => *b,
            Some(_) => return Err("« allow_dangerous_modes » doit valoir true ou false".into()),
        };
        let usage_api = match table.get("quotas") {
            None => true,
            Some(toml::Value::Table(t)) => match t.get("usage_api") {
                None => true,
                Some(toml::Value::Boolean(b)) => *b,
                Some(_) => return Err("« quotas.usage_api » doit valoir true ou false".into()),
            },
            Some(_) => return Err("« quotas » doit être une table ([quotas])".into()),
        };
        Ok(Self {
            allow_dangerous_modes: allow,
            usage_api,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_defaults() {
        assert_eq!(
            DaemonSettings::parse("").unwrap(),
            DaemonSettings::default()
        );
        assert!(
            DaemonSettings::parse("allow_dangerous_modes = true\nautre = 1\n")
                .unwrap()
                .allow_dangerous_modes
        );
        assert!(DaemonSettings::parse("allow_dangerous_modes = \"oui\"").is_err());
        assert!(DaemonSettings::default().usage_api);
        assert!(
            !DaemonSettings::parse("[quotas]\nusage_api = false\n")
                .unwrap()
                .usage_api
        );
        assert!(DaemonSettings::parse("[quotas]\n").unwrap().usage_api);
        assert!(DaemonSettings::parse("[quotas]\nusage_api = 0\n").is_err());
        assert!(DaemonSettings::parse("quotas = 1\n").is_err());
        assert!(DaemonSettings::parse("pas du toml =").is_err());
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            DaemonSettings::load(&dir.path().join("absent.toml")),
            DaemonSettings::default()
        );
        let bad = dir.path().join("config.toml");
        std::fs::write(&bad, "allow_dangerous_modes = 1").unwrap();
        assert!(!DaemonSettings::load(&bad).allow_dangerous_modes);
    }
}
