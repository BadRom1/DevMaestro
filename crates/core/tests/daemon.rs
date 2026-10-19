//! Test d'intégration du démon avec un faux `claude`
//! (`tests/support/fake_claude.rs`) : lancement, événements et statuts,
//! écran et entrées, redimensionnement, reconnexion d'un client, arrêt,
//! reprise, relecture de la base après un plantage, arrêt propre.
//!
//! Aucun vrai `claude`, aucun réseau : dossiers XDG et `HOME` temporaires.

use std::collections::HashMap;
use std::io::Write;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use devmaestro_core::protocol::{Frame, read_frame, request, write_frame};
use serde_json::{Value, json};
use uuid::Uuid;

const ORCHD: &str = env!("CARGO_BIN_EXE_orchd");
const FAKE: &str = env!("CARGO_BIN_EXE_devmaestro-fake-claude");
const TIMEOUT: Duration = Duration::from_secs(10);

/// Dossiers temporaires d'un test.
struct Env {
    _root: tempfile::TempDir,
    // Le socket doit tenir dans sun_path (108 octets) : dossier court dans /tmp.
    _run: tempfile::TempDir,
    home: PathBuf,
    run: PathBuf,
    data: PathBuf,
    state: PathBuf,
    proj: PathBuf,
    fake_log: PathBuf,
    claude_bin: PathBuf,
}

