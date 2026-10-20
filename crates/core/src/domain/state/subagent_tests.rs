//! Sous-agents dans la machine à états (v0.2, lot 5) : rejeu de la session
//! réelle du 2026-10-20 (`tests/fixtures/subagents-2026-10-20.jsonl`, copie
//! de `spikes/01-pty-hooks/fixtures/`, champ `ts_rel` ajouté) et cas
//! synthétiques.

use serde_json::{Value, json};
use time::OffsetDateTime;

use super::*;
use crate::domain::session::Session;
use crate::domain::subagents::{MAX_REPORT_BYTES, SubagentChange, SubagentStatus};

const FIXTURE: &str = include_str!("../../../tests/fixtures/subagents-2026-10-20.jsonl");

fn at(secs: f64) -> OffsetDateTime {
    OffsetDateTime::from_unix_timestamp_nanos(1_792_480_000_000_000_000 + (secs * 1e9) as i128)
        .unwrap()
}

/// Événement de hook à partir de ses champs (`session_id` ajouté).
fn hook(mut v: Value) -> HookEvent {
    v["session_id"] = json!("s");
    HookEvent::from_value(&v, None).unwrap()
}

/// Un pas du rejeu.
struct Step {
    line: usize,
    ts: f64,
    event: String,
    status: SessionStatus,
    change: SubagentChange,
}

fn replay() -> (Session, Vec<Step>) {
    let mut session = Session::new(uuid::Uuid::nil(), "s", "/p", "/p", "default");
    let mut steps = Vec::new();
    for (i, line) in FIXTURE.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let v: Value = serde_json::from_str(line).unwrap();
        let ts = v["ts_rel"].as_f64().unwrap();
        let ev = HookEvent::from_value(&v, None)
            .unwrap_or_else(|e| panic!("ligne {} illisible : {e}", i + 1));
        let applied = session.apply_hook_tracked(&ev, at(ts));
        steps.push(Step {
            line: i + 1,
            ts,
            event: ev.kind.name().to_owned(),
            status: session.state.status(),
            change: applied.subagents,
        });
    }
    (session, steps)
}

fn status_at(steps: &[Step], ts: f64) -> &SessionStatus {
    &steps
        .iter()
        .find(|s| (s.ts - ts).abs() < 1e-6)
        .unwrap_or_else(|| panic!("pas d'événement à {ts}"))
        .status
}

