//! Générateur de flux imitant la TUI de Claude Code : texte coloré, appels d'outils,
//! diffs, cadres, spinner réécrit sur place (`\r\x1b[K`) et déplacements du curseur.
//! Déterministe (PRNG à graine) et sans horloge : l'appelant fournit le temps écoulé.

const WORDS: &[&str] = &[
    "session",
    "daemon",
    "terminal",
    "render",
    "cargo",
    "test",
    "build",
    "worktree",
    "commit",
    "hook",
    "diff",
    "patch",
    "review",
    "fichier",
    "module",
    "socket",
    "async",
    "buffer",
    "flux",
    "xterm",
    "webview",
    "tauri",
    "permission",
    "statusline",
    "Edit",
    "Read",
    "Bash",
    "Grep",
    "src/main.rs",
    "Cargo.toml",
    "index.ts",
    "ok",
    "erreur",
    "warning",
    "→",
    "✓",
    "…",
];
const TOOLS: &[&str] = &["Bash", "Read", "Edit", "Grep", "Write", "Glob", "Task"];
const SPINNER: &[&str] = &["·", "✢", "✳", "✶", "✻", "✽"];
const COLORS: &[u8] = &[174, 114, 75, 180, 145, 216, 110, 252];

/// Intervalle entre deux redessins du spinner.
const SPINNER_PERIOD_S: f64 = 0.1;

/// Petit PRNG xorshift64* : suffisant ici, et pas de dépendance.
#[derive(Clone)]
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
    fn pick<'a>(&mut self, items: &[&'a str]) -> &'a str {
        items[self.below(items.len())]
    }
}

pub struct SessionGen {
    rng: Rng,
    /// Débit visé, en octets par seconde.
    rate: f64,
    /// Octets « dus » non encore produits (peut être négatif après un dépassement).
    budget: f64,
    elapsed_s: f64,
    since_spinner_s: f64,
    spinner_frame: usize,
    tokens: u64,
}

