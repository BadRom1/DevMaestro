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
//! | `SessionStart` (`startup`, `resume`, `clear`, `fork`) | toutes retirées (`Cleared`)¹ | → `Idle`, sauf sous-agent en cours ou attendu³ |
//! | `SessionStart` (`compact`) | inchangées | inchangée (compaction en plein tour) |
//! | `UserPromptSubmit` | toutes retirées (`Cleared`)¹ | → `Running` |
//! | `UserPromptSubmit` `<task-notification>…` | inchangées | → `Running` |
//! | `PreToolUse` `AskUserQuestion` | + une question | → `Running`² |
//! | `PreToolUse` autre outil | attentes sans détails retirées | → `Running`² |
//! | `PermissionRequest` | + une permission (ou une question pour `AskUserQuestion`), sauf si c'est la même demande ; remplace une attente sans détails du même genre (`Superseded`) | inchangée |
//! | `PostToolUse` | retire **sa** demande (`Answered`) et les attentes sans détails | → `Running`² |
//! | `PostToolUseFailure` | retire sa demande (`Failed`) et les attentes sans détails | → `Running`, ou `Idle` si `is_interrupt` (sauf sous-agent en cours ou attendu³)² |
//! | `PermissionDenied` | retire sa demande (`Denied`) et les attentes sans détails | → `Running`² |
//! | `Notification` `permission_prompt` / `elicitation_dialog` | + une attente sans détails, voir « Notifications » | inchangée |
//! | `Notification` `idle_prompt` | voir « Interruption par Échap » ; rien si un sous-agent est en cours ou attendu³ | → `Idle` depuis `Starting` ou `Running`, sauf sous-agent en cours ou attendu³ |
//! | `Notification` autre | inchangées | inchangée |
//! | `Stop` | toutes retirées (`Cleared`)¹ | → `Idle`, ou reste `Running` si un sous-agent est en cours ou attendu³ |
//! | `StopFailure` | toutes retirées (`Cleared`)¹ | → `Error` |
//! | `SessionEnd` | toutes retirées (`Cleared`) | → `Stopped { reason }` |
//! | `SubagentStart`, `SubagentStop`, autres | inchangées | inchangée |
//! | Réponse de l'app ([`SessionState::resolve_by_app`]) | retire **cette** demande (`AnsweredByApp`) | → `Running` |
//!
//! [`apply_tracked`] indique en plus, pour un `PermissionRequest` (et le
//! `PreToolUse` d'`AskUserQuestion`), la demande créée ou retrouvée : c'est
//! à elle que le démon rattache le relais bloquant (ADR 0003).
//!
//! Une session `Stopped` n'en sort que par un `SessionStart` (reprise) ; les
//! autres événements tardifs (y compris un `UserPromptSubmit`) ne mettent à
//! jour que l'activité et le mode.
//!
//! Une demande venue d'un sous-agent (`agent_id` présent) reste rattachée à
//! la session parente : c'est elle qui attend. Tous les rapprochements
//! ci-dessous se font **à agent égal** (`agent_id`, `None` pour la
//! conversation principale) : deux sous-agents qui appellent le même outil
//! avec la même entrée ne se confondent pas.
//!
//! ## Sous-agents (v0.2, lot 5)
//!
//! Les sous-agents sont construits par [`super::subagents`] (contrat :
//! `docs/v0.2.md`, « Contrat du lot 5 », d'après la Q12 du prototype n° 1),
//! appelé pour chaque événement ; [`Applied::subagents`] dit ce qui a changé
//! (création ou statut : tout de suite ; compteurs d'outils : notification
//! limitée en fréquence par le démon).
//!
//! ¹ Fin de tour : les demandes (et les `PreToolUse` gardés) d'un sous-agent
//! qui **tourne encore** restent : il travaille en arrière-plan, sa demande
//! est toujours affichée par la TUI. `SessionEnd` et la fin du processus
//! retirent tout (les sous-agents passent d'abord `interrupted`).
//!
//! ² Un hook qui porte un `agent_id` (lancé dans un sous-agent) ne change
//! **jamais** l'activité de la session : les sous-agents tournent en
//! arrière-plan, leurs hooks arrivent aussi après le `Stop` du tour
//! principal. Ses demandes, elles, sont créées et closes comme les autres.
//!
//! ³ « En cours ou attendu » : un `Stop` dont `background_tasks` liste une
//! entrée `type: "subagent"` `running`, ou un sous-agent connu `running`, ou
//! un sous-agent fini en arrière-plan dont la `task-notification` n'est pas
//! encore arrivée. La session reste `Running` (pas de passage `Idle`, donc
//! pas de notification « terminé ») ; seul un `Stop` suivant sans rien en
//! cours ni en attente la rend `Idle`. L'attente de la `task-notification`
//! est bornée : un vrai prompt de l'utilisateur la lève, et elle expire
//! [`super::subagents::NOTIFICATION_GRACE`] après la fin de l'agent : la
//! session retenue passe alors `Idle` au prochain événement ou au tic du
//! démon ([`SessionState::tick`]). `SessionStart` (hors compaction) et Échap
//! (`PostToolUseFailure` `is_interrupt`) suivent la même règle : les
//! sous-agents en arrière-plan continuent. Avant cette décision, un `Stop` dont
//! `background_tasks` est présent fait passer `interrupted` les sous-agents
//! `running` qu'il ne liste plus (sans `SubagentStop`).
//!
//! Le prompt `<task-notification>…` injecté par Claude Code à la fin d'un
//! sous-agent en arrière-plan est une notification interne : il met à jour
//! ce sous-agent (`failed`, `killed`…), relance l'activité (`Running`, Claude
//! reprend) mais ne retire aucune demande et n'est pas retenu comme premier
//! prompt de l'utilisateur ([`super::session::Session::apply_hook_tracked`]).
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
use super::subagents::{SubagentChange, Subagents, parse_task_notifications};

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
    /// Répondue depuis l'app (`sessions.answerPermission`,
    /// `sessions.answerQuestion`) : la décision part par le relais.
    AnsweredByApp,
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
    /// Sous-agent qui a appelé l'outil (gardé après un `Stop` s'il tourne).
    agent_id: Option<String>,
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
    /// Sous-agents de la session (lot 5).
    subagents: Subagents,
    /// Le tour principal est fini mais des sous-agents retiennent la session
    /// `Running` : elle passe `Idle` dès qu'ils ne la retiennent plus
    /// ([`SessionState::tick`]).
    held: bool,
    /// Le dernier `Stop` listait un sous-agent `running` dans
    /// `background_tasks` (connu ou non) : la session reste retenue jusqu'au
    /// `Stop` suivant.
    listed_running: bool,
}

