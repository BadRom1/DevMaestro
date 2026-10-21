//! Superviseur des sessions : registre, lancement et reprise dans des PTY,
//! rattachement des hooks et de la statusline par jeton, persistance,
//! diffusion des changements.
//!
//! Le registre est protégé par un verrou ordinaire : aucune opération ne
//! l'attend en `await`, et les opérations bloquantes du PTY (lecture,
//! écriture, attente du processus) tournent dans des fils dédiés.

use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use time::OffsetDateTime;
use tokio::sync::{broadcast, mpsc, oneshot};
use uuid::Uuid;

mod commits;
mod conversation;
pub mod forge;
mod subagents;
mod worktrees;

use super::claude_config;
use super::launch::{self, LaunchKind, LaunchSpec, ScopeSpec};
use super::log::{error, info, warning};
use super::peer::{self, Peer, Supervised, SupervisedProc};
use super::terminal::{Chunk, RESUME_RESET, Snapshot, Terminal};
use crate::domain::decision::{self, AnswerError, PermissionAnswer};
use crate::domain::{
    Effect, HookEvent, HookKind, PastSession, PermissionMode, ProcessExit, Profile,
    REASON_DAEMON_RESTART, RequestId, SESSION_COLORS, Session, SessionState, SessionStatus,
    Statusline, SubagentChange, WaitKind, is_session_color, mode_from_footer, normalize_title,
    shift_tab_steps,
};
use crate::paths::Paths;
use crate::ports::{
    Clock, ExitStatus, ProfileSource, PtyControl, PtySpawner, SessionRecord, SessionStore,
    TermSize, TranscriptSource, Vcs,
};
use crate::protocol::error_code;
use crate::protocol::json::{
    activity_json, effect_json, metrics_json, past_session_json, pending_request_json,
    profile_json, status_json, time_json,
};

/// Taille par défaut d'un terminal quand le client n'en donne pas.
pub const DEFAULT_SIZE: TermSize = TermSize { cols: 80, rows: 24 };
/// Morceaux d'entrée clavier en attente d'écriture dans un PTY. Au-delà,
/// l'envoi attend (contre-pression sur le seul client qui écrit).
const INPUT_QUEUE: usize = 256;
/// Événements gardés pour un client lent (petits : un identifiant ou un effet).
const EVENTS_CAPACITY: usize = 1024;
/// Délai maximal entre deux écritures en base d'une session qui ne change
/// que par sa date de dernière activité.
const PERSIST_INTERVAL: Duration = Duration::from_secs(30);

/// Modes acceptés par `sessions.launch` / `sessions.resume`.
pub const MODES: &[&str] = &[
    "default",
    "manual",
    "acceptEdits",
    "plan",
    "auto",
    "dontAsk",
    "bypassPermissions",
];

/// Erreur renvoyée à un client JSON-RPC.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    /// Détails structurés (champ `data` de l'erreur JSON-RPC), s'il y en a.
    pub data: Option<Value>,
}

impl RpcError {
    pub fn new(code: i64, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }
    pub fn with_data(mut self, data: Value) -> Self {
        self.data = Some(data);
        self
    }
    pub fn params(message: impl Into<String>) -> Self {
        Self::new(error_code::INVALID_PARAMS, message)
    }
    fn unknown_session(id: &Uuid) -> Self {
        Self::new(
            error_code::UNKNOWN_SESSION,
            format!("session inconnue : {id}"),
        )
    }
    fn launch(message: impl Into<String>) -> Self {
        Self::new(error_code::LAUNCH_FAILED, message)
    }
    fn cwd_missing(cwd: &Path) -> Self {
        Self::new(
            error_code::CWD_MISSING,
            format!(
                "Le dossier de la session n'existe plus (worktree supprimé ?) : {}",
                cwd.display()
            ),
        )
    }
    fn unknown_request(id: RequestId) -> Self {
        Self::new(
            error_code::UNKNOWN_REQUEST,
            format!("demande {} inconnue ou déjà close", id.0),
        )
    }
    fn not_answerable(id: RequestId) -> Self {
        Self::new(
            error_code::NOT_ANSWERABLE,
            format!(
                "demande {} : aucun relais n'attend de décision, répondre dans le terminal",
                id.0
            ),
        )
    }
}

impl From<AnswerError> for RpcError {
    fn from(e: AnswerError) -> Self {
        let code = match &e {
            AnswerError::WrongKind { .. } => error_code::WRONG_REQUEST_KIND,
            AnswerError::Undetailed => error_code::NOT_ANSWERABLE,
            AnswerError::NoSuggestions => error_code::NO_SUGGESTIONS,
            AnswerError::InvalidAnswers(_) => error_code::INVALID_PARAMS,
        };
        Self::new(code, e.to_string())
    }
}

/// Décision transmise à un relais `PermissionRequest` : le JSON à écrire sur
/// la sortie du hook, ou `None` (libéré sans décision).
pub type Decision = Option<Vec<u8>>;

/// Relais `PermissionRequest` rattaché à une demande : la connexion attend
/// sur `decision`, et se détache avec [`Daemon::detach_waiter`] si le relais
/// s'en va.
pub struct PermissionWait {
    pub session: Uuid,
    pub request: RequestId,
    pub waiter: u64,
    pub decision: oneshot::Receiver<Decision>,
}

/// Pour `sessions.setMode` : file d'entrée du PTY, octets à y écrire, et
/// nombre de Shift+Tab qu'ils contiennent.
pub type ModeKeys = (mpsc::Sender<Vec<u8>>, Vec<u8>, usize);

/// Échec de `sessions.setMode`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SetModeError {
    /// Un `setMode` précédent attend encore sa confirmation (hook ou pied de
    /// la TUI) : l'appelant peut réessayer un peu plus tard.
    Unconfirmed(RpcError),
    /// Toute autre erreur, définitive.
    Rpc(RpcError),
}

impl SetModeError {
    pub fn into_rpc(self) -> RpcError {
        match self {
            Self::Unconfirmed(e) | Self::Rpc(e) => e,
        }
    }
}

impl From<RpcError> for SetModeError {
    fn from(e: RpcError) -> Self {
        Self::Rpc(e)
    }
}

/// Lignes non vides du bas de l'écran lues pour trouver le pied de la TUI.
const FOOTER_ROWS: usize = 8;

/// Séquence envoyée par Shift+Tab (CSI Z, « back tab »).
pub const SHIFT_TAB: &[u8] = b"\x1b[Z";

/// Réglages du démon.
#[derive(Debug, Clone)]
pub struct Config {
    pub paths: Paths,
    /// Chemin absolu du binaire `orchd` (appelé par les hooks et la statusline).
    pub orchd_exe: PathBuf,
    /// `DEVMAESTRO_CLAUDE_BIN`, lue au démarrage.
    pub claude_bin_env: Option<OsString>,
    /// `PATH`, lu au démarrage.
    pub path_env: Option<OsString>,
    /// Délai laissé à un `SessionEnd` en retard après la sortie du processus.
    pub exit_grace: Duration,
    /// Délai entre `SIGHUP` et `SIGKILL` pour arrêter une session.
    pub stop_timeout: Duration,
    /// `timeout` du hook `PermissionRequest` écrit dans `hooks.json`, en
    /// secondes (600 par défaut ; `DEVMAESTRO_PERMISSION_TIMEOUT_SECS` le
    /// réduit pour les tests). Le relais attend un peu moins.
    pub permission_timeout_secs: u64,
    /// `allow_dangerous_modes` de `config.toml`, lu **au démarrage** du démon
    /// (un changement demande de redémarrer le démon).
    pub allow_dangerous_modes: bool,
    /// `[quotas] usage_api` de `config.toml` (vrai par défaut) : interroger
    /// l'API d'usage de Claude Code.
    pub usage_api: bool,
    /// Intervalle minimal entre deux appels à l'API d'usage pour un profil
    /// ([`QUOTA_MIN_INTERVAL`] ; plus court dans les tests).
    pub quota_min_interval: Duration,
    /// `systemd-run`, si un gestionnaire systemd utilisateur répond au
    /// démarrage : chaque session est alors lancée dans son propre scope.
    pub systemd_run: Option<PathBuf>,
    /// `DEVMAESTRO_SYSTEMD_RUNTIME_DIR` : `XDG_RUNTIME_DIR` à donner à
    /// `systemd-run` (tests, dont le dossier runtime est temporaire).
    pub systemd_runtime_dir: Option<OsString>,
    /// Délai laissé au prompt initial de `sessions.launch` (`initial`) pour
    /// partir ([`forge::INITIAL_PROMPT_TIMEOUT`] ; plus court dans les tests).
    pub initial_prompt_timeout: Duration,
}

/// Adaptateurs utilisés par le démon.
pub struct Deps {
    pub pty: Box<dyn PtySpawner>,
    pub vcs: Box<dyn Vcs>,
    pub profiles: Box<dyn ProfileSource + Send + Sync>,
    pub transcripts: Box<dyn TranscriptSource + Send + Sync>,
    pub store: Box<dyn SessionStore + Sync>,
    pub clock: Box<dyn Clock + Send + Sync>,
    pub quotas: Box<dyn crate::ports::QuotaSource>,
    pub diff: Box<dyn crate::ports::DiffSource>,
    pub files: Box<dyn crate::ports::FileAccess>,
    pub worktrees: Box<dyn crate::ports::WorktreeGit>,
    /// Suivi en direct des transcripts (vue conversation).
    pub follower: Box<dyn crate::ports::TranscriptFollower>,
    /// Forge des dépôts (lot 13a, ADR 0006).
    pub forge: Box<dyn crate::ports::Forge>,
}

/// Événement diffusé aux connexions. Léger : une connexion lente regroupe
/// les `Updated` d'une même session et relit l'état au moment d'envoyer.
#[derive(Debug, Clone)]
pub enum Event {
    /// La session a changé (`session.updated`).
    Updated(Uuid),
    /// Effet de la machine à états (`session.effect`).
    Effect { id: Uuid, effect: Arc<Value> },
    /// La session a été retirée (`session.removed`, `sessions.forget`).
    Removed(Uuid),
    /// Les quotas ont changé (`quotas.updated`, relu au moment d'envoyer).
    Quotas,
    /// Le diff d'une session a changé (`session.diff_changed`).
    DiffChanged(Uuid),
    /// Les sous-agents d'une session ont changé (`session.subagents_changed`,
    /// liste relue au moment d'envoyer).
    SubagentsChanged(Uuid),
    /// Les worktrees d'un projet ont changé (`project.worktrees_changed`,
    /// racine du projet).
    WorktreesChanged(PathBuf),
    /// La conversation d'une session a changé (`conversation.changed`,
    /// calculée par connexion depuis sa révision au moment d'envoyer).
    ConversationChanged(Uuid),
}

/// Anti-rebond du recalcul du diff d'une session.
pub const DIFF_DEBOUNCE: Duration = Duration::from_millis(500);
/// Recalcul du diff des sessions qui tournent.
pub const DIFF_POLL_INTERVAL: Duration = Duration::from_secs(5);

/// Suivi du diff d'une session pour `session.diff_changed`.
#[derive(Debug, Default)]
struct DiffWatch {
    /// Empreinte de référence des notifications : la dernière notifiée (ou
    /// le premier calcul). Un `sessions.diff` ne la remplace pas : chaque
    /// client est prévenu de tout changement, quel que soit qui a lu le diff.
    notified: Option<String>,
    /// Dernière liste calculée, et quand (réutilisée moins de [`DIFF_REUSE`]).
    last: Option<(Arc<crate::domain::diff::ChangeSet>, Instant)>,
    /// Un recalcul est déjà prévu.
    pending: bool,
    /// Un recalcul est en cours.
    in_flight: bool,
    /// Un hook est arrivé pendant le recalcul : en refaire un ensuite.
    dirty: bool,
    /// Dernier historique calculé (v0.3, lot 9), et quand : un sha est
    /// validé dessus s'il a moins de [`DIFF_REUSE`].
    commits: Option<(Arc<crate::domain::commits::CommitLog>, Instant)>,
    /// Plage demandée par le dernier `sessions.commits` (`None` :
    /// automatique) : un recalcul de validation liste la même.
    commits_range: Option<crate::domain::commits::CommitRange>,
    /// Compteurs abandonnés (trop lents) : pas de nouvel essai avant cette date.
    slow_stats_until: Option<Instant>,
    /// Fichiers des derniers commits relus, par sha (bornés).
    commit_changes: HashMap<String, Arc<crate::domain::diff::ChangeSet>>,
}

/// Verrou des écritures dans le PTY d'une session.
pub type PtyLock = Arc<tokio::sync::Mutex<()>>;

/// Revue prête à envoyer.
#[derive(Debug)]
pub struct ReviewToSend {
    pub id: Uuid,
    /// File d'entrée du PTY de la session.
    pub input: mpsc::Sender<Vec<u8>>,
    /// Verrou des écritures dans ce PTY.
    pub lock: PtyLock,
    /// Consigne à taper.
    pub instruction: &'static str,
    /// Texte à coller (au plus [`crate::domain::diff::MAX_REVIEW_BYTES`]).
    pub text: String,
}

/// Prompt prêt à écrire (`sessions.sendPrompt`).
#[derive(Debug)]
pub struct PromptToSend {
    pub id: Uuid,
    pub input: mpsc::Sender<Vec<u8>>,
    pub lock: PtyLock,
    /// Texte nettoyé (caractères de contrôle retirés sauf `\n` et `\t`,
    /// fins de ligne `\r\n` / `\r` ramenées à `\n`, blancs de bord retirés).
    pub text: String,
    /// Collé en *bracketed paste* (multiligne, tabulation, `\` final, ou long) ;
    /// sinon tapé.
    pub paste: bool,
}

/// Taille maximale d'un prompt envoyé (256 Kio).
pub const MAX_PROMPT_BYTES: usize = 256 * 1024;
/// Un prompt d'une ligne de moins de ce nombre de caractères est tapé.
pub const TYPED_PROMPT_CHARS: usize = 2000;

/// Prompt nettoyé : fins de ligne normalisées, caractères de contrôle
/// retirés (sauf saut de ligne et tabulation), blancs de bord retirés.
pub fn clean_prompt(raw: &str) -> String {
    let normalized = raw.replace("\r\n", "\n").replace('\r', "\n");
    let kept: String = normalized
        .chars()
        .filter(|c| *c == '\n' || *c == '\t' || !c.is_control())
        .collect();
    kept.trim().to_owned()
}

/// Âge maximal de la liste réutilisée par `sessions.diffFile` et
/// `sessions.sendReview` pour valider un chemin.
pub const DIFF_REUSE: Duration = Duration::from_secs(2);

/// Erreur de diff → erreur du protocole.
fn diff_error(e: crate::ports::DiffError) -> RpcError {
    match e {
        crate::ports::DiffError::NotARepo => RpcError::new(
            error_code::NOT_A_REPO,
            "la session n'est pas dans un dépôt git",
        ),
        crate::ports::DiffError::Failed(m) => RpcError::new(error_code::INTERNAL_ERROR, m),
    }
}

fn changeset_json(c: &crate::domain::diff::ChangeSet) -> Value {
    json!({
        "base": {"ref": c.base.reference, "sha": c.base.sha, "kind": c.base.kind.as_str()},
        "truncated": c.truncated,
        "skipped_non_utf8": c.skipped_non_utf8,
        "files": c.files.iter().map(|f| {
            let mut v = json!({
                "path": f.path,
                "status": f.status.as_str(),
                "additions": f.additions,
                "deletions": f.deletions,
                "binary": f.binary,
            });
            if let Some(old) = &f.old_path {
                v["old_path"] = json!(old);
            }
            v
        }).collect::<Vec<_>>(),
    })
}

