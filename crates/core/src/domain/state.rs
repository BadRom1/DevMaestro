//! Machine à états d'une session (architecture § 5.1, révisée par les
//! résultats du prototype n° 1 et par la relecture du lot 1).
//!
//! [`apply`] est une fonction pure : elle fait évoluer un [`SessionState`] à
//! partir d'un [`HookEvent`] et renvoie les [`Effect`]s que le démon doit
//! exécuter (notification, retrait d'une carte, libération d'un relais).
//!
//! # Modèle
//!
//! L'état sépare :
//! - l'**activité** : `Starting`, `Running`, `Idle`, `Error` ou `Stopped` ;
//! - les **demandes en attente**, une collection ordonnée (de la plus
//!   ancienne à la plus récente) : plusieurs appels d'outils parallèles
//!   peuvent attendre en même temps. Chaque demande reçoit un identifiant
//!   ([`RequestId`]) attribué par le domaine, croissant au sein de la session.
//!
//! Le statut affiché ([`SessionState::status`]) vaut `Waiting(genre de la
//! demande la plus récente)` tant qu'une demande attend, l'activité sinon.
//!
//! # Règles
//!
//! Pour chaque événement :
//! - `last_activity` prend la date de l'événement ;
//! - `permission_mode` est mis à jour quand l'événement le porte (il est absent
//!   des `Notification`, `SessionStart` et `SessionEnd` : on garde alors
//!   l'ancien). Le mode `manual` du lancement s'écrit `default` dans les hooks.
//!
//! | Événement | Demandes | Activité |
//! |---|---|---|
//! | `SessionStart` (`startup`, `resume`, `clear`, `fork`) | toutes retirées (`Cleared`) | → `Idle` |
//! | `SessionStart` (`compact`) | inchangées | inchangée (compaction en plein tour) |
//! | `UserPromptSubmit` | toutes retirées (`Cleared`) | → `Running` |
//! | `PreToolUse` `AskUserQuestion` | + une question | → `Running` |
//! | `PreToolUse` autre outil | attentes sans détails retirées | → `Running` |
//! | `PermissionRequest` | + une permission (ou une question pour `AskUserQuestion`), sauf si c'est la même demande ; remplace une attente sans détails du même genre (`Superseded`) | inchangée |
//! | `PostToolUse` | retire **sa** demande (`Answered`) et les attentes sans détails | → `Running` |
//! | `PostToolUseFailure` | retire sa demande (`Failed`) et les attentes sans détails | → `Running`, ou `Idle` si `is_interrupt` |
//! | `PermissionDenied` | retire sa demande (`Denied`) et les attentes sans détails | → `Running` |
//! | `Notification` `permission_prompt` / `elicitation_dialog` | + une attente sans détails, voir « Notifications » | inchangée |
//! | `Notification` `idle_prompt` | voir « Interruption par Échap » | → `Idle` depuis `Starting` ou `Running` |
//! | `Notification` autre | inchangées | inchangée |
//! | `Stop` | toutes retirées (`Cleared`) | → `Idle` |
//! | `StopFailure` | toutes retirées (`Cleared`) | → `Error` |
//! | `SessionEnd` | toutes retirées (`Cleared`) | → `Stopped { reason }` |
//! | `SubagentStart`, `SubagentStop`, autres | inchangées | inchangée |
//!
//! Une session `Stopped` n'en sort que par un `SessionStart` (reprise) ; les
//! autres événements tardifs (y compris un `UserPromptSubmit`) ne mettent à
//! jour que l'activité et le mode.
//!
//! Une demande venue d'un sous-agent (`agent_id` présent) reste rattachée à
//! la session parente : c'est elle qui attend.
//!
//! ## Rapprocher une demande de l'événement qui la clôt
//!
//! `PermissionRequest` n'a pas de `tool_use_id` (ADR 0003). On le retrouve
//! dans le `PreToolUse` qui précède : le plus récent, pas encore rattaché, du
//! même outil, dont l'entrée correspond (voir plus bas). Ensuite :
//!
//! 1. si la demande et l'événement de clôture (`PostToolUse`,
//!    `PostToolUseFailure`, `PermissionDenied`) ont tous deux un
//!    `tool_use_id`, seule l'égalité de ces identifiants compte ;
//! 2. sinon, repli sur l'entrée : même outil, et l'entrée de l'événement
//!    **contient** chaque clé de l'entrée attendue avec la même valeur (après
//!    une réponse à `AskUserQuestion`, le `PostToolUse` porte en plus
//!    `answers` et `annotations`, constaté au prototype n° 1). Une entrée
//!    `null` vaut `{}` ; une entrée attendue vide exige l'égalité exacte (`{}`
//!    ne correspond pas à tout).
//!
//! Si plusieurs demandes conviennent, la plus ancienne est retirée.
//!
//! ## Notifications
//!
//! Chaque hook est un processus séparé : l'ordre d'arrivée n'est pas garanti.
//! Une `Notification` `permission_prompt` ou `elicitation_dialog` ne crée une
//! attente sans détails que si :
//! - l'activité est `Starting` ou `Running` (jamais depuis `Idle`, `Error` ou
//!   `Stopped`) ;
//! - aucune demande n'attend déjà ;
//! - aucune demande du même genre n'a été close dans les
//!   [`RECENT_RESOLUTION_WINDOW`] précédentes (notification en retard sur la
//!   réponse).
//!
//! ## Interruption par Échap (à vérifier)
//!
//! Claude Code n'envoie pas de `Stop` quand l'utilisateur interrompt avec
//! Échap. À la `Notification` `idle_prompt` :
//! - les attentes sans détails sont retirées (`Cleared`) ;
//! - les demandes détaillées restent, mais la session est marquée
//!   « peut-être obsolète » ([`SessionState::possibly_stale`]) et
//!   [`Effect::PossiblyStale`] est émis une fois.
//!
//! Le comportement réel (Échap sur une demande de permission ouverte,
//! `idle_prompt` pendant qu'une demande est affichée) reste à vérifier dans un
//! prototype.
//!
//! ## Effets
//!
//! - [`Effect::NotifyWaiting`] pour chaque nouvelle demande ;
//! - [`Effect::RequestResolved`] pour chaque demande retirée, avec la façon
//!   dont elle l'a été (le démon libère le relais correspondant) ;
//! - [`Effect::ClearWaiting`] quand plus aucune demande n'attend ;
//! - [`Effect::PossiblyStale`] quand les demandes restantes deviennent
//!   douteuses.

