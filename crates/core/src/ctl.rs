//! `orchd ctl` : petit client du démon, pour les vérifications à la main.
//! Ce n'est pas l'interface de l'app (lot 4) : sorties simples, en français.

use std::io::Write;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{Value, json};

use crate::protocol::{Frame, read_frame, request, write_frame};

/// Client JSON-RPC bloquant.
pub struct Client {
    stream: UnixStream,
    next_id: u64,
}

impl Client {
    pub fn connect(socket: &Path) -> Result<Self, String> {
        let stream = UnixStream::connect(socket).map_err(|e| {
            format!(
                "connexion au démon impossible ({}) : {e}\nLe démon tourne-t-il ? (orchd daemon)",
                socket.display()
            )
        })?;
        stream
            .set_read_timeout(Some(Duration::from_secs(30)))
            .map_err(|e| e.to_string())?;
        Ok(Self { stream, next_id: 1 })
    }

    /// Appelle une méthode et attend sa réponse (les notifications et les
    /// sorties de PTY reçues entre-temps sont ignorées).
    pub fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        write_frame(&mut self.stream, &Frame::rpc(&request(id, method, params)))
            .map_err(|e| format!("envoi : {e}"))?;
        loop {
            let frame = read_frame(&mut self.stream)
                .map_err(|e| format!("réception : {e}"))?
                .ok_or("le démon a fermé la connexion")?;
            let Frame::Rpc(bytes) = frame else { continue };
            let Ok(msg) = serde_json::from_slice::<Value>(&bytes) else {
                continue;
            };
            if msg.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if let Some(err) = msg.get("error") {
                return Err(format!(
                    "{} (code {})",
                    err["message"].as_str().unwrap_or("erreur"),
                    err["code"]
                ));
            }
            return Ok(msg.get("result").cloned().unwrap_or(Value::Null));
        }
    }
}

/// Commandes de `orchd ctl`.
#[derive(Debug, Clone)]
pub enum Command {
    Sessions,
    Profiles,
    Transcripts {
        profile: Option<String>,
        limit: usize,
    },
    Launch {
        cwd: PathBuf,
        profile: Option<String>,
        model: Option<String>,
        mode: Option<String>,
        prompt: Option<String>,
        cols: u16,
        rows: u16,
    },
    Resume {
        id: Option<String>,
        claude_session_id: Option<String>,
        profile: Option<String>,
        cwd: Option<PathBuf>,
        mode: Option<String>,
        model: Option<String>,
    },
    Stop {
        id: String,
    },
    Attach {
        id: String,
        text: bool,
    },
    Input {
        id: String,
        text: String,
        enter: bool,
    },
}

fn status_label(s: &Value) -> String {
    let state = s["state"].as_str().unwrap_or("?");
    let fr = match state {
        "starting" => "démarrage",
        "running" => "en cours",
        "waiting" => match s["wait"].as_str() {
            Some("question") => "à répondre (question)",
            _ => "à répondre (permission)",
        },
        "idle" => "inactive",
        "error" => "erreur",
        "stopped" => "arrêtée",
        other => other,
    };
    match s["reason"].as_str() {
        Some(r) if state == "stopped" => format!("{fr} ({r})"),
        _ => fr.to_owned(),
    }
}

