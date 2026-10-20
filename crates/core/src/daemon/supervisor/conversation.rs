//! Vue conversation côté démon (v0.3, lot 10, ADR 0005) : suivi des
//! transcripts, `conversation.get`, `conversation.subagent`,
//! `conversation.full` et `conversation.changed`.
//!
//! - La normalisation est dans le domaine ([`crate::domain::conversation`]) ;
//!   la lecture des fichiers dans l'adaptateur ([`crate::ports::TranscriptFollower`]).
//! - Chaque conversation a son propre verrou ([`ConvState`]) : aucune
//!   lecture de fichier sous le verrou du registre. Les hooks n'y déposent
//!   qu'une action ([`Daemon::conversation_hook`]) ; la pompe
//!   ([`Daemon::start_conversation_follow`]) les applique et lit les
//!   fichiers hors du runtime (`spawn_blocking`).
//! - Fichiers lus : seulement le transcript des sessions connues
//!   (`transcript_path` du dernier `SessionStart`, à défaut retrouvé par
//!   l'identifiant Claude) et les fichiers de leurs sous-agents, tous
//!   résolus sous `<dossier du profil>/projects/`.
//! - Réveil par la surveillance des dossiers (`notify`) et par chaque hook,
//!   puis lecture [`GROUP_DELAY`] plus tard (les changements sont regroupés) ;
//!   scrutation de secours toutes les [`POLL_INTERVAL`] (taille comparée au
//!   décalage). Une session suivie le reste [`FOLLOW_GRACE`] après la fin
//!   de son processus.
//! - Les notifications sont calculées par connexion depuis sa propre
//!   révision (posée par `conversation.get`) : un client lent ne perd rien,
//!   il reçoit tout ce qui a changé depuis, regroupé.
//! - Jamais de contenu de transcript dans le journal : des compteurs.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use time::OffsetDateTime;
use uuid::Uuid;

use super::{Daemon, Event, RpcError, opt_str, session_id_param};
use crate::domain::conversation::{Conversation, Limits, Part, full_text, is_agent_id};
use crate::domain::{HookEvent, HookKind};
use crate::ports::TailPos;
use crate::protocol::json::{conversation_entry_json, segment_json, time_json};
use crate::protocol::{error_code, notification};

/// Regroupement des changements après un réveil.
pub const GROUP_DELAY: Duration = Duration::from_millis(100);
/// Scrutation de secours des fichiers suivis.
pub const POLL_INTERVAL: Duration = Duration::from_millis(250);
/// Suivi gardé après la fin du processus (dernières lignes écrites).
pub const FOLLOW_GRACE: Duration = Duration::from_secs(5);
/// `limit` par défaut et maximal de `conversation.get`.
pub const DEFAULT_LIMIT: u64 = 200;
pub const MAX_LIMIT: u64 = 1000;
/// Taille maximale des entrées d'une réponse ou d'une notification (le reste
/// suit : `has_more`, ou notification suivante) ; une trame fait 16 Mio au plus.
pub const MAX_PAYLOAD_BYTES: usize = 8 * 1024 * 1024;
/// Conversations de sessions arrêtées gardées en mémoire au plus.
pub const MAX_IDLE_CONVERSATIONS: usize = 8;
/// Actions en attente par session, au plus.
const MAX_ACTIONS: usize = 256;
/// `.meta.json` d'un sous-agent lu au plus.
const META_MAX_BYTES: u64 = 64 * 1024;

/// Ce qu'un hook demande au suivi.
#[derive(Debug, Clone)]
pub(super) enum ConvAction {
    /// `SessionStart` : fichier (peut-être nouveau) et raison.
    Start(StartRequest),
    /// `SubagentStart` : suivre le fichier de ce sous-agent.
    Subagent(String),
    /// Tout autre hook : de nouvelles lignes sont peut-être là ; son
    /// `transcript_path` sert d'indice si le transcript n'est pas encore trouvé.
    Wake {
        claude_session_id: String,
        transcript_path: Option<String>,
    },
}

