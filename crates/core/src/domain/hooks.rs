//! Lecture tolérante du JSON que Claude Code envoie aux hooks sur stdin.
//!
//! Règles :
//! - les champs inconnus sont ignorés ;
//! - un champ facultatif absent ou d'un type inattendu est lu comme absent ;
//! - un événement inconnu donne [`HookKind::Other`] ;
//! - seule une entrée inexploitable (JSON invalide, pas un objet, pas de
//!   `session_id`, pas de nom d'événement, pas de `tool_name` pour un
//!   événement d'outil) renvoie une erreur. Jamais de panique.

use serde_json::{Map, Value};
use thiserror::Error;

use super::session::PermissionMode;

/// Un événement de hook lu.
#[derive(Debug, Clone, PartialEq)]
pub struct HookEvent {
    pub common: HookCommon,
    pub kind: HookKind,
}

/// Champs communs à tous les événements.
#[derive(Debug, Clone, PartialEq)]
pub struct HookCommon {
    /// `session_id` : l'UUID passé à `--session-id` (prototype n° 1, Q3).
    pub session_id: String,
    pub cwd: Option<String>,
    pub transcript_path: Option<String>,
    /// Absent de certains événements (`Notification`, `SessionStart`, `SessionEnd`).
    pub permission_mode: Option<PermissionMode>,
    /// Sous-agent dans lequel le hook se déclenche (`agent_id`), absent dans
    /// la conversation principale. Une demande venue d'un sous-agent reste
    /// rattachée à la session parente.
    pub agent_id: Option<String>,
    /// Type du sous-agent (`Explore`…) ou de l'agent lancé avec `--agent`.
    pub agent_type: Option<String>,
}

/// Appel d'outil vu par `PreToolUse`, `PostToolUse` ou `PermissionRequest`.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolCall {
    pub tool_name: String,
    /// `Value::Null` si absent.
    pub tool_input: Value,
    /// Absent de `PermissionRequest` (ADR 0003).
    pub tool_use_id: Option<String>,
    /// `permission_suggestions` de `PermissionRequest` : les mises à jour de
    /// permissions que Claude Code propose pour cette demande (entrées
    /// `addRules`, `setMode`…), gardées brutes. Vide ailleurs ou si absent.
    pub permission_suggestions: Vec<Value>,
    /// `tool_response` de `PostToolUse`, gardée brute (`Value::Null` si
    /// absente). Pour l'outil `Agent`, elle porte `agentId`, `description`,
    /// `resolvedModel` et `status` (prototype n° 1, Q12).
    pub tool_response: Value,
}

/// Tâche de fond listée par `background_tasks` (`Stop`, `SubagentStop`).
#[derive(Debug, Clone, PartialEq)]
pub struct BackgroundTask {
    pub id: String,
    /// `subagent` pour un sous-agent ; les autres types sont ignorés.
    pub task_type: Option<String>,
    /// `running`…
    pub status: Option<String>,
}

impl BackgroundTask {
    /// Sous-agent encore en cours ?
    pub fn is_running_subagent(&self) -> bool {
        self.task_type.as_deref() == Some("subagent") && self.status.as_deref() == Some("running")
    }
}

/// Événement, avec ses champs propres.
#[derive(Debug, Clone, PartialEq)]
pub enum HookKind {
    SessionStart {
        /// `startup`, `resume`, `clear`, `compact`, `fork`…
        source: Option<String>,
        model: Option<String>,
    },
    UserPromptSubmit {
        prompt: Option<String>,
    },
    PreToolUse(ToolCall),
    PostToolUse(ToolCall),
    /// L'outil a échoué (ou a été interrompu, `is_interrupt`).
    PostToolUseFailure {
        call: ToolCall,
        error: Option<String>,
        is_interrupt: bool,
    },
    PermissionRequest(ToolCall),
    /// Le mode auto a refusé l'appel.
    PermissionDenied {
        call: ToolCall,
        reason: Option<String>,
    },
    Notification {
        /// `idle_prompt`, `permission_prompt`, `elicitation_dialog`…
        notification_type: Option<String>,
        message: Option<String>,
    },
    Stop {
        /// `background_tasks` : tâches de fond encore listées par Claude Code
        /// à la fin du tour. `None` si le champ est absent (version de Claude
        /// Code qui ne l'envoie pas) : rien n'en est déduit.
        background_tasks: Option<Vec<BackgroundTask>>,
    },
    StopFailure,
    SessionEnd {
        /// `prompt_input_exit` pour `/exit` comme pour un double Ctrl+C.
        reason: Option<String>,
    },
    SubagentStart {
        agent_id: Option<String>,
        agent_type: Option<String>,
    },
    /// Fin d'un sous-agent. Son `background_tasks` n'est pas lu : il liste
    /// encore l'agent qui s'arrête (prototype n° 1, Q12).
    SubagentStop {
        agent_id: Option<String>,
        agent_type: Option<String>,
        /// `last_assistant_message` : le rapport du sous-agent (absent pour
        /// certains agents internes de Claude Code).
        last_assistant_message: Option<String>,
        /// `agent_transcript_path` : transcript du sous-agent.
        agent_transcript_path: Option<String>,
    },
    /// Événement que le domaine ne connaît pas (encore).
    Other {
        name: String,
    },
}

