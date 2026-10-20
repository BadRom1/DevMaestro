//! Sous-agents d'une session (v0.2, lot 5) : construction pure à partir des
//! hooks, selon le contrat de `docs/v0.2.md` (« Contrat du lot 5 ») fondé sur
//! la Q12 du prototype n° 1.
//!
//! Ce module ne fait qu'enregistrer : la machine à états ([`super::state`])
//! l'appelle pour chaque événement et lui demande si un sous-agent tourne
//! encore ou attend sa `task-notification` ([`Subagents::busy`]).
//!
//! # Construction
//!
//! - Un sous-agent est créé au **premier** de `SubagentStart` (`agent_id`,
//!   `agent_type`) ou du `PostToolUse` de l'outil `Agent` qui porte
//!   `tool_response.agentId` (`description`, `resolvedModel`, `tool_use_id`),
//!   puis complété par l'autre : les deux ordres existent.
//! - Les `PreToolUse(Agent)` de la conversation principale sont gardés en
//!   attente (au plus [`MAX_PENDING_LAUNCHES`]). Au `SubagentStart`, s'il y en
//!   a **un seul** non rattaché du même `subagent_type`, le sous-agent y est
//!   rattaché provisoirement (description, `tool_use_id`) ; s'il y en a
//!   plusieurs, c'est ambigu : rien n'est deviné. Le `PostToolUse(Agent)` qui
//!   porte `agentId` fait foi (il corrige un rattachement provisoire). Sans
//!   `agentId` (sous-agent au premier plan, non observé), il ne fait que
//!   compléter le sous-agent déjà rattaché à son `tool_use_id`.
//! - Un sous-agent est « en arrière-plan » si la réponse de l'outil `Agent`
//!   le dit (`isAsync: true` ou `status: "async_launched"`) : lui seul attend
//!   une `task-notification` après son `SubagentStop`.
//! - Hooks portant un `agent_id` connu et `running` : `tool_count` + 1 et
//!   `current_tool` posé au `PreToolUse`, `current_tool` vidé au
//!   `PostToolUse` / `PostToolUseFailure`, `last_tool` gardé.
//! - `SubagentStop` d'un `agent_id` connu → `done` (même depuis
//!   `interrupted` : un `Stop` arrivé avant lui a pu le croire perdu), rapport
//!   coupé à [`MAX_REPORT_BYTES`], `transcript_path`, `ended_at`. Inconnu
//!   (agent interne de Claude Code) : ignoré.
//! - `SubagentStart` d'un agent connu qui ne tourne plus (agent repris : la
//!   même tâche peut notifier plusieurs fois) → de nouveau `running`, fin et
//!   notification effacées.
//! - `task-notification` : `completed` → seulement « notifié » ; `failed` →
//!   `failed` ; autre statut → `interrupted` si l'agent tourne encore. Un même
//!   prompt peut en porter plusieurs : toutes sont lues. Une notification
//!   d'un agent pas encore connu est gardée (au plus
//!   [`MAX_EARLY_NOTIFICATIONS`]) et appliquée à sa création.
//! - Attente bornée de la `task-notification` : elle n'est plus attendue
//!   après un vrai prompt de l'utilisateur ([`Subagents::on_user_prompt`]),
//!   ni [`NOTIFICATION_GRACE`] après la fin de l'agent.
//! - `Stop` avec `background_tasks` : un agent `running` qui n'y figure pas
//!   (et n'a pas eu de `SubagentStop`) → `interrupted`.
//! - Fin de session : les agents `running` → `interrupted`.
//!
//! Au plus [`MAX_SUBAGENTS`] sous-agents sont gardés par session : au-delà,
//! le plus ancien fini est oublié (le plus ancien tout court si tous tournent).
//!
//! Les descriptions, rapports et types viennent de Claude : ce sont des
//! données, jamais interprétées. Les textes courts (type, description,
//! modèle, outils, chemin) sont coupés à [`MAX_FIELD_CHARS`] caractères.

use std::hash::{DefaultHasher, Hash, Hasher};