#[test]
fn real_session_stays_running_while_subagents_work() {
    let (session, steps) = replay();
    // Les trois `Stop` du premier tour pendant que des sous-agents tournent
    // ou que leur `task-notification` doit suivre : toujours en cours.
    for ts in [29.566, 33.463, 37.29] {
        assert_eq!(
            status_at(&steps, ts),
            &SessionStatus::Running,
            "Stop à {ts}"
        );
    }
    // Seul le `Stop` sans rien en cours ni en attente rend la session inactive.
    assert_eq!(status_at(&steps, 41.719), &SessionStatus::Idle);
    // Du premier prompt à ce `Stop`, jamais inactive (ni par un hook d'un
    // sous-agent arrivé après un `Stop`, ligne 24).
    for s in steps.iter().filter(|s| s.ts >= 13.392 && s.ts < 41.719) {
        assert_eq!(
            s.status,
            SessionStatus::Running,
            "ligne {} ({} à {})",
            s.line,
            s.event,
            s.ts
        );
    }
    // Deuxième tour : un sous-agent, même règle.
    assert_eq!(status_at(&steps, 70.437), &SessionStatus::Running);
    assert_eq!(status_at(&steps, 123.895), &SessionStatus::Idle);
    assert!(session.state.is_stopped());

    // Les quatre vrais sous-agents, dans l'ordre de lancement ; les
    // `SubagentStop` fantômes (agents internes, `agent_type` vide) sont ignorés.
    let agents = session.state.subagents().list();
    let ids: Vec<&str> = agents.iter().map(|a| a.agent_id.as_str()).collect();
    assert_eq!(
        ids,
        [
            "aa98c9444728c5039",
            "a1dcf2f8a7682d931",
            "aeb35515bd8d2294c",
            "a5ffc8aa4495b41a4"
        ]
    );
    for phantom in [
        "a38dd6d55bb0ecabc",
        "a48ceda177278851d",
        "a54cabbfb63297a8c",
        "a2bcac0f4511f06bd",
        "ae5e68771401f619a",
        "afe543ffa605c1e5b",
        "a7eb296b415706473",
    ] {
        assert!(
            session.state.subagents().get(phantom).is_none(),
            "{phantom}"
        );
    }
    let expected = [
        (
            "Première ligne README.md",
            3,
            "Bash",
            "toolu_01WequRXz71mWyTirejZPCHd",
        ),
        (
            "Première ligne CLAUDE.md",
            1,
            "Read",
            "toolu_01DeWPF6kQ953b6pyYVJiWV5",
        ),
        (
            "Compter fichiers .rs core",
            2,
            "Bash",
            "toolu_01XTJKmAKCs15oTtQqa9ovP3",
        ),
        (
            "Résumer fichiers .rs daemon",
            10,
            "Read",
            "toolu_015E7AJ3X4wQvnKkWyGNECaQ",
        ),
    ];
    for (a, (description, tools, last, tool_use_id)) in agents.iter().zip(expected) {
        assert_eq!(a.status, SubagentStatus::Done, "{}", a.agent_id);
        assert_eq!(a.agent_type.as_deref(), Some("general-purpose"));
        assert_eq!(a.description.as_deref(), Some(description));
        assert_eq!(a.model.as_deref(), Some("claude-opus-5-5"));
        assert_eq!(a.tool_use_id.as_deref(), Some(tool_use_id));
        assert_eq!(a.tool_count, tools, "{}", a.agent_id);
        assert_eq!(a.last_tool.as_deref(), Some(last));
        assert_eq!(a.current_tool, None);
        assert!(a.background && a.notified);
        assert!(a.ended_at.is_some_and(|e| e > a.started_at));
        assert!(
            a.transcript_path
                .as_deref()
                .is_some_and(|p| p.ends_with(&format!("subagents/agent-{}.jsonl", a.agent_id)))
        );
        assert!(!a.report_truncated);
    }
    assert_eq!(agents[2].report.as_deref(), Some("44"));
    assert!(
        agents[1]
            .report
            .as_deref()
            .unwrap()
            .contains("# DevMaestro")
    );

    // Les `<task-notification>` ne sont pas des prompts de l'utilisateur.
    assert!(
        session
            .first_prompt
            .as_deref()
            .is_some_and(|p| p.starts_with("Avec l'outil Agent"))
    );

    // Changements signalés : création et fin immédiates, outils limités.
    let change_of = |line: usize| steps.iter().find(|s| s.line == line).unwrap().change;
    assert_eq!(change_of(6), SubagentChange::Structural); // SubagentStart
    assert_eq!(change_of(9), SubagentChange::Structural); // PostToolUse(Agent) d'abord
    assert_eq!(change_of(10), SubagentChange::None); // SubagentStart d'un agent déjà complet
    assert_eq!(change_of(11), SubagentChange::Counters); // PreToolUse d'un sous-agent
    assert_eq!(change_of(13), SubagentChange::Counters); // PostToolUse d'un sous-agent
    assert_eq!(change_of(19), SubagentChange::Structural); // SubagentStop connu
    assert_eq!(change_of(26), SubagentChange::None); // SubagentStop fantôme
    assert_eq!(change_of(3), SubagentChange::None); // outil de la conversation principale
}

#[test]
fn task_notification_as_first_prompt_is_not_a_user_prompt() {
    let mut s = Session::new(uuid::Uuid::nil(), "s", "/p", "/p", "default");
    s.apply_hook(
        &hook(json!({"hook_event_name": "UserPromptSubmit",
            "prompt": "<task-notification>\n<task-id>x</task-id>\n<status>completed</status>\n</task-notification>"})),
        at(1.0),
    );
    assert_eq!(s.first_prompt, None);
    assert_eq!(s.state.status(), SessionStatus::Running);
    s.apply_hook(
        &hook(json!({"hook_event_name": "UserPromptSubmit", "prompt": "Vrai prompt"})),
        at(2.0),
    );
    assert_eq!(s.first_prompt.as_deref(), Some("Vrai prompt"));
}

// ------------------------------------------------------------- synthétiques

