//! Plugin factice (Python, `python3 -I`) des tests du lot 22a. Son mode est
//! le premier argument de sa commande (jamais l'environnement, filtré par
//! le démon) ; un second argument facultatif est un fichier où écrire le
//! pid d'un petit-enfant détaché (mode `fork`) ou le sien (mode
//! `slowinit`, qui répond à `initialize` après 2 s).
//!
//! - les marqueurs `{RLO}` et `{ZWSP}` des textes de `config` deviennent
//!   U+202E et U+200B dans les réponses (le manifeste refuse les invisibles) ;
//! - `panel.render` rend `config.document` s'il est donné, sinon un
//!   document dont le bloc `markdown` porte, en JSON, les paramètres reçus,
//!   ceux d'`initialize` et l'environnement du processus ;
//! - `action.run` rend `config.results[<action>]` s'il est donné, une
//!   erreur JSON-RPC pour l'action `fail`, sinon le même document d'écho.

#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde_json::{Value, json};

pub const FAKE_PLUGIN_PY: &str = r#"
import json, os, signal, socket, subprocess, sys, time

MODE = sys.argv[1] if len(sys.argv) > 1 else "normal"
PIDFILE = sys.argv[2] if len(sys.argv) > 2 else None
state = {"init": None, "config": {}}

def send(obj):
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
    sys.stdout.flush()

def echo(params):
    text = json.dumps({"params": params, "init": state["init"], "env": dict(os.environ), "pid": os.getpid()})
    return {"title": "Écho", "blocks": [{"type": "markdown", "text": text}]}

def hostile(x):
    # Le manifeste refuse les invisibles : `config` porte des marqueurs que le
    # plugin remplace, pour éprouver le nettoyage de ses réponses.
    text = json.dumps(x).replace("{RLO}", "\\u202e").replace("{ZWSP}", "\\u200b")
    return json.loads(text)

def probe_socket(path):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        s.connect(path)
    except OSError as e:
        return "connexion impossible : %s" % e
    s.settimeout(2.0)
    try:
        data = s.recv(1)
        return "refusé" if data == b"" else "accepté"
    except socket.timeout:
        return "accepté"
    except OSError:
        return "refusé"

if MODE == "noise":
    print("Bienvenue dans le plugin !", flush=True)
if MODE == "fork":
    p = subprocess.Popen(["sleep", "300"], start_new_session=True)
    if PIDFILE:
        with open(PIDFILE, "w") as f:
            f.write(str(p.pid))
if MODE == "slowinit" and PIDFILE:
    with open(PIDFILE, "w") as f:
        f.write(str(os.getpid()))
if MODE == "ignore_term":
    signal.signal(signal.SIGTERM, signal.SIG_IGN)

for line in sys.stdin:
    req = json.loads(line)
    method, params, rid = req.get("method"), req.get("params"), req.get("id")
    if method == "initialize":
        if MODE == "slowinit":
            time.sleep(2)
        state["init"] = params
        state["config"] = (params or {}).get("config") or {}
        send({"jsonrpc": "2.0", "id": rid, "result": {"api_version": 2 if MODE == "badinit" else 1}})
        continue
    if method == "shutdown":
        if MODE == "ignore_term":
            continue
        send({"jsonrpc": "2.0", "id": rid, "result": None})
        break
    if MODE in ("sleep", "ignore_term"):
        time.sleep(300)
    if MODE == "crash":
        os._exit(3)
    if MODE == "flood":
        while True:
            send({"jsonrpc": "2.0", "method": "log", "params": {"x": "y" * 100}})
    if MODE == "hugeline":
        sys.stdout.write('{"jsonrpc":"2.0","id":%d,"result":"' % rid + "z" * 50_000_000)
        sys.stdout.flush()
        time.sleep(300)
    if MODE == "stderr_spam":
        for _ in range(120_000):
            sys.stderr.write("bruit " * 8 + "\n")
        sys.stderr.write("fin du bruit\n")
        sys.stderr.flush()
    if MODE == "request":
        send({"jsonrpc": "2.0", "id": "h1", "method": "host.sessions", "params": {}})
        time.sleep(300)
    if MODE == "unknown_id":
        send({"jsonrpc": "2.0", "id": 9999, "result": None})
        time.sleep(300)
    if MODE == "notify":
        for _ in range(10):
            send({"jsonrpc": "2.0", "method": "log", "params": {}})
    cfg = state["config"]
    if method == "panel.render":
        if MODE == "ctl":
            verdict = probe_socket(cfg["socket"])
            result = {"blocks": [{"type": "markdown", "text": verdict}]}
        else:
            result = hostile(cfg.get("document")) if cfg.get("document") else echo(params)
        send({"jsonrpc": "2.0", "id": rid, "result": result})
    elif method == "action.run":
        action = params.get("action")
        if action == "fail":
            send({"jsonrpc": "2.0", "id": rid, "error": {"code": -1, "message": "échec\u202e voulu\n" + "x" * 900}})
        elif action in (cfg.get("results") or {}):
            send({"jsonrpc": "2.0", "id": rid, "result": hostile(cfg["results"][action])})
        else:
            send({"jsonrpc": "2.0", "id": rid, "result": {"document": echo(params)}})
    else:
        send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": "inconnue"}})