impl SessionState {
    /// Statut affiché : `Waiting` tant qu'une demande attend, l'activité sinon.
    pub fn status(&self) -> SessionStatus {
        match self.pending.last() {
            Some(r) => SessionStatus::Waiting(r.pending.kind()),
            None => self.activity.clone(),
        }
    }

    /// Sous-agents de la session.
    pub fn subagents(&self) -> &Subagents {
        &self.subagents
    }

    /// Remet les sous-agents relus en base (voir [`Subagents::restore`]).
    pub fn restore_subagents(&mut self, agents: Vec<super::subagents::Subagent>) {
        self.subagents.restore(agents);
    }

    /// Reprend les sous-agents d'un état précédent (reprise de la session :
    /// nouveau processus). Ceux qui tournaient encore passent `interrupted` ;
    /// l'ordre de lancement continue. Renvoie le changement.
    pub fn carry_subagents_from(
        &mut self,
        previous: SessionState,
        now: OffsetDateTime,
    ) -> SubagentChange {
        self.subagents = previous.subagents;
        self.subagents.on_session_end(now)
    }

    /// Réévalue l'attente des sous-agents à `now` (délai de grâce de la
    /// `task-notification`) : vrai si la session vient de passer `Idle`.
    pub fn tick(&mut self, now: OffsetDateTime) -> bool {
        if self.held
            && self.activity == SessionStatus::Running
            && !self.listed_running
            && !self.subagents.busy(now)
        {
            self.held = false;
            self.activity = SessionStatus::Idle;
            return true;
        }
        false
    }

