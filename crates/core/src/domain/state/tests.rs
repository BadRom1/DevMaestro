//! Cas synthétiques de la machine à états.

use super::*;
use crate::domain::hooks::HookCommon;
use serde_json::json;

fn t(secs: i64) -> OffsetDateTime {
    OffsetDateTime::from_unix_timestamp(1_792_402_000 + secs).unwrap()
}

fn ev(kind: HookKind) -> HookEvent {
    HookEvent {
        common: HookCommon {
            session_id: "s".into(),
            cwd: None,
            transcript_path: None,
            permission_mode: None,
            agent_id: None,
            agent_type: None,
        },
        kind,
    }
}

fn call(tool: &str, input: Value, id: Option<&str>) -> ToolCall {
    ToolCall {
        tool_name: tool.into(),
        tool_input: input,
        tool_use_id: id.map(str::to_owned),
    }
}

fn pre(tool: &str, input: Value, id: &str) -> HookEvent {
    ev(HookKind::PreToolUse(call(tool, input, Some(id))))
}

fn perm(tool: &str, input: Value) -> HookEvent {
    ev(HookKind::PermissionRequest(call(tool, input, None)))
}

fn post(tool: &str, input: Value, id: Option<&str>) -> HookEvent {
    ev(HookKind::PostToolUse(call(tool, input, id)))
}

fn notif(kind: &str) -> HookEvent {
    ev(HookKind::Notification {
        notification_type: Some(kind.into()),
        message: None,
    })
}

fn bash(cmd: &str) -> Value {
    json!({ "command": cmd })
}

fn running() -> SessionState {
    let mut s = SessionState::default();
    apply(
        &mut s,
        &ev(HookKind::UserPromptSubmit { prompt: None }),
        t(0),
    );
    s
}

fn resolved(id: u64, how: Resolution) -> Effect {
    Effect::RequestResolved {
        request_id: RequestId(id),
        how,
    }
}

fn notified(fx: &[Effect]) -> Vec<RequestId> {
    fx.iter()
        .filter_map(|e| match e {
            Effect::NotifyWaiting { request_id, .. } => Some(*request_id),
            _ => None,
        })
        .collect()
}

#[test]
fn permission_closed_by_tool_use_id() {
    let mut s = running();
    apply(&mut s, &pre("Bash", bash("ls"), "toolu_a"), t(1));
    let fx = apply(&mut s, &perm("Bash", bash("ls")), t(2));
    assert_eq!(notified(&fx), [RequestId(1)]);
    assert_eq!(s.status(), SessionStatus::Waiting(WaitKind::Permission));
    assert_eq!(s.pending()[0].tool_use_id.as_deref(), Some("toolu_a"));
    // L'entrée du PostToolUse a été réécrite (hook de l'utilisateur) : le
    // tool_use_id suffit.
    let fx = apply(&mut s, &post("Bash", bash("rtk ls"), Some("toolu_a")), t(3));
    assert_eq!(
        fx,
        [resolved(1, Resolution::Answered), Effect::ClearWaiting]
    );
    assert_eq!(s.status(), SessionStatus::Running);
}

#[test]
fn parallel_requests_are_closed_one_by_one() {
    let mut s = running();
    apply(&mut s, &pre("Bash", bash("ls"), "a"), t(1));
    apply(&mut s, &pre("Bash", bash("pwd"), "b"), t(1));
    let fx1 = apply(&mut s, &perm("Bash", bash("ls")), t(2));
    let fx2 = apply(&mut s, &perm("Bash", bash("pwd")), t(2));
    assert_eq!(notified(&fx1), [RequestId(1)]);
    assert_eq!(notified(&fx2), [RequestId(2)]);
    assert_eq!(s.pending().len(), 2);

    let fx = apply(&mut s, &post("Bash", bash("pwd"), Some("b")), t(3));
    assert_eq!(fx, [resolved(2, Resolution::Answered)]);
    assert_eq!(s.status(), SessionStatus::Waiting(WaitKind::Permission));
    assert_eq!(s.pending()[0].id, RequestId(1));

    let fx = apply(&mut s, &post("Bash", bash("ls"), Some("a")), t(4));
    assert_eq!(
        fx,
        [resolved(1, Resolution::Answered), Effect::ClearWaiting]
    );
}

