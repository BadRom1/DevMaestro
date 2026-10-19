//! Projets : un dépôt git suivi par l'app.

use std::path::{Path, PathBuf};

/// Un projet : un dépôt git, identifié par sa racine.
///
/// En v0.1, la racine est le dossier fourni par l'utilisateur ; le
/// regroupement par `git rev-parse --git-common-dir` (architecture § 5)
/// arrive avec l'adaptateur git.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Project {
    /// Racine du dépôt.
    pub root: PathBuf,
    /// Nom affiché.
    pub display_name: String,
    /// Profil utilisé par défaut pour les nouvelles sessions (nom du profil).
    pub default_profile: Option<String>,
}

impl Project {
    /// Projet dont le nom affiché est le dernier composant de la racine.
    pub fn from_root(root: impl Into<PathBuf>) -> Self {
        let root = root.into();
        let display_name = display_name_of(&root);
        Self {
            root,
            display_name,
            default_profile: None,
        }
    }
}

fn display_name_of(root: &Path) -> String {
    root.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| root.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_name_is_last_component() {
        assert_eq!(
            Project::from_root("/home/u/dev/Orchestrateur").display_name,
            "Orchestrateur"
        );
        assert_eq!(Project::from_root("/").display_name, "/");
    }
}
