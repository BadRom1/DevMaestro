//! Sessions Claude Code suivies par l'app.

use std::path::PathBuf;

use serde_json::Value;
use time::OffsetDateTime;
use uuid::Uuid;

use super::hooks::{HookEvent, HookKind};
use super::metrics::{Metrics, ModelInfo};
use super::state::{Applied, Effect, SessionState, apply_tracked};
use super::statusline::Statusline;

/// Une session : un processus `claude` lancé ou repris par l'app.
///
/// Deux identifiants coexistent :
/// - [`Session::id`] : identifiant interne, stable, choisi au lancement ;
/// - [`Session::claude_session_id`] : le `session_id` de Claude Code. Il vaut
///   d'abord l'UUID passé à `--session-id`, mais **change** sur `/clear` ou
///   `/resume` (un `SessionStart` de source `clear` ou `resume` en apporte un
///   nouveau).
///
/// Le démon rattache donc un hook à sa session par le processus et le jeton
/// (`ORCH_TOKEN`), jamais par le `session_id` de Claude Code, qui sert
/// seulement à retrouver le transcript et à reprendre la session.
#[derive(Debug, Clone, PartialEq)]
pub struct Session {
    /// Identifiant interne, stable.
    pub id: Uuid,
    /// `session_id` courant de Claude Code.
    pub claude_session_id: String,
    /// Racine du projet auquel la session appartient.
    pub project_root: PathBuf,
    /// Dossier de travail (le worktree).
    pub cwd: PathBuf,
    /// Branche git du worktree, si connue.
    pub branch: Option<String>,
    /// Nom du profil utilisé.
    pub profile: String,
    /// État piloté par les hooks (voir [`crate::domain::state::apply`]).
    pub state: SessionState,
    /// Mesures, dont le modèle (identifiant et nom affiché), issues de la
    /// statusline et de `SessionStart`.
    pub metrics: Metrics,
}

impl Session {
    /// Nouvelle session à l'état « démarrage ».
    pub fn new(
        id: Uuid,
        claude_session_id: impl Into<String>,
        project_root: impl Into<PathBuf>,
        cwd: impl Into<PathBuf>,
        profile: impl Into<String>,
    ) -> Self {
        Self {
            id,
            claude_session_id: claude_session_id.into(),
            project_root: project_root.into(),
            cwd: cwd.into(),
            branch: None,
            profile: profile.into(),
            state: SessionState::default(),
            metrics: Metrics::default(),
        }
    }

    /// Applique un événement de hook : met à jour le `session_id` de Claude
    /// Code et le modèle sur `SessionStart`, puis la machine à états.
    pub fn apply_hook(&mut self, event: &HookEvent, now: OffsetDateTime) -> Vec<Effect> {
        self.apply_hook_tracked(event, now).effects
    }

    /// Comme [`Session::apply_hook`], en indiquant la demande à laquelle
    /// l'événement se rattache (voir [`crate::domain::state::apply_tracked`]).
    pub fn apply_hook_tracked(&mut self, event: &HookEvent, now: OffsetDateTime) -> Applied {
        if let HookKind::SessionStart { model, .. } = &event.kind {
            self.claude_session_id = event.common.session_id.clone();
            if let Some(id) = model {
                let same = self
                    .metrics
                    .model
                    .as_ref()
                    .is_some_and(|m| m.id.as_deref() == Some(id.as_str()));
                if !same {
                    self.metrics.model = Some(ModelInfo {
                        id: Some(id.clone()),
                        display_name: None,
                    });
                }
            }
        }
        apply_tracked(&mut self.state, event, now)
    }

    /// Fusionne les mesures d'une statusline (voir [`Metrics::merge`]).
    pub fn apply_statusline(&mut self, statusline: &Statusline) {
        self.metrics.merge(statusline.metrics.clone());
    }
}

/// Statut d'une session (architecture § 5.1).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum SessionStatus {
    /// PTY lancé, pas encore de `SessionStart`.
    #[default]
    Starting,
    /// Claude travaille.
    Running,
    /// Claude attend une réponse de l'utilisateur.
    Waiting(WaitKind),
    /// Claude a fini son tour et attend un prompt.
    Idle,
    /// Le tour s'est terminé sur une erreur (`StopFailure`).
    Error,
    /// La session est terminée (`SessionEnd`), avec la raison donnée par Claude Code.
    Stopped { reason: Option<String> },
}

impl SessionStatus {
    /// Genre d'attente, si la session attend une réponse.
    pub fn wait_kind(&self) -> Option<WaitKind> {
        match self {
            SessionStatus::Waiting(kind) => Some(*kind),
            _ => None,
        }
    }
}

/// Ce que la session attend.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WaitKind {
    /// Une autorisation d'outil.
    Permission,
    /// Une réponse à une question de Claude (`AskUserQuestion`, élicitation MCP).
    Question,
}

/// Contenu d'une demande en attente.
#[derive(Debug, Clone, PartialEq)]
pub enum Pending {
    Permission(PermissionPending),
    Question(QuestionPending),
    /// Attente connue seulement par une `Notification` (`permission_prompt`,
    /// `elicitation_dialog`) : on sait qu'une demande existe, pas laquelle.
    Undetailed(WaitKind),
}

