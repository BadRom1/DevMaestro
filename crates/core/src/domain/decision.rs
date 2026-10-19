//! Décisions envoyées à Claude Code par le relais `PermissionRequest`
//! (ADR 0003) : réponses de l'app à une permission ou à une question.
//!
//! Sortie du hook (documentation des hooks, « PermissionRequest decision
//! control ») :
//!
//! ```json
//! {"hookSpecificOutput": {"hookEventName": "PermissionRequest",
//!   "decision": {"behavior": "allow", "updatedInput": {…}, "updatedPermissions": […]}}}
//! {"hookSpecificOutput": {"hookEventName": "PermissionRequest",
//!   "decision": {"behavior": "deny", "message": "…"}}}
//! ```
//!
//! - `updatedInput` **remplace** toute l'entrée de l'outil : il n'est envoyé
//!   que pour répondre à une question (`tool_input` + `answers`, constaté au
//!   prototype n° 1), jamais pour une simple autorisation.
//! - `updatedPermissions` reprend des `permission_suggestions` reçues avec la
//!   demande (« Toujours ») : c'est Claude Code qui écrit la règle, jamais
//!   DevMaestro (voir [`always_rules`]).

use serde_json::{Map, Value, json};
use thiserror::Error;

use super::session::{Pending, PermissionPending, QuestionPending};

/// Séparateur des réponses à choix multiples. La documentation dit
/// seulement « Multi-select answers join labels with commas » ; le format
/// exact (virgule seule ou suivie d'une espace) n'a pas été vérifié avec le
/// vrai CLI (le prototype n° 1 n'a testé qu'un choix simple).
pub const MULTI_SELECT_SEPARATOR: &str = ", ";

/// Destinations de règles acceptées pour « Toujours » : la session, ou la
/// configuration du projet. `userSettings` (`~/.claude/settings.json`) est
/// écartée : « Toujours pour ce projet » ne touche pas à la configuration de
/// l'utilisateur.
pub const ALWAYS_DESTINATIONS: &[&str] = &["session", "localSettings", "projectSettings"];

/// Réponse de l'app à une demande de permission.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PermissionAnswer {
    /// Autoriser cette fois.
    Allow,
    /// Autoriser et ajouter les règles proposées par Claude Code.
    AllowAlways,
    /// Refuser, avec un message éventuel pour Claude.
    Deny { message: Option<String> },
}

/// Réponse impossible à construire.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum AnswerError {
    /// La demande est une question et non une permission, ou l'inverse.
    #[error("cette demande est une {actual}, pas une {expected}")]
    WrongKind {
        expected: &'static str,
        actual: &'static str,
    },
    /// Attente connue seulement par une notification : rien à quoi répondre
    /// depuis l'app (répondre dans le terminal).
    #[error("demande sans détails : répondre dans le terminal")]
    Undetailed,
    /// « Toujours » sans règle utilisable dans les suggestions.
    #[error("aucune règle proposée par Claude Code pour « Toujours »")]
    NoSuggestions,
    /// Réponses à une question invalides.
    #[error("{0}")]
    InvalidAnswers(String),
}

fn kind_name(p: &Pending) -> &'static str {
    match p {
        Pending::Permission(_) => "permission",
        Pending::Question(_) => "question",
        Pending::Undetailed(k) => match k {
            super::WaitKind::Permission => "permission",
            super::WaitKind::Question => "question",
        },
    }
}

/// Enveloppe de sortie du hook autour d'une décision.
pub fn hook_output(decision: Value) -> Value {
    json!({
        "hookSpecificOutput": {
            "hookEventName": "PermissionRequest",
            "decision": decision,
        }
    })
}

