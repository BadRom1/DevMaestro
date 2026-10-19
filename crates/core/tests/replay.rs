//! Rejoue les événements réels du prototype n° 1 (Claude Code 2.1.303,
//! 2026-10-19) dans la machine à états, et lit toutes les statuslines
//! capturées.
//!
//! Les fichiers de `tests/fixtures/` sont des copies de
//! `spikes/01-pty-hooks/fixtures/` : le code produit ne dépend pas de `spikes/`.

use std::collections::HashMap;

use devmaestro_core::domain::{
    Effect, HookEvent, Pending, PendingRequest, PermissionMode, RequestId, Resolution, Session,
    SessionStatus, Statusline, WaitKind,
};
use serde_json::Value;
use time::OffsetDateTime;

const EVENTS: &str = include_str!("fixtures/events-2026-10-19.jsonl");
const STATUSLINES: &str = include_str!("fixtures/statusline-2026-10-19.jsonl");

const MAIN: &str = "568e8a35-a919-4f8d-9925-6992b574be75";

/// Un pas du rejeu : l'événement et l'état qui en résulte.
#[derive(Debug)]
struct Step {
    ts: f64,
    event: String,
    status: SessionStatus,
    pending: Vec<PendingRequest>,
    mode: Option<PermissionMode>,
    effects: Vec<Effect>,
}

fn to_datetime(ts: f64) -> OffsetDateTime {
    OffsetDateTime::from_unix_timestamp_nanos((ts * 1e9) as i128).unwrap()
}

/// Rejoue le fichier d'événements, session par session, dans l'ordre.
/// Les lignes sans `payload` (`run.start`, `relay.decision`,
/// `ptyhost.inject`) sont l'outillage du prototype et sont ignorées.
fn replay() -> HashMap<String, Vec<Step>> {
    let mut sessions: HashMap<String, Session> = HashMap::new();
    let mut traces: HashMap<String, Vec<Step>> = HashMap::new();
    for line in EVENTS.lines().filter(|l| !l.trim().is_empty()) {
        let wrapper: Value = serde_json::from_str(line).expect("ligne de fixture illisible");
        let Some(payload) = wrapper.get("payload") else {
            continue;
        };
        let ts = wrapper["ts"].as_f64().unwrap();
        let event = HookEvent::from_value(payload, wrapper["event"].as_str())
            .unwrap_or_else(|e| panic!("événement illisible à {ts} : {e}"));
        let id = event.common.session_id.clone();
        let session = sessions
            .entry(id.clone())
            .or_insert_with(|| Session::new(uuid::Uuid::nil(), id.clone(), "/p", "/p", "default"));
        let effects = session.apply_hook(&event, to_datetime(ts));
        let state = &session.state;

        // Invariant : tant qu'une demande attend, le statut est une attente.
        if let Some(r) = state.pending().last() {
            assert_eq!(
                state.status(),
                SessionStatus::Waiting(r.pending.kind()),
                "à {ts}"
            );
        }
        assert_eq!(state.last_activity, Some(to_datetime(ts)));

        traces.entry(id).or_default().push(Step {
            ts,
            event: event.kind.name().to_owned(),
            status: state.status(),
            pending: state.pending().to_vec(),
            mode: state.permission_mode.clone(),
            effects,
        });
    }
    traces
}

fn at(trace: &[Step], ts: f64) -> &Step {
    trace
        .iter()
        .find(|s| (s.ts - ts).abs() < 1e-3)
        .unwrap_or_else(|| panic!("aucun événement à {ts}"))
}

/// Les effets sont-ils exactement une nouvelle demande, de ce genre ?
fn is_new_request(effects: &[Effect], id: u64, kind: WaitKind) -> bool {
    matches!(effects, [Effect::NotifyWaiting { request_id, pending }]
        if *request_id == RequestId(id) && pending.kind() == kind)
}

fn answered(id: u64) -> Vec<Effect> {
    vec![
        Effect::RequestResolved {
            request_id: RequestId(id),
            how: Resolution::Answered,
        },
        Effect::ClearWaiting,
    ]
}

