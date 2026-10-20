//! Ports : interfaces implémentées par les adaptateurs.
//!
//! Lot 1 : l'horloge et la découverte des profils et des anciennes sessions.
//! Lot 2 : PTY ([`PtySpawner`]), git ([`Vcs`]) et persistance des sessions
//! ([`SessionStore`]). Les autres ports de l'architecture (§ 16 : `Forge`,
//! `QuotaSource`, `Notifier`) arrivent avec les lots qui en ont besoin.

use std::collections::HashSet;
use std::ffi::OsString;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use time::OffsetDateTime;
use uuid::Uuid;

use crate::domain::{PastSession, Profile, QuotaReading, Subagent};

/// Source de l'heure courante (remplaçable dans les tests).
pub trait Clock {
    fn now(&self) -> OffsetDateTime;
}

/// Découverte des profils Claude Code installés.
pub trait ProfileSource {
    fn profiles(&self) -> io::Result<Vec<Profile>>;
}

/// Découverte des anciennes sessions d'un profil.
pub trait TranscriptSource {
    /// Anciennes sessions, de la plus récente à la plus ancienne, sans celles
    /// de `exclude` (nom du fichier ou `session_id`), au plus `limit` après
    /// cette exclusion.
    fn past_sessions(
        &self,
        profile: &Profile,
        limit: Option<usize>,
        exclude: &HashSet<String>,
    ) -> io::Result<Vec<PastSession>>;

    /// Noms (sans `.jsonl`) de tous les transcripts du profil : de quoi savoir
    /// sans lecture si `--resume <id>` est possible. Peut être mis en cache.
    fn transcript_ids(&self, profile: &Profile) -> Arc<HashSet<String>>;

    /// Un transcript existe-t-il pour ce `session_id` ?
    fn has_transcript(&self, profile: &Profile, session_id: &str) -> bool {
        self.transcript_ids(profile).contains(session_id)
    }

    /// Résumé du transcript de ce `session_id`, s'il existe.
    fn past_session(&self, profile: &Profile, session_id: &str) -> Option<PastSession>;
}

/// Lecture des quotas d'un profil (API d'usage de Claude Code). Bloquant :
/// à appeler hors du runtime asynchrone.
pub trait QuotaSource: Send + Sync {
    /// Erreur : un texte en français, qui ne contient jamais le jeton.
    fn fetch(&self, profile: &Profile, now: OffsetDateTime) -> Result<QuotaReading, String>;
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

/// Échec d'un calcul de diff.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiffError {
    /// Le dossier n'est pas dans un dépôt git (ou git est absent).
    NotARepo,
    /// `git` a échoué ou n'a pas répondu à temps (message en français).
    Failed(String),
}

/// Diff d'un worktree par la CLI `git`. Bloquant : à appeler hors du runtime.
pub trait DiffSource: Send + Sync {
    /// Fichiers changés depuis la base de la branche (commités, non commités
    /// et non suivis), chemins relatifs à la racine du worktree.
    fn changes(&self, cwd: &Path) -> Result<crate::domain::diff::ChangeSet, DiffError>;
    /// Diff d'un fichier de la liste.
    /// Racine du worktree contenant `cwd` ([`DiffError::NotARepo`] hors dépôt).
    fn root(&self, cwd: &Path) -> Result<PathBuf, DiffError>;
    /// Fichiers suivis et non suivis non ignorés du worktree `root`
    /// (`git ls-files --cached --others --exclude-standard`), chemins relatifs
    /// à la racine ; `true` si la liste a été coupée.
    fn repo_files(&self, root: &Path) -> Result<(Vec<String>, bool), DiffError>;
    /// Diff d'un fichier de la liste `changes` (même racine, même base).
    fn file_diff(
        &self,
        changes: &crate::domain::diff::ChangeSet,
        file: &crate::domain::diff::ChangedFile,
    ) -> Result<crate::domain::diff::FileDiff, DiffError>;
}

/// Point de départ d'un nouveau worktree.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorktreeStart<'a> {
    /// Nouvelle branche créée sur ce commit (`git worktree add -b`).
    NewBranch { base: &'a str },
    /// Branche existante, extraite nulle part.
    Existing,
}

