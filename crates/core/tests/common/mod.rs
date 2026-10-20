//! Outils partagés des tests d'intégration du démon : dossiers temporaires,
//! démon lancé par le test, client du socket de contrôle.

#![allow(dead_code)]

use std::collections::HashMap;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use devmaestro_core::protocol::{Frame, read_frame, request, write_frame};
use serde_json::{Value, json};
use uuid::Uuid;

pub const ORCHD: &str = env!("CARGO_BIN_EXE_orchd");
pub const FAKE: &str = env!("CARGO_BIN_EXE_devmaestro-fake-claude");
pub const TIMEOUT: Duration = Duration::from_secs(10);

/// Marqueurs de session Claude Code posés dans l'environnement du démon des
/// tests (jamais transmis à `claude`).
pub const INHERITED_CLAUDE_MARKERS: &[(&str, &str)] = &[
    ("CLAUDECODE", "1"),
    ("CLAUDE_CODE_ENTRYPOINT", "cli"),
    ("CLAUDE_CODE_CHILD_SESSION", "1"),
    ("CLAUDE_CODE_SSE_PORT", "12345"),
    (
        "CLAUDE_CODE_SESSION_ID",
        "00000000-0000-4000-8000-0000000000aa",
    ),
    ("CLAUDE_CODE_SESSION_ATTENDED", "1"),
    ("CLAUDE_CODE_PARENT_SESSION_ID", "parent"),
    ("CLAUDE_CODE_EXECPATH", "/usr/bin/claude"),
    (
        "CLAUDE_CODE_MESSAGING_TOKEN",
        "secret-de-la-session-parente",
    ),
    ("CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH", "1"),
    ("CLAUDE_PID", "1"),
    ("AI_AGENT", "claude-code"),
];

/// Réglages Claude Code de l'utilisateur hérités par le démon : gardés.
pub const INHERITED_CLAUDE_SETTINGS: &[(&str, &str)] = &[
    ("CLAUDE_CODE_MAX_OUTPUT_TOKENS", "1234"),
    ("CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS", "1500"),
];

/// Dossiers temporaires d'un test.
pub struct Env {
    _root: tempfile::TempDir,
    // Le socket doit tenir dans sun_path (108 octets) : dossier court dans /tmp.
    _run: tempfile::TempDir,
    pub home: PathBuf,
    pub run: PathBuf,
    pub data: PathBuf,
    pub state: PathBuf,
    pub proj: PathBuf,
    pub fake_log: PathBuf,
    pub claude_bin: PathBuf,
    /// `$XDG_CONFIG_HOME` (réglages du démon : `devmaestro/config.toml`).
    pub config: PathBuf,
    /// `DEVMAESTRO_PERMISSION_TIMEOUT_SECS` du démon, si posé.
    pub permission_timeout: Option<u64>,
    /// Scopes systemd autorisés (`DEVMAESTRO_SYSTEMD_SCOPE`, essayé par
    /// défaut ; sans bus utilisateur, le démon lance directement).
    pub systemd_scope: bool,
}