impl Env {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let run = tempfile::Builder::new()
            .prefix("dm")
            .tempdir_in("/tmp")
            .unwrap();
        let r = root.path().canonicalize().unwrap();
        let home = r.join("home");
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        std::fs::write(home.join(".claude/settings.json"), "{}").unwrap();
        // Profil « work » avec sa propre statusline, pour vérifier le chaînage.
        std::fs::create_dir_all(home.join(".claude-work/projects")).unwrap();
        std::fs::write(
            home.join(".claude-work/settings.json"),
            r#"{"statusLine":{"type":"command","command":"echo statusline-utilisateur-work"}}"#,
        )
        .unwrap();
        let proj = r.join("projet");
        std::fs::create_dir_all(&proj).unwrap();
        Self {
            home,
            run: run.path().to_path_buf(),
            data: r.join("data"),
            state: r.join("state"),
            fake_log: r.join("fake-claude.log"),
            claude_bin: PathBuf::from(FAKE),
            proj,
            _root: root,
            _run: run,
        }
    }

    fn socket(&self) -> PathBuf {
        self.run.join("devmaestro/orchd.sock")
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut c = Command::new(ORCHD);
        c.args(args)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("HOME", &self.home)
            .env("XDG_RUNTIME_DIR", &self.run)
            .env("XDG_DATA_HOME", &self.data)
            .env("XDG_STATE_HOME", &self.state)
            .env("DEVMAESTRO_CLAUDE_BIN", &self.claude_bin)
            .env("FAKE_CLAUDE_LOG", &self.fake_log)
            // Doit être retiré pour le profil par défaut.
            .env("CLAUDE_CONFIG_DIR", "/ne/doit/pas/arriver");
        c
    }

    fn start_daemon(&self) -> DaemonProc {
        let child = self
            .command(&["daemon"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let start = Instant::now();
        while UnixStream::connect(self.socket()).is_err() {
            assert!(start.elapsed() < TIMEOUT, "le démon ne démarre pas");
            std::thread::sleep(Duration::from_millis(20));
        }
        DaemonProc(child)
    }

    fn fake_launches(&self) -> Vec<Value> {
        std::fs::read_to_string(&self.fake_log)
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }
}

/// Démon lancé par le test, tué s'il reste à la fin (même sur panique).
struct DaemonProc(Child);

impl DaemonProc {
    fn signal(&self, sig: nix::sys::signal::Signal) {
        nix::sys::signal::kill(nix::unistd::Pid::from_raw(self.0.id() as i32), sig).unwrap();
    }

    fn wait(&mut self) -> std::process::ExitStatus {
        let start = Instant::now();
        loop {
            if let Some(s) = self.0.try_wait().unwrap() {
                return s;
            }
            assert!(start.elapsed() < TIMEOUT, "le démon ne s'arrête pas");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

impl Drop for DaemonProc {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

/// Client de test : lit les trames dans un fil, garde notifications et sorties.
struct Client {
    stream: UnixStream,
    rx: mpsc::Receiver<Frame>,
    next_id: u64,
    notifications: Vec<Value>,
    pty: HashMap<Uuid, Vec<u8>>,
    responses: HashMap<u64, Value>,
}

impl Client {
    fn connect(env: &Env) -> Self {
        let stream = UnixStream::connect(env.socket()).unwrap();
        let mut reader = stream.try_clone().unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            while let Ok(Some(frame)) = read_frame(&mut reader) {
                if tx.send(frame).is_err() {
                    break;
                }
            }
        });
        Self {
            stream,
            rx,
            next_id: 1,
            notifications: Vec::new(),
            pty: HashMap::new(),
            responses: HashMap::new(),
        }
    }

    fn pump(&mut self, wait: Duration) -> bool {
        let frame = match self.rx.recv_timeout(wait) {
            Ok(f) => f,
            Err(_) => return false,
        };
        match frame {
            Frame::Rpc(bytes) => {
                let v: Value = serde_json::from_slice(&bytes).unwrap();
                if let Some(id) = v.get("id").and_then(Value::as_u64) {
                    self.responses.insert(id, v);
                } else {
                    self.notifications.push(v);
                }
            }
            Frame::PtyOutput { session, data } => {
                self.pty.entry(session).or_default().extend(data);
            }
            other => panic!("trame inattendue : {other:?}"),
        }
        true
    }

    fn call_raw(&mut self, method: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        write_frame(&mut self.stream, &Frame::rpc(&request(id, method, params))).unwrap();
        let start = Instant::now();
        loop {
            if let Some(v) = self.responses.remove(&id) {
                return v;
            }
            assert!(start.elapsed() < TIMEOUT, "pas de réponse à {method}");
            self.pump(Duration::from_millis(50));
        }
    }

    fn call(&mut self, method: &str, params: Value) -> Value {
        let v = self.call_raw(method, params);
        assert!(v.get("error").is_none(), "{method} : {v}");
        v["result"].clone()
    }

    fn input(&mut self, id: Uuid, data: &[u8]) {
        write_frame(
            &mut self.stream,
            &Frame::PtyInput {
                session: id,
                data: data.to_vec(),
            },
        )
        .unwrap();
    }

    /// Attend qu'une condition sur l'état du client soit vraie.
    fn wait_until(&mut self, what: &str, mut cond: impl FnMut(&Self) -> bool) {
        let start = Instant::now();
        while !cond(self) {
            assert!(
                start.elapsed() < TIMEOUT,
                "délai dépassé : {what}\nstatuts vus : {:?}",
                self.notifications
                    .iter()
                    .filter(|n| n["method"] == "session.updated")
                    .map(|n| status_label(&n["params"]["session"]))
                    .collect::<Vec<_>>()
            );
            self.pump(Duration::from_millis(20));
        }
    }

    fn output_text(&self, id: Uuid) -> String {
        String::from_utf8_lossy(self.pty.get(&id).map_or(&[][..], |v| v)).into_owned()
    }

    /// Statuts successifs de la session vus dans `session.updated`, sans répétition.
    fn statuses(&self, id: Uuid) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for n in &self.notifications {
            if n["method"] == "session.updated" && n["params"]["session"]["id"] == json!(id) {
                let s = status_label(&n["params"]["session"]);
                if out.last() != Some(&s) {
                    out.push(s);
                }
            }
        }
        out
    }

    fn last_session(&self, id: Uuid) -> Option<Value> {
        self.notifications
            .iter()
            .rev()
            .find(|n| n["method"] == "session.updated" && n["params"]["session"]["id"] == json!(id))
            .map(|n| n["params"]["session"].clone())
    }

    fn effects(&self, id: Uuid) -> Vec<Value> {
        self.notifications
            .iter()
            .filter(|n| n["method"] == "session.effect" && n["params"]["id"] == json!(id))
            .map(|n| n["params"]["effect"].clone())
            .collect()
    }
}

fn status_label(session: &Value) -> String {
    let st = &session["status"];
    match (
        st["state"].as_str(),
        st["wait"].as_str(),
        st["reason"].as_str(),
    ) {
        (Some(s), Some(w), _) => format!("{s}:{w}"),
        (Some("stopped"), _, Some(r)) => format!("stopped:{r}"),
        (Some(s), _, _) => s.to_owned(),
        _ => "?".into(),
    }
}

/// `expected` apparaît-il, dans l'ordre, dans `seen` ?
fn is_subsequence(seen: &[String], expected: &[&str]) -> bool {
    let mut it = seen.iter();
    expected.iter().all(|e| it.any(|s| s == e))
}

fn git_available() -> bool {
    Command::new("git")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

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
    let socket = env.socket();
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

/// Lance une session et attend qu'elle soit inactive (fin du premier tour).
fn launch_idle(c: &mut Client, env: &Env, params: Value) -> Uuid {
    let mut p = json!({"cwd": env.proj, "cols": 80, "rows": 24});
    for (k, v) in params.as_object().unwrap() {
        p[k] = v.clone();
    }
    let r = c.call("sessions.launch", p);
    let id: Uuid = r["session"]["id"].as_str().unwrap().parse().unwrap();
    c.wait_until("session inactive", |c| {
        c.last_session(id)
            .is_some_and(|s| status_label(&s) == "idle")
    });
    id
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
        (json!({"id": id, "cwd": "/nulle/part"}), -32602),
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
