//! Faux `claude` pour les tests d'intégration du démon (jamais distribué).
//!
//! Il accepte les mêmes options que `claude` pour ce que le démon utilise
//! (`--session-id`, `--resume`, `--permission-mode`, `--model`,
//! `--plugin-dir`, `--settings`, prompt en dernier), affiche un écran façon
//! TUI, appelle les hooks déclarés dans `<plugin-dir>/hooks/hooks.json` avec
//! un JSON réaliste (celui des jeux d'événements du prototype n° 1) et la
//! statusline déclarée dans `--settings`. Clavier en mode brut : il affiche
//! ce qui est tapé, traite une ligne à l'Entrée (un tour complet avec une
//! permission), signale les changements de taille (SIGWINCH) et sort sur
//! `/exit` après un `SessionEnd` (ou sur `/crash`, code 3, sans `SessionEnd`) ; `/tetu` lui fait ignorer
//! `SIGHUP`.
//!
//! Si `FAKE_CLAUDE_LOG` est défini, chaque lancement y ajoute une ligne JSON
//! (arguments et quelques variables), pour les assertions des tests.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc;
use std::time::Duration;

use serde_json::{Value, json};

static WINCH: AtomicBool = AtomicBool::new(false);
static TOOL_SEQ: AtomicU32 = AtomicU32::new(0);

extern "C" fn on_winch(_: nix::libc::c_int) {
    WINCH.store(true, Ordering::SeqCst);
}

nix::ioctl_read_bad!(get_winsize, nix::libc::TIOCGWINSZ, nix::pty::Winsize);

#[derive(Debug, Default)]
struct Args {
    session_id: Option<String>,
    resume: Option<String>,
    mode: Option<String>,
    model: Option<String>,
    plugin_dir: Option<PathBuf>,
    settings: Option<PathBuf>,
    prompt: Option<String>,
}

fn parse_args(raw: &[String]) -> Result<Args, String> {
    let mut a = Args::default();
    let mut it = raw.iter();
    while let Some(arg) = it.next() {
        let mut value = |name: &str| {
            it.next()
                .cloned()
                .ok_or_else(|| format!("l'option {name} attend une valeur"))
        };
        match arg.as_str() {
            "--session-id" => a.session_id = Some(value(arg)?),
            "--resume" => a.resume = Some(value(arg)?),
            "--permission-mode" => {
                let m = value(arg)?;
                if m == "default" {
                    // Comme claude 2.1.303 : « default » est refusé.
                    return Err("mode « default » refusé, utiliser « manual »".into());
                }
                a.mode = Some(m)
            }
            "--model" => a.model = Some(value(arg)?),
            "--plugin-dir" => a.plugin_dir = Some(PathBuf::from(value(arg)?)),
            "--settings" => a.settings = Some(PathBuf::from(value(arg)?)),
            // Fin des options : le reste est le prompt (comme commander.js).
            "--" => {
                let rest: Vec<&str> = it.by_ref().map(String::as_str).collect();
                if !rest.is_empty() {
                    a.prompt = Some(rest.join(" "));
                }
            }
            other if other.starts_with('-') && other != "-" => {
                return Err(format!("option inconnue : {other}"));
            }
            other => a.prompt = Some(other.to_owned()),
        }
    }
    Ok(a)
}

struct Fake {
    args: Args,
    session_id: String,
    cwd: String,
    hooks: Value,
    plugin_root: String,
}

fn out(s: &str) {
    let mut o = std::io::stdout();
    let _ = o.write_all(s.as_bytes());
    let _ = o.flush();
}

impl Fake {
    /// `permission_mode` tel que l'écrivent les hooks : `manual` → `default`.
    fn hook_mode(&self) -> &str {
        match self.args.mode.as_deref() {
            None | Some("manual") => "default",
            Some(m) => m,
        }
    }

    fn base(&self, event: &str) -> Value {
        json!({
            "session_id": self.session_id,
            "transcript_path": format!("/tmp/faux/{}.jsonl", self.session_id),
            "cwd": self.cwd,
            "hook_event_name": event,
        })
    }

    fn matches(matcher: Option<&str>, tool: Option<&str>) -> bool {
        match (matcher, tool) {
            (None | Some("" | "*"), _) | (_, None) => true,
            (Some(m), Some(t)) => m.split(['|', ',']).any(|x| x.trim() == t),
        }
    }