use serde_json::Value;
use time::{Duration, OffsetDateTime};

use super::hooks::{BackgroundTask, ToolCall, str_in};

/// Nom de l'outil qui lance un sous-agent.
pub const AGENT_TOOL: &str = "Agent";
/// Début du prompt qu'injecte Claude Code à la fin d'un sous-agent en
/// arrière-plan.
pub const TASK_NOTIFICATION_PREFIX: &str = "<task-notification>";
/// Taille maximale gardée d'un rapport, en octets (64 Kio).
pub const MAX_REPORT_BYTES: usize = 64 * 1024;
/// Nombre maximal de sous-agents gardés par session.
pub const MAX_SUBAGENTS: usize = 100;
/// Nombre maximal de `PreToolUse(Agent)` gardés en attente.
pub const MAX_PENDING_LAUNCHES: usize = 64;
/// Nombre maximal de `task-notification` gardées pour des agents pas encore
/// connus.
pub const MAX_EARLY_NOTIFICATIONS: usize = 64;
/// Délai au-delà duquel la `task-notification` d'un agent fini n'est plus
/// attendue (elle ne retient plus la session `running`).
pub const NOTIFICATION_GRACE: Duration = Duration::minutes(5);
/// Longueur maximale des textes courts d'un sous-agent, en caractères.
pub const MAX_FIELD_CHARS: usize = 500;
/// `subagent_type` de l'outil `Agent` quand il est absent.
pub const DEFAULT_SUBAGENT_TYPE: &str = "general-purpose";

/// Statut d'un sous-agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SubagentStatus {
    Running,
    Done,
    Failed,
    Interrupted,
}

impl SubagentStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Interrupted => "interrupted",
        }
    }

    /// Lecture d'un statut enregistré ; inconnu → `None`.
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "running" => Self::Running,
            "done" => Self::Done,
            "failed" => Self::Failed,
            "interrupted" => Self::Interrupted,
            _ => return None,
        })
    }
}

/// Un sous-agent lancé par Claude dans une session.
#[derive(Debug, Clone, PartialEq, Hash)]
pub struct Subagent {
    pub agent_id: String,
    pub agent_type: Option<String>,
    pub description: Option<String>,
    /// `resolvedModel` de la réponse de l'outil `Agent`.
    pub model: Option<String>,
    /// `tool_use_id` de l'appel à l'outil `Agent`.
    pub tool_use_id: Option<String>,
    pub status: SubagentStatus,
    pub started_at: OffsetDateTime,
    pub ended_at: Option<OffsetDateTime>,
    pub tool_count: u64,
    pub current_tool: Option<String>,
    pub last_tool: Option<String>,
    /// `last_assistant_message` du `SubagentStop`, coupé à [`MAX_REPORT_BYTES`].
    pub report: Option<String>,
    pub report_truncated: bool,
    /// `agent_transcript_path` du `SubagentStop` (gardé, pas lu).
    pub transcript_path: Option<String>,
    /// Ordre de lancement dans la session (croissant).
    pub seq: u64,
    /// Lancé en arrière-plan : une `task-notification` suivra sa fin.
    pub background: bool,
    /// La `task-notification` de cet agent est arrivée.
    pub notified: bool,
    /// Rattaché à son `PreToolUse(Agent)` par le repli (pas par `agentId`).
    pub guessed_link: bool,
}

impl Subagent {
    /// Nouveau sous-agent `running`, champs inconnus vides (la relecture en
    /// base complète les champs).
    pub fn new(agent_id: impl Into<String>, seq: u64, started_at: OffsetDateTime) -> Self {
        Self {
            agent_id: agent_id.into(),
            agent_type: None,
            description: None,
            model: None,
            tool_use_id: None,
            status: SubagentStatus::Running,
            started_at,
            ended_at: None,
            tool_count: 0,
            current_tool: None,
            last_tool: None,
            report: None,
            report_truncated: false,
            transcript_path: None,
            seq,
            background: false,
            notified: false,
            guessed_link: false,
        }
    }

