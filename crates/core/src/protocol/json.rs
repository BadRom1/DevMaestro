//! Représentation JSON des objets du domaine sur le socket (voir
//! `docs/protocole.md`). Le domaine ne connaît pas ce format : la conversion
//! vit ici.

use serde_json::{Value, json};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use crate::domain::{
    Effect, Metrics, PastSession, Pending, PendingRequest, Profile, RateLimitWindow, Resolution,
    SessionStatus, Subagent, WaitKind,
};

/// Date au format RFC 3339, `null` si inconnue.
pub fn time_json(t: Option<OffsetDateTime>) -> Value {
    t.and_then(|t| t.format(&Rfc3339).ok())
        .map(Value::String)
        .unwrap_or(Value::Null)
}

pub fn wait_kind_str(kind: WaitKind) -> &'static str {
    match kind {
        WaitKind::Permission => "permission",
        WaitKind::Question => "question",
    }
}

/// Statut : `{"state": "starting|running|waiting|idle|error|stopped", "wait"?, "reason"?}`.
pub fn status_json(status: &SessionStatus) -> Value {
    match status {
        SessionStatus::Starting => json!({"state": "starting"}),
        SessionStatus::Running => json!({"state": "running"}),
        SessionStatus::Waiting(kind) => json!({"state": "waiting", "wait": wait_kind_str(*kind)}),
        SessionStatus::Idle => json!({"state": "idle"}),
        SessionStatus::Error => json!({"state": "error"}),
        SessionStatus::Stopped { reason } => json!({"state": "stopped", "reason": reason}),
    }
}

/// Contenu d'une demande.
pub fn pending_json(p: &Pending) -> Value {
    match p {
        Pending::Permission(p) => json!({
            "kind": "permission",
            "tool_name": p.tool_name,
            "tool_input": p.tool_input,
            "suggestions": p.suggestions,
            "always_rules": crate::domain::decision::always_rules(p),
        }),
        Pending::Question(q) => json!({
            "kind": "question",
            "tool_name": crate::domain::session::ASK_USER_QUESTION,
            "tool_input": q.tool_input,
            "questions": q.questions.iter().map(|q| json!({
                "question": q.question,
                "header": q.header,
                "multi_select": q.multi_select,
                "options": q.options.iter().map(|o| json!({
                    "label": o.label,
                    "description": o.description,
                })).collect::<Vec<_>>(),
            })).collect::<Vec<_>>(),
        }),
        Pending::Undetailed(kind) => json!({
            "kind": wait_kind_str(*kind),
            "detailed": false,
        }),
    }
}

/// Demande en attente. `answerable` : un relais `PermissionRequest` attend
/// la décision, l'app peut donc y répondre.
pub fn pending_request_json(r: &PendingRequest, answerable: bool) -> Value {
    json!({
        "request_id": r.id.0,
        "answerable": answerable,
        "pending": pending_json(&r.pending),
        "tool_use_id": r.tool_use_id,
        "agent_id": r.agent_id,
        "since": time_json(Some(r.since)),
    })
}

fn window_json(w: &Option<RateLimitWindow>) -> Value {
    match w {
        Some(w) => json!({"used_pct": w.used_pct, "resets_at": time_json(w.resets_at)}),
        None => Value::Null,
    }
}

pub fn metrics_json(m: &Metrics) -> Value {
    json!({
        "model": m.model.as_ref().map(|m| json!({"id": m.id, "display_name": m.display_name})),
        "cost_usd": m.cost_usd,
        "context_used_pct": m.context_used_pct,
        "context_window_size": m.context_window_size,
        "total_tokens": m.total_tokens,
        "rate_limits": {
            "five_hour": window_json(&m.rate_limits.five_hour),
            "seven_day": window_json(&m.rate_limits.seven_day),
        },
        "session_name": m.session_name,
    })
}

fn resolution_str(how: Resolution) -> &'static str {
    match how {
        Resolution::Answered => "answered",
        Resolution::Failed => "failed",
        Resolution::Denied => "denied",
        Resolution::Superseded => "superseded",
        Resolution::Cleared => "cleared",
        Resolution::AnsweredByApp => "answered_by_app",
    }
}

/// Effet : `{"type": "notify_waiting|request_resolved|clear_waiting|possibly_stale", …}`.
pub fn effect_json(e: &Effect) -> Value {
    match e {
        Effect::NotifyWaiting {
            request_id,
            pending,
        } => json!({
            "type": "notify_waiting",
            "request_id": request_id.0,
            "pending": pending_json(pending),
        }),
        Effect::RequestResolved { request_id, how } => json!({
            "type": "request_resolved",
            "request_id": request_id.0,
            "how": resolution_str(*how),
        }),
        Effect::ClearWaiting => json!({"type": "clear_waiting"}),
        Effect::PossiblyStale { request_ids } => json!({
            "type": "possibly_stale",
            "request_ids": request_ids.iter().map(|r| r.0).collect::<Vec<_>>(),
        }),
    }
}

/// Sous-agent (objet `Subagent`). `with_report` : avec le champ `report`
/// (`sessions.subagent`) ; sinon il est absent (liste, notification). Les
/// textes viennent de Claude : ce sont des données, transmises telles quelles.
pub fn subagent_json(a: &Subagent, with_report: bool) -> Value {
    let mut v = json!({
        "agent_id": a.agent_id,
        "agent_type": a.agent_type,
        "description": a.description,
        "model": a.model,
        "tool_use_id": a.tool_use_id,
        "status": a.status.as_str(),
        "started_at": time_json(Some(a.started_at)),
        "ended_at": time_json(a.ended_at),
        "tool_count": a.tool_count,
        "current_tool": a.current_tool,
        "last_tool": a.last_tool,
        "report_truncated": a.report_truncated,
        "transcript_path": a.transcript_path,
    });
    if with_report {
        v["report"] = json!(a.report);
    }
    v
}

