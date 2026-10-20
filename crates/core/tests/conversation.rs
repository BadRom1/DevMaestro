//! Vue conversation (v0.3, lots 10 et 12) de bout en bout avec le faux
//! `claude` : il écrit un transcript réaliste (repris des fixtures du
//! prototype n° 5) au fil des hooks ; le démon le suit et le sert par
//! `conversation.get`, `conversation.changed`, `conversation.subagent` et
//! `conversation.full` ; activité dérivée des hooks ; `sessions.sendPrompt`.
mod common;

use common::*;
use serde_json::{Value, json};
use uuid::Uuid;

/// Toutes les entrées reçues par `conversation.changed` pour la session.
fn upserts(c: &Client, id: Uuid) -> Vec<Value> {
    c.notifications
        .iter()
        .filter(|n| n["method"] == "conversation.changed" && n["params"]["id"] == json!(id))
        .flat_map(|n| n["params"]["upserts"].as_array().unwrap().clone())
        .collect()
}

/// Dernière version reçue d'une entrée qui satisfait `pred`.
fn last_upsert(c: &Client, id: Uuid, pred: impl Fn(&Value) -> bool) -> Option<Value> {
    upserts(c, id).into_iter().rev().find(|e| pred(e))
}

fn entries(c: &mut Client, id: Uuid) -> Vec<Value> {
    c.call("conversation.get", json!({"id": id}))["entries"]
        .as_array()
        .unwrap()
        .clone()
}

fn kinds(entries: &[Value]) -> Vec<&str> {
    entries
        .iter()
        .map(|e| e["kind"].as_str().unwrap())
        .collect()
}

/// Attend la fin du `n`-ième tour ordinaire du faux (texte « Fait. »), puis
/// une session inactive : `wait_idle` seul peut voir l'état d'avant le tour.
fn wait_turn_end(c: &mut Client, id: Uuid, n: usize) {
    c.wait_until("fin du tour", |c| {
        let mut uids: Vec<Value> = upserts(c, id)
            .into_iter()
            .filter(|e| e["kind"] == "text" && e["markdown"] == "Fait.")
            .map(|e| e["uid"].clone())
            .collect();
        uids.dedup();
        uids.len() >= n
    });
    wait_idle(c, id);
}