fn pre_agent(tool_use_id: &str, subagent_type: &str, description: &str) -> HookEvent {
    hook(
        json!({"hook_event_name": "PreToolUse", "tool_name": "Agent",
        "tool_use_id": tool_use_id,
        "tool_input": {"description": description, "prompt": "…", "subagent_type": subagent_type}}),
    )
}

fn post_agent(tool_use_id: &str, response: Value) -> HookEvent {
    hook(
        json!({"hook_event_name": "PostToolUse", "tool_name": "Agent",
        "tool_use_id": tool_use_id, "tool_input": {"description": "entrée"},
        "tool_response": response}),
    )
}

fn launched(agent_id: &str, description: &str) -> Value {
    json!({"isAsync": true, "status": "async_launched", "agentId": agent_id,
        "description": description, "resolvedModel": "claude-opus-5-5"})
}

fn start(agent_id: &str, agent_type: &str) -> HookEvent {
    hook(
        json!({"hook_event_name": "SubagentStart", "agent_id": agent_id, "agent_type": agent_type}),
    )
}

fn sub_stop(agent_id: &str, report: Option<&str>) -> HookEvent {
    let mut v = json!({"hook_event_name": "SubagentStop", "agent_id": agent_id,
        "agent_type": "general-purpose", "agent_transcript_path": "/t/a.jsonl",
        // Liste encore l'agent qui s'arrête : jamais lu.
        "background_tasks": [{"id": agent_id, "type": "subagent", "status": "running"}]});
    if let Some(r) = report {
        v["last_assistant_message"] = json!(r);
    }
    hook(v)
}

fn agent_tool(event: &str, agent_id: &str, tool: &str) -> HookEvent {
    hook(json!({"hook_event_name": event, "agent_id": agent_id,
        "agent_type": "general-purpose", "tool_name": tool, "tool_input": {},
        "tool_use_id": format!("toolu_{agent_id}_{tool}")}))
}

fn stop_with(running: &[&str]) -> HookEvent {
    let tasks: Vec<Value> = running
        .iter()
        .map(|id| json!({"id": id, "type": "subagent", "status": "running"}))
        .collect();
    hook(json!({"hook_event_name": "Stop", "background_tasks": tasks, "session_crons": []}))
}

fn notification(agent_id: &str, status: &str) -> HookEvent {
    hook(
        json!({"hook_event_name": "UserPromptSubmit", "prompt": format!(
        "<task-notification>\n<task-id>{agent_id}</task-id>\n<status>{status}</status>\n\
         <summary>Agent « x »</summary>\n</task-notification>")}),
    )
}

fn prompt() -> HookEvent {
    hook(json!({"hook_event_name": "UserPromptSubmit", "prompt": "Fais-le"}))
}

fn apply_all(s: &mut SessionState, events: &[HookEvent]) {
    for (i, e) in events.iter().enumerate() {
        apply(s, e, at(i as f64));
    }
}

fn agent<'a>(s: &'a SessionState, id: &str) -> &'a crate::domain::Subagent {
    s.subagents().get(id).unwrap()
}

#[test]
fn both_orders_build_the_same_agent() {
    let mut a = SessionState::default();
    apply_all(
        &mut a,
        &[
            prompt(),
            pre_agent("t1", "Explore", "Chercher"),
            start("A", "Explore"),
            post_agent("t1", launched("A", "Chercher")),
        ],
    );
    let mut b = SessionState::default();
    apply_all(
        &mut b,
        &[
            prompt(),
            pre_agent("t1", "Explore", "Chercher"),
            post_agent("t1", launched("A", "Chercher")),
            start("A", "Explore"),
        ],
    );
    for s in [&a, &b] {
        let x = agent(s, "A");
        assert_eq!(x.agent_type.as_deref(), Some("Explore"));
        assert_eq!(x.description.as_deref(), Some("Chercher"));
        assert_eq!(x.model.as_deref(), Some("claude-opus-5-5"));
        assert_eq!(x.tool_use_id.as_deref(), Some("t1"));
        assert_eq!(x.status, SubagentStatus::Running);
        assert!(x.background && !x.guessed_link);
        assert_eq!(s.subagents().total(), 1);
    }
}