use serde_json::{Map, Value};
use time::{Duration, OffsetDateTime};

use super::hooks::{HookEvent, HookKind, ToolCall};
use super::session::{
    ASK_USER_QUESTION, Pending, PermissionMode, PermissionPending, QuestionPending, SessionStatus,
    WaitKind,
};

/// Délai pendant lequel une notification d'attente arrivée après la clôture
/// d'une demande du même genre est ignorée.
pub const RECENT_RESOLUTION_WINDOW: Duration = Duration::seconds(2);

/// Nombre maximal de `PreToolUse` gardés pour retrouver un `tool_use_id`.
const MAX_SEEN_TOOL_USES: usize = 64;

/// Identifiant d'une demande, unique au sein d'une session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct RequestId(pub u64);

/// Une demande en attente.
#[derive(Debug, Clone, PartialEq)]
pub struct PendingRequest {
    pub id: RequestId,
    pub pending: Pending,
    /// `tool_use_id` de l'appel, lu directement ou retrouvé dans le `PreToolUse`.
    pub tool_use_id: Option<String>,
    /// Sous-agent à l'origine de la demande, s'il y en a un.
    pub agent_id: Option<String>,
    /// Date d'arrivée de la demande.
    pub since: OffsetDateTime,
}

/// Façon dont une demande a été retirée.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Resolution {
    /// L'outil s'est exécuté (`PostToolUse`).
    Answered,
    /// L'outil a échoué (`PostToolUseFailure`).
    Failed,
    /// L'appel a été refusé (`PermissionDenied`).
    Denied,
    /// Une demande détaillée a remplacé une attente sans détails.
    Superseded,
    /// Fin de tour, nouveau prompt, fin de session, ou attente sans détails
    /// devenue caduque.
    Cleared,
}

