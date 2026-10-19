//! Ports : interfaces implémentées par les adaptateurs.
//!
//! Lot 1 : l'horloge et la découverte des profils et des anciennes sessions.
//! Lot 2 : PTY ([`PtySpawner`]), git ([`Vcs`]) et persistance des sessions
//! ([`SessionStore`]). Les autres ports de l'architecture (§ 16 : `Forge`,
//! `QuotaSource`, `Notifier`) arrivent avec les lots qui en ont besoin.

use std::ffi::OsString;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use time::OffsetDateTime;
use uuid::Uuid;

use crate::domain::{PastSession, Profile};

/// Source de l'heure courante (remplaçable dans les tests).
pub trait Clock {
    fn now(&self) -> OffsetDateTime;
}

/// Découverte des profils Claude Code installés.
pub trait ProfileSource {
    fn profiles(&self) -> io::Result<Vec<Profile>>;
}

/// Découverte des anciennes sessions d'un profil, de la plus récente à la
/// plus ancienne, au plus `limit` si elle est donnée.
pub trait TranscriptSource {
    fn past_sessions(
        &self,
        profile: &Profile,
        limit: Option<usize>,
    ) -> io::Result<Vec<PastSession>>;
}

/// Commande à lancer dans un PTY.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandLine {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub cwd: PathBuf,
    /// Variables à poser (remplacent l'héritage).
    pub env: Vec<(String, OsString)>,
    /// Variables héritées à retirer.
    pub env_remove: Vec<String>,
}

/// Taille d'un terminal, en caractères.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TermSize {
    pub cols: u16,
    pub rows: u16,
}

/// Fin d'un processus.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExitStatus {
    Code(i32),
    Signal(String),
}

/// Contrôle d'un PTY ouvert.
pub trait PtyControl: Send + Sync {
    fn resize(&self, size: TermSize) -> io::Result<()>;
}

/// Processus lancé dans un PTY.
pub trait PtyChild: Send {
    /// Identifiant du processus, chef de son groupe (et de sa session).
    fn pid(&self) -> Option<u32>;
    /// Attend la fin du processus (bloquant).
    fn wait(&mut self) -> io::Result<ExitStatus>;
}

/// Un processus lancé dans un PTY, avec ses flux (bloquants).
pub struct SpawnedPty {
    pub reader: Box<dyn Read + Send>,
    pub writer: Box<dyn Write + Send>,
    pub control: Box<dyn PtyControl>,
    pub child: Box<dyn PtyChild>,
}

/// Lancement de processus dans un PTY.
pub trait PtySpawner: Send + Sync {
    fn spawn(&self, command: &CommandLine, size: TermSize) -> io::Result<SpawnedPty>;
}

/// Dépôt git contenant un dossier.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoInfo {
    /// Racine du worktree (`git rev-parse --show-toplevel`).
    pub worktree_root: PathBuf,
    /// Dossier commun (`git rev-parse --git-common-dir`, absolu) : identifie le projet.
    pub common_dir: PathBuf,
    /// Racine du projet : le worktree principal (parent du dossier commun
    /// quand il s'appelle `.git`), sinon la racine du worktree.
    pub project_root: PathBuf,
    /// Branche courante, absente en HEAD détachée.
    pub branch: Option<String>,
}

/// Accès à git.
pub trait Vcs: Send + Sync {
    /// Dépôt contenant `path`, ou `None` si ce n'est pas un dépôt (ou si git
    /// est absent).
    fn resolve(&self, path: &Path) -> Option<RepoInfo>;
}

/// Une session telle qu'enregistrée en base.
#[derive(Debug, Clone, PartialEq)]
pub struct SessionRecord {
    pub id: Uuid,
    pub claude_session_id: String,
    pub profile: String,
    pub cwd: PathBuf,
    pub project_root: PathBuf,
    pub branch: Option<String>,
    pub model: Option<String>,
    /// Mode de permission, tel qu'écrit par les hooks (`default`, `plan`…).
    pub mode: Option<String>,
    /// `starting`, `running`, `waiting`, `idle`, `error` ou `stopped`.
    pub status: String,
    /// Raison de l'arrêt, pour `stopped`.
    pub status_reason: Option<String>,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
    pub last_activity: Option<OffsetDateTime>,
    pub pid: Option<u32>,
    /// Date de démarrage du processus `pid` (`/proc/<pid>/stat`).
    pub pid_start: Option<u64>,
    /// Scope systemd de la session (`devmaestro-session-….scope`), s'il y en a un.
    pub scope_unit: Option<String>,
}

/// Persistance des sessions.
pub trait SessionStore: Send {
    fn upsert(&self, record: &SessionRecord) -> io::Result<()>;
    /// Toutes les sessions, de la plus récente à la plus ancienne (`updated_at`).
    fn load_all(&self) -> io::Result<Vec<SessionRecord>>;
}
