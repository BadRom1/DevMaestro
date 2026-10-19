//! Terminal d'une session, côté démon (architecture § 9) : émulateur sans
//! affichage (`vt100`), tampon circulaire des octets bruts, diffusion aux
//! abonnés.
//!
//! Toutes les opérations prennent le même verrou : un abonné reçoit un
//! instantané puis exactement les octets arrivés après lui, sans trou ni
//! doublon. La diffusion (`tokio::sync::broadcast`) ne bloque jamais le
//! lecteur du PTY : un abonné trop lent prend du retard (`Lagged`) et doit
//! redemander un instantané.

use std::collections::VecDeque;
use std::num::NonZeroU16;
use std::sync::{Arc, Mutex, MutexGuard};

use tokio::sync::broadcast;

use crate::ports::TermSize;

/// Taille du tampon des octets bruts.
pub const RING_CAPACITY: usize = 2 * 1024 * 1024;
/// Morceaux de sortie gardés pour les abonnés lents avant `Lagged`.
pub const BROADCAST_CAPACITY: usize = 1024;
/// Lignes d'historique gardées par l'émulateur.
const SCROLLBACK_LINES: usize = 1000;

/// Séquence envoyée avant la reprise d'une session dans le même terminal :
/// attributs remis à zéro, écran effacé, curseur en haut à gauche
/// (l'historique des clients est conservé).
pub const RESUME_RESET: &[u8] = b"\x1b[0m\r\n\x1b[2J\x1b[H";

/// Un morceau de sortie du PTY.
pub type Chunk = Arc<[u8]>;

/// Écran courant, de quoi restaurer un terminal qui se (re)connecte.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    pub cols: u16,
    pub rows: u16,
    /// Ligne et colonne du curseur, à partir de 0.
    pub cursor_row: u16,
    pub cursor_col: u16,
    pub cursor_visible: bool,
    /// Séquences ANSI qui redessinent l'écran et rétablissent les modes
    /// d'entrée (`Screen::state_formatted`).
    pub ansi: String,
    /// Texte de l'écran, sans mise en forme.
    pub text: String,
}

struct Inner {
    parser: vt100::Parser,
    ring: VecDeque<u8>,
    tx: broadcast::Sender<Chunk>,
}

/// Terminal d'une session.
pub struct Terminal {
    inner: Mutex<Inner>,
}

fn nz(v: u16) -> NonZeroU16 {
    NonZeroU16::new(v).unwrap_or(NonZeroU16::MIN)
}

impl Terminal {
    pub fn new(size: TermSize) -> Self {
        let (tx, _) = broadcast::channel(BROADCAST_CAPACITY);
        Self {
            inner: Mutex::new(Inner {
                parser: vt100::Parser::new(nz(size.rows), nz(size.cols), SCROLLBACK_LINES),
                ring: VecDeque::new(),
                tx,
            }),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        // Un verrou empoisonné (panique d'un autre fil) n'empêche pas d'afficher.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Octets sortis du PTY : émulateur, tampon, abonnés.
    pub fn feed(&self, data: &[u8]) {
        if data.is_empty() {
            return;
        }
        let mut inner = self.lock();
        // Une panique de l'émulateur (séquence imprévue) ne doit ni empoisonner
        // le verrou ni arrêter la lecture du PTY : l'émulateur repart de zéro.
        let processed =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| inner.parser.process(data)));
        if processed.is_err() {
            super::log::error!("émulateur de terminal en erreur : remis à zéro");
            let (rows, cols) = inner.parser.screen().size();
            inner.parser = vt100::Parser::new(rows, cols, SCROLLBACK_LINES);
        }
        inner.ring.extend(data);
        let excess = inner.ring.len().saturating_sub(RING_CAPACITY);
        inner.ring.drain(..excess);
        // Aucun abonné : l'erreur est normale.
        let _ = inner.tx.send(Arc::from(data));
    }

    fn snapshot_of(inner: &Inner) -> Snapshot {
        let screen = inner.parser.screen();
        let (rows, cols) = screen.size();
        let (cursor_row, cursor_col) = screen.cursor_position();
        Snapshot {
            cols: cols.get(),
            rows: rows.get(),
            cursor_row,
            cursor_col,
            cursor_visible: !screen.hide_cursor(),
            ansi: screen.state_formatted(),
            text: screen.contents(),
        }
    }

    pub fn snapshot(&self) -> Snapshot {
        Self::snapshot_of(&self.lock())
    }