/// Ce que le démon doit faire après un événement.
#[derive(Debug, Clone, PartialEq)]
pub enum Effect {
    /// Nouvelle demande : notifier l'utilisateur et afficher la carte.
    NotifyWaiting {
        request_id: RequestId,
        pending: Pending,
    },
    /// Demande retirée : retirer sa carte et libérer son relais (sans décision
    /// si la réponse est venue d'ailleurs).
    RequestResolved {
        request_id: RequestId,
        how: Resolution,
    },
    /// Plus aucune demande n'attend.
    ClearWaiting,
    /// Ces demandes sont peut-être obsolètes (interruption probable).
    PossiblyStale { request_ids: Vec<RequestId> },
}

/// `PreToolUse` vu, gardé pour retrouver le `tool_use_id` d'un `PermissionRequest`.
#[derive(Debug, Clone, PartialEq)]
struct SeenToolUse {
    tool_use_id: Option<String>,
    tool_name: String,
    tool_input: Value,
    claimed: bool,
}

/// Partie de la session que la machine à états fait évoluer.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SessionState {
    /// Mode de permission courant, tel que rapporté par le dernier hook qui le porte.
    pub permission_mode: Option<PermissionMode>,
    /// Date du dernier événement reçu.
    pub last_activity: Option<OffsetDateTime>,
    /// Activité, jamais `Waiting`.
    activity: SessionStatus,
    pending: Vec<PendingRequest>,
    possibly_stale: bool,
    next_id: u64,
    seen_tool_uses: Vec<SeenToolUse>,
    /// Dernière clôture d'une demande détaillée, par genre (permission, question).
    last_resolved: [Option<OffsetDateTime>; 2],
}

impl SessionState {
    /// Statut affiché : `Waiting` tant qu'une demande attend, l'activité sinon.
    pub fn status(&self) -> SessionStatus {
        match self.pending.last() {
            Some(r) => SessionStatus::Waiting(r.pending.kind()),
            None => self.activity.clone(),
        }
    }

    /// Demandes en attente, de la plus ancienne à la plus récente.
    pub fn pending(&self) -> &[PendingRequest] {
        &self.pending
    }

    /// Vrai si les demandes en attente sont peut-être obsolètes (voir
    /// « Interruption par Échap »).
    pub fn possibly_stale(&self) -> bool {
        self.possibly_stale
    }

    fn add(
        &mut self,
        pending: Pending,
        tool_use_id: Option<String>,
        agent_id: Option<String>,
        now: OffsetDateTime,
        fx: &mut Vec<Effect>,
    ) {
        self.next_id += 1;
        let id = RequestId(self.next_id);
        fx.push(Effect::NotifyWaiting {
            request_id: id,
            pending: pending.clone(),
        });
        self.pending.push(PendingRequest {
            id,
            pending,
            tool_use_id,
            agent_id,
            since: now,
        });
    }

    fn remove(&mut self, index: usize, how: Resolution, now: OffsetDateTime, fx: &mut Vec<Effect>) {
        let r = self.pending.remove(index);
        if r.pending.is_detailed() && how != Resolution::Superseded {
            self.last_resolved[kind_index(r.pending.kind())] = Some(now);
        }
        fx.push(Effect::RequestResolved {
            request_id: r.id,
            how,
        });
    }

    /// Retire les demandes qui satisfont `pred`.
    fn remove_where(
        &mut self,
        pred: impl Fn(&PendingRequest) -> bool,
        how: Resolution,
        now: OffsetDateTime,
        fx: &mut Vec<Effect>,
    ) {
        let mut i = 0;
        while i < self.pending.len() {
            if pred(&self.pending[i]) {
                self.remove(i, how, now, fx);
            } else {
                i += 1;
            }
        }
    }

    fn clear_undetailed(&mut self, now: OffsetDateTime, fx: &mut Vec<Effect>) {
        self.remove_where(|r| !r.pending.is_detailed(), Resolution::Cleared, now, fx);
    }

    /// Fin de tour (ou de session) : tout est retiré.
    fn end_turn(&mut self, activity: SessionStatus, now: OffsetDateTime, fx: &mut Vec<Effect>) {
        self.remove_where(|_| true, Resolution::Cleared, now, fx);
        self.seen_tool_uses.clear();
        self.activity = activity;
    }

