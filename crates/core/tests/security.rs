//! Défense du démon contre les sessions qu'il supervise (« Modèle de menace »
//! de `docs/protocole.md`) : socket de contrôle refusé aux processus des
//! sessions (scope systemd, environnement, ascendance, orphelins d'un démon
//! planté), socket des relais réservé aux processus de la session du jeton,
//! modes dangereux.

mod common;

use std::os::unix::net::UnixStream;
use std::time::{Duration, Instant};

use common::*;
use devmaestro_core::protocol::{Frame, read_frame, request, write_frame};
use serde_json::{Value, json};

/// Arguments du n-ième lancement du faux claude.
fn launch_args(env: &Env, n: usize) -> Vec<String> {
    let start = Instant::now();
    while env.fake_launches().len() <= n {
        assert!(
            start.elapsed() < TIMEOUT,
            "lancement n° {n} absent du journal"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    env.fake_launches()[n]["args"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a.as_str().unwrap().to_owned())
        .collect()
}

fn mode_arg(args: &[String]) -> Option<String> {
    args.windows(2)
        .find(|w| w[0] == "--permission-mode")
        .map(|w| w[1].clone())
}

#[test]
fn dangerous_modes_need_the_daemon_setting() {
    let env = Env::new();
    let mut daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    c.call("hello", json!({}));
    for mode in ["bypassPermissions", "dontAsk"] {
        let r = c.call_raw("sessions.launch", json!({"cwd": env.proj, "mode": mode}));
        assert_eq!(r["error"]["code"], -32005, "{r}");
        assert!(
            r["error"]["message"]
                .as_str()
                .unwrap()
                .contains("allow_dangerous_modes")
        );
    }
    assert!(
        c.call("sessions.list", json!({}))["sessions"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    // Les réglages générés verrouillent bypassPermissions.
    let settings: Value = serde_json::from_str(
        &std::fs::read_to_string(env.data.join("devmaestro/settings/default.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        settings["permissions"]["disableBypassPermissionsMode"],
        "disable"
    );

    // Le réglage n'est lu qu'au démarrage : sans redémarrage, toujours refusé.
    env.write_config("allow_dangerous_modes = true\n");
    let r = c.call_raw(
        "sessions.launch",
        json!({"cwd": env.proj, "mode": "bypassPermissions"}),
    );
    assert_eq!(r["error"]["code"], -32005, "{r}");
    daemon.signal(nix::sys::signal::Signal::SIGTERM);
    daemon.wait();
    drop(c);
    let mut daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    c.call("hello", json!({}));
    let settings: Value = serde_json::from_str(
        &std::fs::read_to_string(env.data.join("devmaestro/settings/default.json")).unwrap(),
    )
    .unwrap();
    assert!(settings.get("permissions").is_none(), "{settings}");
    let id = launch_idle(&mut c, &env, json!({"mode": "bypassPermissions"}));
    turn(&mut c, id);
    assert_eq!(c.last_session(id).unwrap()["mode"], "bypassPermissions");
    c.input(id, b"/exit\r");
    c.wait_until("arrêt", |c| {
        c.last_session(id).is_some_and(|s| s["alive"] == false)
    });

    // Réglage retiré (et démon redémarré) : reprendre une session qui était
    // en bypass est refusé, sauf en demandant un autre mode.
    env.write_config("allow_dangerous_modes = false\n");
    daemon.signal(nix::sys::signal::Signal::SIGTERM);
    daemon.wait();
    drop(c);
    let _daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    c.call("hello", json!({}));
    let r = c.call_raw("sessions.resume", json!({"id": id}));
    assert_eq!(r["error"]["code"], -32005, "{r}");
    assert!(
        r["error"]["message"]
            .as_str()
            .unwrap()
            .contains("était en mode")
    );
    c.call("sessions.resume", json!({"id": id, "mode": "default"}));
}

#[test]
fn default_mode_of_project_or_profile_is_made_explicit() {
    let env = Env::new();
    std::fs::create_dir_all(env.proj.join(".claude")).unwrap();
    std::fs::write(
        env.home.join(".claude/settings.json"),
        r#"{"permissions": {"defaultMode": "bypassPermissions"}}"#,
    )
    .unwrap();
    let _daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    c.call("hello", json!({}));

    // Mode dangereux par défaut (profil), non autorisé : lancé en « manual »,
    // avec un avertissement.
    let r = c.call("sessions.launch", json!({"cwd": env.proj}));
    let warnings = r["warnings"].as_array().unwrap();
    assert_eq!(warnings.len(), 1, "{r}");
    assert!(warnings[0].as_str().unwrap().contains("bypassPermissions"));
    let id: uuid::Uuid = r["session"]["id"].as_str().unwrap().parse().unwrap();
    c.wait_until("lancée", |c| {
        c.last_session(id)
            .is_some_and(|s| s["status"]["state"] == "idle")
    });
    assert_eq!(mode_arg(&launch_args(&env, 0)).as_deref(), Some("manual"));
    assert!(daemon_log(&env).contains("n'est pas autorisé par le démon"));

    // Le projet l'emporte sur le profil ; mode sûr : passé tel quel.
    std::fs::write(
        env.proj.join(".claude/settings.json"),
        r#"{"permissions": {"defaultMode": "plan"}}"#,
    )
    .unwrap();
    let r = c.call("sessions.launch", json!({"cwd": env.proj}));
    assert!(r["warnings"].as_array().unwrap().is_empty());
    assert_eq!(mode_arg(&launch_args(&env, 1)).as_deref(), Some("plan"));
    std::fs::write(
        env.proj.join(".claude/settings.local.json"),
        r#"{"permissions": {"defaultMode": "dontAsk"}}"#,
    )
    .unwrap();
    let r = c.call("sessions.launch", json!({"cwd": env.proj}));
    assert_eq!(r["warnings"].as_array().unwrap().len(), 1);
    assert_eq!(mode_arg(&launch_args(&env, 2)).as_deref(), Some("manual"));

    // Un hook qui rapporte un mode dangereux non autorisé : signalé.
    c.call("sessions.subscribe", json!({"id": id}));
    c.input(id, b"/mode bypassPermissions\r");
    wait_output(&mut c, id, "mode forcé : bypassPermissions");
    turn(&mut c, id);
    let fx = c.effects(id);
    let detected: Vec<&Value> = fx
        .iter()
        .filter(|e| e["type"] == "dangerous_mode_detected")
        .collect();
    assert_eq!(detected.len(), 1, "{fx:?}");
    assert_eq!(detected[0]["mode"], "bypassPermissions");
    // Une seule fois tant que le mode ne change pas.
    turn(&mut c, id);
    assert_eq!(
        c.effects(id)
            .iter()
            .filter(|e| e["type"] == "dangerous_mode_detected")
            .count(),
        1
    );
}

#[test]
fn sessions_cannot_use_the_control_socket() {
    let env = Env::new();
    let _daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    c.call("hello", json!({}));
    let id = session(&mut c, &env, json!({"mode": "default"}));

    // Un processus lancé par la session, qui connaît le chemin du socket de contrôle.
    c.input(id, b"/ctl\r");
    wait_output(&mut c, id, "contrôle : refusé");
    // Un descendant détaché (rattaché à init) : reconnu par sa session.
    c.input(id, b"/ctl-detache\r");
    assert_eq!(wait_probe(&env, "detache", TIMEOUT), "refusé");
    // Nouvelle session (`setsid -f`) qui garde l'environnement : refusée
    // (ORCH_TOKEN dans /proc/<pid>/environ).
    c.input(id, b"/ctl-setsid-env\r");
    assert_eq!(wait_probe(&env, "setsid-env", TIMEOUT), "refusé");
    // Nouvelle session et environnement nettoyé : seul le scope systemd le
    // reconnaît.
    let scoped = c.last_session(id).unwrap()["scope"].is_string();
    if scoped {
        assert!(daemon_log(&env).contains("scope systemd"));
        c.input(id, b"/ctl-setsid\r");
        assert_eq!(wait_probe(&env, "setsid", TIMEOUT), "refusé");
    } else {
        eprintln!("pas de gestionnaire systemd utilisateur : sonde setsid non vérifiée");
    }
    // Le client du test, lui, est servi.
    c.call("sessions.list", json!({}));

    // Le socket des relais refuse le JSON-RPC : connexion fermée sans réponse.
    let mut relay = UnixStream::connect(env.relay_socket()).unwrap();
    relay
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    write_frame(
        &mut relay,
        &Frame::rpc(&request(1, "sessions.list", json!({}))),
    )
    .unwrap();
    assert!(matches!(read_frame(&mut relay), Ok(None) | Err(_)));
    // Les entrées de PTY aussi.
    let mut relay = UnixStream::connect(env.relay_socket()).unwrap();
    relay
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    write_frame(
        &mut relay,
        &Frame::PtyInput {
            session: id,
            data: b"/exit\r".to_vec(),
        },
    )
    .unwrap();
    assert!(matches!(read_frame(&mut relay), Ok(None) | Err(_)));
    // Et le socket de contrôle refuse les trames de hook.
    let mut control = UnixStream::connect(env.socket()).unwrap();
    control
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    write_frame(
        &mut control,
        &Frame::Hook {
            token: token_of(&env, 0),
            event: "Stop".into(),
            json: br#"{"session_id":"x","hook_event_name":"Stop"}"#.to_vec(),
        },
    )
    .unwrap();
    assert!(matches!(read_frame(&mut control), Ok(None) | Err(_)));
    // Le socket des relais refuse une trame valide (bon jeton) venue d'un
    // processus qui n'appartient pas à la session : ignorée, accusé seul.
    let mut relay = UnixStream::connect(env.relay_socket()).unwrap();
    relay
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    write_frame(
        &mut relay,
        &Frame::Hook {
            token: token_of(&env, 0),
            event: "SessionEnd".into(),
            json: br#"{"session_id":"x","hook_event_name":"SessionEnd","reason":"forge"}"#.to_vec(),
        },
    )
    .unwrap();
    assert_eq!(read_frame(&mut relay).unwrap(), Some(Frame::Ack));
    wait_log(&env, "trame de relais ignorée");
    // La session tourne toujours.
    let s = c.call("sessions.get", json!({"id": id}))["session"].clone();
    assert_eq!(s["alive"], true);
    assert_ne!(s["status"]["state"], "stopped");
}

#[test]
fn without_systemd_scope_only_environment_and_ancestry_protect() {
    let mut env = Env::new();
    env.systemd_scope = false;
    let _daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    c.call("hello", json!({}));
    let id = session(&mut c, &env, json!({"mode": "default"}));
    assert_eq!(c.last_session(id).unwrap()["scope"], json!(null));
    assert!(daemon_log(&env).contains("sessions lancées directement"));
    c.input(id, b"/ctl\r");
    wait_output(&mut c, id, "contrôle : refusé");
    c.input(id, b"/ctl-setsid-env\r");
    assert_eq!(wait_probe(&env, "setsid-env", TIMEOUT), "refusé");
    // Limite documentée (protocole § 10) : nouvelle session et environnement
    // nettoyé, sans scope, ne sont plus reconnus.
    c.input(id, b"/ctl-setsid\r");
    assert_eq!(wait_probe(&env, "setsid", TIMEOUT), "accepté");
}

#[test]
fn orphans_of_a_crashed_daemon_stay_refused() {
    let mut env = Env::new();
    // Sans scope : seules l'ascendance et la base relue protègent.
    env.systemd_scope = false;
    let daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    c.call("hello", json!({}));
    let id = session(&mut c, &env, json!({"mode": "default"}));
    // Le faux claude survit à la perte de son terminal, et lance une sonde
    // différée (même session, environnement nettoyé).
    c.input(id, b"/tetu\r");
    wait_output(&mut c, id, "SIGHUP ignoré");
    c.input(id, b"/ctl-later-3\r");
    wait_output(&mut c, id, "sonde later 3 lancée");
    let started = Instant::now();
    daemon.signal(nix::sys::signal::Signal::SIGKILL);
    drop(c);
    drop(daemon);
    let _daemon = env.start_daemon();
    assert!(
        started.elapsed() < Duration::from_millis(2500),
        "démon trop lent à redémarrer pour le test"
    );
    assert!(daemon_log(&env).contains("vivent encore"));
    // La sonde part du processus orphelin, après le redémarrage.
    assert_eq!(wait_probe(&env, "later", TIMEOUT), "refusé");
    let mut c = Client::connect(&env);
    let s = c.call("sessions.get", json!({"id": id}))["session"].clone();
    assert_eq!(s["status"]["reason"], "daemon_restart");
    kill_group(fake_pid(&env, 0));
}
