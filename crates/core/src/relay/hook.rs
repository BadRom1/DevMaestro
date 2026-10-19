//! `orchd hook <événement>` : lit le JSON du hook sur stdin et l'envoie au
//! démon (`ORCH_SOCKET`) avec le jeton de la session (`ORCH_TOKEN`).
//!
//! Le relais attend l'accusé de réception du démon (pas une décision) : les
//! hooks d'une session sont ainsi appliqués dans l'ordre où Claude Code les
//! lance. Il n'écrit jamais rien et sort toujours en 0, au plus tard au bout
//! de [`budget`]. Au lot 2, `PermissionRequest` est relayé comme les autres,
//! sans décision : la TUI garde la main.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use super::{read_stdin, send_frame, silence_panics, within};
use crate::protocol::{ENV_SOCKET, ENV_TOKEN, Frame};

/// Budget total d'un relais de hook. `SessionEnd` partage 1,5 s avec tous
/// les hooks de fin de session de l'utilisateur : on en prend au plus 0,5 s.
pub fn budget(event: &str) -> Duration {
    match event {
        "SessionEnd" => Duration::from_millis(500),
        _ => Duration::from_secs(1),
    }
}

/// Point d'entrée ; renvoie toujours normalement (code de sortie 0).
pub fn run(event: Option<&str>) {
    silence_panics();
    let Some(event) = event.filter(|e| !e.is_empty()).map(str::to_owned) else {
        return;
    };
    let (Some(socket), Some(token)) = (std::env::var_os(ENV_SOCKET), std::env::var(ENV_TOKEN).ok())
    else {
        return;
    };
    let budget = budget(&event);
    let deadline = Instant::now() + budget;
    let _ = within(budget, move || {
        let json = read_stdin();
        let frame = Frame::Hook { token, event, json };
        send_frame(&PathBuf::from(socket), &frame, true, deadline)
    });
}
