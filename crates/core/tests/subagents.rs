//! Sous-agents (v0.2, lot 5) de bout en bout avec le faux `claude` : deux
//! sous-agents en arrière-plan vus en cours puis terminés par le protocole,
//! session restée en cours pendant leur exécution, persistance.
mod common;

use common::*;
use serde_json::{Value, json};
use uuid::Uuid;

fn subagents(c: &mut Client, id: Uuid) -> Vec<Value> {
    c.call("sessions.subagents", json!({"id": id}))["agents"]
        .as_array()
        .unwrap()
        .clone()
}

/// Dernière liste reçue par `session.subagents_changed`.
fn last_changed(c: &Client, id: Uuid) -> Option<Vec<Value>> {
    c.notifications
        .iter()
        .rev()
        .find(|n| n["method"] == "session.subagents_changed" && n["params"]["id"] == json!(id))
        .map(|n| n["params"]["agents"].as_array().unwrap().clone())
}

fn statuses_of(agents: &[Value]) -> Vec<&str> {
    agents
        .iter()
        .map(|a| a["status"].as_str().unwrap())
        .collect()
}

#[test]
fn background_subagents_followed_through_the_protocol() {
    let env = Env::new();
    let mut daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    c.call("hello", json!({}));
    let id = session(&mut c, &env, json!({}));
    let before = c.statuses(id).len();

    c.input(id, b"/agents\r");
    wait_output(&mut c, id, "touche f pour les finir");
    c.wait_until("deux sous-agents en cours après le Stop", |c| {
        last_changed(c, id).is_some_and(|a| statuses_of(&a) == ["running", "running"])
            && c.last_session(id).is_some_and(|s| {
                s["subagents_running"] == 2
                    && s["subagents_total"] == 2
                    && s["status"]["state"] == "running"
            })
    });
    let agents = subagents(&mut c, id);
    assert_eq!(agents.len(), 2, "{agents:?}");
    assert_eq!(agents[0]["description"], "Lire le README");
    assert_eq!(agents[1]["description"], "Compter les fichiers");
    for a in &agents {
        assert_eq!(a["status"], "running");
        assert_eq!(a["agent_type"], "general-purpose");
        assert_eq!(a["model"], "claude-opus-5-5");
        assert!(
            a["tool_use_id"]
                .as_str()
                .unwrap()
                .starts_with("toolu_agent_")
        );
        assert!(a.get("report").is_none(), "pas de rapport dans la liste");
        assert!(a["ended_at"].is_null());
    }
    // L'outil du premier sous-agent est compté (notification limitée à une
    // toutes les 500 ms, mais la liste lue est à jour).
    c.wait_until("outil du sous-agent", |c| {
        last_changed(c, id).is_some_and(|a| a[0]["tool_count"] == 1)
    });
    let agents = subagents(&mut c, id);
    assert_eq!(agents[0]["current_tool"], "Read");
    assert_eq!(agents[0]["last_tool"], "Read");
    assert_eq!(agents[1]["tool_count"], 0);

    c.input(id, b"f");
    c.wait_until("fin des sous-agents et session inactive", |c| {
        c.last_session(id)
            .is_some_and(|s| s["status"]["state"] == "idle" && s["subagents_running"] == 0)
    });
    // Jamais inactive pendant leur exécution : un seul passage running → idle,
    // malgré les trois `Stop` (deux sous-agents en cours, un dernier en cours,
    // une notification attendue) et les deux `<task-notification>`.
    assert_eq!(c.statuses(id)[before..], ["running", "idle"]);
    let agents = subagents(&mut c, id);
    assert_eq!(statuses_of(&agents), ["done", "done"]);
    assert_eq!(agents[0]["current_tool"], Value::Null);
    assert!(agents.iter().all(|a| a["ended_at"].is_string()));
    assert_eq!(
        last_changed(&c, id).map(|a| statuses_of(&a).join(",")),
        Some("done,done".to_owned())
    );
    // Le `SubagentStop` de l'agent interne est ignoré.
    assert_eq!(c.last_session(id).unwrap()["subagents_total"], 2);
    // Une `<task-notification>` n'est pas le premier prompt.
    assert_eq!(c.last_session(id).unwrap()["first_prompt"], Value::Null);

    let b = agents[1]["agent_id"].as_str().unwrap().to_owned();
    let detail = c.call("sessions.subagent", json!({"id": id, "agent_id": b}));
    assert_eq!(detail["report"], "44");
    assert_eq!(detail["report_truncated"], false);
    assert!(
        detail["transcript_path"]
            .as_str()
            .unwrap()
            .ends_with(&format!("agent-{b}.jsonl"))
    );

    // Paramètres validés comme ailleurs.
    let unknown = Uuid::from_u128(7);
    for (method, params, code) in [
        ("sessions.subagents", json!({}), -32602),
        ("sessions.subagents", json!({"id": "pas-un-uuid"}), -32602),
        ("sessions.subagents", json!({"id": unknown}), -32001),
        ("sessions.subagent", json!({"id": id}), -32602),
        (
            "sessions.subagent",
            json!({"id": id, "agent_id": 3}),
            -32602,
        ),
        (
            "sessions.subagent",
            json!({"id": id, "agent_id": ""}),
            -32602,
        ),
        (
            "sessions.subagent",
            json!({"id": id, "agent_id": "inconnu"}),
            -32018,
        ),
        (
            "sessions.subagent",
            json!({"id": unknown, "agent_id": "x"}),
            -32001,
        ),
    ] {
        assert_eq!(
            c.call_err(method, params.clone()),
            code,
            "{method} {params}"
        );
    }

    // Relu après un redémarrage du démon.
    let a = agents[0]["agent_id"].as_str().unwrap().to_owned();
    daemon.signal(nix::sys::signal::Signal::SIGTERM);
    daemon.wait();
    drop(c);
    let _daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    c.call("hello", json!({}));
    let agents = subagents(&mut c, id);
    assert_eq!(statuses_of(&agents), ["done", "done"]);
    assert_eq!(agents[0]["agent_id"], a);
    assert_eq!(agents[0]["tool_count"], 1);
    let detail = c.call("sessions.subagent", json!({"id": id, "agent_id": b}));
    assert_eq!(detail["report"], "44");
}