impl HookKind {
    /// Appel d'outil porté par l'événement, s'il y en a un.
    pub fn tool_call(&self) -> Option<&ToolCall> {
        match self {
            HookKind::PreToolUse(call)
            | HookKind::PostToolUse(call)
            | HookKind::PermissionRequest(call)
            | HookKind::PostToolUseFailure { call, .. }
            | HookKind::PermissionDenied { call, .. } => Some(call),
            _ => None,
        }
    }

    /// Nom de l'événement tel qu'écrit par Claude Code.
    pub fn name(&self) -> &str {
        match self {
            HookKind::SessionStart { .. } => "SessionStart",
            HookKind::UserPromptSubmit { .. } => "UserPromptSubmit",
            HookKind::PreToolUse(_) => "PreToolUse",
            HookKind::PostToolUse(_) => "PostToolUse",
            HookKind::PostToolUseFailure { .. } => "PostToolUseFailure",
            HookKind::PermissionRequest(_) => "PermissionRequest",
            HookKind::PermissionDenied { .. } => "PermissionDenied",
            HookKind::Notification { .. } => "Notification",
            HookKind::Stop { .. } => "Stop",
            HookKind::StopFailure => "StopFailure",
            HookKind::SessionEnd { .. } => "SessionEnd",
            HookKind::SubagentStart { .. } => "SubagentStart",
            HookKind::SubagentStop { .. } => "SubagentStop",
            HookKind::Other { name } => name,
        }
    }
}