    pub fn is_running(&self) -> bool {
        self.status == SubagentStatus::Running
    }

    /// Fini en arrière-plan, sa `task-notification` pas encore arrivée, et
    /// fini depuis moins de [`NOTIFICATION_GRACE`].
    pub fn awaits_notification(&self, now: OffsetDateTime) -> bool {
        self.status == SubagentStatus::Done
            && self.background
            && !self.notified
            && self.ended_at.is_none_or(|e| now - e < NOTIFICATION_GRACE)
    }

    /// Empreinte des champs enregistrés en base (sans `background`,
    /// `notified` ni `guessed_link`) : sert à n'écrire que ce qui a changé.
    pub fn fingerprint(&self) -> u64 {
        let mut h = DefaultHasher::new();
        (
            &self.agent_id,
            &self.agent_type,
            &self.description,
            &self.model,
            &self.tool_use_id,
            self.status,
            self.started_at,
            self.ended_at,
        )
            .hash(&mut h);
        (
            self.tool_count,
            &self.current_tool,
            &self.last_tool,
            &self.report,
            self.report_truncated,
            &self.transcript_path,
            self.seq,
        )
            .hash(&mut h);
        h.finish()
    }

    fn end(&mut self, status: SubagentStatus, now: OffsetDateTime) {
        self.status = status;
        self.current_tool = None;
        if self.ended_at.is_none() {
            self.ended_at = Some(now);
        }
    }
}

/// Ce qu'un événement a changé dans les sous-agents.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord)]
pub enum SubagentChange {
    #[default]
    None,
    /// Seulement les compteurs d'outils (`tool_count`, `current_tool`,
    /// `last_tool`) : notification limitée en fréquence.
    Counters,
    /// Création, statut, ou autre champ : notification immédiate.
    Structural,
}

impl SubagentChange {
    fn merge(&mut self, other: SubagentChange) {
        *self = (*self).max(other);
    }
}

/// `PreToolUse(Agent)` de la conversation principale, en attente.
#[derive(Debug, Clone, PartialEq)]
struct Launch {
    tool_use_id: Option<String>,
    subagent_type: Option<String>,
    description: Option<String>,
    /// Sous-agent rattaché (provisoirement) à ce lancement.
    claimed_by: Option<String>,
}

/// `<task-notification>` lue dans un prompt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskNotification {
    pub task_id: Option<String>,
    pub status: Option<String>,
}

/// Le prompt est-il une notification interne de Claude Code ?
pub fn is_task_notification(prompt: &str) -> bool {
    prompt.trim_start().starts_with(TASK_NOTIFICATION_PREFIX)
}

/// Lit `task-id` et `status` de **chaque** `<task-notification>` du prompt
/// (`None` si le prompt n'en est pas une). Le reste (résumé, chemin de
/// sortie) n'est pas lu.
pub fn parse_task_notifications(prompt: &str) -> Option<Vec<TaskNotification>> {
    if !is_task_notification(prompt) {
        return None;
    }
    let tag = |block: &str, name: &str| -> Option<String> {
        let open = format!("<{name}>");
        let close = format!("</{name}>");
        let start = block.find(&open)? + open.len();
        let len = block[start..].find(&close)?;
        let v = block[start..start + len].trim();
        (!v.is_empty()).then(|| v.to_owned())
    };
    Some(
        prompt
            .split(TASK_NOTIFICATION_PREFIX)
            .skip(1)
            .map(|block| TaskNotification {
                task_id: tag(block, "task-id"),
                status: tag(block, "status"),
            })
            .collect(),
    )
}

/// Texte coupé à [`MAX_FIELD_CHARS`] caractères.
pub fn clip(s: &str) -> String {
    match s.char_indices().nth(MAX_FIELD_CHARS) {
        Some((end, _)) => s[..end].to_owned(),
        None => s.to_owned(),
    }
}

/// Champ texte non vide d'une valeur JSON brute, coupé.
fn text(v: &Value, key: &str) -> Option<String> {
    str_in(v, key).filter(|s| !s.is_empty()).map(|s| clip(&s))
}