    /// Lance les hooks de l'événement, l'un après l'autre (comme claude pour
    /// les hooks d'un même événement, à l'ordre près).
    fn hook(&self, event: &str, payload: Value) {
        let tool = payload.get("tool_name").and_then(Value::as_str);
        let groups = self.hooks["hooks"][event]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let input = serde_json::to_vec(&payload).unwrap();
        for g in groups {
            if !Self::matches(g.get("matcher").and_then(Value::as_str), tool) {
                continue;
            }
            for h in g["hooks"].as_array().into_iter().flatten() {
                let expand = |s: &str| s.replace("${CLAUDE_PLUGIN_ROOT}", &self.plugin_root);
                let Some(cmd) = h["command"].as_str() else {
                    continue;
                };
                let mut c = match h.get("args").and_then(Value::as_array) {
                    Some(args) => {
                        let mut c = Command::new(expand(cmd));
                        c.args(args.iter().filter_map(Value::as_str).map(expand));
                        c
                    }
                    None => {
                        let mut c = Command::new("sh");
                        c.arg("-c").arg(expand(cmd));
                        c
                    }
                };
                let child = c
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null())
                    .spawn();
                let Ok(mut child) = child else {
                    out(&format!("[hook {event} : lancement impossible]\r\n"));
                    continue;
                };
                if let Some(mut stdin) = child.stdin.take() {
                    let _ = stdin.write_all(&input);
                }
                let output = child.wait_with_output();
                if let Ok(o) = output {
                    if !o.status.success() {
                        out(&format!("[hook {event} : code {:?}]\r\n", o.status.code()));
                    }
                    if !o.stdout.is_empty() {
                        out(&format!("[hook {event} : sortie inattendue]\r\n"));
                    }
                }
            }
        }
    }

    fn statusline(&self) {
        let Some(path) = &self.args.settings else {
            return;
        };
        let Ok(text) = std::fs::read_to_string(path) else {
            return;
        };
        let Ok(settings) = serde_json::from_str::<Value>(&text) else {
            return;
        };
        let Some(cmd) = settings["statusLine"]["command"].as_str() else {
            return;
        };
        let payload = json!({
            "session_id": self.session_id,
            "cwd": self.cwd,
            "session_name": "Session factice",
            "model": {"id": self.args.model.clone().unwrap_or("claude-opus-5-5".into()),
                      "display_name": "Opus 5.5"},
            "workspace": {"current_dir": self.cwd, "project_dir": self.cwd},
            "cost": {"total_cost_usd": 0.42},
            "context_window": {"total_input_tokens": 1200, "total_output_tokens": 34,
                               "context_window_size": 1000000, "used_percentage": 7},
        });
        let child = Command::new("sh")
            .arg("-c")
            .arg(cmd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn();
        let Ok(mut child) = child else { return };
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(&serde_json::to_vec(&payload).unwrap());
        }
        if let Ok(o) = child.wait_with_output() {
            let line = String::from_utf8_lossy(&o.stdout);
            out(&format!(
                "\x1b[2m statusline : {}\x1b[0m\r\n",
                line.lines().next().unwrap_or("")
            ));
        }
    }

    fn turn(&self, prompt: &str) {
        let mode = self.hook_mode().to_owned();
        let mut ev = self.base("UserPromptSubmit");
        ev["prompt"] = json!(prompt);
        ev["permission_mode"] = json!(mode);
        self.hook("UserPromptSubmit", ev);
        out(&format!("\x1b[1m●\x1b[0m Réponse à : {prompt}\r\n"));

        let n = TOOL_SEQ.fetch_add(1, Ordering::SeqCst);
        let tool_use_id = format!("toolu_faux_{n}");
        let input =
            json!({"command": format!("touch /tmp/faux-{n}"), "description": "Fichier vide"});
        let mut ev = self.base("PreToolUse");
        ev["permission_mode"] = json!(mode);
        ev["tool_name"] = json!("Bash");
        ev["tool_input"] = input.clone();
        ev["tool_use_id"] = json!(tool_use_id);
        self.hook("PreToolUse", ev);

        let mut ev = self.base("PermissionRequest");
        ev["permission_mode"] = json!(mode);
        ev["tool_name"] = json!("Bash");
        ev["tool_input"] = input.clone();
        ev["permission_suggestions"] = json!([]);
        self.hook("PermissionRequest", ev);
        out("  Bash(touch) autorisé\r\n");

        let mut ev = self.base("PostToolUse");
        ev["permission_mode"] = json!(mode);
        ev["tool_name"] = json!("Bash");
        ev["tool_input"] = input;
        ev["tool_use_id"] = json!(tool_use_id);
        ev["tool_response"] = json!({"stdout": "", "stderr": "", "interrupted": false});
        self.hook("PostToolUse", ev);

        let mut ev = self.base("Stop");
        ev["permission_mode"] = json!(mode);
        ev["stop_hook_active"] = json!(false);
        self.hook("Stop", ev);
        self.statusline();
    }
}

