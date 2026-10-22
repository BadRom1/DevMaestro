//! v0.3, lot 22a (ADR 0007) : plugins par le socket du démon, avec
//! `DEVMAESTRO_PLUGINS_DIR` sur un dossier temporaire et le plugin factice
//! Python de `common::plugin`. Sautés sans `python3`.

mod common;

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use common::plugin::{no_python, no_systemd, process_alive, write_plugin};
use common::*;
use serde_json::{Value, json};
use uuid::Uuid;

/// Démon avec un dossier de plugins temporaire.
struct Setup {
    env: Env,
    plugins: PathBuf,
}

fn setup(extra: &[(&str, &str)]) -> Option<Setup> {
    if no_python() {
        return None;
    }
    let mut env = Env::new();
    // Sous la racine de l'`Env` : la commande des scopes `devmaestro-plugin-*`
    // la contient, et le filet de `Drop for Env` les retrouve.
    let plugins = env.root.join("plugins");
    std::fs::create_dir_all(&plugins).unwrap();
    env.extra_env.push((
        "DEVMAESTRO_PLUGINS_DIR".into(),
        plugins.display().to_string(),
    ));
    for (k, v) in extra {
        env.extra_env.push(((*k).into(), (*v).into()));
    }
    Some(Setup { env, plugins })
}

fn list(c: &mut Client) -> Value {
    c.call("plugins.list", json!({}))
}

fn plugin(c: &mut Client, name: &str) -> Value {
    list(c)["plugins"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["name"] == name)
        .cloned()
        .unwrap_or_else(|| panic!("plugin {name} absent"))
}

fn fingerprint(c: &mut Client, name: &str) -> String {
    plugin(c, name)["fingerprint"].as_str().unwrap().to_owned()
}

fn accept(c: &mut Client, name: &str) -> String {
    let fp = fingerprint(c, name);
    let r = c.call(
        "plugins.accept",
        json!({"name": name, "expected_fingerprint": fp}),
    );
    assert_eq!(r["plugin"]["acceptance"], "accepted", "{r}");
    fp
}

fn panel_raw(c: &mut Client, name: &str, sid: Uuid, fp: &str) -> Value {
    c.call_raw(
        "plugins.panel",
        json!({"name": name, "session_id": sid, "expected_fingerprint": fp, "locale": "fr"}),
    )
}

fn action_raw(c: &mut Client, name: &str, sid: Uuid, fp: &str, action: &str) -> Value {
    c.call_raw(
        "plugins.action",
        json!({"name": name, "action": action, "session_id": sid,
               "expected_fingerprint": fp, "locale": "en", "args": {"full": true}}),
    )
}

fn code(v: &Value) -> i64 {
    v["error"]["code"]
        .as_i64()
        .unwrap_or_else(|| panic!("erreur attendue : {v}"))
}

/// Contenu d'écho du plugin factice (bloc `markdown` du document).
fn echo(doc: &Value) -> Value {
    serde_json::from_str(doc["blocks"][0]["text"].as_str().unwrap()).unwrap()
}

fn plugins_changed(c: &Client) -> usize {
    c.notifications
        .iter()
        .filter(|n| n["method"] == "plugins.changed")
        .count()
}

fn stop_daemon(mut d: DaemonProc) {
    d.signal(nix::sys::signal::Signal::SIGTERM);
    d.wait();
}