/// Rapport coupé à [`MAX_REPORT_BYTES`] (sur une limite de caractère), et
/// vrai s'il a été coupé.
pub fn truncate_report(report: &str) -> (String, bool) {
    if report.len() <= MAX_REPORT_BYTES {
        return (report.to_owned(), false);
    }
    let mut end = MAX_REPORT_BYTES;
    while !report.is_char_boundary(end) {
        end -= 1;
    }
    (report[..end].to_owned(), true)
}

/// Sous-agents d'une session, dans l'ordre de lancement.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Subagents {
    agents: Vec<Subagent>,
    launches: Vec<Launch>,
    next_seq: u64,
    /// `task-notification` d'agents pas encore connus.
    early: Vec<TaskNotification>,
}

/// Applique une `task-notification` ; vrai si le statut a changé.
fn apply_notification(a: &mut Subagent, n: &TaskNotification, now: OffsetDateTime) -> bool {
    let before = a.status;
    a.notified = true;
    match n.status.as_deref() {
        Some("completed") => {}
        Some("failed") => a.end(SubagentStatus::Failed, now),
        _ if a.is_running() => a.end(SubagentStatus::Interrupted, now),
        _ => {}
    }
    a.status != before
}

impl Subagents {
    /// Tous les sous-agents, dans l'ordre de lancement.
    pub fn list(&self) -> &[Subagent] {
        &self.agents
    }

    pub fn get(&self, agent_id: &str) -> Option<&Subagent> {
        self.agents.iter().find(|a| a.agent_id == agent_id)
    }

    fn get_mut(&mut self, agent_id: &str) -> Option<&mut Subagent> {
        self.agents.iter_mut().find(|a| a.agent_id == agent_id)
    }

    pub fn running_count(&self) -> usize {
        self.agents.iter().filter(|a| a.is_running()).count()
    }

    pub fn total(&self) -> usize {
        self.agents.len()
    }

    /// L'agent `agent_id` est connu et tourne ?
    pub fn is_running(&self, agent_id: &str) -> bool {
        self.get(agent_id).is_some_and(Subagent::is_running)
    }

    /// Un sous-agent tourne, ou un sous-agent fini attend sa
    /// `task-notification` : la session ne peut pas passer `idle`.
    pub fn busy(&self, now: OffsetDateTime) -> bool {
        self.agents
            .iter()
            .any(|a| a.is_running() || a.awaits_notification(now))
    }

    /// Sous-agents relus en base : triés par ordre de lancement, au plus
    /// [`MAX_SUBAGENTS`] ; le compteur d'ordre repart après le plus grand.
    pub fn restore(&mut self, mut agents: Vec<Subagent>) {
        agents.sort_by_key(|a| a.seq);
        self.next_seq = agents.iter().map(|a| a.seq + 1).max().unwrap_or(0);
        self.agents = agents;
        self.launches.clear();
        while self.agents.len() > MAX_SUBAGENTS {
            self.evict();
        }
    }

    fn evict(&mut self) {
        let i = self
            .agents
            .iter()
            .position(|a| !a.is_running())
            .unwrap_or(0);
        self.agents.remove(i);
    }

    fn create(&mut self, agent_id: &str, now: OffsetDateTime) -> &mut Subagent {
        let seq = self.next_seq;
        self.next_seq += 1;
        let mut agent = Subagent::new(agent_id, seq, now);
        // Notifications arrivées avant que l'agent soit connu.
        let early: Vec<TaskNotification> = self
            .early
            .iter()
            .filter(|n| n.task_id.as_deref() == Some(agent_id))
            .cloned()
            .collect();
        self.early
            .retain(|n| n.task_id.as_deref() != Some(agent_id));
        for n in &early {
            apply_notification(&mut agent, n, now);
        }
        self.agents.push(agent);
        if self.agents.len() > MAX_SUBAGENTS {
            self.evict();
        }
        self.agents
            .iter_mut()
            .find(|a| a.agent_id == agent_id)
            .expect("sous-agent qui vient d'être créé")
    }