/// Transcript courant d'une session (profil par défaut du faux).
fn transcript_of(env: &Env, c: &Client, id: Uuid) -> std::path::PathBuf {
    let claude = c.last_session(id).unwrap()["claude_session_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let encoded: String = env
        .proj
        .to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    env.home
        .join(".claude/projects")
        .join(encoded)
        .join(format!("{claude}.jsonl"))
}

fn activity(c: &Client, id: Uuid) -> Option<Value> {
    c.last_session(id).map(|s| s["activity"].clone())
}

#[test]
fn conversation_follows_the_transcript_with_upserts() {
    let env = Env::new();
    let mut daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    c.call("hello", json!({}));
    let id = session(&mut c, &env, json!({}));
    assert_eq!(activity(&c, id).unwrap()["kind"], "idle");

    let first = c.call("conversation.get", json!({"id": id}));
    assert_eq!(first["segments"].as_array().unwrap().len(), 1);
    assert_eq!(first["segments"][0]["reason"], "start");
    assert_eq!(first["invalid_lines"], 0);
    assert_eq!(first["has_more"], false);
    // Première ligne du faux transcript : de l'intendance, rien à montrer.
    assert_eq!(first["entries"], json!([]));

    c.input(id, b"/conv\r");
    wait_output(&mut c, id, "Read en cours");
    // L'outil arrive sans son résultat ; l'activité dit « outil Read ».
    c.wait_until("Read sans résultat", |c| {
        last_upsert(c, id, |e| e["kind"] == "tool" && e["name"] == "Read")
            .is_some_and(|e| e.get("result").is_none())
            && activity(c, id).is_some_and(|a| a["kind"] == "tool" && a["tool"] == "Read")
    });
    let read = last_upsert(&c, id, |e| e["name"] == "Read").unwrap();
    assert!(read["summary"].as_str().unwrap().ends_with("/calcul.py"));
    assert!(activity(&c, id).unwrap()["since"].is_string());
    let texts = upserts(&c, id);
    assert!(
        texts
            .iter()
            .any(|e| e["kind"] == "text" && e["markdown"] == "ALPHADEBUT Je lis le fichier.")
    );
    assert!(texts.iter().any(|e| e["kind"] == "thinking"));
    let prompt = texts.iter().find(|e| e["kind"] == "prompt").unwrap();
    assert_eq!(prompt["source"], "typed");
    assert!(prompt["prompt_id"].as_str().unwrap().starts_with("prompt-"));

    // Le résultat complète l'entrée de l'outil : même `uid`, nouvelle version.
    c.input(id, b"r");
    c.wait_until("Read complété", |c| {
        last_upsert(c, id, |e| e["uid"] == read["uid"])
            .is_some_and(|e| e["result"]["status"] == "ok")
    });
    wait_idle(&mut c, id);
    c.wait_until("texte de fin", |c| {
        last_upsert(c, id, |e| e["kind"] == "text")
            .is_some_and(|e| e["markdown"] == "BETADEBUT Fonction **multiplication** ajoutée.")
    });
    assert_eq!(activity(&c, id).unwrap()["kind"], "idle");

    let all = entries(&mut c, id);
    assert_eq!(
        kinds(&all),
        ["prompt", "thinking", "text", "tool", "tool", "text"]
    );
    let edit = &all[4];
    assert_eq!(edit["name"], "Edit");
    assert_eq!(edit["input_truncated"], false);
    assert_eq!(edit["result"]["truncated"], false);
    let hunk = &edit["result"]["patch"][0];
    assert_eq!(hunk["header"], "@@ -1,2 +1,6 @@");
    assert_eq!(
        hunk["lines"][4],
        json!({"kind": "+", "old_no": null, "new_no": 5, "text": "def multiplication(a, b):"})
    );
    assert!(
        all.iter()
            .all(|e| e["segment"] == 0 && e.get("agent_id").is_none())
    );

    // Pagination : curseur `before`.
    let page = c.call(
        "conversation.get",
        json!({"id": id, "before": all[5]["uid"], "limit": 2}),
    );
    assert_eq!(kinds(page["entries"].as_array().unwrap()), ["tool", "tool"]);
    assert_eq!(page["has_more"], true);
    for bad in [
        json!({"id": id, "before": "inconnu"}),
        json!({"id": id, "limit": 0}),
        json!({"id": id, "limit": 1001}),
    ] {
        assert_eq!(c.call_err("conversation.get", bad), -32602);
    }
    assert_eq!(
        c.call_err("conversation.get", json!({"id": Uuid::new_v4()})),
        -32001
    );

    // Lecture entière d'une partie.
    let full = c.call(
        "conversation.full",
        json!({"id": id, "uid": edit["uid"], "part": "input"}),
    );
    assert!(
        full["text"]
            .as_str()
            .unwrap()
            .contains("def multiplication")
    );
    assert_eq!(full["truncated"], false);
    let full = c.call(
        "conversation.full",
        json!({"id": id, "uid": all[2]["uid"], "part": "text"}),
    );
    assert_eq!(full["text"], "ALPHADEBUT Je lis le fichier.");
    for bad in [
        json!({"id": id, "uid": "inconnu", "part": "text"}),
        json!({"id": id, "uid": all[2]["uid"], "part": "result"}),
        json!({"id": id, "uid": all[2]["uid"], "part": "autre"}),
    ] {
        assert_eq!(c.call_err("conversation.full", bad), -32602);
    }

    // Vie privée : une vraie erreur de lecture (transcript illisible) est
    // signalée une seule fois, sans chemin ni contenu.
    let transcript = transcript_of(&env, &c, id);
    {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&transcript)
            .unwrap();
        f.write_all(b"{\"type\":\"user\",\"uuid\":\"secret-1\",\"message\":{\"content\":\"SECRETAJOUT\"}}\n")
            .unwrap();
        std::fs::set_permissions(&transcript, std::fs::Permissions::from_mode(0o000)).unwrap();
    }
    wait_log(&env, "transcript illisible");
    std::thread::sleep(std::time::Duration::from_millis(800));
    let log = daemon_log(&env);
    assert_eq!(log.matches("transcript illisible").count(), 1, "{log}");
    let dir = transcript.parent().unwrap().to_string_lossy().into_owned();
    for secret in [
        "ALPHADEBUT",
        "BETADEBUT",
        "Lis calcul.py",
        "def addition",
        "SECRETAJOUT",
        dir.as_str(),
    ] {
        assert!(!log.contains(secret), "« {secret} » dans le journal");
    }
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&transcript, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    c.wait_until("ligne lue une fois lisible", |c| {
        last_upsert(c, id, |e| e["uid"] == "secret-1").is_some()
    });
    daemon.signal(nix::sys::signal::Signal::SIGTERM);
    daemon.wait();
}