/// Entrée de hook inexploitable.
#[derive(Debug, Error)]
pub enum HookParseError {
    #[error("JSON de hook invalide : {0}")]
    InvalidJson(#[from] serde_json::Error),
    #[error("le JSON de hook n'est pas un objet")]
    NotAnObject,
    #[error("champ obligatoire absent ou mal typé : {0}")]
    MissingField(&'static str),
}

impl HookEvent {
    /// Lit le JSON reçu sur stdin.
    ///
    /// Le nom de l'événement vient de `hook_event_name` ; à défaut, de
    /// `event_hint` (l'argument de `orchd hook <événement>`).
    pub fn parse(input: &str, event_hint: Option<&str>) -> Result<Self, HookParseError> {
        let value: Value = serde_json::from_str(input)?;
        Self::from_value(&value, event_hint)
    }

    /// Comme [`HookEvent::parse`], depuis un JSON déjà décodé.
    pub fn from_value(value: &Value, event_hint: Option<&str>) -> Result<Self, HookParseError> {
        let obj = value.as_object().ok_or(HookParseError::NotAnObject)?;
        let name = str_field(obj, "hook_event_name")
            .or_else(|| event_hint.map(str::to_owned))
            .ok_or(HookParseError::MissingField("hook_event_name"))?;
        let common = HookCommon {
            session_id: str_field(obj, "session_id")
                .ok_or(HookParseError::MissingField("session_id"))?,
            cwd: str_field(obj, "cwd"),
            transcript_path: str_field(obj, "transcript_path"),
            permission_mode: obj
                .get("permission_mode")
                .and_then(Value::as_str)
                .map(PermissionMode::parse),
            agent_id: str_field(obj, "agent_id"),
            agent_type: str_field(obj, "agent_type"),
        };
        let kind = match name.as_str() {
            "SessionStart" => HookKind::SessionStart {
                source: str_field(obj, "source"),
                model: model_field(obj),
            },
            "UserPromptSubmit" => HookKind::UserPromptSubmit {
                prompt: str_field(obj, "prompt"),
            },
            "PreToolUse" => HookKind::PreToolUse(tool_call(obj)?),
            "PostToolUse" => HookKind::PostToolUse(tool_call(obj)?),
            "PostToolUseFailure" => HookKind::PostToolUseFailure {
                call: tool_call(obj)?,
                error: str_field(obj, "error"),
                is_interrupt: obj
                    .get("is_interrupt")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            },
            "PermissionRequest" => HookKind::PermissionRequest(tool_call(obj)?),
            "PermissionDenied" => HookKind::PermissionDenied {
                call: tool_call(obj)?,
                reason: str_field(obj, "reason"),
            },
            "Notification" => HookKind::Notification {
                notification_type: str_field(obj, "notification_type"),
                message: str_field(obj, "message"),
            },
            "Stop" => HookKind::Stop {
                background_tasks: background_tasks(obj),
            },
            "StopFailure" => HookKind::StopFailure,
            "SessionEnd" => HookKind::SessionEnd {
                reason: str_field(obj, "reason"),
            },
            "SubagentStart" => HookKind::SubagentStart {
                agent_id: str_field(obj, "agent_id"),
                agent_type: str_field(obj, "agent_type"),
            },
            "SubagentStop" => HookKind::SubagentStop {
                agent_id: str_field(obj, "agent_id"),
                agent_type: str_field(obj, "agent_type"),
                last_assistant_message: str_field(obj, "last_assistant_message"),
                agent_transcript_path: str_field(obj, "agent_transcript_path"),
            },
            _ => HookKind::Other { name },
        };
        Ok(Self { common, kind })
    }
}

fn str_field(obj: &Map<String, Value>, key: &str) -> Option<String> {
    obj.get(key).and_then(Value::as_str).map(str::to_owned)
}

/// Champ texte `key` d'une valeur JSON brute (`tool_input`, `tool_response`) ;
/// absent si la valeur n'est pas un objet ou si le champ n'est pas un texte.
pub(crate) fn str_in(value: &Value, key: &str) -> Option<String> {
    value.as_object().and_then(|o| str_field(o, key))
}

/// `model` est une chaîne dans `SessionStart` ; on accepte aussi un objet
/// `{id, display_name}` comme dans la statusline.
fn model_field(obj: &Map<String, Value>) -> Option<String> {
    match obj.get("model")? {
        Value::String(s) => Some(s.clone()),
        Value::Object(m) => str_field(m, "id").or_else(|| str_field(m, "display_name")),
        _ => None,
    }
}

fn tool_call(obj: &Map<String, Value>) -> Result<ToolCall, HookParseError> {
    Ok(ToolCall {
        tool_name: str_field(obj, "tool_name").ok_or(HookParseError::MissingField("tool_name"))?,
        tool_input: obj.get("tool_input").cloned().unwrap_or(Value::Null),
        tool_use_id: str_field(obj, "tool_use_id"),
        permission_suggestions: obj
            .get("permission_suggestions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        tool_response: obj.get("tool_response").cloned().unwrap_or(Value::Null),
    })
}

/// `background_tasks` : tableau d'objets ; une entrée sans `id` texte est
/// ignorée, un champ qui n'est pas un tableau vaut absent.
fn background_tasks(obj: &Map<String, Value>) -> Option<Vec<BackgroundTask>> {
    let list = obj.get("background_tasks")?.as_array()?;
    Some(
        list.iter()
            .filter_map(Value::as_object)
            .filter_map(|t| {
                Some(BackgroundTask {
                    id: str_field(t, "id")?,
                    task_type: str_field(t, "type"),
                    status: str_field(t, "status"),
                })
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const SID: &str = "568e8a35-a919-4f8d-9925-6992b574be75";

    #[test]
    fn parses_permission_request() {
        let ev = HookEvent::parse(
            &format!(
                r#"{{"session_id":"{SID}","cwd":"~/x","permission_mode":"default",
                "hook_event_name":"PermissionRequest","tool_name":"Bash",
                "tool_input":{{"command":"touch /tmp/x"}},"permission_suggestions":[],
                "effort":{{"level":"medium"}}}}"#
            ),
            None,
        )
        .unwrap();
        assert_eq!(ev.common.session_id, SID);
        assert_eq!(ev.common.permission_mode, Some(PermissionMode::Default));
        let HookKind::PermissionRequest(call) = ev.kind else {
            panic!("PermissionRequest attendu");
        };
        assert_eq!(call.tool_name, "Bash");
        assert_eq!(call.tool_input["command"], "touch /tmp/x");
        assert_eq!(call.tool_use_id, None);
        assert!(call.permission_suggestions.is_empty());
    }

    #[test]
    fn keeps_permission_suggestions() {
        let ev = HookEvent::parse(
            &format!(
                r#"{{"session_id":"{SID}","hook_event_name":"PermissionRequest","tool_name":"Bash",
                "tool_input":{{"command":"rm -rf node_modules"}},
                "permission_suggestions":[{{"type":"addRules","rules":[{{"toolName":"Bash","ruleContent":"rm -rf node_modules"}}],
                "behavior":"allow","destination":"localSettings"}}, 3]}}"#
            ),
            None,
        )
        .unwrap();
        let HookKind::PermissionRequest(call) = ev.kind else {
            panic!("PermissionRequest attendu");
        };
        assert_eq!(call.permission_suggestions.len(), 2);
        assert_eq!(call.permission_suggestions[0]["type"], "addRules");
    }

    #[test]
    fn unknown_event_is_other() {
        let ev = HookEvent::parse(
            &format!(r#"{{"session_id":"{SID}","hook_event_name":"PreCompact","trigger":"auto"}}"#),
            None,
        )
        .unwrap();
        assert_eq!(
            ev.kind,
            HookKind::Other {
                name: "PreCompact".into()
            }
        );
    }

    #[test]
    fn event_name_falls_back_to_hint() {
        let ev = HookEvent::parse(&format!(r#"{{"session_id":"{SID}"}}"#), Some("Stop")).unwrap();
        assert_eq!(
            ev.kind,
            HookKind::Stop {
                background_tasks: None
            }
        );
        // Le nom présent dans le JSON l'emporte sur l'indice.
        let ev = HookEvent::parse(
            &format!(r#"{{"session_id":"{SID}","hook_event_name":"StopFailure"}}"#),
            Some("Stop"),
        )
        .unwrap();
        assert_eq!(ev.kind, HookKind::StopFailure);
    }

    #[test]
    fn wrongly_typed_optional_fields_are_ignored() {
        let ev = HookEvent::parse(
            &format!(
                r#"{{"session_id":"{SID}","hook_event_name":"SessionEnd","reason":42,
                "permission_mode":["x"],"cwd":null}}"#
            ),
            None,
        )
        .unwrap();
        assert_eq!(ev.kind, HookKind::SessionEnd { reason: None });
        assert_eq!(ev.common.permission_mode, None);
        assert_eq!(ev.common.cwd, None);
    }

    #[test]
    fn session_start_reads_model_string_or_object() {
        let ev = HookEvent::parse(
            &format!(
                r#"{{"session_id":"{SID}","hook_event_name":"SessionStart","source":"startup","model":"claude-opus-5-5"}}"#
            ),
            None,
        )
        .unwrap();
        assert_eq!(
            ev.kind,
            HookKind::SessionStart {
                source: Some("startup".into()),
                model: Some("claude-opus-5-5".into())
            }
        );
        let ev = HookEvent::parse(
            &format!(
                r#"{{"session_id":"{SID}","hook_event_name":"SessionStart","model":{{"id":"m"}}}}"#
            ),
            None,
        )
        .unwrap();
        assert!(matches!(ev.kind, HookKind::SessionStart { model: Some(m), .. } if m == "m"));
    }

    #[test]
    fn bad_input_is_an_error_not_a_panic() {
        assert!(matches!(
            HookEvent::parse("{pas du json", None),
            Err(HookParseError::InvalidJson(_))
        ));
        assert!(matches!(
            HookEvent::parse("[1,2]", None),
            Err(HookParseError::NotAnObject)
        ));
        assert!(matches!(
            HookEvent::parse(r#"{"hook_event_name":"Stop"}"#, None),
            Err(HookParseError::MissingField("session_id"))
        ));
        assert!(matches!(
            HookEvent::parse(&format!(r#"{{"session_id":"{SID}"}}"#), None),
            Err(HookParseError::MissingField("hook_event_name"))
        ));
        assert!(matches!(
            HookEvent::parse(
                &format!(r#"{{"session_id":"{SID}","hook_event_name":"PreToolUse"}}"#),
                None
            ),
            Err(HookParseError::MissingField("tool_name"))
        ));
        assert!(HookEvent::parse("", None).is_err());
    }

    #[test]
    fn parses_failure_denial_and_agent_fields() {
        let ev = HookEvent::parse(
            &format!(
                r#"{{"session_id":"{SID}","hook_event_name":"PostToolUseFailure","tool_name":"Bash",
                "tool_input":{{"command":"npm test"}},"tool_use_id":"toolu_1","error":"Exit code 1",
                "is_interrupt":true,"agent_id":"agent-1","agent_type":"Explore"}}"#
            ),
            None,
        )
        .unwrap();
        assert_eq!(ev.common.agent_id.as_deref(), Some("agent-1"));
        assert_eq!(ev.common.agent_type.as_deref(), Some("Explore"));
        let HookKind::PostToolUseFailure {
            call,
            error,
            is_interrupt,
        } = &ev.kind
        else {
            panic!("PostToolUseFailure attendu");
        };
        assert_eq!(call.tool_use_id.as_deref(), Some("toolu_1"));
        assert_eq!(error.as_deref(), Some("Exit code 1"));
        assert!(is_interrupt);
        assert!(ev.kind.tool_call().is_some());

        let ev = HookEvent::parse(
            &format!(
                r#"{{"session_id":"{SID}","hook_event_name":"PermissionDenied","tool_name":"Bash",
                "tool_input":{{}},"tool_use_id":"toolu_2","reason":"[Irreversible]"}}"#
            ),
            None,
        )
        .unwrap();
        assert!(
            matches!(&ev.kind, HookKind::PermissionDenied { reason: Some(r), .. } if r == "[Irreversible]")
        );
        assert_eq!(ev.common.agent_id, None);
    }

    #[test]
    fn missing_tool_input_is_null() {
        let ev = HookEvent::parse(
            &format!(
                r#"{{"session_id":"{SID}","hook_event_name":"PostToolUse","tool_name":"Read"}}"#
            ),
            None,
        )
        .unwrap();
        let HookKind::PostToolUse(call) = ev.kind else {
            panic!("PostToolUse attendu");
        };
        assert_eq!(call.tool_input, Value::Null);
    }
    #[test]
    fn parses_subagent_fields_tolerantly() {
        let ev = HookEvent::parse(
            &format!(
                r#"{{"session_id":"{SID}","hook_event_name":"Stop","stop_hook_active":false,
                "background_tasks":[{{"id":"a1","type":"subagent","status":"running",
                "description":"Lire","agent_type":"general-purpose"}},{{"type":"subagent"}},3,
                {{"id":"c1","type":"cron"}}],"session_crons":[]}}"#
            ),
            None,
        )
        .unwrap();
        let HookKind::Stop {
            background_tasks: Some(tasks),
        } = ev.kind
        else {
            panic!("Stop avec background_tasks attendu");
        };
        assert_eq!(tasks.len(), 2);
        assert!(tasks[0].is_running_subagent());
        assert_eq!(tasks[0].id, "a1");
        assert!(!tasks[1].is_running_subagent());

        let ev = HookEvent::parse(
            &format!(r#"{{"session_id":"{SID}","hook_event_name":"Stop","background_tasks":"x"}}"#),
            None,
        )
        .unwrap();
        assert_eq!(
            ev.kind,
            HookKind::Stop {
                background_tasks: None
            }
        );

        let ev = HookEvent::parse(
            &format!(
                r#"{{"session_id":"{SID}","hook_event_name":"SubagentStop","agent_id":"a1",
                "agent_type":"general-purpose","agent_transcript_path":"/t/agent-a1.jsonl",
                "last_assistant_message":"Fini.","background_tasks":[]}}"#
            ),
            None,
        )
        .unwrap();
        assert_eq!(
            ev.kind,
            HookKind::SubagentStop {
                agent_id: Some("a1".into()),
                agent_type: Some("general-purpose".into()),
                last_assistant_message: Some("Fini.".into()),
                agent_transcript_path: Some("/t/agent-a1.jsonl".into()),
            }
        );

        let ev = HookEvent::parse(
            &format!(
                r#"{{"session_id":"{SID}","hook_event_name":"PostToolUse","tool_name":"Agent",
                "tool_input":{{"description":"Lire"}},"tool_use_id":"toolu_1",
                "tool_response":{{"agentId":"a1","status":"async_launched"}}}}"#
            ),
            None,
        )
        .unwrap();
        let HookKind::PostToolUse(call) = ev.kind else {
            panic!("PostToolUse attendu");
        };
        assert_eq!(call.tool_response["agentId"], "a1");
    }
}