/// Worktrees d'un dépôt par la CLI `git` (v0.2, lot 6). Bloquant : à
/// appeler hors du runtime. Ne lance jamais `git fetch`. Les erreurs
/// [`DiffError::Failed`] portent le message de `git`, nettoyé.
pub trait WorktreeGit: Send + Sync {
    /// `git worktree list --porcelain -z` depuis `root` (le principal d'abord).
    fn list(&self, root: &Path) -> Result<Vec<crate::domain::worktree::WorktreeEntry>, DiffError>;
    /// Branche de référence (même résolution que la base du diff, et celle
    /// qui descend de l'autre entre `origin/<défaut>` et `<défaut>`).
    fn reference(&self, root: &Path) -> Option<crate::domain::worktree::Reference>;
    /// Fichiers modifiés ou non suivis non ignorés d'un worktree
    /// (`git status --porcelain=v2 -z`).
    fn status_paths(&self, dir: &Path) -> Result<Vec<String>, DiffError>;
    /// Commits de `branch` absents de la référence (`reference` : référence complète).
    fn ahead(&self, root: &Path, reference: &str, branch: &str) -> Option<u64>;
    /// `git merge-tree --write-tree` est-il disponible (git ≥ 2.38) ? Détecté
    /// une fois, puis gardé.
    fn merge_tree_supported(&self) -> bool;
    /// `branch` est-elle intégrée à la référence ? `None` : inconnu. Sans
    /// `merge-tree --write-tree`, le squash n'est pas évalué.
    fn integrated(
        &self,
        root: &Path,
        reference: &str,
        branch: &str,
    ) -> Option<crate::domain::worktree::Integrated>;
    /// Nom de branche accepté par `git check-ref-format --branch` (message en
    /// français sinon).
    fn check_branch_name(&self, root: &Path, name: &str) -> Result<(), String>;
    /// `refs/heads/<name>` existe-t-elle ?
    fn branch_exists(&self, root: &Path, name: &str) -> bool;
    /// Commit désigné par une révision, s'il existe.
    fn resolve_commit(&self, root: &Path, rev: &str) -> Option<String>;
    /// `git worktree add` (sans hooks).
    fn add(
        &self,
        root: &Path,
        path: &Path,
        branch: &str,
        start: WorktreeStart<'_>,
    ) -> Result<(), DiffError>;
    /// `git worktree remove [--force [--force]] <path>` (double `--force`
    /// pour un worktree verrouillé).
    fn remove(&self, root: &Path, path: &Path, force: bool, locked: bool) -> Result<(), DiffError>;
    /// `git branch -d` (ou `-D` avec `force`).
    fn delete_branch(&self, root: &Path, branch: &str, force: bool) -> Result<(), DiffError>;
    /// Ajoute `.worktrees/` à `<common_dir>/info/exclude` s'il n'est pas déjà
    /// ignoré ; `true` si le fichier a été modifié.
    fn exclude_in_repo_dir(&self, root: &Path, common_dir: &Path) -> Result<bool, DiffError>;
}

/// Worktree créé par le démon, enregistré en base (schéma v6).
#[derive(Debug, Clone, PartialEq)]
pub struct WorktreeRecord {
    pub path: PathBuf,
    /// Dossier commun du dépôt (identité du projet).
    pub common_dir: PathBuf,
    /// Worktree principal du projet.
    pub project_root: PathBuf,
    pub branch: String,
    /// Base demandée (ou référence par défaut) ; `None` pour une branche existante.
    pub base: Option<String>,
    /// La branche a été créée avec le worktree.
    pub created_branch: bool,
    /// Commit de départ du worktree (tête au moment de la création) : une
    /// tête encore égale vaut `integrated: "empty"`.
    pub start_sha: Option<String>,
    pub created_at: OffsetDateTime,
}

/// Échec d'un accès au dossier d'une session (onglet Fichiers).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileError {
    NotFound,
    /// Le chemin sort de la racine, passe par un lien refusé ou par `.git`.
    Outside(String),
    /// Pas un fichier ordinaire (dossier, FIFO, périphérique, socket).
    NotRegular,
    /// Pas un dossier.
    NotDir,
    Io(String),
}

/// Une entrée telle que lue sur le disque (sans suivre de lien).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawEntry {
    pub name: String,
    pub kind: crate::domain::files::EntryKind,
    /// Taille d'un fichier ordinaire.
    pub size: Option<u64>,
    /// Date de modification (renseignée par `lstat`).
    pub modified: Option<std::time::SystemTime>,
}