/// Ouverture d'un segment demandée (`SessionStart`), gardée tant que son
/// transcript n'est pas trouvé (pas encore écrit).
#[derive(Debug, Clone)]
pub(super) struct StartRequest {
    claude_session_id: String,
    transcript_path: Option<String>,
    source: Option<String>,
    at: Option<String>,
}

/// Un fichier suivi (une source de la conversation).
#[derive(Debug)]
struct Tracked {
    path: PathBuf,
    pos: TailPos,
    /// Sous-agent dont c'est le fichier (`None` : transcript principal).
    agent: Option<String>,
    /// Lu : principal du segment courant, ou sous-agent activé (lancé
    /// pendant le suivi, `SubagentStart`, ou demandé par `conversation.subagent`).
    active: bool,
    /// `.meta.json` lu (rattachement par `toolUseId`).
    linked: bool,
    /// Segment où ranger ses lignes.
    segment: u32,
    /// Fichier principal : première recherche de ses sous-agents faite (ceux
    /// trouvés alors, déjà finis, ne sont lus qu'à la demande).
    scanned: bool,
    /// Erreurs de lecture déjà signalées (une alerte par genre).
    errors: HashSet<std::io::ErrorKind>,
}

/// Conversation d'une session et ses fichiers.
pub(super) struct ConvState {
    conv: Conversation,
    /// `<dossier du profil>/projects`, résolu (il peut ne pas exister encore).
    root: PathBuf,
    profile: String,
    /// Indice = source de la conversation.
    files: Vec<Tracked>,
    /// Source principale courante.
    current: Option<u32>,
    /// Source de chaque sous-agent connu.
    agents: HashMap<String, u32>,
    /// `SessionStart` dont le transcript n'est pas encore trouvé : réessayé
    /// à chaque tour de la pompe.
    pending_start: Option<StartRequest>,
    /// Dernier `transcript_path` vu dans un hook, avec son identifiant Claude.
    last_hint: Option<(String, String)>,
    last_change: Instant,
    last_used: Instant,
}

/// Infos d'une session lues sous le verrou du registre.
struct SessionInfo {
    profile: String,
    claude_session_id: String,
    alive: bool,
}

/// Conversations de sessions arrêtées gardées au plus, et âge minimal (depuis
/// la dernière lecture) pour être évincée. Un binaire de test
/// (`test-support`) lit `DEVMAESTRO_CONV_MAX_IDLE` (âge minimal nul).
fn idle_limits() -> (usize, Duration) {
    #[cfg(feature = "test-support")]
    if let Some(n) = std::env::var("DEVMAESTRO_CONV_MAX_IDLE")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
    {
        return (n.max(1), Duration::ZERO);
    }
    (MAX_IDLE_CONVERSATIONS, FOLLOW_GRACE)
}

/// Taille approximative du JSON d'une valeur, sans la sérialiser (pour
/// borner une réponse avant son unique sérialisation).
fn approx_len(v: &Value) -> usize {
    match v {
        Value::Null | Value::Bool(_) => 5,
        Value::Number(_) => 20,
        Value::String(s) => {
            s.len()
                + 2
                + s.bytes()
                    .filter(|b| *b < 0x20 || *b == b'"' || *b == b'\\')
                    .count()
                    * 5
        }
        Value::Array(a) => 2 + a.iter().map(|x| approx_len(x) + 1).sum::<usize>(),
        Value::Object(o) => {
            2 + o
                .iter()
                .map(|(k, x)| k.len() + 4 + approx_len(x))
                .sum::<usize>()
        }
    }
}

impl Daemon {
    fn conversations(&self) -> MutexGuard<'_, HashMap<Uuid, Arc<Mutex<ConvState>>>> {
        self.conversations.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn session_info(&self, id: &Uuid) -> Option<SessionInfo> {
        let reg = self.lock();
        let e = reg.sessions.get(id)?;
        Some(SessionInfo {
            profile: e.session.profile.clone(),
            claude_session_id: e.session.claude_session_id.clone(),
            alive: e.run.is_some(),
        })
    }

