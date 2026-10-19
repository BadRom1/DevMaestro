//! Source de flux : générateur synthétique, ou rejeu en boucle d'une vraie capture PTY
//! (sortie brute d'une session Claude Code) au débit configuré.

use crate::generator::SessionGen;
use std::sync::Arc;

/// Retire les entrées / sorties d'écran alternatif (`ESC[?1049h/l`, `ESC[?47h/l`, `ESC[?1047h/l`) :
/// en boucle, elles feraient basculer l'écran à chaque tour.
pub fn strip_alt_screen(data: &[u8]) -> Vec<u8> {
    const SEQS: [&[u8]; 6] = [
        b"\x1b[?1049h",
        b"\x1b[?1049l",
        b"\x1b[?1047h",
        b"\x1b[?1047l",
        b"\x1b[?47h",
        b"\x1b[?47l",
    ];
    let mut out = Vec::with_capacity(data.len());
    let mut i = 0;
    while i < data.len() {
        match SEQS.iter().find(|q| data[i..].starts_with(q)) {
            Some(q) => i += q.len(),
            None => {
                out.push(data[i]);
                i += 1;
            }
        }
    }
    out
}

/// Rejeu en boucle d'une capture, à débit constant ; chaque session part d'un décalage différent.
pub struct Replay {
    data: Arc<Vec<u8>>,
    pos: usize,
    rate: f64,
    budget: f64,
}

/// Coupe au plus tard `max` octets après `from`, de préférence juste avant un ESC ou après un
/// saut de ligne (pour ne pas trancher une séquence d'échappement), sinon sur une frontière UTF-8.
fn cut(data: &[u8], from: usize, want: usize) -> usize {
    let end = (from + want).min(data.len());
    if end == data.len() {
        return end;
    }
    // Cherche une frontière propre dans les 256 octets suivants.
    let look = (end + 256).min(data.len());
    if let Some(i) = data[end..look]
        .iter()
        .position(|&b| b == 0x1b || b == b'\n')
    {
        let i = end + i;
        return if data[i] == b'\n' { i + 1 } else { i };
    }
    let mut e = end;
    while e < data.len() && (data[e] & 0xC0) == 0x80 {
        e += 1;
    }
    e
}

impl Replay {
    pub fn new(data: Arc<Vec<u8>>, offset: usize, rate_bytes_per_s: f64) -> Self {
        assert!(!data.is_empty(), "capture vide");
        // Décalage aligné sur un début de ligne.
        let mut pos = offset % data.len();
        if let Some(i) = data[pos..].iter().position(|&b| b == b'\n') {
            pos += i + 1;
        }
        Self {
            pos: pos % data.len(),
            data,
            rate: rate_bytes_per_s,
            budget: 0.0,
        }
    }

    fn take(&mut self, want: usize, out: &mut Vec<u8>) {
        let end = cut(&self.data, self.pos, want.max(1));
        out.extend_from_slice(&self.data[self.pos..end]);
        self.pos = if end >= self.data.len() { 0 } else { end };
    }

    pub fn tick(&mut self, dt_s: f64) -> Vec<u8> {
        let mut out = Vec::new();
        self.budget += self.rate * dt_s;
        while self.budget > 0.0 {
            let before = out.len();
            self.take(self.budget.ceil() as usize, &mut out);
            self.budget -= (out.len() - before) as f64;
        }
        self.budget = self.budget.max(-self.rate);
        out
    }

    pub fn fill(&mut self, n: usize) -> Vec<u8> {
        let mut out = Vec::with_capacity(n + 512);
        while out.len() < n {
            self.take(n - out.len(), &mut out);
        }
        out
    }
}

/// Ce qui alimente une session simulée.
pub enum Feed {
    Synthetic(SessionGen),
    Replay(Replay),
}

impl Feed {
    /// `capture` absente : générateur synthétique (graine `seed`) ; présente : rejeu décalé selon `seed`.
    pub fn new(seed: u64, rate_bytes_per_s: f64, capture: Option<&Arc<Vec<u8>>>) -> Self {
        match capture {
            None => Feed::Synthetic(SessionGen::new(seed, rate_bytes_per_s)),
            Some(c) => {
                // Décalages répartis sur la capture (nombre d'or : bien espacés quelle que soit la graine).
                let offset = ((seed as f64 * 0.618_033_988_7).fract() * c.len() as f64) as usize;
                Feed::Replay(Replay::new(c.clone(), offset, rate_bytes_per_s))
            }
        }
    }

    pub fn tick(&mut self, dt_s: f64) -> Vec<u8> {
        match self {
            Feed::Synthetic(g) => g.tick(dt_s),
            Feed::Replay(r) => r.tick(dt_s),
        }
    }

    pub fn fill(&mut self, n: usize) -> Vec<u8> {
        match self {
            Feed::Synthetic(g) => g.fill(n),
            Feed::Replay(r) => r.fill(n),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn capture() -> Arc<Vec<u8>> {
        let mut v = Vec::new();
        for i in 0..200 {
            v.extend_from_slice(format!("\x1b[38;5;174mligne {i} é\x1b[0m\r\n").as_bytes());
        }
        Arc::new(v)
    }

    #[test]
    fn alt_screen_is_stripped() {
        let d = b"a\x1b[?1049hb\x1b[?47lc\x1b[?1047h\x1b[?25ld";
        assert_eq!(strip_alt_screen(d), b"abc\x1b[?25ld");
    }

    #[test]
    fn replay_keeps_rate_and_loops() {
        let mut r = Replay::new(capture(), 0, 2000.0);
        let mut total = 0;
        for _ in 0..1000 {
            total += r.tick(0.01).len();
        }
        // 10 s à 2 Ko/s, à une coupe près.
        assert!((19_000..21_500).contains(&total), "total = {total}");
        // Plus long que la capture : boucle.
        assert!(r.fill(30_000).len() >= 30_000);
    }

    #[test]
    fn replay_cuts_cleanly() {
        let c = capture();
        let mut r = Replay::new(c.clone(), 37, 500.0);
        for _ in 0..200 {
            let chunk = r.tick(0.01);
            assert!(std::str::from_utf8(&chunk).is_ok(), "frontière UTF-8");
            if let Some(&b) = chunk.last() {
                // Fin de morceau : saut de ligne, ou juste avant un ESC.
                assert!(
                    b == b'\n' || r.data[r.pos] == 0x1b,
                    "coupe au milieu d'une séquence"
                );
            }
        }
        // Deux sessions démarrent à des endroits différents.
        let a = Feed::new(1, 1000.0, Some(&c)).fill(64);
        let b = Feed::new(2, 1000.0, Some(&c)).fill(64);
        assert_ne!(a, b);
    }
}
