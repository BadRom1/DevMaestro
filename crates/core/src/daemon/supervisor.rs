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
use tokio::sync::{broadcast, mpsc};
use uuid::Uuid;

use super::claude_config;
use super::launch::{self, LaunchKind, LaunchSpec};
use super::log::{error, info, warning};
use super::terminal::{Chunk, RESUME_RESET, Snapshot, Terminal};
use crate::domain::HookEvent;
use crate::domain::{
    PermissionMode, ProcessExit, Profile, REASON_DAEMON_RESTART, Session, SessionState,
    SessionStatus, Statusline, WaitKind,
};
use crate::paths::Paths;
use crate::ports::{
    Clock, ExitStatus, ProfileSource, PtyControl, PtySpawner, SessionRecord, SessionStore,
    TermSize, TranscriptSource, Vcs,
};
use crate::protocol::error_code;
use crate::protocol::json::{
    effect_json, metrics_json, past_session_json, pending_request_json, profile_json, status_json,
    time_json,
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
}

impl RpcError {
    pub fn new(code: i64, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
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
}

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
}

/// Adaptateurs utilisés par le démon.
pub struct Deps {
    pub pty: Box<dyn PtySpawner>,
    pub vcs: Box<dyn Vcs>,
    pub profiles: Box<dyn ProfileSource + Send + Sync>,
    pub transcripts: Box<dyn TranscriptSource + Send + Sync>,
    pub store: Box<dyn SessionStore + Sync>,
    pub clock: Box<dyn Clock + Send + Sync>,
}

/// Événement diffusé aux connexions. Léger : une connexion lente regroupe
/// les `Updated` d'une même session et relit l'état au moment d'envoyer.
#[derive(Debug, Clone)]
pub enum Event {
    /// La session a changé (`session.updated`).
    Updated(Uuid),
    /// Effet de la machine à états (`session.effect`).
    Effect { id: Uuid, effect: Arc<Value> },
}

/// Un processus `claude` en cours.
struct Run {
    id: u64,
    pid: Option<u32>,
    control: Box<dyn PtyControl>,
    input: mpsc::Sender<Vec<u8>>,
    stop_requested: bool,
    /// Code de sortie, posé par le fil d'attente dès la fin du processus
    /// (avant que le démon ne la constate).
    exited: Arc<Mutex<Option<ExitStatus>>>,
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
}

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
    shutting_down: AtomicBool,
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

