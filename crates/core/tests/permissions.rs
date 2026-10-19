//! Lot 3 : permissions et questions répondues depuis l'app, en concurrence
//! avec la TUI (ADR 0003), et changement de mode par Shift+Tab. La défense
//! des sockets est dans `security.rs`.
//!
//! Le faux `claude` (`tests/support/fake_claude.rs`) reproduit la course du
//! prototype n° 1 : il affiche un dialogue pendant que le relais
//! `PermissionRequest` attend, et prend la première réponse (touche dans le
//! terminal ou décision écrite par le relais).

mod common;

use std::time::{Duration, Instant};

use common::*;
use serde_json::{Value, json};
use uuid::Uuid;

#[test]
fn app_allows_and_denies_permissions() {
    let env = Env::new();
    let _daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    c.call("hello", json!({}));
    let id = session(&mut c, &env, json!({"mode": "default"}));

    // Autoriser depuis l'app : la TUI ferme son dialogue, l'outil s'exécute.
    c.input(id, b"/perm Bash\r");
    let req = c.wait_answerable(id, "permission");
    let pending = c.last_pending(id).unwrap();
    assert_eq!(pending["pending"]["tool_name"], "Bash");
    assert_eq!(
        pending["pending"]["suggestions"].as_array().unwrap().len(),
        2
    );
    // « Toujours » n'ajouterait que la règle du projet, pas le changement de mode.
    let always = pending["pending"]["always_rules"].as_array().unwrap();
    assert_eq!(always.len(), 1);
    assert_eq!(always[0]["destination"], "localSettings");
    assert_eq!(
        c.last_session(id).unwrap()["status"],
        json!({"state": "waiting", "wait": "permission"})
    );

    // Mauvais genre, session ou demande inconnues, décision invalide.
    assert_eq!(
        c.call_err(
            "sessions.answerQuestion",
            json!({"id": id, "request_id": req, "answers": {}})
        ),
        -32011
    );
    assert_eq!(
        c.call_err(
            "sessions.answerPermission",
            json!({"id": Uuid::new_v4(), "request_id": req, "decision": "allow"})
        ),
        -32001
    );
    assert_eq!(
        c.call_err(
            "sessions.answerPermission",
            json!({"id": id, "request_id": 999, "decision": "allow"})
        ),
        -32010
    );
    assert_eq!(
        c.call_err(
            "sessions.answerPermission",
            json!({"id": id, "request_id": req, "decision": "peut-être"})
        ),
        -32602
    );

    let r = c.call(
        "sessions.answerPermission",
        json!({"id": id, "request_id": req, "decision": "allow"}),
    );
    assert_eq!(r, json!({"request_id": req, "resolved": true}));
    wait_output(&mut c, id, "Bash autorisé par l'app (règles ajoutées : 0)");
    wait_idle(&mut c, id);
    // Une seule clôture : celle de l'app ; le PostToolUse suivant ne trouve plus rien.
    assert_eq!(c.resolutions(id, req), ["answered_by_app"]);
    // Le relais a écrit la décision, et seulement elle.
    let results = wait_relay_results(&env, 1);
    let last = results.last().unwrap();
    assert_eq!(last["code"], 0);
    let printed: Value = serde_json::from_str(last["stdout"].as_str().unwrap().trim_end()).unwrap();
    assert_eq!(
        printed,
        json!({"hookSpecificOutput": {"hookEventName": "PermissionRequest",
               "decision": {"behavior": "allow"}}})
    );
    assert!(last["stdout"].as_str().unwrap().ends_with("}\n"));
    // Déjà répondue.
    assert_eq!(
        c.call_err(
            "sessions.answerPermission",
            json!({"id": id, "request_id": req, "decision": "deny"})
        ),
        -32010
    );

    // Refuser avec un message.
    c.input(id, b"/perm Bash\r");
    let req = c.wait_answerable(id, "permission");
    c.call(
        "sessions.answerPermission",
        json!({"id": id, "request_id": req, "decision": "deny", "message": "pas ce dossier"}),
    );
    wait_output(&mut c, id, "Bash refusé par l'app : pas ce dossier");
    wait_idle(&mut c, id);
    assert_eq!(c.resolutions(id, req), ["answered_by_app"]);
    let results = wait_relay_results(&env, 2);
    let printed: Value =
        serde_json::from_str(results.last().unwrap()["stdout"].as_str().unwrap()).unwrap();
    assert_eq!(
        printed["hookSpecificOutput"]["decision"],
        json!({"behavior": "deny", "message": "pas ce dossier"})
    );
}

