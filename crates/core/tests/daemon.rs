//! Test d'intégration du démon avec un faux `claude`
//! (`tests/support/fake_claude.rs`) : lancement, événements et statuts,
//! écran et entrées, redimensionnement, reconnexion d'un client, arrêt,
//! reprise, relecture de la base après un plantage, arrêt propre.
//!
//! Aucun vrai `claude`, aucun réseau : dossiers XDG et `HOME` temporaires.
mod common;

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use common::*;
use serde_json::{Value, json};
use uuid::Uuid;

const TURN: &[&str] = &["running", "waiting:permission", "running", "idle"];

#[test]
fn launch_follow_reconnect_stop_resume() {
    let env = Env::new();
    let has_git = git_available()
        && Command::new("git")
            .args(["init", "-q", "-b", "essai"])
            .current_dir(&env.proj)
            .status()
            .is_ok_and(|s| s.success());
    let mut daemon = env.start_daemon();

    // Une seule instance.
    let second = env.command(&["daemon"]).output().unwrap();
    assert!(!second.status.success());
    assert!(String::from_utf8_lossy(&second.stderr).contains("tourne déjà"));

    // Plugin et réglages générés au démarrage.
    let plugin = env.data.join("devmaestro/claude-plugin");
    let hooks: Value =
        serde_json::from_str(&std::fs::read_to_string(plugin.join("hooks/hooks.json")).unwrap())
            .unwrap();
    assert_eq!(
        hooks["hooks"]["SessionEnd"][0]["hooks"][0]["args"],
        json!(["hook", "SessionEnd"])
    );
    assert!(plugin.join(".claude-plugin/plugin.json").is_file());
    assert!(env.data.join("devmaestro/settings/work.json").is_file());

    let mut c = Client::connect(&env);
    let hello = c.call("hello", json!({"client": "test"}));
    assert_eq!(hello["protocol"], 1);
    let profiles = c.call("profiles.list", json!({}));
    let names: Vec<&str> = profiles["profiles"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["default", "work"]);
    let project = c.call("projects.resolve", json!({"path": env.proj}));
    assert_eq!(project["is_git"], has_git);
    assert_eq!(project["root"], json!(env.proj));
    assert_eq!(project["name"], "projet");

    // Lancement : un tour complet (prompt initial) avec une permission.
    let launched = c.call(
        "sessions.launch",
        json!({"cwd": env.proj, "profile": "default", "mode": "default",
               "prompt": "Bonjour", "cols": 80, "rows": 24}),
    );
    let s = &launched["session"];
    let id: Uuid = s["id"].as_str().unwrap().parse().unwrap();
    let claude_id = s["claude_session_id"].as_str().unwrap().to_owned();
    assert_eq!(s["status"]["state"], "starting");
    assert_eq!(s["alive"], true);
    assert_eq!(s["mode"], "default");
    let mut expected = vec!["starting", "idle"];
    expected.extend_from_slice(TURN);
    c.wait_until("premier tour", |c| {
        is_subsequence(&c.statuses(id), &expected)
    });
    c.wait_until("statusline", |c| {
        c.last_session(id)
            .is_some_and(|s| s["metrics"]["cost_usd"] == json!(0.42))
    });
    let fx = c.effects(id);
    assert!(fx.iter().any(|e| e["type"] == "notify_waiting"
        && e["pending"]["kind"] == "permission"
        && e["pending"]["tool_name"] == "Bash"));
    assert!(
        fx.iter()
            .any(|e| e["type"] == "request_resolved" && e["how"] == "answered")
    );
    let last = c.last_session(id).unwrap();
    assert_eq!(last["metrics"]["context_used_pct"], json!(7.0));
    assert_eq!(last["metrics"]["model"]["display_name"], "Opus 5.5");
    if has_git {
        assert_eq!(last["branch"], json!(null)); // pas encore de commit
    }

    // Ligne de commande et environnement vus par le faux claude.
    let launches = env.fake_launches();
    assert_eq!(launches.len(), 1);
    let l = &launches[0];
    let args: Vec<&str> = l["args"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a.as_str().unwrap())
        .collect();
    assert_eq!(
        &args[..4],
        [
            "--session-id",
            claude_id.as_str(),
            "--permission-mode",
            "manual"
        ]
    );
    assert_eq!(args[4], "--plugin-dir");
    assert_eq!(args[6], "--settings");
    assert!(args[7].ends_with("settings/default.json"));
    assert_eq!(args.last(), Some(&"Bonjour"));
    assert_eq!(l["CLAUDE_CONFIG_DIR"], json!(null));
    assert_eq!(l["ORCH_SESSION"], json!(id));
    assert_eq!(l["ORCH_TOKEN_present"], true);
    // Seules les variables des relais arrivent : ni ORCH_* hérité, ni DEVMAESTRO_*.
    let mut keys: Vec<&str> = l["env_keys"]
        .as_array()
        .unwrap()
        .iter()
        .map(|k| k.as_str().unwrap())
        .collect();
    keys.sort_unstable();
    // Ni les marqueurs de session Claude Code hérités du démon : seuls les
    // réglages de l'utilisateur passent.
    assert_eq!(
        keys,
        [
            "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
            "CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS",
            "ORCH_SESSION",
            "ORCH_SOCKET",
            "ORCH_TOKEN"
        ]
    );
    // Le démon les a retirés de son propre environnement (noms au journal,
    // jamais les valeurs).
    let log = daemon_log(&env);
    assert!(
        log.contains("marqueurs de session Claude Code hérités"),
        "{log}"
    );
    assert!(log.contains("CLAUDE_CODE_CHILD_SESSION"), "{log}");
    assert!(!log.contains("secret-de-la-session-parente"), "{log}");
    assert_eq!(l["ORCH_SOCKET"], json!(env.relay_socket()));
    assert_eq!(l["TERM"], "xterm-256color");
    assert_eq!(l["COLORTERM"], "truecolor");

    // Abonnement : instantané de l'écran, puis le flux.
    let sub = c.call("sessions.subscribe", json!({"id": id}));
    let snap = &sub["snapshot"];
    assert_eq!(
        (snap["cols"].as_u64(), snap["rows"].as_u64()),
        (Some(80), Some(24))
    );
    let text = snap["text"].as_str().unwrap();
    assert!(text.contains("Faux Claude Code"), "{text}");
    assert!(text.contains("Réponse à : Bonjour"), "{text}");
    assert!(text.contains("CLAUDE_CONFIG_DIR : (absent)"), "{text}");
    assert!(
        text.contains("statusline : DevMaestro · contexte 7 % · 0,42 $"),
        "{text}"
    );
    assert!(
        snap["ansi"].as_str().unwrap().contains("\x1b[?2004h"),
        "mode collage rétabli"
    );

    // Entrée clavier : écho, puis un tour à l'Entrée.
    c.input(id, b"salut");
    c.wait_until("écho", |c| c.output_text(id).contains("salut"));
    let before = c.statuses(id).len();
    c.input(id, b"\r");
    c.wait_until("second tour", |c| {
        is_subsequence(&c.statuses(id)[before..], TURN)
    });
    c.wait_until("réponse affichée", |c| {
        c.output_text(id).contains("Réponse à : salut")
    });

    // Redimensionnement : PTY (SIGWINCH reçu par le faux claude) et émulateur.
    c.call(
        "sessions.resize",
        json!({"id": id, "cols": 100, "rows": 30}),
    );
    c.wait_until("SIGWINCH", |c| {
        c.output_text(id).contains("taille : 100x30")
    });

    // Reconnexion : un nouveau client retrouve l'écran courant.
    drop(c);
    let mut c = Client::connect(&env);
    c.call("hello", json!({}));
    let sub = c.call("sessions.subscribe", json!({"id": id, "history": true}));
    let snap = &sub["snapshot"];
    assert_eq!(
        (snap["cols"].as_u64(), snap["rows"].as_u64()),
        (Some(100), Some(30))
    );
    let text = snap["text"].as_str().unwrap();
    assert!(text.contains("Réponse à : salut"), "{text}");
    assert!(text.contains("taille : 100x30"), "{text}");
    assert!(
        sub["history"]
            .as_str()
            .unwrap()
            .contains("Faux Claude Code")
    );
    let list = c.call("sessions.list", json!({}));
    assert_eq!(list["sessions"].as_array().unwrap().len(), 1);

    // Arrêt demandé par l'app : SIGHUP, la session devient arrêtée et reprenable.
    let stop = c.call("sessions.stop", json!({"id": id}));
    assert_eq!(stop["stopping"], true);
    c.wait_until("arrêt", |c| {
        c.last_session(id)
            .is_some_and(|s| status_label(&s) == "stopped:stopped_by_app" && s["alive"] == false)
    });
    let err = c.call_raw("sessions.input", json!({"id": id, "data": "x"}));
    assert_eq!(err["error"]["code"], -32002);

    // Reprise : --resume, plugin et réglages repassés, même identifiant interne.
    let resumed = c.call("sessions.resume", json!({"id": id}));
    assert_eq!(resumed["session"]["id"], json!(id));
    assert_eq!(resumed["session"]["status"]["state"], "starting");
    c.wait_until("reprise", |c| {
        c.last_session(id)
            .is_some_and(|s| status_label(&s) == "idle")
    });
    let launches = env.fake_launches();
    assert_eq!(launches.len(), 2);
    let args: Vec<&str> = launches[1]["args"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a.as_str().unwrap())
        .collect();
    assert_eq!(&args[..2], ["--resume", claude_id.as_str()]);
    assert!(args.contains(&"--plugin-dir"));
    assert!(args.contains(&"--settings"));
    assert!(
        args.windows(2)
            .any(|w| w == ["--permission-mode", "manual"])
    );
    assert!(!args.contains(&"--session-id"));
    // L'abonnement survit à la reprise : le nouvel écran arrive dans le flux.
    c.wait_until("écran de reprise", |c| {
        c.output_text(id).contains("(reprise)")
    });

    // Sortie par /exit : SessionEnd, puis fin du processus.
    c.input(id, b"/exit\r");
    c.wait_until("SessionEnd", |c| {
        c.last_session(id)
            .is_some_and(|s| status_label(&s) == "stopped:prompt_input_exit" && s["alive"] == false)
    });
    assert_eq!(c.last_session(id).unwrap()["last_exit"], json!({"code": 0}));

    // Profil « work » : CLAUDE_CONFIG_DIR passé, statusline de l'utilisateur chaînée.
    let work = c.call(
        "sessions.launch",
        json!({"cwd": env.proj, "profile": "work", "cols": 80, "rows": 24}),
    );
    let work_id: Uuid = work["session"]["id"].as_str().unwrap().parse().unwrap();
    c.wait_until("session work", |c| {
        c.last_session(work_id)
            .is_some_and(|s| status_label(&s) == "idle")
    });
    let launches = env.fake_launches();
    assert_eq!(
        launches[2]["CLAUDE_CONFIG_DIR"],
        json!(env.home.join(".claude-work"))
    );
    let args = launches[2]["args"].as_array().unwrap();
    assert!(!args.iter().any(|a| a == "--permission-mode"));
    let snap = c.call("sessions.subscribe", json!({"id": work_id}));
    let first = snap["snapshot"]["text"].as_str().unwrap().to_owned();
    c.wait_until("statusline de l'utilisateur", |c| {
        format!("{first}{}", c.output_text(work_id))
            .contains("statusline : statusline-utilisateur-work")
    });

    // Plantage du démon (SIGKILL) : la session « work » meurt avec son PTY.
    // Au redémarrage, elle est relue comme arrêtée et reprenable.
    daemon.signal(nix::sys::signal::Signal::SIGKILL);
    daemon.wait();
    drop(c);
    let mut daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    let list = c.call("sessions.list", json!({}));
    let sessions = list["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 2);
    let by_id = |id: Uuid| sessions.iter().find(|s| s["id"] == json!(id)).unwrap();
    assert_eq!(status_label(by_id(work_id)), "stopped:daemon_restart");
    assert_eq!(status_label(by_id(id)), "stopped:prompt_input_exit");
    assert_eq!(by_id(id)["claude_session_id"], json!(claude_id));

    // Reprise après redémarrage, puis arrêt propre du démon (SIGTERM).
    c.call("sessions.resume", json!({"id": work_id}));
    c.wait_until("reprise après redémarrage", |c| {
        c.last_session(work_id)
            .is_some_and(|s| status_label(&s) == "idle")
    });
    daemon.signal(nix::sys::signal::Signal::SIGTERM);
    c.wait_until("arrêt des sessions avec le démon", |c| {
        c.last_session(work_id)
            .is_some_and(|s| s["status"]["state"] == "stopped" && s["alive"] == false)
    });
    assert!(daemon.wait().success());
    assert!(!env.socket().exists(), "socket retiré à l'arrêt");
    assert!(
        !env.relay_socket().exists(),
        "socket des relais retiré à l'arrêt"
    );
    let log = std::fs::read_to_string(env.state.join("devmaestro/orchd.log")).unwrap();
    assert!(log.contains("orchd arrêté"));
}

#[test]
fn relays_never_fail_nor_print() {
    let env = Env::new();
    let run = |args: &[&str], envs: &[(&str, &str)], stdin: &[u8]| {
        let mut cmd = env.command(args);
        for (k, v) in envs {
            cmd.env(k, v);
        }
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        // Le relais peut sortir sans lire stdin (événement absent) : EPIPE possible.
        let _ = child.stdin.take().unwrap().write_all(stdin);
        let start = Instant::now();
        let out = child.wait_with_output().unwrap();
        (out, start.elapsed())
    };
    let missing = env.run.join("absent.sock");
    let missing = missing.to_str().unwrap();
    type Case<'a> = (&'a [&'a str], &'a [(&'a str, &'a str)]);
    let cases: &[Case] = &[
        (&["hook", "Stop"], &[]),
        (&["hook"], &[("ORCH_SOCKET", missing), ("ORCH_TOKEN", "t")]),
        (
            &["hook", "SessionEnd"],
            &[("ORCH_SOCKET", missing), ("ORCH_TOKEN", "t")],
        ),
        (
            &["hook", "PermissionRequest", "en", "trop"],
            &[("ORCH_SOCKET", missing), ("ORCH_TOKEN", "t")],
        ),
    ];
    for (args, envs) in cases {
        let (out, elapsed) = run(args, envs, b"{pas du json");
        assert!(out.status.success(), "{args:?}");
        assert!(out.stdout.is_empty() && out.stderr.is_empty(), "{args:?}");
        // Budget du relais : 1 s au plus ; marge large pour une machine chargée.
        assert!(elapsed < Duration::from_secs(3), "{args:?} : {elapsed:?}");
    }

    // Démon présent mais jeton inconnu : rien non plus.
    let _daemon = env.start_daemon();
    let socket = env.relay_socket();
    let (out, _) = run(
        &["hook", "Stop"],
        &[
            ("ORCH_SOCKET", socket.to_str().unwrap()),
            ("ORCH_TOKEN", "inconnu"),
        ],
        br#"{"session_id":"x","hook_event_name":"Stop"}"#,
    );
    assert!(out.status.success() && out.stdout.is_empty() && out.stderr.is_empty());

    // Statusline sans démon : la ligne de repli, en français.
    let (out, _) = run(
        &[
            "statusline",
            "--config-dir",
            env.home.join(".claude").to_str().unwrap(),
        ],
        &[("ORCH_SOCKET", missing), ("ORCH_TOKEN", "t")],
        br#"{"context_window":{"used_percentage":12.6},"cost":{"total_cost_usd":1.5}}"#,
    );
    assert!(out.status.success());
    assert_eq!(
        String::from_utf8_lossy(&out.stdout),
        "DevMaestro · contexte 13 % · 1,50 $\n"
    );
    // Statusline de l'utilisateur du profil, même sans démon.
    let (out, _) = run(
        &[
            "statusline",
            "--config-dir",
            env.home.join(".claude-work").to_str().unwrap(),
        ],
        &[],
        b"{}",
    );
    assert_eq!(
        String::from_utf8_lossy(&out.stdout),
        "statusline-utilisateur-work\n"
    );
    // Statusline de l'utilisateur qui laisse un processus en arrière-plan
    // sur la sortie : rendue au bout du délai (2 s), avec ce qu'elle a écrit.
    let slow = env.home.join(".claude-lent");
    std::fs::create_dir_all(&slow).unwrap();
    std::fs::write(
        slow.join("settings.json"),
        r#"{"statusLine":{"type":"command","command":"sleep 30 & echo ligne-lente"}}"#,
    )
    .unwrap();
    let (out, elapsed) = run(
        &["statusline", "--config-dir", slow.to_str().unwrap()],
        &[],
        b"{}",
    );
    assert!(out.status.success());
    assert_eq!(String::from_utf8_lossy(&out.stdout), "ligne-lente\n");
    assert!(elapsed < Duration::from_millis(3500), "{elapsed:?}");
    let _ = Path::new(missing);
}

fn sessions_without_times(c: &mut Client) -> Value {
    let mut list = c.call("sessions.list", json!({}));
    for s in list["sessions"].as_array_mut().unwrap() {
        s.as_object_mut().unwrap().remove("metrics");
    }
    list
}

#[test]
fn resume_failures_leave_sessions_unchanged() {
    let mut env = Env::new();
    let mut daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    c.call("hello", json!({}));
    let id = launch_idle(&mut c, &env, json!({}));
    c.input(id, b"/exit\r");
    c.wait_until("arrêt", |c| {
        c.last_session(id).is_some_and(|s| s["alive"] == false)
    });
    let before = sessions_without_times(&mut c);

    let cases = [
        (json!({"id": id, "mode": "nimporte"}), -32602),
        (json!({"id": id, "profile": "inconnu"}), -32003),
        // Dossier absent : -32016 (worktree supprimé ?), relatif : -32602.
        (json!({"id": id, "cwd": "/nulle/part"}), -32016),
        (json!({"id": id, "cwd": "relatif"}), -32602),
        (json!({"id": id, "cols": 0}), -32602),
        (
            json!({"claude_session_id": "ancienne", "profile": "inconnu", "cwd": env.proj}),
            -32003,
        ),
        (json!({"claude_session_id": "ancienne"}), -32602),
    ];
    for (params, code) in cases {
        let r = c.call_raw("sessions.resume", params.clone());
        assert_eq!(r["error"]["code"], code, "{params} : {r}");
        assert_eq!(sessions_without_times(&mut c), before, "{params}");
    }
    let screen = c.call("sessions.subscribe", json!({"id": id}));
    let text = screen["snapshot"]["text"].as_str().unwrap().to_owned();

    // Binaire claude introuvable : même chose, et l'écran n'est pas effacé.
    daemon.signal(nix::sys::signal::Signal::SIGTERM);
    daemon.wait();
    drop(c);
    env.claude_bin = PathBuf::from("/nulle/part/claude");
    let _daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    c.call("hello", json!({}));
    let before = sessions_without_times(&mut c);
    let r = c.call_raw("sessions.resume", json!({"id": id}));
    assert_eq!(r["error"]["code"], -32004, "{r}");
    let r = c.call_raw(
        "sessions.resume",
        json!({"claude_session_id": "ancienne", "cwd": env.proj}),
    );
    assert_eq!(r["error"]["code"], -32004, "{r}");
    assert_eq!(sessions_without_times(&mut c), before);
    // (Écran vide après redémarrage : le démon ne garde pas l'écran sur disque.)
    let _ = text;
}

#[test]
fn prompts_input_crash_and_restore() {
    let env = Env::new();
    let mut daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    c.call("hello", json!({}));

    // Prompts qui commencent par un tiret : passés après `--`.
    for prompt in ["--dangerously-skip-permissions", "- liste"] {
        let id = launch_idle(&mut c, &env, json!({"prompt": prompt}));
        let launches = env.fake_launches();
        let args: Vec<&str> = launches.last().unwrap()["args"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a.as_str().unwrap())
            .collect();
        assert_eq!(&args[args.len() - 2..], ["--", prompt]);
        c.wait_until("tour du prompt", |c| {
            is_subsequence(
                &c.statuses(id),
                &["idle", "running", "waiting:permission", "running", "idle"],
            )
        });
        let snap = c.call("sessions.subscribe", json!({"id": id}));
        let text = snap["snapshot"]["text"].as_str().unwrap();
        assert!(text.contains(&format!("Réponse à : {prompt}")), "{text}");
        c.call("sessions.stop", json!({"id": id}));
    }

    // Gros collage en de nombreuses trames : rien n'est perdu (contre-pression).
    let id = launch_idle(&mut c, &env, json!({}));
    c.call("sessions.subscribe", json!({"id": id}));
    const FRAMES: usize = 600;
    const PER_FRAME: usize = 100;
    for _ in 0..FRAMES {
        c.input(id, &[b'q'; PER_FRAME]);
    }
    c.input(id, b"FIN");
    c.wait_until("fin du collage", |c| c.output_text(id).contains("FIN"));
    let echoed = c.output_text(id).bytes().filter(|b| *b == b'q').count();
    assert_eq!(echoed, FRAMES * PER_FRAME);
    c.input(id, b"\x15"); // ignoré par le faux claude
    c.call("sessions.stop", json!({"id": id}));
    c.wait_until("arrêt", |c| {
        c.last_session(id).is_some_and(|s| s["alive"] == false)
    });

    // Plantage de claude (code 3, sans SessionEnd) : statut erreur. Une
    // reprise pendant le délai de grâce constate la fin au lieu de refuser.
    let crashed = launch_idle(&mut c, &env, json!({}));
    c.input(crashed, b"/crash\r");
    std::thread::sleep(Duration::from_millis(150));
    let r = c.call("sessions.resume", json!({"id": crashed}));
    assert_eq!(r["session"]["status"]["state"], "starting");
    c.wait_until("reprise après plantage", |c| {
        c.last_session(crashed)
            .is_some_and(|s| status_label(&s) == "idle")
    });
    c.input(crashed, b"/crash\r");
    c.wait_until("erreur", |c| {
        c.last_session(crashed)
            .is_some_and(|s| status_label(&s) == "error" && s["last_exit"] == json!({"code": 3}))
    });

    // Redémarrage après plantage du démon : erreur et arrêtée gardées telles quelles.
    let list = c.call("sessions.list", json!({}));
    let before: HashMap<String, Value> = list["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| (s["id"].as_str().unwrap().to_owned(), s.clone()))
        .collect();
    let running = launch_idle(&mut c, &env, json!({}));
    daemon.signal(nix::sys::signal::Signal::SIGKILL);
    daemon.wait();
    drop(c);
    let _daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    let list = c.call("sessions.list", json!({}));
    for s in list["sessions"].as_array().unwrap() {
        let sid = s["id"].as_str().unwrap();
        if sid == running.to_string() {
            assert_eq!(status_label(s), "stopped:daemon_restart");
            continue;
        }
        let old = &before[sid];
        assert_eq!(status_label(s), status_label(old), "{sid}");
        assert_eq!(s["updated_at"], old["updated_at"], "{sid}");
    }
    assert_eq!(
        status_label(
            &list["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .find(|s| s["id"] == json!(crashed))
                .unwrap()
                .clone()
        ),
        "error"
    );
}

#[test]
fn stubborn_session_killed_and_second_signal_exits_now() {
    let env = Env::new();
    let mut daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    c.call("hello", json!({}));

    // sessions.stop sur un processus qui ignore SIGHUP : SIGKILL au bout de 3 s.
    let id = launch_idle(&mut c, &env, json!({}));
    c.call("sessions.subscribe", json!({"id": id}));
    c.input(id, b"/tetu\r");
    c.wait_until("SIGHUP ignoré", |c| {
        c.output_text(id).contains("SIGHUP ignoré")
    });
    let start = Instant::now();
    c.call("sessions.stop", json!({"id": id}));
    c.wait_until("arrêt forcé", |c| {
        c.last_session(id)
            .is_some_and(|s| status_label(&s) == "stopped:stopped_by_app" && s["alive"] == false)
    });
    assert!(start.elapsed() >= Duration::from_secs(3));

    // Arrêt du démon bloqué par une session têtue : un second SIGTERM
    // termine tout aussitôt, sans attendre les 3 s.
    let id = launch_idle(&mut c, &env, json!({}));
    c.call("sessions.subscribe", json!({"id": id}));
    c.input(id, b"/tetu\r");
    c.wait_until("SIGHUP ignoré", |c| {
        c.output_text(id).contains("SIGHUP ignoré")
    });
    daemon.signal(nix::sys::signal::Signal::SIGTERM);
    std::thread::sleep(Duration::from_millis(300));
    let start = Instant::now();
    daemon.signal(nix::sys::signal::Signal::SIGTERM);
    assert!(daemon.wait().success());
    assert!(
        start.elapsed() < Duration::from_secs(2),
        "{:?}",
        start.elapsed()
    );
    assert!(!env.socket().exists());
    drop(c);
    let _daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    let s = c.call("sessions.get", json!({"id": id}));
    assert_eq!(status_label(&s["session"]), "stopped:stopped_by_app");
}

#[test]
fn title_color_and_display_name() {
    let env = Env::new();
    let mut daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    c.call("hello", json!({}));

    // Nom affiché : premier prompt dès le lancement…
    let prompt = "Corrige le test\nunitaire du démon";
    let r = c.call(
        "sessions.launch",
        json!({"cwd": env.proj, "mode": "default", "prompt": prompt}),
    );
    let id: Uuid = r["session"]["id"].as_str().unwrap().parse().unwrap();
    assert_eq!(r["session"]["first_prompt"], prompt);
    assert_eq!(
        r["session"]["display_name"],
        "Corrige le test unitaire du démon"
    );
    assert_eq!(r["session"]["title"], json!(null));
    assert_eq!(r["session"]["color"], json!(null));
    // … puis le `session_name` de la statusline.
    c.wait_until("nom de Claude Code", |c| {
        c.last_session(id)
            .is_some_and(|s| s["display_name"] == "Session factice")
    });
    wait_idle(&mut c, id);

    // Paramètres invalides : rien ne change.
    for bad in [
        json!({"id": id}),
        json!({"id": id, "color": "purple"}),
        json!({"id": id, "color": 3}),
        json!({"id": id, "title": "é".repeat(81)}),
        json!({"id": id, "title": "deux\nlignes"}),
        json!({"id": id, "title": 12}),
    ] {
        assert_eq!(c.call_err("sessions.update", bad.clone()), -32602, "{bad}");
    }
    assert_eq!(
        c.call_err(
            "sessions.update",
            json!({"id": Uuid::new_v4(), "title": "x"})
        ),
        -32001
    );

    let before = c.last_session(id).unwrap();
    let r = c.call(
        "sessions.update",
        json!({"id": id, "title": "  Mon titre  ", "color": "violet"}),
    );
    assert_eq!(r["session"]["title"], "Mon titre");
    assert_eq!(r["session"]["color"], "violet");
    assert_eq!(r["session"]["display_name"], "Mon titre");
    assert_eq!(r["session"]["updated_at"], before["updated_at"]);
    c.wait_until("session.updated du titre", |c| {
        c.last_session(id)
            .is_some_and(|s| s["title"] == "Mon titre")
    });
    // Clé absente : inchangée ; null : effacée.
    let r = c.call("sessions.update", json!({"id": id, "color": null}));
    assert_eq!(r["session"]["title"], "Mon titre");
    assert_eq!(r["session"]["color"], json!(null));
    let r = c.call("sessions.update", json!({"id": id, "title": null}));
    assert_eq!(r["session"]["display_name"], "Session factice");
    let r = c.call(
        "sessions.update",
        json!({"id": id, "title": "Titre gardé", "color": "bleu"}),
    );
    assert_eq!(r["session"]["display_name"], "Titre gardé");
    let claude_id = r["session"]["claude_session_id"]
        .as_str()
        .unwrap()
        .to_owned();

    // Gardés à la reprise…
    c.call("sessions.stop", json!({"id": id}));
    c.wait_until("arrêt", |c| {
        c.last_session(id).is_some_and(|s| s["alive"] == false)
    });
    let r = c.call("sessions.resume", json!({"id": id}));
    assert_eq!(r["session"]["title"], "Titre gardé");
    assert_eq!(r["session"]["color"], "bleu");
    assert_eq!(r["session"]["first_prompt"], prompt);
    wait_idle(&mut c, id);

    // … et au redémarrage du démon (base SQLite).
    daemon.signal(nix::sys::signal::Signal::SIGKILL);
    daemon.wait();
    drop(c);
    let _daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    let s = c.call("sessions.get", json!({"id": id}))["session"].clone();
    assert_eq!(s["title"], "Titre gardé");
    assert_eq!(s["color"], "bleu");
    assert_eq!(s["first_prompt"], prompt);
    assert_eq!(s["metrics"]["session_name"], "Session factice");
    let r = c.call("sessions.update", json!({"id": id, "title": null}));
    assert_eq!(r["session"]["display_name"], "Session factice");
    c.call("sessions.update", json!({"id": id, "title": "Titre gardé"}));

    // Anciennes sessions : titre de l'app, sinon titre de Claude Code, sinon
    // premier prompt, sinon identifiant court.
    let dir = env.home.join(".claude/projects/-projet");
    std::fs::create_dir_all(&dir).unwrap();
    let line = |prompt: &str| {
        format!(
            r#"{{"type":"user","cwd":"/p","timestamp":"2026-10-19T10:00:00Z","message":{{"content":"{prompt}"}}}}"#
        )
    };
    std::fs::write(dir.join(format!("{claude_id}.jsonl")), line("ignoré")).unwrap();
    let with_title = "11111111-1111-4111-8111-111111111111";
    std::fs::write(
        dir.join(format!("{with_title}.jsonl")),
        format!(
            "{}\n{}\n",
            line("Prompt"),
            r#"{"type":"summary","summary":"Résumé de Claude"}"#
        ),
    )
    .unwrap();
    let with_prompt = "22222222-2222-4222-8222-222222222222";
    std::fs::write(
        dir.join(format!("{with_prompt}.jsonl")),
        line("Lis le code"),
    )
    .unwrap();
    let empty = "33333333-3333-4333-8333-333333333333";
    std::fs::write(dir.join(format!("{empty}.jsonl")), "").unwrap();
    // Sessions du démon incluses (`exclude_known: false`) : titre de l'app.
    let list = c.call("transcripts.list", json!({"exclude_known": false}));
    let names: HashMap<String, Value> = list["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            (
                s["claude_session_id"].as_str().unwrap().to_owned(),
                s["display_name"].clone(),
            )
        })
        .collect();
    assert_eq!(names[&claude_id], "Titre gardé");
    assert_eq!(names[with_title], "Résumé de Claude");
    assert_eq!(names[with_prompt], "Lis le code");
    assert_eq!(names[empty], "33333333");

    // Reprise d'une session connue seulement par son transcript : elle garde
    // son nom (titre de Claude Code, premier prompt).
    let r = c.call(
        "sessions.resume",
        json!({"claude_session_id": with_title, "cwd": env.proj}),
    );
    assert_ne!(r["session"]["id"], json!(id));
    assert_eq!(r["session"]["first_prompt"], "Prompt");
    assert_eq!(r["session"]["metrics"]["session_name"], "Résumé de Claude");
    assert_eq!(r["session"]["display_name"], "Résumé de Claude");
    let r = c.call(
        "sessions.resume",
        json!({"claude_session_id": with_prompt, "cwd": env.proj}),
    );
    assert_eq!(r["session"]["display_name"], "Lis le code");
}

/// Fichiers de transcript d'une session dans le profil par défaut du test.
fn transcript_files(env: &Env, claude_id: &str) -> Vec<PathBuf> {
    let projects = env.home.join(".claude/projects");
    std::fs::read_dir(&projects)
        .map(|d| {
            d.flatten()
                .map(|p| p.path().join(format!("{claude_id}.jsonl")))
                .filter(|p| p.is_file())
                .collect()
        })
        .unwrap_or_default()
}

#[test]
fn resumable_needs_a_transcript_and_forget_removes_a_session() {
    let env = Env::new();
    let mut daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    c.call("hello", json!({}));
    // Une seconde connexion reçoit aussi `session.removed`.
    let mut other = Client::connect(&env);
    other.call("hello", json!({}));

    let id = launch_idle(&mut c, &env, json!({}));
    let s = c.last_session(id).unwrap();
    assert_eq!(s["resumable"], false, "session vivante");
    let claude_id = s["claude_session_id"].as_str().unwrap().to_owned();
    // Le faux claude écrit son transcript, comme Claude Code.
    c.wait_until("transcript écrit", |_| {
        transcript_files(&env, &claude_id).len() == 1
    });
    c.call("sessions.stop", json!({"id": id}));
    c.wait_until("arrêtée et reprenable", |c| {
        c.last_session(id)
            .is_some_and(|s| s["alive"] == false && s["resumable"] == true)
    });

    // Transcript absent (session lancée avec un marqueur hérité, par
    // exemple) : plus reprenable, et la reprise est refusée sans rien changer.
    for f in transcript_files(&env, &claude_id) {
        std::fs::remove_file(f).unwrap();
    }
    let listed = c.call("sessions.list", json!({}));
    let s = listed["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == json!(id))
        .unwrap()
        .clone();
    assert_eq!(s["resumable"], false);
    let before = c.call("sessions.get", json!({"id": id}))["session"].clone();
    let launches = env.fake_launches().len();
    assert_eq!(c.call_err("sessions.resume", json!({"id": id})), -32015);
    assert_eq!(
        c.call_err("sessions.resume", json!({"claude_session_id": claude_id})),
        -32015
    );
    assert_eq!(
        c.call_err(
            "sessions.resume",
            json!({"claude_session_id": Uuid::new_v4(), "cwd": env.proj})
        ),
        -32015
    );
    let r = c.call_raw("sessions.resume", json!({"id": id}));
    assert_eq!(
        r["error"]["message"],
        "Claude Code n'a pas de transcript pour cette session : impossible de la reprendre"
    );
    assert_eq!(c.call("sessions.get", json!({"id": id}))["session"], before);
    assert_eq!(env.fake_launches().len(), launches, "aucun lancement");

    // Oublier : refusé pour une session vivante ou inconnue.
    let alive = launch_idle(&mut c, &env, json!({}));
    assert_eq!(c.call_err("sessions.forget", json!({"id": alive})), -32002);
    assert_eq!(
        c.call_err("sessions.forget", json!({"id": Uuid::new_v4()})),
        -32001
    );
    assert_eq!(c.call_err("sessions.forget", json!({})), -32602);
    assert_eq!(
        c.call("sessions.forget", json!({"id": id})),
        json!({"forgotten": true})
    );
    assert_eq!(c.call_err("sessions.get", json!({"id": id})), -32001);
    let removed = |cl: &Client| {
        cl.notifications
            .iter()
            .any(|n| n["method"] == "session.removed" && n["params"] == json!({"id": id}))
    };
    c.wait_until("session.removed", |c| removed(c));
    other.wait_until("session.removed (autre client)", |c| removed(c));
    assert_eq!(c.call_err("sessions.forget", json!({"id": id})), -32001);

    // Toujours absente après un redémarrage du démon (retirée de la base) ;
    // l'autre session est relue. Les transcripts ne sont jamais supprimés.
    let alive_claude = c.last_session(alive).unwrap()["claude_session_id"]
        .as_str()
        .unwrap()
        .to_owned();
    daemon.signal(nix::sys::signal::Signal::SIGKILL);
    daemon.wait();
    drop(c);
    drop(other);
    let _daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    let ids: Vec<Value> = c.call("sessions.list", json!({}))["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["id"].clone())
        .collect();
    assert!(!ids.contains(&json!(id)), "{ids:?}");
    assert!(ids.contains(&json!(alive)), "{ids:?}");
    let s = c.call("sessions.get", json!({"id": alive}))["session"].clone();
    assert_eq!(s["resumable"], true, "relue arrêtée, transcript présent");
    assert_eq!(
        c.call("sessions.forget", json!({"id": alive})),
        json!({"forgotten": true})
    );
    assert_eq!(transcript_files(&env, &alive_claude).len(), 1);

    // Oubliée : son transcript est masqué de transcripts.list (durablement),
    // visible avec `include_hidden`, et démasquable.
    let entry = |c: &mut Client, params: Value| -> Option<Value> {
        c.call("transcripts.list", params)["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["claude_session_id"] == json!(alive_claude))
            .cloned()
    };
    assert_eq!(entry(&mut c, json!({})), None);
    let e = entry(&mut c, json!({"include_hidden": true})).unwrap();
    assert_eq!(e["hidden"], true);
    // Entrée : cwd absolu, dernière activité, branche.
    assert_eq!(e["cwd"], json!(env.proj));
    assert!(e["last_activity"].is_string(), "{e}");
    assert!(e.get("git_branch").is_some(), "{e}");
    assert_eq!(
        c.call(
            "transcripts.unhide",
            json!({"claude_session_id": alive_claude})
        ),
        json!({"hidden": false})
    );
    assert_eq!(entry(&mut c, json!({})).unwrap()["hidden"], false);
    // Masquer une ancienne session connue seulement par son transcript.
    assert_eq!(
        c.call(
            "transcripts.hide",
            json!({"profile": "default", "claude_session_id": alive_claude})
        ),
        json!({"hidden": true})
    );
    assert_eq!(entry(&mut c, json!({})), None);
    assert_eq!(
        c.call_err("transcripts.hide", json!({"profile": "default"})),
        -32602
    );
    assert_eq!(
        c.call_err(
            "transcripts.hide",
            json!({"profile": "inconnu", "claude_session_id": "x"})
        ),
        -32003
    );
    assert_eq!(
        c.call_err("transcripts.list", json!({"include_hidden": "oui"})),
        -32602
    );
    // Le masquage survit au redémarrage, et ne supprime aucun fichier.
    drop(c);
    drop(_daemon);
    let _daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    assert_eq!(entry(&mut c, json!({})), None);
    assert_eq!(transcript_files(&env, &alive_claude).len(), 1);

    // La limite s'applique après l'exclusion des sessions masquées et de
    // celles que le démon connaît.
    let dir = env.home.join(".claude/projects/-autre");
    std::fs::create_dir_all(&dir).unwrap();
    for i in 0..3 {
        std::fs::write(
            dir.join(format!("00000000-0000-4000-8000-00000000000{i}.jsonl")),
            "{}\n",
        )
        .unwrap();
    }
    let known = launch_idle(&mut c, &env, json!({}));
    let known_claude = c.last_session(known).unwrap()["claude_session_id"]
        .as_str()
        .unwrap()
        .to_owned();
    c.wait_until("transcript", |_| {
        transcript_files(&env, &known_claude).len() == 1
    });
    let ids = |c: &mut Client, params: Value| -> Vec<String> {
        c.call("transcripts.list", params)["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["claude_session_id"].as_str().unwrap().to_owned())
            .collect()
    };
    let got = ids(&mut c, json!({"limit": 3}));
    assert_eq!(got.len(), 3, "{got:?}");
    assert!(
        !got.contains(&known_claude) && !got.contains(&alive_claude),
        "{got:?}"
    );
    let all = ids(
        &mut c,
        json!({"limit": 50, "exclude_known": false, "include_hidden": true}),
    );
    assert!(
        all.contains(&known_claude) && all.contains(&alive_claude),
        "{all:?}"
    );
}

#[test]
fn forget_during_exit_grace_and_resumable_on_get() {
    let env = Env::new();
    let _daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    c.call("hello", json!({}));

    // `resumable` relu à chaque sessions.get (session.updated s'il change).
    let id = launch_idle(&mut c, &env, json!({}));
    let claude_id = c.last_session(id).unwrap()["claude_session_id"]
        .as_str()
        .unwrap()
        .to_owned();
    c.call("sessions.stop", json!({"id": id}));
    c.wait_until("reprenable", |c| {
        c.last_session(id).is_some_and(|s| s["resumable"] == true)
    });
    let files = transcript_files(&env, &claude_id);
    let saved = std::fs::read(&files[0]).unwrap();
    std::fs::remove_file(&files[0]).unwrap();
    let get =
        |c: &mut Client| c.call("sessions.get", json!({"id": id}))["session"]["resumable"].clone();
    assert_eq!(get(&mut c), false);
    c.wait_until("session.updated (plus reprenable)", |c| {
        c.last_session(id).is_some_and(|s| s["resumable"] == false)
    });
    std::fs::write(&files[0], saved).unwrap();
    assert_eq!(get(&mut c), true);

    // Processus tout juste terminé (délai de grâce) : la fin est constatée et
    // la session oubliée, au lieu d'un refus.
    let crashed = launch_idle(&mut c, &env, json!({}));
    c.input(crashed, b"/crash\r");
    std::thread::sleep(Duration::from_millis(150));
    assert_eq!(
        c.call("sessions.forget", json!({"id": crashed})),
        json!({"forgotten": true})
    );
    assert_eq!(c.call_err("sessions.get", json!({"id": crashed})), -32001);
}

#[test]
fn missing_worktree_directory() {
    let env = Env::new();
    let _daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    c.call("hello", json!({}));

    // projects.resolve d'un dossier disparu : rien n'est créé.
    let root = env.proj.parent().unwrap().to_path_buf();
    let gone = root.join("nulle-part/sous");
    let r = c.call("projects.resolve", json!({"path": gone}));
    assert_eq!(r["exists"], false);
    assert_eq!(r["inferred"], false);
    assert_eq!(r["is_git"], false);
    assert_eq!(r["root"], Value::Null);
    assert!(!root.join("nulle-part").exists());
    let r = c.call("projects.resolve", json!({"path": env.proj}));
    assert_eq!(
        (r["exists"].clone(), r["inferred"].clone()),
        (json!(true), json!(false))
    );
    if git_available() {
        let repo = root.join("depot");
        std::fs::create_dir_all(&repo).unwrap();
        assert!(
            Command::new("git")
                .args(["init", "-q"])
                .current_dir(&repo)
                .status()
                .unwrap()
                .success()
        );
        let repo = repo.canonicalize().unwrap();
        for missing in [
            root.join("depot--fonction-x/src"),
            root.join("depot.wt"),
            repo.join(".worktrees/x"),
            repo.join(".claude/worktrees/y/z"),
        ] {
            let r = c.call("projects.resolve", json!({"path": missing}));
            assert_eq!(r["exists"], false, "{missing:?} {r}");
            assert_eq!(r["inferred"], true, "{missing:?} {r}");
            assert_eq!(r["is_git"], true, "{missing:?} {r}");
            assert_eq!(r["root"], json!(repo), "{missing:?} {r}");
            assert_eq!(r["name"], "depot");
            assert!(!missing.exists());
        }
    }

    // Session dont le dossier a disparu (worktree supprimé).
    let wt = env.proj.join("worktree");
    std::fs::create_dir_all(&wt).unwrap();
    let r = c.call("sessions.launch", json!({"cwd": wt}));
    let id: Uuid = r["session"]["id"].as_str().unwrap().parse().unwrap();
    let claude_id = r["session"]["claude_session_id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(r["session"]["resume_blocker"], Value::Null);
    wait_idle(&mut c, id);
    c.call("sessions.stop", json!({"id": id}));
    c.wait_until("reprenable", |c| {
        c.last_session(id)
            .is_some_and(|s| s["resumable"] == true && s["resume_blocker"].is_null())
    });
    std::fs::remove_dir_all(&wt).unwrap();
    let s = c.call("sessions.get", json!({"id": id}))["session"].clone();
    assert_eq!(s["resumable"], false);
    assert_eq!(s["resume_blocker"], "cwd_missing");
    let before = s;
    let launches = env.fake_launches().len();
    let r = c.call_raw("sessions.resume", json!({"id": id}));
    assert_eq!(r["error"]["code"], -32016, "{r}");
    assert_eq!(
        r["error"]["message"],
        format!(
            "Le dossier de la session n'existe plus (worktree supprimé ?) : {}",
            wt.display()
        )
    );
    assert_eq!(c.call("sessions.get", json!({"id": id}))["session"], before);
    assert_eq!(env.fake_launches().len(), launches);
    assert_eq!(
        c.call_err(
            "sessions.resume",
            json!({"claude_session_id": claude_id, "cwd": wt})
        ),
        -32016
    );
    // transcripts.list : `cwd_exists`.
    let list = c.call("transcripts.list", json!({"exclude_known": false}));
    let e = list["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["claude_session_id"] == json!(claude_id))
        .unwrap()
        .clone();
    assert_eq!(e["cwd"], json!(wt));
    assert_eq!(e["cwd_exists"], false);
    // Transcript absent en plus : c'est lui qui bloque (définitif).
    for f in transcript_files(&env, &claude_id) {
        std::fs::remove_file(f).unwrap();
    }
    let s = c.call("sessions.get", json!({"id": id}))["session"].clone();
    assert_eq!(s["resume_blocker"], "transcript_missing");
    // Même ordre pour la reprise : transcript (-32015) avant dossier (-32016).
    assert_eq!(c.call_err("sessions.resume", json!({"id": id})), -32015);
    // Ancienne session connue seulement par son transcript.
    let only = "44444444-4444-4444-8444-444444444444";
    let dir = env.home.join(".claude/projects/-ailleurs");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(format!("{only}.jsonl")), "{}\n").unwrap();
    assert_eq!(
        c.call_err(
            "sessions.resume",
            json!({"claude_session_id": only, "cwd": wt})
        ),
        -32016
    );
    assert_eq!(
        c.call_err(
            "sessions.resume",
            json!({"claude_session_id": "55555555-5555-4555-8555-555555555555", "cwd": wt})
        ),
        -32015
    );
    assert!(!wt.exists(), "rien n'est créé");
    // Session vivante : pas de blocage.
    let alive = launch_idle(&mut c, &env, json!({}));
    assert_eq!(
        c.last_session(alive).unwrap()["resume_blocker"],
        Value::Null
    );
    let list = c.call("transcripts.list", json!({"exclude_known": false}));
    assert!(
        list["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["cwd_exists"] == true)
    );
}

/// Reprise d'une ancienne session dans le dossier où Claude Code a rangé sa
/// conversation (cas réel du 2026-10-21, anonymisé) : les lignes du
/// transcript portent surtout le dossier personnel, mais le transcript est
/// rangé sous le dossier de départ. Un dossier forcé incompatible donne un
/// avertissement, puis un échec expliqué (« No conversation found »).
#[test]
fn resume_in_the_folder_claude_code_filed_the_conversation_under() {
    use devmaestro_core::domain::transcript::project_dir_name;
    let env = Env::new();
    let _daemon = env.start_daemon();
    let mut c = Client::connect(&env);

    let home = env.proj.join("maison");
    let start = home.join("espace de travail/next-level.run");
    let sub = start.join("optimus-mcp");
    std::fs::create_dir_all(&sub).unwrap();
    let cid = "36b9efbf-1dfc-49d3-9414-723d97625117";
    let dir = env
        .home
        .join(".claude/projects")
        .join(project_dir_name(&start));
    std::fs::create_dir_all(&dir).unwrap();
    let mut transcript = String::new();
    for (cwd, n) in [
        (&home, 3),
        (&home.join("espace de travail"), 1),
        (&start, 2),
        (&home, 1),
        (&sub, 2),
        (&home, 3),
    ] {
        for _ in 0..n {
            transcript.push_str(
                &json!({"type": "user", "cwd": cwd, "sessionId": cid,
                        "timestamp": "2026-10-21T08:00:00Z",
                        "message": {"content": "Reprends l'audit"}})
                .to_string(),
            );
            transcript.push('\n');
        }
    }
    std::fs::write(dir.join(format!("{cid}.jsonl")), transcript).unwrap();

    // transcripts.list : le dossier de reprise, pas le premier `cwd` lu.
    let list = c.call("transcripts.list", json!({}));
    let e = list["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["claude_session_id"] == cid)
        .unwrap()
        .clone();
    assert_eq!(e["cwd"], json!(start), "{e}");
    assert_eq!(e["resume_cwd_inferred"], true);
    assert_eq!(e["cwd_exists"], true);

    // Reprise sans `cwd` : dans ce dossier, sans avertissement.
    let r = c.call("sessions.resume", json!({"claude_session_id": cid}));
    assert_eq!(r["warnings"], json!([]), "{r}");
    assert_eq!(r["session"]["cwd"], json!(start));
    let id: Uuid = r["session"]["id"].as_str().unwrap().parse().unwrap();
    wait_idle(&mut c, id);
    let launch = env.fake_launches().last().unwrap().clone();
    assert_eq!(launch["cwd"], json!(start));
    c.call("sessions.stop", json!({"id": id}));
    c.wait_until("arrêtée", |c| {
        c.last_session(id).is_some_and(|s| s["alive"] == false)
    });

    // Dossier forcé incompatible : avertissement, puis échec expliqué.
    let r = c.call("sessions.resume", json!({"id": id, "cwd": home}));
    let warnings = r["warnings"].as_array().unwrap();
    assert!(
        warnings.iter().any(|w| w
            .as_str()
            .unwrap()
            .starts_with("Claude Code ne trouvera pas la conversation depuis ce dossier")),
        "{r}"
    );
    c.wait_until("reprise refusée par Claude Code", |c| {
        c.last_session(id)
            .is_some_and(|s| s["status"]["reason"] == "conversation_not_found")
    });
    let s = c.last_session(id).unwrap();
    assert_eq!(s["status"]["state"], "error");
    assert_eq!(s["last_exit"], json!({"code": 1}));
    let message = s["status"]["message"].as_str().unwrap();
    assert!(message.contains("No conversation found"), "{message}");
    assert!(message.contains(&home.display().to_string()), "{message}");
    let failed: Vec<Value> = c
        .effects(id)
        .into_iter()
        .filter(|e| e["type"] == "resume_failed")
        .collect();
    assert_eq!(failed.len(), 1, "{failed:?}");
    assert_eq!(failed[0]["reason"], "conversation_not_found");
    assert_eq!(failed[0]["message"], json!(message));

    // Reprise suivante sans `cwd` : le dossier de la session ne convient
    // plus, celui du transcript est repris ; l'échec est effacé.
    let r = c.call("sessions.resume", json!({"id": id}));
    assert_eq!(r["warnings"], json!([]), "{r}");
    assert_eq!(r["session"]["cwd"], json!(start));
    assert!(r["session"]["status"].get("message").is_none(), "{r}");
    wait_idle(&mut c, id);
    assert_eq!(env.fake_launches().last().unwrap()["cwd"], json!(start));
}