impl SessionGen {
    pub fn new(seed: u64, rate_bytes_per_s: f64) -> Self {
        Self {
            rng: Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1),
            rate: rate_bytes_per_s,
            budget: 0.0,
            elapsed_s: 0.0,
            since_spinner_s: 0.0,
            spinner_frame: 0,
            tokens: 0,
        }
    }

    /// Produit les octets dus pour `dt_s` secondes de flux.
    pub fn tick(&mut self, dt_s: f64) -> Vec<u8> {
        let mut out = Vec::new();
        self.elapsed_s += dt_s;
        self.since_spinner_s += dt_s;
        self.budget += self.rate * dt_s;
        if self.since_spinner_s >= SPINNER_PERIOD_S {
            self.since_spinner_s = 0.0;
            let before = out.len();
            self.spinner(&mut out);
            self.budget -= (out.len() - before) as f64;
        }
        while self.budget > 0.0 {
            let before = out.len();
            self.element(&mut out);
            self.budget -= (out.len() - before) as f64;
        }
        // Évite qu'un long retard accumule une dette énorme.
        self.budget = self.budget.max(-self.rate);
        out
    }

    /// Produit au moins `n` octets d'un coup (pic de sortie, historique).
    pub fn fill(&mut self, n: usize) -> Vec<u8> {
        let mut out = Vec::with_capacity(n + 512);
        while out.len() < n {
            self.element(&mut out);
            if self.rng.below(8) == 0 {
                self.spinner(&mut out);
            }
        }
        out
    }

    fn spinner(&mut self, out: &mut Vec<u8>) {
        self.spinner_frame = (self.spinner_frame + 1) % SPINNER.len();
        self.tokens += 7 + self.rng.below(40) as u64;
        let s = format!(
            "\r\x1b[K\x1b[38;5;174m{}\x1b[0m \x1b[38;5;174mThinking…\x1b[0m \x1b[2m({}s · ↑ {:.1}k tokens · esc to interrupt)\x1b[0m",
            SPINNER[self.spinner_frame],
            self.elapsed_s as u64,
            self.tokens as f64 / 1000.0
        );
        out.extend_from_slice(s.as_bytes());
    }

    fn words(&mut self, min: usize, max: usize) -> String {
        let n = min + self.rng.below(max - min + 1);
        let mut s = String::new();
        for i in 0..n {
            if i > 0 {
                s.push(' ');
            }
            s.push_str(self.rng.pick(WORDS));
        }
        s
    }

    /// Un élément de sortie, précédé d'un effacement de la ligne du spinner.
    fn element(&mut self, out: &mut Vec<u8>) {
        out.extend_from_slice(b"\r\x1b[K");
        let s = match self.rng.below(20) {
            // Ligne de texte colorée par morceaux.
            0..=9 => {
                let mut s = String::from("  ");
                for _ in 0..1 + self.rng.below(4) {
                    let c = COLORS[self.rng.below(COLORS.len())];
                    let w = self.words(3, 8);
                    s.push_str(&format!("\x1b[38;5;{c}m{w}\x1b[0m "));
                }
                s.push_str("\r\n");
                s
            }
            // Appel d'outil.
            10..=12 => {
                let tool = self.rng.pick(TOOLS);
                let arg = self.words(1, 3);
                let res = self.words(4, 10);
                format!("\x1b[38;5;114m●\x1b[0m \x1b[1m{tool}\x1b[0m({arg})\r\n  ⎿  \x1b[2m{res}\x1b[0m\r\n")
            }
            // Lignes de diff sur fond coloré.
            13..=15 => {
                let mut s = String::new();
                for _ in 0..2 + self.rng.below(4) {
                    let (bg, sign) = if self.rng.below(2) == 0 {
                        (22, '+')
                    } else {
                        (52, '-')
                    };
                    let w = self.words(4, 12);
                    s.push_str(&format!("\x1b[48;5;{bg}m{sign} {w}\x1b[K\x1b[0m\r\n"));
                }
                s
            }
            // Réécriture d'une ligne plus haut puis retour (déplacements du curseur).
            16..=17 => {
                let up = 1 + self.rng.below(3);
                let w = self.words(2, 6);
                format!("\x1b[{up}A\r\x1b[K\x1b[2m  ✓ {w}\x1b[0m\x1b[{up}B\r")
            }
            // Cadre.
            _ => {
                let w = self.words(3, 7);
                let width = w.chars().count() + 2;
                let bar = "─".repeat(width);
                format!(
                    "\x1b[38;5;244m╭{bar}╮\r\n│ \x1b[0m{w}\x1b[38;5;244m │\r\n╰{bar}╯\x1b[0m\r\n"
                )
            }
        };
        out.extend_from_slice(s.as_bytes());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn contains(hay: &[u8], needle: &[u8]) -> bool {
        hay.windows(needle.len()).any(|w| w == needle)
    }

    #[test]
    fn one_second_matches_rate_and_has_spinner() {
        let rate = 20_000.0;
        let mut g = SessionGen::new(1, rate);
        let mut total = Vec::new();
        for _ in 0..100 {
            total.extend(g.tick(0.010));
        }
        let n = total.len() as f64;
        assert!(
            (n - rate).abs() / rate < 0.2,
            "débit hors tolérance : {n} o/s"
        );
        assert!(contains(&total, b"\r\x1b[K"), "pas de réécriture de ligne");
        assert!(contains(&total, "Thinking…".as_bytes()), "pas de spinner");
        assert!(contains(&total, b"\x1b[38;5;"), "pas de couleur");
        // Le spinner est redessiné ~10 fois par seconde.
        let needle = "Thinking…".as_bytes();
        let spins = total.windows(needle.len()).filter(|w| *w == needle).count();
        assert!((8..=12).contains(&spins), "{spins} redessins du spinner");
        // Flux valide en UTF-8 (aucun caractère coupé).
        assert!(std::str::from_utf8(&total).is_ok());
    }

    #[test]
    fn long_run_keeps_rate() {
        let mut g = SessionGen::new(7, 20_000.0);
        let n: usize = (0..3000).map(|_| g.tick(0.010).len()).sum();
        let rate = n as f64 / 30.0;
        assert!((rate - 20_000.0).abs() < 1_000.0, "{rate} o/s");
    }

    #[test]
    fn fill_produces_at_least_n() {
        let mut g = SessionGen::new(3, 20_000.0);
        let b = g.fill(1 << 20);
        assert!(b.len() >= 1 << 20 && b.len() < (1 << 20) + 4096);
        assert!(std::str::from_utf8(&b).is_ok());
    }

    #[test]
    fn deterministic_per_seed() {
        assert_eq!(
            SessionGen::new(5, 1e4).fill(5000),
            SessionGen::new(5, 1e4).fill(5000)
        );
        assert_ne!(
            SessionGen::new(5, 1e4).fill(5000),
            SessionGen::new(6, 1e4).fill(5000)
        );
    }
}