#[test]
fn allow_always_uses_claude_code_suggestions() {
    let env = Env::new();
    let _daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    c.call("hello", json!({}));
    let id = session(&mut c, &env, json!({"mode": "default"}));

    c.input(id, b"/perm Bash\r");
    let req = c.wait_answerable(id, "permission");
    let rule = c.last_pending(id).unwrap()["pending"]["always_rules"][0].clone();
    c.call(
        "sessions.answerPermission",
        json!({"id": id, "request_id": req, "decision": "allow_always"}),
    );
    wait_output(&mut c, id, "Bash autorisé par l'app (règles ajoutées : 1)");
    wait_idle(&mut c, id);
    let results = wait_relay_results(&env, 1);
    let printed: Value = serde_json::from_str(results[0]["stdout"].as_str().unwrap()).unwrap();
    assert_eq!(
        printed["hookSpecificOutput"]["decision"],
        json!({"behavior": "allow", "updatedPermissions": [rule]})
    );

    // Sans suggestion : erreur explicite, la demande reste répondable.
    c.input(id, b"/perm Read nosug\r");
    let req = c.wait_answerable(id, "permission");
    let r = c.call_raw(
        "sessions.answerPermission",
        json!({"id": id, "request_id": req, "decision": "allow_always"}),
    );
    assert_eq!(r["error"]["code"], -32013, "{r}");
    assert!(
        r["error"]["message"]
            .as_str()
            .unwrap()
            .contains("aucune règle proposée par Claude Code")
    );
    assert_eq!(c.last_pending(id).unwrap()["answerable"], true);
    c.call(
        "sessions.answerPermission",
        json!({"id": id, "request_id": req, "decision": "allow"}),
    );
    wait_output(&mut c, id, "Read autorisé par l'app (règles ajoutées : 0)");
    wait_idle(&mut c, id);
}

#[test]
fn terminal_answer_first_releases_the_relay_without_decision() {
    let env = Env::new();
    let _daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    c.call("hello", json!({}));
    let id = session(&mut c, &env, json!({"mode": "default"}));

    c.input(id, b"/perm Bash\r");
    let req = c.wait_answerable(id, "permission");
    // Réponse dans la TUI : le faux claude n'attend pas son relais (comme le vrai).
    c.input(id, b"o");
    wait_output(&mut c, id, "Bash autorisé dans le terminal");
    wait_idle(&mut c, id);
    // Le démon a vu le PostToolUse et a libéré le relais, sans décision.
    assert_eq!(c.resolutions(id, req), ["answered"]);
    let results = wait_relay_results(&env, 1);
    assert_eq!(results[0]["code"], 0);
    assert_eq!(results[0]["stdout"], "");
    // La réponse de l'app arrive trop tard.
    assert_eq!(
        c.call_err(
            "sessions.answerPermission",
            json!({"id": id, "request_id": req, "decision": "allow"})
        ),
        -32010
    );

    // Refus dans la TUI : la fin du tour (Stop) libère le relais.
    c.input(id, b"/perm Bash\r");
    let req = c.wait_answerable(id, "permission");
    c.input(id, b"n");
    wait_output(&mut c, id, "Bash refusé dans le terminal");
    wait_idle(&mut c, id);
    assert_eq!(c.resolutions(id, req), ["cleared"]);
    let results = wait_relay_results(&env, 2);
    assert_eq!(results[1]["stdout"], "");
}