impl Pending {
    pub fn kind(&self) -> WaitKind {
        match self {
            Pending::Permission(_) => WaitKind::Permission,
            Pending::Question(_) => WaitKind::Question,
            Pending::Undetailed(kind) => *kind,
        }
    }

    /// Vrai si la demande porte un outil et son entrée.
    pub fn is_detailed(&self) -> bool {
        !matches!(self, Pending::Undetailed(_))
    }

    /// Nom de l'outil concerné.
    pub fn tool_name(&self) -> Option<&str> {
        match self {
            Pending::Permission(p) => Some(&p.tool_name),
            Pending::Question(_) => Some(ASK_USER_QUESTION),
            Pending::Undetailed(_) => None,
        }
    }

    /// Entrée de l'outil telle que reçue par le hook.
    pub fn tool_input(&self) -> Option<&Value> {
        match self {
            Pending::Permission(p) => Some(&p.tool_input),
            Pending::Question(q) => Some(&q.tool_input),
            Pending::Undetailed(_) => None,
        }
    }
}

/// Nom de l'outil de Claude Code qui pose une question à l'utilisateur.
pub const ASK_USER_QUESTION: &str = "AskUserQuestion";

/// Demande d'autorisation d'un outil.
#[derive(Debug, Clone, PartialEq)]
pub struct PermissionPending {
    pub tool_name: String,
    pub tool_input: Value,
    /// `permission_suggestions` reçues avec la demande, brutes : la source de
    /// « Toujours » (voir [`crate::domain::decision::always_rules`]).
    pub suggestions: Vec<Value>,
}

/// Question posée par Claude avec `AskUserQuestion`.
#[derive(Debug, Clone, PartialEq)]
pub struct QuestionPending {
    /// Questions lues dans `tool_input.questions` (vide si illisible).
    pub questions: Vec<Question>,
    /// Entrée brute, à renvoyer complétée de `answers` (ADR 0003, point 5).
    pub tool_input: Value,
}

impl QuestionPending {
    /// Lit les questions dans le `tool_input` d'`AskUserQuestion`, sans échouer :
    /// une entrée mal formée donne une liste vide (la carte renvoie alors vers
    /// le terminal).
    pub fn from_tool_input(tool_input: &Value) -> Self {
        let questions = tool_input
            .get("questions")
            .and_then(Value::as_array)
            .map(|qs| qs.iter().filter_map(Question::from_value).collect())
            .unwrap_or_default();
        Self {
            questions,
            tool_input: tool_input.clone(),
        }
    }
}

/// Une question et ses options.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Question {
    pub question: String,
    pub header: Option<String>,
    pub options: Vec<QuestionOption>,
    pub multi_select: bool,
}