#[test]
fn foreground_agent_without_agent_id_uses_the_pending_launch() {
    let mut s = SessionState::default();
    apply_all(
        &mut s,
        &[
            prompt(),
            pre_agent("t1", "Explore", "Lister les fichiers"),
            start("A", "Explore"),
            agent_tool("PreToolUse", "A", "Glob"),
            agent_tool("PostToolUse", "A", "Glob"),
            sub_stop("A", Some("3 fichiers")),
            post_agent(
                "t1",
                json!({"status": "completed", "content": [{"type": "text", "text": "3"}]}),
            ),
        ],
    );
    let a = agent(&s, "A");
    assert_eq!(a.description.as_deref(), Some("Lister les fichiers"));
    assert_eq!(a.tool_use_id.as_deref(), Some("t1"));
    assert_eq!(a.status, SubagentStatus::Done);
    assert_eq!(a.report.as_deref(), Some("3 fichiers"));
    assert_eq!(a.tool_count, 1);
    assert!(!a.background);
    // Au premier plan, aucune `task-notification` n'est attendue.
    apply(&mut s, &stop_with(&[]), at(10.0));
    assert_eq!(s.status(), SessionStatus::Idle);
}

#[test]
fn ambiguous_launches_leave_the_description_empty() {
    let mut s = SessionState::default();
    apply_all(
        &mut s,
        &[
            prompt(),
            pre_agent("t1", "Explore", "Un"),
            pre_agent("t2", "Explore", "Deux"),
            start("A", "Explore"),
            start("B", "Explore"),
        ],
    );
    for id in ["A", "B"] {
        assert_eq!(agent(&s, id).description, None, "{id}");
        assert_eq!(agent(&s, id).tool_use_id, None, "{id}");
    }
    // La réponse avec `agentId` fait foi.
    apply(&mut s, &post_agent("t2", launched("B", "Deux")), at(10.0));
    assert_eq!(agent(&s, "B").description.as_deref(), Some("Deux"));
    assert_eq!(agent(&s, "A").description, None);

    // Rattachement provisoire démenti par `agentId`.
    let mut s = SessionState::default();
    apply_all(
        &mut s,
        &[
            prompt(),
            pre_agent("t1", "Explore", "Un"),
            start("A", "Explore"),
        ],
    );
    assert_eq!(agent(&s, "A").description.as_deref(), Some("Un"));
    assert!(agent(&s, "A").guessed_link);
    apply(&mut s, &post_agent("t1", launched("B", "Un")), at(10.0));
    assert_eq!(agent(&s, "A").description, None);
    assert_eq!(agent(&s, "A").tool_use_id, None);
    assert_eq!(agent(&s, "B").tool_use_id.as_deref(), Some("t1"));
}

/// Deux sous-agents en arrière-plan, lancés et en cours.
fn two_running() -> SessionState {
    let mut s = SessionState::default();
    apply_all(
        &mut s,
        &[
            prompt(),
            pre_agent("t1", "general-purpose", "Un"),
            start("A", "general-purpose"),
            post_agent("t1", launched("A", "Un")),
            pre_agent("t2", "general-purpose", "Deux"),
            post_agent("t2", launched("B", "Deux")),
            start("B", "general-purpose"),
            stop_with(&["A", "B"]),
        ],
    );
    assert_eq!(s.status(), SessionStatus::Running);
    assert_eq!(s.subagents().running_count(), 2);
    s
}

#[test]
fn failed_and_killed_notifications() {
    let mut s = two_running();
    apply(&mut s, &notification("A", "failed"), at(20.0));
    assert_eq!(agent(&s, "A").status, SubagentStatus::Failed);
    assert!(agent(&s, "A").ended_at.is_some());
    apply(&mut s, &notification("B", "killed"), at(21.0));
    assert_eq!(agent(&s, "B").status, SubagentStatus::Interrupted);
    // Notifications : la session reprend, rien n'est un prompt.
    assert_eq!(s.status(), SessionStatus::Running);
    apply(&mut s, &stop_with(&[]), at(22.0));
    assert_eq!(s.status(), SessionStatus::Idle);

    // `killed` après un `SubagentStop` : l'agent reste fini.
    let mut s = two_running();
    apply(&mut s, &sub_stop("A", Some("ok")), at(20.0));
    apply(&mut s, &notification("A", "killed"), at(21.0));
    assert_eq!(agent(&s, "A").status, SubagentStatus::Done);
    // Notification d'une tâche inconnue : ignorée, toujours pas un prompt.
    let fx = apply_tracked(&mut s, &notification("Z", "completed"), at(22.0));
    assert_eq!(fx.subagents, SubagentChange::None);
}

