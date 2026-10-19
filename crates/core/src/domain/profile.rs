//! Profils Claude Code (un compte = un dossier de configuration).

use std::path::{Path, PathBuf};

/// Nom du profil correspondant au dossier par défaut `~/.claude`.
pub const DEFAULT_PROFILE_NAME: &str = "default";

/// Un compte Claude : un nom et un dossier de configuration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Profile {
    /// Nom affiché et clé du profil (`default`, `work`…).
    pub name: String,
    /// Dossier de configuration (`~/.claude`, `~/.claude-work`…).
    pub config_dir: PathBuf,
    /// Faut-il passer `CLAUDE_CONFIG_DIR` au lancement ?
    ///
    /// Faux pour le profil par défaut : avec `CLAUDE_CONFIG_DIR=~/.claude`,
    /// Claude Code chercherait `.claude.json` dans `~/.claude/` alors qu'il
    /// vit dans `~/.claude.json`, et la session perdrait son état (compte,
    /// confiance des dossiers).
    pub sets_config_dir_env: bool,
}

impl Profile {
    /// Profil par défaut, sur `~/.claude`, sans `CLAUDE_CONFIG_DIR`.
    pub fn default_for(config_dir: impl Into<PathBuf>) -> Self {
        Self {
            name: DEFAULT_PROFILE_NAME.to_owned(),
            config_dir: config_dir.into(),
            sets_config_dir_env: false,
        }
    }

    /// Profil supplémentaire (`~/.claude-<nom>`), lancé avec `CLAUDE_CONFIG_DIR`.
    pub fn named(name: impl Into<String>, config_dir: impl Into<PathBuf>) -> Self {
        Self {
            name: name.into(),
            config_dir: config_dir.into(),
            sets_config_dir_env: true,
        }
    }

    /// Valeur de `CLAUDE_CONFIG_DIR` à passer au lancement, s'il en faut une.
    pub fn config_dir_env(&self) -> Option<&Path> {
        self.sets_config_dir_env
            .then_some(self.config_dir.as_path())
    }

    /// Dossier des transcripts : `<config>/projects`.
    pub fn projects_dir(&self) -> PathBuf {
        self.config_dir.join("projects")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_profile_does_not_set_env() {
        let p = Profile::default_for("/home/u/.claude");
        assert_eq!(p.name, "default");
        assert_eq!(p.config_dir_env(), None);
    }

    #[test]
    fn named_profile_sets_env() {
        let p = Profile::named("work", "/home/u/.claude-work");
        assert_eq!(p.config_dir_env(), Some(Path::new("/home/u/.claude-work")));
        assert_eq!(p.projects_dir(), Path::new("/home/u/.claude-work/projects"));
    }
}