#[test]
fn question_answered_from_the_app() {
    let env = Env::new();
    let _daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    c.call("hello", json!({}));
    let id = session(&mut c, &env, json!({"mode": "default"}));

    c.input(id, b"/ask\r");
    // La question apparaît au PreToolUse ; on attend que le relais du
    // PermissionRequest s'y rattache (déduplication).
    let req = c.wait_answerable(id, "question");
    let pending = c.last_pending(id).unwrap();
    assert_eq!(pending["pending"]["questions"].as_array().unwrap().len(), 2);
    assert_eq!(pending["pending"]["questions"][1]["multi_select"], true);
    assert_eq!(
        c.last_session(id).unwrap()["pending"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    assert_eq!(
        c.call_err(
            "sessions.answerPermission",
            json!({"id": id, "request_id": req, "decision": "allow"})
        ),
        -32011
    );
    // Réponses incomplètes ou invalides : rien ne change.
    for answers in [
        json!({"Tu préfères A ou B ?": "B"}),
        json!({"Tu préfères A ou B ?": ["A", "B"], "Quelles couleurs ?": "Rouge"}),
        json!({"Tu préfères A ou B ?": "B", "Quelles couleurs ?": "Rouge", "Autre ?": "x"}),
    ] {
        assert_eq!(
            c.call_err(
                "sessions.answerQuestion",
                json!({"id": id, "request_id": req, "answers": answers})
            ),
            -32602
        );
    }
    assert_eq!(c.last_pending(id).unwrap()["answerable"], true);

    c.call(
        "sessions.answerQuestion",
        json!({"id": id, "request_id": req, "answers": {
            "Tu préfères A ou B ?": "B",
            "Quelles couleurs ?": ["Rouge", "Vert"],
        }}),
    );
    wait_output(&mut c, id, "Réponses (app) :");
    wait_idle(&mut c, id);
    let text = c.output_text(id);
    assert!(
        text.contains(r#""Quelles couleurs ?":"Rouge, Vert""#)
            && text.contains(r#""Tu préfères A ou B ?":"B""#),
        "{text}"
    );
    assert_eq!(c.resolutions(id, req), ["answered_by_app"]);
    let results = wait_relay_results(&env, 1);
    let printed: Value = serde_json::from_str(results[0]["stdout"].as_str().unwrap()).unwrap();
    let input = &printed["hookSpecificOutput"]["decision"]["updatedInput"];
    assert_eq!(input["questions"].as_array().unwrap().len(), 2);
    assert_eq!(input["answers"]["Tu préfères A ou B ?"], "B");
}

#[test]
fn relay_gives_up_after_its_budget_without_decision() {
    let mut env = Env::new();
    env.permission_timeout = Some(3); // le relais attend 2 s
    let _daemon = env.start_daemon();
    let hooks: Value = serde_json::from_str(
        &std::fs::read_to_string(env.data.join("devmaestro/claude-plugin/hooks/hooks.json"))
            .unwrap(),
    )
    .unwrap();
    let hook = &hooks["hooks"]["PermissionRequest"][0]["hooks"][0];
    assert_eq!(hook["timeout"], 3);
    assert_eq!(
        hook["args"],
        json!(["hook", "PermissionRequest", "--wait", "2"])
    );

    let mut c = Client::connect(&env);
    c.call("hello", json!({}));
    let id = session(&mut c, &env, json!({"mode": "default"}));
    c.input(id, b"/perm Bash\r");
    let req = c.wait_answerable(id, "permission");
    // Le relais part sans décision : la demande reste (la TUI l'affiche
    // toujours) mais l'app ne peut plus y répondre.
    c.wait_until("relais parti", |c| {
        c.last_pending(id)
            .is_some_and(|p| p["request_id"] == req && p["answerable"] == false)
    });
    let results = wait_relay_results(&env, 1);
    assert_eq!(results[0]["code"], 0);
    assert_eq!(results[0]["stdout"], "");
    let elapsed = results[0]["elapsed_ms"].as_u64().unwrap();
    assert!((1900..6000).contains(&elapsed), "{elapsed} ms");
    wait_output(&mut c, id, "(relais rendu sans décision)");
    assert_eq!(
        c.call_err(
            "sessions.answerPermission",
            json!({"id": id, "request_id": req, "decision": "allow"})
        ),
        -32012
    );
    // La TUI garde la main.
    c.input(id, b"o");
    wait_output(&mut c, id, "Bash autorisé dans le terminal");
    wait_idle(&mut c, id);
    assert_eq!(c.resolutions(id, req), ["answered"]);
}

#[test]
fn set_mode_cycles_with_shift_tab() {
    let env = Env::new();
    let _daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    c.call("hello", json!({}));

    // Mode courant inconnu (aucun hook ne l'a encore porté) : refusé.
    let unknown = session(&mut c, &env, json!({}));
    assert_eq!(c.last_session(unknown).unwrap()["mode"], json!(null));
    assert_eq!(
        c.call_err("sessions.setMode", json!({"id": unknown, "mode": "plan"})),
        -32014
    );
    c.call("sessions.stop", json!({"id": unknown}));

    let id = session(&mut c, &env, json!({"mode": "default"}));
    turn(&mut c, id);
    assert_eq!(c.last_session(id).unwrap()["mode"], "default");
    assert_eq!(
        c.call_err("sessions.setMode", json!({"id": id, "mode": "nimporte"})),
        -32602
    );
    assert_eq!(
        c.call_err(
            "sessions.setMode",
            json!({"id": id, "mode": "bypassPermissions"})
        ),
        -32005
    );
    // Chaque mode du cycle est quitté au moins une fois.
    let steps = [
        ("acceptEdits", 1),
        ("auto", 2),
        ("default", 1),
        ("plan", 2),
        ("acceptEdits", 3),
        ("default", 3),
        ("auto", 3),
        ("plan", 3),
        ("default", 2),
        ("default", 0),
    ];
    for (mode, expected) in steps {
        let r = c.call("sessions.setMode", json!({"id": id, "mode": mode}));
        assert_eq!(r, json!({"sent": expected}), "vers {mode}");
        if expected > 0 {
            wait_output(&mut c, id, &format!("⏵⏵ mode : {mode}"));
        }
        // Confirmation par les hooks du tour suivant.
        turn(&mut c, id);
        assert_eq!(c.last_session(id).unwrap()["mode"], mode, "vers {mode}");
    }

    // Pendant une demande, Shift+Tab agirait sur le dialogue : refusé.
    c.input(id, b"/perm Bash\r");
    let req = c.wait_answerable(id, "permission");
    assert_eq!(
        c.call_err("sessions.setMode", json!({"id": id, "mode": "plan"})),
        -32002
    );
    c.call(
        "sessions.answerPermission",
        json!({"id": id, "request_id": req, "decision": "allow"}),
    );
    wait_idle(&mut c, id);
    c.call("sessions.stop", json!({"id": id}));
    c.wait_until("arrêt", |c| {
        c.last_session(id).is_some_and(|s| s["alive"] == false)
    });
    assert_eq!(
        c.call_err("sessions.setMode", json!({"id": id, "mode": "plan"})),
        -32002
    );
}

#[test]
fn waiting_relay_is_released_when_session_or_daemon_stops() {
    let env = Env::new();
    let mut daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    c.call("hello", json!({}));

    // `/tetu` : le faux claude et ses relais ignorent SIGHUP (disposition
    // héritée), comme un relais qui survivrait à son terminal.
    let quiet_release = |c: &mut Client, env: &Env, id: Uuid, n: usize| {
        c.input(id, b"/tetu\r");
        wait_output(c, id, "SIGHUP ignoré");
        c.input(id, b"/perm Bash\r");
        c.wait_answerable(id, "permission");
        let before = relay_results(env).len();
        assert_eq!(before, n);
        Instant::now()
    };
    let assert_quiet = |env: &Env, n: usize, since: Instant| {
        let r = wait_relay_results(env, n + 1);
        assert_eq!(r[n]["code"], 0);
        assert_eq!(r[n]["stdout"], "");
        assert!(
            since.elapsed() < Duration::from_secs(3),
            "{:?}",
            since.elapsed()
        );
    };

    // Session arrêtée pendant que le relais attend : libéré tout de suite.
    let a = session(&mut c, &env, json!({"mode": "default"}));
    let since = quiet_release(&mut c, &env, a, 0);
    c.call("sessions.stop", json!({"id": a}));
    assert_quiet(&env, 0, since);
    let pid_a = fake_pid(&env, 0);

    // Arrêt propre du démon (SIGTERM) : relais libéré dès le début de l'arrêt.
    let b = session(&mut c, &env, json!({"mode": "default"}));
    let since = quiet_release(&mut c, &env, b, 1);
    daemon.signal(nix::sys::signal::Signal::SIGTERM);
    assert_quiet(&env, 1, since);
    daemon.wait();
    drop(c);

    // Démon tué (SIGKILL) : fin de connexion, le relais sort aussitôt.
    let daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    c.call("hello", json!({}));
    let d = session(&mut c, &env, json!({"mode": "default"}));
    let since = quiet_release(&mut c, &env, d, 2);
    daemon.signal(nix::sys::signal::Signal::SIGKILL);
    assert_quiet(&env, 2, since);
    for pid in [pid_a, fake_pid(&env, 1), fake_pid(&env, 2)] {
        kill_group(pid);
    }
}

#[test]
fn forged_second_frame_neither_replaces_suggestions_nor_doubles_the_answer() {
    let env = Env::new();
    let _daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    c.call("hello", json!({}));
    let id = session(&mut c, &env, json!({"mode": "default"}));

    // Vraie demande, puis seconde trame pour le même appel (même demande :
    // deux relais rattachés) avec une règle « Bash » sans contenu.
    c.input(id, b"/perm Bash forge\r");
    let req = c.wait_answerable(id, "permission");
    wait_log(
        &env,
        &format!("relais rattaché à la demande {req} (2 en attente)"),
    );
    let pending = c.last_pending(id).unwrap();
    assert_eq!(
        c.last_session(id).unwrap()["pending"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    // Les suggestions restent celles de la première trame.
    let always = pending["pending"]["always_rules"]
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(always.len(), 1);
    assert!(
        always[0]["rules"][0]["ruleContent"]
            .as_str()
            .unwrap()
            .starts_with("rm -rf build-")
    );

    c.call(
        "sessions.answerPermission",
        json!({"id": id, "request_id": req, "decision": "allow_always"}),
    );
    wait_output(&mut c, id, "Bash autorisé par l'app (règles ajoutées : 1)");
    wait_idle(&mut c, id);
    // Les deux relais ont reçu la même décision ; une seule clôture.
    let results = wait_relay_results(&env, 2);
    for r in &results {
        let v: Value = serde_json::from_str(r["stdout"].as_str().unwrap()).unwrap();
        assert_eq!(
            v["hookSpecificOutput"]["decision"]["updatedPermissions"],
            json!(always)
        );
    }
    assert_eq!(c.resolutions(id, req), ["answered_by_app"]);
}

#[test]
fn app_answer_racing_the_terminal_answer_resolves_once() {
    let env = Env::new();
    let _daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    c.call("hello", json!({}));
    let id = session(&mut c, &env, json!({"mode": "default"}));
    for round in 0..5 {
        c.input(id, b"/perm Bash\r");
        let req = c.wait_answerable(id, "permission");
        // Les deux réponses partent ensemble.
        c.input(id, b"o");
        let r = c.call_raw(
            "sessions.answerPermission",
            json!({"id": id, "request_id": req, "decision": "allow"}),
        );
        wait_idle(&mut c, id);
        let how = c.resolutions(id, req);
        assert_eq!(how.len(), 1, "tour {round} : {how:?}");
        if r.get("error").is_some() {
            assert_eq!(r["error"]["code"], -32010, "tour {round} : {r}");
            assert_eq!(how, ["answered"]);
        } else {
            assert_eq!(how, ["answered_by_app"]);
        }
    }
    // Chaque demande n'a exécuté l'outil qu'une fois.
    let text = c.output_text(id);
    let done = text.matches("Bash autorisé").count();
    assert_eq!(done, 5, "{text}");
}

#[test]
fn second_set_mode_waits_for_the_first_to_be_confirmed() {
    let env = Env::new();
    let _daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    c.call("hello", json!({}));
    let id = session(&mut c, &env, json!({"mode": "default"}));
    turn(&mut c, id);
    assert_eq!(
        c.call("sessions.setMode", json!({"id": id, "mode": "plan"})),
        json!({"sent": 2})
    );
    // Le mode courant connu est encore « default » : un second calcul serait faux.
    assert_eq!(
        c.call_err("sessions.setMode", json!({"id": id, "mode": "auto"})),
        -32002
    );
    wait_output(&mut c, id, "⏵⏵ mode : plan");
    turn(&mut c, id);
    assert_eq!(c.last_session(id).unwrap()["mode"], "plan");
    assert_eq!(
        c.call("sessions.setMode", json!({"id": id, "mode": "auto"})),
        json!({"sent": 1})
    );
    // Sans hook pour confirmer, le verrou tombe au bout de 3 s.
    std::thread::sleep(Duration::from_millis(3200));
    assert_eq!(
        c.call("sessions.setMode", json!({"id": id, "mode": "auto"})),
        json!({"sent": 1}),
        "toujours compté depuis « plan », dernier mode confirmé"
    );
}