    /// `PreToolUse` : lancement d'un sous-agent (conversation principale), ou
    /// outil d'un sous-agent connu.
    pub fn on_pre_tool_use(&mut self, agent_id: Option<&str>, call: &ToolCall) -> SubagentChange {
        match agent_id {
            None if call.tool_name == AGENT_TOOL => {
                if self.launches.len() >= MAX_PENDING_LAUNCHES {
                    self.launches.remove(0);
                }
                self.launches.push(Launch {
                    tool_use_id: call.tool_use_id.clone(),
                    subagent_type: Some(
                        text(&call.tool_input, "subagent_type")
                            .unwrap_or_else(|| DEFAULT_SUBAGENT_TYPE.to_owned()),
                    ),
                    description: text(&call.tool_input, "description"),
                    claimed_by: None,
                });
                SubagentChange::None
            }
            None => SubagentChange::None,
            Some(id) => match self.get_mut(id).filter(|a| a.is_running()) {
                Some(a) => {
                    a.tool_count += 1;
                    a.current_tool = Some(clip(&call.tool_name));
                    a.last_tool = a.current_tool.clone();
                    SubagentChange::Counters
                }
                None => SubagentChange::None,
            },
        }
    }

    /// `PostToolUse` (`failure` : `Some(is_interrupt)` pour
    /// `PostToolUseFailure`).
    pub fn on_post_tool_use(
        &mut self,
        agent_id: Option<&str>,
        call: &ToolCall,
        failure: Option<bool>,
        now: OffsetDateTime,
    ) -> SubagentChange {
        match agent_id {
            Some(id) => match self.get_mut(id).filter(|a| a.is_running()) {
                Some(a) if a.current_tool.is_some() => {
                    a.current_tool = None;
                    SubagentChange::Counters
                }
                _ => SubagentChange::None,
            },
            None if call.tool_name == AGENT_TOOL => match failure {
                None => self.agent_returned(call, now),
                Some(is_interrupt) => self.agent_failed(call, is_interrupt, now),
            },
            None => SubagentChange::None,
        }
    }

    /// Index du lancement en attente de cet appel.
    fn launch_of(&self, call: &ToolCall) -> Option<usize> {
        call.tool_use_id.as_ref()?;
        self.launches
            .iter()
            .position(|l| l.tool_use_id == call.tool_use_id)
    }

    /// Réponse de l'outil `Agent` (`PostToolUse`).
    fn agent_returned(&mut self, call: &ToolCall, now: OffsetDateTime) -> SubagentChange {
        let resp = &call.tool_response;
        let launch = self.launch_of(call).map(|i| self.launches.remove(i));
        let Some(agent_id) = text(resp, "agentId") else {
            // Premier plan (non observé) : compléter l'agent déjà rattaché.
            let Some(a) = call.tool_use_id.as_deref().and_then(|t| {
                self.agents
                    .iter_mut()
                    .find(|a| a.tool_use_id.as_deref() == Some(t))
            }) else {
                return SubagentChange::None;
            };
            let before = a.clone();
            if let Some(m) = text(resp, "resolvedModel") {
                a.model = Some(m);
            }
            return if *a != before {
                SubagentChange::Structural
            } else {
                SubagentChange::None
            };
        };
        // `agentId` fait foi : un autre agent rattaché par le repli à ce même
        // appel l'était à tort.
        if let Some(t) = &call.tool_use_id {
            for other in self.agents.iter_mut().filter(|a| {
                a.agent_id != agent_id && a.guessed_link && a.tool_use_id.as_ref() == Some(t)
            }) {
                other.tool_use_id = None;
                other.description = None;
                other.guessed_link = false;
            }
        }
        // Un lancement que cet agent avait revendiqué par le repli n'était
        // pas le sien : il est libéré pour un autre.
        for l in self
            .launches
            .iter_mut()
            .filter(|l| l.claimed_by.as_deref() == Some(agent_id.as_str()))
        {
            l.claimed_by = None;
        }
        let background = resp.get("isAsync").and_then(Value::as_bool) == Some(true)
            || resp.get("status").and_then(Value::as_str) == Some("async_launched");
        let completed = resp.get("status").and_then(Value::as_str) == Some("completed");
        let created = self.get(&agent_id).is_none();
        let a = match created {
            true => self.create(&agent_id, now),
            false => self.get_mut(&agent_id).expect("sous-agent connu"),
        };
        let before = a.clone();
        a.tool_use_id = call.tool_use_id.clone().or(a.tool_use_id.take());
        a.guessed_link = false;
        a.description = text(resp, "description")
            .or_else(|| text(&call.tool_input, "description"))
            .or_else(|| launch.as_ref().and_then(|l| l.description.clone()))
            .or(a.description.take());
        if let Some(m) = text(resp, "resolvedModel") {
            a.model = Some(m);
        }
        if a.agent_type.is_none() {
            a.agent_type = Some(
                text(&call.tool_input, "subagent_type")
                    .unwrap_or_else(|| DEFAULT_SUBAGENT_TYPE.to_owned()),
            );
        }
        a.background |= background;
        if created && completed {
            // Premier plan, `SubagentStart` jamais vu : déjà fini.
            a.end(SubagentStatus::Done, now);
        }
        if created || *a != before {
            SubagentChange::Structural
        } else {
            SubagentChange::None
        }
    }