pub fn profile_json(p: &Profile) -> Value {
    json!({
        "name": p.name,
        "config_dir": p.config_dir,
        "sets_config_dir_env": p.sets_config_dir_env,
    })
}

pub fn past_session_json(s: &PastSession) -> Value {
    json!({
        "claude_session_id": s.session_id,
        "transcript_path": s.transcript_path,
        // Absolu ou `null` (le nom du dossier du transcript n'est jamais décodé).
        "cwd": s.cwd.as_ref().filter(|c| c.is_absolute()),
        "git_branch": s.git_branch,
        "first_prompt": s.first_prompt,
        "title": s.title,
        "display_name": s.display_name(),
        "first_timestamp": time_json(s.first_timestamp),
        "last_timestamp": time_json(s.last_timestamp),
        // Dernière activité : dernier horodatage lu, sinon date du fichier.
        "last_activity": time_json(s.last_timestamp.or(s.modified)),
        "message_count": s.message_count,
    })
}

/// Activité d'une session (ADR 0005) : `{kind, tool?, since}`.
pub fn activity_json(a: &crate::domain::Activity) -> Value {
    let mut v = json!({"kind": a.kind.as_str(), "since": time_json(a.since)});
    if let Some(t) = &a.tool {
        v["tool"] = json!(t);
    }
    v
}

/// Segment d'une conversation : `{segment, claude_session_id, reason, started_at}`.
pub fn segment_json(s: &crate::domain::conversation::Segment) -> Value {
    json!({
        "segment": s.segment,
        "claude_session_id": s.claude_session_id,
        "reason": s.reason,
        "started_at": s.started_at,
    })
}

/// Entrée d'une conversation (`docs/protocole.md`, « Entrée de conversation »).
pub fn conversation_entry_json(e: &crate::domain::conversation::Entry) -> Value {
    use crate::domain::conversation::Body;
    let mut v = json!({
        "uid": e.uid,
        "kind": e.body.kind(),
        "ts": e.ts,
        "segment": e.segment,
    });
    if let Some(a) = &e.agent_id {
        v["agent_id"] = json!(a);
    }
    if e.hidden_by_segment {
        v["hidden_by_segment"] = json!(true);
    }
    let fields = match &e.body {
        Body::Prompt {
            text,
            source,
            pasted,
            prompt_id,
        } => json!({
            "text": text,
            "source": source,
            "prompt_id": prompt_id,
            "pasted": pasted.iter().map(|p| json!({"id": p.id, "text": p.text})).collect::<Vec<_>>(),
            "truncated": e.truncated,
        }),
        Body::Text { markdown } => json!({"markdown": markdown, "truncated": e.truncated}),
        Body::Thinking => json!({}),
        Body::Tool {
            tool_use_id,
            name,
            summary,
            input,
            input_truncated,
            result,
        } => {
            let mut t = json!({
                "tool_use_id": tool_use_id,
                "name": name,
                "summary": summary,
                "input": input,
                "input_truncated": input_truncated,
            });
            if let Some(r) = result {
                let mut rj = json!({"status": r.status, "text": r.text, "truncated": r.truncated});
                if let Some(p) = &r.patch {
                    rj["patch"] = p.clone();
                }
                t["result"] = rj;
            }
            t
        }
        Body::Question {
            tool_use_id,
            questions,
            answers,
        } => json!({"tool_use_id": tool_use_id, "questions": questions, "answers": answers}),
        Body::Subagent {
            tool_use_id,
            agent_id,
            agent_type,
            description,
            status,
        } => {
            // `agent_id` : l'agent **lancé** (une entrée `subagent` se range
            // dans le fil de son parent) ; l'agent dont le fichier porte
            // l'entrée (sous-agent imbriqué) passe dans `parent_agent_id`.
            if let Some(owner) = &e.agent_id {
                v["parent_agent_id"] = json!(owner);
            }
            json!({
                "tool_use_id": tool_use_id,
                "agent_id": agent_id,
                "agent_type": agent_type,
                "description": description,
                "status": status,
            })
        }
        Body::Notification {
            task_id,
            status,
            summary,
        } => {
            json!({"task_id": task_id, "status": status, "summary": summary, "truncated": e.truncated})
        }
        Body::Compaction {
            trigger,
            pre_tokens,
            post_tokens,
            summary,
        } => json!({
            "trigger": trigger,
            "pre_tokens": pre_tokens,
            "post_tokens": post_tokens,
            "summary": summary,
            "truncated": e.truncated,
        }),
        Body::Command { name, args, output } => {
            json!({"name": name, "args": args, "output": output, "truncated": e.truncated})
        }
        Body::Error { message } => json!({"message": message, "truncated": e.truncated}),
        Body::Unknown { kind, subtype } => json!({"type": kind, "subtype": subtype}),
    };
    if let (Some(obj), Value::Object(f)) = (v.as_object_mut(), fields) {
        obj.extend(f);
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::RequestId;

    #[test]
    fn status_and_effects() {
        assert_eq!(
            status_json(&SessionStatus::Waiting(WaitKind::Question)),
            json!({"state": "waiting", "wait": "question"})
        );
        assert_eq!(
            status_json(&SessionStatus::Stopped { reason: None }),
            json!({"state": "stopped", "reason": null})
        );
        assert_eq!(
            effect_json(&Effect::RequestResolved {
                request_id: RequestId(3),
                how: Resolution::Answered
            }),
            json!({"type": "request_resolved", "request_id": 3, "how": "answered"})
        );
        assert_eq!(
            time_json(Some(OffsetDateTime::UNIX_EPOCH)),
            json!("1970-01-01T00:00:00Z")
        );
    }
}