#[test]
fn stop_waits_for_the_task_notification() {
    let mut s = two_running();
    apply(&mut s, &sub_stop("A", Some("A fini")), at(20.0));
    apply(&mut s, &sub_stop("B", Some("B fini")), at(21.0));
    // Plus rien ne tourne, mais deux notifications doivent suivre.
    apply(&mut s, &stop_with(&[]), at(22.0));
    assert_eq!(s.status(), SessionStatus::Running);
    apply(&mut s, &notification("A", "completed"), at(23.0));
    apply(&mut s, &stop_with(&[]), at(24.0));
    assert_eq!(s.status(), SessionStatus::Running);
    // Même règle pour `idle_prompt`.
    apply(
        &mut s,
        &hook(json!({"hook_event_name": "Notification", "notification_type": "idle_prompt"})),
        at(84.0),
    );
    assert_eq!(s.status(), SessionStatus::Running);
    apply(&mut s, &notification("B", "completed"), at(85.0));
    apply(&mut s, &stop_with(&[]), at(86.0));
    assert_eq!(s.status(), SessionStatus::Idle);
}

#[test]
fn idle_prompt_keeps_running_while_a_subagent_works() {
    let mut s = two_running();
    apply(
        &mut s,
        &hook(json!({"hook_event_name": "Notification", "notification_type": "idle_prompt"})),
        at(60.0),
    );
    assert_eq!(s.status(), SessionStatus::Running);
}

#[test]
fn stop_without_the_agent_in_background_tasks_interrupts_it() {
    let mut s = two_running();
    let fx = apply_tracked(&mut s, &stop_with(&["B"]), at(20.0));
    assert_eq!(fx.subagents, SubagentChange::Structural);
    assert_eq!(agent(&s, "A").status, SubagentStatus::Interrupted);
    assert_eq!(agent(&s, "B").status, SubagentStatus::Running);
    assert_eq!(s.status(), SessionStatus::Running);
    // Un `SubagentStop` en retard sur ce `Stop` fait foi.
    apply(&mut s, &sub_stop("A", Some("fini quand même")), at(21.0));
    assert_eq!(agent(&s, "A").status, SubagentStatus::Done);
    // Sans `background_tasks` (ancienne version) : rien n'est déduit.
    let mut s = two_running();
    apply(&mut s, &hook(json!({"hook_event_name": "Stop"})), at(20.0));
    assert_eq!(s.subagents().running_count(), 2);
    assert_eq!(s.status(), SessionStatus::Running);
}

#[test]
fn session_end_interrupts_running_agents() {
    let mut s = two_running();
    apply(&mut s, &sub_stop("A", Some("ok")), at(20.0));
    let fx = apply_tracked(
        &mut s,
        &hook(json!({"hook_event_name": "SessionEnd", "reason": "prompt_input_exit"})),
        at(21.0),
    );
    assert_eq!(fx.subagents, SubagentChange::Structural);
    assert_eq!(agent(&s, "A").status, SubagentStatus::Done);
    assert_eq!(agent(&s, "B").status, SubagentStatus::Interrupted);
    assert!(agent(&s, "B").ended_at.is_some());
    assert!(!s.subagents().busy(at(21.0)));
    assert!(s.is_stopped());

    // Fin du processus sans `SessionEnd`.
    let mut s = two_running();
    s.process_exited(&ProcessExit::Code(3), at(30.0));
    assert_eq!(s.subagents().running_count(), 0);
    assert_eq!(agent(&s, "A").status, SubagentStatus::Interrupted);
    assert_eq!(s.status(), SessionStatus::Error);
}

#[test]
fn long_report_is_cut_at_64_kib() {
    let mut s = two_running();
    let long = format!("{}é{}", "r".repeat(MAX_REPORT_BYTES - 1), "x".repeat(100));
    apply(&mut s, &sub_stop("A", Some(&long)), at(20.0));
    let a = agent(&s, "A");
    assert!(a.report_truncated);
    assert_eq!(a.report.as_ref().unwrap().len(), MAX_REPORT_BYTES - 1);
    apply(&mut s, &sub_stop("B", Some("court")), at(21.0));
    assert!(!agent(&s, "B").report_truncated);
}