#[test]
fn subagent_compaction_and_clear() {
    let env = Env::new();
    let mut daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    c.call("hello", json!({}));
    let id = session(&mut c, &env, json!({}));
    c.call("conversation.get", json!({"id": id}));

    // Sous-agent en arrière-plan : rattaché par son `.meta.json` / son résultat.
    c.input(id, b"/conv-agent\r");
    wait_output(&mut c, id, "Sous-agent en cours");
    c.wait_until("sous-agent rattaché, session retenue", |c| {
        last_upsert(c, id, |e| e["kind"] == "subagent").is_some_and(|e| {
            e["agent_id"]
                .as_str()
                .is_some_and(|a| a.starts_with("aconv"))
                && e["status"] == "running"
                && e["agent_type"] == "Explore"
        }) && activity(c, id).is_some_and(|a| a["kind"] == "subagents")
    });
    let sub = last_upsert(&c, id, |e| e["kind"] == "subagent").unwrap();
    let agent = sub["agent_id"].as_str().unwrap().to_owned();
    assert_eq!(sub["description"], "Compter les fichiers");
    assert!(sub.get("parent_agent_id").is_none());
    let r = c.call(
        "conversation.subagent",
        json!({"id": id, "agent_id": agent}),
    );
    let sub_entries = r["entries"].as_array().unwrap();
    assert_eq!(kinds(sub_entries), ["prompt", "tool"]);
    assert_eq!(sub_entries[0]["source"], "system");
    assert!(sub_entries.iter().all(|e| e["agent_id"] == json!(agent)));
    assert_eq!(r["invalid_lines"], 0);
    for bad in ["inconnu", "../x"] {
        assert_eq!(
            c.call_err("conversation.subagent", json!({"id": id, "agent_id": bad})),
            -32018
        );
    }

    // Fin du sous-agent : son fichier avance, la notification de fin arrive.
    c.input(id, b"f");
    c.wait_until("sous-agent fini et notifié", |c| {
        last_upsert(c, id, |e| e["kind"] == "subagent").is_some_and(|e| e["status"] == "done")
            && last_upsert(c, id, |e| e["kind"] == "notification")
                .is_some_and(|e| e["task_id"] == json!(agent) && e["status"] == "completed")
            && last_upsert(c, id, |e| {
                e["agent_id"] == json!(agent) && e["kind"] == "tool"
            })
            .is_some_and(|e| e["result"]["text"] == "a.txt\nb.txt")
    });
    wait_idle(&mut c, id);
    c.wait_until("activité au repos", |c| {
        activity(c, id).is_some_and(|a| a["kind"] == "idle")
    });

    // Compaction : activité `compacting` entre `PreCompact` et `SessionStart`.
    c.input(id, b"/compact\r");
    wait_output(&mut c, id, "Compaction");
    c.wait_until("compaction en cours", |c| {
        activity(c, id).is_some_and(|a| a["kind"] == "compacting")
    });
    c.input(id, b"c");
    c.wait_until("compaction finie", |c| {
        activity(c, id).is_some_and(|a| a["kind"] == "idle")
            && last_upsert(c, id, |e| e["kind"] == "compaction")
                .is_some_and(|e| e["summary"] == "Résumé de la conversation.")
            && last_upsert(c, id, |e| e["kind"] == "command" && e["name"] == "/compact")
                .is_some_and(|e| e["output"] == "Compacted")
    });
    let comp = last_upsert(&c, id, |e| e["kind"] == "compaction").unwrap();
    assert_eq!(comp["trigger"], "manual");
    assert_eq!(comp["pre_tokens"], 49233);
    assert_eq!(comp["segment"], 0);

    // `/clear` : nouveau segment, nouveau fichier.
    c.input(id, b"/clear\r");
    wait_output(&mut c, id, "Conversation effacée");
    c.wait_until("segment de /clear", |c| {
        c.notifications.iter().any(|n| {
            n["method"] == "conversation.changed"
                && n["params"]["segment_started"]["reason"] == "clear"
        }) && last_upsert(c, id, |e| e["kind"] == "command" && e["name"] == "/clear").is_some()
    });
    let r = c.call("conversation.get", json!({"id": id}));
    let segs = r["segments"].as_array().unwrap();
    assert_eq!(segs.len(), 2);
    assert_eq!(segs[1]["segment"], 1);
    assert_eq!(segs[1]["reason"], "clear");
    assert_ne!(segs[0]["claude_session_id"], segs[1]["claude_session_id"]);
    assert_eq!(
        segs[1]["claude_session_id"],
        c.last_session(id).unwrap()["claude_session_id"]
    );
    let all = r["entries"].as_array().unwrap();
    let last = all.last().unwrap();
    assert_eq!(
        (last["kind"].as_str(), last["segment"].as_u64()),
        (Some("command"), Some(1))
    );
    // Un tour après le `/clear` arrive dans le nouveau segment.
    c.call("sessions.sendPrompt", json!({"id": id, "text": "après"}));
    c.wait_until("prompt du segment 1", |c| {
        last_upsert(c, id, |e| e["kind"] == "prompt" && e["text"] == "après")
            .is_some_and(|e| e["segment"] == 1)
    });
    wait_turn_end(&mut c, id, 1);
    daemon.signal(nix::sys::signal::Signal::SIGTERM);
    daemon.wait();
}