    /// Échec de l'outil `Agent` (`PostToolUseFailure`) : l'agent rattaché
    /// s'arrête (`interrupted` si interruption, `failed` sinon).
    fn agent_failed(
        &mut self,
        call: &ToolCall,
        is_interrupt: bool,
        now: OffsetDateTime,
    ) -> SubagentChange {
        if let Some(i) = self.launch_of(call) {
            self.launches.remove(i);
        }
        let Some(t) = call.tool_use_id.as_deref() else {
            return SubagentChange::None;
        };
        let Some(a) = self
            .agents
            .iter_mut()
            .find(|a| a.tool_use_id.as_deref() == Some(t) && a.is_running())
        else {
            return SubagentChange::None;
        };
        let status = if is_interrupt {
            SubagentStatus::Interrupted
        } else {
            SubagentStatus::Failed
        };
        a.end(status, now);
        SubagentChange::Structural
    }

    /// `SubagentStart`.
    pub fn on_start(
        &mut self,
        agent_id: Option<&str>,
        agent_type: Option<&str>,
        now: OffsetDateTime,
    ) -> SubagentChange {
        let Some(agent_id) = agent_id.filter(|s| !s.is_empty()) else {
            return SubagentChange::None;
        };
        let agent_type = agent_type.filter(|s| !s.is_empty()).map(clip);
        if let Some(a) = self.get_mut(agent_id) {
            let mut change = SubagentChange::None;
            if !a.is_running() {
                // Agent repris après sa fin : suivi de nouveau.
                a.status = SubagentStatus::Running;
                a.ended_at = None;
                a.notified = false;
                a.current_tool = None;
                change = SubagentChange::Structural;
            }
            // Le type du `SubagentStart` fait foi (celui de l'outil `Agent`
            // peut manquer et valoir `general-purpose` par défaut).
            if agent_type.is_some() && a.agent_type != agent_type {
                a.agent_type = agent_type;
                change = SubagentChange::Structural;
            }
            return change;
        }
        // Repli : un seul lancement en attente, non rattaché, de ce type.
        let wanted = agent_type.as_deref().unwrap_or(DEFAULT_SUBAGENT_TYPE);
        let candidates: Vec<usize> = self
            .launches
            .iter()
            .enumerate()
            .filter(|(_, l)| l.claimed_by.is_none() && l.subagent_type.as_deref() == Some(wanted))
            .map(|(i, _)| i)
            .collect();
        let guess = match candidates.as_slice() {
            [i] => Some(*i),
            _ => None,
        };
        if let Some(i) = guess {
            self.launches[i].claimed_by = Some(agent_id.to_owned());
        }
        let launch = guess.map(|i| self.launches[i].clone());
        let a = self.create(agent_id, now);
        a.agent_type = agent_type;
        if let Some(l) = launch {
            a.tool_use_id = l.tool_use_id;
            a.description = l.description;
            a.guessed_link = true;
        }
        SubagentChange::Structural
    }