fn git(dir: &Path, args: &[&str]) -> bool {
    Command::new("git")
        .arg("-C")
        .arg(dir)
        .args([
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

#[test]
fn list_accept_panel_action_revoke() {
    let Some(s) = setup(&[]) else {
        return;
    };
    let dir = write_plugin(&s.plugins, "factice", "normal", json!({}));
    // Manifeste invalide (nom ≠ dossier), entrées ignorées.
    write_plugin(&s.plugins, "casse", "normal", json!({"name": "autre"}));
    std::fs::create_dir_all(s.plugins.join(".cache")).unwrap();
    std::fs::write(s.plugins.join("note.txt"), "x").unwrap();
    let daemon = s.env.start_daemon();
    let mut c = Client::connect(&s.env);
    let hello = c.call("hello", json!({}));
    assert_eq!(hello["capabilities"]["plugins"], true);
    let id = session(&mut c, &s.env, json!({"mode": "default"}));

    let l = list(&mut c);
    assert_eq!(l["dir"], json!(s.plugins));
    let names: Vec<&str> = l["plugins"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["casse", "factice"]);
    let casse = &l["plugins"][0];
    assert_eq!(casse["valid"], false);
    assert_eq!(casse["fingerprint"], Value::Null);
    assert!(
        casse["errors"][0]
            .as_str()
            .unwrap()
            .contains("nom du dossier")
    );
    let f = &l["plugins"][1];
    assert_eq!(f["valid"], true, "{f}");
    assert_eq!(f["acceptance"], "none");
    assert_eq!(f["process"]["state"], "stopped");
    assert_eq!(f["label"], json!({"fr": "Factice", "en": "Fake"}));
    assert_eq!(f["tab"]["label"]["en"], "Fake");
    assert_eq!(
        f["command"],
        json!(["python3", "-I", dir.join("fake_plugin.py"), "normal"])
    );
    assert_eq!(f["files"], json!(["fake_plugin.py"]));
    assert!(f.get("config").is_none(), "{f}");
    assert_eq!(
        f["actions"][0],
        json!({"id": "echo", "label": {"fr": "Écho", "en": "Echo"}, "propose": false})
    );
    let fp = f["fingerprint"].as_str().unwrap().to_owned();
    assert_eq!(fp.len(), 64);

    // Pas accepté.
    let r = panel_raw(&mut c, "factice", id, &fp);
    assert_eq!(code(&r), -32031);
    assert_eq!(
        r["error"]["data"],
        json!({"acceptance": "none", "fingerprint": fp})
    );
    // Plugin inconnu, manifeste invalide.
    assert_eq!(code(&panel_raw(&mut c, "absent", id, &fp)), -32030);
    assert_eq!(code(&panel_raw(&mut c, "casse", id, &fp)), -32030);
    // Accord avec une autre empreinte : refusé.
    let r = c.call_raw(
        "plugins.accept",
        json!({"name": "factice", "expected_fingerprint": "0".repeat(64)}),
    );
    assert_eq!(code(&r), -32032);
    assert_eq!(r["error"]["data"]["fingerprint"], json!(fp));

    let before = plugins_changed(&c);
    assert_eq!(accept(&mut c, "factice"), fp);
    c.wait_until("plugins.changed", |c| plugins_changed(c) > before);
    let p = plugin(&mut c, "factice");
    assert_eq!(p["accepted_fingerprint"], json!(fp));
    assert_eq!(p["accepted_permissions"], json!([]));

    // Panneau : sans permission, seulement `session.id`.
    let r = panel_raw(&mut c, "factice", id, &fp);
    let doc = &r["result"]["document"];
    assert_eq!(doc["title"], "Écho", "{r}");
    let e = echo(doc);
    assert_eq!(e["params"]["session"], json!({"id": id}));
    assert_eq!(e["params"]["locale"], "fr");
    assert!(e["params"].get("diff").is_none());
    assert_eq!(e["init"]["api_version"], 1);
    assert_eq!(e["init"]["locale"], "fr");
    assert_eq!(e["init"]["permissions"], json!([]));
    assert_eq!(e["init"]["config"], json!({}));
    assert_eq!(e["init"]["host"]["name"], "devmaestro");
    assert_eq!(plugin(&mut c, "factice")["process"]["state"], "running");
    // Même processus pour la requête suivante.
    let pid = e["pid"].as_u64().unwrap();
    let r = panel_raw(&mut c, "factice", id, &fp);
    assert_eq!(echo(&r["result"]["document"])["pid"], pid);

    // Empreinte attendue différente, session inconnue.
    let r = panel_raw(&mut c, "factice", id, &"a".repeat(64));
    assert_eq!(code(&r), -32032);
    assert_eq!(
        code(&panel_raw(&mut c, "factice", Uuid::new_v4(), &fp)),
        -32001
    );
    // Paramètres invalides.
    let r = c.call_raw(
        "plugins.panel",
        json!({"name": "factice", "session_id": id, "expected_fingerprint": fp, "locale": "de"}),
    );
    assert_eq!(code(&r), -32602);

    // Actions.
    let r = action_raw(&mut c, "factice", id, &fp, "echo");
    let e = echo(&r["result"]["document"]);
    assert_eq!(e["params"]["action"], "echo");
    assert_eq!(e["params"]["args"], json!({"full": true}));
    assert_eq!(e["params"]["locale"], "en");
    assert_eq!(
        code(&action_raw(&mut c, "factice", id, &fp, "nope")),
        -32602
    );
    // Réponse `error` du plugin : -32033, message nettoyé et borné, processus gardé.
    let r = action_raw(&mut c, "factice", id, &fp, "fail");
    assert_eq!(code(&r), -32033);
    assert_eq!(r["error"]["data"]["reason"], "error");
    let msg = r["error"]["message"].as_str().unwrap();
    assert!(!msg.contains('\u{202E}') && !msg.contains('\n'), "{msg}");
    assert!(msg.chars().count() < 600, "{}", msg.len());
    let r = panel_raw(&mut c, "factice", id, &fp);
    assert_eq!(echo(&r["result"]["document"])["pid"], pid);

    // Fichier haché modifié : `changed`, panneau refusé, processus arrêté.
    std::fs::write(
        dir.join("fake_plugin.py"),
        format!("{}\n# modifié\n", common::plugin::FAKE_PLUGIN_PY),
    )
    .unwrap();
    let p = plugin(&mut c, "factice");
    assert_eq!(p["acceptance"], "changed");
    let fp2 = p["fingerprint"].as_str().unwrap().to_owned();
    assert_ne!(fp2, fp);
    let r = panel_raw(&mut c, "factice", id, &fp2);
    assert_eq!(code(&r), -32031);
    assert_eq!(
        r["error"]["data"],
        json!({"acceptance": "changed", "fingerprint": fp2})
    );
    let start = Instant::now();
    while process_alive(pid as u32) {
        assert!(start.elapsed() < TIMEOUT, "ancien processus encore vivant");
        std::thread::sleep(Duration::from_millis(20));
    }
    // Nouvel accord : fonctionne, nouveau processus.
    assert_eq!(accept(&mut c, "factice"), fp2);
    let r = panel_raw(&mut c, "factice", id, &fp2);
    let pid2 = echo(&r["result"]["document"])["pid"].as_u64().unwrap();
    assert_ne!(pid2, pid);

    // Révocation : processus arrêté, panneau refusé.
    let r = c.call("plugins.revoke", json!({"name": "factice"}));
    assert_eq!(r["plugin"]["acceptance"], "none");
    assert_eq!(r["plugin"]["process"]["state"], "stopped");
    assert!(!process_alive(pid2 as u32));
    assert_eq!(code(&panel_raw(&mut c, "factice", id, &fp2)), -32031);
    let r = c.call("plugins.revoke", json!({"name": "inconnu"}));
    assert_eq!(r["plugin"], Value::Null);
    // Le dossier des plugins n'a pas été écrit par le démon.
    assert!(!s.env.config.join("devmaestro/plugins").exists());
    stop_daemon(daemon);
}

#[test]
fn environment_allowlist_and_permissions() {
    let Some(s) = setup(&[
        ("LANG", "C.UTF-8"),
        ("LC_ALL", "C.UTF-8"),
        ("DEVMAESTRO_X", "1"),
        ("ANTHROPIC_API_KEY", "sk-secret"),
        ("GH_TOKEN", "ghp_secret"),
        ("ORCH_TOKEN", "jeton"),
        ("FOO", "bar"),
    ]) else {
        return;
    };
    let git_ok = git_available();
    if git_ok {
        let repo = &s.env.proj;
        assert!(git(repo, &["init", "-q", "-b", "main"]));
        std::fs::write(repo.join("a.txt"), "un\n").unwrap();
        assert!(git(repo, &["add", "."]));
        assert!(git(repo, &["commit", "-q", "-m", "base"]));
        std::fs::write(repo.join("a.txt"), "un\ndeux\n").unwrap();
    }
    write_plugin(
        &s.plugins,
        "lecteur",
        "normal",
        json!({
            "permissions": ["diff.read", "worktree.read", "claude.propose"],
            "contributes": {
                "session_tab": {"label": {"fr": "L", "en": "L"}},
                "actions": [
                    {"id": "send", "label": {"fr": "Envoyer", "en": "Send"}, "propose": true},
                    {"id": "echo", "label": {"fr": "Écho", "en": "Echo"}}
                ]
            },
            "config": {"results": {
                "send": {"propose": {"content": "# Impact{RLO}\n- a"}},
                "echo": {"propose": {"content": "interdit"}}
            }}
        }),
    );
    write_plugin(
        &s.plugins,
        "sans-droit",
        "normal",
        json!({
            "permissions": [],
            "config": {"results": {"echo": {"propose": {"content": "x"}}}}
        }),
    );
    let daemon = s.env.start_daemon();
    let mut c = Client::connect(&s.env);
    c.call("hello", json!({}));
    let id = session(&mut c, &s.env, json!({"mode": "default"}));
    // `config` du manifeste, tel que haché, dans `plugins.list`.
    assert_eq!(
        plugin(&mut c, "lecteur")["config"]["results"]["send"]["propose"]["content"],
        "# Impact{RLO}\n- a"
    );
    let fp = accept(&mut c, "lecteur");
    let r = panel_raw(&mut c, "lecteur", id, &fp);
    let e = echo(&r["result"]["document"]);
    // Environnement : liste d'autorisation seulement.
    let envp = e["env"].as_object().unwrap();
    for absent in [
        "DEVMAESTRO_X",
        "ANTHROPIC_API_KEY",
        "GH_TOKEN",
        "ORCH_TOKEN",
        "FOO",
        "CLAUDE_CONFIG_DIR",
        "XDG_CONFIG_HOME",
    ] {
        assert!(!envp.contains_key(absent), "{absent} transmis : {envp:?}");
    }
    for present in ["PATH", "HOME", "LANG", "LC_ALL"] {
        assert!(envp.contains_key(present), "{present} absent : {envp:?}");
    }
    // `INVOCATION_ID` : posée par `systemd-run` dans un scope (identifiant
    // de l'unité, sans secret).
    assert!(
        envp.keys().all(|k| [
            "PATH",
            "HOME",
            "LANG",
            "XDG_RUNTIME_DIR",
            "TERM",
            "INVOCATION_ID"
        ]
        .contains(&k.as_str())
            || k.starts_with("LC_")),
        "{envp:?}"
    );
    // Permissions accordées : cwd, worktree, diff.
    let session = &e["params"]["session"];
    assert_eq!(session["id"], json!(id));
    assert_eq!(session["cwd"], json!(s.env.proj));
    if git_ok {
        assert_eq!(session["worktree_root"], json!(s.env.proj));
        assert_eq!(session["branch"], "main");
        let diff = &e["params"]["diff"];
        assert_eq!(diff["files"][0]["path"], "a.txt", "{diff}");
        assert_eq!(diff["base"]["sha"].as_str().unwrap().len(), 40);
        assert_eq!(diff["truncated"], false);
        assert!(diff.get("skipped_non_utf8").is_none());
    }
    // `propose` : permis seulement pour l'action `propose: true`.
    let r = action_raw(&mut c, "lecteur", id, &fp, "send");
    assert_eq!(
        r["result"],
        json!({"propose": {"content": "# Impact\n- a"}}),
        "{r}"
    );
    let r = action_raw(&mut c, "lecteur", id, &fp, "echo");
    assert_eq!(code(&r), -32034);
    assert!(
        r["error"]["data"]["problem"]
            .as_str()
            .unwrap()
            .contains("claude.propose")
    );

    // Sans permission : ni cwd ni diff, et pas de `propose`.
    let fp2 = accept(&mut c, "sans-droit");
    let r = panel_raw(&mut c, "sans-droit", id, &fp2);
    let e = echo(&r["result"]["document"]);
    assert_eq!(e["params"]["session"], json!({"id": id}));
    assert!(e["params"].get("diff").is_none());
    assert_eq!(
        code(&action_raw(&mut c, "sans-droit", id, &fp2, "echo")),
        -32034
    );
    stop_daemon(daemon);
}

#[test]
fn invalid_documents_are_rejected_and_text_cleaned() {
    let Some(s) = setup(&[]) else {
        return;
    };
    write_plugin(
        &s.plugins,
        "html",
        "normal",
        json!({"config": {"document": {"blocks": [{"type": "html", "text": "<script>"}]}}}),
    );
    write_plugin(
        &s.plugins,
        "rafale",
        "normal",
        json!({"config": {"document": {"refresh_ms": 10, "blocks": [{"type": "markdown", "text": "x"}]}}}),
    );
    write_plugin(
        &s.plugins,
        "action-inconnue",
        "normal",
        json!({"config": {"document": {"blocks": [{"type": "actions", "items": [{"id": "rm", "label": "x"}]}]}}}),
    );
    write_plugin(
        &s.plugins,
        "propre",
        "normal",
        json!({"config": {"document": {"title": "Ti{RLO}tre\nsuite", "extra": 1,
            "blocks": [{"type": "kv", "items": [{"key": "a{ZWSP}b", "value": "v", "x": 2}]}]}}}),
    );
    let daemon = s.env.start_daemon();
    let mut c = Client::connect(&s.env);
    c.call("hello", json!({}));
    let id = session(&mut c, &s.env, json!({"mode": "default"}));
    for (name, needle) in [
        ("html", "inconnu"),
        ("rafale", "refresh_ms"),
        ("action-inconnue", "non déclarée"),
    ] {
        let fp = accept(&mut c, name);
        let r = panel_raw(&mut c, name, id, &fp);
        assert_eq!(code(&r), -32034, "{name} : {r}");
        let problem = r["error"]["data"]["problem"].as_str().unwrap();
        assert!(problem.contains(needle), "{name} : {problem}");
        // Un document invalide n'arrête pas le plugin.
        assert_eq!(plugin(&mut c, name)["process"]["state"], "running");
    }
    let fp = accept(&mut c, "propre");
    let doc = c.call(
        "plugins.panel",
        json!({"name": "propre", "session_id": id, "expected_fingerprint": fp, "locale": "fr"}),
    )["document"]
        .clone();
    assert_eq!(
        doc,
        json!({"title": "Titre suite", "blocks": [{"type": "kv", "items": [{"key": "ab", "value": "v"}]}]})
    );
    stop_daemon(daemon);
}

#[test]
fn failures_timeouts_and_idle_stop() {
    let Some(s) = setup(&[
        ("DEVMAESTRO_PLUGIN_TIMEOUT_MS", "4000"),
        ("DEVMAESTRO_PLUGIN_IDLE_MS", "400"),
    ]) else {
        return;
    };
    write_plugin(&s.plugins, "lent", "sleep", json!({}));
    write_plugin(&s.plugins, "plante", "crash", json!({}));
    write_plugin(&s.plugins, "bavard", "stderr_spam", json!({}));
    write_plugin(&s.plugins, "mauvais-init", "badinit", json!({}));
    write_plugin(&s.plugins, "factice", "normal", json!({}));
    // Programme `./…` absent du PATH, pas exécutable : échec de lancement.
    let d = write_plugin(&s.plugins, "local", "normal", json!({}));
    let mut m: Value =
        serde_json::from_slice(&std::fs::read(d.join("plugin.json")).unwrap()).unwrap();
    m["command"] = json!(["./fake_plugin.py", "normal"]);
    std::fs::write(d.join("plugin.json"), m.to_string()).unwrap();
    let daemon = s.env.start_daemon();
    let mut c = Client::connect(&s.env);
    c.call("hello", json!({}));
    let id = session(&mut c, &s.env, json!({"mode": "default"}));

    let fp = accept(&mut c, "lent");
    let r = panel_raw(&mut c, "lent", id, &fp);
    assert_eq!(code(&r), -32033);
    assert_eq!(r["error"]["data"]["reason"], "timeout");
    let p = plugin(&mut c, "lent");
    assert_eq!(p["process"]["state"], "failed");
    assert_eq!(p["process"]["reason"], "timeout");
    // Relancé à la demande suivante seulement (et de nouveau en échec).
    let r = panel_raw(&mut c, "lent", id, &fp);
    assert_eq!(r["error"]["data"]["reason"], "timeout");

    let fp = accept(&mut c, "plante");
    let r = panel_raw(&mut c, "plante", id, &fp);
    assert_eq!(code(&r), -32033);
    assert_eq!(r["error"]["data"]["reason"], "closed");
    assert_eq!(plugin(&mut c, "plante")["process"]["reason"], "closed");

    let fp = accept(&mut c, "bavard");
    let r = c.call(
        "plugins.panel",
        json!({"name": "bavard", "session_id": id, "expected_fingerprint": fp, "locale": "fr"}),
    );
    assert!(r["document"].is_object());

    let fp = accept(&mut c, "mauvais-init");
    let r = panel_raw(&mut c, "mauvais-init", id, &fp);
    assert_eq!(r["error"]["data"]["reason"], "protocol", "{r}");

    let fp = accept(&mut c, "local");
    let r = panel_raw(&mut c, "local", id, &fp);
    assert_eq!(r["error"]["data"]["reason"], "launch", "{r}");
    assert_eq!(plugin(&mut c, "local")["process"]["reason"], "launch");

    // Arrêt après le délai sans requête.
    let fp = accept(&mut c, "factice");
    let r = panel_raw(&mut c, "factice", id, &fp);
    let pid = echo(&r["result"]["document"])["pid"].as_u64().unwrap() as u32;
    let start = Instant::now();
    while plugin(&mut c, "factice")["process"]["state"] != "stopped" {
        assert!(
            start.elapsed() < TIMEOUT,
            "plugin pas arrêté après le délai"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    while process_alive(pid) {
        assert!(
            start.elapsed() < TIMEOUT,
            "processus encore vivant après l'arrêt"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    stop_daemon(daemon);
}

#[test]
fn plugins_stop_with_the_daemon() {
    let Some(s) = setup(&[]) else {
        return;
    };
    write_plugin(&s.plugins, "factice", "normal", json!({}));
    let daemon = s.env.start_daemon();
    let mut c = Client::connect(&s.env);
    c.call("hello", json!({}));
    let id = session(&mut c, &s.env, json!({"mode": "default"}));
    let fp = accept(&mut c, "factice");
    let r = panel_raw(&mut c, "factice", id, &fp);
    let pid = echo(&r["result"]["document"])["pid"].as_u64().unwrap() as u32;
    assert!(process_alive(pid));
    stop_daemon(daemon);
    assert!(!process_alive(pid));
}

#[test]
fn control_socket_is_refused_to_a_plugin() {
    let Some(s) = setup(&[]) else {
        return;
    };
    write_plugin(
        &s.plugins,
        "sonde",
        "ctl",
        json!({"config": {"socket": s.env.socket()}}),
    );
    let daemon = s.env.start_daemon();
    let mut c = Client::connect(&s.env);
    c.call("hello", json!({}));
    let id = session(&mut c, &s.env, json!({"mode": "default"}));
    let fp = accept(&mut c, "sonde");
    let r = c.call(
        "plugins.panel",
        json!({"name": "sonde", "session_id": id, "expected_fingerprint": fp, "locale": "fr"}),
    );
    assert_eq!(r["document"]["blocks"][0]["text"], "refusé", "{r}");
    let log = daemon_log(&s.env);
    if log.contains("lancées directement") {
        common::plugin::skip(
            "vérification du refus par le scope (pas de systemd utilisateur) ; refus par l'ascendance seulement",
        );
    } else {
        assert!(log.contains("scope devmaestro-plugin-sonde-"), "{log}");
        wait_log(
            &s.env,
            "scope systemd d'une session, d'un runner ou d'un plugin",
        );
    }
    // Le client du test, lui, est servi.
    c.call("sessions.list", json!({}));
    stop_daemon(daemon);
}

#[test]
fn control_socket_is_refused_to_any_plugin_scope() {
    // Processus quelconque dans un scope `devmaestro-plugin-*`, hors de
    // l'ascendance du démon : seul le cgroup le fait refuser.
    if no_systemd("socket refusé à un scope plugin") || no_python() {
        return;
    }
    let env = Env::new();
    let daemon = env.start_daemon();
    let probe = r#"
import socket, sys
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.connect(sys.argv[1])
s.settimeout(2.0)
try:
    print("refusé" if s.recv(1) == b"" else "accepté")
except socket.timeout:
    print("accepté")
"#;
    let run = |unit: Option<&str>| -> String {
        let mut cmd = match unit {
            Some(u) => {
                let mut c = Command::new("systemd-run");
                c.args(["--user", "--scope", "--quiet", "--collect"])
                    .arg(format!("--unit={u}"))
                    .args(["--", "python3"]);
                c
            }
            None => Command::new("python3"),
        };
        let out = cmd
            .args(["-I", "-c", probe])
            .arg(env.socket())
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_owned()
    };
    let unit = format!(
        "devmaestro-plugin-sonde-{}.scope",
        &Uuid::new_v4().simple().to_string()[..8]
    );
    assert_eq!(run(Some(&unit)), "refusé");
    assert_eq!(run(None), "accepté");
    stop_daemon(daemon);
}

/// Plugin factice lent à s'initialiser (2 s), qui écrit son pid dans `pidfile`.
fn slow_plugin(plugins: &Path, name: &str, pidfile: &Path) {
    write_plugin(
        plugins,
        name,
        "slowinit",
        json!({"command": ["python3", "-I", plugins.join(name).join("fake_plugin.py"), "slowinit", pidfile]}),
    );
}

fn wait_pid(pidfile: &Path) -> u32 {
    let start = Instant::now();
    loop {
        if let Some(pid) = std::fs::read_to_string(pidfile)
            .ok()
            .and_then(|s| s.trim().parse().ok())
        {
            return pid;
        }
        assert!(start.elapsed() < TIMEOUT, "pid du plugin absent");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn revocation_during_launch_stops_the_plugin_at_once() {
    let Some(s) = setup(&[]) else {
        return;
    };
    let pidfile = s.plugins.join("lent.pid");
    slow_plugin(&s.plugins, "lent", &pidfile);
    let daemon = s.env.start_daemon();
    let mut c = Client::connect(&s.env);
    c.call("hello", json!({}));
    let id = session(&mut c, &s.env, json!({"mode": "default"}));
    let fp = accept(&mut c, "lent");
    // Panneau demandé, plugin lancé mais pas encore initialisé : révocation
    // par une autre connexion.
    let req = c.send_request(
        "plugins.panel",
        json!({"name": "lent", "session_id": id, "expected_fingerprint": fp, "locale": "fr"}),
    );
    let pid = wait_pid(&pidfile);
    let mut other = Client::connect(&s.env);
    other.call("hello", json!({}));
    let r = other.call("plugins.revoke", json!({"name": "lent"}));
    assert_eq!(r["plugin"]["acceptance"], "none");
    let r = c.wait_response(req);
    assert!(r.get("error").is_some(), "{r}");
    assert!(!process_alive(pid), "plugin révoqué encore vivant");
    // Arrêt demandé : ni « en échec », ni processus relancé.
    let p = plugin(&mut c, "lent");
    assert_eq!(p["process"]["state"], "stopped", "{p}");
    assert_eq!(code(&panel_raw(&mut c, "lent", id, &fp)), -32031);
    stop_daemon(daemon);
}

#[test]
fn daemon_shutdown_during_launch_leaves_no_plugin() {
    let Some(s) = setup(&[]) else {
        return;
    };
    let pidfile = s.plugins.join("lent.pid");
    slow_plugin(&s.plugins, "lent", &pidfile);
    let daemon = s.env.start_daemon();
    let mut c = Client::connect(&s.env);
    c.call("hello", json!({}));
    let id = session(&mut c, &s.env, json!({"mode": "default"}));
    let fp = accept(&mut c, "lent");
    c.send_request(
        "plugins.panel",
        json!({"name": "lent", "session_id": id, "expected_fingerprint": fp, "locale": "fr"}),
    );
    let pid = wait_pid(&pidfile);
    assert!(process_alive(pid));
    stop_daemon(daemon);
    let start = Instant::now();
    while process_alive(pid) {
        assert!(
            start.elapsed() < TIMEOUT,
            "plugin {pid} resté après l'arrêt du démon"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}