#[test]
fn replay_main_session() {
    let traces = replay();
    let t = &traces[MAIN];

    // Tour simple : SessionStart → UserPromptSubmit → Stop, puis idle_prompt.
    let s = at(t, 1792402221.2534587);
    assert_eq!(
        (s.event.as_str(), &s.status),
        ("SessionStart", &SessionStatus::Idle)
    );
    let s = at(t, 1792402221.7757442);
    assert_eq!(s.status, SessionStatus::Running);
    assert_eq!(s.mode, Some(PermissionMode::Default));
    assert_eq!(at(t, 1792402224.0932922).status, SessionStatus::Idle);
    let s = at(t, 1792402335.8508084);
    assert_eq!(
        (s.event.as_str(), &s.status),
        ("Notification", &SessionStatus::Idle)
    );

    // Permission répondue dans la TUI (« switch to auto mode ») : le
    // PostToolUse identique retire la demande, le mode passe à auto.
    assert_eq!(at(t, 1792402351.0234783).status, SessionStatus::Running);
    let s = at(t, 1792402351.4555416);
    assert_eq!(s.status, SessionStatus::Waiting(WaitKind::Permission));
    assert!(is_new_request(&s.effects, 1, WaitKind::Permission));
    // Le tool_use_id est retrouvé dans le PreToolUse qui précède.
    assert_eq!(
        s.pending[0].tool_use_id.as_deref(),
        Some("toolu_01EGqZGddcmsNBYFP3EReBCk")
    );
    let Pending::Permission(p) = &s.pending[0].pending else {
        panic!("permission attendue");
    };
    assert_eq!(p.tool_name, "Bash");
    assert_eq!(p.tool_input["command"], "touch /tmp/spike-x");
    let s = at(t, 1792402356.4683244);
    assert_eq!(s.status, SessionStatus::Running);
    assert_eq!(s.effects, answered(1));
    assert!(s.pending.is_empty());
    assert_eq!(s.mode, Some(PermissionMode::Auto));
    assert_eq!(at(t, 1792402358.2755916).status, SessionStatus::Idle);

    // En mode auto, pas de demande : PreToolUse/PostToolUse → Running.
    let s = at(t, 1792402449.881866);
    assert_eq!(s.status, SessionStatus::Running);
    assert!(s.effects.is_empty());
    // PostToolUse dont l'entrée a été réécrite par un hook de l'utilisateur
    // (`cat` → `rtk read`) : sans demande en attente, rien à rapprocher.
    assert_eq!(at(t, 1792402467.5318139).status, SessionStatus::Running);

    // Retour en mode default après les Shift+Tab injectés.
    assert_eq!(
        at(t, 1792402514.3451965).mode,
        Some(PermissionMode::Default)
    );

    // Permission répondue depuis l'extérieur ; la Notification
    // permission_prompt (+ 6 s) ne change rien.
    let s = at(t, 1792402516.9754167);
    assert_eq!(s.status, SessionStatus::Waiting(WaitKind::Permission));
    assert!(is_new_request(&s.effects, 2, WaitKind::Permission));
    let s = at(t, 1792402522.9929116);
    assert_eq!(s.status, SessionStatus::Waiting(WaitKind::Permission));
    assert_eq!(s.pending.len(), 1);
    assert!(s.effects.is_empty());
    let s = at(t, 1792402527.6551);
    assert_eq!(s.status, SessionStatus::Running);
    assert_eq!(s.effects, answered(2));
    assert_eq!(at(t, 1792402529.6201499).status, SessionStatus::Idle);
    assert_eq!(at(t, 1792402590.003731).status, SessionStatus::Idle);

    // Question : PreToolUse AskUserQuestion → Waiting(Question) ; le
    // PermissionRequest et la Notification qui suivent ne renotifient pas ;
    // le PostToolUse (qui porte en plus `answers`) la retire.
    let s = at(t, 1792403010.1935873);
    assert_eq!(s.status, SessionStatus::Waiting(WaitKind::Question));
    assert!(is_new_request(&s.effects, 3, WaitKind::Question));
    let Pending::Question(q) = &s.pending[0].pending else {
        panic!("question attendue");
    };
    assert_eq!(q.questions.len(), 1);
    assert_eq!(
        q.questions[0].question,
        "Tu préfères l'option A ou l'option B ?"
    );
    assert_eq!(q.questions[0].options.len(), 2);
    assert!(at(t, 1792403010.2247462).effects.is_empty());
    let s = at(t, 1792403016.2392743);
    assert_eq!(s.status, SessionStatus::Waiting(WaitKind::Question));
    assert!(s.effects.is_empty());
    let s = at(t, 1792403043.3898892);
    assert_eq!(s.status, SessionStatus::Running);
    assert_eq!(s.effects, answered(3));

    // Seconde question, répondue depuis l'extérieur.
    assert_eq!(
        at(t, 1792403071.7832668).status,
        SessionStatus::Waiting(WaitKind::Question)
    );
    assert_eq!(at(t, 1792403072.4477324).status, SessionStatus::Running);
    assert_eq!(at(t, 1792403073.710802).status, SessionStatus::Idle);

    // Fin par /exit.
    let last = t.last().unwrap();
    assert_eq!(last.event, "SessionEnd");
    assert_eq!(
        last.status,
        SessionStatus::Stopped {
            reason: Some("prompt_input_exit".into())
        }
    );

    // Autant de cartes retirées que de cartes affichées.
    let count = |f: fn(&Effect) -> bool| t.iter().flat_map(|s| &s.effects).filter(|e| f(e)).count();
    assert_eq!(count(|e| matches!(e, Effect::NotifyWaiting { .. })), 4);
    assert_eq!(count(|e| matches!(e, Effect::ClearWaiting)), 4);
    assert_eq!(count(|e| matches!(e, Effect::RequestResolved { .. })), 4);
    assert_eq!(count(|e| matches!(e, Effect::PossiblyStale { .. })), 0);
}