fn file_diff_json(d: &crate::domain::diff::FileDiff) -> Value {
    json!({
        "hunks": d.hunks.iter().map(|h| json!({
            "header": h.header,
            "old_start": h.old_start,
            "old_lines": h.old_lines,
            "new_start": h.new_start,
            "new_lines": h.new_lines,
            "lines": h.lines.iter().map(|l| json!({
                "kind": l.kind.to_string(),
                "old_no": l.old_no,
                "new_no": l.new_no,
                "text": l.text,
            })).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
        "binary": d.binary,
        "too_large": d.too_large,
    })
}

/// Intervalle entre deux lectures de l'API d'usage.
pub const QUOTA_POLL_INTERVAL: Duration = Duration::from_secs(5 * 60);
/// Intervalle minimal entre deux appels à l'API d'usage pour un même profil.
pub const QUOTA_MIN_INTERVAL: Duration = Duration::from_secs(10);
/// Durée maximale d'une tournée de lecture des quotas (tous profils).
pub const QUOTA_REFRESH_BUDGET: Duration = Duration::from_secs(15);

/// Sessions retirées gardées en mémoire pour les clients qui ont pris du
/// retard (leur file est reconstruite, voir [`Daemon::removed_ids`]).
const REMOVED_KEPT: usize = 1024;

/// Un processus `claude` en cours.
struct Run {
    id: u64,
    pid: Option<u32>,
    control: Box<dyn PtyControl>,
    input: mpsc::Sender<Vec<u8>>,
    stop_requested: bool,
    /// Identité du processus (date de démarrage, scope systemd).
    proc: SupervisedProc,
    /// Code de sortie, posé par le fil d'attente dès la fin du processus
    /// (avant que le démon ne la constate).
    exited: Arc<Mutex<Option<ExitStatus>>>,
    /// Posé quand un hook change le mode : le lecteur du PTY oublie le
    /// dernier pied vu et le signale de nouveau à la prochaine sortie.
    footer_reset: Arc<AtomicBool>,
}

impl Run {
    fn exit_status(&self) -> Option<ExitStatus> {
        self.exited
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
}

/// Une session du registre.
struct Entry {
    session: Session,
    /// Modèle demandé au lancement (`--model`).
    model: Option<String>,
    created_at: OffsetDateTime,
    updated_at: OffsetDateTime,
    terminal: Arc<Terminal>,
    run: Option<Run>,
    /// Jeton du processus courant (`ORCH_TOKEN`).
    token: Option<String>,
    last_exit: Option<ExitStatus>,
    /// Dernier enregistrement écrit en base, et quand.
    persisted: Option<(SessionRecord, Instant)>,
    /// Relais `PermissionRequest` qui attendent une décision, par demande
    /// (plusieurs si Claude Code relance le même hook).
    waiters: HashMap<RequestId, Vec<(u64, oneshot::Sender<Decision>)>>,
    /// Processus `claude` d'avant un plantage du démon, relu en base, dont des
    /// processus vivent encore : gardé en base tant qu'il est supervisé.
    orphan: Option<(u32, SupervisedProc)>,
    /// `sessions.setMode` envoyé, pas encore confirmé par un hook : mode visé
    /// et date de l'envoi.
    mode_change: Option<(PermissionMode, Instant)>,
    /// Dernier mode retenu depuis le pied de la TUI, et quand.
    screen_mode: Option<(PermissionMode, Instant)>,
    /// Un transcript existe pour `claude_session_id` (`--resume` possible) ;
    /// relu à la fin du processus, à la relecture de la base et sur
    /// `sessions.list`.
    has_transcript: bool,
    /// Le dossier de travail existe (faux : worktree supprimé…) ; relu en même
    /// temps que `has_transcript`.
    cwd_exists: bool,
    /// Verrou des écritures dans le PTY (revue, Shift+Tab, clavier).
    pty_lock: Arc<tokio::sync::Mutex<()>>,
    /// Empreinte de chaque sous-agent tel qu'écrit en base pour la dernière
    /// fois ([`crate::domain::Subagent::fingerprint`]).
    subagents_persisted: HashMap<String, u64>,
}

/// Délai au bout duquel un `sessions.setMode` non confirmé n'empêche plus
/// le suivant.
pub const MODE_CHANGE_TIMEOUT: Duration = Duration::from_secs(3);

/// Un hook qui contredit le pied de la TUI lu il y a moins que ce délai est
/// peut-être en retard (émis avant le changement) : le pied est relu.
const STALE_HOOK_WINDOW: Duration = Duration::from_secs(3);

/// Délai avant de relire le pied après un hook qui le contredit (le temps
/// que la TUI redessine).
const FOOTER_RECHECK_DELAY: Duration = Duration::from_millis(200);

#[derive(Default)]
struct Registry {
    sessions: HashMap<Uuid, Entry>,
    by_token: Vec<(String, Uuid)>,
}

impl Registry {
    /// Session d'un jeton, comparé en temps constant.
    fn session_of(&self, token: &str) -> Option<Uuid> {
        let mut found = None;
        for (t, id) in &self.by_token {
            if ct_eq(t.as_bytes(), token.as_bytes()) {
                found = Some(*id);
            }
        }
        found
    }

    fn forget_token(&mut self, token: &str) {
        self.by_token.retain(|(t, _)| t != token);
    }
}

/// Égalité en temps constant (pour une même longueur).
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Le démon.
pub struct Daemon {
    config: Config,
    deps: Deps,
    registry: Mutex<Registry>,
    events: broadcast::Sender<Event>,
    runtime: tokio::runtime::Handle,
    next_run: AtomicU64,
    next_waiter: AtomicU64,
    shutting_down: AtomicBool,
    /// Processus `claude` lancés depuis le démarrage (pid = pgid = sid,
    /// `setsid`) : leurs descendants n'ont pas accès au socket de contrôle.
    /// Associe à chaque pid sa date de démarrage (`/proc/<pid>/stat`), pour
    /// ne jamais confondre avec un pid réattribué.
    supervised: Mutex<Supervised>,
    /// Le démon lui-même, pour les tâches lancées depuis `&self`.
    me: std::sync::Weak<Daemon>,
    /// Dernières sessions retirées (au plus [`REMOVED_KEPT`]).
    removed: Mutex<std::collections::VecDeque<Uuid>>,
    /// Quotas par profil, et dernier JSON diffusé (`quotas.updated`).
    quotas: Mutex<(
        std::collections::BTreeMap<String, crate::domain::ProfileQuotas>,
        Option<Value>,
    )>,
    /// Dernier appel à l'API d'usage par profil ([`QUOTA_MIN_INTERVAL`]).
    quota_calls: Mutex<HashMap<String, Instant>>,
    /// Une tournée de lecture des quotas est en cours.
    quota_refreshing: AtomicBool,
    /// Suivi du diff des sessions (`session.diff_changed`).
    diff_watch: Mutex<HashMap<Uuid, DiffWatch>>,
    /// Fichiers des dépôts par session (onglet Fichiers).
    files_cache: Mutex<HashMap<Uuid, FilesCacheEntry>>,
    /// Limitation des `session.subagents_changed` dus aux compteurs d'outils.
    subagent_notify: Mutex<HashMap<Uuid, subagents::NotifyState>>,
    /// Un seul `git ls-files` à la fois par session.
    files_inflight: Mutex<HashMap<Uuid, Arc<Mutex<()>>>>,
    /// Suivi des worktrees par projet (dossier commun), pour
    /// `project.worktrees_changed`.
    worktree_watch: Mutex<HashMap<PathBuf, worktrees::WorktreeWatch>>,
    /// Verrou des créations et suppressions de worktrees, par dossier commun.
    repo_locks: Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>,
    /// Worktrees en cours de suppression : aucun lancement ni reprise dedans.
    removing: Mutex<std::collections::HashSet<PathBuf>>,
    /// Conversations suivies (vue conversation), chacune sous son verrou.
    conversations: Mutex<HashMap<Uuid, Arc<Mutex<conversation::ConvState>>>>,
    /// Actions déposées par les hooks pour la pompe des conversations.
    conv_actions: Mutex<HashMap<Uuid, Vec<conversation::ConvAction>>>,
    /// Réveil de la pompe des conversations.
    conv_wake: tokio::sync::Notify,
    /// Plus grande révision d'une conversation oubliée.
    conv_rev_floor: AtomicU64,
    /// Réponses récentes de la forge (60 s).
    forge_cache: Mutex<forge::ForgeCache>,
}

/// Liste des fichiers d'un dépôt, quand, pour quelle empreinte du diff et
/// quelle racine.
type FilesCacheEntry = (Arc<(Vec<String>, bool)>, Instant, Option<String>, PathBuf);

/// Âge maximal de la liste des fichiers d'un dépôt gardée en cache.
pub const FILES_CACHE_TTL: Duration = Duration::from_secs(3);

/// Erreur d'accès à un fichier → erreur du protocole (`-32602`).
fn file_error(e: crate::ports::FileError, rel: &str) -> RpcError {
    use crate::ports::FileError;
    let shown = if rel.is_empty() { "." } else { rel };
    match e {
        FileError::NotFound => RpcError::params(format!("« {shown} » introuvable")),
        FileError::Outside(why) => RpcError::params(format!("« {shown} » refusé : {why}")),
        FileError::NotRegular => RpcError::params(format!(
            "« {shown} » n'est pas un fichier ordinaire (dossier, FIFO, périphérique…)"
        )),
        FileError::NotDir => RpcError::params(format!("« {shown} » n'est pas un dossier")),
        FileError::Denied => RpcError::params(format!("« {shown} » : accès refusé")),
        FileError::Refused(why) => {
            RpcError::params(format!("« {shown} » : modification refusée : {why}"))
        }
        FileError::Conflict(version) => RpcError::new(
            error_code::FILE_CONFLICT,
            "le fichier a été modifié depuis son ouverture",
        )
        .with_data(json!({"version": version.as_ref().map(file_version_json)})),
        FileError::Io(m) => RpcError::new(error_code::INTERNAL_ERROR, m),
    }
}

/// `{size, mtime_ns, sha256}` d'une version de fichier.
fn file_version_json(v: &crate::domain::files::FileVersion) -> Value {
    json!({"size": v.size, "mtime_ns": v.mtime_ns, "sha256": v.sha256})
}

/// Instantané, historique éventuel, flux de sortie et terminal d'une session.
pub type Subscription = (
    Snapshot,
    Option<Vec<u8>>,
    broadcast::Receiver<Chunk>,
    Arc<Terminal>,
);

/// Lancement ou reprise entièrement validé : rien n'a encore changé.
struct Plan {
    claude: PathBuf,
    kind: LaunchKind,
    profile: Profile,
    cwd: PathBuf,
    mode: Option<PermissionMode>,
    model: Option<String>,
    prompt: Option<String>,
    size: TermSize,
}

fn status_record(status: &SessionStatus) -> (String, Option<String>) {
    let reason = match status {
        SessionStatus::Stopped { reason } => reason.clone(),
        _ => None,
    };
    let name = status_json(status)["state"]
        .as_str()
        .unwrap_or("starting")
        .to_owned();
    (name, reason)
}

fn status_from_record(name: &str, reason: Option<String>) -> SessionStatus {
    match name {
        "running" => SessionStatus::Running,
        "waiting" => SessionStatus::Waiting(WaitKind::Permission),
        "idle" => SessionStatus::Idle,
        "error" => SessionStatus::Error,
        "stopped" => SessionStatus::Stopped { reason },
        _ => SessionStatus::Starting,
    }
}

/// Jeton : 16 octets du générateur aléatoire du système, en hexadécimal.
fn new_token() -> Result<String, RpcError> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes)
        .map_err(|e| RpcError::launch(format!("générateur aléatoire indisponible : {e}")))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn pid_alive(pid: u32) -> bool {
    nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid as i32), None).is_ok()
}

/// Champs d'un enregistrement qui justifient une écriture immédiate.
fn significant(r: &SessionRecord) -> SessionRecord {
    let mut r = r.clone();
    r.updated_at = OffsetDateTime::UNIX_EPOCH;
    r.last_activity = None;
    r
}

impl Entry {
    fn new(session: Session, terminal: Terminal, now: OffsetDateTime) -> Self {
        Self {
            session,
            model: None,
            created_at: now,
            updated_at: now,
            terminal: Arc::new(terminal),
            run: None,
            token: None,
            last_exit: None,
            persisted: None,
            waiters: HashMap::new(),
            orphan: None,
            mode_change: None,
            screen_mode: None,
            has_transcript: false,
            cwd_exists: true,
            pty_lock: Arc::new(tokio::sync::Mutex::new(())),
            subagents_persisted: HashMap::new(),
        }
    }

    /// Processus `claude` à persister : celui qui tourne, sinon l'orphelin.
    fn process(&self) -> Option<(u32, SupervisedProc)> {
        match &self.run {
            Some(r) => r.pid.map(|p| (p, r.proc.clone())),
            None => self.orphan.clone(),
        }
    }

    /// Un relais attend-il la décision de cette demande ?
    fn answerable(&self, id: RequestId) -> bool {
        self.waiters.get(&id).is_some_and(|w| !w.is_empty())
    }

    /// Libère sans décision les relais d'une demande.
    fn release(&mut self, id: RequestId) {
        for (_, tx) in self.waiters.remove(&id).unwrap_or_default() {
            let _ = tx.send(None);
        }
    }

    /// Libère sans décision tous les relais de la session.
    fn release_all(&mut self) {
        for (_, list) in self.waiters.drain() {
            for (_, tx) in list {
                let _ = tx.send(None);
            }
        }
    }

    /// Libère les relais des demandes closes par ces effets.
    fn release_resolved(&mut self, effects: &[Effect]) {
        for e in effects {
            if let Effect::RequestResolved { request_id, .. } = e {
                self.release(*request_id);
            }
        }
    }

    fn record(&self) -> SessionRecord {
        let (status, status_reason) = status_record(&self.session.state.status());
        SessionRecord {
            id: self.session.id,
            claude_session_id: self.session.claude_session_id.clone(),
            profile: self.session.profile.clone(),
            cwd: self.session.cwd.clone(),
            project_root: self.session.project_root.clone(),
            branch: self.session.branch.clone(),
            model: self.model.clone(),
            mode: self
                .session
                .state
                .permission_mode
                .as_ref()
                .map(|m| m.as_str().to_owned()),
            status,
            status_reason,
            created_at: self.created_at,
            updated_at: self.updated_at,
            last_activity: self.session.state.last_activity,
            pid: self.process().map(|(p, _)| p),
            pid_start: self.process().and_then(|(_, p)| p.start),
            scope_unit: self.process().and_then(|(_, p)| p.scope),
            title: self.session.title.clone(),
            color: self.session.color.clone(),
            first_prompt: self.session.first_prompt.clone(),
            session_name: self.session.metrics.session_name.clone(),
            project_common_dir: self.session.project_common_dir.clone(),
            issue: self.session.issue.clone(),
        }
    }

    /// Pourquoi la session ne peut pas être reprise : `transcript_missing`
    /// (prioritaire : définitif), `cwd_missing`, ou `None` (vivante ou reprenable).
    fn resume_blocker(&self) -> Option<&'static str> {
        if self.run.is_some() {
            None
        } else if !self.has_transcript {
            Some("transcript_missing")
        } else if !self.cwd_exists {
            Some("cwd_missing")
        } else {
            None
        }
    }

    fn json(&self) -> Value {
        let s = &self.session;
        let size = self.terminal.size();
        json!({
            "id": s.id,
            "claude_session_id": s.claude_session_id,
            "title": s.title,
            "color": s.color,
            "display_name": s.display_name(),
            "first_prompt": s.first_prompt,
            "profile": s.profile,
            "cwd": s.cwd,
            "project_root": s.project_root,
            "project_common_dir": s.project_common_dir,
            "issue": s.issue.as_ref().map(|i| json!({"number": i.number, "title": i.title, "url": i.url})),
            "branch": s.branch,
            "model": self.model,
            "mode": s.state.permission_mode.as_ref().map(|m| m.as_str()),
            "status": status_json(&s.state.status()),
            "activity": activity_json(&s.state.activity()),
            "pending": s.state.pending().iter()
                .map(|r| pending_request_json(r, self.answerable(r.id)))
                .collect::<Vec<_>>(),
            "possibly_stale": s.state.possibly_stale(),
            "subagents_running": s.state.subagents().running_count(),
            "subagents_total": s.state.subagents().total(),
            "metrics": metrics_json(&s.metrics),
            "last_activity": time_json(s.state.last_activity),
            "created_at": time_json(Some(self.created_at)),
            "updated_at": time_json(Some(self.updated_at)),
            "alive": self.run.is_some(),
            "resumable": self.run.is_none() && self.has_transcript && self.cwd_exists,
            "resume_blocker": self.resume_blocker(),
            "pid": self.run.as_ref().and_then(|r| r.pid),
            "scope": self.run.as_ref().and_then(|r| r.proc.scope.clone()),
            "last_exit": match &self.last_exit {
                Some(ExitStatus::Code(c)) => json!({"code": c}),
                Some(ExitStatus::Signal(sig)) => json!({"signal": sig}),
                None => Value::Null,
            },
            "size": {"cols": size.cols, "rows": size.rows},
        })
    }
}

/// Lit un paramètre texte facultatif.
pub fn opt_str(params: &Value, key: &str) -> Result<Option<String>, RpcError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err(RpcError::params(format!("« {key} » doit être une chaîne"))),
    }
}

/// Lit l'identifiant de session `id`.
pub fn session_id_param(params: &Value) -> Result<Uuid, RpcError> {
    let s = opt_str(params, "id")?.ok_or_else(|| RpcError::params("« id » manquant"))?;
    Uuid::parse_str(&s).map_err(|_| RpcError::params(format!("identifiant invalide : {s}")))
}

/// Lit `cols` / `rows` (1 à 1000), avec une valeur par défaut.
pub fn size_param(params: &Value, default: TermSize) -> Result<TermSize, RpcError> {
    let get = |key: &str, d: u16| -> Result<u16, RpcError> {
        match params.get(key) {
            None | Some(Value::Null) => Ok(d),
            Some(v) => v
                .as_u64()
                .filter(|n| (1..=1000).contains(n))
                .map(|n| n as u16)
                .ok_or_else(|| RpcError::params(format!("« {key} » : entier de 1 à 1000"))),
        }
    };
    Ok(TermSize {
        cols: get("cols", default.cols)?,
        rows: get("rows", default.rows)?,
    })
}

/// Lit un identifiant de demande `request_id` (entier positif).
pub fn request_id_param(params: &Value) -> Result<RequestId, RpcError> {
    params
        .get("request_id")
        .and_then(Value::as_u64)
        .map(RequestId)
        .ok_or_else(|| RpcError::params("« request_id » manquant ou invalide"))
}

fn mode_param(params: &Value) -> Result<Option<PermissionMode>, RpcError> {
    match opt_str(params, "mode")? {
        None => Ok(None),
        Some(m) if MODES.contains(&m.as_str()) => Ok(Some(PermissionMode::parse(&m))),
        Some(m) => Err(RpcError::params(format!(
            "mode inconnu : {m} (attendu : {})",
            MODES.join(", ")
        ))),
    }
}

fn canonical_cwd(cwd: &str) -> Result<PathBuf, RpcError> {
    let path = PathBuf::from(cwd);
    if !path.is_absolute() {
        return Err(RpcError::params(format!(
            "« cwd » doit être absolu : {cwd}"
        )));
    }
    let path = path
        .canonicalize()
        .map_err(|e| RpcError::params(format!("dossier introuvable : {cwd} ({e})")))?;
    if !path.is_dir() {
        return Err(RpcError::params(format!("pas un dossier : {cwd}")));
    }
    Ok(path)
}

impl Daemon {
    /// Crée le démon. À appeler dans un runtime tokio.
    pub fn new(config: Config, deps: Deps) -> Arc<Self> {
        let (events, _) = broadcast::channel(EVENTS_CAPACITY);
        Arc::new_cyclic(|me| Self {
            config,
            deps,
            registry: Mutex::new(Registry::default()),
            events,
            runtime: tokio::runtime::Handle::current(),
            next_run: AtomicU64::new(1),
            next_waiter: AtomicU64::new(1),
            shutting_down: AtomicBool::new(false),
            supervised: Mutex::new(Supervised::new()),
            me: me.clone(),
            removed: Mutex::new(std::collections::VecDeque::new()),
            quotas: Mutex::new((std::collections::BTreeMap::new(), None)),
            quota_calls: Mutex::new(HashMap::new()),
            quota_refreshing: AtomicBool::new(false),
            diff_watch: Mutex::new(HashMap::new()),
            files_cache: Mutex::new(HashMap::new()),
            subagent_notify: Mutex::new(HashMap::new()),
            files_inflight: Mutex::new(HashMap::new()),
            worktree_watch: Mutex::new(HashMap::new()),
            repo_locks: Mutex::new(HashMap::new()),
            removing: Mutex::new(std::collections::HashSet::new()),
            conversations: Mutex::new(HashMap::new()),
            conv_actions: Mutex::new(HashMap::new()),
            conv_wake: tokio::sync::Notify::new(),
            conv_rev_floor: AtomicU64::new(0),
            forge_cache: Mutex::new(forge::ForgeCache::default()),
        })
    }

    pub fn config(&self) -> &Config {
        &self.config
    }

    fn lock(&self) -> MutexGuard<'_, Registry> {
        self.registry.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn now(&self) -> OffsetDateTime {
        self.deps.clock.now()
    }

    /// Abonnement aux événements (`session.updated`, `session.effect`).
    pub fn events(&self) -> broadcast::Receiver<Event> {
        self.events.subscribe()
    }

    /// Écrit en base si un champ significatif a changé (ou si la dernière
    /// écriture date de plus de [`PERSIST_INTERVAL`]), puis signale le changement.
    fn commit(&self, entry: &mut Entry) {
        let record = entry.record();
        let write = match &entry.persisted {
            None => true,
            Some((old, at)) => {
                significant(old) != significant(&record)
                    || (old != &record && at.elapsed() >= PERSIST_INTERVAL)
            }
        };
        if write {
            if let Err(e) = self.deps.store.upsert(&record) {
                error!("écriture de la session {} en base : {e}", record.id);
            }
            entry.persisted = Some((record, Instant::now()));
        }
        let _ = self.events.send(Event::Updated(entry.session.id));
    }

    /// Contrôle du pair d'une connexion au socket de contrôle (voir
    /// [`peer::check_control`]). Les processus supervisés disparus sont
    /// d'abord oubliés (lecture de `/proc` hors de tout verrou du registre).
    pub fn check_control_peer(&self, peer: &Peer) -> Result<(), String> {
        let live = peer::scan();
        let supervised = {
            let mut sup = self.supervised.lock().unwrap_or_else(|e| e.into_inner());
            peer::prune(&mut sup, &live);
            sup.clone()
        };
        peer::check_control(peer, nix::unistd::getuid().as_raw(), &supervised)
    }

    /// Une trame de relais avec ce jeton vient-elle bien d'un processus de la
    /// session (voir [`peer::check_relay`]) ? Jeton inconnu : non.
    pub fn check_relay_peer(&self, token: &str, peer: &Peer) -> Result<(), String> {
        let claude = {
            let reg = self.lock();
            reg.session_of(token)
                .and_then(|id| reg.sessions.get(&id))
                .and_then(|e| e.run.as_ref())
                .and_then(|r| r.pid.map(|p| (p, r.proc.clone())))
        };
        let Some((pid, proc)) = claude else {
            return Err("jeton inconnu".into());
        };
        peer::check_relay(peer, nix::unistd::getuid().as_raw(), pid, &proc)
    }