impl Question {
    fn from_value(v: &Value) -> Option<Self> {
        let question = v.get("question")?.as_str()?.to_owned();
        let options = v
            .get("options")
            .and_then(Value::as_array)
            .map(|os| {
                os.iter()
                    .filter_map(|o| {
                        Some(QuestionOption {
                            label: o.get("label")?.as_str()?.to_owned(),
                            description: o
                                .get("description")
                                .and_then(Value::as_str)
                                .map(str::to_owned),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        Some(Self {
            question,
            header: v.get("header").and_then(Value::as_str).map(str::to_owned),
            options,
            multi_select: v
                .get("multiSelect")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        })
    }
}

/// Une option de réponse.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuestionOption {
    pub label: String,
    pub description: Option<String>,
}

/// Mode de permission de Claude Code, tel que l'écrivent les hooks.
///
/// Le mode lancé avec `--permission-mode manual` apparaît comme `default`
/// dans les hooks (prototype n° 1, Q9) : les deux se lisent [`PermissionMode::Default`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PermissionMode {
    Default,
    AcceptEdits,
    Plan,
    Auto,
    BypassPermissions,
    /// Valeur inconnue, gardée telle quelle (le format peut évoluer).
    Other(String),
}

impl PermissionMode {
    /// Lit une valeur de `permission_mode` ; ne refuse jamais rien.
    pub fn parse(s: &str) -> Self {
        match s {
            "default" | "manual" => Self::Default,
            "acceptEdits" => Self::AcceptEdits,
            "plan" => Self::Plan,
            "auto" => Self::Auto,
            "bypassPermissions" => Self::BypassPermissions,
            other => Self::Other(other.to_owned()),
        }
    }

    /// Valeur telle qu'écrite par les hooks.
    pub fn as_str(&self) -> &str {
        match self {
            Self::Default => "default",
            Self::AcceptEdits => "acceptEdits",
            Self::Plan => "plan",
            Self::Auto => "auto",
            Self::BypassPermissions => "bypassPermissions",
            Self::Other(s) => s,
        }
    }

    /// Modes qui retirent les demandes de permission : jamais proposés sans
    /// réglage explicite du démon (`allow_dangerous_modes`).
    pub fn is_dangerous(&self) -> bool {
        matches!(self, Self::BypassPermissions) || self.as_str() == "dontAsk"
    }
}

/// Cycle de Shift+Tab dans la TUI, relevé avec Claude Code 2.1.303
/// (prototype n° 1, Q9) : `manual` → `accept edits` → `plan` → `auto` →
/// `manual`. Il peut changer d'une version à l'autre (ou selon les modes
/// disponibles) : `sessions.setMode` est un contournement, faute d'API.
pub const SHIFT_TAB_CYCLE: [PermissionMode; 4] = [
    PermissionMode::Default,
    PermissionMode::AcceptEdits,
    PermissionMode::Plan,
    PermissionMode::Auto,
];

/// Nombre de Shift+Tab pour passer du mode `current` au mode `target` le
/// long de [`SHIFT_TAB_CYCLE`] ; `None` si l'un des deux n'est pas sur le cycle.
pub fn shift_tab_steps(current: &PermissionMode, target: &PermissionMode) -> Option<usize> {
    let pos = |m: &PermissionMode| SHIFT_TAB_CYCLE.iter().position(|c| c == m);
    let (from, to) = (pos(current)?, pos(target)?);
    Some((to + SHIFT_TAB_CYCLE.len() - from) % SHIFT_TAB_CYCLE.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn hook(json: &str) -> HookEvent {
        HookEvent::parse(json, None).unwrap()
    }

    #[test]
    fn session_start_updates_claude_session_id_and_model() {
        let id = Uuid::nil();
        let mut s = Session::new(id, "a", "/p", "/p", "default");
        let now = OffsetDateTime::UNIX_EPOCH;
        s.apply_statusline(
            &Statusline::parse(
                r#"{"model":{"id":"m1","display_name":"M 1"},"cost":{"total_cost_usd":1}}"#,
            )
            .unwrap(),
        );
        // Même modèle : le nom affiché est gardé.
        s.apply_hook(
            &hook(r#"{"session_id":"a","hook_event_name":"SessionStart","source":"startup","model":"m1"}"#),
            now,
        );
        let model = s.metrics.model.clone().unwrap();
        assert_eq!(model.display_name.as_deref(), Some("M 1"));
        // /clear : nouveau session_id de Claude Code, identifiant interne inchangé.
        s.apply_hook(
            &hook(r#"{"session_id":"b","hook_event_name":"SessionStart","source":"clear","model":"m2"}"#),
            now,
        );
        assert_eq!(s.id, id);
        assert_eq!(s.claude_session_id, "b");
        let model = s.metrics.model.clone().unwrap();
        assert_eq!(model.id.as_deref(), Some("m2"));
        assert_eq!(model.display_name, None);
        // Les autres événements ne changent pas le session_id de Claude Code.
        s.apply_hook(
            &hook(r#"{"session_id":"zzz","hook_event_name":"Stop"}"#),
            now,
        );
        assert_eq!(s.claude_session_id, "b");
        assert_eq!(s.state.status(), SessionStatus::Idle);
        assert_eq!(s.metrics.cost_usd, Some(1.0));
    }

    #[test]
    fn manual_reads_as_default() {
        assert_eq!(PermissionMode::parse("manual"), PermissionMode::Default);
        assert_eq!(PermissionMode::parse("auto").as_str(), "auto");
        assert_eq!(
            PermissionMode::parse("nouveau"),
            PermissionMode::Other("nouveau".into())
        );
    }

    #[test]
    fn shift_tab_cycle() {
        use PermissionMode::*;
        assert_eq!(shift_tab_steps(&Default, &Default), Some(0));
        assert_eq!(shift_tab_steps(&Default, &AcceptEdits), Some(1));
        assert_eq!(shift_tab_steps(&Default, &Auto), Some(3));
        assert_eq!(shift_tab_steps(&Auto, &Default), Some(1));
        assert_eq!(shift_tab_steps(&Plan, &AcceptEdits), Some(3));
        assert_eq!(shift_tab_steps(&BypassPermissions, &Default), None);
        assert_eq!(shift_tab_steps(&Default, &BypassPermissions), None);
        assert_eq!(shift_tab_steps(&Other("dontAsk".into()), &Plan), None);
        assert!(BypassPermissions.is_dangerous());
        assert!(PermissionMode::parse("dontAsk").is_dangerous());
        assert!(!Auto.is_dangerous());
    }

    #[test]
    fn question_parsing_is_tolerant() {
        let q = QuestionPending::from_tool_input(&json!({
            "questions": [
                {"question": "A ou B ?", "header": "Choix", "multiSelect": true,
                 "options": [{"label": "A", "description": "a"}, {"label": 3}, {"label": "B"}]},
                {"header": "sans question"}
            ]
        }));
        assert_eq!(q.questions.len(), 1);
        let first = &q.questions[0];
        assert!(first.multi_select);
        assert_eq!(first.options.len(), 2);
        assert_eq!(first.options[1].description, None);

        assert!(
            QuestionPending::from_tool_input(&json!("n'importe quoi"))
                .questions
                .is_empty()
        );
    }
}