/// Retrouve l'identifiant complet d'une session à partir d'un préfixe.
fn resolve_id(client: &mut Client, prefix: &str) -> Result<String, String> {
    let list = client.call("sessions.list", json!({}))?;
    let matches: Vec<String> = list["sessions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|s| s["id"].as_str())
        .filter(|id| id.starts_with(prefix))
        .map(str::to_owned)
        .collect();
    match matches.as_slice() {
        [one] => Ok(one.clone()),
        [] => Err(format!("aucune session ne commence par « {prefix} »")),
        _ => Err(format!("plusieurs sessions commencent par « {prefix} »")),
    }
}

fn print_session(s: &Value) {
    println!(
        "{}  {:<26} {:<8} {}  claude={}{}",
        s["id"].as_str().unwrap_or("?"),
        status_label(&s["status"]),
        s["profile"].as_str().unwrap_or("?"),
        s["cwd"].as_str().unwrap_or("?"),
        s["claude_session_id"].as_str().unwrap_or("?"),
        if s["alive"].as_bool() == Some(true) {
            format!("  pid={}", s["pid"])
        } else {
            String::new()
        },
    );
}

/// Exécute une commande `ctl`.
pub fn run(socket: &Path, command: Command) -> Result<(), String> {
    let mut c = Client::connect(socket)?;
    c.call("hello", json!({"client": "orchd ctl"}))?;
    match command {
        Command::Sessions => {
            let list = c.call("sessions.list", json!({}))?;
            let sessions = list["sessions"].as_array().cloned().unwrap_or_default();
            if sessions.is_empty() {
                println!("Aucune session.");
            }
            for s in &sessions {
                print_session(s);
            }
        }
        Command::Profiles => {
            let r = c.call("profiles.list", json!({}))?;
            for p in r["profiles"].as_array().into_iter().flatten() {
                println!(
                    "{:<10} {}{}",
                    p["name"].as_str().unwrap_or("?"),
                    p["config_dir"].as_str().unwrap_or("?"),
                    if p["sets_config_dir_env"].as_bool() == Some(true) {
                        "  (CLAUDE_CONFIG_DIR)"
                    } else {
                        ""
                    }
                );
            }
        }
        Command::Transcripts { profile, limit } => {
            let r = c.call(
                "transcripts.list",
                json!({"profile": profile, "limit": limit}),
            )?;
            for s in r["sessions"].as_array().into_iter().flatten() {
                println!(
                    "{}  {}  {}  {}",
                    s["claude_session_id"].as_str().unwrap_or("?"),
                    s["last_timestamp"].as_str().unwrap_or("?"),
                    s["cwd"].as_str().unwrap_or("?"),
                    s["title"]
                        .as_str()
                        .or(s["first_prompt"].as_str())
                        .unwrap_or("")
                );
            }
        }
        Command::Launch {
            cwd,
            profile,
            model,
            mode,
            prompt,
            cols,
            rows,
        } => {
            let cwd = std::path::absolute(&cwd).map_err(|e| e.to_string())?;
            let r = c.call(
                "sessions.launch",
                json!({"cwd": cwd, "profile": profile, "model": model, "mode": mode,
                       "prompt": prompt, "cols": cols, "rows": rows}),
            )?;
            print_session(&r["session"]);
        }
        Command::Resume {
            id,
            claude_session_id,
            profile,
            cwd,
            mode,
            model,
        } => {
            let id = id.map(|p| resolve_id(&mut c, &p)).transpose()?;
            let cwd = cwd
                .map(|p| std::path::absolute(&p).map_err(|e| e.to_string()))
                .transpose()?;
            let r = c.call(
                "sessions.resume",
                json!({"id": id, "claude_session_id": claude_session_id, "profile": profile,
                       "cwd": cwd, "mode": mode, "model": model}),
            )?;
            print_session(&r["session"]);
        }
        Command::Stop { id } => {
            let id = resolve_id(&mut c, &id)?;
            let r = c.call("sessions.stop", json!({"id": id}))?;
            if r["stopping"].as_bool() == Some(true) {
                println!("Arrêt demandé pour {id}.");
            } else {
                println!("La session {id} ne tourne pas.");
            }
        }
        Command::Attach { id, text } => {
            let id = resolve_id(&mut c, &id)?;
            let r = c.call("sessions.subscribe", json!({"id": id}))?;
            let snap = &r["snapshot"];
            let mut out = std::io::stdout();
            if text {
                let _ = writeln!(out, "{}", snap["text"].as_str().unwrap_or(""));
            } else {
                let _ = out.write_all(b"\x1b[0m\x1b[2J\x1b[H");
                let _ = out.write_all(snap["ansi"].as_str().unwrap_or("").as_bytes());
                let _ = out.write_all(b"\x1b[0m\r\n");
            }
            let _ = writeln!(
                out,
                "[{}×{}, curseur {}:{}]",
                snap["cols"], snap["rows"], snap["cursor"]["row"], snap["cursor"]["col"]
            );
        }
        Command::Input { id, text, enter } => {
            let id = resolve_id(&mut c, &id)?;
            let mut data = text;
            if enter {
                data.push('\r');
            }
            c.call("sessions.input", json!({"id": id, "data": data}))?;
        }
    }
    Ok(())
}