    fn remember(&mut self, call: &ToolCall, claimed: bool) {
        if call.tool_use_id.is_some()
            && self
                .seen_tool_uses
                .iter()
                .any(|s| s.tool_use_id == call.tool_use_id)
        {
            return;
        }
        if self.seen_tool_uses.len() >= MAX_SEEN_TOOL_USES {
            self.seen_tool_uses.remove(0);
        }
        self.seen_tool_uses.push(SeenToolUse {
            tool_use_id: call.tool_use_id.clone(),
            tool_name: call.tool_name.clone(),
            tool_input: call.tool_input.clone(),
            claimed,
        });
    }

    /// `tool_use_id` du `PreToolUse` le plus récent, non rattaché, qui
    /// correspond à cet appel.
    fn claim_tool_use(&mut self, call: &ToolCall) -> Option<String> {
        let seen = self.seen_tool_uses.iter_mut().rev().find(|s| {
            !s.claimed
                && s.tool_name == call.tool_name
                && input_matches(&call.tool_input, &s.tool_input)
        })?;
        seen.claimed = true;
        seen.tool_use_id.clone()
    }

    fn forget_tool_use(&mut self, tool_use_id: &Option<String>) {
        if tool_use_id.is_some() {
            self.seen_tool_uses
                .retain(|s| &s.tool_use_id != tool_use_id);
        }
    }

    /// Nouvelle demande détaillée, sauf si la même attend déjà.
    fn request(
        &mut self,
        pending: Pending,
        call: &ToolCall,
        tool_use_id: Option<String>,
        agent_id: Option<String>,
        now: OffsetDateTime,
        fx: &mut Vec<Effect>,
    ) {
        let same = self.pending.iter_mut().find(|r| {
            r.pending.tool_name() == Some(call.tool_name.as_str())
                && same_origin(&r.tool_use_id, &tool_use_id)
                && r.pending
                    .tool_input()
                    .is_some_and(|i| normalized(i) == normalized(&call.tool_input))
        });
        if let Some(existing) = same {
            if existing.tool_use_id.is_none() {
                existing.tool_use_id = tool_use_id;
            }
            return;
        }
        let kind = pending.kind();
        self.remove_where(
            |r| r.pending == Pending::Undetailed(kind),
            Resolution::Superseded,
            now,
            fx,
        );
        self.add(pending, tool_use_id, agent_id, now, fx);
    }

    /// Clôture d'un appel d'outil : retire sa demande, s'il y en a une.
    fn close(
        &mut self,
        call: &ToolCall,
        how: Resolution,
        now: OffsetDateTime,
        fx: &mut Vec<Effect>,
    ) {
        self.forget_tool_use(&call.tool_use_id);
        let by_id = self
            .pending
            .iter()
            .position(|r| r.tool_use_id.is_some() && r.tool_use_id == call.tool_use_id);
        let index = by_id.or_else(|| {
            self.pending.iter().position(|r| {
                r.pending.tool_name() == Some(call.tool_name.as_str())
                    && !(r.tool_use_id.is_some() && call.tool_use_id.is_some())
                    && r.pending
                        .tool_input()
                        .is_some_and(|expected| input_matches(&call.tool_input, expected))
            })
        });
        if let Some(i) = index {
            self.remove(i, how, now, fx);
        }
        self.clear_undetailed(now, fx);
        self.activity = SessionStatus::Running;
    }

    /// Attente signalée par une `Notification`, sans détails.
    fn notified_wait(&mut self, kind: WaitKind, now: OffsetDateTime, fx: &mut Vec<Effect>) {
        let active = matches!(
            self.activity,
            SessionStatus::Starting | SessionStatus::Running
        );
        let recently_resolved = self.last_resolved[kind_index(kind)]
            .is_some_and(|t| (now - t).abs() <= RECENT_RESOLUTION_WINDOW);
        if active && self.pending.is_empty() && !recently_resolved {
            self.add(Pending::Undetailed(kind), None, None, now, fx);
        }
    }