#[test]
fn identical_parallel_requests_each_get_their_own_id() {
    let mut s = running();
    apply(&mut s, &pre("Bash", bash("make"), "a"), t(1));
    apply(&mut s, &pre("Bash", bash("make"), "b"), t(1));
    apply(&mut s, &perm("Bash", bash("make")), t(2));
    apply(&mut s, &perm("Bash", bash("make")), t(2));
    let mut ids: Vec<_> = s
        .pending()
        .iter()
        .map(|r| r.tool_use_id.clone().unwrap())
        .collect();
    ids.sort();
    assert_eq!(ids, ["a", "b"]);
    apply(&mut s, &post("Bash", bash("make"), Some("a")), t(3));
    assert_eq!(s.pending().len(), 1);
    assert_eq!(s.pending()[0].tool_use_id.as_deref(), Some("b"));
}

#[test]
fn different_tool_use_id_never_falls_back_to_input() {
    let mut s = running();
    apply(&mut s, &pre("Bash", bash("ls"), "a"), t(1));
    apply(&mut s, &perm("Bash", bash("ls")), t(2));
    let fx = apply(&mut s, &post("Bash", bash("ls"), Some("c")), t(3));
    assert!(fx.is_empty());
    assert_eq!(s.pending().len(), 1);
}

#[test]
fn fallback_on_input_without_ids() {
    let mut s = running();
    apply(&mut s, &perm("Bash", bash("ls")), t(1));
    // Autre outil, puis même outil avec une autre entrée : rien.
    assert!(
        apply(
            &mut s,
            &post("Read", json!({"file_path": "/x"}), None),
            t(2)
        )
        .is_empty()
    );
    assert!(apply(&mut s, &post("Bash", bash("pwd"), None), t(2)).is_empty());
    // Un PreToolUse d'un autre outil ne retire pas une demande détaillée.
    assert!(apply(&mut s, &pre("Read", json!({}), "r"), t(2)).is_empty());
    assert_eq!(s.status(), SessionStatus::Waiting(WaitKind::Permission));
    let mut more = bash("ls");
    more["timeout"] = json!(1000);
    let fx = apply(&mut s, &post("Bash", more, None), t(3));
    assert_eq!(
        fx,
        [resolved(1, Resolution::Answered), Effect::ClearWaiting]
    );
}

#[test]
fn empty_or_null_expected_input_needs_exact_match() {
    let mut s = running();
    apply(&mut s, &perm("ExitPlanMode", Value::Null), t(1));
    assert!(
        apply(
            &mut s,
            &post("ExitPlanMode", json!({"plan": "x"}), None),
            t(2)
        )
        .is_empty()
    );
    let fx = apply(&mut s, &post("ExitPlanMode", json!({}), None), t(3));
    assert_eq!(
        fx,
        [resolved(1, Resolution::Answered), Effect::ClearWaiting]
    );
}

#[test]
fn failure_and_denial_close_requests() {
    let mut s = running();
    apply(&mut s, &pre("Bash", bash("x"), "a"), t(1));
    apply(&mut s, &perm("Bash", bash("x")), t(1));
    let fx = apply(
        &mut s,
        &ev(HookKind::PostToolUseFailure {
            call: call("Bash", bash("x"), Some("a")),
            error: Some("Exit code 1".into()),
            is_interrupt: false,
        }),
        t(2),
    );
    assert_eq!(fx, [resolved(1, Resolution::Failed), Effect::ClearWaiting]);
    assert_eq!(s.status(), SessionStatus::Running);

    apply(&mut s, &pre("Bash", bash("rm"), "b"), t(3));
    apply(&mut s, &perm("Bash", bash("rm")), t(3));
    let fx = apply(
        &mut s,
        &ev(HookKind::PermissionDenied {
            call: call("Bash", bash("rm"), Some("b")),
            reason: None,
        }),
        t(4),
    );
    assert_eq!(fx, [resolved(2, Resolution::Denied), Effect::ClearWaiting]);

    // Interruption pendant l'exécution d'un outil : la session redevient inactive.
    apply(&mut s, &pre("Bash", bash("sleep 60"), "c"), t(5));
    apply(
        &mut s,
        &ev(HookKind::PostToolUseFailure {
            call: call("Bash", bash("sleep 60"), Some("c")),
            error: None,
            is_interrupt: true,
        }),
        t(6),
    );
    assert_eq!(s.status(), SessionStatus::Idle);
}

