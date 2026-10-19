//! `orchd hook <événement> [--wait <secondes>]` : lit le JSON du hook sur
//! stdin et l'envoie au démon (`ORCH_SOCKET`, le socket des relais) avec le
//! jeton de la session (`ORCH_TOKEN`).
//!
//! - Tous les événements sauf `PermissionRequest` : le relais attend
//!   l'accusé de réception du démon (pas une décision), pour que les hooks
//!   d'une session soient appliqués dans l'ordre où Claude Code les lance.
//!   Il n'écrit jamais rien et sort toujours en 0, au plus tard au bout de
//!   [`budget`].
//! - `PermissionRequest` (ADR 0003) : le relais garde la connexion ouverte et
//!   attend la décision de l'app, au plus `--wait` secondes (le démon écrit
//!   dans `hooks.json` un `timeout` un peu plus long). Sur une trame de
//!   décision, il écrit son JSON sur la sortie standard (suivi d'un saut de
//!   ligne) ; sur un accusé (« sans décision » : réponse donnée dans la TUI,
//!   demande close, session arrêtée), une fin de connexion (démon disparu) ou
//!   le délai dépassé, il n'écrit **rien** : la TUI garde la main. Il sort
//!   toujours en 0 et n'autorise jamais rien de lui-même.

use std::io::Write;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use super::{read_stdin, send_frame, silence_panics, within};
use crate::protocol::{ENV_SOCKET, ENV_TOKEN, Frame, read_frame, write_frame};

/// Événement dont le relais attend une décision.
pub const PERMISSION_REQUEST: &str = "PermissionRequest";

/// Attente par défaut d'une décision, si `--wait` est absent : le délai par
/// défaut de Claude Code (600 s) moins une marge.
pub const DEFAULT_PERMISSION_WAIT: Duration = Duration::from_secs(595);

/// Budget total d'un relais de hook. `SessionEnd` partage 1,5 s avec tous
/// les hooks de fin de session de l'utilisateur : on en prend au plus 0,5 s.
pub fn budget(event: &str) -> Duration {
    match event {
        "SessionEnd" => Duration::from_millis(500),
        _ => Duration::from_secs(1),
    }
}

/// Point d'entrée ; renvoie toujours normalement (code de sortie 0).
/// `wait` : valeur de `--wait`, utilisée seulement pour `PermissionRequest`.
pub fn run(event: Option<&str>, wait: Option<Duration>) {
    silence_panics();
    let Some(event) = event.filter(|e| !e.is_empty()).map(str::to_owned) else {
        return;
    };
    let (Some(socket), Some(token)) = (std::env::var_os(ENV_SOCKET), std::env::var(ENV_TOKEN).ok())
    else {
        return;
    };
    let socket = PathBuf::from(socket);
    if event == PERMISSION_REQUEST {
        let budget = wait.unwrap_or(DEFAULT_PERMISSION_WAIT);
        let deadline = Instant::now() + budget;
        // La sortie est écrite ici, dans le fil principal, et seulement si la
        // décision est arrivée dans le budget.
        if let Some(Some(decision)) = within(budget, move || {
            let json = read_stdin();
            let frame = Frame::Hook { token, event, json };
            wait_decision(&socket, &frame, deadline)
        }) {
            let mut out = std::io::stdout();
            let _ = out.write_all(&decision);
            let _ = out.write_all(b"\n");
            let _ = out.flush();
        }
        return;
    }
    let budget = budget(&event);
    let deadline = Instant::now() + budget;
    let _ = within(budget, move || {
        let json = read_stdin();
        let frame = Frame::Hook { token, event, json };
        send_frame(&socket, &frame, true, deadline)
    });
}

/// Envoie la demande et attend la trame de décision. `None` : pas de
/// décision (accusé, fin de flux, erreur, délai).
fn wait_decision(socket: &std::path::Path, frame: &Frame, deadline: Instant) -> Option<Vec<u8>> {
    let remaining = || {
        deadline
            .saturating_duration_since(Instant::now())
            .max(Duration::from_millis(1))
    };
    let mut stream = UnixStream::connect(socket).ok()?;
    stream.set_write_timeout(Some(remaining())).ok()?;
    write_frame(&mut stream, frame).ok()?;
    loop {
        stream.set_read_timeout(Some(remaining())).ok()?;
        match read_frame(&mut stream) {
            Ok(Some(Frame::Decision(json))) if !json.is_empty() => return Some(json),
            Ok(Some(Frame::Ack | Frame::Decision(_))) | Ok(None) | Err(_) => return None,
            // Trame d'un type inconnu : ignorée (compatibilité ascendante).
            Ok(Some(_)) => {
                if Instant::now() >= deadline {
                    return None;
                }
            }
        }
    }
}
