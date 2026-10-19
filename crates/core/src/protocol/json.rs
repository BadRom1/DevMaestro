//! Représentation JSON des objets du domaine sur le socket (voir
//! `docs/protocole.md`). Le domaine ne connaît pas ce format : la conversion
//! vit ici.

use serde_json::{Value, json};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use crate::domain::{
    Effect, Metrics, PastSession, Pending, PendingRequest, Profile, RateLimitWindow, Resolution,
    SessionStatus, WaitKind,
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

pub fn pending_request_json(r: &PendingRequest) -> Value {
    json!({
        "request_id": r.id.0,
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
        "cwd": s.cwd,
        "git_branch": s.git_branch,
        "first_prompt": s.first_prompt,
        "title": s.title,
        "first_timestamp": time_json(s.first_timestamp),
        "last_timestamp": time_json(s.last_timestamp),
        "message_count": s.message_count,
    })
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