#[test]
fn ask_user_question_lifecycle() {
    let input = json!({"questions": [{"question": "A ou B ?", "options": [{"label": "A"}]}]});
    let mut s = running();
    let fx = apply(
        &mut s,
        &ev(HookKind::PreToolUse(call(
            ASK_USER_QUESTION,
            input.clone(),
            None,
        ))),
        t(1),
    );
    assert_eq!(notified(&fx), [RequestId(1)]);
    assert_eq!(s.status(), SessionStatus::Waiting(WaitKind::Question));
    // Le PermissionRequest de la même question ne crée rien de plus.
    assert!(apply(&mut s, &perm(ASK_USER_QUESTION, input.clone()), t(1)).is_empty());
    // La notification permission_prompt ne rétrograde pas la question.
    assert!(apply(&mut s, &notif("permission_prompt"), t(7)).is_empty());
    assert_eq!(s.pending().len(), 1);
    let Pending::Question(q) = &s.pending()[0].pending else {
        panic!("question attendue");
    };
    assert_eq!(q.questions[0].question, "A ou B ?");

    // Sans tool_use_id : repli sur l'entrée, qui porte en plus `answers`.
    let mut answered = input.clone();
    answered["answers"] = json!({"A ou B ?": "A"});
    answered["annotations"] = json!({});
    let fx = apply(&mut s, &post(ASK_USER_QUESTION, answered, None), t(8));
    assert_eq!(
        fx,
        [resolved(1, Resolution::Answered), Effect::ClearWaiting]
    );
}

#[test]
fn subagent_question_stays_on_parent_session() {
    let input = json!({"questions": [{"question": "Q ?", "options": []}]});
    let mut s = running();
    apply(
        &mut s,
        &ev(HookKind::SubagentStart {
            agent_id: Some("agent-1".into()),
            agent_type: Some("Explore".into()),
        }),
        t(1),
    );
    let mut e = ev(HookKind::PreToolUse(call(
        ASK_USER_QUESTION,
        input,
        Some("toolu_q"),
    )));
    e.common.agent_id = Some("agent-1".into());
    apply(&mut s, &e, t(2));
    assert_eq!(s.status(), SessionStatus::Waiting(WaitKind::Question));
    assert_eq!(s.pending()[0].agent_id.as_deref(), Some("agent-1"));
    // La fin du sous-agent ne retire pas la question.
    assert!(
        apply(
            &mut s,
            &ev(HookKind::SubagentStop {
                agent_id: Some("agent-1".into()),
                agent_type: None,
            }),
            t(3),
        )
        .is_empty()
    );
    assert_eq!(s.pending().len(), 1);
}

#[test]
fn turn_end_clears_every_request() {
    for (event, status) in [
        (
            ev(HookKind::UserPromptSubmit { prompt: None }),
            SessionStatus::Running,
        ),
        (ev(HookKind::Stop), SessionStatus::Idle),
        (ev(HookKind::StopFailure), SessionStatus::Error),
    ] {
        let mut s = running();
        apply(&mut s, &perm("Bash", bash("ls")), t(1));
        apply(&mut s, &perm("Bash", bash("pwd")), t(1));
        let fx = apply(&mut s, &event, t(2));
        assert_eq!(
            fx,
            [
                resolved(1, Resolution::Cleared),
                resolved(2, Resolution::Cleared),
                Effect::ClearWaiting
            ]
        );
        assert_eq!(s.status(), status);
    }
}

#[test]
fn permission_prompt_alone_then_superseded() {
    let mut s = running();
    let fx = apply(&mut s, &notif("permission_prompt"), t(1));
    assert_eq!(
        fx,
        [Effect::NotifyWaiting {
            request_id: RequestId(1),
            pending: Pending::Undetailed(WaitKind::Permission),
        }]
    );
    let fx = apply(&mut s, &perm("Bash", bash("ls")), t(2));
    assert_eq!(fx[0], resolved(1, Resolution::Superseded));
    assert_eq!(notified(&fx), [RequestId(2)]);
    assert_eq!(s.pending().len(), 1);
}