    /// `SubagentStop` : seul un agent connu compte.
    pub fn on_stop(
        &mut self,
        agent_id: Option<&str>,
        report: Option<&str>,
        transcript_path: Option<&str>,
        now: OffsetDateTime,
    ) -> SubagentChange {
        let Some(a) = agent_id.and_then(|id| self.get_mut(id)) else {
            return SubagentChange::None;
        };
        if matches!(
            a.status,
            SubagentStatus::Running | SubagentStatus::Interrupted
        ) {
            a.status = SubagentStatus::Done;
            a.ended_at = Some(now);
        }
        a.current_tool = None;
        if let Some(r) = report {
            let (r, cut) = truncate_report(r);
            a.report = Some(r);
            a.report_truncated = cut;
        }
        if let Some(p) = transcript_path {
            a.transcript_path = Some(clip(p));
        }
        SubagentChange::Structural
    }

    /// `<task-notification>` injectée par Claude Code.
    pub fn on_task_notification(
        &mut self,
        n: &TaskNotification,
        now: OffsetDateTime,
    ) -> SubagentChange {
        let Some(id) = n.task_id.as_deref() else {
            return SubagentChange::None;
        };
        let Some(a) = self.get_mut(id) else {
            // Arrivée avant l'agent (hooks dans le désordre) : gardée.
            if self.early.len() >= MAX_EARLY_NOTIFICATIONS {
                self.early.remove(0);
            }
            self.early.push(n.clone());
            return SubagentChange::None;
        };
        if apply_notification(a, n, now) {
            SubagentChange::Structural
        } else {
            // `notified` ne se voit pas dans le protocole.
            SubagentChange::None
        }
    }

    /// Vrai prompt de l'utilisateur : plus aucune `task-notification` n'est
    /// attendue des agents déjà finis (l'utilisateur a repris la main).
    pub fn on_user_prompt(&mut self) {
        for a in self.agents.iter_mut().filter(|a| !a.is_running()) {
            a.notified = true;
        }
    }

    /// `Stop` de la conversation principale. Les lancements en attente sont
    /// oubliés (un appel à `Agent` ne survit pas à son tour). Si
    /// `background_tasks` est connu, un agent `running` qui n'y figure pas
    /// devient `interrupted`.
    pub fn on_turn_stop(
        &mut self,
        background_tasks: Option<&[BackgroundTask]>,
        now: OffsetDateTime,
    ) -> SubagentChange {
        self.launches.clear();
        let Some(tasks) = background_tasks else {
            return SubagentChange::None;
        };
        let mut change = SubagentChange::None;
        for a in self.agents.iter_mut().filter(|a| a.is_running()) {
            if !tasks.iter().any(|t| t.id == a.agent_id) {
                a.end(SubagentStatus::Interrupted, now);
                change.merge(SubagentChange::Structural);
            }
        }
        change
    }

    /// Fin de session (`SessionEnd`, fin du processus) : les agents encore
    /// `running` passent `interrupted`, et plus aucune notification n'est
    /// attendue.
    pub fn on_session_end(&mut self, now: OffsetDateTime) -> SubagentChange {
        self.launches.clear();
        let mut change = SubagentChange::None;
        for a in &mut self.agents {
            a.notified = true;
            if a.is_running() {
                a.end(SubagentStatus::Interrupted, now);
                change.merge(SubagentChange::Structural);
            }
        }
        change
    }