impl Env {
    pub fn new() -> Self {
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
            config: r.join("config"),
            permission_timeout: None,
            systemd_scope: true,
            proj,
            _root: root,
            _run: run,
        }
    }

    pub fn socket(&self) -> PathBuf {
        self.run.join("devmaestro/orchd.sock")
    }

    pub fn relay_socket(&self) -> PathBuf {
        self.run.join("devmaestro/relay.sock")
    }

    pub fn command(&self, args: &[&str]) -> Command {
        let mut c = Command::new(ORCHD);
        c.args(args)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("HOME", &self.home)
            .env("XDG_RUNTIME_DIR", &self.run)
            .env("XDG_DATA_HOME", &self.data)
            .env("XDG_STATE_HOME", &self.state)
            .env("XDG_CONFIG_HOME", &self.config)
            // Doit être retirée de l'environnement de claude.
            .env("ORCH_PARASITE", "1")
            .env("DEVMAESTRO_CLAUDE_BIN", &self.claude_bin)
            .env("FAKE_CLAUDE_LOG", &self.fake_log)
            // Doit être retiré pour le profil par défaut.
            .env("CLAUDE_CONFIG_DIR", "/ne/doit/pas/arriver");
        // Démon lancé depuis une session Claude Code : ses marqueurs de
        // session doivent être retirés, ses réglages gardés.
        for (k, v) in INHERITED_CLAUDE_MARKERS {
            c.env(k, v);
        }
        for (k, v) in INHERITED_CLAUDE_SETTINGS {
            c.env(k, v);
        }
        // Bus du gestionnaire systemd utilisateur (XDG_RUNTIME_DIR est
        // temporaire : sans cette adresse, systemd-run ne le trouverait pas).
        if let Some(bus) = std::env::var_os("DBUS_SESSION_BUS_ADDRESS") {
            c.env("DBUS_SESSION_BUS_ADDRESS", bus);
        }
        if let Some(dir) = std::env::var_os("XDG_RUNTIME_DIR") {
            c.env("DEVMAESTRO_SYSTEMD_RUNTIME_DIR", dir);
        }
        if !self.systemd_scope {
            c.env("DEVMAESTRO_SYSTEMD_SCOPE", "off");
        }
        if let Some(t) = self.permission_timeout {
            c.env("DEVMAESTRO_PERMISSION_TIMEOUT_SECS", t.to_string());
        }
        c
    }

    /// Écrit les réglages du démon (`config.toml`).
    pub fn write_config(&self, text: &str) {
        let dir = self.config.join("devmaestro");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("config.toml"), text).unwrap();
    }

    pub fn start_daemon(&self) -> DaemonProc {
        let child = self
            .command(&["daemon"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let start = Instant::now();
        while UnixStream::connect(self.socket()).is_err()
            || UnixStream::connect(self.relay_socket()).is_err()
        {
            assert!(start.elapsed() < TIMEOUT, "le démon ne démarre pas");
            std::thread::sleep(Duration::from_millis(20));
        }
        DaemonProc(child)
    }

    pub fn fake_launches(&self) -> Vec<Value> {
        std::fs::read_to_string(&self.fake_log)
            .unwrap_or_default()
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .filter(|l| l.get("args").is_some())
            .collect()
    }

    /// Lignes du journal du faux claude autres que les lancements.
    pub fn fake_events(&self, key: &str) -> Vec<Value> {
        std::fs::read_to_string(&self.fake_log)
            .unwrap_or_default()
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .filter(|l| l.get(key).is_some())
            .collect()
    }
}

/// Démon lancé par le test, tué s'il reste à la fin (même sur panique).
pub struct DaemonProc(pub Child);

impl DaemonProc {
    pub fn signal(&self, sig: nix::sys::signal::Signal) {
        nix::sys::signal::kill(nix::unistd::Pid::from_raw(self.0.id() as i32), sig).unwrap();
    }

    pub fn wait(&mut self) -> std::process::ExitStatus {
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
pub struct Client {
    pub stream: UnixStream,
    pub rx: mpsc::Receiver<Frame>,
    pub next_id: u64,
    pub notifications: Vec<Value>,
    pub pty: HashMap<Uuid, Vec<u8>>,
    pub responses: HashMap<u64, Value>,
}

impl Client {
    pub fn connect(env: &Env) -> Self {
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

    pub fn pump(&mut self, wait: Duration) -> bool {
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

    /// Envoie une requête sans attendre sa réponse ; renvoie son `id`.
    pub fn send_request(&mut self, method: &str, params: Value) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        write_frame(&mut self.stream, &Frame::rpc(&request(id, method, params))).unwrap();
        id
    }

    /// La requête `id` n'a pas encore de réponse ?
    pub fn responses_pending(&self, id: u64) -> bool {
        !self.responses.contains_key(&id)
    }

    /// Réponse (ou erreur) de la requête `id`.
    pub fn wait_response(&mut self, id: u64) -> Value {
        let start = Instant::now();
        loop {
            if let Some(v) = self.responses.remove(&id) {
                return v;
            }
            assert!(
                start.elapsed() < TIMEOUT,
                "pas de réponse à la requête {id}"
            );
            self.pump(Duration::from_millis(20));
        }
    }

    pub fn call_raw(&mut self, method: &str, params: Value) -> Value {
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

    pub fn call(&mut self, method: &str, params: Value) -> Value {
        let v = self.call_raw(method, params);
        assert!(v.get("error").is_none(), "{method} : {v}");
        v["result"].clone()
    }

    pub fn input(&mut self, id: Uuid, data: &[u8]) {
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
    pub fn wait_until(&mut self, what: &str, mut cond: impl FnMut(&Self) -> bool) {
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

    pub fn output_text(&self, id: Uuid) -> String {
        String::from_utf8_lossy(self.pty.get(&id).map_or(&[][..], |v| v)).into_owned()
    }

    /// Statuts successifs de la session vus dans `session.updated`, sans répétition.
    pub fn statuses(&self, id: Uuid) -> Vec<String> {
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

    pub fn last_session(&self, id: Uuid) -> Option<Value> {
        self.notifications
            .iter()
            .rev()
            .find(|n| n["method"] == "session.updated" && n["params"]["session"]["id"] == json!(id))
            .map(|n| n["params"]["session"].clone())
    }

    pub fn effects(&self, id: Uuid) -> Vec<Value> {
        self.notifications
            .iter()
            .filter(|n| n["method"] == "session.effect" && n["params"]["id"] == json!(id))
            .map(|n| n["params"]["effect"].clone())
            .collect()
    }
}

pub fn status_label(session: &Value) -> String {
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
pub fn is_subsequence(seen: &[String], expected: &[&str]) -> bool {
    let mut it = seen.iter();
    expected.iter().all(|e| it.any(|s| s == e))
}

pub fn git_available() -> bool {
    Command::new("git")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

/// Lance une session et attend qu'elle soit inactive (fin du premier tour).
pub fn launch_idle(c: &mut Client, env: &Env, params: Value) -> Uuid {
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

impl Client {
    /// Appel qui doit échouer : renvoie le code d'erreur.
    pub fn call_err(&mut self, method: &str, params: Value) -> i64 {
        let v = self.call_raw(method, params);
        v["error"]["code"]
            .as_i64()
            .unwrap_or_else(|| panic!("{method} : erreur attendue, reçu {v}"))
    }

    /// Dernière demande en attente de la session, d'après `session.updated`.
    pub fn last_pending(&self, id: Uuid) -> Option<Value> {
        self.last_session(id)?["pending"]
            .as_array()?
            .last()
            .cloned()
    }

    /// Attend une demande du genre `kind` à laquelle un relais est rattaché
    /// (`answerable`), et renvoie son identifiant.
    pub fn wait_answerable(&mut self, id: Uuid, kind: &str) -> u64 {
        self.wait_until("demande répondable", |c| {
            c.last_pending(id)
                .is_some_and(|p| p["answerable"] == true && p["pending"]["kind"] == kind)
        });
        self.last_pending(id).unwrap()["request_id"]
            .as_u64()
            .unwrap()
    }

    /// Effets `request_resolved` d'une demande.
    pub fn resolutions(&self, id: Uuid, request: u64) -> Vec<String> {
        self.effects(id)
            .iter()
            .filter(|e| e["type"] == "request_resolved" && e["request_id"] == request)
            .map(|e| e["how"].as_str().unwrap_or("?").to_owned())
            .collect()
    }
}

/// Session lancée, abonnée, inactive.
pub fn session(c: &mut Client, env: &Env, params: Value) -> Uuid {
    let id = launch_idle(c, env, params);
    c.call("sessions.subscribe", json!({"id": id}));
    id
}

pub fn wait_output(c: &mut Client, id: Uuid, text: &str) {
    c.wait_until(text, |c| c.output_text(id).contains(text));
}

/// Un tour ordinaire (texte libre), attendu jusqu'à sa fin.
pub fn turn(c: &mut Client, id: Uuid) {
    let before = c.statuses(id).len();
    c.input(id, b"tour\r");
    let start = Instant::now();
    loop {
        let s = c.statuses(id);
        if s.len() > before
            && s[before..].contains(&"running".to_owned())
            && s.last().unwrap() == "idle"
        {
            break;
        }
        assert!(
            start.elapsed() < TIMEOUT,
            "fin du tour : statuts {:?}\nécran : {}",
            &s[before..],
            c.output_text(id)
        );
        c.pump(Duration::from_millis(20));
    }
}

pub fn wait_idle(c: &mut Client, id: Uuid) {
    c.wait_until("session inactive", |c| {
        c.last_session(id).is_some_and(|s| {
            s["status"]["state"] == "idle" && s["pending"].as_array().is_some_and(Vec::is_empty)
        })
    });
}

/// Lignes `PermissionRequest` du journal du faux claude (relais terminés).
pub fn relay_results(env: &Env) -> Vec<Value> {
    env.fake_events("hook")
        .into_iter()
        .filter(|l| l["hook"] == "PermissionRequest")
        .collect()
}

pub fn wait_relay_results(env: &Env, n: usize) -> Vec<Value> {
    let start = Instant::now();
    loop {
        let r = relay_results(env);
        if r.len() >= n {
            return r;
        }
        assert!(start.elapsed() < TIMEOUT, "relais pas terminé : {r:?}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

pub fn token_of(env: &Env, n: usize) -> String {
    env.fake_launches()[n]["ORCH_TOKEN"]
        .as_str()
        .unwrap()
        .to_owned()
}

/// Verdict d'une sonde du socket de contrôle lancée par le faux claude.
pub fn wait_probe(env: &Env, label: &str, timeout: Duration) -> String {
    let start = Instant::now();
    loop {
        if let Some(p) = env
            .fake_events("probe")
            .iter()
            .find(|p| p["probe"] == label)
        {
            return p["verdict"].as_str().unwrap().to_owned();
        }
        assert!(start.elapsed() < timeout, "sonde {label} : pas de verdict");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Pid du n-ième faux claude lancé.
pub fn fake_pid(env: &Env, n: usize) -> u32 {
    env.fake_launches()[n]["pid"].as_u64().unwrap() as u32
}

/// Tue (SIGKILL) le groupe d'un faux claude resté en vie.
pub fn kill_group(pid: u32) {
    let _ = nix::sys::signal::killpg(
        nix::unistd::Pid::from_raw(pid as i32),
        nix::sys::signal::Signal::SIGKILL,
    );
}

/// Lignes du journal du démon.
pub fn daemon_log(env: &Env) -> String {
    std::fs::read_to_string(env.state.join("devmaestro/orchd.log")).unwrap_or_default()
}

pub fn wait_log(env: &Env, text: &str) {
    let start = Instant::now();
    while !daemon_log(env).contains(text) {
        assert!(
            start.elapsed() < TIMEOUT,
            "journal du démon : « {text} » attendu"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}