#[test]
fn send_prompt_types_or_pastes_then_enter() {
    let env = Env::new();
    let mut daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    c.call("hello", json!({}));
    let id = session(&mut c, &env, json!({}));
    c.call("conversation.get", json!({"id": id}));

    // Vide après nettoyage, absent, trop long : refusés, rien n'est écrit.
    for bad in [
        json!({"id": id, "text": "  \u{7}\r\n\t "}),
        json!({"id": id}),
        json!({"id": id, "text": "x".repeat(256 * 1024 + 1)}),
    ] {
        assert_eq!(c.call_err("sessions.sendPrompt", bad), -32602);
    }
    assert_eq!(
        c.call_err(
            "sessions.sendPrompt",
            json!({"id": Uuid::new_v4(), "text": "x"})
        ),
        -32001
    );

    // Court, une ligne : tapé, puis Entrée (caractères de contrôle retirés).
    let r = c.call(
        "sessions.sendPrompt",
        json!({"id": id, "text": "  Bonjour\u{1b} DevMaestro  "}),
    );
    assert_eq!(r, json!({"sent": true}));
    c.wait_until("prompt tapé dans le transcript", |c| {
        last_upsert(c, id, |e| e["kind"] == "prompt")
            .is_some_and(|e| e["text"] == "Bonjour DevMaestro")
    });
    wait_turn_end(&mut c, id, 1);
    assert!(env.fake_events("pasted").is_empty(), "tapé, pas collé");

    // Multiligne : collé en bracketed paste, puis Entrée.
    c.call(
        "sessions.sendPrompt",
        json!({"id": id, "text": "ligne 1\r\nligne\u{1b}[31m 2"}),
    );
    let start = std::time::Instant::now();
    while env.fake_events("pasted").is_empty() {
        assert!(
            start.elapsed() < std::time::Duration::from_secs(10),
            "collage non reçu ; écran : {}",
            c.output_text(id)
        );
        c.pump(std::time::Duration::from_millis(20));
    }
    let p = env.fake_events("pasted").pop().unwrap();
    assert_eq!(p["pasted"], "ligne 1\nligne[31m 2");
    assert_eq!(p["typed"], "");
    c.wait_until("prompt collé dans le transcript", |c| {
        last_upsert(c, id, |e| e["kind"] == "prompt")
            .is_some_and(|e| e["text"] == "ligne 1\nligne[31m 2")
    });
    wait_turn_end(&mut c, id, 2);

    // Une ligne qui finit par `\` : collée (tapée, elle passerait à la ligne).
    let before = env.fake_events("pasted").len();
    c.call("sessions.sendPrompt", json!({"id": id, "text": "fin\\"}));
    let start = std::time::Instant::now();
    while env.fake_events("pasted").len() == before {
        assert!(start.elapsed() < std::time::Duration::from_secs(10));
        c.pump(std::time::Duration::from_millis(20));
    }
    assert_eq!(env.fake_events("pasted").pop().unwrap()["pasted"], "fin\\");
    wait_turn_end(&mut c, id, 3);

    // Une demande ouverte : refus (même erreur que la revue).
    c.input(id, b"/perm Bash\r");
    c.wait_answerable(id, "permission");
    assert_eq!(
        c.call_err(
            "sessions.sendPrompt",
            json!({"id": id, "text": "pas maintenant"})
        ),
        -32002
    );
    c.input(id, b"o");
    wait_idle(&mut c, id);

    // Session arrêtée : refus.
    c.call("sessions.stop", json!({"id": id}));
    c.wait_until("session arrêtée", |c| {
        c.last_session(id)
            .is_some_and(|s| s["status"]["state"] == "stopped" && s["alive"] == false)
    });
    assert_eq!(
        c.call_err(
            "sessions.sendPrompt",
            json!({"id": id, "text": "trop tard"})
        ),
        -32002
    );
    // La conversation d'une session arrêtée reste lisible.
    let all = entries(&mut c, id);
    assert!(
        all.iter()
            .any(|e| e["kind"] == "prompt" && e["text"] == "Bonjour DevMaestro")
    );
    daemon.signal(nix::sys::signal::Signal::SIGTERM);
    daemon.wait();
}