    /// Activité de fin de tour : `Running` (retenue par les sous-agents) ou
    /// `Idle`.
    fn turn_end_activity(&mut self, now: OffsetDateTime) -> SessionStatus {
        self.held = self.subagents.busy(now);
        if self.held {
            SessionStatus::Running
        } else {
            SessionStatus::Idle
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

    /// Demande en attente portant cet identifiant.
    pub fn pending_request(&self, id: RequestId) -> Option<&PendingRequest> {
        self.pending.iter().find(|r| r.id == id)
    }

    /// La demande `id` a reçu une réponse de l'app (la décision part par son
    /// relais) : elle est retirée (`AnsweredByApp`) et Claude reprend
    /// (`Running`). `None` si elle n'attend plus (déjà close, ou inconnue).
    ///
    /// La clôture est datée comme les autres : une `Notification`
    /// `permission_prompt` en retard ne recrée pas d'attente sans détails.
    pub fn resolve_by_app(&mut self, id: RequestId, now: OffsetDateTime) -> Option<Vec<Effect>> {
        let index = self.pending.iter().position(|r| r.id == id)?;
        let mut fx = Vec::new();
        self.remove(index, Resolution::AnsweredByApp, now, &mut fx);
        if !self.is_stopped() {
            self.activity = SessionStatus::Running;
        }
        if self.pending.is_empty() {
            self.possibly_stale = false;
            fx.push(Effect::ClearWaiting);
        }
        Some(fx)
    }

    fn add(
        &mut self,
        pending: Pending,
        tool_use_id: Option<String>,
        agent_id: Option<String>,
        now: OffsetDateTime,
        fx: &mut Vec<Effect>,
    ) -> RequestId {
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
        id
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

    /// Fin de tour (ou de session) : tout est retiré, sauf ce qui vient d'un
    /// sous-agent qui tourne encore (il travaille en arrière-plan, sa demande
    /// reste posée).
    fn end_turn(&mut self, activity: SessionStatus, now: OffsetDateTime, fx: &mut Vec<Effect>) {
        let subagents = &self.subagents;
        let live = |a: &Option<String>| a.as_deref().is_some_and(|id| subagents.is_running(id));
        let keep: Vec<RequestId> = self
            .pending
            .iter()
            .filter(|r| live(&r.agent_id))
            .map(|r| r.id)
            .collect();
        self.seen_tool_uses.retain(|s| live(&s.agent_id));
        self.remove_where(|r| !keep.contains(&r.id), Resolution::Cleared, now, fx);
        self.activity = activity;
    }

    fn remember(&mut self, call: &ToolCall, agent_id: Option<String>, claimed: bool) {
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
            agent_id,
            tool_use_id: call.tool_use_id.clone(),
            tool_name: call.tool_name.clone(),
            tool_input: call.tool_input.clone(),
            claimed,
        });
    }

    /// `tool_use_id` du `PreToolUse` le plus récent, non rattaché, du même
    /// agent (`None` : conversation principale), qui correspond à cet appel.
    fn claim_tool_use(&mut self, call: &ToolCall, agent_id: &Option<String>) -> Option<String> {
        let seen = self.seen_tool_uses.iter_mut().rev().find(|s| {
            !s.claimed
                && &s.agent_id == agent_id
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

    /// Nouvelle demande détaillée, sauf si la même attend déjà. Renvoie
    /// l'identifiant de la demande, nouvelle ou retrouvée.
    fn request(
        &mut self,
        pending: Pending,
        call: &ToolCall,
        tool_use_id: Option<String>,
        agent_id: Option<String>,
        now: OffsetDateTime,
        fx: &mut Vec<Effect>,
    ) -> RequestId {
        let same = self.pending.iter_mut().find(|r| {
            r.pending.tool_name() == Some(call.tool_name.as_str())
                && r.agent_id == agent_id
                && same_origin(&r.tool_use_id, &tool_use_id)
                && r.pending
                    .tool_input()
                    .is_some_and(|i| normalized(i) == normalized(&call.tool_input))
        });
        if let Some(existing) = same {
            if existing.tool_use_id.is_none() {
                existing.tool_use_id = tool_use_id;
            }
            // Les suggestions de « Toujours » sont celles de la **première**
            // trame : une trame suivante (relance du hook, ou trame forgée
            // par un processus de la session) ne les remplace jamais.
            return existing.id;
        }
        let kind = pending.kind();
        self.remove_where(
            |r| r.pending == Pending::Undetailed(kind),
            Resolution::Superseded,
            now,
            fx,
        );
        self.add(pending, tool_use_id, agent_id, now, fx)
    }

    /// Clôture d'un appel d'outil : retire sa demande, s'il y en a une.
    /// `agent_id` : agent qui a appelé l'outil (`None` : conversation
    /// principale) ; le repli sur l'entrée ne retient que ses demandes, et
    /// l'activité de la session n'est pas touchée pour un sous-agent.
    fn close(
        &mut self,
        call: &ToolCall,
        how: Resolution,
        agent_id: &Option<String>,
        now: OffsetDateTime,
        fx: &mut Vec<Effect>,
    ) {
        let from_subagent = agent_id.is_some();
        self.forget_tool_use(&call.tool_use_id);
        let by_id = self
            .pending
            .iter()
            .position(|r| r.tool_use_id.is_some() && r.tool_use_id == call.tool_use_id);
        let index = by_id.or_else(|| {
            self.pending.iter().position(|r| {
                r.pending.tool_name() == Some(call.tool_name.as_str())
                    && &r.agent_id == agent_id
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
        if !from_subagent {
            self.activity = SessionStatus::Running;
            self.held = false;
        }
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
        if self.subagents.busy(now) {
            // Claude attend ses sous-agents : rien n'a changé.
            if self.activity == SessionStatus::Running {
                self.held = true;
            }
            return;
        }
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
        self.subagents.on_session_end(now);
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
    apply_tracked(state, event, now).effects
}

/// Résultat de [`apply_tracked`].
#[derive(Debug, Clone, PartialEq)]
pub struct Applied {
    pub effects: Vec<Effect>,
    /// Pour un `PermissionRequest` (ou un `PreToolUse` d'`AskUserQuestion`) :
    /// la demande à laquelle il se rattache, nouvelle ou déjà connue. C'est
    /// à elle que le démon accroche le relais qui attend la décision.
    pub request: Option<RequestId>,
    /// Ce que l'événement a changé dans les sous-agents.
    pub subagents: SubagentChange,
}

/// Comme [`apply`], en indiquant la demande créée ou retrouvée.
pub fn apply_tracked(state: &mut SessionState, event: &HookEvent, now: OffsetDateTime) -> Applied {
    state.last_activity = Some(now);
    if let Some(mode) = &event.common.permission_mode {
        state.permission_mode = Some(mode.clone());
    }
    let is_session_start = matches!(event.kind, HookKind::SessionStart { .. });
    if matches!(state.activity, SessionStatus::Stopped { .. }) && !is_session_start {
        return Applied {
            effects: Vec::new(),
            request: None,
            subagents: SubagentChange::None,
        };
    }
    let mut request = None;
    let mut subagents = SubagentChange::None;
    let from_subagent = event.common.agent_id.is_some();

    let was_waiting = !state.pending.is_empty();
    let agent_id = event.common.agent_id.clone();
    let mut fx = Vec::new();

    match &event.kind {
        HookKind::SessionStart { source, .. } => {
            if source.as_deref() != Some("compact") {
                state.subagents.forget_launches();
                // Les sous-agents en arrière-plan survivent à `/clear` (Q12).
                let activity = state.turn_end_activity(now);
                state.end_turn(activity, now, &mut fx);
            }
        }
        HookKind::UserPromptSubmit { prompt } => {
            state.held = false;
            match prompt.as_deref().and_then(parse_task_notifications) {
                // Notification interne de Claude Code (fin d'un sous-agent en
                // arrière-plan) : Claude reprend, rien n'est retiré.
                Some(list) => {
                    for n in &list {
                        subagents = subagents.max(state.subagents.on_task_notification(n, now));
                    }
                    state.activity = SessionStatus::Running;
                }
                None => {
                    // L'utilisateur reprend la main : plus de notification attendue.
                    state.subagents.on_user_prompt();
                    state.end_turn(SessionStatus::Running, now, &mut fx)
                }
            }
        }
        HookKind::PreToolUse(call) => {
            subagents = state.subagents.on_pre_tool_use(agent_id.as_deref(), call);
            if !from_subagent {
                state.activity = SessionStatus::Running;
                state.held = false;
            }
            if call.tool_name == ASK_USER_QUESTION {
                state.remember(call, agent_id.clone(), true);
                let tool_use_id = call.tool_use_id.clone();
                request = Some(state.request(
                    question_from(call),
                    call,
                    tool_use_id,
                    agent_id,
                    now,
                    &mut fx,
                ));
            } else {
                state.remember(call, agent_id, false);
                state.clear_undetailed(now, &mut fx);
            }
        }
        HookKind::PermissionRequest(call) => {
            let tool_use_id = call
                .tool_use_id
                .clone()
                .or_else(|| state.claim_tool_use(call, &agent_id));
            let pending = if call.tool_name == ASK_USER_QUESTION {
                question_from(call)
            } else {
                Pending::Permission(PermissionPending {
                    tool_name: call.tool_name.clone(),
                    tool_input: call.tool_input.clone(),
                    suggestions: call.permission_suggestions.clone(),
                })
            };
            request = Some(state.request(pending, call, tool_use_id, agent_id, now, &mut fx));
        }
        HookKind::PostToolUse(call) => {
            subagents = state
                .subagents
                .on_post_tool_use(agent_id.as_deref(), call, None, now);
            state.close(call, Resolution::Answered, &agent_id, now, &mut fx)
        }
        HookKind::PostToolUseFailure {
            call, is_interrupt, ..
        } => {
            subagents = state.subagents.on_post_tool_use(
                agent_id.as_deref(),
                call,
                Some(*is_interrupt),
                now,
            );
            state.close(call, Resolution::Failed, &agent_id, now, &mut fx);
            // Échap n'arrête pas un sous-agent en arrière-plan (Q12).
            if *is_interrupt && !from_subagent {
                state.activity = state.turn_end_activity(now);
            }
        }
        HookKind::PermissionDenied { call, .. } => {
            state.close(call, Resolution::Denied, &agent_id, now, &mut fx)
        }
        HookKind::Notification {
            notification_type, ..
        } => match notification_type.as_deref() {
            Some("permission_prompt") => state.notified_wait(WaitKind::Permission, now, &mut fx),
            Some("elicitation_dialog") => state.notified_wait(WaitKind::Question, now, &mut fx),
            Some("idle_prompt") => state.idle_prompt(now, &mut fx),
            _ => {}
        },
        HookKind::Stop { background_tasks } => {
            subagents = state
                .subagents
                .on_turn_stop(background_tasks.as_deref(), now);
            // Un sous-agent tourne (ou sa `task-notification` doit suivre) :
            // la session reste en cours, seul un `Stop` suivant la rendra
            // inactive.
            let mut activity = state.turn_end_activity(now);
            state.listed_running = background_tasks
                .iter()
                .flatten()
                .any(|t| t.is_running_subagent());
            if state.listed_running {
                state.held = true;
                activity = SessionStatus::Running;
            }
            state.end_turn(activity, now, &mut fx)
        }
        HookKind::StopFailure => {
            state.held = false;
            state.end_turn(SessionStatus::Error, now, &mut fx)
        }
        HookKind::SessionEnd { reason } => {
            state.held = false;
            subagents = state.subagents.on_session_end(now);
            state.end_turn(
                SessionStatus::Stopped {
                    reason: reason.clone(),
                },
                now,
                &mut fx,
            )
        }
        HookKind::SubagentStart {
            agent_id,
            agent_type,
        } => {
            subagents = state
                .subagents
                .on_start(agent_id.as_deref(), agent_type.as_deref(), now);
        }
        HookKind::SubagentStop {
            agent_id,
            last_assistant_message,
            agent_transcript_path,
            ..
        } => {
            subagents = state.subagents.on_stop(
                agent_id.as_deref(),
                last_assistant_message.as_deref(),
                agent_transcript_path.as_deref(),
                now,
            );
        }
        HookKind::Other { .. } => {}
    }
    // Délai de grâce de la `task-notification` écoulé : la session n'est
    // plus retenue (évalué à chaque événement, et par le tic du démon).
    state.tick(now);

    if state.pending.is_empty() {
        state.possibly_stale = false;
        if was_waiting {
            fx.push(Effect::ClearWaiting);
        }
    }
    Applied {
        effects: fx,
        request,
        subagents,
    }
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
mod subagent_tests;
#[cfg(test)]
mod tests;