    /// Instantané et abonnement pris ensemble.
    pub fn subscribe(&self) -> (Snapshot, broadcast::Receiver<Chunk>) {
        let inner = self.lock();
        (Self::snapshot_of(&inner), inner.tx.subscribe())
    }

    /// Instantané, historique brut (si demandé) et abonnement, pris sous le
    /// même verrou : l'historique s'arrête exactement où le flux commence.
    pub fn subscribe_with_history(
        &self,
        history: bool,
    ) -> (Snapshot, Option<Vec<u8>>, broadcast::Receiver<Chunk>) {
        let inner = self.lock();
        let hist = history.then(|| Self::history_of(&inner));
        (Self::snapshot_of(&inner), hist, inner.tx.subscribe())
    }

    /// Nouvelle taille de l'émulateur (le PTY est redimensionné à part).
    pub fn resize(&self, size: TermSize) {
        self.lock().parser.set_size(nz(size.rows), nz(size.cols));
    }

    pub fn size(&self) -> TermSize {
        let inner = self.lock();
        let (rows, cols) = inner.parser.screen().size();
        TermSize {
            cols: cols.get(),
            rows: rows.get(),
        }
    }

    /// Octets bruts récents, à partir du début d'une ligne (le début du
    /// tampon tombe souvent au milieu d'une séquence d'échappement).
    pub fn history(&self) -> Vec<u8> {
        Self::history_of(&self.lock())
    }

    fn history_of(inner: &Inner) -> Vec<u8> {
        let bytes: Vec<u8> = inner.ring.iter().copied().collect();
        if inner.ring.len() < RING_CAPACITY {
            return bytes;
        }
        match bytes.iter().position(|b| *b == b'\n') {
            Some(i) => bytes[i + 1..].to_vec(),
            None => Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SIZE: TermSize = TermSize { cols: 20, rows: 5 };

    #[test]
    fn snapshot_reflects_output_and_resize() {
        let t = Terminal::new(SIZE);
        t.feed(b"Bonjour\r\n\x1b[1mgras\x1b[0m");
        let s = t.snapshot();
        assert_eq!((s.cols, s.rows), (20, 5));
        assert!(s.text.starts_with("Bonjour\ngras"));
        assert!(s.ansi.contains("Bonjour"));
        assert_eq!((s.cursor_row, s.cursor_col), (1, 4));
        t.resize(TermSize { cols: 30, rows: 10 });
        assert_eq!(t.size(), TermSize { cols: 30, rows: 10 });
        // L'instantané rejoué dans un autre émulateur redonne le même écran.
        let mut p = vt100::Parser::new(nz(10), nz(30), 0);
        p.process(t.snapshot().ansi.as_bytes());
        assert_eq!(p.screen().contents(), t.snapshot().text);
    }

    #[test]
    fn subscriber_gets_exactly_what_follows_its_snapshot() {
        let t = Terminal::new(SIZE);
        t.feed(b"avant ");
        let (snap, mut rx) = t.subscribe();
        assert!(snap.text.contains("avant"));
        t.feed(b"apres");
        assert_eq!(&*rx.try_recv().unwrap(), b"apres");
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn history_ends_where_the_stream_starts() {
        let t = Terminal::new(SIZE);
        t.feed(b"un\n");
        let (_, hist, mut rx) = t.subscribe_with_history(true);
        t.feed(b"deux\n");
        assert_eq!(hist.unwrap(), b"un\n");
        assert_eq!(&*rx.try_recv().unwrap(), b"deux\n");
        assert!(t.subscribe_with_history(false).1.is_none());
    }

    #[test]
    fn slow_subscriber_lags_without_blocking() {
        let t = Terminal::new(SIZE);
        let (_, mut rx) = t.subscribe();
        for _ in 0..BROADCAST_CAPACITY + 10 {
            t.feed(b"x");
        }
        assert!(matches!(
            rx.try_recv(),
            Err(broadcast::error::TryRecvError::Lagged(_))
        ));
    }

    #[test]
    fn ring_is_bounded_and_history_starts_on_a_line() {
        let t = Terminal::new(SIZE);
        t.feed(b"court\n");
        assert_eq!(t.history(), b"court\n");
        let line = vec![b'a'; 1023];
        for _ in 0..(RING_CAPACITY / 1024 + 4) {
            t.feed(&line);
            t.feed(b"\n");
        }
        let h = t.history();
        assert!(h.len() < RING_CAPACITY);
        assert_eq!(h.len() % 1024, 0);
        assert!(h.iter().all(|b| *b == b'a' || *b == b'\n'));
    }
}