    fn idle_prompt(&mut self, now: OffsetDateTime, fx: &mut Vec<Effect>) {
        self.clear_undetailed(now, fx);
        if !self.pending.is_empty() && !self.possibly_stale {
            self.possibly_stale = true;
            fx.push(Effect::PossiblyStale {
                request_ids: self.pending.iter().map(|r| r.id).collect(),
            });
        }
        if matches!(
            self.activity,
            SessionStatus::Starting | SessionStatus::Running
        ) {
            self.activity = SessionStatus::Idle;
        }
    }
}

/// Fin du processus `claude`, vue par le démon (lot 2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProcessExit {
    /// Le démon a demandé l'arrêt (`sessions.stop`, arrêt du démon).
    Requested,
    /// Le processus est sorti seul avec ce code.
    Code(i32),
    /// Le processus a été tué par un signal que le démon n'a pas envoyé.
    Signal(String),
}

/// Raison d'arrêt quand le processus sort sans `SessionEnd`, à la demande du démon.
pub const REASON_STOPPED_BY_APP: &str = "stopped_by_app";
/// Raison d'arrêt quand le processus sort seul, avec le code 0, sans `SessionEnd`.
pub const REASON_PROCESS_EXIT: &str = "process_exit";
/// Raison d'arrêt d'une session retrouvée active en base au démarrage du démon.
pub const REASON_DAEMON_RESTART: &str = "daemon_restart";

impl SessionState {
    /// État relu depuis la base : activité, mode et dernière activité, sans
    /// demande en attente (elles ne survivent pas au processus). `Waiting`
    /// est lu comme `Running`.
    pub fn restored(
        status: SessionStatus,
        permission_mode: Option<PermissionMode>,
        last_activity: Option<OffsetDateTime>,
    ) -> Self {
        let activity = match status {
            SessionStatus::Waiting(_) => SessionStatus::Running,
            other => other,
        };
        Self {
            permission_mode,
            last_activity,
            activity,
            ..Self::default()
        }
    }

    /// Le processus `claude` est terminé.
    ///
    /// Règles (architecture § 5.1) :
    /// - déjà `Stopped` (un `SessionEnd` est arrivé) : rien ne change ;
    /// - sinon toutes les demandes sont retirées (`Cleared`) et l'activité
    ///   devient `Stopped { reason: stopped_by_app }` si le démon a demandé
    ///   l'arrêt, `Stopped { reason: process_exit }` pour un code 0, `Error`
    ///   pour un code non nul ou un signal inattendu.
    ///
    /// `last_activity` n'est pas modifiée : ce n'est pas un événement de Claude.
    pub fn process_exited(&mut self, exit: &ProcessExit, now: OffsetDateTime) -> Vec<Effect> {
        if matches!(self.activity, SessionStatus::Stopped { .. }) {
            return Vec::new();
        }
        let activity = match exit {
            ProcessExit::Requested => SessionStatus::Stopped {
                reason: Some(REASON_STOPPED_BY_APP.to_owned()),
            },
            ProcessExit::Code(0) => SessionStatus::Stopped {
                reason: Some(REASON_PROCESS_EXIT.to_owned()),
            },
            ProcessExit::Code(_) | ProcessExit::Signal(_) => SessionStatus::Error,
        };
        let was_waiting = !self.pending.is_empty();
        let mut fx = Vec::new();
        self.end_turn(activity, now, &mut fx);
        self.possibly_stale = false;
        if was_waiting {
            fx.push(Effect::ClearWaiting);
        }
        fx
    }

    /// Vrai si l'activité est `Stopped` (un `SessionEnd` est arrivé, ou le
    /// processus est terminé).
    pub fn is_stopped(&self) -> bool {
        matches!(self.activity, SessionStatus::Stopped { .. })
    }
}

