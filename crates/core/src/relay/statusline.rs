//! `orchd statusline [--config-dir <dossier>]` : statusline chaînée (ADR 0002).
//!
//! 1. lit le JSON de la statusline sur stdin et l'envoie au démon, en
//!    attendant son accusé (300 ms au plus, en parallèle de l'étape 2) : le
//!    démon vérifie que l'expéditeur est un processus de la session, ce qui
//!    demande qu'il vive encore ;
//! 2. lance la statusline de l'utilisateur pour ce profil
//!    (`statusLine.command` de `<dossier du profil>/settings.json`), avec le
//!    même JSON sur stdin, par `sh -c`, au plus [`USER_TIMEOUT`] ;
//! 3. affiche sa sortie, ou à défaut une ligne courte (contexte et coût).
//!
//! Le dossier du profil vient de `--config-dir` (posé dans les réglages
//! générés), à défaut de `CLAUDE_CONFIG_DIR`, à défaut de `~/.claude`. Seuls
//! les réglages utilisateur du profil sont lus (pas ceux du projet).
//! La variable [`ENV_CHAINED`] évite qu'une statusline qui rappellerait
//! `orchd statusline` ne boucle.

use std::io::{Read, Write};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::Value;

use super::{read_stdin, send_frame, silence_panics, within};
use crate::protocol::{ENV_SOCKET, ENV_TOKEN, Frame};

/// Délai laissé à la statusline de l'utilisateur.
pub const USER_TIMEOUT: Duration = Duration::from_secs(2);
/// Délai pour transmettre le JSON au démon.
const FORWARD_BUDGET: Duration = Duration::from_millis(300);
/// Posée pour la statusline de l'utilisateur : empêche une boucle.
pub const ENV_CHAINED: &str = "DEVMAESTRO_STATUSLINE_CHAINED";

/// Point d'entrée ; renvoie toujours normalement (code de sortie 0).
pub fn run(config_dir: Option<PathBuf>) {
    silence_panics();
    let raw = within(Duration::from_secs(1), read_stdin).unwrap_or_default();

    // 1. Transmission au démon, en parallèle de la statusline de l'utilisateur.
    let forward = match (std::env::var_os(ENV_SOCKET), std::env::var(ENV_TOKEN).ok()) {
        (Some(socket), Some(token)) => {
            let json = raw.clone();
            let deadline = Instant::now() + FORWARD_BUDGET;
            Some(std::thread::spawn(move || {
                let frame = Frame::Statusline { token, json };
                // L'accusé garde le relais en vie le temps que le démon
                // vérifie qu'il vient bien de la session (socket des relais).
                let _ = send_frame(Path::new(&socket), &frame, true, deadline);
            }))
        }
        _ => None,
    };

    // 2 et 3. Statusline de l'utilisateur, ou ligne de repli.
    let line = if std::env::var_os(ENV_CHAINED).is_some() {
        None
    } else {
        let dir = config_dir
            .or_else(|| std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from))
            .or_else(|| std::env::home_dir().map(|h| h.join(".claude")));
        dir.and_then(|d| user_command(&d))
            .and_then(|cmd| run_user_command(&cmd, &raw, USER_TIMEOUT))
            .filter(|out| !out.trim().is_empty())
    };
    let line = line.unwrap_or_else(|| fallback_line(&raw));
    let mut stdout = std::io::stdout();
    let _ = stdout.write_all(line.as_bytes());
    if !line.ends_with('\n') {
        let _ = stdout.write_all(b"\n");
    }
    let _ = stdout.flush();

    if let Some(t) = forward {
        // Le fil a son propre délai d'écriture ; on ne l'attend pas au-delà.
        let deadline = Instant::now() + FORWARD_BUDGET;
        while !t.is_finished() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}

/// `statusLine.command` des réglages utilisateur du profil.
pub fn user_command(config_dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(config_dir.join("settings.json")).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    let cmd = v.get("statusLine")?.get("command")?.as_str()?.trim();
    (!cmd.is_empty()).then(|| cmd.to_owned())
}