    /// Nouvelle conversation (`SessionStart` hors compaction) : les
    /// lancements en attente sont oubliés.
    pub fn forget_launches(&mut self) {
        self.launches.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn report_is_cut_on_a_char_boundary() {
        let short = "Rapport é";
        assert_eq!(truncate_report(short), (short.to_owned(), false));
        // « é » (2 octets) à cheval sur la limite.
        let long = format!("{}é{}", "a".repeat(MAX_REPORT_BYTES - 1), "b".repeat(10));
        let (cut, truncated) = truncate_report(&long);
        assert!(truncated);
        assert_eq!(cut.len(), MAX_REPORT_BYTES - 1);
        assert!(cut.chars().all(|c| c == 'a'));
        let exact = "x".repeat(MAX_REPORT_BYTES);
        assert_eq!(truncate_report(&exact), (exact.clone(), false));
        let emoji = "👩‍💻".repeat(MAX_REPORT_BYTES / 3);
        let (cut, truncated) = truncate_report(&emoji);
        assert!(truncated && cut.len() <= MAX_REPORT_BYTES);
    }

    #[test]
    fn task_notification_is_parsed() {
        let p = "<task-notification>\n<task-id>a1</task-id>\n<tool-use-id>t</tool-use-id>\n\
                 <status>completed</status>\n<summary>Agent « x »</summary>\n</task-notification>";
        assert_eq!(
            parse_task_notifications(p),
            Some(vec![TaskNotification {
                task_id: Some("a1".into()),
                status: Some("completed".into()),
            }])
        );
        assert_eq!(
            parse_task_notifications("<task-notification><status></status>"),
            Some(vec![TaskNotification {
                task_id: None,
                status: None
            }])
        );
        // Plusieurs notifications dans un même prompt : toutes lues.
        let two = format!(
            "{p}\n<task-notification><task-id>b2</task-id><status>failed</status></task-notification>"
        );
        let all = parse_task_notifications(&two).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[1].task_id.as_deref(), Some("b2"));
        assert_eq!(all[1].status.as_deref(), Some("failed"));
        assert_eq!(parse_task_notifications("Lance <task-notification>"), None);
        assert!(!is_task_notification("bonjour"));
    }

    #[test]
    fn short_texts_are_clipped_on_a_char_boundary() {
        assert_eq!(clip("court"), "court");
        let long = "é".repeat(MAX_FIELD_CHARS + 10);
        assert_eq!(clip(&long).chars().count(), MAX_FIELD_CHARS);
        let t = OffsetDateTime::UNIX_EPOCH;
        let mut s = Subagents::default();
        s.on_start(Some("a"), Some(&"x".repeat(2000)), t);
        assert_eq!(
            s.get("a").unwrap().agent_type.as_ref().unwrap().len(),
            MAX_FIELD_CHARS
        );
    }

    #[test]
    fn status_roundtrip() {
        for s in [
            SubagentStatus::Running,
            SubagentStatus::Done,
            SubagentStatus::Failed,
            SubagentStatus::Interrupted,
        ] {
            assert_eq!(SubagentStatus::parse(s.as_str()), Some(s));
        }
        assert_eq!(SubagentStatus::parse("?"), None);
    }

    #[test]
    fn at_most_max_subagents_oldest_finished_first() {
        let t = OffsetDateTime::UNIX_EPOCH;
        let mut s = Subagents::default();
        s.on_start(Some("keep"), Some("x"), t);
        for i in 0..MAX_SUBAGENTS + 5 {
            let id = format!("a{i}");
            s.on_start(Some(&id), Some("x"), t);
            s.on_stop(Some(&id), None, None, t);
        }
        assert_eq!(s.total(), MAX_SUBAGENTS);
        // L'agent qui tourne reste ; les plus anciens finis sont partis.
        assert!(s.is_running("keep"));
        assert!(s.get("a0").is_none());
        assert!(s.get(&format!("a{}", MAX_SUBAGENTS + 4)).is_some());

        let mut r = Subagents::default();
        r.restore(s.list().to_vec());
        assert_eq!(r.list(), s.list());
        r.on_start(Some("new"), None, t);
        assert!(r.get("new").unwrap().seq > s.list().iter().map(|a| a.seq).max().unwrap());
    }
}