    /// Signale le groupe de processus d'une session (`killpg`, jamais `kill`
    /// sur un pid seul). Si le pid désigne désormais un autre processus
    /// (date de démarrage différente : pid réattribué), rien n'est envoyé.
    fn signal_group(&self, pid: u32, sig: nix::sys::signal::Signal) {
        let start = self
            .supervised
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&pid)
            .and_then(|p| p.start);
        if let (Some(start), Some(now)) = (start, peer::start_time(pid))
            && start != now
        {
            return;
        }
        let _ = nix::sys::signal::killpg(nix::unistd::Pid::from_raw(pid as i32), sig);
    }

    /// Mode à passer quand l'appelant n'en donne pas : `permissions.defaultMode`
    /// des réglages du projet ou du profil (lecture seule). Un mode dangereux
    /// non autorisé devient `default` (`--permission-mode manual`), avec un
    /// avertissement.
    fn effective_mode(
        &self,
        cwd: &Path,
        profile: &Profile,
        warnings: &mut Vec<String>,
    ) -> Option<PermissionMode> {
        let (mode, source) = claude_config::default_mode(cwd, &profile.config_dir)?;
        if mode.is_dangerous() && !self.config.allow_dangerous_modes {
            let w = format!(
                "le mode par défaut « {} » de {} n'est pas autorisé par le démon : session lancée en mode « default » \
                 (régler allow_dangerous_modes = true dans {})",
                mode.as_str(),
                source.display(),
                self.config.paths.config_file().display()
            );
            warning!("{w}");
            warnings.push(w);
            return Some(PermissionMode::Default);
        }
        Some(mode)
    }

    /// Refuse un mode dangereux sans `allow_dangerous_modes`.
    fn check_mode_allowed(
        &self,
        mode: Option<&PermissionMode>,
        inherited: bool,
    ) -> Result<(), RpcError> {
        let Some(mode) = mode.filter(|m| m.is_dangerous()) else {
            return Ok(());
        };
        if self.config.allow_dangerous_modes {
            return Ok(());
        }
        let origin = if inherited {
            format!("la session était en mode « {} »", mode.as_str())
        } else {
            format!("mode « {} » demandé", mode.as_str())
        };
        Err(RpcError::new(
            error_code::DANGEROUS_MODE,
            format!(
                "{origin} : ce mode supprime les demandes de permission et n'est pas autorisé \
                 (régler allow_dangerous_modes = true dans {}, puis redémarrer le démon)",
                self.config.paths.config_file().display()
            ),
        ))
    }

    fn emit_effects(&self, id: Uuid, effects: &[crate::domain::Effect]) {
        for e in effects {
            let _ = self.events.send(Event::Effect {
                id,
                effect: Arc::new(effect_json(e)),
            });
        }
    }

    /// Régénère le plugin et les réglages de tous les profils connus.
    pub fn write_claude_config(&self) {
        let orchd = &self.config.orchd_exe;
        if let Err(e) = claude_config::write_plugin(
            &self.config.paths.plugin_dir(),
            orchd,
            self.config.permission_timeout_secs,
        ) {
            error!("écriture du plugin Claude Code : {e}");
        }
        match self.deps.profiles.profiles() {
            Ok(profiles) => {
                for p in profiles {
                    let path = self.config.paths.settings_for(&p.name);
                    if let Err(e) = claude_config::write_settings(
                        &path,
                        orchd,
                        &p,
                        !self.config.allow_dangerous_modes,
                    ) {
                        error!("écriture des réglages du profil {} : {e}", p.name);
                    }
                }
            }
            Err(e) => warning!("détection des profils : {e}"),
        }
    }

    /// Relit les sessions de la base. Celles qui étaient actives (démarrage,
    /// en cours, à répondre, inactive) quand le démon a disparu deviennent
    /// arrêtées (`daemon_restart`) et reprenables ; les sessions arrêtées ou
    /// en erreur sont gardées telles quelles.
    pub fn restore(&self) {
        let records = match self.deps.store.load_all() {
            Ok(r) => r,
            Err(e) => {
                error!("lecture de la base : {e}");
                return;
            }
        };
        let now = self.now();
        // Processus restés d'avant un plantage : toujours refusés au socket de
        // contrôle tant qu'eux (ou des processus de leur session) vivent.
        let live = peer::scan();
        let mut reg = self.lock();
        for r in records {
            let mut orphan = None;
            if let (Some(pid), Some(start)) = (r.pid, r.pid_start) {
                let proc = SupervisedProc {
                    start: Some(start),
                    scope: r.scope_unit.clone(),
                };
                let mut one: Supervised = [(pid, proc.clone())].into();
                peer::prune(&mut one, &live);
                if !one.is_empty() {
                    warning!(
                        "session {} : des processus de l'ancien claude {pid} vivent encore ; \
                         ils restent refusés au socket de contrôle",
                        r.id
                    );
                    self.supervised
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .insert(pid, proc.clone());
                    orphan = Some((pid, proc));
                }
            }
            let mut status = status_from_record(&r.status, r.status_reason.clone());
            let was_active = matches!(
                status,
                SessionStatus::Starting
                    | SessionStatus::Running
                    | SessionStatus::Waiting(_)
                    | SessionStatus::Idle
            );
            if was_active {
                if let Some(pid) = r.pid.filter(|p| pid_alive(*p)) {
                    warning!(
                        "session {} : le processus {pid} existe encore mais n'est plus rattaché au démon",
                        r.id
                    );
                }
                status = SessionStatus::Stopped {
                    reason: Some(REASON_DAEMON_RESTART.to_owned()),
                };
            }
            let mut session = Session::new(
                r.id,
                r.claude_session_id.clone(),
                r.project_root.clone(),
                r.cwd.clone(),
                r.profile.clone(),
            );
            session.branch = r.branch.clone();
            session.project_common_dir = r.project_common_dir.clone();
            session.issue = r.issue.clone();
            session.title = r.title.clone();
            session.color = r.color.clone();
            session.first_prompt = r.first_prompt.clone();
            session.metrics.session_name = r.session_name.clone();
            session.state = SessionState::restored(
                status,
                r.mode.as_deref().map(PermissionMode::parse),
                r.last_activity,
            );
            let mut agents = match self.deps.store.load_subagents(&r.id) {
                Ok(a) => a,
                Err(e) => {
                    error!("lecture des sous-agents de la session {} : {e}", r.id);
                    Vec::new()
                }
            };
            let persisted: HashMap<String, u64> = agents
                .iter()
                .map(|a| (a.agent_id.clone(), a.fingerprint()))
                .collect();
            // Le processus n'est plus là : un sous-agent resté en cours ne
            // finira jamais. Fin datée de la dernière activité connue.
            for a in agents.iter_mut().filter(|a| a.is_running()) {
                a.status = crate::domain::SubagentStatus::Interrupted;
                a.current_tool = None;
                a.ended_at = Some(r.last_activity.unwrap_or(now).max(a.started_at));
            }
            session.state.restore_subagents(agents);
            let mut entry = Entry::new(session, Terminal::new(DEFAULT_SIZE), r.created_at);
            entry.subagents_persisted = persisted;
            self.persist_subagents(&mut entry);
            entry.model = r.model.clone();
            entry.orphan = orphan;
            entry.updated_at = if was_active { now } else { r.updated_at };
            let orphan_changed = entry.orphan.is_none() && r.pid.is_some();
            entry.persisted = Some((r, Instant::now()));
            if was_active || orphan_changed {
                let record = entry.record();
                if let Err(e) = self.deps.store.upsert(&record) {
                    error!("écriture de la session {} en base : {e}", record.id);
                }
                entry.persisted = Some((record, Instant::now()));
            }
            reg.sessions.insert(entry.session.id, entry);
        }
        info!("{} session(s) relue(s) depuis la base", reg.sessions.len());
        drop(reg);
        self.refresh_resumable(None);
        self.backfill_common_dirs();
    }

    // ---------------------------------------------------------------- lecture

    /// `profiles.list`.
    pub fn profiles(&self) -> Result<Value, RpcError> {
        let profiles = self
            .deps
            .profiles
            .profiles()
            .map_err(|e| RpcError::new(error_code::INTERNAL_ERROR, e.to_string()))?;
        Ok(json!({"profiles": profiles.iter().map(profile_json).collect::<Vec<_>>()}))
    }

    fn profile(&self, name: &str) -> Result<Profile, RpcError> {
        self.deps
            .profiles
            .profiles()
            .ok()
            .and_then(|ps| ps.into_iter().find(|p| p.name == name))
            .ok_or_else(|| {
                RpcError::new(
                    error_code::UNKNOWN_PROFILE,
                    format!("profil inconnu : {name}"),
                )
            })
    }

    /// `projects.resolve`.
    pub fn resolve_project(&self, path: &Path) -> Result<Value, RpcError> {
        if !path.exists() {
            if !path.is_absolute() {
                return Err(RpcError::params(format!(
                    "dossier introuvable : {}",
                    path.display()
                )));
            }
            // Dossier disparu (worktree supprimé…) : d'abord le projet
            // enregistré (sessions, worktrees créés par le démon), puis la
            // déduction ; rien n'est créé.
            if let Some((root, common_dir)) = self.known_project_of(path) {
                return Ok(json!({
                    "path": path,
                    "exists": false,
                    "inferred": true,
                    "is_git": true,
                    "root": root,
                    "worktree_root": Value::Null,
                    "common_dir": common_dir,
                    "branch": Value::Null,
                    "name": display_name(&root),
                }));
            }
            let vcs = |p: &Path| self.deps.vcs.resolve(p);
            return Ok(
                match infer_missing_project(path, &|p: &Path| p.is_dir(), &vcs) {
                    Some(repo) => json!({
                        "path": path,
                        "exists": false,
                        "inferred": true,
                        "is_git": true,
                        "root": repo.project_root,
                        "worktree_root": Value::Null,
                        "common_dir": repo.common_dir,
                        "branch": Value::Null,
                        "name": display_name(&repo.project_root),
                    }),
                    None => json!({
                        "path": path,
                        "exists": false,
                        "inferred": false,
                        "is_git": false,
                        "root": Value::Null,
                        "worktree_root": Value::Null,
                        "common_dir": Value::Null,
                        "branch": Value::Null,
                        "name": display_name(path),
                    }),
                },
            );
        }
        let path = path.canonicalize().map_err(|e| {
            RpcError::params(format!("dossier introuvable : {} ({e})", path.display()))
        })?;
        Ok(match self.deps.vcs.resolve(&path) {
            Some(repo) => json!({
                "path": path,
                "exists": true,
                "inferred": false,
                "is_git": true,
                "root": repo.project_root,
                "worktree_root": repo.worktree_root,
                "common_dir": repo.common_dir,
                "branch": repo.branch,
                "name": display_name(&repo.project_root),
            }),
            None => json!({
                "path": path,
                "exists": true,
                "inferred": false,
                "is_git": false,
                "root": path,
                "worktree_root": Value::Null,
                "common_dir": Value::Null,
                "branch": Value::Null,
                "name": display_name(&path),
            }),
        })
    }

    /// `sessions.list`, de la plus récente à la plus ancienne.
    pub fn list(&self) -> Value {
        let reg = self.lock();
        let mut entries: Vec<&Entry> = reg.sessions.values().collect();
        entries.sort_by_key(|e| std::cmp::Reverse(e.updated_at));
        json!({"sessions": entries.iter().map(|e| e.json()).collect::<Vec<_>>()})
    }

    /// Identifiants de toutes les sessions.
    pub fn session_ids(&self) -> Vec<Uuid> {
        self.lock().sessions.keys().copied().collect()
    }

    /// État courant d'une session, `None` si elle n'existe pas.
    pub fn session_json(&self, id: &Uuid) -> Option<Value> {
        self.lock().sessions.get(id).map(Entry::json)
    }

    /// `sessions.get`.
    pub fn get(&self, id: &Uuid) -> Result<Value, RpcError> {
        let json = self
            .session_json(id)
            .ok_or_else(|| RpcError::unknown_session(id))?;
        Ok(json!({"session": json}))
    }

    /// `transcripts.list {profile?, limit?, include_hidden?, exclude_known?}`.
    pub fn transcripts(&self, params: &Value) -> Result<Value, RpcError> {
        let profile = self.profile(
            &opt_str(params, "profile")?
                .unwrap_or_else(|| crate::domain::profile::DEFAULT_PROFILE_NAME.to_owned()),
        )?;
        let limit = match params.get("limit") {
            None | Some(Value::Null) => Some(50),
            Some(v) => Some(
                v.as_u64()
                    .ok_or_else(|| RpcError::params("« limit » : entier positif"))?
                    as usize,
            ),
        };
        let flag = |key: &str, default: bool| match params.get(key) {
            None | Some(Value::Null) => Ok(default),
            Some(Value::Bool(b)) => Ok(*b),
            Some(_) => Err(RpcError::params(format!("« {key} » doit être un booléen"))),
        };
        let include_hidden = flag("include_hidden", false)?;
        let exclude_known = flag("exclude_known", true)?;
        let hidden = self
            .deps
            .store
            .hidden_transcripts(&profile.name)
            .map_err(|e| RpcError::new(error_code::INTERNAL_ERROR, e.to_string()))?;
        // Un titre donné dans l'app à une session du démon vaut aussi pour
        // son transcript (même `claude_session_id`).
        let (known, titles) = {
            let reg = self.lock();
            let mut entries: Vec<&Entry> = reg.sessions.values().collect();
            entries.sort_by_key(|e| e.updated_at);
            let known: std::collections::HashSet<String> = entries
                .iter()
                .map(|e| e.session.claude_session_id.clone())
                .collect();
            let titles: HashMap<String, String> = entries
                .into_iter()
                .filter_map(|e| {
                    e.session
                        .title
                        .clone()
                        .map(|t| (e.session.claude_session_id.clone(), t))
                })
                .collect();
            (known, titles)
        };
        let mut exclude = std::collections::HashSet::new();
        if exclude_known {
            exclude.extend(known);
        }
        if !include_hidden {
            exclude.extend(hidden.iter().cloned());
        }
        let past = self
            .deps
            .transcripts
            .past_sessions(&profile, limit, &exclude)
            .map_err(|e| RpcError::new(error_code::INTERNAL_ERROR, e.to_string()))?;
        let sessions: Vec<Value> = past
            .iter()
            .map(|p| {
                let mut v = past_session_json(p);
                if let Some(t) = titles.get(&p.session_id) {
                    v["display_name"] = json!(t);
                }
                v["hidden"] = json!(hidden.contains(&p.session_id));
                v["cwd_exists"] = json!(
                    p.cwd
                        .as_ref()
                        .is_some_and(|c| c.is_absolute() && c.is_dir())
                );
                v
            })
            .collect();
        Ok(json!({"profile": profile.name, "sessions": sessions}))
    }

    // ------------------------------------------------------ lancement, reprise

    /// Résumé du transcript `claude_session_id` d'un profil, s'il existe
    /// (profil inconnu ou lecture impossible : `None`).
    fn past_session(&self, profile: &str, claude_session_id: &str) -> Option<PastSession> {
        let profile = self.profile(profile).ok()?;
        self.deps
            .transcripts
            .past_session(&profile, claude_session_id)
    }

    fn known_profiles(&self) -> Vec<Profile> {
        self.deps.profiles.profiles().unwrap_or_default()
    }

    /// Transcripts existants de ces profils (liste en cache dans
    /// l'adaptateur) : à appeler **hors** du verrou du registre.
    fn transcript_sets(
        &self,
        names: impl IntoIterator<Item = String>,
    ) -> HashMap<String, Arc<std::collections::HashSet<String>>> {
        let profiles = self.known_profiles();
        names
            .into_iter()
            .filter_map(|name| {
                let p = profiles.iter().find(|p| p.name == name)?;
                Some((name, self.deps.transcripts.transcript_ids(p)))
            })
            .collect()
    }

    /// Relit `has_transcript` des sessions qui ne tournent pas (toutes, ou
    /// seulement `only`) : une liste des transcripts par profil, hors du
    /// verrou du registre ; `session.updated` pour chaque valeur changée.
    /// Fait du travail sur le système de fichiers : depuis un contexte
    /// asynchrone, l'appeler dans `spawn_blocking`.
    pub fn refresh_resumable(&self, only: Option<Uuid>) {
        let todo: Vec<(Uuid, String, String, PathBuf)> = self
            .lock()
            .sessions
            .values()
            .filter(|e| e.run.is_none() && only.is_none_or(|id| id == e.session.id))
            .map(|e| {
                (
                    e.session.id,
                    e.session.profile.clone(),
                    e.session.claude_session_id.clone(),
                    e.session.cwd.clone(),
                )
            })
            .collect();
        if todo.is_empty() {
            return;
        }
        let sets = self.transcript_sets(todo.iter().map(|(_, p, _, _)| p.clone()));
        let found: Vec<(Uuid, String, PathBuf, bool, bool)> = todo
            .into_iter()
            .map(|(id, profile, cid, cwd)| {
                let ok = sets.get(&profile).is_some_and(|ids| ids.contains(&cid));
                let exists = cwd.is_dir();
                (id, cid, cwd, ok, exists)
            })
            .collect();
        let mut reg = self.lock();
        for (id, cid, cwd, ok, exists) in found {
            if let Some(e) = reg.sessions.get_mut(&id)
                && e.run.is_none()
                && e.session.claude_session_id == cid
                && e.session.cwd == cwd
                && (e.has_transcript, e.cwd_exists) != (ok, exists)
            {
                e.has_transcript = ok;
                e.cwd_exists = exists;
                let _ = self.events.send(Event::Updated(id));
            }
        }
    }

    /// Identifiants des dernières sessions retirées.
    pub fn removed_ids(&self) -> Vec<Uuid> {
        self.removed
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .copied()
            .collect()
    }

    /// `sessions.forget {id}` : retire une session qui ne tourne pas (arrêtée
    /// ou en erreur) du registre et de la base, masque son transcript de
    /// `transcripts.list`, puis diffuse `session.removed`. Un processus qui
    /// vient de se terminer (délai de grâce) est d'abord constaté terminé.
    /// Les transcripts de Claude Code ne sont jamais supprimés.
    pub fn forget(&self, id: &Uuid) -> Result<Value, RpcError> {
        let mut reg = self.lock();
        let current = reg
            .sessions
            .get(id)
            .ok_or_else(|| RpcError::unknown_session(id))?
            .run
            .as_ref()
            .map(|r| (r.id, r.exit_status()));
        match current {
            None => {}
            Some((_, None)) => {
                return Err(RpcError::new(
                    error_code::INVALID_STATE,
                    "la session tourne encore : l'arrêter d'abord",
                ));
            }
            Some((run_id, Some(status))) => self.finalize_exit(&mut reg, *id, run_id, status),
        }
        let entry = reg.sessions.remove(id).expect("présente");
        if let Some(t) = &entry.token {
            reg.forget_token(t);
        }
        drop(reg);
        // Hors du verrou : plus aucune écriture de cette session ne peut
        // suivre (elles se font toutes sous le verrou, entrée présente).
        if let Err(e) = self.deps.store.delete(id) {
            error!("session {id} : suppression en base : {e} (elle reviendra au redémarrage)");
        }
        if let Err(e) = self.deps.store.hide_transcript(
            &entry.session.profile,
            &entry.session.claude_session_id,
            self.now(),
        ) {
            error!("session {id} : masquage du transcript : {e}");
        }
        // Processus d'avant un plantage : oublié seulement si plus rien ne
        // vit dans son groupe ni sa session (sinon ses descendants resteraient
        // refusés au socket de contrôle tant qu'ils vivent).
        if let Some((pid, proc)) = entry.orphan {
            let mut one: Supervised = [(pid, proc)].into();
            peer::prune(&mut one, &peer::scan());
            if one.is_empty() {
                self.supervised
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&pid);
            }
        }
        {
            let mut removed = self.removed.lock().unwrap_or_else(|e| e.into_inner());
            removed.push_back(*id);
            while removed.len() > REMOVED_KEPT {
                removed.pop_front();
            }
        }
        self.diff_watch
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id);
        self.files_cache
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id);
        self.files_inflight
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id);
        self.subagent_notify
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id);
        self.drop_conversation(id);
        info!("session {id} oubliée (retirée du registre et de la base, transcript masqué)");
        let _ = self.events.send(Event::Removed(*id));
        Ok(json!({"forgotten": true}))
    }

    // ------------------------------------------------------------------- diff

    /// Dossier d'une session, et si son processus tourne.
    fn session_cwd(&self, id: &Uuid) -> Result<(PathBuf, bool), RpcError> {
        let reg = self.lock();
        let e = reg
            .sessions
            .get(id)
            .ok_or_else(|| RpcError::unknown_session(id))?;
        Ok((e.session.cwd.clone(), e.run.is_some()))
    }

    /// Verrou des écritures dans le PTY d'une session : une revue, des
    /// Shift+Tab ou une entrée clavier ne s'entremêlent jamais.
    pub fn pty_lock(&self, id: &Uuid) -> Option<Arc<tokio::sync::Mutex<()>>> {
        self.lock().sessions.get(id).map(|e| e.pty_lock.clone())
    }

    /// Fichiers changés d'un dossier (calcul complet), erreurs du protocole,
    /// et mémorisés pour la session. Bloquant.
    fn compute_changes(
        &self,
        id: Uuid,
        cwd: &Path,
    ) -> Result<Arc<crate::domain::diff::ChangeSet>, RpcError> {
        if !cwd.is_dir() {
            return Err(RpcError::cwd_missing(cwd));
        }
        let changes = Arc::new(self.deps.diff.changes(cwd).map_err(diff_error)?);
        let mut watch = self.diff_watch.lock().unwrap_or_else(|e| e.into_inner());
        let w = watch.entry(id).or_default();
        w.last = Some((changes.clone(), Instant::now()));
        // Référence des notifications, seulement si aucune n'existe encore.
        if w.notified.is_none() {
            w.notified = Some(changes.fingerprint());
        }
        Ok(changes)
    }

    /// Dernière liste calculée si elle date de moins de [`DIFF_REUSE`],
    /// sinon un nouveau calcul. Bloquant.
    fn recent_changes(
        &self,
        id: Uuid,
        cwd: &Path,
    ) -> Result<Arc<crate::domain::diff::ChangeSet>, RpcError> {
        let cached = self
            .diff_watch
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&id)
            .and_then(|w| w.last.clone())
            .filter(|(_, at)| at.elapsed() < DIFF_REUSE);
        match cached {
            Some((c, _)) => Ok(c),
            None => self.compute_changes(id, cwd),
        }
    }

    /// `sessions.diff {id}` (toujours un calcul complet). Bloquant (`git`).
    pub fn diff(&self, params: &Value) -> Result<Value, RpcError> {
        let id = session_id_param(params)?;
        let (cwd, _) = self.session_cwd(&id)?;
        let changes = self.compute_changes(id, &cwd)?;
        Ok(changeset_json(&changes))
    }

    /// `sessions.diffFile {id, path}` : `path` doit faire partie de la liste
    /// de `sessions.diff` (la dernière calculée si elle a moins de 2 s) :
    /// jamais de lecture de fichier arbitraire. Bloquant (`git`).
    pub fn diff_file(&self, params: &Value) -> Result<Value, RpcError> {
        let id = session_id_param(params)?;
        let path = opt_str(params, "path")?.ok_or_else(|| RpcError::params("« path » manquant"))?;
        let (cwd, _) = self.session_cwd(&id)?;
        let changes = self.recent_changes(id, &cwd)?;
        let file = changes.file(&path).ok_or_else(|| {
            RpcError::params(format!(
                "« {path} » ne fait pas partie du diff de la session"
            ))
        })?;
        let d = self
            .deps
            .diff
            .file_diff(&changes, file)
            .map_err(diff_error)?;
        Ok(file_diff_json(&d))
    }

    /// Session à qui envoyer une revue : elle doit tourner et n'avoir aucune
    /// demande en attente (l'Entrée validerait le dialogue de la TUI).
    fn review_target(
        &self,
        id: &Uuid,
    ) -> Result<(PathBuf, mpsc::Sender<Vec<u8>>, PtyLock), RpcError> {
        self.input_target(
            id,
            "la session ne tourne pas : la reprendre pour lui envoyer la revue",
        )
    }

    /// Session à qui écrire une revue ou un prompt (`not_running` : message
    /// si elle ne tourne pas).
    fn input_target(
        &self,
        id: &Uuid,
        not_running: &str,
    ) -> Result<(PathBuf, mpsc::Sender<Vec<u8>>, PtyLock), RpcError> {
        let reg = self.lock();
        let e = reg
            .sessions
            .get(id)
            .ok_or_else(|| RpcError::unknown_session(id))?;
        let run = e
            .run
            .as_ref()
            .ok_or_else(|| RpcError::new(error_code::INVALID_STATE, not_running))?;
        if matches!(e.session.state.status(), SessionStatus::Waiting(_))
            || !e.session.state.pending().is_empty()
        {
            return Err(RpcError::new(
                error_code::INVALID_STATE,
                "une demande attend une réponse dans la session",
            ));
        }
        Ok((e.session.cwd.clone(), run.input.clone(), e.pty_lock.clone()))
    }

    /// Revérifie, verrou du PTY pris et juste avant d'écrire, qu'une revue
    /// préparée peut toujours partir : même processus, toujours en vie, et
    /// aucune demande apparue pendant la préparation (lecture du disque,
    /// `git`). Mêmes erreurs que [`Self::review_target`].
    pub fn recheck_review(&self, review: &ReviewToSend) -> Result<(), RpcError> {
        self.recheck_input(&review.id, &review.input)
    }

    /// Même processus, toujours en vie, aucune demande ouverte.
    pub fn recheck_input(
        &self,
        id: &Uuid,
        expected: &mpsc::Sender<Vec<u8>>,
    ) -> Result<(), RpcError> {
        let (_, input, _) = self.input_target(id, "la session ne tourne plus")?;
        if !input.same_channel(expected) {
            return Err(RpcError::new(
                error_code::INVALID_STATE,
                "la session ne tourne plus",
            ));
        }
        Ok(())
    }

    /// `sessions.sendPrompt {id, text}` (v0.3, lot 12) : nettoie et valide le
    /// prompt, et renvoie de quoi l'écrire (voir [`PromptToSend`]).
    pub fn prepare_prompt(&self, params: &Value) -> Result<PromptToSend, RpcError> {
        let id = session_id_param(params)?;
        let raw = opt_str(params, "text")?.ok_or_else(|| RpcError::params("« text » manquant"))?;
        let text = clean_prompt(&raw);
        if text.is_empty() {
            return Err(RpcError::params("prompt vide"));
        }
        if text.len() > MAX_PROMPT_BYTES {
            return Err(RpcError::params(format!(
                "prompt trop long : {} octets, {MAX_PROMPT_BYTES} au plus",
                text.len()
            )));
        }
        let (_, input, lock) = self.input_target(
            &id,
            "la session ne tourne pas : la reprendre pour lui écrire",
        )?;
        // Un `\` final ferait passer la TUI à la ligne au lieu d'envoyer.
        let paste = text.contains('\n')
            || text.contains('\t')
            || text.ends_with('\\')
            || text.chars().count() >= TYPED_PROMPT_CHARS;
        Ok(PromptToSend {
            id,
            input,
            lock,
            text,
            paste,
        })
    }

    /// `sessions.sendReview` : valide la revue (commentaires de diff et de
    /// fichier), la met en forme (Markdown, extraits du diff et lignes des
    /// fichiers relues ici, au plus 256 Kio collés) et renvoie de quoi
    /// l'envoyer. Bloquant (`git`, disque).
    pub fn prepare_review(&self, params: &Value) -> Result<ReviewToSend, RpcError> {
        use crate::domain::diff::{
            FileComment, MAX_REVIEW_BYTES, MAX_REVIEW_COMMENTS, MAX_REVIEW_TEXT_CHARS,
            ReviewBuilder, ReviewComment, ReviewEntry, Side, excerpt, file_excerpt, line_count,
            looks_binary, review_instruction, validate_file_range,
        };
        use crate::domain::files::{MAX_READ_BYTES, normalize_rel};
        /// Commentaire validé, pas encore accompagné de son extrait.
        enum Parsed {
            Diff(ReviewComment),
            File(FileComment),
            /// Commentaire sur le diff d'un commit : sha complet.
            Commit(String, ReviewComment),
        }
        /// Erreur sur un commentaire de fichier : rang, chemin et lignes
        /// demandés dans le message, et `data: {index, path, line,
        /// line_end}` (valeurs telles que reçues ; `index` à partir de 0).
        fn file_comment_error(
            code: i64,
            index: usize,
            (path, line, line_end): (&Value, &Value, &Value),
            message: &str,
        ) -> RpcError {
            let shown = path.as_str().unwrap_or("?");
            let lines = match (line.as_u64(), line_end.as_u64()) {
                (Some(a), Some(b)) if a == b => format!("ligne {a}"),
                (Some(a), Some(b)) => format!("lignes {a}-{b}"),
                (Some(a), None) => format!("ligne {a}"),
                _ => "lignes ?".to_owned(),
            };
            RpcError::new(
                code,
                format!(
                    "commentaire {} (« {shown} », {lines}) : {message}",
                    index + 1
                ),
            )
            .with_data(json!({"index": index, "path": path, "line": line, "line_end": line_end}))
        }
        let id = session_id_param(params)?;
        let text_param = |v: &Value, what: &str| -> Result<String, RpcError> {
            let t = v
                .as_str()
                .ok_or_else(|| RpcError::params(format!("« {what} » doit être une chaîne")))?;
            let n = t.chars().count();
            if n > MAX_REVIEW_TEXT_CHARS {
                return Err(RpcError::params(format!(
                    "« {what} » : {n} caractères, {MAX_REVIEW_TEXT_CHARS} au plus"
                )));
            }
            Ok(t.to_owned())
        };
        let general = match params.get("general") {
            None | Some(Value::Null) => None,
            Some(v) => Some(text_param(v, "general")?).filter(|g| !g.trim().is_empty()),
        };
        let raw = match params.get("comments") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(a)) => a.clone(),
            Some(_) => return Err(RpcError::params("« comments » doit être une liste")),
        };
        if raw.len() > MAX_REVIEW_COMMENTS {
            return Err(RpcError::params(format!(
                "{} commentaires, {MAX_REVIEW_COMMENTS} au plus",
                raw.len()
            )));
        }
        let mut parsed = Vec::with_capacity(raw.len());
        for (i, c) in raw.iter().enumerate() {
            let at = |m: &str| RpcError::params(format!("commentaire {} : {m}", i + 1));
            let kind = match c.get("kind") {
                None | Some(Value::Null) => "diff",
                Some(Value::String(k)) if ["diff", "file", "commit"].contains(&k.as_str()) => {
                    k.as_str()
                }
                Some(_) => return Err(at("« kind » : « diff », « file » ou « commit » attendu")),
            };
            if kind == "file" {
                let raw_path = c.get("path").unwrap_or(&Value::Null);
                let raw_line = c.get("line").unwrap_or(&Value::Null);
                // `line_end` absent : une seule ligne.
                let raw_end = match c.get("line_end") {
                    None | Some(Value::Null) => raw_line,
                    Some(v) => v,
                };
                let at = |m: &str| {
                    file_comment_error(
                        error_code::INVALID_PARAMS,
                        i,
                        (raw_path, raw_line, raw_end),
                        m,
                    )
                };
                let path = raw_path
                    .as_str()
                    .filter(|p| !p.is_empty())
                    .ok_or_else(|| at("« path » manquant"))?;
                let rel = normalize_rel(path).map_err(at)?;
                if rel.is_empty() {
                    return Err(at("« path » : un fichier attendu"));
                }
                let line = raw_line
                    .as_u64()
                    .ok_or_else(|| at("« line » : entier positif attendu"))?;
                let line_end = raw_end.as_u64().ok_or_else(|| {
                    at("« line_end » : entier supérieur ou égal à « line » attendu")
                })?;
                validate_file_range(line, line_end).map_err(|m| at(&m))?;
                // Commentaire facultatif pour une sélection de fichier.
                let text = match c.get("text") {
                    None | Some(Value::Null) => String::new(),
                    Some(v) => text_param(v, "text").map_err(|e| at(&e.message))?,
                };
                parsed.push(Parsed::File(FileComment {
                    path: rel,
                    line: line as u32,
                    line_end: line_end as u32,
                    text,
                }));
                continue;
            }
            let sha = if kind == "commit" {
                Some(commits::sha_param(c.get("sha")).map_err(|m| at(&m))?)
            } else {
                None
            };
            let path = c
                .get("path")
                .and_then(Value::as_str)
                .filter(|p| !p.is_empty())
                .ok_or_else(|| at("« path » manquant"))?
                .to_owned();
            let line =
                c.get("line")
                    .and_then(Value::as_u64)
                    .filter(|l| (1..=u32::MAX as u64).contains(l))
                    .ok_or_else(|| at("« line » : entier positif attendu"))? as u32;
            let side = match c.get("side").and_then(Value::as_str) {
                Some("new") => Side::New,
                Some("old") => Side::Old,
                _ => return Err(at("« side » : « new » ou « old » attendu")),
            };
            let text = text_param(c.get("text").unwrap_or(&Value::Null), "text")
                .map_err(|e| at(&e.message))?;
            if text.trim().is_empty() {
                return Err(at("« text » vide"));
            }
            let comment = ReviewComment {
                path,
                line,
                side,
                text,
            };
            parsed.push(match sha {
                Some(sha) => Parsed::Commit(sha, comment),
                None => Parsed::Diff(comment),
            });
        }
        if parsed.is_empty() && general.is_none() {
            return Err(RpcError::params(
                "revue vide : au moins un commentaire ou « general » attendu",
            ));
        }
        let (cwd, input, lock) = self.review_target(&id)?;
        // Diff : seulement s'il y a des commentaires de diff (une sélection
        // de fichier marche aussi hors dépôt).
        let has_diff = parsed.iter().any(|p| matches!(p, Parsed::Diff(_)));
        let has_file = parsed.iter().any(|p| matches!(p, Parsed::File(_)));
        let has_commit = parsed.iter().any(|p| matches!(p, Parsed::Commit(..)));
        let changes = if has_diff {
            Some(self.recent_changes(id, &cwd)?)
        } else {
            None
        };
        let root = if has_file {
            Some(self.files_root(&id)?.1)
        } else {
            None
        };
        // Historique : résolu une fois pour toute la revue (tous les sha
        // cités), fichiers relus une fois par commit.
        let history = if has_commit {
            let shas: Vec<&str> = parsed
                .iter()
                .filter_map(|p| match p {
                    Parsed::Commit(sha, _) => Some(sha.as_str()),
                    _ => None,
                })
                .collect();
            Some(self.history_log(id, &cwd, &shas)?)
        } else {
            None
        };
        let mut commit_files: HashMap<String, Arc<crate::domain::diff::ChangeSet>> = HashMap::new();
        let count = parsed.len();
        let mut diffs: HashMap<String, crate::domain::diff::FileDiff> = HashMap::new();
        // Diffs de fichiers de commits, par (sha, chemin).
        let mut commit_diffs: HashMap<(String, String), crate::domain::diff::FileDiff> =
            HashMap::new();
        // Dernier fichier lu (les sélections d'un même fichier se suivent
        // en général) : toujours lu par le démon, jamais de texte d'extrait
        // venu du client ; un seul fichier de 2 Mio au plus en mémoire.
        let mut last_file: Option<(String, String)> = None;
        // Revue bornée : au-delà de 256 Kio, les éléments sont comptés, plus
        // gardés.
        let mut review = ReviewBuilder::new(general.as_deref());
        for (i, p) in parsed.into_iter().enumerate() {
            match p {
                Parsed::Diff(c) => {
                    let changes = changes.as_ref().expect("diff calculé");
                    let file = changes.file(&c.path).ok_or_else(|| {
                        RpcError::params(format!(
                            "« {} » ne fait pas partie du diff de la session",
                            c.path
                        ))
                    })?;
                    if !diffs.contains_key(&c.path) {
                        let d = self.deps.diff.file_diff(changes, file).unwrap_or_default();
                        diffs.insert(c.path.clone(), d);
                    }
                    let ex = excerpt(&diffs[&c.path], c.line, c.side);
                    review.push(&ReviewEntry::Diff(c, ex));
                }
                Parsed::Commit(sha, c) => {
                    let at = |m: &str| RpcError::params(format!("commentaire {} : {m}", i + 1));
                    let log = history.as_ref().expect("historique résolu");
                    let commit = log
                        .commit(&sha)
                        .ok_or_else(|| at(&commits::foreign_commit(&sha)))?;
                    let changes = match commit_files.get(&sha) {
                        Some(c) => c.clone(),
                        None => {
                            let c = self.commit_files(id, log, commit)?;
                            commit_files.insert(sha.clone(), c.clone());
                            c
                        }
                    };
                    let file = changes.file(&c.path).ok_or_else(|| {
                        at(&format!(
                            "« {} » ne fait pas partie du diff du commit « {} »",
                            c.path,
                            commit.short()
                        ))
                    })?;
                    let key = (sha.clone(), c.path.clone());
                    if !commit_diffs.contains_key(&key) {
                        let d = self.deps.diff.file_diff(&changes, file).unwrap_or_default();
                        commit_diffs.insert(key.clone(), d);
                    }
                    let ex = excerpt(&commit_diffs[&key], c.line, c.side);
                    review.push(&ReviewEntry::Commit(sha, c, ex));
                }
                Parsed::File(c) => {
                    let (path_v, line_v, end_v) = (json!(c.path), json!(c.line), json!(c.line_end));
                    let fail = |code: i64, m: &str| {
                        file_comment_error(code, i, (&path_v, &line_v, &end_v), m)
                    };
                    if last_file.as_ref().is_none_or(|(p, _)| *p != c.path) {
                        let root = root.as_ref().expect("racine résolue");
                        let f = self
                            .deps
                            .files
                            .read_beneath(root, &c.path, MAX_READ_BYTES)
                            .map_err(|e| {
                                let e = file_error(e, &c.path);
                                fail(e.code, &e.message)
                            })?;
                        let bytes = f.bytes.ok_or_else(|| {
                            fail(
                                error_code::INVALID_PARAMS,
                                &format!(
                                    "fichier trop gros (plus de {} Mio)",
                                    MAX_READ_BYTES / (1024 * 1024)
                                ),
                            )
                        })?;
                        if looks_binary(&bytes) {
                            return Err(fail(error_code::INVALID_PARAMS, "fichier binaire"));
                        }
                        last_file =
                            Some((c.path.clone(), String::from_utf8_lossy(&bytes).into_owned()));
                    }
                    let text = &last_file.as_ref().expect("fichier lu").1;
                    let lines = file_excerpt(text, c.line, c.line_end).ok_or_else(|| {
                        fail(
                            error_code::INVALID_PARAMS,
                            &format!("hors du fichier ({} ligne(s))", line_count(text)),
                        )
                    })?;
                    review.push(&ReviewEntry::File(c, lines));
                }
            }
        }
        let text = review.finish().map_err(|n| {
            RpcError::params(format!(
                "revue trop volumineuse : {} Kio sur {} Kio au plus",
                n.div_ceil(1024),
                MAX_REVIEW_BYTES / 1024
            ))
        })?;
        info!("session {id} : revue préparée ({count} commentaire(s))");
        Ok(ReviewToSend {
            id,
            input,
            lock,
            instruction: review_instruction(has_diff || has_commit, has_file),
            text,
        })
    }

    /// Recalcule le diff d'une session dans 500 ms (anti-rebond : un seul
    /// recalcul en attente par session) et diffuse `session.diff_changed` si
    /// l'empreinte a changé. Pendant un calcul en cours, un tic du
    /// sondage est sauté ; un hook le fait refaire ensuite.
    fn schedule_diff_check(&self, id: Uuid, from_poll: bool) {
        {
            let mut watch = self.diff_watch.lock().unwrap_or_else(|e| e.into_inner());
            let w = watch.entry(id).or_default();
            if w.pending {
                return;
            }
            if w.in_flight {
                if !from_poll {
                    w.dirty = true;
                }
                return;
            }
            w.pending = true;
        }
        let Some(daemon) = self.me.upgrade() else {
            return;
        };
        self.runtime.spawn(async move {
            tokio::time::sleep(DIFF_DEBOUNCE).await;
            {
                let mut watch = daemon.diff_watch.lock().unwrap_or_else(|e| e.into_inner());
                let Some(w) = watch.get_mut(&id) else {
                    return;
                };
                w.pending = false;
                w.in_flight = true;
            }
            let d = daemon.clone();
            let _ = tokio::task::spawn_blocking(move || d.check_diff(id)).await;
            let again = {
                let mut watch = daemon.diff_watch.lock().unwrap_or_else(|e| e.into_inner());
                match watch.get_mut(&id) {
                    Some(w) => {
                        w.in_flight = false;
                        std::mem::take(&mut w.dirty)
                    }
                    None => false,
                }
            };
            if again {
                daemon.schedule_diff_check(id, false);
            }
        });
    }

    /// Compare l'empreinte du diff d'une session à la dernière notifiée.
    /// Bloquant.
    fn check_diff(&self, id: Uuid) {
        let Ok((cwd, _)) = self.session_cwd(&id) else {
            return;
        };
        if !cwd.is_dir() {
            return;
        }
        let Ok(changes) = self.deps.diff.changes(&cwd) else {
            return; // hors dépôt ou git en échec : rien à signaler
        };
        let fp = changes.fingerprint();
        let changed = {
            let mut watch = self.diff_watch.lock().unwrap_or_else(|e| e.into_inner());
            let Some(w) = watch.get_mut(&id) else {
                return; // session oubliée entre-temps
            };
            w.last = Some((Arc::new(changes), Instant::now()));
            let changed = w.notified.as_ref().is_some_and(|old| *old != fp);
            w.notified = Some(fp);
            changed
        };
        if changed && self.lock().sessions.contains_key(&id) {
            let _ = self.events.send(Event::DiffChanged(id));
        }
    }

    /// Recalcul du diff des sessions qui tournent toutes les [`DIFF_POLL_INTERVAL`].
    pub fn start_diff_polling(self: &Arc<Self>) {
        let daemon = Arc::clone(self);
        self.runtime.spawn(async move {
            loop {
                tokio::time::sleep(DIFF_POLL_INTERVAL).await;
                let running: Vec<Uuid> = daemon
                    .lock()
                    .sessions
                    .values()
                    .filter(|e| e.run.is_some())
                    .map(|e| e.session.id)
                    .collect();
                for id in running {
                    daemon.schedule_diff_check(id, true);
                }
                daemon.tick_subagents();
            }
        });
    }

    // ---------------------------------------------------------------- fichiers

    /// Racine de l'onglet Fichiers : racine du worktree dans un dépôt, sinon
    /// le dossier de travail (résolu). `true` si c'est un dépôt git.
    fn files_root(&self, id: &Uuid) -> Result<(PathBuf, PathBuf, bool), RpcError> {
        let (cwd, _) = self.session_cwd(id)?;
        if !cwd.is_dir() {
            return Err(RpcError::cwd_missing(&cwd));
        }
        let (root, git) = match self.deps.diff.root(&cwd) {
            Ok(r) => (r, true),
            Err(crate::ports::DiffError::NotARepo) => (cwd.clone(), false),
            Err(e) => return Err(diff_error(e)),
        };
        let root = root
            .canonicalize()
            .map_err(|e| RpcError::new(error_code::INTERNAL_ERROR, e.to_string()))?;
        Ok((cwd, root, git))
    }

    /// Fichiers du dépôt (`git ls-files`), gardés par session tant que
    /// l'empreinte du diff ne change pas, [`FILES_CACHE_TTL`] au plus. Un seul
    /// `git ls-files` à la fois par session : les appels concurrents attendent
    /// le premier et réutilisent sa liste.
    fn repo_file_set(&self, id: Uuid, root: &Path) -> Result<Arc<(Vec<String>, bool)>, RpcError> {
        let fingerprint = || {
            self.diff_watch
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(&id)
                .and_then(|w| w.notified.clone())
        };
        let cached = |fp: &Option<String>| {
            let cache = self.files_cache.lock().unwrap_or_else(|e| e.into_inner());
            cache
                .get(&id)
                .filter(|(_, at, f, r)| at.elapsed() < FILES_CACHE_TTL && f == fp && r == root)
                .map(|(set, ..)| set.clone())
        };
        if let Some(set) = cached(&fingerprint()) {
            return Ok(set);
        }
        let gate = self
            .files_inflight
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(id)
            .or_default()
            .clone();
        let _one = gate.lock().unwrap_or_else(|e| e.into_inner());
        // Un autre appel a peut-être fait la liste pendant l'attente.
        let fp = fingerprint();
        if let Some(set) = cached(&fp) {
            return Ok(set);
        }
        let set = Arc::new(self.deps.diff.repo_files(root).map_err(diff_error)?);
        self.files_cache
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, (set.clone(), Instant::now(), fp, root.to_path_buf()));
        Ok(set)
    }

    /// `files.list {id, path?}` : contenu d'un dossier. Les noms sont choisis,
    /// triés (clés de tri calculées une fois) et coupés à
    /// [`crate::domain::files::MAX_DIR_ENTRIES`] **avant** de décrire chaque
    /// entrée gardée sur le disque. Bloquant.
    pub fn files_list(&self, params: &Value) -> Result<Value, RpcError> {
        use crate::domain::files::{
            Entry, EntryKind, MAX_DIR_ENTRIES, children, join_rel, normalize_rel, sort_entries,
        };
        let id = session_id_param(params)?;
        let rel = normalize_rel(&opt_str(params, "path")?.unwrap_or_default())
            .map_err(RpcError::params)?;
        let (cwd, root, git) = self.files_root(&id)?;
        // Dans un dépôt, un dossier dont tous les fichiers ont été supprimés
        // n'existe plus sur le disque mais se liste encore (fichiers `D`).
        let missing = match self.deps.files.check_dir(&root, &rel) {
            Ok(()) => false,
            Err(crate::ports::FileError::NotFound) if git => true,
            Err(e) => return Err(file_error(e, &rel)),
        };
        let mut truncated = false;
        let mut marks: HashMap<String, &'static str> = HashMap::new();
        // Noms d'abord, genre provisoire (déduit de la liste ou de readdir).
        let mut entries: Vec<Entry> = if git {
            let set = self.repo_file_set(id, &root)?;
            truncated |= set.1;
            // Marques du diff (liste de moins de 2 s si possible).
            marks = self
                .recent_changes(id, &cwd)
                .map(|c| {
                    c.files
                        .iter()
                        .map(|f| (f.path.clone(), f.status.as_str()))
                        .collect()
                })
                .unwrap_or_default();
            // Fichiers supprimés de l'arbre de travail : montrés quand même.
            let deleted: Vec<&String> = marks
                .iter()
                .filter(|(_, s)| **s == "D")
                .map(|(p, _)| p)
                .collect();
            children(
                set.0
                    .iter()
                    .map(String::as_str)
                    .chain(deleted.iter().map(|p| p.as_str())),
                &rel,
            )
            .into_iter()
            .map(|(name, is_dir)| Entry {
                path: join_rel(&rel, &name),
                name,
                kind: if is_dir {
                    EntryKind::Dir
                } else {
                    EntryKind::File
                },
                size: None,
                changed: None,
            })
            .collect()
        } else {
            let (raw, cut) = self
                .deps
                .files
                .list_dir(&root, &rel)
                .map_err(|e| file_error(e, &rel))?;
            truncated |= cut;
            raw.into_iter()
                .map(|r| Entry {
                    path: join_rel(&rel, &r.name),
                    name: r.name,
                    kind: r.kind,
                    size: None,
                    changed: None,
                })
                .collect()
        };
        if missing && entries.is_empty() {
            return Err(file_error(crate::ports::FileError::NotFound, &rel));
        }
        sort_entries(&mut entries);
        if entries.len() > MAX_DIR_ENTRIES {
            entries.truncate(MAX_DIR_ENTRIES);
            truncated = true;
        }
        // Puis seulement les entrées gardées sont décrites sur le disque.
        for e in &mut entries {
            let raw = self.deps.files.lstat(&root, &e.path);
            e.kind = match &raw {
                Some(r) if r.kind == EntryKind::Symlink => EntryKind::Symlink,
                Some(r) => r.kind,
                None => e.kind,
            };
            e.size = raw
                .and_then(|r| r.size)
                .filter(|_| e.kind == EntryKind::File);
            e.changed = if e.kind == EntryKind::Dir {
                let prefix = format!("{}/", e.path);
                marks.keys().any(|p| p.starts_with(&prefix)).then_some("M")
            } else {
                marks.get(&e.path).copied()
            };
        }
        // Un dossier devenu lien change de rang : ordre refait (déjà coupé).
        sort_entries(&mut entries);
        Ok(json!({
            "root": root,
            "path": rel,
            "entries": entries.iter().map(|e| json!({
                "name": e.name,
                "path": e.path,
                "kind": e.kind.as_str(),
                "size": e.size,
                "changed": e.changed,
            })).collect::<Vec<_>>(),
            "truncated": truncated,
        }))
    }

    /// `files.read {id, path}` : un fichier ordinaire sous la racine. Bloquant.
    pub fn files_read(&self, params: &Value) -> Result<Value, RpcError> {
        use crate::domain::diff::looks_binary;
        use crate::domain::files::{MAX_READ_BYTES, normalize_rel};
        let id = session_id_param(params)?;
        let rel = normalize_rel(
            &opt_str(params, "path")?.ok_or_else(|| RpcError::params("« path » manquant"))?,
        )
        .map_err(RpcError::params)?;
        if rel.is_empty() {
            return Err(RpcError::params("« path » : un fichier attendu"));
        }
        let (_, root, _) = self.files_root(&id)?;
        let f = self
            .deps
            .files
            .read_beneath(&root, &rel, MAX_READ_BYTES)
            .map_err(|e| file_error(e, &rel))?;
        let (binary, too_large, content) = match &f.bytes {
            None => (false, true, Value::Null),
            Some(b) if looks_binary(b) => (true, false, Value::Null),
            Some(b) => (false, false, json!(String::from_utf8_lossy(b))),
        };
        // Ce que `files.write` refuserait d'avance (il revérifie tout).
        let not_editable: Option<String> = if too_large {
            Some("fichier trop gros pour être modifié (2 Mio au plus)".into())
        } else if binary {
            Some("fichier binaire".into())
        } else if f
            .bytes
            .as_deref()
            .is_some_and(|b| std::str::from_utf8(b).is_err())
        {
            Some("le fichier n'est pas un texte UTF-8 valide".into())
        } else {
            f.not_editable.clone()
        };
        Ok(json!({
            "path": rel,
            "size": f.size,
            "binary": binary,
            "too_large": too_large,
            "content": content,
            "version": f.version.as_ref().map(file_version_json),
            "editable": not_editable.is_none(),
            "not_editable_reason": not_editable,
        }))
    }

    /// `files.write {id, path, content, expected: {sha256} | null}` : écrit
    /// un fichier texte sous la racine, atomiquement, s'il n'a pas changé
    /// depuis sa lecture (`-32021` sinon, version actuelle dans `data`).
    /// Bloquant.
    pub fn files_write(&self, params: &Value) -> Result<Value, RpcError> {
        use crate::domain::files::{check_write_content, normalize_rel, valid_sha256};
        let id = session_id_param(params)?;
        let rel = normalize_rel(
            &opt_str(params, "path")?.ok_or_else(|| RpcError::params("« path » manquant"))?,
        )
        .map_err(RpcError::params)?;
        if rel.is_empty() {
            return Err(RpcError::params("« path » : un fichier attendu"));
        }
        let content = match params.get("content") {
            Some(Value::String(c)) => c,
            Some(_) => return Err(RpcError::params("« content » : texte attendu")),
            None => return Err(RpcError::params("« content » manquant")),
        };
        let expected = match params.get("expected") {
            None => {
                return Err(RpcError::params(
                    "« expected » manquant : {sha256} ou null pour créer le fichier",
                ));
            }
            Some(Value::Null) => None,
            Some(Value::Object(o)) => match o.get("sha256").and_then(Value::as_str) {
                Some(h) if valid_sha256(h) => Some(h),
                _ => {
                    return Err(RpcError::params(
                        "« expected.sha256 » : 64 caractères hexadécimaux minuscules attendus",
                    ));
                }
            },
            Some(_) => {
                return Err(RpcError::params("« expected » : {sha256} ou null attendu"));
            }
        };
        check_write_content(content).map_err(RpcError::params)?;
        let (_, root, _) = self.files_root(&id)?;
        let v = self
            .deps
            .files
            .write_beneath(&root, &rel, content.as_bytes(), expected)
            .map_err(|e| file_error(e, &rel))?;
        Ok(json!({"version": file_version_json(&v)}))
    }

    // ----------------------------------------------------------------- quotas

    /// Modifie les quotas, puis diffuse `quotas.updated` si leur JSON a changé.
    fn update_quotas(
        &self,
        f: impl FnOnce(&mut std::collections::BTreeMap<String, crate::domain::ProfileQuotas>),
    ) {
        let now = self.now();
        let mut guard = self.quotas.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut guard.0);
        let json = self.quotas_json_of(&guard.0, now);
        if guard.1.as_ref() != Some(&json) {
            guard.1 = Some(json);
            let _ = self.events.send(Event::Quotas);
        }
    }

    fn quotas_json_of(
        &self,
        map: &std::collections::BTreeMap<String, crate::domain::ProfileQuotas>,
        now: OffsetDateTime,
    ) -> Value {
        use crate::domain::ProfileQuotas;
        let window =
            |slot: &Option<crate::domain::WindowReading>| match ProfileQuotas::visible(slot, now) {
                Some(r) => json!({
                    "used_percentage": r.window.used_percentage,
                    "resets_at": time_json(r.window.resets_at),
                    "source": r.origin.as_str(),
                    "fetched_at": time_json(Some(r.at)),
                }),
                None => Value::Null,
            };
        let profiles: serde_json::Map<String, Value> = map
            .iter()
            .map(|(name, q)| {
                let latest = q.latest(now);
                let v = json!({
                    "five_hour": window(&q.five_hour),
                    "seven_day": window(&q.seven_day),
                    "source": latest.map(|r| r.origin.as_str()),
                    "fetched_at": time_json(latest.map(|r| r.at)),
                    "error": if self.config.usage_api { q.api_error.clone() } else { None },
                });
                (name.clone(), v)
            })
            .collect();
        json!({"profiles": profiles})
    }

    /// `{"profiles": {…}}` de `quotas.get` et `quotas.updated`.
    pub fn quotas_json(&self) -> Value {
        let guard = self.quotas.lock().unwrap_or_else(|e| e.into_inner());
        self.quotas_json_of(&guard.0, self.now())
    }

    /// Lit l'API d'usage pour un profil, si le dernier essai pour ce profil
    /// date d'au moins [`Config::quota_min_interval`] ; bloquant (réseau).
    /// Échec : les lectures précédentes sont gardées, avec l'erreur.
    fn refresh_profile_quotas(&self, profile: &Profile) {
        {
            let mut calls = self.quota_calls.lock().unwrap_or_else(|e| e.into_inner());
            if calls
                .get(&profile.name)
                .is_some_and(|at| at.elapsed() < self.config.quota_min_interval)
            {
                return;
            }
            calls.insert(profile.name.clone(), Instant::now());
        }
        let reading = self.deps.quotas.fetch(profile, self.now());
        let now = self.now();
        let mut changed_error = None;
        self.update_quotas(|q| {
            let e = q.entry(profile.name.clone()).or_default();
            match reading {
                Ok(r) => {
                    e.merge(r, crate::domain::QuotaOrigin::UsageApi, now);
                    e.api_error = None;
                }
                Err(err) => {
                    if e.api_error.as_ref() != Some(&err) {
                        changed_error = Some(err.clone());
                    }
                    e.api_error = Some(err);
                }
            }
        });
        // Journalisé une fois par erreur nouvelle (jamais le jeton).
        if let Some(err) = changed_error {
            warning!("quotas du profil {} : {err}", profile.name);
        }
    }

    /// Profils connus présents dans la liste des quotas (sans lecture).
    fn ensure_quota_profiles(&self, profiles: &[Profile]) {
        self.update_quotas(|q| {
            for p in profiles {
                q.entry(p.name.clone()).or_default();
            }
        });
    }

    /// Relit l'API d'usage de tous les profils, en parallèle, dans une tâche
    /// détachée (résultats par `quotas.updated`). Une seule tournée à la fois
    /// (une demande pendant une tournée est sans effet) ; la tournée rend la
    /// main au plus tard après [`QUOTA_REFRESH_BUDGET`] (un appel plus lent
    /// finit en arrière-plan, borné par son propre délai). Ne fait rien si
    /// `[quotas] usage_api = false`.
    pub fn spawn_quota_refresh(self: &Arc<Self>) -> Option<tokio::task::JoinHandle<()>> {
        if !self.config.usage_api || self.quota_refreshing.swap(true, Ordering::SeqCst) {
            return None;
        }
        let daemon = Arc::clone(self);
        Some(self.runtime.spawn(async move {
            let d = daemon.clone();
            let profiles = tokio::task::spawn_blocking(move || d.known_profiles())
                .await
                .unwrap_or_default();
            let deadline = tokio::time::Instant::now() + QUOTA_REFRESH_BUDGET;
            let tasks: Vec<_> = profiles
                .into_iter()
                .map(|p| {
                    let d = daemon.clone();
                    tokio::task::spawn_blocking(move || d.refresh_profile_quotas(&p))
                })
                .collect();
            for t in tasks {
                let _ = tokio::time::timeout_at(deadline, t).await;
            }
            daemon.quota_refreshing.store(false, Ordering::SeqCst);
        }))
    }

    /// `quotas.get {refresh?}` : répond tout de suite avec les quotas connus
    /// (tous les profils présents) ; `refresh` lance en plus une tournée
    /// ([`Daemon::spawn_quota_refresh`]). Lit les profils (système de
    /// fichiers) : à appeler hors du runtime.
    pub fn quotas_get(self: &Arc<Self>, refresh: bool) -> Value {
        self.ensure_quota_profiles(&self.known_profiles());
        if refresh {
            let _ = self.spawn_quota_refresh();
        }
        self.quotas_json()
    }

    /// Lecture des quotas au démarrage puis toutes les [`QUOTA_POLL_INTERVAL`].
    pub fn start_quota_polling(self: &Arc<Self>) {
        let daemon = Arc::clone(self);
        self.runtime.spawn(async move {
            loop {
                let d = daemon.clone();
                let _ = tokio::task::spawn_blocking(move || {
                    d.ensure_quota_profiles(&d.known_profiles())
                })
                .await;
                if let Some(t) = daemon.spawn_quota_refresh() {
                    let _ = t.await;
                }
                tokio::time::sleep(QUOTA_POLL_INTERVAL).await;
            }
        });
    }

    /// `transcripts.hide` / `transcripts.unhide {profile?, claude_session_id}`.
    pub fn set_transcript_hidden(&self, params: &Value, hidden: bool) -> Result<Value, RpcError> {
        let profile = self.profile(
            &opt_str(params, "profile")?
                .unwrap_or_else(|| crate::domain::profile::DEFAULT_PROFILE_NAME.to_owned()),
        )?;
        let cid = opt_str(params, "claude_session_id")?
            .filter(|c| !c.is_empty())
            .ok_or_else(|| RpcError::params("« claude_session_id » manquant"))?;
        let r = if hidden {
            self.deps
                .store
                .hide_transcript(&profile.name, &cid, self.now())
        } else {
            self.deps
                .store
                .unhide_transcript(&profile.name, &cid)
                .map(drop)
        };
        r.map_err(|e| RpcError::new(error_code::INTERNAL_ERROR, e.to_string()))?;
        Ok(json!({"hidden": hidden}))
    }

    /// Refuse la reprise d'une session sans transcript (`--resume` échouerait).
    /// `sets` : listes calculées hors du verrou ; profil absent (rare) : la
    /// liste est demandée ici.
    fn require_transcript(
        &self,
        sets: &HashMap<String, Arc<std::collections::HashSet<String>>>,
        profile: &Profile,
        claude_id: &str,
    ) -> Result<(), RpcError> {
        let ok = match sets.get(&profile.name) {
            Some(ids) => ids.contains(claude_id),
            None => self.deps.transcripts.has_transcript(profile, claude_id),
        };
        if ok {
            Ok(())
        } else {
            Err(RpcError::new(
                error_code::NO_TRANSCRIPT,
                "Claude Code n'a pas de transcript pour cette session : impossible de la reprendre",
            ))
        }
    }

    fn claude_bin(&self) -> Result<PathBuf, RpcError> {
        launch::find_claude(
            self.config.claude_bin_env.clone(),
            self.config.path_env.clone(),
        )
        // Vérifié avant le lancement : derrière `systemd-run`, un binaire absent
        // ne ferait échouer qu'après coup, dans le scope.
        .filter(|p| launch::is_executable(p))
        .ok_or_else(|| {
            RpcError::launch("binaire « claude » introuvable (PATH ou DEVMAESTRO_CLAUDE_BIN)")
        })
    }

    fn refuse_if_shutting_down(&self) -> Result<(), RpcError> {
        if self.shutting_down.load(Ordering::SeqCst) {
            Err(RpcError::new(
                error_code::INVALID_STATE,
                "le démon s'arrête",
            ))
        } else {
            Ok(())
        }
    }

    /// `sessions.launch`, avec en option un nouveau worktree (`worktree`,
    /// v0.2 lot 6) : créé avant le lancement, retiré (avec la branche créée)
    /// si le lancement échoue. Bloquant (`git`) : à appeler hors du runtime.
    pub fn launch(self: &Arc<Self>, params: &Value) -> Result<Value, RpcError> {
        self.refuse_if_shutting_down()?;
        let cwd = opt_str(params, "cwd")?.ok_or_else(|| RpcError::params("« cwd » manquant"))?;
        let cwd = canonical_cwd(&cwd)?;
        let worktree = worktrees::WorktreeParam::parse(params)?;
        let profile_name = opt_str(params, "profile")?
            .unwrap_or_else(|| crate::domain::profile::DEFAULT_PROFILE_NAME.to_owned());
        let id = Uuid::new_v4();
        let mut plan = Plan {
            claude: self.claude_bin()?,
            kind: LaunchKind::New {
                claude_session_id: id.to_string(),
            },
            profile: self.profile(&profile_name)?,
            cwd: cwd.clone(),
            mode: mode_param(params)?,
            model: opt_str(params, "model")?.filter(|m| !m.is_empty()),
            prompt: opt_str(params, "prompt")?.filter(|p| !p.is_empty()),
            size: size_param(params, DEFAULT_SIZE)?,
        };
        self.check_mode_allowed(plan.mode.as_ref(), false)?;
        let issue = forge::issue_param(params)?;
        let initial = forge::initial_param(params)?;
        if initial.is_some() && plan.prompt.is_some() {
            return Err(RpcError::params(
                "« prompt » et « initial » s'excluent : l'un ou l'autre",
            ));
        }
        let mut warnings = Vec::new();
        // Tout est validé : le worktree est créé, la session y sera lancée.
        let created = match &worktree {
            Some(w) => Some(self.create_worktree(&cwd, w, &mut warnings)?),
            None => None,
        };
        let cwd = created.as_ref().map_or(cwd, |c| c.path.clone());
        plan.cwd = cwd.clone();
        if plan.mode.is_none() {
            plan.mode = self.effective_mode(&plan.cwd, &plan.profile, &mut warnings);
        }
        let repo = self.deps.vcs.resolve(&cwd);
        let mut session = Session::new(
            id,
            id.to_string(),
            repo.as_ref()
                .map_or_else(|| cwd.clone(), |r| r.project_root.clone()),
            cwd,
            plan.profile.name.clone(),
        );
        session.project_common_dir = repo.as_ref().map(|r| r.common_dir.clone());
        session.branch = repo.and_then(|r| r.branch);
        session.issue = issue;
        if let Some(p) = &plan.prompt {
            session.note_prompt(p);
        }
        if let Some(i) = &initial {
            session.note_prompt(&i.instruction);
        }
        let mut entry = Entry::new(session, Terminal::new(plan.size), self.now());

        let mut reg = self.lock();
        // Sous le verrou du registre : une suppression qui a marqué ce
        // worktree voit ensuite cette session vivante, ou bien elle est refusée ici.
        let refused = self.being_removed(&plan.cwd).then(|| {
            RpcError::new(
                error_code::WORKTREE_IN_USE,
                "ce worktree est en cours de suppression",
            )
        });
        let spawned = match refused {
            Some(e) => Err(e),
            None => self.spawn_run(id, &entry.terminal, &plan, false),
        };
        let (run, token) = match spawned {
            Ok(spawned) => spawned,
            Err(e) => {
                drop(reg);
                if let Some(c) = &created {
                    self.rollback_worktree(c);
                }
                return Err(e);
            }
        };
        install_run(&mut reg, &mut entry, run, token, plan);
        info!(
            "session {id} lancée dans {} (profil {})",
            entry.session.cwd.display(),
            entry.session.profile
        );
        self.commit(&mut entry);
        let mut result = json!({"session": entry.json(), "warnings": warnings});
        if let Some(c) = &created {
            result["worktree"] = c.json();
        }
        // Prompt initial en deux temps : claude est lancé sans prompt, la
        // consigne est tapée et le contenu collé quand la TUI est prête.
        let delivery = initial.and_then(|i| {
            let input = entry.run.as_ref()?.input.clone();
            Some((input, entry.pty_lock.clone(), i))
        });
        reg.sessions.insert(id, entry);
        drop(reg);
        if let Some((input, lock, initial)) = delivery {
            self.runtime.spawn(super::server::deliver_initial(
                self.clone(),
                id,
                input,
                lock,
                initial,
            ));
        }
        if let Some(c) = &created {
            self.worktrees_touched(&c.common_dir, &c.project_root);
        }
        Ok(result)
    }

    /// `sessions.resume` : par `id` (session connue du démon) ou par
    /// `claude_session_id` (session connue, sinon ancienne session d'un
    /// transcript, qui devient une nouvelle entrée).
    ///
    /// Tout est validé avant de toucher au registre : en cas d'erreur, la
    /// session (ou son absence) reste exactement comme avant.
    pub fn resume(self: &Arc<Self>, params: &Value) -> Result<Value, RpcError> {
        self.refuse_if_shutting_down()?;
        let by_id = match params.get("id") {
            None | Some(Value::Null) => None,
            Some(_) => Some(session_id_param(params)?),
        };
        let claude_id = opt_str(params, "claude_session_id")?;
        if by_id.is_none() && claude_id.is_none() {
            return Err(RpcError::params("« id » ou « claude_session_id » attendu"));
        }
        // Paramètres indépendants de la session.
        let cwd_param = opt_str(params, "cwd")?
            .map(|c| {
                // Absolu mais absent : gardé tel quel, refusé plus bas (-32016)
                // après la vérification du transcript (-32015, définitive).
                if Path::new(&c).is_absolute() && !Path::new(&c).exists() {
                    Ok(PathBuf::from(&c))
                } else {
                    canonical_cwd(&c)
                }
            })
            .transpose()?;
        let profile_param = opt_str(params, "profile")?;
        let mode_param = mode_param(params)?;
        let model_param = opt_str(params, "model")?.filter(|m| !m.is_empty());
        let prompt = opt_str(params, "prompt")?.filter(|p| !p.is_empty());
        let size_given = params.get("cols").is_some() || params.get("rows").is_some();
        let size_param = size_param(params, DEFAULT_SIZE)?;
        let claude = self.claude_bin()?;
        // Reprise par `claude_session_id` : le résumé de son transcript (lu
        // hors du verrou du registre) nommera la nouvelle entrée s'il en faut une.
        let past = match (&by_id, &claude_id) {
            (None, Some(cid)) => self.past_session(
                profile_param
                    .as_deref()
                    .unwrap_or(crate::domain::profile::DEFAULT_PROFILE_NAME),
                cid,
            ),
            _ => None,
        };
        // Transcripts des profils en jeu, listés hors du verrou du registre.
        // Dossiers des sessions en jeu, vérifiés aussi hors du verrou.
        let (candidate_profiles, candidate_cwds): (Vec<String>, Vec<PathBuf>) = {
            let reg = self.lock();
            let cwds: Vec<PathBuf> = reg
                .sessions
                .values()
                .filter(|e| {
                    by_id == Some(e.session.id)
                        || claude_id.as_deref() == Some(e.session.claude_session_id.as_str())
                })
                .map(|e| e.session.cwd.clone())
                .collect();
            let mut names = vec![
                profile_param
                    .clone()
                    .unwrap_or_else(|| crate::domain::profile::DEFAULT_PROFILE_NAME.to_owned()),
            ];
            if profile_param.is_none() {
                names.extend(
                    reg.sessions
                        .values()
                        .filter(|e| {
                            by_id == Some(e.session.id)
                                || claude_id.as_deref()
                                    == Some(e.session.claude_session_id.as_str())
                        })
                        .map(|e| e.session.profile.clone()),
                );
            }
            names.sort();
            names.dedup();
            (names, cwds)
        };
        let transcript_sets = self.transcript_sets(candidate_profiles);
        let cwd_known: HashMap<PathBuf, bool> = candidate_cwds
            .into_iter()
            .chain(cwd_param.clone())
            .map(|c| {
                let ok = c.is_dir();
                (c, ok)
            })
            .collect();
        let cwd_exists = |p: &Path| cwd_known.get(p).copied().unwrap_or_else(|| p.is_dir());
        // Dépôts des dossiers en jeu, lus par `git` (avec délai) avant de
        // prendre le verrou du registre.
        let repos: HashMap<PathBuf, crate::ports::RepoInfo> = cwd_known
            .iter()
            .filter(|(_, ok)| **ok)
            .filter_map(|(c, _)| self.deps.vcs.resolve(c).map(|r| (c.clone(), r)))
            .collect();

        let mut reg = self.lock();
        let existing = match (&by_id, &claude_id) {
            (Some(id), _) => {
                if !reg.sessions.contains_key(id) {
                    return Err(RpcError::unknown_session(id));
                }
                Some(*id)
            }
            (None, Some(cid)) => reg
                .sessions
                .values()
                .filter(|e| e.session.claude_session_id == *cid)
                .filter(|e| e.run.as_ref().is_none_or(|r| r.exit_status().is_some()))
                .max_by_key(|e| e.updated_at)
                .map(|e| e.session.id),
            (None, None) => unreachable!("vérifié plus haut"),
        };

        if let Some(id) = existing {
            // Processus terminé mais fin pas encore constatée (délai de grâce) :
            // on la constate maintenant plutôt que de refuser.
            let current = reg.sessions[&id]
                .run
                .as_ref()
                .map(|r| (r.id, r.exit_status()));
            match current {
                None => {}
                Some((_, None)) => {
                    return Err(RpcError::new(
                        error_code::INVALID_STATE,
                        "la session tourne encore",
                    ));
                }
                Some((run_id, Some(status))) => self.finalize_exit(&mut reg, id, run_id, status),
            }
            let entry = &reg.sessions[&id];
            let profile =
                self.profile(profile_param.as_deref().unwrap_or(&entry.session.profile))?;
            let mode_inherited = mode_param.is_none();
            let mut plan = Plan {
                claude,
                kind: LaunchKind::Resume {
                    claude_session_id: entry.session.claude_session_id.clone(),
                },
                profile,
                cwd: cwd_param.unwrap_or_else(|| entry.session.cwd.clone()),
                mode: mode_param.or_else(|| entry.session.state.permission_mode.clone()),
                model: model_param.or_else(|| entry.model.clone()),
                prompt,
                size: if size_given {
                    size_param
                } else {
                    entry.terminal.size()
                },
            };
            self.check_mode_allowed(plan.mode.as_ref(), mode_inherited)?;
            // Même ordre que `resume_blocker` : transcript (définitif), puis dossier.
            if let LaunchKind::Resume { claude_session_id } = &plan.kind {
                self.require_transcript(&transcript_sets, &plan.profile, claude_session_id)?;
            }
            if !cwd_exists(&plan.cwd) {
                return Err(RpcError::cwd_missing(&plan.cwd));
            }
            let mut warnings = Vec::new();
            if plan.mode.is_none() {
                plan.mode = self.effective_mode(&plan.cwd, &plan.profile, &mut warnings);
            }
            if self.being_removed(&plan.cwd) {
                return Err(RpcError::new(
                    error_code::WORKTREE_IN_USE,
                    "ce worktree est en cours de suppression",
                ));
            }
            let terminal = entry.terminal.clone();
            let (run, token) = self.spawn_run(id, &terminal, &plan, true)?;
            let now = self.now();
            let mut entry = reg.sessions.remove(&id).expect("présente");
            install_run(&mut reg, &mut entry, run, token, plan);
            entry.updated_at = now;
            if entry.session.project_common_dir.is_none() {
                entry.session.project_common_dir =
                    repos.get(&entry.session.cwd).map(|r| r.common_dir.clone());
            }
            info!(
                "session {id} reprise (claude {})",
                entry.session.claude_session_id
            );
            // Sous-agents gardés à la reprise (statuts déjà finaux).
            self.persist_subagents(&mut entry);
            self.commit(&mut entry);
            if entry.session.state.subagents().total() > 0 {
                self.signal_subagents(id, SubagentChange::Structural);
            }
            let result = json!({"session": entry.json(), "warnings": warnings});
            reg.sessions.insert(id, entry);
            return Ok(result);
        }

        // Ancienne session connue seulement par son transcript.
        let cid = claude_id.expect("vérifié plus haut");
        let cwd = cwd_param
            .ok_or_else(|| RpcError::params("« cwd » manquant pour une ancienne session"))?;
        let profile = self.profile(
            profile_param
                .as_deref()
                .unwrap_or(crate::domain::profile::DEFAULT_PROFILE_NAME),
        )?;
        let mut plan = Plan {
            claude,
            kind: LaunchKind::Resume {
                claude_session_id: cid.clone(),
            },
            profile,
            cwd: cwd.clone(),
            mode: mode_param,
            model: model_param,
            prompt,
            size: size_param,
        };
        self.check_mode_allowed(plan.mode.as_ref(), false)?;
        self.require_transcript(&transcript_sets, &plan.profile, &cid)?;
        if !cwd_exists(&plan.cwd) {
            return Err(RpcError::cwd_missing(&plan.cwd));
        }
        let mut warnings = Vec::new();
        if plan.mode.is_none() {
            plan.mode = self.effective_mode(&plan.cwd, &plan.profile, &mut warnings);
        }
        if self.being_removed(&plan.cwd) {
            return Err(RpcError::new(
                error_code::WORKTREE_IN_USE,
                "ce worktree est en cours de suppression",
            ));
        }
        let repo = repos.get(&cwd).cloned();
        let id = Uuid::new_v4();
        let mut session = Session::new(
            id,
            cid,
            repo.as_ref()
                .map_or_else(|| cwd.clone(), |r| r.project_root.clone()),
            cwd,
            plan.profile.name.clone(),
        );
        session.project_common_dir = repo.as_ref().map(|r| r.common_dir.clone());
        session.branch = repo.and_then(|r| r.branch);
        // Nom repris du transcript (premier prompt, titre de Claude Code) et
        // d'une autre entrée du démon pour la même conversation (titre, couleur).
        if let Some(past) = past {
            session.first_prompt = past.first_prompt;
            session.metrics.session_name = past.title;
        }
        if let Some(other) = reg
            .sessions
            .values()
            .filter(|e| e.session.claude_session_id == session.claude_session_id)
            .filter(|e| e.session.title.is_some() || e.session.color.is_some())
            .max_by_key(|e| e.updated_at)
        {
            session.title = other.session.title.clone();
            session.color = other.session.color.clone();
        }
        if let Some(p) = &plan.prompt {
            session.note_prompt(p);
        }
        let mut entry = Entry::new(session, Terminal::new(plan.size), self.now());
        let (run, token) = self.spawn_run(id, &entry.terminal, &plan, false)?;
        install_run(&mut reg, &mut entry, run, token, plan);
        info!(
            "ancienne session {} reprise sous {id}",
            entry.session.claude_session_id
        );
        self.commit(&mut entry);
        let result = json!({"session": entry.json(), "warnings": warnings});
        reg.sessions.insert(id, entry);
        Ok(result)
    }

    /// Lance `claude` dans un PTY. Ne modifie rien d'autre que le terminal
    /// (et seulement une fois le processus lancé) : en cas d'erreur, la
    /// session est intacte.
    fn spawn_run(
        self: &Arc<Self>,
        id: Uuid,
        terminal: &Arc<Terminal>,
        plan: &Plan,
        reset: bool,
    ) -> Result<(Run, String), RpcError> {
        let paths = &self.config.paths;
        let plugin_dir = paths.plugin_dir();
        let settings = paths.settings_for(&plan.profile.name);
        claude_config::write_plugin(
            &plugin_dir,
            &self.config.orchd_exe,
            self.config.permission_timeout_secs,
        )
        .and_then(|()| {
            claude_config::write_settings(
                &settings,
                &self.config.orchd_exe,
                &plan.profile,
                !self.config.allow_dangerous_modes,
            )
        })
        .map_err(|e| RpcError::launch(format!("écriture du plugin ou des réglages : {e}")))?;

        let token = new_token()?;
        // Socket des relais seulement : celui de contrôle n'est jamais passé.
        let socket = paths.relay_socket();
        let inherited_env: Vec<String> = std::env::vars_os()
            .filter_map(|(k, _)| k.into_string().ok())
            .collect();
        let session_str = id.to_string();
        // Scope systemd propre à ce processus (nom unique : un scope précédent
        // de la même session peut encore se vider).
        let scope = self.config.systemd_run.as_ref().map(|_| {
            format!(
                "{}{}-{}.scope",
                peer::SCOPE_PREFIX,
                &id.simple().to_string()[..8],
                &token[..8]
            )
        });
        let command = launch::build(&LaunchSpec {
            claude_bin: &plan.claude,
            kind: plan.kind.clone(),
            profile: &plan.profile,
            cwd: &plan.cwd,
            mode: plan.mode.as_ref(),
            model: plan.model.as_deref(),
            prompt: plan.prompt.as_deref(),
            plugin_dir: &plugin_dir,
            settings: &settings,
            socket: &socket,
            token: &token,
            session: &session_str,
            inherited_env: &inherited_env,
            scope: self
                .config
                .systemd_run
                .as_deref()
                .zip(scope.as_deref())
                .map(|(systemd_run, unit)| ScopeSpec {
                    systemd_run,
                    unit,
                    runtime_dir: self.config.systemd_runtime_dir.as_deref(),
                }),
        });
        let spawned = self.deps.pty.spawn(&command, plan.size).map_err(|e| {
            RpcError::launch(format!("lancement de {} : {e}", plan.claude.display()))
        })?;

        let run_id = self.next_run.fetch_add(1, Ordering::SeqCst);
        let pid = spawned.child.pid();
        // `systemd-run --scope` garde le pid en exécutant claude : la date de
        // démarrage est celle du processus lancé.
        let proc = SupervisedProc {
            start: pid.and_then(peer::start_time),
            scope: scope.clone(),
        };
        if let Some(pid) = pid {
            self.supervised
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(pid, proc.clone());
        }
        terminal.resize(plan.size);
        if reset {
            // Avant le premier octet du nouveau processus (le lecteur n'est pas encore lancé).
            terminal.feed(RESUME_RESET);
        }

        // Lecteur du PTY : alimente le terminal, ne bloque jamais sur les clients.
        // Il lit aussi le pied de la TUI (mode affiché) : le démon n'est
        // prévenu que d'un changement, verrou du terminal relâché avant celui
        // du registre (jamais imbriqués dans cet ordre).
        let term = terminal.clone();
        let mut reader = spawned.reader;
        let reader_daemon = Arc::clone(self);
        let footer_reset = Arc::new(AtomicBool::new(false));
        let reset_seen = footer_reset.clone();
        spawn_thread(&format!("pty-lecture-{run_id}"), move || {
            let mut buf = vec![0u8; 64 * 1024];
            let mut footer: Option<PermissionMode> = None;
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        term.feed(&buf[..n]);
                        if reset_seen.swap(false, Ordering::SeqCst) {
                            footer = None;
                        }
                        let seen = mode_from_footer(&term.bottom_rows(FOOTER_ROWS));
                        if let Some(mode) = seen.filter(|m| footer.as_ref() != Some(m)) {
                            footer = Some(mode.clone());
                            reader_daemon.on_screen_mode(id, run_id, mode);
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    // EIO : l'enfant a fermé le PTY.
                    Err(_) => break,
                }
            }
        });

        // Écrivain : les entrées des clients, dans l'ordre. File bornée : un
        // client qui écrit plus vite que `claude` ne lit attend (lui seul).
        let (input_tx, mut input_rx) = mpsc::channel::<Vec<u8>>(INPUT_QUEUE);
        let mut writer = spawned.writer;
        spawn_thread(&format!("pty-ecriture-{run_id}"), move || {
            while let Some(data) = input_rx.blocking_recv() {
                if writer
                    .write_all(&data)
                    .and_then(|()| writer.flush())
                    .is_err()
                {
                    break;
                }
            }
        });

        // Attente de la fin du processus.
        let exited = Arc::new(Mutex::new(None));
        let exited_slot = exited.clone();
        let mut child = spawned.child;
        let daemon = Arc::clone(self);
        spawn_thread(&format!("pty-attente-{run_id}"), move || {
            let status = child.wait().unwrap_or(ExitStatus::Code(-1));
            // Les descendants restés dans le groupe (outils lancés par claude)
            // reçoivent SIGHUP, comme à la fermeture d'un terminal.
            if let Some(pid) = pid {
                daemon.signal_group(pid, nix::sys::signal::Signal::SIGHUP);
            }
            *exited_slot.lock().unwrap_or_else(|e| e.into_inner()) = Some(status.clone());
            let rt = daemon.runtime.clone();
            rt.spawn(async move { daemon.on_exit(id, run_id).await });
        });

        Ok((
            Run {
                id: run_id,
                pid,
                control: spawned.control,
                input: input_tx,
                footer_reset,
                stop_requested: false,
                proc,
                exited,
            },
            token,
        ))
    }

    // ------------------------------------------------------------ pilotage

    /// `sessions.stop` : `SIGHUP` au groupe du processus, puis `SIGKILL` si
    /// besoin après [`Config::stop_timeout`].
    pub fn stop(self: &Arc<Self>, id: &Uuid) -> Result<Value, RpcError> {
        let mut reg = self.lock();
        let entry = reg
            .sessions
            .get_mut(id)
            .ok_or_else(|| RpcError::unknown_session(id))?;
        // Aucune décision ne viendra plus : les relais en attente rendent la main.
        entry.release_all();
        let Some(run) = entry.run.as_mut() else {
            return Ok(json!({"stopping": false, "alive": false}));
        };
        run.stop_requested = true;
        if let Some(pid) = run.pid {
            self.signal_group(pid, nix::sys::signal::Signal::SIGHUP);
            let run_id = run.id;
            let daemon = Arc::clone(self);
            let id = *id;
            let timeout = self.config.stop_timeout;
            self.runtime.spawn(async move {
                tokio::time::sleep(timeout).await;
                let reg = daemon.lock();
                if let Some(run) = reg.sessions.get(&id).and_then(|e| e.run.as_ref())
                    && run.id == run_id
                    && run.exit_status().is_none()
                    && let Some(pid) = run.pid
                {
                    warning!("session {id} : pas sortie après SIGHUP, SIGKILL");
                    daemon.signal_group(pid, nix::sys::signal::Signal::SIGKILL);
                }
            });
        }
        Ok(json!({"stopping": true, "alive": true}))
    }

    /// `sessions.resize`.
    pub fn resize(&self, id: &Uuid, size: TermSize) -> Result<Value, RpcError> {
        let reg = self.lock();
        let entry = reg
            .sessions
            .get(id)
            .ok_or_else(|| RpcError::unknown_session(id))?;
        entry.terminal.resize(size);
        if let Some(run) = &entry.run
            && let Err(e) = run.control.resize(size)
        {
            warning!("session {id} : redimensionnement du PTY : {e}");
        }
        Ok(json!({"cols": size.cols, "rows": size.rows}))
    }

    /// File d'entrée clavier du processus courant. L'appelant y envoie avec
    /// `send().await` : si `claude` ne lit pas assez vite, c'est lui qui
    /// attend, sans perte.
    pub fn input_sender(&self, id: &Uuid) -> Result<mpsc::Sender<Vec<u8>>, RpcError> {
        let reg = self.lock();
        let entry = reg
            .sessions
            .get(id)
            .ok_or_else(|| RpcError::unknown_session(id))?;
        entry
            .run
            .as_ref()
            .map(|r| r.input.clone())
            .ok_or_else(|| RpcError::new(error_code::INVALID_STATE, "la session ne tourne pas"))
    }

    /// Instantané, historique (si demandé) et abonnement à la sortie d'une
    /// session, pris ensemble.
    pub fn subscribe(&self, id: &Uuid, history: bool) -> Result<Subscription, RpcError> {
        let reg = self.lock();
        let entry = reg
            .sessions
            .get(id)
            .ok_or_else(|| RpcError::unknown_session(id))?;
        let (snap, hist, rx) = entry.terminal.subscribe_with_history(history);
        Ok((snap, hist, rx, entry.terminal.clone()))
    }

    // ------------------------------------------------------- hooks, statusline

    /// Trame de hook d'un relais. Ignorée (avec un avertissement) si le jeton
    /// est inconnu ou le JSON illisible.
    pub fn on_hook(&self, token: &str, event: &str, json: &[u8]) {
        let _ = self.apply_hook(token, event, json, false);
    }

    /// Trame `PermissionRequest` d'un relais : l'événement est appliqué, puis
    /// le relais est rattaché à la demande créée ou retrouvée (déduplication)
    /// et attend sa décision. `None` : rien à attendre (jeton inconnu, JSON
    /// illisible, session arrêtée, démon qui s'arrête) ; le relais est alors
    /// libéré sans décision.
    pub fn on_permission_request(&self, token: &str, json: &[u8]) -> Option<PermissionWait> {
        self.apply_hook(token, "PermissionRequest", json, true)
    }

    fn apply_hook(
        &self,
        token: &str,
        event: &str,
        json: &[u8],
        wait: bool,
    ) -> Option<PermissionWait> {
        let mut reg = self.lock();
        let Some(id) = reg.session_of(token) else {
            warning!("hook {event} avec un jeton inconnu, ignoré");
            return None;
        };
        let now = self.now();
        let entry = reg.sessions.get_mut(&id)?;
        let text = String::from_utf8_lossy(json);
        let event = match HookEvent::parse(&text, Some(event)) {
            Ok(ev) => ev,
            Err(e) => {
                warning!("session {id} : hook {event} illisible : {e}");
                return None;
            }
        };
        let mode_before = entry.session.state.permission_mode.clone();
        let applied = entry.session.apply_hook_tracked(&event, now);
        entry.updated_at = now;
        entry.release_resolved(&applied.effects);
        if let Some(mode) = &event.common.permission_mode {
            if mode_before.as_ref() != Some(mode) {
                if let Some(run) = &entry.run {
                    run.footer_reset.store(true, Ordering::SeqCst);
                }
                self.recheck_footer_after_hook(id, entry, mode);
            }
            // Un hook porte le mode : un `setMode` en cours est confirmé (ou démenti).
            if let Some((target, _)) = entry.mode_change.take()
                && &target != mode
            {
                warning!(
                    "session {id} : mode « {} » attendu après setMode, « {} » rapporté",
                    target.as_str(),
                    mode.as_str()
                );
            }
            // Mode dangereux sans autorisation (Shift+Tab dans la TUI, réglage
            // de l'utilisateur…) : on ne peut pas l'empêcher, on le signale.
            if mode.is_dangerous()
                && !self.config.allow_dangerous_modes
                && mode_before.as_ref() != Some(mode)
            {
                warning!(
                    "session {id} : mode dangereux « {} » détecté sans allow_dangerous_modes",
                    mode.as_str()
                );
                let _ = self.events.send(Event::Effect {
                    id,
                    effect: Arc::new(json!({
                        "type": "dangerous_mode_detected",
                        "mode": mode.as_str(),
                    })),
                });
            }
        }
        let mut handle = None;
        if wait
            && matches!(event.kind, HookKind::PermissionRequest(_))
            && !self.shutting_down.load(Ordering::SeqCst)
            && let Some(request) = applied.request
            && entry.session.state.pending_request(request).is_some()
        {
            let waiter = self.next_waiter.fetch_add(1, Ordering::SeqCst);
            let (tx, rx) = oneshot::channel();
            let list = entry.waiters.entry(request).or_default();
            list.push((waiter, tx));
            info!(
                "session {id} : relais rattaché à la demande {} ({} en attente)",
                request.0,
                list.len()
            );
            handle = Some(PermissionWait {
                session: id,
                request,
                waiter,
                decision: rx,
            });
        }
        self.emit_effects(id, &applied.effects);
        // Vue conversation : une action pour la pompe (aucune lecture ici).
        self.conversation_hook(id, &event, now);
        if applied.subagents == SubagentChange::Structural {
            self.persist_subagents(entry);
        }
        // Après le rattachement : le `session.updated` porte `answerable: true`.
        self.commit(entry);
        self.signal_subagents(id, applied.subagents);
        // Fichiers peut-être changés : diff recalculé (anti-rebond).
        if matches!(
            event.kind,
            HookKind::PostToolUse(_)
                | HookKind::PostToolUseFailure { .. }
                | HookKind::Stop { .. }
                | HookKind::StopFailure
        ) {
            self.schedule_diff_check(id, false);
        }
        // Fin de tour : `dirty` / `integrated` des worktrees du dépôt relus.
        if matches!(event.kind, HookKind::Stop { .. } | HookKind::StopFailure)
            && let Some(common) = entry.session.project_common_dir.clone()
        {
            let root = entry.session.project_root.clone();
            self.schedule_worktrees_check(common, root, false);
        }
        handle
    }

    /// Le relais `waiter` est parti (délai dépassé, Claude Code l'a tué) :
    /// il est détaché ; si plus aucun relais n'attend, la demande n'est plus
    /// répondable depuis l'app (`answerable: false`).
    pub fn detach_waiter(&self, session: Uuid, request: RequestId, waiter: u64) {
        let mut reg = self.lock();
        let Some(entry) = reg.sessions.get_mut(&session) else {
            return;
        };
        let Some(list) = entry.waiters.get_mut(&request) else {
            return;
        };
        list.retain(|(w, _)| *w != waiter);
        if list.is_empty() {
            entry.waiters.remove(&request);
            if entry.session.state.pending_request(request).is_some() {
                info!(
                    "session {session} : le relais de la demande {} est parti sans décision",
                    request.0
                );
                self.commit(entry);
            }
        }
    }

    // ------------------------------------------------- réponses depuis l'app

    /// `sessions.answerPermission {id, request_id, decision, message?}`.
    pub fn answer_permission(&self, params: &Value) -> Result<Value, RpcError> {
        let id = session_id_param(params)?;
        let request = request_id_param(params)?;
        let message = opt_str(params, "message")?;
        let answer = match opt_str(params, "decision")?.as_deref() {
            Some("allow") => PermissionAnswer::Allow,
            Some("allow_always") => PermissionAnswer::AllowAlways,
            Some("deny") => PermissionAnswer::Deny { message },
            Some(other) => {
                return Err(RpcError::params(format!(
                    "décision inconnue : {other} (attendu : allow, allow_always, deny)"
                )));
            }
            None => return Err(RpcError::params("« decision » manquant")),
        };
        self.answer(id, request, |pending| {
            decision::permission_decision(pending, &answer)
        })
    }

    /// `sessions.answerQuestion {id, request_id, answers}`.
    pub fn answer_question(&self, params: &Value) -> Result<Value, RpcError> {
        let id = session_id_param(params)?;
        let request = request_id_param(params)?;
        let answers = params
            .get("answers")
            .and_then(Value::as_object)
            .ok_or_else(|| RpcError::params("« answers » manquant (objet attendu)"))?
            .clone();
        self.answer(id, request, |pending| {
            decision::question_decision(pending, &answers)
        })
    }

    /// Construit la décision, la remet aux relais qui attendent, puis clôt la
    /// demande (`AnsweredByApp`). Rien ne change en cas d'erreur.
    fn answer(
        &self,
        id: Uuid,
        request: RequestId,
        build: impl FnOnce(&crate::domain::Pending) -> Result<Value, AnswerError>,
    ) -> Result<Value, RpcError> {
        let mut reg = self.lock();
        let entry = reg
            .sessions
            .get_mut(&id)
            .ok_or_else(|| RpcError::unknown_session(&id))?;
        let pending = entry
            .session
            .state
            .pending_request(request)
            .ok_or_else(|| RpcError::unknown_request(request))?;
        let output = build(&pending.pending)?;
        if !entry.answerable(request) {
            return Err(RpcError::not_answerable(request));
        }
        let bytes = serde_json::to_vec(&output)
            .map_err(|e| RpcError::new(error_code::INTERNAL_ERROR, e.to_string()))?;
        let mut delivered = 0;
        for (_, tx) in entry.waiters.remove(&request).unwrap_or_default() {
            if tx.send(Some(bytes.clone())).is_ok() {
                delivered += 1;
            }
        }
        if delivered == 0 {
            // Les relais sont partis entre-temps : la demande reste à la TUI.
            self.commit(entry);
            return Err(RpcError::not_answerable(request));
        }
        let now = self.now();
        let effects = entry
            .session
            .state
            .resolve_by_app(request, now)
            .ok_or_else(|| RpcError::unknown_request(request))?;
        entry.updated_at = now;
        entry.release_resolved(&effects);
        info!("session {id} : demande {} répondue depuis l'app", request.0);
        self.emit_effects(id, &effects);
        self.commit(entry);
        Ok(json!({"request_id": request.0, "resolved": true}))
    }

    /// `sessions.setMode {id, mode}` : nombre de Shift+Tab le long du cycle
    /// de la TUI ([`crate::domain::SHIFT_TAB_CYCLE`]) depuis le mode courant
    /// connu. Renvoie la file d'entrée du PTY et les octets à y écrire ; la
    /// confirmation viendra du pied de la TUI ([`Daemon::on_screen_mode`]) ou
    /// du `permission_mode` du hook suivant. Tant qu'un changement précédent
    /// n'est pas confirmé : [`SetModeError::Unconfirmed`] (l'appelant réessaie).
    pub fn set_mode(&self, params: &Value) -> Result<ModeKeys, SetModeError> {
        let id = session_id_param(params)?;
        let target = mode_param(params)?.ok_or_else(|| RpcError::params("« mode » manquant"))?;
        self.check_mode_allowed(Some(&target), false)?;
        let mut reg = self.lock();
        let entry = reg
            .sessions
            .get_mut(&id)
            .ok_or_else(|| RpcError::unknown_session(&id))?;
        if let Some((pending, at)) = &entry.mode_change
            && at.elapsed() < MODE_CHANGE_TIMEOUT
        {
            return Err(SetModeError::Unconfirmed(RpcError::new(
                error_code::INVALID_STATE,
                format!(
                    "changement de mode vers « {} » pas encore confirmé par Claude Code : réessayer après le prochain hook",
                    pending.as_str()
                ),
            )));
        }
        let run = entry
            .run
            .as_ref()
            .ok_or_else(|| RpcError::new(error_code::INVALID_STATE, "la session ne tourne pas"))?;
        if !entry.session.state.pending().is_empty() {
            return Err(RpcError::new(
                error_code::INVALID_STATE,
                "une demande attend une réponse : Shift+Tab agirait sur le dialogue de la TUI",
            )
            .into());
        }
        let current = entry.session.state.permission_mode.clone().ok_or_else(|| {
            RpcError::new(
                error_code::MODE_UNREACHABLE,
                "mode courant inconnu : attendre le prochain hook de la session",
            )
        })?;
        let steps = shift_tab_steps(&current, &target).ok_or_else(|| {
            RpcError::new(
                error_code::MODE_UNREACHABLE,
                format!(
                    "pas de passage de « {} » à « {} » par Shift+Tab (cycle : default, acceptEdits, plan, auto)",
                    current.as_str(),
                    target.as_str()
                ),
            )
        })?;
        let input = run.input.clone();
        if steps > 0 {
            entry.mode_change = Some((target, Instant::now()));
        }
        Ok((input, SHIFT_TAB.repeat(steps), steps))
    }

    /// Mode lu dans le pied de la TUI du processus `run_id` (voir
    /// [`mode_from_footer`]). Pendant un `setMode`, seul le mode visé est
    /// retenu (les modes traversés par plusieurs Shift+Tab sont ignorés) et
    /// il confirme le changement ; sinon tout mode lu est retenu (Shift+Tab
    /// tapé dans la TUI). Les hooks restent la source qui fait foi : ils
    /// écrasent ce mode dès qu'ils en portent un.
    pub fn on_screen_mode(&self, id: Uuid, run_id: u64, mode: PermissionMode) {
        let mut reg = self.lock();
        let Some(entry) = reg.sessions.get_mut(&id) else {
            return;
        };
        if entry.run.as_ref().is_none_or(|r| r.id != run_id) {
            return;
        }
        match &entry.mode_change {
            Some((target, _)) if *target != mode => return,
            Some(_) => entry.mode_change = None,
            None => {}
        }
        entry.screen_mode = Some((mode.clone(), Instant::now()));
        let current = entry.session.state.permission_mode.as_ref();
        // Un mode dangereux n'est jamais remplacé par une lecture de l'écran
        // (les hooks en restent seuls juges ; un vieux pied peut traîner).
        if current == Some(&mode) || current.is_some_and(PermissionMode::is_dangerous) {
            return;
        }
        info!(
            "session {id} : mode « {} » lu dans le pied de la TUI",
            mode.as_str()
        );
        entry.session.state.permission_mode = Some(mode);
        entry.updated_at = self.now();
        self.commit(entry);
    }

    /// Un hook vient de changer le mode en `hook_mode`. S'il contredit le pied
    /// de la TUI lu peu avant ([`STALE_HOOK_WINDOW`]), il a peut-être été
    /// émis avant le changement (hook en retard) : le pied est relu au bout
    /// de [`FOOTER_RECHECK_DELAY`] ([`Daemon::on_footer_recheck`]). Jamais
    /// pour un mode dangereux, dont les hooks restent seuls juges.
    fn recheck_footer_after_hook(&self, id: Uuid, entry: &Entry, hook_mode: &PermissionMode) {
        let Some((screen, at)) = &entry.screen_mode else {
            return;
        };
        if screen == hook_mode || hook_mode.is_dangerous() || at.elapsed() >= STALE_HOOK_WINDOW {
            return;
        }
        let (Some(run), Some(daemon)) = (&entry.run, self.me.upgrade()) else {
            return;
        };
        let (run_id, terminal, screen) = (run.id, entry.terminal.clone(), screen.clone());
        self.runtime.spawn(async move {
            tokio::time::sleep(FOOTER_RECHECK_DELAY).await;
            let seen = mode_from_footer(&terminal.bottom_rows(FOOTER_ROWS));
            daemon.on_footer_recheck(id, run_id, &screen, seen);
        });
    }

    /// Relecture du pied après un hook qui le contredisait : si le pied
    /// montre toujours le mode `screen` lu avant le hook, c'est lui qui
    /// l'emporte (le hook était en retard). Sinon le hook est gardé.
    fn on_footer_recheck(
        &self,
        id: Uuid,
        run_id: u64,
        screen: &PermissionMode,
        seen: Option<PermissionMode>,
    ) {
        let mut reg = self.lock();
        let Some(entry) = reg.sessions.get_mut(&id) else {
            return;
        };
        if entry.run.as_ref().is_none_or(|r| r.id != run_id) || seen.as_ref() != Some(screen) {
            return;
        }
        let current = entry.session.state.permission_mode.clone();
        if current.as_ref() == Some(screen) || current.as_ref().is_some_and(|m| m.is_dangerous()) {
            return;
        }
        warning!(
            "session {id} : hook en retard (mode « {} ») ; le pied de la TUI montre toujours « {} », gardé",
            current.as_ref().map_or("?", |m| m.as_str()),
            screen.as_str()
        );
        entry.screen_mode = Some((screen.clone(), Instant::now()));
        entry.session.state.permission_mode = Some(screen.clone());
        entry.updated_at = self.now();
        self.commit(entry);
    }

    /// Le Shift+Tab d'un `setMode` n'a pas pu être écrit : le changement
    /// attendu est abandonné (il n'empêche pas le suivant).
    pub fn cancel_mode_change(&self, id: &Uuid) {
        if let Some(entry) = self.lock().sessions.get_mut(id) {
            entry.mode_change = None;
        }
    }

    /// `sessions.update {id, title?, color?}` : clé absente = inchangé,
    /// `null` (ou titre vide) = effacé. Renvoie `{session}`.
    pub fn update_session(&self, params: &Value) -> Result<Value, RpcError> {
        let id = session_id_param(params)?;
        let title = match params.get("title") {
            None => None,
            Some(Value::Null) => Some(None),
            Some(Value::String(t)) => {
                Some(normalize_title(t).map_err(|e| RpcError::params(format!("« title » : {e}")))?)
            }
            Some(_) => return Err(RpcError::params("« title » doit être une chaîne ou null")),
        };
        let color = match params.get("color") {
            None => None,
            Some(Value::Null) => Some(None),
            Some(Value::String(c)) if is_session_color(c) => Some(Some(c.clone())),
            Some(_) => {
                return Err(RpcError::params(format!(
                    "« color » : une couleur parmi {}, ou null",
                    SESSION_COLORS.join(", ")
                )));
            }
        };
        if title.is_none() && color.is_none() {
            return Err(RpcError::params(
                "rien à modifier : « title » ou « color » attendu",
            ));
        }
        let mut reg = self.lock();
        let entry = reg
            .sessions
            .get_mut(&id)
            .ok_or_else(|| RpcError::unknown_session(&id))?;
        let before = (entry.session.title.clone(), entry.session.color.clone());
        if let Some(t) = title {
            entry.session.title = t;
        }
        if let Some(c) = color {
            entry.session.color = c;
        }
        // `updated_at` reste inchangé : renommer une session ne la fait pas
        // remonter dans `sessions.list`.
        if (entry.session.title.clone(), entry.session.color.clone()) != before {
            self.commit(entry);
        }
        Ok(json!({"session": entry.json()}))
    }

    /// Trame de statusline d'un relais.
    pub fn on_statusline(&self, token: &str, json: &[u8]) {
        let mut reg = self.lock();
        let Some(id) = reg.session_of(token) else {
            return;
        };
        let Some(entry) = reg.sessions.get_mut(&id) else {
            return;
        };
        match Statusline::parse(&String::from_utf8_lossy(json)) {
            Ok(s) => {
                let before = entry.session.metrics.clone();
                entry.session.apply_statusline(&s);
                if entry.session.metrics != before {
                    self.commit(entry);
                }
                if let Some(reading) =
                    crate::domain::reading_from_rate_limits(&s.metrics.rate_limits)
                {
                    let profile = entry.session.profile.clone();
                    let now = self.now();
                    self.update_quotas(|q| {
                        q.entry(profile).or_default().merge(
                            reading,
                            crate::domain::QuotaOrigin::Statusline,
                            now,
                        );
                    });
                }
            }
            Err(e) => warning!("session {id} : statusline illisible : {e}"),
        }
    }

    // ------------------------------------------------------- fin de processus

    async fn on_exit(self: Arc<Self>, id: Uuid, run_id: u64) {
        let stopped = {
            let reg = self.lock();
            reg.sessions
                .get(&id)
                .is_some_and(|e| e.session.state.is_stopped())
        };
        if !stopped {
            // Laisse arriver un SessionEnd encore en route.
            tokio::time::sleep(self.config.exit_grace).await;
        }
        let mut reg = self.lock();
        let status = reg
            .sessions
            .get(&id)
            .and_then(|e| e.run.as_ref())
            .filter(|r| r.id == run_id)
            .and_then(Run::exit_status);
        if let Some(status) = status {
            self.finalize_exit(&mut reg, id, run_id, status);
        }
    }

    /// Constate la fin du processus `run_id` (une seule fois).
    fn finalize_exit(&self, reg: &mut Registry, id: Uuid, run_id: u64, status: ExitStatus) {
        let Some(entry) = reg.sessions.get_mut(&id) else {
            return;
        };
        let Some(run) = entry.run.as_ref().filter(|r| r.id == run_id) else {
            return;
        };
        let exit = if run.stop_requested || self.shutting_down.load(Ordering::SeqCst) {
            ProcessExit::Requested
        } else {
            match &status {
                ExitStatus::Code(c) => ProcessExit::Code(*c),
                ExitStatus::Signal(s) => ProcessExit::Signal(s.clone()),
            }
        };
        let now = self.now();
        let running_before = entry.session.state.subagents().running_count();
        let effects = entry.session.state.process_exited(&exit, now);
        let subagents_changed = entry.session.state.subagents().running_count() != running_before;
        if subagents_changed {
            self.persist_subagents(entry);
        }
        entry.release_resolved(&effects);
        entry.release_all();
        entry.run = None;
        entry.last_exit = Some(status.clone());
        entry.updated_at = now;
        let token = entry.token.take();
        let how = match &status {
            ExitStatus::Code(c) => format!("code {c}"),
            ExitStatus::Signal(sig) => format!("signal {sig}"),
        };
        info!("session {id} : processus terminé ({how})");
        self.emit_effects(id, &effects);
        self.commit(entry);
        if subagents_changed {
            self.signal_subagents(id, SubagentChange::Structural);
        }
        // `resumable` relu hors du verrou (système de fichiers).
        if let Some(daemon) = self.me.upgrade() {
            self.runtime
                .spawn_blocking(move || daemon.refresh_resumable(Some(id)));
        }
        if let Some(t) = token {
            reg.forget_token(&t);
        }
        if let Some(e) = reg.sessions.get(&id)
            && let Some(common) = e.session.project_common_dir.clone()
        {
            let root = e.session.project_root.clone();
            self.schedule_worktrees_check(common, root, false);
        }
    }

    /// Nombre de sessions dont le processus tourne.
    pub fn running_count(&self) -> usize {
        self.lock()
            .sessions
            .values()
            .filter(|e| e.run.is_some())
            .count()
    }

    fn running_pids(&self) -> Vec<u32> {
        self.lock()
            .sessions
            .values()
            .filter_map(|e| e.run.as_ref().and_then(|r| r.pid))
            .collect()
    }

    /// `SIGKILL` immédiat à toutes les sessions (second signal d'arrêt).
    pub fn kill_all(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        for pid in self.running_pids() {
            self.signal_group(pid, nix::sys::signal::Signal::SIGKILL);
        }
    }

    /// Arrêt du démon : `SIGHUP` à toutes les sessions, attente, puis
    /// `SIGKILL`. Les sessions restent reprenables.
    pub async fn shutdown(self: &Arc<Self>) {
        self.shutting_down.store(true, Ordering::SeqCst);
        let pids: Vec<u32> = {
            let mut reg = self.lock();
            // Les relais en attente rendent la main tout de suite, sans décision.
            for entry in reg.sessions.values_mut() {
                entry.release_all();
            }
            reg.sessions
                .values_mut()
                .filter_map(|e| e.run.as_mut())
                .filter_map(|r| {
                    r.stop_requested = true;
                    r.pid
                })
                .collect()
        };
        if pids.is_empty() {
            return;
        }
        info!("arrêt : SIGHUP à {} session(s)", pids.len());
        for pid in &pids {
            self.signal_group(*pid, nix::sys::signal::Signal::SIGHUP);
        }
        let deadline = tokio::time::Instant::now() + self.config.stop_timeout;
        while self.running_count() > 0 && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        if self.running_count() == 0 {
            return;
        }
        for pid in self.running_pids() {
            self.signal_group(pid, nix::sys::signal::Signal::SIGKILL);
        }
        let deadline =
            tokio::time::Instant::now() + self.config.exit_grace + Duration::from_secs(1);
        while self.running_count() > 0 && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        self.mark_all_stopped();
    }

    /// Dernier recours : les processus restants sont marqués arrêtés.
    pub fn mark_all_stopped(&self) {
        let now = self.now();
        let mut reg = self.lock();
        for entry in reg.sessions.values_mut().filter(|e| e.run.is_some()) {
            let running_before = entry.session.state.subagents().running_count();
            entry
                .session
                .state
                .process_exited(&ProcessExit::Requested, now);
            let subagents_changed =
                entry.session.state.subagents().running_count() != running_before;
            if subagents_changed {
                self.persist_subagents(entry);
            }
            entry.release_all();
            entry.run = None;
            entry.updated_at = now;
            self.commit(entry);
            if subagents_changed {
                self.signal_subagents(entry.session.id, SubagentChange::Structural);
            }
        }
    }
}