#[test]
fn replay_other_sessions_end_stopped() {
    let traces = replay();
    assert_eq!(traces.len(), 3);
    for (id, trace) in &traces {
        let names: Vec<_> = trace.iter().map(|s| s.event.as_str()).collect();
        assert_eq!(names.first(), Some(&"SessionStart"), "{id}");
        assert_eq!(
            trace.last().unwrap().status,
            SessionStatus::Stopped {
                reason: Some("prompt_input_exit".into())
            },
            "{id}"
        );
        // Chaque Stop laisse la session inactive, sans demande.
        for s in trace.iter().filter(|s| s.event == "Stop") {
            assert_eq!(s.status, SessionStatus::Idle, "{id} à {}", s.ts);
            assert!(s.pending.is_empty());
        }
    }
}

#[test]
fn every_statusline_fixture_parses() {
    let mut last_cost: HashMap<String, f64> = HashMap::new();
    let mut with_rate_limits = 0;
    let mut lines = 0;
    for line in STATUSLINES.lines().filter(|l| !l.trim().is_empty()) {
        lines += 1;
        let wrapper: Value = serde_json::from_str(line).unwrap();
        let s = Statusline::from_value(&wrapper["payload"]).unwrap();
        let id = s.session_id.clone().expect("session_id");
        let m = &s.metrics;
        let model = m.model.as_ref().expect("modèle");
        assert_eq!(model.id.as_deref(), Some("claude-opus-5-5"));
        assert_eq!(model.display_name.as_deref(), Some("Opus 5.5"));
        assert_eq!(m.context_window_size, Some(1_000_000));
        assert!(m.total_tokens.is_some());
        assert_eq!(s.current_dir.as_deref(), Some("~/DevMaestro"));

        // Le coût cumulé ne décroît jamais au sein d'une session.
        let cost = m.cost_usd.expect("coût");
        let previous = last_cost.insert(id, cost).unwrap_or(0.0);
        assert!(cost >= previous);

        if wrapper["payload"].get("rate_limits").is_some() {
            with_rate_limits += 1;
            let five = m.rate_limits.five_hour.as_ref().expect("quota 5 h");
            assert!(five.used_pct.is_some() && five.resets_at.is_some());
            assert!(m.rate_limits.seven_day.is_some());
        } else {
            assert_eq!(m.rate_limits.five_hour, None);
        }
        // Le premier rendu d'une session n'a pas encore de pourcentage.
        if m.context_used_pct.is_none() {
            assert_eq!(
                wrapper["payload"]["context_window"]["used_percentage"],
                Value::Null
            );
        }
    }
    assert_eq!(lines, 40);
    assert!(with_rate_limits > 0);
    assert_eq!(last_cost.len(), 3);
}