/// Lance `sh -c <cmd>` dans son propre groupe de processus, avec `input`
/// sur stdin, et renvoie ce qu'il a écrit sur sa sortie standard avant la fin
/// du délai. Au-delà du délai (processus trop long, ou descendant en arrière-
/// plan qui garde la sortie ouverte), le groupe est tué et on rend la main
/// sans attendre le fil de lecture. `None` si le lancement échoue ou si rien
/// n'a été écrit à temps.
pub fn run_user_command(cmd: &str, input: &[u8], timeout: Duration) -> Option<String> {
    let deadline = Instant::now() + timeout;
    let mut child = Command::new("sh")
        .arg("-c")
        .arg(cmd)
        .env(ENV_CHAINED, "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .ok()?;
    let pgid = nix::unistd::Pid::from_raw(child.id() as i32);
    let mut stdin = child.stdin.take()?;
    let input = input.to_vec();
    std::thread::spawn(move || {
        let _ = stdin.write_all(&input);
    });
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match stdout.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });
    let mut out = Vec::new();
    let mut eof = false;
    while !eof && out.len() < 1024 * 1024 {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        match rx.recv_timeout(remaining) {
            Ok(chunk) => out.extend(chunk),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => break,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => eof = true,
        }
    }
    if !eof {
        // Délai dépassé : tout le groupe est tué, le fil de lecture est abandonné.
        let _ = nix::sys::signal::killpg(pgid, nix::sys::signal::Signal::SIGKILL);
    }
    // Récupère le processus s'il est fini (sinon le système le fera à notre sortie).
    let _ = child.try_wait();
    if out.is_empty() && !eof {
        return None;
    }
    Some(String::from_utf8_lossy(&out).into_owned())
}

/// Ligne de repli : « DevMaestro · contexte 3 % · 0,22 $ ».
pub fn fallback_line(raw: &[u8]) -> String {
    let v: Value = serde_json::from_slice(raw).unwrap_or(Value::Null);
    let ctx = v["context_window"]["used_percentage"]
        .as_f64()
        .map(|p| format!("{p:.0} %"))
        .unwrap_or_else(|| "?".into());
    let cost = v["cost"]["total_cost_usd"]
        .as_f64()
        .map(|c| format!("{c:.2} $").replace('.', ","))
        .unwrap_or_else(|| "?".into());
    format!("DevMaestro · contexte {ctx} · {cost}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fallback_formats_in_french() {
        assert_eq!(
            fallback_line(
                br#"{"context_window":{"used_percentage":3.4},"cost":{"total_cost_usd":0.2204}}"#
            ),
            "DevMaestro · contexte 3 % · 0,22 $"
        );
        assert_eq!(fallback_line(b"pas du json"), "DevMaestro · contexte ? · ?");
    }

    #[test]
    fn reads_user_command() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(user_command(dir.path()), None);
        std::fs::write(
            dir.path().join("settings.json"),
            r#"{"statusLine":{"type":"command","command":"bash ~/.claude/statusline.sh"}}"#,
        )
        .unwrap();
        assert_eq!(
            user_command(dir.path()).as_deref(),
            Some("bash ~/.claude/statusline.sh")
        );
        std::fs::write(dir.path().join("settings.json"), r#"{"statusLine":{}}"#).unwrap();
        assert_eq!(user_command(dir.path()), None);
    }

    #[test]
    fn runs_user_command_with_stdin_and_timeout() {
        let out = run_user_command(
            "cat; echo \" $DEVMAESTRO_STATUSLINE_CHAINED\"",
            b"{}",
            USER_TIMEOUT,
        );
        assert_eq!(out.as_deref(), Some("{} 1\n"));
        let start = Instant::now();
        assert_eq!(
            run_user_command("sleep 5", b"", Duration::from_millis(200)),
            None
        );
        assert!(start.elapsed() < Duration::from_secs(2));
        assert_eq!(
            run_user_command("exit 3", b"", USER_TIMEOUT).as_deref(),
            Some("")
        );
        // Un descendant en arrière-plan garde la sortie ouverte : on rend la
        // main au délai, avec ce qui a été écrit.
        let start = Instant::now();
        let out = run_user_command("sleep 30 & echo ligne", b"", Duration::from_millis(500));
        assert_eq!(out.as_deref(), Some("ligne\n"));
        assert!(start.elapsed() < Duration::from_millis(1500));
    }
}
