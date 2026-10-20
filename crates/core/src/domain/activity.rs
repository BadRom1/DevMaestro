//! Activité d'une session pour la vue conversation (ADR 0005, point 3) :
//! ce que fait Claude **en ce moment**, dérivé des seuls hooks.
//!
//! Le transcript n'est écrit qu'à la fin de chaque message d'API (prototype
//! n° 5, Q1) : pendant que Claude écrit, la vue conversation ne montre rien
//! de nouveau. L'indicateur d'activité comble l'attente.
//!
//! | Événement (conversation principale) | Activité |
//! |---|---|
//! | `UserPromptSubmit` (prompt ou `task-notification`) | `prompt` (« Claude écrit ») |
//! | `PreToolUse` | `tool` (nom de l'outil) |
//! | `PostToolUse`, `PostToolUseFailure`, `PermissionDenied` | `prompt` |
//! | `PostToolUseFailure` `is_interrupt` (Échap), `Stop`, `StopFailure`, `Notification` `idle_prompt`, `SessionStart` (hors compaction) | `subagents` si un sous-agent tourne ou retient la session, sinon `idle` |
//! | `PreCompact` | `compacting` (l'activité d'avant est gardée) |
//! | `SessionStart` `compact` | l'activité d'avant la compaction |
//! | `SessionEnd`, fin du processus | `idle` |
//! | `SubagentStop`, tic du démon | `subagents` → `idle` quand plus rien ne retient la session |
//!
//! Les hooks d'un sous-agent (`agent_id`) ne changent pas l'activité de la
//! conversation principale. Une demande en attente l'emporte sur tout
//! (`waiting`, depuis l'arrivée de la demande la plus récente).
//!
//! `since` ne change que si le genre (ou l'outil) change : un second
//! `PostToolUse` d'affilée garde la date du premier.

use time::OffsetDateTime;

/// Genre d'activité.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum ActivityKind {
    #[default]
    Idle,
    /// Claude écrit (entre un prompt ou un résultat d'outil et la suite).
    Prompt,
    /// Un outil s'exécute.
    Tool,
    /// Le tour principal est fini, des sous-agents travaillent encore.
    Subagents,
    /// Compaction en cours (entre `PreCompact` et `SessionStart` `compact`).
    Compacting,
    /// Une demande attend l'utilisateur.
    Waiting,
}

impl ActivityKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Prompt => "prompt",
            Self::Tool => "tool",
            Self::Subagents => "subagents",
            Self::Compacting => "compacting",
            Self::Waiting => "waiting",
        }
    }
}

/// Activité courante.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Activity {
    pub kind: ActivityKind,
    /// Outil en cours, pour [`ActivityKind::Tool`].
    pub tool: Option<String>,
    /// Début de cette activité ; `None` si inconnu (session relue en base).
    pub since: Option<OffsetDateTime>,
}

impl Activity {
    /// Passe à `kind` (et `tool`) ; la date ne change que si l'activité change.
    pub fn set(&mut self, kind: ActivityKind, tool: Option<String>, now: OffsetDateTime) {
        if self.kind != kind || self.tool != tool || self.since.is_none() {
            *self = Activity {
                kind,
                tool,
                since: Some(now),
            };
        }
    }
}
