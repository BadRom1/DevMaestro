//! Détection des profils Claude Code dans le dossier personnel.
//!
//! - `~/.claude` : profil par défaut (`default`), lancé **sans**
//!   `CLAUDE_CONFIG_DIR` ;
//! - `~/.claude-<nom>` : profil `<nom>`, lancé avec `CLAUDE_CONFIG_DIR`.
//!
//! Un dossier n'est retenu que s'il ressemble à une configuration Claude Code
//! (il contient `settings.json` ou `projects/`). Les liens symboliques sont
//! suivis. Les copies de sauvegarde (`~/.claude-backup*`) sont écartées.
//! Rien n'est jamais écrit.
//!
//! Cette détection n'est qu'une proposition : la liste des profils sera
//! confirmable et modifiable dans la configuration de l'app
//! (`config.toml`, architecture § 13).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::domain::Profile;
use crate::ports::ProfileSource;

const PREFIX: &str = ".claude-";

/// Profils trouvés sous `home` : le profil par défaut d'abord, puis les
/// autres par ordre alphabétique.
pub fn discover_profiles(home: &Path) -> io::Result<Vec<Profile>> {
    let mut profiles = Vec::new();
    let default_dir = home.join(".claude");
    if looks_like_config_dir(&default_dir) {
        profiles.push(Profile::default_for(default_dir));
    }

    let mut named = Vec::new();
    for entry in fs::read_dir(home)? {
        let Ok(entry) = entry else { continue };
        let file_name = entry.file_name();
        let Some(name) = file_name.to_str().and_then(|n| n.strip_prefix(PREFIX)) else {
            continue;
        };
        if name.is_empty() || name.starts_with("backup") {
            continue;
        }
        let path = entry.path();
        if looks_like_config_dir(&path) {
            named.push(Profile::named(name, path));
        }
    }
    named.sort_by(|a, b| a.name.cmp(&b.name));
    profiles.extend(named);
    Ok(profiles)
}

fn looks_like_config_dir(dir: &Path) -> bool {
    dir.is_dir() && (dir.join("settings.json").is_file() || dir.join("projects").is_dir())
}

/// [`ProfileSource`] sur le système de fichiers.
#[derive(Debug, Clone)]
pub struct FsProfileSource {
    home: PathBuf,
}

impl FsProfileSource {
    pub fn new(home: impl Into<PathBuf>) -> Self {
        Self { home: home.into() }
    }

    /// Source sur le dossier personnel de l'utilisateur courant (`$HOME`).
    pub fn from_env() -> Option<Self> {
        std::env::home_dir().map(Self::new)
    }
}

impl ProfileSource for FsProfileSource {
    fn profiles(&self) -> io::Result<Vec<Profile>> {
        discover_profiles(&self.home)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mkdir(p: &Path) {
        fs::create_dir_all(p).unwrap();
    }

    #[test]
    fn finds_default_and_named_profiles() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        mkdir(&h.join(".claude/projects"));
        mkdir(&h.join(".claude-work"));
        fs::write(h.join(".claude-work/settings.json"), "{}").unwrap();
        mkdir(&h.join(".claude-alpha/projects"));
        // Ignorés : sans configuration, suffixe vide, fichier, autre préfixe.
        mkdir(&h.join(".claude-vide"));
        mkdir(&h.join(".claude-/projects"));
        mkdir(&h.join(".claude-backup-2026/projects"));
        fs::write(h.join(".claude-fichier"), "").unwrap();
        fs::write(h.join(".claude.json"), "{}").unwrap();
        mkdir(&h.join(".config/projects"));

        let profiles = discover_profiles(h).unwrap();
        let names: Vec<_> = profiles.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["default", "alpha", "work"]);
        assert_eq!(profiles[0].config_dir_env(), None);
        assert_eq!(
            profiles[2].config_dir_env(),
            Some(h.join(".claude-work").as_path())
        );
    }

    #[test]
    fn empty_home_has_no_profile() {
        let home = tempfile::tempdir().unwrap();
        assert!(
            FsProfileSource::new(home.path())
                .profiles()
                .unwrap()
                .is_empty()
        );
    }

    #[cfg(unix)]
    #[test]
    fn follows_symlinked_config_dir() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        mkdir(&h.join("ailleurs/projects"));
        std::os::unix::fs::symlink(h.join("ailleurs"), h.join(".claude-perso")).unwrap();
        let names: Vec<_> = discover_profiles(h)
            .unwrap()
            .into_iter()
            .map(|p| p.name)
            .collect();
        assert_eq!(names, ["perso"]);
    }
}