/// Installe un processus lancé dans l'entrée (après succès du lancement).
fn install_run(reg: &mut Registry, entry: &mut Entry, run: Run, token: String, plan: Plan) {
    if let Some(old) = entry.token.take() {
        reg.forget_token(&old);
    }
    reg.by_token.push((token.clone(), entry.session.id));
    entry.token = Some(token);
    entry.run = Some(run);
    entry.orphan = None;
    entry.mode_change = None;
    entry.screen_mode = None;
    entry.last_exit = None;
    entry.session.cwd = plan.cwd;
    entry.session.profile = plan.profile.name;
    let previous = std::mem::take(&mut entry.session.state);
    entry.session.state = SessionState::restored(
        SessionStatus::Starting,
        plan.mode.or_else(|| previous.permission_mode.clone()),
        previous.last_activity,
    );
    // Les sous-agents restent (ordre de lancement continué) ; ceux qui
    // tournaient encore sont déjà passés `interrupted` à la fin du processus.
    let now = previous.last_activity.unwrap_or(entry.updated_at);
    entry.session.state.carry_subagents_from(previous, now);
    if plan.model.is_some() {
        entry.model = plan.model;
    }
}

/// Projet probable d'un dossier qui n'existe plus (worktree supprimé), sans
/// rien créer. Soit `missing` le premier composant manquant du chemin, et
/// `ancestor` son parent (le plus proche ancêtre existant) :
/// 1. un voisin : si `missing` s'appelle `<nom>--<suffixe>` ou
///    `<nom>.<suffixe>`, le dossier `<ancestor>/<nom>` s'il est la racine d'un
///    dépôt git (préfixe le plus long d'abord) ;
/// 2. sinon le dépôt qui contient `ancestor`, seulement si le chemin est
///    rangé comme un worktree : sous `<racine>/.worktrees/`,
///    `<racine>/.claude/worktrees/`, ou directement sous `<racine>` (un dépôt
///    lointain, comme un dépôt de fichiers de configuration dans `~`, n'est
///    pas retenu pour `~/a/b/c`).
fn infer_missing_project(
    path: &Path,
    is_dir: &dyn Fn(&Path) -> bool,
    resolve: &dyn Fn(&Path) -> Option<crate::ports::RepoInfo>,
) -> Option<crate::ports::RepoInfo> {
    let mut missing = path;
    let ancestor = loop {
        let parent = missing.parent()?;
        if is_dir(parent) {
            break parent;
        }
        missing = parent;
    };
    let name = missing.file_name()?.to_str()?;
    let mut cuts: Vec<usize> = name
        .match_indices("--")
        .map(|(i, _)| i)
        .chain(name.match_indices('.').map(|(i, _)| i))
        .filter(|i| *i > 0)
        .collect();
    cuts.sort_unstable_by(|a, b| b.cmp(a));
    cuts.dedup();
    let sibling = cuts.into_iter().find_map(|i| {
        let candidate = ancestor.join(&name[..i]);
        if !is_dir(&candidate) {
            return None;
        }
        resolve(&candidate).filter(|r| r.worktree_root == candidate)
    });
    if sibling.is_some() {
        return sibling;
    }
    let repo = resolve(ancestor)?;
    let root = &repo.worktree_root;
    let worktree_like = ancestor == root.as_path()
        || path.starts_with(root.join(".worktrees"))
        || path.starts_with(root.join(".claude/worktrees"));
    worktree_like.then_some(repo)
}