/// Un fichier lu.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadFile {
    pub size: u64,
    /// Contenu, `None` s'il dépasse la limite (rien n'est alors lu).
    pub bytes: Option<Vec<u8>>,
    /// Chemin réel relatif à la racine (liens suivis).
    pub resolved: String,
}

/// Accès en lecture au dossier d'une session, confiné à sa racine
/// (`root` : chemin absolu résolu). Bloquant.
pub trait FileAccess: Send + Sync {
    /// Lit un fichier ordinaire sous la racine (liens suivis s'ils y restent),
    /// au plus `max` octets.
    fn read_beneath(&self, root: &Path, rel: &str, max: u64) -> Result<ReadFile, FileError>;
    /// `rel` est un vrai dossier sous la racine, sans lien sur le chemin.
    fn check_dir(&self, root: &Path, rel: &str) -> Result<(), FileError>;
    /// Genre et taille d'une entrée, sans suivre de lien ; `None` si absente.
    fn lstat(&self, root: &Path, rel: &str) -> Option<RawEntry>;
    /// Contenu d'un dossier (sans `.git`, sans FIFO ni périphérique), sans
    /// suivre de lien et sans taille (voir [`FileAccess::lstat`]) ; `true` si
    /// la lecture a été coupée.
    fn list_dir(&self, root: &Path, rel: &str) -> Result<(Vec<RawEntry>, bool), FileError>;
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
    /// Titre donné par l'utilisateur (schéma v3).
    pub title: Option<String>,
    /// Couleur choisie par l'utilisateur (schéma v3).
    pub color: Option<String>,
    /// Premier prompt tapé, tronqué (schéma v3).
    pub first_prompt: Option<String>,
    /// Dernier `session_name` de la statusline (schéma v3).
    pub session_name: Option<String>,
    /// Dossier commun git du projet (identité du projet), relevé au lancement
    /// (schéma v6) ; `None` hors dépôt ou pas encore relevé.
    pub project_common_dir: Option<PathBuf>,
}

/// Persistance des sessions.
pub trait SessionStore: Send {
    fn upsert(&self, record: &SessionRecord) -> io::Result<()>;
    /// Toutes les sessions, de la plus récente à la plus ancienne (`updated_at`).
    fn load_all(&self) -> io::Result<Vec<SessionRecord>>;
    /// Retire une session (`sessions.forget`) et ses sous-agents ; absente :
    /// rien à faire.
    fn delete(&self, id: &Uuid) -> io::Result<()>;
    /// Écrit (ou remplace) ces sous-agents de la session `session`, puis
    /// ramène la session à [`crate::domain::subagents::MAX_SUBAGENTS`]
    /// sous-agents en base avec la même règle qu'en mémoire : les plus anciens
    /// finis d'abord (ordre de lancement), jamais un `running`.
    /// `background`, `notified` et `guessed_link` ne sont pas gardés.
    fn upsert_subagents(&self, session: &Uuid, agents: &[Subagent]) -> io::Result<()>;
    /// Sous-agents d'une session, dans l'ordre de lancement.
    fn load_subagents(&self, session: &Uuid) -> io::Result<Vec<Subagent>>;
    /// Retire ces sous-agents de la session (oubliés en mémoire : plafond).
    fn delete_subagents(&self, session: &Uuid, agent_ids: &[String]) -> io::Result<()>;
    /// Masque un transcript de `transcripts.list` (déjà masqué : rien à faire).
    fn hide_transcript(
        &self,
        profile: &str,
        claude_session_id: &str,
        at: OffsetDateTime,
    ) -> io::Result<()>;
    /// Démasque un transcript ; `false` s'il n'était pas masqué.
    fn unhide_transcript(&self, profile: &str, claude_session_id: &str) -> io::Result<bool>;
    /// `claude_session_id` masqués d'un profil.
    fn hidden_transcripts(&self, profile: &str) -> io::Result<HashSet<String>>;
    /// Enregistre (ou remplace) un worktree créé par le démon.
    fn record_worktree(&self, w: &WorktreeRecord) -> io::Result<()>;
    /// Oublie un worktree (supprimé, ou création annulée) ; absent : rien à faire.
    fn delete_worktree(&self, path: &Path) -> io::Result<()>;
    /// Worktrees créés par le démon.
    fn load_worktrees(&self) -> io::Result<Vec<WorktreeRecord>>;
}