#[test]
fn subagent_hooks_do_not_change_the_session_status() {
    let mut s = SessionState::default();
    apply_all(
        &mut s,
        &[
            prompt(),
            pre_agent("t1", "general-purpose", "Un"),
            post_agent("t1", launched("A", "Un")),
            start("A", "general-purpose"),
            sub_stop("A", Some("ok")),
            notification("A", "completed"),
            stop_with(&[]),
        ],
    );
    assert_eq!(s.status(), SessionStatus::Idle);
    // Hook tardif d'un sous-agent (fini ou inconnu) : la session reste inactive.
    for e in [
        agent_tool("PreToolUse", "A", "Read"),
        agent_tool("PostToolUse", "A", "Read"),
        agent_tool("PostToolUseFailure", "Z", "Bash"),
    ] {
        apply(&mut s, &e, at(30.0));
        assert_eq!(s.status(), SessionStatus::Idle);
    }
    assert_eq!(agent(&s, "A").tool_count, 0);
}

#[test]
fn tool_counters_follow_the_agent() {
    let mut s = two_running();
    let fx = apply_tracked(&mut s, &agent_tool("PreToolUse", "A", "Read"), at(20.0));
    assert_eq!(fx.subagents, SubagentChange::Counters);
    assert_eq!(agent(&s, "A").current_tool.as_deref(), Some("Read"));
    apply(&mut s, &agent_tool("PreToolUse", "A", "Grep"), at(20.5));
    assert_eq!(agent(&s, "A").tool_count, 2);
    apply(
        &mut s,
        &agent_tool("PostToolUseFailure", "A", "Grep"),
        at(21.0),
    );
    let a = agent(&s, "A");
    assert_eq!(a.current_tool, None);
    assert_eq!(a.last_tool.as_deref(), Some("Grep"));
    assert_eq!(agent(&s, "B").tool_count, 0);
}

#[test]
fn subagent_request_survives_the_main_stop() {
    let mut s = two_running();
    let mut e = hook(
        json!({"hook_event_name": "PermissionRequest", "agent_id": "A",
        "tool_name": "Bash", "tool_input": {"command": "ls"}}),
    );
    e.common.agent_id = Some("A".into());
    apply(&mut s, &e, at(20.0));
    apply(&mut s, &perm_main(), at(20.5));
    assert_eq!(s.pending().len(), 2);
    // Fin du tour principal : la demande du sous-agent qui tourne reste.
    apply(&mut s, &stop_with(&["A", "B"]), at(21.0));
    assert_eq!(s.pending().len(), 1);
    assert_eq!(s.pending()[0].agent_id.as_deref(), Some("A"));
    assert_eq!(s.status(), SessionStatus::Waiting(WaitKind::Permission));
    // Une notification de tâche ne retire rien.
    apply(&mut s, &notification("B", "completed"), at(22.0));
    assert_eq!(s.pending().len(), 1);
}

fn perm_main() -> HookEvent {
    hook(
        json!({"hook_event_name": "PermissionRequest", "tool_name": "Bash",
        "tool_input": {"command": "pwd"}}),
    )
}

// ------------------------------------------------ corrections de la relecture

fn tool_hook(event: &str, agent_id: &str, tool_use_id: Option<&str>) -> HookEvent {
    let mut v = json!({"hook_event_name": event, "agent_id": agent_id,
        "agent_type": "general-purpose", "tool_name": "Bash",
        "tool_input": {"command": "ls"}});
    if let Some(t) = tool_use_id {
        v["tool_use_id"] = json!(t);
    }
    hook(v)
}