#[test]
fn running_subagents_are_interrupted_when_the_session_ends() {
    let env = Env::new();
    let mut daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    c.call("hello", json!({}));
    let id = session(&mut c, &env, json!({}));
    c.input(id, b"/agents\r");
    c.wait_until("deux sous-agents en cours", |c| {
        c.last_session(id)
            .is_some_and(|s| s["subagents_running"] == 2)
    });
    // Arrêt du démon : la session s'arrête, ses sous-agents ne finiront pas.
    daemon.signal(nix::sys::signal::Signal::SIGTERM);
    daemon.wait();
    drop(c);
    let _daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    c.call("hello", json!({}));
    let agents = subagents(&mut c, id);
    assert_eq!(statuses_of(&agents), ["interrupted", "interrupted"]);
    let s = c.call("sessions.get", json!({"id": id}))["session"].clone();
    assert_eq!(s["subagents_running"], 0);
    assert_eq!(s["subagents_total"], 2);

    // Reprise : les sous-agents relus restent, les nouveaux suivent dans
    // l'ordre de lancement.
    let old: Vec<Value> = agents.iter().map(|a| a["agent_id"].clone()).collect();
    c.call("sessions.resume", json!({"id": id}));
    c.wait_until("reprise", |c| {
        c.last_session(id)
            .is_some_and(|s| status_label(&s) == "idle")
    });
    assert_eq!(
        statuses_of(&subagents(&mut c, id)),
        ["interrupted", "interrupted"]
    );
    c.call("sessions.subscribe", json!({"id": id}));
    c.input(id, b"/agents\r");
    wait_output(&mut c, id, "touche f pour les finir");
    c.input(id, b"f");
    c.wait_until("nouveaux sous-agents finis", |c| {
        c.last_session(id)
            .is_some_and(|s| s["status"]["state"] == "idle" && s["subagents_total"] == 4)
    });
    let agents = subagents(&mut c, id);
    assert_eq!(
        statuses_of(&agents),
        ["interrupted", "interrupted", "done", "done"]
    );
    assert_eq!(agents[0]["agent_id"], old[0]);
    assert_eq!(agents[1]["agent_id"], old[1]);
    assert!(agents.iter().all(|a| a["ended_at"].is_string()));
}