fn signal_group(pid: u32, sig: nix::sys::signal::Signal) {
    let pgid = nix::unistd::Pid::from_raw(pid as i32);
    if nix::sys::signal::killpg(pgid, sig).is_err() {
        let _ = nix::sys::signal::kill(pgid, sig);
    }
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
            pid: self.run.as_ref().and_then(|r| r.pid),
        }
    }

    fn json(&self) -> Value {
        let s = &self.session;
        let size = self.terminal.size();
        json!({
            "id": s.id,
            "claude_session_id": s.claude_session_id,
            "profile": s.profile,
            "cwd": s.cwd,
            "project_root": s.project_root,
            "branch": s.branch,
            "model": self.model,
            "mode": s.state.permission_mode.as_ref().map(|m| m.as_str()),
            "status": status_json(&s.state.status()),
            "pending": s.state.pending().iter().map(pending_request_json).collect::<Vec<_>>(),
            "possibly_stale": s.state.possibly_stale(),
            "metrics": metrics_json(&s.metrics),
            "last_activity": time_json(s.state.last_activity),
            "created_at": time_json(Some(self.created_at)),
            "updated_at": time_json(Some(self.updated_at)),
            "alive": self.run.is_some(),
            "pid": self.run.as_ref().and_then(|r| r.pid),
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
        Arc::new(Self {
            config,
            deps,
            registry: Mutex::new(Registry::default()),
            events,
            runtime: tokio::runtime::Handle::current(),
            next_run: AtomicU64::new(1),
            shutting_down: AtomicBool::new(false),
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
        if let Err(e) = claude_config::write_plugin(&self.config.paths.plugin_dir(), orchd) {
            error!("écriture du plugin Claude Code : {e}");
        }
        match self.deps.profiles.profiles() {
            Ok(profiles) => {
                for p in profiles {
                    let path = self.config.paths.settings_for(&p.name);
                    if let Err(e) = claude_config::write_settings(&path, orchd, &p) {
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
        let mut reg = self.lock();
        for r in records {
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
            session.state = SessionState::restored(
                status,
                r.mode.as_deref().map(PermissionMode::parse),
                r.last_activity,
            );
            let mut entry = Entry::new(session, Terminal::new(DEFAULT_SIZE), r.created_at);
            entry.model = r.model.clone();
            entry.updated_at = if was_active { now } else { r.updated_at };
            entry.persisted = Some((r, Instant::now()));
            if was_active {
                let record = entry.record();
                if let Err(e) = self.deps.store.upsert(&record) {
                    error!("écriture de la session {} en base : {e}", record.id);
                }
                entry.persisted = Some((record, Instant::now()));
            }
            reg.sessions.insert(entry.session.id, entry);
        }
        info!("{} session(s) relue(s) depuis la base", reg.sessions.len());
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
        let path = path.canonicalize().map_err(|e| {
            RpcError::params(format!("dossier introuvable : {} ({e})", path.display()))
        })?;
        Ok(match self.deps.vcs.resolve(&path) {
            Some(repo) => json!({
                "path": path,
                "is_git": true,
                "root": repo.project_root,
                "worktree_root": repo.worktree_root,
                "common_dir": repo.common_dir,
                "branch": repo.branch,
                "name": display_name(&repo.project_root),
            }),
            None => json!({
                "path": path,
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

    /// `transcripts.list`.
    pub fn transcripts(&self, profile: &str, limit: Option<usize>) -> Result<Value, RpcError> {
        let profile = self.profile(profile)?;
        let past = self
            .deps
            .transcripts
            .past_sessions(&profile, limit)
            .map_err(|e| RpcError::new(error_code::INTERNAL_ERROR, e.to_string()))?;
        Ok(json!({
            "profile": profile.name,
            "sessions": past.iter().map(past_session_json).collect::<Vec<_>>(),
        }))
    }

    // ------------------------------------------------------ lancement, reprise

    fn claude_bin(&self) -> Result<PathBuf, RpcError> {
        launch::find_claude(
            self.config.claude_bin_env.clone(),
            self.config.path_env.clone(),
        )
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

    /// `sessions.launch`.
    pub fn launch(self: &Arc<Self>, params: &Value) -> Result<Value, RpcError> {
        self.refuse_if_shutting_down()?;
        let cwd = opt_str(params, "cwd")?.ok_or_else(|| RpcError::params("« cwd » manquant"))?;
        let cwd = canonical_cwd(&cwd)?;
        let profile_name = opt_str(params, "profile")?
            .unwrap_or_else(|| crate::domain::profile::DEFAULT_PROFILE_NAME.to_owned());
        let id = Uuid::new_v4();
        let plan = Plan {
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
        let repo = self.deps.vcs.resolve(&cwd);
        let mut session = Session::new(
            id,
            id.to_string(),
            repo.as_ref()
                .map_or_else(|| cwd.clone(), |r| r.project_root.clone()),
            cwd,
            plan.profile.name.clone(),
        );
        session.branch = repo.and_then(|r| r.branch);
        let mut entry = Entry::new(session, Terminal::new(plan.size), self.now());

        let mut reg = self.lock();
        let (run, token) = self.spawn_run(id, &entry.terminal, &plan, false)?;
        install_run(&mut reg, &mut entry, run, token, plan);
        info!(
            "session {id} lancée dans {} (profil {})",
            entry.session.cwd.display(),
            entry.session.profile
        );
        self.commit(&mut entry);
        let result = json!({"session": entry.json()});
        reg.sessions.insert(id, entry);
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
            .map(|c| canonical_cwd(&c))
            .transpose()?;
        let profile_param = opt_str(params, "profile")?;
        let mode_param = mode_param(params)?;
        let model_param = opt_str(params, "model")?.filter(|m| !m.is_empty());
        let prompt = opt_str(params, "prompt")?.filter(|p| !p.is_empty());
        let size_given = params.get("cols").is_some() || params.get("rows").is_some();
        let size_param = size_param(params, DEFAULT_SIZE)?;
        let claude = self.claude_bin()?;

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
            let plan = Plan {
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
            let terminal = entry.terminal.clone();
            let (run, token) = self.spawn_run(id, &terminal, &plan, true)?;
            let now = self.now();
            let mut entry = reg.sessions.remove(&id).expect("présente");
            install_run(&mut reg, &mut entry, run, token, plan);
            entry.updated_at = now;
            info!(
                "session {id} reprise (claude {})",
                entry.session.claude_session_id
            );
            self.commit(&mut entry);
            let result = json!({"session": entry.json()});
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
        let plan = Plan {
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
        let repo = self.deps.vcs.resolve(&cwd);
        let id = Uuid::new_v4();
        let mut session = Session::new(
            id,
            cid,
            repo.as_ref()
                .map_or_else(|| cwd.clone(), |r| r.project_root.clone()),
            cwd,
            plan.profile.name.clone(),
        );
        session.branch = repo.and_then(|r| r.branch);
        let mut entry = Entry::new(session, Terminal::new(plan.size), self.now());
        let (run, token) = self.spawn_run(id, &entry.terminal, &plan, false)?;
        install_run(&mut reg, &mut entry, run, token, plan);
        info!(
            "ancienne session {} reprise sous {id}",
            entry.session.claude_session_id
        );
        self.commit(&mut entry);
        let result = json!({"session": entry.json()});
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
        claude_config::write_plugin(&plugin_dir, &self.config.orchd_exe)
            .and_then(|()| {
                claude_config::write_settings(&settings, &self.config.orchd_exe, &plan.profile)
            })
            .map_err(|e| RpcError::launch(format!("écriture du plugin ou des réglages : {e}")))?;

        let token = new_token()?;
        let socket = paths.socket();
        let session_str = id.to_string();
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
        });
        let spawned = self.deps.pty.spawn(&command, plan.size).map_err(|e| {
            RpcError::launch(format!("lancement de {} : {e}", plan.claude.display()))
        })?;

        let run_id = self.next_run.fetch_add(1, Ordering::SeqCst);
        let pid = spawned.child.pid();
        terminal.resize(plan.size);
        if reset {
            // Avant le premier octet du nouveau processus (le lecteur n'est pas encore lancé).
            terminal.feed(RESUME_RESET);
        }

        // Lecteur du PTY : alimente le terminal, ne bloque jamais sur les clients.
        let term = terminal.clone();
        let mut reader = spawned.reader;
        spawn_thread(&format!("pty-lecture-{run_id}"), move || {
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => term.feed(&buf[..n]),
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
                signal_group(pid, nix::sys::signal::Signal::SIGHUP);
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
                stop_requested: false,
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
        let Some(run) = entry.run.as_mut() else {
            return Ok(json!({"stopping": false, "alive": false}));
        };
        run.stop_requested = true;
        if let Some(pid) = run.pid {
            signal_group(pid, nix::sys::signal::Signal::SIGHUP);
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
                    signal_group(pid, nix::sys::signal::Signal::SIGKILL);
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
        let mut reg = self.lock();
        let Some(id) = reg.session_of(token) else {
            warning!("hook {event} avec un jeton inconnu, ignoré");
            return;
        };
        let now = self.now();
        let Some(entry) = reg.sessions.get_mut(&id) else {
            return;
        };
        let text = String::from_utf8_lossy(json);
        let event = match HookEvent::parse(&text, Some(event)) {
            Ok(ev) => ev,
            Err(e) => {
                warning!("session {id} : hook {event} illisible : {e}");
                return;
            }
        };
        let effects = entry.session.apply_hook(&event, now);
        entry.updated_at = now;
        self.emit_effects(id, &effects);
        self.commit(entry);
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
        let effects = entry.session.state.process_exited(&exit, now);
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
        if let Some(t) = token {
            reg.forget_token(&t);
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
            signal_group(pid, nix::sys::signal::Signal::SIGKILL);
        }
    }

    /// Arrêt du démon : `SIGHUP` à toutes les sessions, attente, puis
    /// `SIGKILL`. Les sessions restent reprenables.
    pub async fn shutdown(self: &Arc<Self>) {
        self.shutting_down.store(true, Ordering::SeqCst);
        let pids: Vec<u32> = {
            let mut reg = self.lock();
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
            signal_group(*pid, nix::sys::signal::Signal::SIGHUP);
        }
        let deadline = tokio::time::Instant::now() + self.config.stop_timeout;
        while self.running_count() > 0 && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        if self.running_count() == 0 {
            return;
        }
        for pid in self.running_pids() {
            signal_group(pid, nix::sys::signal::Signal::SIGKILL);
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
            entry
                .session
                .state
                .process_exited(&ProcessExit::Requested, now);
            entry.run = None;
            entry.updated_at = now;
            self.commit(entry);
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
    entry.last_exit = None;
    entry.session.cwd = plan.cwd;
    entry.session.profile = plan.profile.name;
    entry.session.state = SessionState::restored(
        SessionStatus::Starting,
        plan.mode
            .or_else(|| entry.session.state.permission_mode.clone()),
        entry.session.state.last_activity,
    );
    if plan.model.is_some() {
        entry.model = plan.model;
    }
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
        };
        let mut later = r.clone();
        later.updated_at = OffsetDateTime::now_utc();
        later.last_activity = Some(OffsetDateTime::now_utc());
        assert_eq!(significant(&r), significant(&later));
        later.status = "idle".into();
        assert_ne!(significant(&r), significant(&later));
    }
}