#[test]
fn undetailed_wait_ends_with_next_tool_event() {
    let mut s = running();
    apply(&mut s, &notif("elicitation_dialog"), t(1));
    assert_eq!(s.status(), SessionStatus::Waiting(WaitKind::Question));
    let fx = apply(&mut s, &post("mcp__x__y", json!({}), Some("m")), t(2));
    assert_eq!(fx, [resolved(1, Resolution::Cleared), Effect::ClearWaiting]);
    assert_eq!(s.status(), SessionStatus::Running);
}

#[test]
fn late_notifications_are_ignored() {
    // Depuis Idle (après Stop) : ignorée.
    let mut s = running();
    apply(&mut s, &ev(HookKind::Stop), t(1));
    assert!(apply(&mut s, &notif("permission_prompt"), t(2)).is_empty());
    assert_eq!(s.status(), SessionStatus::Idle);

    // Juste après la clôture d'une demande du même genre : ignorée.
    let mut s = running();
    apply(&mut s, &perm("Bash", bash("ls")), t(1));
    apply(&mut s, &post("Bash", bash("ls"), None), t(2));
    assert!(apply(&mut s, &notif("permission_prompt"), t(3)).is_empty());
    assert_eq!(s.status(), SessionStatus::Running);
    // Hors de la fenêtre, en plein travail : prise en compte.
    let fx = apply(&mut s, &notif("permission_prompt"), t(10));
    assert_eq!(notified(&fx).len(), 1);
}

#[test]
fn idle_prompt_after_escape() {
    // Attente sans détails : retirée, la session redevient inactive.
    let mut s = running();
    apply(&mut s, &notif("permission_prompt"), t(1));
    let fx = apply(&mut s, &notif("idle_prompt"), t(61));
    assert_eq!(fx, [resolved(1, Resolution::Cleared), Effect::ClearWaiting]);
    assert_eq!(s.status(), SessionStatus::Idle);

    // Demande détaillée : gardée, marquée peut-être obsolète, une seule fois.
    let mut s = running();
    apply(&mut s, &perm("Bash", bash("ls")), t(1));
    let fx = apply(&mut s, &notif("idle_prompt"), t(61));
    assert_eq!(
        fx,
        [Effect::PossiblyStale {
            request_ids: vec![RequestId(1)]
        }]
    );
    assert!(s.possibly_stale());
    assert_eq!(s.status(), SessionStatus::Waiting(WaitKind::Permission));
    assert!(apply(&mut s, &notif("idle_prompt"), t(121)).is_empty());
    // Le prompt suivant retire tout et lève le doute.
    apply(
        &mut s,
        &ev(HookKind::UserPromptSubmit { prompt: None }),
        t(130),
    );
    assert!(!s.possibly_stale());
    assert_eq!(s.status(), SessionStatus::Running);
}

#[test]
fn idle_prompt_does_not_hide_an_error() {
    let mut s = running();
    apply(&mut s, &ev(HookKind::StopFailure), t(1));
    apply(&mut s, &notif("idle_prompt"), t(61));
    assert_eq!(s.status(), SessionStatus::Error);
    apply(
        &mut s,
        &ev(HookKind::UserPromptSubmit { prompt: None }),
        t(70),
    );
    assert_eq!(s.status(), SessionStatus::Running);
}

#[test]
fn stop_without_prior_events() {
    let mut s = SessionState::default();
    assert_eq!(s.status(), SessionStatus::Starting);
    assert!(apply(&mut s, &ev(HookKind::Stop), t(1)).is_empty());
    assert_eq!(s.status(), SessionStatus::Idle);
}

#[test]
fn stopped_is_left_only_by_session_start() {
    let mut s = running();
    apply(
        &mut s,
        &ev(HookKind::SessionEnd {
            reason: Some("prompt_input_exit".into()),
        }),
        t(1),
    );
    let stopped = SessionStatus::Stopped {
        reason: Some("prompt_input_exit".into()),
    };
    // Un UserPromptSubmit tardif, une notification ou un Stop : rien.
    for e in [
        ev(HookKind::UserPromptSubmit { prompt: None }),
        notif("permission_prompt"),
        ev(HookKind::Stop),
    ] {
        assert!(apply(&mut s, &e, t(2)).is_empty());
        assert_eq!(s.status(), stopped);
    }
    assert_eq!(s.last_activity, Some(t(2)));
    apply(
        &mut s,
        &ev(HookKind::SessionStart {
            source: Some("resume".into()),
            model: None,
        }),
        t(3),
    );
    assert_eq!(s.status(), SessionStatus::Idle);
}