    /// Appelé par chaque hook, sous le verrou du registre : dépose une
    /// action pour la pompe, sans aucune entrée-sortie.
    pub(super) fn conversation_hook(&self, id: Uuid, event: &HookEvent, now: OffsetDateTime) {
        let action = match &event.kind {
            HookKind::SessionStart { source, .. } => ConvAction::Start(StartRequest {
                claude_session_id: event.common.session_id.clone(),
                transcript_path: event.common.transcript_path.clone(),
                source: source.clone(),
                at: time_json(Some(now)).as_str().map(str::to_owned),
            }),
            HookKind::SubagentStart {
                agent_id: Some(a), ..
            } if is_agent_id(a) => ConvAction::Subagent(a.clone()),
            _ => ConvAction::Wake {
                claude_session_id: event.common.session_id.clone(),
                transcript_path: event.common.transcript_path.clone(),
            },
        };
        {
            let mut actions = self.conv_actions.lock().unwrap_or_else(|e| e.into_inner());
            let list = actions.entry(id).or_default();
            // Deux réveils de suite : le dernier suffit (même indice, plus récent).
            if matches!(action, ConvAction::Wake { .. })
                && matches!(list.last(), Some(ConvAction::Wake { .. }))
            {
                list.pop();
            }
            if list.len() >= MAX_ACTIONS {
                // Un `SessionStart` ne se perd jamais : seuls les réveils sautent.
                if let Some(i) = list
                    .iter()
                    .position(|a| matches!(a, ConvAction::Wake { .. }))
                {
                    list.remove(i);
                }
            }
            list.push(action);
        }
        self.conv_wake.notify_one();
    }

    /// Démarre le suivi des transcripts : réveil par la surveillance des
    /// dossiers et par les hooks, scrutation de secours.
    pub fn start_conversation_follow(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        self.deps.follower.set_waker(Box::new(move || {
            if let Some(d) = weak.upgrade() {
                d.conv_wake.notify_one();
            }
        }));
        let daemon = Arc::clone(self);
        self.runtime.spawn(async move {
            loop {
                let woken = tokio::select! {
                    () = daemon.conv_wake.notified() => true,
                    () = tokio::time::sleep(POLL_INTERVAL) => false,
                };
                if woken {
                    // Regroupe ce qui arrive ensemble (hooks, lignes, sous-agents).
                    tokio::time::sleep(GROUP_DELAY).await;
                }
                let d = daemon.clone();
                let _ = tokio::task::spawn_blocking(move || d.pump_conversations()).await;
            }
        });
    }

    /// Un tour de la pompe : actions en attente, puis lecture des fichiers des
    /// conversations suivies. Bloquant.
    fn pump_conversations(&self) {
        let pending: Vec<Uuid> = self
            .conv_actions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .keys()
            .copied()
            .collect();
        let known: Vec<(Uuid, Arc<Mutex<ConvState>>)> = self
            .conversations()
            .iter()
            .map(|(id, s)| (*id, s.clone()))
            .collect();
        let mut targets = pending;
        for (id, state) in known {
            if targets.contains(&id) {
                continue;
            }
            let recent = state
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .last_change
                .elapsed()
                < FOLLOW_GRACE;
            let alive = self.session_info(&id).is_some_and(|i| i.alive);
            if alive || recent {
                targets.push(id);
            }
        }
        for id in targets {
            let _ = self.with_conversation(&id, |_| ());
        }
        // Sessions arrêtées depuis : leurs conversations comptent désormais.
        self.evict_idle_conversations(&Uuid::nil());
    }