/// Règles de « Toujours » : les suggestions `addRules` de comportement
/// `allow` vers une destination de [`ALWAYS_DESTINATIONS`], dont **chaque**
/// règle correspond à la demande (voir [`rule_fits`]). Les autres
/// (changement de mode, dossiers, règles `deny`/`ask`, configuration de
/// l'utilisateur, règle plus large que la demande) sont écartées :
/// « Toujours » ne change jamais le mode de la session.
///
/// Les suggestions sont celles de la première trame `PermissionRequest` de
/// la demande (voir la machine à états) ; cette vérification protège en plus
/// d'une première trame forgée par un processus de la session.
pub fn always_rules(p: &PermissionPending) -> Vec<Value> {
    p.suggestions
        .iter()
        .filter(|s| {
            s.get("type").and_then(Value::as_str) == Some("addRules")
                && s.get("behavior").and_then(Value::as_str) == Some("allow")
                && s.get("destination")
                    .and_then(Value::as_str)
                    .is_some_and(|d| ALWAYS_DESTINATIONS.contains(&d))
                && s.get("rules").and_then(Value::as_array).is_some_and(|r| {
                    !r.is_empty() && r.iter().all(|r| rule_fits(r, &p.tool_name, &p.tool_input))
                })
        })
        .cloned()
        .collect()
}

/// Outils dont l'entrée désigne un fichier : une règle doit nommer un chemin.
const FILE_TOOLS: &[&str] = &["Read", "Write", "Edit", "MultiEdit", "NotebookEdit"];

/// Une règle `{toolName, ruleContent?}` correspond-elle à la demande ?
///
/// - `toolName` doit être l'outil de la demande ;
/// - `Bash` : `ruleContent` obligatoire, égal à la commande, ou préfixe
///   `<préfixe>:*` / `<préfixe> *` (préfixe non vide, sans autre joker) que
///   la commande prolonge ;
/// - outils de fichiers : `ruleContent` obligatoire, égal au chemin, ou
///   `<dossier absolu>/**` qui le contient ;
/// - autres outils (MCP, `WebFetch`…) : `ruleContent` facultatif.
pub fn rule_fits(rule: &Value, tool: &str, input: &Value) -> bool {
    if rule.get("toolName").and_then(Value::as_str) != Some(tool) {
        return false;
    }
    let content = rule.get("ruleContent").and_then(Value::as_str);
    if tool == "Bash" {
        return match (content, input.get("command").and_then(Value::as_str)) {
            (Some(rule), Some(cmd)) => bash_rule_matches(rule, cmd),
            _ => false,
        };
    }
    if FILE_TOOLS.contains(&tool) {
        let path = input
            .get("file_path")
            .or_else(|| input.get("notebook_path"))
            .and_then(Value::as_str);
        return match (content, path) {
            (Some(rule), Some(path)) => path_rule_matches(rule, path),
            _ => false,
        };
    }
    content.is_none_or(|c| !c.trim().is_empty())
}

fn bash_rule_matches(rule: &str, cmd: &str) -> bool {
    if rule == cmd {
        return !rule.trim().is_empty();
    }
    let prefix = rule.strip_suffix(":*").or_else(|| rule.strip_suffix(" *"));
    match prefix {
        Some(p) if !p.trim().is_empty() && !p.contains('*') => {
            cmd == p || cmd.starts_with(&format!("{p} "))
        }
        _ => false,
    }
}

fn path_rule_matches(rule: &str, path: &str) -> bool {
    // `//chemin` : chemin absolu dans la syntaxe des règles de Claude Code.
    let rule = rule
        .strip_prefix('/')
        .filter(|r| r.starts_with('/'))
        .unwrap_or(rule);
    if rule == path {
        return true;
    }
    match rule.strip_suffix("/**") {
        Some(dir) if dir.starts_with('/') && dir.len() > 1 && !dir.contains('*') => {
            path.starts_with(&format!("{dir}/"))
        }
        _ => false,
    }
}