/// Applique un événement de hook à l'état d'une session. Voir les règles du module.
pub fn apply(state: &mut SessionState, event: &HookEvent, now: OffsetDateTime) -> Vec<Effect> {
    state.last_activity = Some(now);
    if let Some(mode) = &event.common.permission_mode {
        state.permission_mode = Some(mode.clone());
    }
    let is_session_start = matches!(event.kind, HookKind::SessionStart { .. });
    if matches!(state.activity, SessionStatus::Stopped { .. }) && !is_session_start {
        return Vec::new();
    }

    let was_waiting = !state.pending.is_empty();
    let agent_id = event.common.agent_id.clone();
    let mut fx = Vec::new();

    match &event.kind {
        HookKind::SessionStart { source, .. } => {
            if source.as_deref() != Some("compact") {
                state.end_turn(SessionStatus::Idle, now, &mut fx);
            }
        }
        HookKind::UserPromptSubmit { .. } => state.end_turn(SessionStatus::Running, now, &mut fx),
        HookKind::PreToolUse(call) => {
            state.activity = SessionStatus::Running;
            if call.tool_name == ASK_USER_QUESTION {
                state.remember(call, true);
                let tool_use_id = call.tool_use_id.clone();
                state.request(
                    question_from(call),
                    call,
                    tool_use_id,
                    agent_id,
                    now,
                    &mut fx,
                );
            } else {
                state.remember(call, false);
                state.clear_undetailed(now, &mut fx);
            }
        }
        HookKind::PermissionRequest(call) => {
            let tool_use_id = call
                .tool_use_id
                .clone()
                .or_else(|| state.claim_tool_use(call));
            let pending = if call.tool_name == ASK_USER_QUESTION {
                question_from(call)
            } else {
                Pending::Permission(PermissionPending {
                    tool_name: call.tool_name.clone(),
                    tool_input: call.tool_input.clone(),
                })
            };
            state.request(pending, call, tool_use_id, agent_id, now, &mut fx);
        }
        HookKind::PostToolUse(call) => state.close(call, Resolution::Answered, now, &mut fx),
        HookKind::PostToolUseFailure {
            call, is_interrupt, ..
        } => {
            state.close(call, Resolution::Failed, now, &mut fx);
            if *is_interrupt {
                state.activity = SessionStatus::Idle;
            }
        }
        HookKind::PermissionDenied { call, .. } => {
            state.close(call, Resolution::Denied, now, &mut fx)
        }
        HookKind::Notification {
            notification_type, ..
        } => match notification_type.as_deref() {
            Some("permission_prompt") => state.notified_wait(WaitKind::Permission, now, &mut fx),
            Some("elicitation_dialog") => state.notified_wait(WaitKind::Question, now, &mut fx),
            Some("idle_prompt") => state.idle_prompt(now, &mut fx),
            _ => {}
        },
        HookKind::Stop => state.end_turn(SessionStatus::Idle, now, &mut fx),
        HookKind::StopFailure => state.end_turn(SessionStatus::Error, now, &mut fx),
        HookKind::SessionEnd { reason } => state.end_turn(
            SessionStatus::Stopped {
                reason: reason.clone(),
            },
            now,
            &mut fx,
        ),
        HookKind::SubagentStart { .. } | HookKind::SubagentStop { .. } | HookKind::Other { .. } => {
        }
    }

    if state.pending.is_empty() {
        state.possibly_stale = false;
        if was_waiting {
            fx.push(Effect::ClearWaiting);
        }
    }
    fx
}

fn kind_index(kind: WaitKind) -> usize {
    match kind {
        WaitKind::Permission => 0,
        WaitKind::Question => 1,
    }
}

fn question_from(call: &ToolCall) -> Pending {
    Pending::Question(QuestionPending::from_tool_input(&call.tool_input))
}

/// Deux `tool_use_id` désignent-ils le même appel ? Inconnu d'un côté : oui.
fn same_origin(a: &Option<String>, b: &Option<String>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => a == b,
        _ => true,
    }
}

/// Entrée d'outil normalisée : `null` vaut `{}`.
fn normalized(v: &Value) -> Value {
    match v {
        Value::Null => Value::Object(Map::new()),
        other => other.clone(),
    }
}

/// L'entrée `actual` correspond-elle à l'entrée attendue ? Voir « Rapprocher
/// une demande… » dans la documentation du module.
fn input_matches(actual: &Value, expected: &Value) -> bool {
    let (actual, expected) = (normalized(actual), normalized(expected));
    match (&actual, &expected) {
        (Value::Object(a), Value::Object(e)) if !e.is_empty() => {
            e.iter().all(|(k, v)| a.get(k).is_some_and(|x| x == v))
        }
        _ => actual == expected,
    }
}

#[cfg(test)]
mod tests;