    /// La conversation d'une session, créée au besoin, à jour (actions en
    /// attente appliquées, fichiers relus), passée à `f`. Un changement fait
    /// par `f` (sous-agent activé…) est signalé aussi. Bloquant.
    fn with_conversation<T>(
        &self,
        id: &Uuid,
        f: impl FnOnce(&mut ConvState) -> T,
    ) -> Result<T, RpcError> {
        let Some(info) = self.session_info(id) else {
            self.drop_conversation(id);
            return Err(RpcError::unknown_session(id));
        };
        let (state, _) = self.conversation_state(id, &info)?;
        let mut st = state.lock().unwrap_or_else(|e| e.into_inner());
        st.last_used = Instant::now();
        let before = st.conv.rev();
        let actions = self
            .conv_actions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id)
            .unwrap_or_default();
        for a in actions {
            match a {
                ConvAction::Start(req) => {
                    st.last_hint = req
                        .transcript_path
                        .clone()
                        .map(|p| (req.claude_session_id.clone(), p));
                    st.pending_start = None;
                    if !self.open_segment(&mut st, &req) {
                        st.pending_start = Some(req);
                    }
                }
                ConvAction::Subagent(agent) => {
                    self.track_subagent(&mut st, &agent, true);
                }
                ConvAction::Wake {
                    claude_session_id,
                    transcript_path,
                } => {
                    if let Some(p) = transcript_path {
                        st.last_hint = Some((claude_session_id, p));
                    }
                }
            }
        }
        // Transcript pas encore trouvé (pas encore écrit, `projects/` absent,
        // démon redémarré) : réessayé à chaque tour.
        if let Some(req) = st.pending_start.clone() {
            if self.open_segment(&mut st, &req) {
                st.pending_start = None;
            }
        } else if st.current.is_none() {
            let hint = st
                .last_hint
                .as_ref()
                .filter(|(cid, _)| *cid == info.claude_session_id)
                .map(|(_, p)| p.clone());
            let req = StartRequest {
                claude_session_id: info.claude_session_id.clone(),
                transcript_path: hint,
                source: None,
                at: None,
            };
            self.open_segment(&mut st, &req);
        }
        self.refresh(&mut st);
        let out = f(&mut st);
        if st.conv.rev() != before {
            st.last_change = Instant::now();
            let _ = self.events.send(Event::ConversationChanged(*id));
        }
        Ok(out)
    }

    /// Conversation existante, ou nouvelle (vide). `true` si elle vient d'être créée.
    fn conversation_state(
        &self,
        id: &Uuid,
        info: &SessionInfo,
    ) -> Result<(Arc<Mutex<ConvState>>, bool), RpcError> {
        if let Some(s) = self.conversations().get(id) {
            return Ok((s.clone(), false));
        }
        let profile = self.profile(&info.profile)?;
        let projects = profile.config_dir.join("projects");
        let root = self.deps.follower.resolve(&projects).unwrap_or(projects);
        let mut conv = Conversation::new(Limits::display());
        // Révisions croissantes même pour une conversation recréée : une
        // connexion garde sa révision d'avant.
        conv.set_rev_base(self.conv_rev_floor.load(Ordering::SeqCst));
        let state = Arc::new(Mutex::new(ConvState {
            conv,
            root,
            profile: info.profile.clone(),
            files: Vec::new(),
            current: None,
            agents: HashMap::new(),
            pending_start: None,
            last_hint: None,
            last_change: Instant::now(),
            last_used: Instant::now(),
        }));
        let mut map = self.conversations();
        if let Some(s) = map.get(id) {
            return Ok((s.clone(), false)); // Créée entre-temps.
        }
        map.insert(*id, state.clone());
        drop(map);
        self.evict_idle_conversations(id);
        Ok((state, true))
    }

    /// Garde au plus [`MAX_IDLE_CONVERSATIONS`] conversations de sessions
    /// qui ne tournent pas (les moins récemment lues partent).
    fn evict_idle_conversations(&self, keep: &Uuid) {
        let (max, min_age) = idle_limits();
        let alive: HashSet<Uuid> = self
            .lock()
            .sessions
            .values()
            .filter(|e| e.run.is_some())
            .map(|e| e.session.id)
            .collect();
        let mut idle: Vec<(Instant, Uuid)> = self
            .conversations()
            .iter()
            .filter(|(id, _)| *id != keep && !alive.contains(id))
            .filter_map(|(id, s)| {
                s.try_lock()
                    .ok()
                    .map(|st| (st.last_used, *id))
                    .filter(|(used, _)| used.elapsed() >= min_age)
            })
            .collect();
        if idle.len() <= max {
            return;
        }
        idle.sort();
        for (_, id) in idle.iter().take(idle.len() - max) {
            super::info!("session {id} : conversation libérée de la mémoire (relue à la demande)");
            self.drop_conversation(id);
        }
    }

    /// Oublie la conversation d'une session (`sessions.forget`, éviction) et
    /// cesse de surveiller ses dossiers (sauf ceux d'une autre conversation).
    pub(super) fn drop_conversation(&self, id: &Uuid) {
        let removed = self.conversations().remove(id);
        self.conv_actions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id);
        let Some(s) = removed else { return };
        let dirs: HashSet<PathBuf> = {
            let st = s.lock().unwrap_or_else(|e| e.into_inner());
            self.conv_rev_floor
                .fetch_max(st.conv.rev(), Ordering::SeqCst);
            watched_dirs(&st)
        };
        let others: Vec<Arc<Mutex<ConvState>>> = self.conversations().values().cloned().collect();
        let mut kept = HashSet::new();
        for o in others {
            kept.extend(watched_dirs(&o.lock().unwrap_or_else(|e| e.into_inner())));
        }
        for d in dirs.difference(&kept) {
            self.deps.follower.unwatch(d);
        }
    }

    /// Transcript principal résolu sous la racine du profil :
    /// `<projects>/<dossier du projet>/<nom>.jsonl`.
    fn confine_main(&self, st: &ConvState, path: &Path) -> Option<PathBuf> {
        let resolved = self.deps.follower.confine(path, &st.root)?;
        let rel = resolved.strip_prefix(&st.root).ok()?;
        (rel.components().count() == 2 && resolved.extension().is_some_and(|e| e == "jsonl"))
            .then_some(resolved)
    }

    /// `SessionStart` (ou ouverture sans hook) : suit le fichier du
    /// transcript ; un fichier différent du segment courant ouvre un nouveau
    /// segment (`/clear`, reprise d'une autre conversation). L'indice
    /// (`transcript_path` du hook) n'est retenu que si son nom de fichier est
    /// l'identifiant Claude du hook ; sinon le transcript est cherché par cet
    /// identifiant. `false` : transcript pas (encore) trouvé.
    fn open_segment(&self, st: &mut ConvState, req: &StartRequest) -> bool {
        let id = req.claude_session_id.as_str();
        let from_hint = req
            .transcript_path
            .as_deref()
            .map(Path::new)
            .filter(|p| p.file_stem().and_then(|s| s.to_str()) == Some(id))
            .and_then(|p| self.confine_main(st, p))
            // Indice pas encore écrit : on attend qu'il existe.
            .filter(|p| p.is_file());
        let path = from_hint.or_else(|| {
            let profile = self.profile(&st.profile).ok()?;
            let found = self.deps.transcripts.transcript_path(&profile, id)?;
            self.confine_main(st, &found)
        });
        let Some(path) = path else {
            return false;
        };
        if let Some(cur) = st.current
            && st.files[cur as usize].path == path
        {
            return true; // `compact`, `resume` du même fichier : même segment.
        }
        // L'ancien fichier principal : lu jusqu'au bout, puis plus suivi.
        if let Some(cur) = st.current {
            self.read_source(st, cur as usize);
            st.files[cur as usize].active = false;
        }
        let reason = match req.source.as_deref() {
            Some("clear") => "clear",
            Some("resume") => "resume",
            _ => "start",
        };
        let segment = st.conv.start_segment(id, reason, req.at.clone());
        let existing = st
            .files
            .iter()
            .position(|t| t.agent.is_none() && t.path == path);
        let source = match existing {
            Some(i) => {
                // Reprise d'un fichier déjà suivi : ses lignes suivantes vont
                // au nouveau segment.
                st.conv.set_source_segment(i as u32, segment);
                st.files[i].segment = segment;
                st.files[i].active = true;
                i as u32
            }
            None => {
                let s = st.conv.add_source(None, segment);
                st.files.push(Tracked {
                    path: path.clone(),
                    pos: TailPos::default(),
                    agent: None,
                    active: true,
                    linked: true,
                    segment,
                    scanned: false,
                    errors: HashSet::new(),
                });
                s
            }
        };
        st.current = Some(source);
        if let Some(dir) = path.parent() {
            self.deps.follower.watch(dir);
        }
        true
    }

    /// Suit le fichier d'un sous-agent (créé au besoin) ; `activate` : le lire.
    fn track_subagent(&self, st: &mut ConvState, agent: &str, activate: bool) -> Option<u32> {
        if let Some(&src) = st.agents.get(agent) {
            if activate {
                st.files[src as usize].active = true;
            }
            return Some(src);
        }
        // Fichier existant sous le dossier d'un transcript principal (le
        // plus récent d'abord) : `<transcript sans .jsonl>/subagents/agent-<id>.jsonl`.
        // Pas encore créé : la recherche de `refresh` le trouvera.
        let name = format!("agent-{agent}.jsonl");
        let (main, path) = st
            .files
            .iter()
            .enumerate()
            .rev()
            .filter(|(_, t)| t.agent.is_none())
            .map(|(i, t)| (i, subagents_dir(&t.path).join(&name)))
            .find(|(_, p)| p.is_file())?;
        let path = self.deps.follower.confine(&path, &st.root)?;
        let segment = st.files[main].segment;
        let src = st.conv.add_source(Some(agent.to_owned()), segment);
        st.files.push(Tracked {
            path,
            pos: TailPos::default(),
            agent: Some(agent.to_owned()),
            active: activate,
            linked: false,
            segment,
            scanned: true,
            errors: HashSet::new(),
        });
        st.agents.insert(agent.to_owned(), src);
        Some(src)
    }

    /// Cherche les sous-agents (fichiers apparus), lit les `.meta.json`
    /// pas encore lus, puis les nouvelles lignes des fichiers actifs.
    fn refresh(&self, st: &mut ConvState) {
        let follower = &self.deps.follower;
        for i in 0..st.files.len() {
            if st.files[i].agent.is_some() || !st.files[i].active {
                continue;
            }
            let main = st.files[i].path.clone();
            // Dossier du projet absent au `SessionStart` (nouveau projet) :
            // surveillé dès qu'il existe (sans effet s'il l'est déjà).
            if let Some(parent) = main.parent() {
                follower.watch(parent);
            }
            let dir = subagents_dir(&main);
            follower.watch(&dir);
            // Déjà là à la première recherche de ce fichier : lus à la
            // demande ; apparus ensuite : lus en direct.
            let live = st.files[i].scanned;
            for name in follower.list_dir(&dir) {
                let Some(agent) = name
                    .strip_prefix("agent-")
                    .and_then(|n| n.strip_suffix(".jsonl"))
                    .filter(|a| is_agent_id(a))
                else {
                    continue;
                };
                if !st.agents.contains_key(agent) {
                    self.track_subagent(st, agent, live);
                }
            }
            st.files[i].scanned = true;
        }
        for i in 0..st.files.len() {
            if !st.files[i].linked {
                let meta = st.files[i].path.with_extension("meta.json");
                if let Some(text) = follower.read_small(&meta, META_MAX_BYTES)
                    && let Ok(v) = serde_json::from_str::<Value>(&text)
                {
                    st.files[i].linked = true;
                    if let (Some(tool_use_id), Some(agent)) =
                        (v["toolUseId"].as_str(), st.files[i].agent.clone())
                    {
                        st.conv.link_agent(tool_use_id, &agent);
                    }
                }
            }
            if st.files[i].active {
                self.read_source(st, i);
            }
        }
    }

    /// Lit les nouvelles lignes d'un fichier, par lots, et les donne au
    /// domaine. Une erreur est signalée une fois par fichier et par genre,
    /// sans chemin ni contenu.
    fn read_source(&self, st: &mut ConvState, i: usize) {
        let path = st.files[i].path.clone();
        let mut pos = std::mem::take(&mut st.files[i].pos);
        loop {
            match self.deps.follower.read_new(&path, &mut pos) {
                Ok(read) => {
                    for l in &read.lines {
                        st.conv.feed_at(i as u32, l.offset, l.len, &l.text);
                    }
                    for _ in 0..read.oversized {
                        st.conv.count_invalid(i as u32);
                    }
                    if !read.more {
                        break;
                    }
                }
                Err(e) => {
                    if st.files[i].errors.insert(e.kind()) {
                        super::warning!(
                            "transcript illisible (source {i} d'une conversation) : {}",
                            e.kind()
                        );
                    }
                    break;
                }
            }
        }
        st.files[i].pos = pos;
    }

    /// Une connexion vient de poser sa révision sur cette conversation :
    /// un changement survenu pendant sa lecture lui sera envoyé.
    pub fn conversation_touched(&self, id: Uuid) {
        if self.conversations().contains_key(&id) {
            let _ = self.events.send(Event::ConversationChanged(id));
        }
    }

    // ------------------------------------------------------------ méthodes

    /// `conversation.get {id, before?, limit?}` et `conversation.subagent
    /// {id, agent_id, before?, limit?}`. Renvoie aussi la révision de
    /// l'instantané (point de départ des `conversation.changed` de la
    /// connexion). Bloquant.
    pub fn conversation_get(
        &self,
        params: &Value,
        subagent: bool,
    ) -> Result<(Value, Uuid, u64), RpcError> {
        let id = session_id_param(params)?;
        let before = opt_str(params, "before")?;
        let limit = match params.get("limit") {
            None | Some(Value::Null) => DEFAULT_LIMIT,
            Some(v) => v
                .as_u64()
                .filter(|n| (1..=MAX_LIMIT).contains(n))
                .ok_or_else(|| {
                    RpcError::params(format!("« limit » : entier de 1 à {MAX_LIMIT}"))
                })?,
        } as usize;
        let agent = if subagent {
            let a = opt_str(params, "agent_id")?
                .ok_or_else(|| RpcError::params("« agent_id » manquant"))?;
            if !is_agent_id(&a) {
                return Err(unknown_subagent(&a));
            }
            Some(a)
        } else {
            None
        };
        self.with_conversation(&id, |st| {
            if let Some(a) = &agent {
                if self.track_subagent(st, a, true).is_none() {
                    return Err(unknown_subagent(a));
                }
                self.refresh(st);
            }
            let (page, more) = st
                .conv
                .page(agent.as_deref(), before.as_deref(), limit)
                .ok_or_else(|| RpcError::params("« before » : entrée inconnue"))?;
            // Du plus récent au plus ancien, jusqu'à la taille maximale.
            let mut entries = Vec::new();
            let mut size = 0;
            let mut cut = false;
            for e in page.iter().rev() {
                let v = conversation_entry_json(e);
                size += approx_len(&v);
                if size > MAX_PAYLOAD_BYTES && !entries.is_empty() {
                    cut = true;
                    break;
                }
                entries.push(v);
            }
            entries.reverse();
            let value = json!({
                "segments": st.conv.segments().iter().map(segment_json).collect::<Vec<_>>(),
                "entries": entries,
                "has_more": more || cut,
                "invalid_lines": st.conv.invalid_lines(agent.as_deref()),
            });
            Ok((value, id, st.conv.rev()))
        })?
    }

    /// `conversation.full {id, uid, part}` → `{text, truncated}` : la partie
    /// entière d'une entrée (au plus 4 Mio), relue dans le fichier. Bloquant.
    pub fn conversation_full(&self, params: &Value) -> Result<Value, RpcError> {
        let id = session_id_param(params)?;
        let uid = opt_str(params, "uid")?.ok_or_else(|| RpcError::params("« uid » manquant"))?;
        let part = opt_str(params, "part")?
            .as_deref()
            .and_then(Part::parse)
            .ok_or_else(|| RpcError::params("« part » : input, result ou text"))?;
        let (agent, refs) = self.with_conversation(&id, |st| {
            let e = st
                .conv
                .entry(&uid)
                .ok_or_else(|| RpcError::params(format!("entrée inconnue : {uid}")))?;
            let refs: Vec<(PathBuf, u64, u64)> = e
                .lines
                .iter()
                .filter_map(|l| {
                    let t = st.files.get(l.source as usize)?;
                    Some((t.path.clone(), l.offset, l.len))
                })
                .collect();
            Ok::<_, RpcError>((e.agent_id.clone(), refs))
        })??;
        // Relecture hors du verrou de la conversation : une ouverture par
        // fichier, lignes remises dans leur ordre.
        let mut lines = vec![String::new(); refs.len()];
        let mut paths: Vec<&PathBuf> = refs.iter().map(|(p, _, _)| p).collect();
        paths.dedup();
        let mut done = HashSet::new();
        for path in paths {
            if !done.insert(path.clone()) {
                continue;
            }
            let idx: Vec<usize> = (0..refs.len()).filter(|k| refs[*k].0 == *path).collect();
            let wanted: Vec<(u64, u64)> = idx.iter().map(|k| (refs[*k].1, refs[*k].2)).collect();
            let got = self.deps.follower.read_lines(path, &wanted).map_err(|e| {
                RpcError::new(
                    error_code::INTERNAL_ERROR,
                    format!("transcript illisible : {}", e.kind()),
                )
            })?;
            for (k, text) in idx.into_iter().zip(got) {
                lines[k] = text;
            }
        }
        let (text, truncated) =
            full_text(&uid, agent.as_deref(), &lines, part).ok_or_else(|| {
                RpcError::params(format!(
                    "l'entrée {uid} n'a pas de partie « {} »",
                    part_name(part)
                ))
            })?;
        Ok(json!({"text": text, "truncated": truncated}))
    }

    /// Notifications `conversation.changed` pour une connexion dont la
    /// révision est `cursor` (morceaux d'au plus [`MAX_PAYLOAD_BYTES`]), et
    /// la nouvelle révision. Rien si rien n'a changé. Bloquant (court).
    pub fn conversation_changes(&self, id: &Uuid, cursor: u64) -> Option<(Vec<Value>, u64)> {
        let state = self.conversations().get(id)?.clone();
        let st = state.lock().unwrap_or_else(|e| e.into_inner());
        let rev = st.conv.rev();
        if rev <= cursor {
            return None;
        }
        let segments: Vec<Value> = st.conv.segments_since(cursor).map(segment_json).collect();
        let mut frames = Vec::new();
        let mut batch: Vec<Value> = Vec::new();
        let mut size = 0;
        for e in st.conv.changed_since(cursor) {
            let v = conversation_entry_json(e);
            let n = approx_len(&v);
            if size + n > MAX_PAYLOAD_BYTES && !batch.is_empty() {
                frames.push(std::mem::take(&mut batch));
                size = 0;
            }
            size += n;
            batch.push(v);
        }
        frames.push(batch);
        let last = frames.len() - 1;
        let values = frames
            .into_iter()
            .enumerate()
            .map(|(i, upserts)| {
                let mut p = json!({"id": id, "upserts": upserts});
                if i == last && !segments.is_empty() {
                    p["segment_started"] = segments[segments.len() - 1].clone();
                    p["segments_started"] = Value::Array(segments.clone());
                }
                notification("conversation.changed", p)
            })
            .collect();
        Some((values, rev))
    }

    /// Sessions dont une conversation est en mémoire (resynchronisation d'un
    /// client en retard).
    pub fn sessions_with_conversation(&self) -> Vec<Uuid> {
        self.conversations().keys().copied().collect()
    }
}

fn part_name(p: Part) -> &'static str {
    match p {
        Part::Input => "input",
        Part::Result => "result",
        Part::Text => "text",
    }
}

fn unknown_subagent(agent: &str) -> RpcError {
    RpcError::new(
        error_code::UNKNOWN_SUBAGENT,
        format!("sous-agent inconnu dans cette conversation : {agent}"),
    )
}

/// `<transcript sans .jsonl>/subagents`.
fn subagents_dir(main: &Path) -> PathBuf {
    main.with_extension("").join("subagents")
}

/// Dossiers surveillés pour une conversation : celui de chaque transcript
/// principal et celui de ses sous-agents.
fn watched_dirs(st: &ConvState) -> HashSet<PathBuf> {
    st.files
        .iter()
        .filter(|t| t.agent.is_none())
        .flat_map(|t| {
            [
                t.path.parent().map(Path::to_path_buf),
                Some(subagents_dir(&t.path)),
            ]
        })
        .flatten()
        .collect()
}