#[test]
fn transcript_written_after_session_start_is_found() {
    let mut env = Env::new();
    env.extra_env
        .push(("FAKE_CLAUDE_LATE_TRANSCRIPT".into(), "1".into()));
    let mut daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    c.call("hello", json!({}));
    let id = session(&mut c, &env, json!({}));
    // Ni transcript ni même `projects/` au `SessionStart`.
    assert!(!env.home.join(".claude/projects").exists());
    let r = c.call("conversation.get", json!({"id": id}));
    assert_eq!(r["entries"], json!([]));
    assert_eq!(r["segments"], json!([]));
    c.call("sessions.sendPrompt", json!({"id": id, "text": "tardif"}));
    c.wait_until("transcript trouvé après coup", |c| {
        last_upsert(c, id, |e| e["kind"] == "prompt" && e["text"] == "tardif").is_some()
    });
    wait_turn_end(&mut c, id, 1);
    let r = c.call("conversation.get", json!({"id": id}));
    assert_eq!(r["segments"].as_array().unwrap().len(), 1);
    assert_eq!(r["segments"][0]["reason"], "start");
    daemon.signal(nix::sys::signal::Signal::SIGTERM);
    daemon.wait();
}

#[test]
fn a_foreign_transcript_path_is_ignored() {
    let mut env = Env::new();
    // Un autre transcript du même profil, désigné par les hooks de la session.
    let foreign = env
        .home
        .join(".claude/projects/-ailleurs/11111111-2222-4333-8444-555555555555.jsonl");
    std::fs::create_dir_all(foreign.parent().unwrap()).unwrap();
    std::fs::write(
        &foreign,
        "{\"type\":\"user\",\"uuid\":\"etranger\",\"promptSource\":\"typed\",\"message\":{\"content\":\"ÉTRANGER\"}}\n",
    )
    .unwrap();
    env.extra_env.push((
        "FAKE_CLAUDE_FOREIGN_PATH".into(),
        foreign.to_string_lossy().into_owned(),
    ));
    let mut daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    c.call("hello", json!({}));
    let id = session(&mut c, &env, json!({}));
    c.call("conversation.get", json!({"id": id}));
    c.call("sessions.sendPrompt", json!({"id": id, "text": "le vrai"}));
    c.wait_until("prompt du vrai transcript", |c| {
        last_upsert(c, id, |e| e["kind"] == "prompt" && e["text"] == "le vrai").is_some()
    });
    wait_turn_end(&mut c, id, 1);
    let all = entries(&mut c, id);
    assert!(all.iter().all(|e| e["uid"] != "etranger"), "{all:?}");
    let r = c.call("conversation.get", json!({"id": id}));
    assert_eq!(
        r["segments"][0]["claude_session_id"],
        c.last_session(id).unwrap()["claude_session_id"]
    );
    daemon.signal(nix::sys::signal::Signal::SIGTERM);
    daemon.wait();
}