"#;

/// Test sauté faute de `what` : message explicite, et échec si `CI` est
/// défini (en intégration continue, rien ne doit être sauté en silence).
pub fn skip(what: &str) {
    eprintln!("SAUTÉ : {what}");
    assert!(
        std::env::var_os("CI").is_none(),
        "CI défini : test qui aurait été sauté ({what})"
    );
}

/// `python3` absent : test sauté (voir [`skip`]) ; rend `true` s'il faut sauter.
pub fn no_python() -> bool {
    if python_available() {
        return false;
    }
    skip("python3 absent du PATH");
    true
}

/// Pas de systemd utilisateur : cas sauté (voir [`skip`]) ; rend `true`
/// s'il faut sauter.
pub fn no_systemd(case: &str) -> bool {
    if systemd_scope_available() {
        return false;
    }
    skip(&format!("{case} : pas de gestionnaire systemd utilisateur"));
    true
}

/// `python3` est-il dans le `PATH` ?
pub fn python_available() -> bool {
    Command::new("python3")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

/// Un gestionnaire systemd utilisateur répond-il (scope de test lancé) ?
pub fn systemd_scope_available() -> bool {
    Command::new("systemd-run")
        .args(["--user", "--scope", "--quiet", "--collect", "--", "true"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

/// Écrit un plugin factice `name` dans `plugins_dir` : `fake_plugin.py` et
/// `plugin.json` (`mode` en argument de la commande). Le script est donné
/// par son chemin absolu : la commande, Description du scope systemd, porte
/// ainsi la racine de l'`Env` (filet de `Drop for Env`). `extra` est fusionné
/// dans le manifeste (champs de premier niveau). Rend son dossier.
pub fn write_plugin(plugins_dir: &Path, name: &str, mode: &str, extra: Value) -> PathBuf {
    let dir = plugins_dir.join(name);
    std::fs::create_dir_all(&dir).unwrap();
    let script = dir.join("fake_plugin.py");
    std::fs::write(&script, FAKE_PLUGIN_PY).unwrap();
    let mut m = json!({
        "api_version": 1,
        "name": name,
        "version": "0.1.0",
        "label": {"fr": "Factice", "en": "Fake"},
        "command": ["python3", "-I", script, mode],
        "files": ["fake_plugin.py"],
        "permissions": [],
        "contributes": {
            "session_tab": {"label": {"fr": "Factice", "en": "Fake"}},
            "actions": [{"id": "echo", "label": {"fr": "Écho", "en": "Echo"}},
                        {"id": "fail", "label": {"fr": "Échec", "en": "Fail"}}]
        }
    });
    if let Value::Object(extra) = extra {
        for (k, v) in extra {
            m[k] = v;
        }
    }
    std::fs::write(
        dir.join("plugin.json"),
        serde_json::to_vec_pretty(&m).unwrap(),
    )
    .unwrap();
    dir
}

/// Le processus `pid` existe-t-il encore (zombie compris : non) ?
pub fn process_alive(pid: u32) -> bool {
    match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(s) => !s
            .rsplit(')')
            .next()
            .is_some_and(|rest| rest.trim_start().starts_with('Z')),
        Err(_) => false,
    }
}