#[test]
fn parallel_agents_with_identical_inputs_keep_their_own_requests() {
    let mut s = two_running();
    apply(
        &mut s,
        &tool_hook("PreToolUse", "A", Some("toolu_A")),
        at(20.0),
    );
    apply(
        &mut s,
        &tool_hook("PreToolUse", "B", Some("toolu_B")),
        at(20.1),
    );
    // Chaque `PermissionRequest` (sans `tool_use_id`) revendique le
    // `PreToolUse` de son propre agent, et n'est pas confondu avec l'autre.
    apply(&mut s, &tool_hook("PermissionRequest", "A", None), at(20.2));
    apply(&mut s, &tool_hook("PermissionRequest", "B", None), at(20.3));
    assert_eq!(s.pending().len(), 2);
    let ids: Vec<_> = s
        .pending()
        .iter()
        .map(|r| (r.agent_id.clone().unwrap(), r.tool_use_id.clone().unwrap()))
        .collect();
    assert_eq!(
        ids,
        [
            ("A".to_owned(), "toolu_A".to_owned()),
            ("B".to_owned(), "toolu_B".to_owned())
        ]
    );
    // La fin de l'outil de B ne retire que la demande de B.
    apply(
        &mut s,
        &tool_hook("PostToolUse", "B", Some("toolu_B")),
        at(20.4),
    );
    assert_eq!(s.pending().len(), 1);
    assert_eq!(s.pending()[0].agent_id.as_deref(), Some("A"));
    // Repli par l'entrée (sans `tool_use_id`) : seulement le même agent.
    let mut s = two_running();
    apply(&mut s, &tool_hook("PermissionRequest", "A", None), at(20.0));
    apply(&mut s, &tool_hook("PostToolUse", "B", None), at(20.1));
    assert_eq!(s.pending().len(), 1);
    apply(&mut s, &tool_hook("PostToolUse", "A", None), at(20.2));
    assert!(s.pending().is_empty());
}

#[test]
fn resumed_agent_is_followed_again() {
    let mut s = two_running();
    apply(&mut s, &sub_stop("A", Some("première fois")), at(20.0));
    apply(&mut s, &notification("A", "completed"), at(21.0));
    let fx = apply_tracked(&mut s, &start("A", "general-purpose"), at(22.0));
    assert_eq!(fx.subagents, SubagentChange::Structural);
    let a = agent(&s, "A");
    assert_eq!(a.status, SubagentStatus::Running);
    assert_eq!(a.ended_at, None);
    assert!(!a.notified);
    apply(&mut s, &sub_stop("B", Some("b")), at(23.0));
    apply(&mut s, &notification("B", "completed"), at(24.0));
    apply(&mut s, &sub_stop("A", Some("deuxième fois")), at(25.0));
    // Sa nouvelle notification est de nouveau attendue.
    apply(&mut s, &stop_with(&[]), at(26.0));
    assert_eq!(s.status(), SessionStatus::Running);
    apply(&mut s, &notification("A", "completed"), at(27.0));
    apply(&mut s, &stop_with(&[]), at(28.0));
    assert_eq!(s.status(), SessionStatus::Idle);
    assert_eq!(agent(&s, "A").report.as_deref(), Some("deuxième fois"));
}

/// Deux agents finis, dont les notifications n'arrivent pas : session retenue.
fn waiting_for_notifications() -> SessionState {
    let mut s = two_running();
    apply(&mut s, &sub_stop("A", Some("a")), at(20.0));
    apply(&mut s, &sub_stop("B", Some("b")), at(21.0));
    apply(&mut s, &stop_with(&[]), at(22.0));
    assert_eq!(s.status(), SessionStatus::Running);
    s
}

#[test]
fn a_real_user_prompt_ends_the_wait_for_notifications() {
    let mut s = waiting_for_notifications();
    apply(&mut s, &prompt(), at(30.0));
    assert_eq!(s.status(), SessionStatus::Running);
    apply(&mut s, &stop_with(&[]), at(31.0));
    assert_eq!(s.status(), SessionStatus::Idle);
}

#[test]
fn the_wait_for_notifications_expires_after_the_grace_delay() {
    let grace = crate::domain::subagents::NOTIFICATION_GRACE.whole_seconds() as f64;
    // Par le tic périodique du démon.
    let mut s = waiting_for_notifications();
    assert!(!s.tick(at(21.0 + grace - 1.0)));
    assert_eq!(s.status(), SessionStatus::Running);
    assert!(s.tick(at(21.0 + grace + 1.0)));
    assert_eq!(s.status(), SessionStatus::Idle);
    // Ou au prochain événement (ici une `Notification` sans effet propre).
    let mut s = waiting_for_notifications();
    apply(
        &mut s,
        &hook(json!({"hook_event_name": "Notification", "notification_type": "auth_success"})),
        at(21.0 + grace + 1.0),
    );
    assert_eq!(s.status(), SessionStatus::Idle);
    // Tant que Claude travaille (tour principal en cours), le tic ne touche à rien.
    let mut s = waiting_for_notifications();
    apply(&mut s, &notification("A", "completed"), at(23.0));
    assert!(!s.tick(at(21.0 + grace + 1.0)));
    assert_eq!(s.status(), SessionStatus::Running);
}

