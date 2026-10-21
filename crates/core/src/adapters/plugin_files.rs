//! Lecture du dossier des plugins (v0.3, lot 22a) : liste des dossiers, et
//! fichiers lus sous le dossier **résolu** d'un plugin avec les garanties de
//! l'onglet Fichiers ([`super::FsFiles`] : `openat2` + `RESOLVE_BENEATH`,
//! fichiers ordinaires seulement, liens suivis s'ils restent dessous).
//! Rien n'est jamais créé ni écrit.

use std::path::{Path, PathBuf};

use super::FsFiles;
use crate::ports::{FileAccess, FileError, FileStamp, PluginFileError, PluginFiles};

/// [`PluginFiles`] sur le système de fichiers.
#[derive(Debug, Clone, Copy, Default)]
pub struct FsPluginFiles;

/// Dossiers de plugins rendus au plus (après tri).
const MAX_SCANNED: usize = 4096;

impl PluginFiles for FsPluginFiles {
    fn list(&self, dir: &Path) -> Vec<String> {
        let Ok(rd) = std::fs::read_dir(dir) else {
            return Vec::new();
        };
        // Noms triés **avant** la coupe : le résultat ne dépend pas de l'ordre
        // du système de fichiers.
        let mut names: Vec<String> = rd
            .flatten()
            .filter_map(|e| e.file_name().into_string().ok())
            .filter(|n| !n.starts_with('.'))
            .collect();
        names.sort();
        names
            .into_iter()
            // `metadata` suit un lien : un lien vers un dossier compte.
            .filter(|n| std::fs::metadata(dir.join(n)).is_ok_and(|m| m.is_dir()))
            .take(MAX_SCANNED)
            .collect()
    }

    fn stamp(&self, root: &Path, rel: &str) -> Option<FileStamp> {
        use std::os::unix::fs::MetadataExt;
        let path = root.join(rel).canonicalize().ok()?;
        if !path.starts_with(root) {
            return None;
        }
        let m = std::fs::metadata(&path).ok()?;
        if !m.is_file() {
            return None;
        }
        let ns = |s: i64, n: i64| i128::from(s) * 1_000_000_000 + i128::from(n);
        Some(FileStamp {
            dev: m.dev(),
            ino: m.ino(),
            size: m.size(),
            mtime_ns: ns(m.mtime(), m.mtime_nsec()),
            ctime_ns: ns(m.ctime(), m.ctime_nsec()),
        })
    }

    fn resolve(&self, dir: &Path, name: &str) -> Option<PathBuf> {
        if name.is_empty() || name.contains('/') || name.starts_with('.') {
            return None;
        }
        let p = dir.join(name).canonicalize().ok()?;
        p.is_dir().then_some(p)
    }

    fn read(&self, root: &Path, rel: &str, max: u64) -> Result<Vec<u8>, PluginFileError> {
        match FsFiles.read_beneath(root, rel, max) {
            Ok(f) => f.bytes.ok_or(PluginFileError::TooLarge(f.size)),
            Err(FileError::NotFound) => Err(PluginFileError::NotFound),
            Err(FileError::Outside(_)) => {
                Err(PluginFileError::Refused("hors du dossier du plugin".into()))
            }
            Err(FileError::NotRegular) => {
                Err(PluginFileError::Refused("pas un fichier ordinaire".into()))
            }
            Err(FileError::Denied) => Err(PluginFileError::Refused("lecture refusée".into())),
            Err(FileError::NotDir) => Err(PluginFileError::NotFound),
            Err(_) => Err(PluginFileError::Refused("illisible".into())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_dirs_and_links_and_reads_beneath() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().canonicalize().unwrap();
        let plugins = base.join("plugins");
        std::fs::create_dir_all(plugins.join("b")).unwrap();
        std::fs::create_dir_all(plugins.join(".cache")).unwrap();
        std::fs::write(plugins.join("fichier"), "x").unwrap();
        let real = base.join("depot/a");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("plugin.json"), "{}").unwrap();
        std::fs::write(base.join("secret"), "s").unwrap();
        std::os::unix::fs::symlink(&real, plugins.join("a")).unwrap();
        std::os::unix::fs::symlink(base.join("secret"), real.join("fuite")).unwrap();
        std::os::unix::fs::symlink("plugin.json", real.join("interne")).unwrap();
        let f = FsPluginFiles;
        assert_eq!(f.list(&plugins), ["a", "b"]);
        assert!(f.list(&base.join("absent")).is_empty());
        let root = f.resolve(&plugins, "a").unwrap();
        assert_eq!(root, real);
        assert_eq!(f.read(&root, "plugin.json", 10).unwrap(), b"{}");
        assert_eq!(f.read(&root, "interne", 10).unwrap(), b"{}");
        assert!(matches!(
            f.read(&root, "fuite", 10),
            Err(PluginFileError::Refused(_))
        ));
        assert!(matches!(
            f.read(&root, "../../secret", 10),
            Err(PluginFileError::Refused(_))
        ));
        assert_eq!(
            f.read(&root, "plugin.json", 1),
            Err(PluginFileError::TooLarge(2))
        );
        assert_eq!(f.read(&root, "absent", 1), Err(PluginFileError::NotFound));
        assert!(f.resolve(&plugins, "fichier").is_none());
        // Empreinte d'état : stable, change avec le contenu, refusée hors racine.
        let s1 = f.stamp(&root, "plugin.json").unwrap();
        assert_eq!(f.stamp(&root, "interne"), Some(s1));
        assert!(f.stamp(&root, "fuite").is_none());
        assert!(f.stamp(&root, "absent").is_none());
        std::fs::write(real.join("plugin.json"), "{ }").unwrap();
        assert_ne!(f.stamp(&root, "plugin.json"), Some(s1));
        assert!(f.resolve(&plugins, "../plugins").is_none());
    }
}