/// Sortie du hook pour une réponse à une demande de permission.
pub fn permission_decision(
    pending: &Pending,
    answer: &PermissionAnswer,
) -> Result<Value, AnswerError> {
    let p = match pending {
        Pending::Permission(p) => p,
        Pending::Undetailed(_) => return Err(AnswerError::Undetailed),
        other => {
            return Err(AnswerError::WrongKind {
                expected: "permission",
                actual: kind_name(other),
            });
        }
    };
    let decision = match answer {
        PermissionAnswer::Allow => json!({"behavior": "allow"}),
        PermissionAnswer::AllowAlways => {
            let rules = always_rules(p);
            if rules.is_empty() {
                return Err(AnswerError::NoSuggestions);
            }
            json!({"behavior": "allow", "updatedPermissions": rules})
        }
        PermissionAnswer::Deny { message } => {
            let mut d = json!({"behavior": "deny"});
            if let Some(m) = message.as_deref().filter(|m| !m.is_empty()) {
                d["message"] = json!(m);
            }
            d
        }
    };
    Ok(hook_output(decision))
}

/// Sortie du hook pour les réponses à une question (`AskUserQuestion`) :
/// `allow` avec `updatedInput` = `tool_input` + `answers`.
///
/// `answers` associe le texte de chaque question à une réponse : un libellé
/// d'option, un texte libre (« Autre »), ou pour une question à choix
/// multiples une liste de libellés (joints par [`MULTI_SELECT_SEPARATOR`]).
/// Chaque question doit recevoir une réponse non vide, et aucune clé
/// inconnue n'est acceptée.
pub fn question_decision(
    pending: &Pending,
    answers: &Map<String, Value>,
) -> Result<Value, AnswerError> {
    let q = match pending {
        Pending::Question(q) => q,
        Pending::Undetailed(_) => return Err(AnswerError::Undetailed),
        other => {
            return Err(AnswerError::WrongKind {
                expected: "question",
                actual: kind_name(other),
            });
        }
    };
    let normalized = normalize_answers(q, answers)?;
    let mut input = match &q.tool_input {
        Value::Object(m) => m.clone(),
        _ => return Err(AnswerError::Undetailed),
    };
    input.insert("answers".into(), Value::Object(normalized));
    Ok(hook_output(json!({
        "behavior": "allow",
        "updatedInput": Value::Object(input),
    })))
}