#[test]
fn an_evicted_conversation_comes_back_for_a_connected_client() {
    let mut env = Env::new();
    env.extra_env
        .push(("DEVMAESTRO_CONV_MAX_IDLE".into(), "1".into()));
    let mut daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    c.call("hello", json!({}));
    let stop = |c: &mut Client, id: Uuid| {
        c.call("sessions.stop", json!({"id": id}));
        c.wait_until("session arrêtée", |c| {
            c.last_session(id).is_some_and(|s| s["alive"] == false)
        });
    };
    let a = session(&mut c, &env, json!({}));
    c.call("conversation.get", json!({"id": a}));
    c.call("sessions.sendPrompt", json!({"id": a, "text": "premier"}));
    wait_turn_end(&mut c, a, 1);
    assert!(entries(&mut c, a).iter().any(|e| e["text"] == "premier"));
    stop(&mut c, a);
    // Une seule conversation arrêtée gardée : lire celle de B évince celle de A.
    let b = session(&mut c, &env, json!({}));
    stop(&mut c, b);
    c.call("conversation.get", json!({"id": b}));
    wait_log(&env, &format!("session {a} : conversation libérée"));
    // A reprend : sa conversation est recréée, et le client qui l'avait lue
    // reçoit la suite (révisions toujours croissantes).
    c.call("sessions.resume", json!({"id": a}));
    c.wait_until("A reprise", |c| {
        c.last_session(a)
            .is_some_and(|s| s["alive"] == true && s["status"]["state"] == "idle")
    });
    let n = upserts(&c, a).len();
    c.call(
        "sessions.sendPrompt",
        json!({"id": a, "text": "après reprise"}),
    );
    c.wait_until("suite reçue après recréation", |c| {
        upserts(c, a)[n..]
            .iter()
            .any(|e| e["kind"] == "prompt" && e["text"] == "après reprise")
    });
    daemon.signal(nix::sys::signal::Signal::SIGTERM);
    daemon.wait();
}