fn display_name(root: &Path) -> String {
    crate::domain::Project::from_root(root).display_name
}

fn spawn_thread(name: &str, f: impl FnOnce() + Send + 'static) {
    if let Err(e) = std::thread::Builder::new().name(name.to_owned()).spawn(f) {
        error!("création du fil {name} : {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_project_is_inferred_without_creating_anything() {
        use crate::ports::RepoInfo;
        let repo = |root: &str| RepoInfo {
            worktree_root: root.into(),
            common_dir: format!("{root}/.git").into(),
            project_root: root.into(),
            branch: None,
        };
        let dirs = [
            "/",
            "/home",
            "/home/u",
            "/home/u/proj",
            "/home/u/proj/src",
            "/home/u/proj/.worktrees",
            "/home/u/proj/.claude",
            "/home/u/proj/.claude/worktrees",
            "/home/u/autre",
        ];
        let is_dir = |p: &Path| dirs.iter().any(|d| Path::new(d) == p);
        // `~` est un dépôt de fichiers de configuration ; `proj` un dépôt.
        let resolve = |p: &Path| {
            if p.starts_with("/home/u/proj") {
                Some(repo("/home/u/proj"))
            } else if p.starts_with("/home/u") {
                Some(repo("/home/u"))
            } else {
                None
            }
        };
        let infer = |p: &str| {
            infer_missing_project(Path::new(p), &is_dir, &resolve).map(|r| r.project_root)
        };
        let proj = Some(PathBuf::from("/home/u/proj"));
        // Rangés comme des worktrees du dépôt.
        assert_eq!(infer("/home/u/proj/.worktrees/feat/src"), proj);
        assert_eq!(infer("/home/u/proj/.claude/worktrees/x"), proj);
        assert_eq!(infer("/home/u/proj/wt-ancien"), proj);
        // Voisins `<nom>--<suffixe>` et `<nom>.<suffixe>`, avant le dépôt de `~`.
        assert_eq!(infer("/home/u/proj--feature-x/src"), proj);
        assert_eq!(infer("/home/u/proj.wt"), proj);
        assert_eq!(infer("/home/u/proj--a--b"), proj);
        // Dossier profond du dépôt : pas rangé comme un worktree.
        assert_eq!(infer("/home/u/proj/src/vieux/x"), None);
        // Pas de voisin (`~/autre` n'est pas une racine de dépôt) ; chemin
        // directement sous `~` (dépôt de configuration) : retenu.
        assert_eq!(infer("/home/u/autre--x"), Some(PathBuf::from("/home/u")));
        // Profond sous `~` : le dépôt de configuration n'est pas retenu.
        assert_eq!(infer("/home/u/autre/a/b"), None);
        assert_eq!(infer("/nulle/part"), None);
    }

    #[test]
    fn status_record_roundtrip() {
        for s in [
            SessionStatus::Starting,
            SessionStatus::Running,
            SessionStatus::Idle,
            SessionStatus::Error,
            SessionStatus::Stopped {
                reason: Some("prompt_input_exit".into()),
            },
        ] {
            let (name, reason) = status_record(&s);
            assert_eq!(status_from_record(&name, reason), s);
        }
        assert_eq!(
            status_record(&SessionStatus::Waiting(WaitKind::Question)).0,
            "waiting"
        );
    }

    #[test]
    fn params() {
        assert_eq!(
            size_param(&json!({"cols": 120}), DEFAULT_SIZE).unwrap(),
            TermSize {
                cols: 120,
                rows: 24
            }
        );
        assert!(size_param(&json!({"rows": 0}), DEFAULT_SIZE).is_err());
        assert!(size_param(&json!({"rows": "x"}), DEFAULT_SIZE).is_err());
        assert_eq!(
            mode_param(&json!({"mode": "default"})).unwrap(),
            Some(PermissionMode::Default)
        );
        assert!(mode_param(&json!({"mode": "nimporte"})).is_err());
        assert!(opt_str(&json!({"cwd": 3}), "cwd").is_err());
        assert!(session_id_param(&json!({"id": "pas-un-uuid"})).is_err());
    }

    #[test]
    fn tokens_are_random_hex_and_compared_in_constant_time() {
        let a = new_token().unwrap();
        assert_eq!(a.len(), 32);
        assert!(a.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_ne!(a, new_token().unwrap());
        assert!(ct_eq(b"abc", b"abc"));
        assert!(!ct_eq(b"abc", b"abd"));
        assert!(!ct_eq(b"abc", b"ab"));
        let id = Uuid::from_u128(1);
        let mut reg = Registry::default();
        reg.by_token.push((a.clone(), id));
        assert_eq!(reg.session_of(&a), Some(id));
        assert_eq!(reg.session_of("autre"), None);
        reg.forget_token(&a);
        assert_eq!(reg.session_of(&a), None);
    }

    #[test]
    fn only_significant_changes_force_a_write() {
        let r = SessionRecord {
            id: Uuid::from_u128(1),
            claude_session_id: "c".into(),
            profile: "default".into(),
            cwd: "/p".into(),
            project_root: "/p".into(),
            branch: None,
            model: None,
            mode: None,
            status: "running".into(),
            status_reason: None,
            created_at: OffsetDateTime::UNIX_EPOCH,
            updated_at: OffsetDateTime::UNIX_EPOCH,
            last_activity: None,
            pid: None,
            pid_start: None,
            scope_unit: None,
            title: None,
            color: None,
            first_prompt: None,
            session_name: None,
            project_common_dir: None,
            issue: None,
        };
        let mut later = r.clone();
        later.updated_at = OffsetDateTime::now_utc();
        later.last_activity = Some(OffsetDateTime::now_utc());
        assert_eq!(significant(&r), significant(&later));
        later.status = "idle".into();
        assert_ne!(significant(&r), significant(&later));
    }
}
