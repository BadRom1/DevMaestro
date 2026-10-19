//! Emplacements des fichiers de DevMaestro (architecture § 13), selon la
//! spécification XDG.
//!
//! | Quoi | Où |
//! |---|---|
//! | Base SQLite | `$XDG_DATA_HOME/devmaestro/state.db` |
//! | Plugin Claude Code généré | `$XDG_DATA_HOME/devmaestro/claude-plugin/` |
//! | Réglages générés par profil | `$XDG_DATA_HOME/devmaestro/settings/<profil>.json` |
//! | Journal du démon | `$XDG_STATE_HOME/devmaestro/orchd.log` |
//! | Réglages du démon (facultatifs) | `$XDG_CONFIG_HOME/devmaestro/config.toml` |
//! | Socket de contrôle (clients), socket des relais, verrou | `$XDG_RUNTIME_DIR/devmaestro/orchd.sock`, `relay.sock`, `orchd.lock` |
//!
//! Replis quand une variable est absente ou relative (la spécification
//! demande alors de l'ignorer) : `~/.local/share`, `~/.local/state`,
//! `~/.config`, et pour
//! `XDG_RUNTIME_DIR`, `$TMPDIR/devmaestro-<uid>` (ou `/tmp/…`).

use std::env;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// Nom du dossier de l'app dans chaque base XDG.
pub const APP_DIR: &str = "devmaestro";
/// Nom du socket de contrôle du démon (clients : front, `orchd ctl`).
pub const SOCKET_NAME: &str = "orchd.sock";
/// Nom du socket des relais (`orchd hook`, `orchd statusline`).
pub const RELAY_SOCKET_NAME: &str = "relay.sock";

/// Emplacements résolus.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Paths {
    /// `$XDG_DATA_HOME/devmaestro`.
    pub data_dir: PathBuf,
    /// `$XDG_STATE_HOME/devmaestro`.
    pub state_dir: PathBuf,
    /// `$XDG_CONFIG_HOME/devmaestro` (lu seulement, jamais créé par le démon).
    pub config_dir: PathBuf,
    /// `$XDG_RUNTIME_DIR/devmaestro`, à créer en 0700.
    pub runtime_dir: PathBuf,
    /// Dossier personnel (profils Claude Code).
    pub home: PathBuf,
}

impl Paths {
    /// Résout les emplacements depuis l'environnement du processus.
    pub fn from_env() -> Self {
        Self::resolve(|k| env::var_os(k))
    }

    /// Résout les emplacements avec une fonction de lecture des variables
    /// (testable sans toucher à l'environnement).
    pub fn resolve(get: impl Fn(&str) -> Option<OsString>) -> Self {
        let home = get("HOME")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .unwrap_or_else(|| PathBuf::from("/"));
        let xdg = |key: &str, fallback: &str| {
            get(key)
                .map(PathBuf::from)
                .filter(|p| p.is_absolute())
                .unwrap_or_else(|| home.join(fallback))
                .join(APP_DIR)
        };
        let runtime_dir = get("XDG_RUNTIME_DIR")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .map(|p| p.join(APP_DIR))
            .unwrap_or_else(|| {
                let tmp = get("TMPDIR")
                    .map(PathBuf::from)
                    .filter(|p| p.is_absolute())
                    .unwrap_or_else(|| PathBuf::from("/tmp"));
                tmp.join(format!("{APP_DIR}-{}", nix::unistd::getuid()))
            });
        Self {
            data_dir: xdg("XDG_DATA_HOME", ".local/share"),
            state_dir: xdg("XDG_STATE_HOME", ".local/state"),
            config_dir: xdg("XDG_CONFIG_HOME", ".config"),
            runtime_dir,
            home,
        }
    }

    pub fn socket(&self) -> PathBuf {
        self.runtime_dir.join(SOCKET_NAME)
    }

    /// Socket des relais : son chemin est le seul passé aux processus `claude`.
    pub fn relay_socket(&self) -> PathBuf {
        self.runtime_dir.join(RELAY_SOCKET_NAME)
    }

    /// Réglages du démon (`config.toml`).
    pub fn config_file(&self) -> PathBuf {
        self.config_dir.join("config.toml")
    }

    pub fn lock_file(&self) -> PathBuf {
        self.runtime_dir.join("orchd.lock")
    }

    pub fn database(&self) -> PathBuf {
        self.data_dir.join("state.db")
    }

    pub fn log_file(&self) -> PathBuf {
        self.state_dir.join("orchd.log")
    }

    pub fn plugin_dir(&self) -> PathBuf {
        self.data_dir.join("claude-plugin")
    }

