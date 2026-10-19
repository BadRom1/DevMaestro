//! Relais lancés par Claude Code (architecture § 4.3) :
//!
//! - `orchd hook <événement>` : transmet le JSON du hook au démon ;
//! - `orchd statusline` : transmet le JSON de la statusline, puis affiche la
//!   statusline de l'utilisateur.
//!
//! Règle d'or : un relais ne casse ni ne ralentit jamais `claude`. Toute
//! erreur (démon absent, variable manquante, JSON illisible, délai dépassé)
//! est silencieuse et le code de sortie vaut toujours 0. Entrées-sorties
//! bloquantes de la bibliothèque standard (pas de runtime à démarrer), avec un
//! budget de temps global garanti par un fil de travail.

pub mod hook;
pub mod statusline;

use std::io::Read;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use crate::protocol::{Frame, read_frame, write_frame};

/// Taille maximale lue sur l'entrée standard.
pub const MAX_STDIN: u64 = 8 * 1024 * 1024;

/// Lit l'entrée standard, au plus [`MAX_STDIN`] octets.
fn read_stdin() -> Vec<u8> {
    let mut buf = Vec::new();
    let _ = std::io::stdin().take(MAX_STDIN).read_to_end(&mut buf);
    buf
}

/// Exécute `work` dans un fil et l'attend au plus `budget`. Au-delà, le
/// résultat est abandonné (le fil meurt avec le processus).
fn within<T: Send + 'static>(
    budget: Duration,
    work: impl FnOnce() -> T + Send + 'static,
) -> Option<T> {
    let (tx, rx) = mpsc::channel();
    std::thread::Builder::new()
        .name("relais".into())
        .spawn(move || {
            let _ = tx.send(work());
        })
        .ok()?;
    rx.recv_timeout(budget).ok()
}

/// Envoie une trame au démon ; si `ack`, attend l'accusé jusqu'à `deadline`.
fn send_frame(socket: &Path, frame: &Frame, ack: bool, deadline: Instant) -> std::io::Result<()> {
    let mut stream = UnixStream::connect(socket)?;
    let remaining = deadline
        .saturating_duration_since(Instant::now())
        .max(Duration::from_millis(1));
    stream.set_write_timeout(Some(remaining))?;
    write_frame(&mut stream, frame)?;
    if ack {
        let remaining = deadline
            .saturating_duration_since(Instant::now())
            .max(Duration::from_millis(1));
        stream.set_read_timeout(Some(remaining))?;
        // Accusé, fin de flux ou erreur : dans tous les cas on rend la main.
        let _ = read_frame(&mut stream);
    }
    Ok(())
}

/// Coupe les messages de panique : rien ne doit s'afficher dans la TUI.
fn silence_panics() {
    std::panic::set_hook(Box::new(|_| {}));
}