#[test]
fn compact_session_start_keeps_status() {
    let mut s = running();
    apply(&mut s, &perm("Bash", bash("ls")), t(1));
    let fx = apply(
        &mut s,
        &ev(HookKind::SessionStart {
            source: Some("compact".into()),
            model: None,
        }),
        t(2),
    );
    assert!(fx.is_empty());
    assert_eq!(s.pending().len(), 1);
}

#[test]
fn permission_mode_kept_when_absent() {
    let mut s = running();
    let mut e = ev(HookKind::Stop);
    e.common.permission_mode = Some(PermissionMode::Auto);
    apply(&mut s, &e, t(1));
    apply(&mut s, &notif("idle_prompt"), t(61));
    assert_eq!(s.permission_mode, Some(PermissionMode::Auto));
}

#[test]
fn unknown_events_change_nothing_but_activity() {
    let mut s = running();
    let fx = apply(
        &mut s,
        &ev(HookKind::Other {
            name: "PreCompact".into(),
        }),
        t(5),
    );
    assert!(fx.is_empty());
    assert_eq!(s.status(), SessionStatus::Running);
    assert_eq!(s.last_activity, Some(t(5)));
    apply(&mut s, &notif("autre_chose"), t(6));
    assert_eq!(s.status(), SessionStatus::Running);
}

#[test]
fn process_exit_without_session_end() {
    // Code 0 sans SessionEnd : arrêtée, demandes retirées.
    let mut s = running();
    apply(&mut s, &perm("Bash", bash("ls")), t(1));
    let fx = s.process_exited(&ProcessExit::Code(0), t(2));
    assert_eq!(
        fx,
        vec![resolved(1, Resolution::Cleared), Effect::ClearWaiting]
    );
    assert_eq!(
        s.status(),
        SessionStatus::Stopped {
            reason: Some(REASON_PROCESS_EXIT.into())
        }
    );
    assert!(s.pending().is_empty());
    assert_eq!(s.last_activity, Some(t(1)));

    // Code non nul ou signal inattendu : erreur.
    let mut s = running();
    assert!(s.process_exited(&ProcessExit::Code(1), t(2)).is_empty());
    assert_eq!(s.status(), SessionStatus::Error);
    let mut s = running();
    s.process_exited(&ProcessExit::Signal("SIGKILL".into()), t(2));
    assert_eq!(s.status(), SessionStatus::Error);

    // Arrêt demandé par le démon.
    let mut s = running();
    s.process_exited(&ProcessExit::Requested, t(2));
    assert_eq!(
        s.status(),
        SessionStatus::Stopped {
            reason: Some(REASON_STOPPED_BY_APP.into())
        }
    );
}

#[test]
fn process_exit_after_session_end_keeps_reason() {
    let mut s = running();
    apply(
        &mut s,
        &ev(HookKind::SessionEnd {
            reason: Some("prompt_input_exit".into()),
        }),
        t(1),
    );
    assert!(s.process_exited(&ProcessExit::Code(1), t(2)).is_empty());
    assert_eq!(
        s.status(),
        SessionStatus::Stopped {
            reason: Some("prompt_input_exit".into())
        }
    );
    assert!(s.is_stopped());
}

#[test]
fn restored_state_has_no_pending_and_resumes_on_session_start() {
    let mut s = SessionState::restored(
        SessionStatus::Waiting(WaitKind::Permission),
        Some(PermissionMode::Plan),
        Some(t(5)),
    );
    assert_eq!(s.status(), SessionStatus::Running);
    assert_eq!(s.permission_mode, Some(PermissionMode::Plan));
    s.process_exited(&ProcessExit::Requested, t(6));
    assert!(s.is_stopped());
    apply(
        &mut s,
        &ev(HookKind::SessionStart {
            source: Some("resume".into()),
            model: None,
        }),
        t(7),
    );
    assert_eq!(s.status(), SessionStatus::Idle);
}