    pub fn settings_dir(&self) -> PathBuf {
        self.data_dir.join("settings")
    }

    /// Réglages générés pour un profil.
    pub fn settings_for(&self, profile: &str) -> PathBuf {
        self.settings_dir()
            .join(format!("{}.json", file_safe(profile)))
    }
}

/// Nom de fichier sûr : les caractères hors `[A-Za-z0-9._-]` deviennent `_`.
pub fn file_safe(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect();
    if s.is_empty() || s.starts_with('.') {
        format!("_{s}")
    } else {
        s
    }
}

/// Crée (si besoin) un dossier privé : ses parents sont créés normalement,
/// le dossier lui-même doit être un vrai dossier (pas un lien symbolique),
/// appartenir à l'utilisateur, et reçoit les droits 0700.
///
/// Le dossier est ouvert avec `O_NOFOLLOW` puis vérifié et modifié par son
/// descripteur (`fstat`, `fchmod`) : un lien posé à sa place (repli dans
/// `/tmp`) est refusé, sans course entre la vérification et le `chmod`.
pub fn create_private_dir(path: &Path) -> std::io::Result<()> {
    use nix::fcntl::{OFlag, open};
    use nix::sys::stat::{Mode, fchmod, fstat};
    use std::os::unix::fs::DirBuilderExt;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    match std::fs::DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e),
    }
    let fd = open(
        path,
        OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
        Mode::empty(),
    )
    .map_err(|e| {
        std::io::Error::other(format!(
            "{} n'est pas un dossier (lien symbolique ?) : {e}",
            path.display()
        ))
    })?;
    let st = fstat(&fd).map_err(std::io::Error::from)?;
    if st.st_uid != nix::unistd::getuid().as_raw() {
        return Err(std::io::Error::other(format!(
            "{} appartient à un autre utilisateur",
            path.display()
        )));
    }
    fchmod(&fd, Mode::from_bits_truncate(0o700)).map_err(std::io::Error::from)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn with(vars: &[(&str, &str)]) -> Paths {
        let map: HashMap<String, OsString> = vars
            .iter()
            .map(|(k, v)| ((*k).to_owned(), OsString::from(v)))
            .collect();
        Paths::resolve(|k| map.get(k).cloned())
    }

    #[test]
    fn uses_xdg_variables() {
        let p = with(&[
            ("HOME", "/home/u"),
            ("XDG_DATA_HOME", "/d"),
            ("XDG_STATE_HOME", "/s"),
            ("XDG_RUNTIME_DIR", "/run/user/1000"),
        ]);
        assert_eq!(p.database(), Path::new("/d/devmaestro/state.db"));
        assert_eq!(p.log_file(), Path::new("/s/devmaestro/orchd.log"));
        assert_eq!(
            p.socket(),
            Path::new("/run/user/1000/devmaestro/orchd.sock")
        );
        assert_eq!(
            p.relay_socket(),
            Path::new("/run/user/1000/devmaestro/relay.sock")
        );
        assert_eq!(p.plugin_dir(), Path::new("/d/devmaestro/claude-plugin"));
        assert_eq!(
            p.config_file(),
            Path::new("/home/u/.config/devmaestro/config.toml")
        );
        assert_eq!(
            p.settings_for("work"),
            Path::new("/d/devmaestro/settings/work.json")
        );
    }

    #[test]
    fn falls_back_when_unset_or_relative() {
        let p = with(&[("HOME", "/home/u"), ("XDG_DATA_HOME", "relatif")]);
        assert_eq!(p.data_dir, Path::new("/home/u/.local/share/devmaestro"));
        assert_eq!(p.state_dir, Path::new("/home/u/.local/state/devmaestro"));
        assert!(p.runtime_dir.starts_with("/tmp"));
        assert!(
            p.runtime_dir
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("devmaestro-")
        );
    }

    #[test]
    fn private_dir_is_0700_and_refuses_symlinks() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("a/b");
        create_private_dir(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        create_private_dir(&dir).unwrap();
        let mode = std::fs::metadata(&dir).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
        let target = root.path().join("cible");
        std::fs::create_dir(&target).unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).unwrap();
        let link = root.path().join("lien");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(create_private_dir(&link).is_err());
        // La cible du lien n'a pas été touchée.
        let mode = std::fs::metadata(&target).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o755);
    }

    #[test]
    fn file_safe_names() {
        assert_eq!(file_safe("work"), "work");
        assert_eq!(file_safe("a/b c"), "a_b_c");
        assert_eq!(file_safe(".."), "_..");
        assert_eq!(file_safe(""), "_");
    }
}