fn winsize() -> Option<(u16, u16)> {
    let mut ws = nix::pty::Winsize {
        ws_row: 0,
        ws_col: 0,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    // SAFETY: TIOCGWINSZ remplit une struct winsize valide, passée par pointeur.
    unsafe { get_winsize(0, &mut ws) }.ok()?;
    Some((ws.ws_col, ws.ws_row))
}

fn main() {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    let args = match parse_args(&raw) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("faux claude : {e}");
            std::process::exit(1);
        }
    };
    if let Some(log) = std::env::var_os("FAKE_CLAUDE_LOG") {
        let line = json!({
            "args": raw,
            "CLAUDE_CONFIG_DIR": std::env::var("CLAUDE_CONFIG_DIR").ok(),
            "ORCH_SESSION": std::env::var("ORCH_SESSION").ok(),
            "ORCH_TOKEN_present": std::env::var_os("ORCH_TOKEN").is_some(),
            "TERM": std::env::var("TERM").ok(),
            "COLORTERM": std::env::var("COLORTERM").ok(),
            "cwd": std::env::current_dir().ok(),
        });
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log)
        {
            let _ = writeln!(f, "{line}");
        }
    }

    let plugin_root = args
        .plugin_dir
        .as_ref()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let hooks = args
        .plugin_dir
        .as_ref()
        .and_then(|d| std::fs::read_to_string(d.join("hooks/hooks.json")).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(Value::Null);
    let resumed = args.resume.is_some();
    let session_id = args
        .resume
        .clone()
        .or_else(|| args.session_id.clone())
        .unwrap_or_else(|| "00000000-0000-4000-8000-000000000000".into());
    let fake = Fake {
        cwd: std::env::current_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default(),
        session_id,
        hooks,
        plugin_root,
        args,
    };

    // Clavier en mode brut, comme une TUI.
    if let Ok(mut t) = nix::sys::termios::tcgetattr(std::io::stdin()) {
        nix::sys::termios::cfmakeraw(&mut t);
        let _ =
            nix::sys::termios::tcsetattr(std::io::stdin(), nix::sys::termios::SetArg::TCSANOW, &t);
    }
    // SAFETY: le gestionnaire ne fait qu'écrire un booléen atomique.
    unsafe {
        let _ = nix::sys::signal::signal(
            nix::sys::signal::Signal::SIGWINCH,
            nix::sys::signal::SigHandler::Handler(on_winch),
        );
    }

    out("\x1b[2J\x1b[H\x1b[?2004h");
    out("\x1b[1;35m╭─ Faux Claude Code ─╮\x1b[0m\r\n");
    out(&format!(
        "session : {} ({})\r\n",
        fake.session_id,
        if resumed { "reprise" } else { "nouvelle" }
    ));
    out(&format!(
        "mode : {} · modèle : {}\r\n",
        fake.args.mode.as_deref().unwrap_or("?"),
        fake.args.model.as_deref().unwrap_or("par défaut")
    ));
    out(&format!(
        "CLAUDE_CONFIG_DIR : {}\r\n",
        std::env::var("CLAUDE_CONFIG_DIR").unwrap_or_else(|_| "(absent)".into())
    ));
    if let Some((c, r)) = winsize() {
        out(&format!("taille : {c}x{r}\r\n"));
    }

    let mut ev = fake.base("SessionStart");
    ev["source"] = json!(if resumed { "resume" } else { "startup" });
    ev["model"] = json!(fake.args.model.clone().unwrap_or("claude-opus-5-5".into()));
    fake.hook("SessionStart", ev);
    fake.statusline();
    if let Some(p) = fake.args.prompt.clone() {
        fake.turn(&p);
    }
    out("> ");

    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut stdin = std::io::stdin();
        let mut buf = [0u8; 4096];
        loop {
            match stdin.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
    });

    let mut line = String::new();
    loop {
        if WINCH.swap(false, Ordering::SeqCst)
            && let Some((c, r)) = winsize()
        {
            out(&format!("\r\ntaille : {c}x{r}\r\n> {line}"));
        }
        let data = match rx.recv_timeout(Duration::from_millis(20)) {
            Ok(d) => d,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        };
        for b in String::from_utf8_lossy(&data).chars() {
            match b {
                '\r' | '\n' => {
                    out("\r\n");
                    let text = std::mem::take(&mut line);
                    if text.trim() == "/tetu" {
                        // Ignore SIGHUP : seul SIGKILL l'arrête.
                        // SAFETY: changement de disposition d'un signal, sans gestionnaire.
                        unsafe {
                            let _ = nix::sys::signal::signal(
                                nix::sys::signal::Signal::SIGHUP,
                                nix::sys::signal::SigHandler::SigIgn,
                            );
                        }
                        out("SIGHUP ignoré.\r\n> ");
                        continue;
                    }
                    if text.trim() == "/crash" {
                        // Sortie en erreur, sans SessionEnd.
                        out("Plantage simulé.\r\n");
                        std::process::exit(3);
                    }
                    if text.trim() == "/exit" {
                        let mut ev = fake.base("SessionEnd");
                        ev["reason"] = json!("prompt_input_exit");
                        fake.hook("SessionEnd", ev);
                        out("Au revoir.\r\n");
                        std::process::exit(0);
                    }
                    if !text.trim().is_empty() {
                        fake.turn(text.trim());
                    }
                    out("> ");
                }
                '\x7f' | '\x08' => {
                    if line.pop().is_some() {
                        out("\x08 \x08");
                    }
                }
                c if !c.is_control() => {
                    line.push(c);
                    out(&c.to_string());
                }
                _ => {}
            }
        }
    }
}