#[test]
fn early_task_notification_is_applied_when_the_agent_appears() {
    let mut s = SessionState::default();
    apply_all(
        &mut s,
        &[
            prompt(),
            pre_agent("t1", "general-purpose", "Un"),
            notification("C", "failed"),
            post_agent("t1", launched("C", "Un")),
        ],
    );
    let c = agent(&s, "C");
    assert_eq!(c.status, SubagentStatus::Failed);
    assert!(c.notified);
    // Notification `completed` en avance : l'agent ne l'attend plus à sa fin.
    let mut s = SessionState::default();
    apply_all(
        &mut s,
        &[
            prompt(),
            pre_agent("t1", "general-purpose", "Un"),
            notification("D", "completed"),
            post_agent("t1", launched("D", "Un")),
            start("D", "general-purpose"),
            sub_stop("D", Some("fini")),
            stop_with(&[]),
        ],
    );
    assert_eq!(agent(&s, "D").status, SubagentStatus::Done);
    assert_eq!(s.status(), SessionStatus::Idle);
}

#[test]
fn several_task_notifications_in_one_prompt() {
    let mut s = waiting_for_notifications();
    let both = hook(json!({"hook_event_name": "UserPromptSubmit", "prompt":
        "<task-notification>\n<task-id>A</task-id>\n<status>completed</status>\n</task-notification>\n\
         <task-notification>\n<task-id>B</task-id>\n<status>completed</status>\n</task-notification>"}));
    apply(&mut s, &both, at(30.0));
    apply(&mut s, &stop_with(&[]), at(31.0));
    assert_eq!(s.status(), SessionStatus::Idle);
}

#[test]
fn clear_and_escape_keep_running_while_subagents_work() {
    let mut s = two_running();
    apply(
        &mut s,
        &hook(json!({"hook_event_name": "SessionStart", "source": "clear"})),
        at(20.0),
    );
    assert_eq!(s.status(), SessionStatus::Running);
    assert_eq!(s.subagents().running_count(), 2);

    let mut s = two_running();
    apply(&mut s, &prompt(), at(20.0));
    let mut e = hook(
        json!({"hook_event_name": "PostToolUseFailure", "tool_name": "Bash",
        "tool_input": {"command": "sleep 9"}, "tool_use_id": "toolu_m", "is_interrupt": true}),
    );
    e.common.agent_id = None;
    apply(&mut s, &e, at(21.0));
    assert_eq!(s.status(), SessionStatus::Running);
    // Sans sous-agent : Échap rend la session inactive, comme avant.
    let mut s = SessionState::default();
    apply(&mut s, &prompt(), at(1.0));
    apply(&mut s, &e, at(2.0));
    assert_eq!(s.status(), SessionStatus::Idle);
}

#[test]
fn subagent_type_defaults_and_rejected_claim_frees_the_launch() {
    // `subagent_type` absent de l'outil `Agent` : `general-purpose`.
    let mut s = SessionState::default();
    apply_all(
        &mut s,
        &[
            prompt(),
            hook(
                json!({"hook_event_name": "PreToolUse", "tool_name": "Agent",
                "tool_use_id": "t1", "tool_input": {"description": "Sans type"}}),
            ),
            start("A", "general-purpose"),
        ],
    );
    assert_eq!(agent(&s, "A").description.as_deref(), Some("Sans type"));
    // A revendique t1 par le repli, mais la réponse de t2 dit que c'est A :
    // t1 est libéré, B peut le prendre.
    let mut s = SessionState::default();
    apply_all(
        &mut s,
        &[
            prompt(),
            pre_agent("t1", "Explore", "Un"),
            start("A", "Explore"),
            pre_agent("t2", "Explore", "Deux"),
            post_agent("t2", launched("A", "Deux")),
            start("B", "Explore"),
        ],
    );
    assert_eq!(agent(&s, "A").tool_use_id.as_deref(), Some("t2"));
    assert_eq!(agent(&s, "B").tool_use_id.as_deref(), Some("t1"));
    assert_eq!(agent(&s, "B").description.as_deref(), Some("Un"));
}