fn normalize_answers(
    q: &QuestionPending,
    answers: &Map<String, Value>,
) -> Result<Map<String, Value>, AnswerError> {
    if q.questions.is_empty() {
        return Err(AnswerError::Undetailed);
    }
    let invalid = |m: String| Err(AnswerError::InvalidAnswers(m));
    for key in answers.keys() {
        if !q.questions.iter().any(|x| &x.question == key) {
            return invalid(format!("question inconnue : « {key} »"));
        }
    }
    let mut out = Map::new();
    for question in &q.questions {
        let text = &question.question;
        let value = match answers.get(text) {
            None | Some(Value::Null) => {
                return invalid(format!("réponse manquante pour « {text} »"));
            }
            Some(Value::String(s)) if !s.trim().is_empty() => s.clone(),
            Some(Value::Array(items)) => {
                let labels: Option<Vec<&str>> = items.iter().map(Value::as_str).collect();
                let Some(labels) =
                    labels.filter(|l| !l.is_empty() && l.iter().all(|s| !s.trim().is_empty()))
                else {
                    return invalid(format!(
                        "réponse à « {text} » : liste de libellés non vides attendue"
                    ));
                };
                if labels.len() > 1 && !question.multi_select {
                    return invalid(format!("« {text} » n'accepte qu'une seule réponse"));
                }
                labels.join(MULTI_SELECT_SEPARATOR)
            }
            Some(_) => {
                return invalid(format!(
                    "réponse à « {text} » : texte ou liste de libellés attendu"
                ));
            }
        };
        out.insert(text.clone(), Value::String(value));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::WaitKind;

    fn perm(suggestions: Vec<Value>) -> Pending {
        Pending::Permission(PermissionPending {
            tool_name: "Bash".into(),
            tool_input: json!({"command": "rm -rf node_modules"}),
            suggestions,
        })
    }

    fn question() -> Pending {
        Pending::Question(QuestionPending::from_tool_input(&json!({
            "questions": [
                {"question": "A ou B ?", "header": "Choix",
                 "options": [{"label": "A"}, {"label": "B"}], "multiSelect": false},
                {"question": "Quelles couleurs ?", "header": "Couleurs",
                 "options": [{"label": "Rouge"}, {"label": "Vert"}], "multiSelect": true}
            ]
        })))
    }

    fn add_rules(destination: &str, behavior: &str) -> Value {
        json!({"type": "addRules", "rules": [{"toolName": "Bash", "ruleContent": "rm -rf node_modules"}],
               "behavior": behavior, "destination": destination})
    }

    #[test]
    fn allow_and_deny() {
        let p = perm(vec![]);
        assert_eq!(
            permission_decision(&p, &PermissionAnswer::Allow).unwrap(),
            json!({"hookSpecificOutput": {"hookEventName": "PermissionRequest",
                   "decision": {"behavior": "allow"}}})
        );
        let deny = permission_decision(
            &p,
            &PermissionAnswer::Deny {
                message: Some("pas maintenant".into()),
            },
        )
        .unwrap();
        assert_eq!(
            deny["hookSpecificOutput"]["decision"],
            json!({"behavior": "deny", "message": "pas maintenant"})
        );
        let deny = permission_decision(
            &p,
            &PermissionAnswer::Deny {
                message: Some(String::new()),
            },
        )
        .unwrap();
        assert_eq!(
            deny["hookSpecificOutput"]["decision"],
            json!({"behavior": "deny"})
        );
    }

    #[test]
    fn allow_always_keeps_only_project_allow_rules() {
        let suggestions = vec![
            add_rules("localSettings", "allow"),
            add_rules("userSettings", "allow"),
            add_rules("projectSettings", "deny"),
            json!({"type": "setMode", "mode": "acceptEdits", "destination": "session"}),
        ];
        let d = permission_decision(&perm(suggestions), &PermissionAnswer::AllowAlways).unwrap();
        assert_eq!(
            d["hookSpecificOutput"]["decision"],
            json!({"behavior": "allow", "updatedPermissions": [add_rules("localSettings", "allow")]})
        );
        assert_eq!(
            permission_decision(&perm(vec![]), &PermissionAnswer::AllowAlways),
            Err(AnswerError::NoSuggestions)
        );
        assert_eq!(
            permission_decision(
                &perm(vec![
                    json!({"type": "setMode", "mode": "auto", "destination": "session"})
                ]),
                &PermissionAnswer::AllowAlways
            ),
            Err(AnswerError::NoSuggestions)
        );
    }

    #[test]
    fn rules_must_fit_the_request() {
        let bash = |cmd: &str| json!({"command": cmd});
        let rule = |tool: &str, content: Option<&str>| match content {
            Some(c) => json!({"toolName": tool, "ruleContent": c}),
            None => json!({"toolName": tool}),
        };
        let cmd = bash("npm test --watch");
        for ok in ["npm test --watch", "npm test:*", "npm:*", "npm test *"] {
            assert!(rule_fits(&rule("Bash", Some(ok)), "Bash", &cmd), "{ok}");
        }
        for bad in [
            "*",
            ":*",
            " *",
            "rm:*",
            "npm t:*",
            "npm * --watch",
            "npm test",
        ] {
            assert!(!rule_fits(&rule("Bash", Some(bad)), "Bash", &cmd), "{bad}");
        }
        assert!(!rule_fits(&rule("Bash", None), "Bash", &cmd));
        assert!(!rule_fits(&rule("Write", Some("npm:*")), "Bash", &cmd));
        let file = json!({"file_path": "/home/u/p/src/a.rs"});
        for ok in [
            "/home/u/p/src/a.rs",
            "//home/u/p/src/a.rs",
            "/home/u/p/**",
            "/home/u/p/src/**",
        ] {
            assert!(rule_fits(&rule("Edit", Some(ok)), "Edit", &file), "{ok}");
        }
        for bad in ["/**", "**", "src/**", "/home/u/autre/**", "/home/*/p/**"] {
            assert!(!rule_fits(&rule("Edit", Some(bad)), "Edit", &file), "{bad}");
        }
        assert!(!rule_fits(&rule("Edit", None), "Edit", &file));
        assert!(rule_fits(&rule("mcp__x__y", None), "mcp__x__y", &json!({})));
        assert!(rule_fits(
            &rule("WebFetch", Some("domain:example.com")),
            "WebFetch",
            &json!({"url": "https://example.com"})
        ));
    }

    #[test]
    fn allow_always_drops_rules_broader_than_the_request() {
        let wide = json!({"type": "addRules", "rules": [{"toolName": "Bash"}],
                          "behavior": "allow", "destination": "localSettings"});
        let other = json!({"type": "addRules", "rules": [{"toolName": "Bash", "ruleContent": "curl:*"}],
                           "behavior": "allow", "destination": "localSettings"});
        let mixed = json!({"type": "addRules", "rules": [
                              {"toolName": "Bash", "ruleContent": "rm -rf node_modules"},
                              {"toolName": "Bash", "ruleContent": "sudo:*"}],
                           "behavior": "allow", "destination": "localSettings"});
        assert_eq!(
            permission_decision(
                &perm(vec![wide, other, mixed]),
                &PermissionAnswer::AllowAlways
            ),
            Err(AnswerError::NoSuggestions)
        );
    }

    #[test]
    fn wrong_kind_and_undetailed() {
        assert!(matches!(
            permission_decision(&question(), &PermissionAnswer::Allow),
            Err(AnswerError::WrongKind {
                expected: "permission",
                ..
            })
        ));
        assert!(matches!(
            question_decision(&perm(vec![]), &Map::new()),
            Err(AnswerError::WrongKind {
                expected: "question",
                ..
            })
        ));
        assert_eq!(
            permission_decision(
                &Pending::Undetailed(WaitKind::Permission),
                &PermissionAnswer::Allow
            ),
            Err(AnswerError::Undetailed)
        );
    }

    #[test]
    fn answers_are_added_to_the_tool_input() {
        let q = question();
        let answers = json!({"A ou B ?": "B", "Quelles couleurs ?": ["Rouge", "Vert"]});
        let d = question_decision(&q, answers.as_object().unwrap()).unwrap();
        let decision = &d["hookSpecificOutput"]["decision"];
        assert_eq!(decision["behavior"], "allow");
        let input = &decision["updatedInput"];
        assert_eq!(input["questions"], q.tool_input().unwrap()["questions"]);
        assert_eq!(
            input["answers"],
            json!({"A ou B ?": "B", "Quelles couleurs ?": "Rouge, Vert"})
        );
        // Texte libre, et liste d'un seul libellé pour une question simple.
        let answers = json!({"A ou B ?": ["A"], "Quelles couleurs ?": "toutes"});
        let d = question_decision(&q, answers.as_object().unwrap()).unwrap();
        assert_eq!(
            d["hookSpecificOutput"]["decision"]["updatedInput"]["answers"],
            json!({"A ou B ?": "A", "Quelles couleurs ?": "toutes"})
        );
    }

    #[test]
    fn invalid_answers_are_refused() {
        let q = question();
        for answers in [
            json!({"A ou B ?": "A"}),
            json!({"A ou B ?": "A", "Quelles couleurs ?": "", }),
            json!({"A ou B ?": ["A", "B"], "Quelles couleurs ?": "Rouge"}),
            json!({"A ou B ?": "A", "Quelles couleurs ?": [3]}),
            json!({"A ou B ?": "A", "Quelles couleurs ?": []}),
            json!({"A ou B ?": "A", "Quelles couleurs ?": "Rouge", "Autre ?": "x"}),
            json!({"A ou B ?": 1, "Quelles couleurs ?": "Rouge"}),
        ] {
            assert!(
                matches!(
                    question_decision(&q, answers.as_object().unwrap()),
                    Err(AnswerError::InvalidAnswers(_))
                ),
                "{answers}"
            );
        }
    }
}
