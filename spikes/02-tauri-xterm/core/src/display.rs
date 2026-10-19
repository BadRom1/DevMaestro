//! Écrans (option `--monitor`) : géométrie logique et mode courant d'une sortie selon Mutter
//! (`org.gnome.Mutter.DisplayConfig`), et position de la sortie dans XWayland (`xrandr`).

use crate::engine::run;

/// Une sortie vue par Mutter : position logique, échelle, mode courant (« 2560x1600@165.000 »).
#[derive(Debug, Clone, PartialEq)]
pub struct MutterOutput {
    pub x: i32,
    pub y: i32,
    pub scale: f64,
    pub mode: Option<String>,
}

impl MutterOutput {
    pub fn describe(&self, connector: &str) -> String {
        format!(
            "{connector} : mode {}, échelle {:.2}, position logique ({}, {})",
            self.mode.as_deref().unwrap_or("?"),
            self.scale,
            self.x,
            self.y
        )
    }
}

/// Analyse la sortie texte de `gdbus call … GetCurrentState` pour un connecteur.
pub fn parse_mutter(state: &str, connector: &str) -> Option<MutterOutput> {
    let key = format!("[('{connector}',");
    // Moniteurs logiques : « (x, y, échelle, uint32 t, primaire, [('eDP-1', … ».
    let at = state.find(&key)?;
    let head = &state[..at];
    let start = [("), (", 4), ("[(", 2)]
        .iter()
        .filter_map(|(pat, len)| head.rfind(pat).map(|i| i + len))
        .max()?;
    let nums: Vec<&str> = head[start..].split(", ").collect();
    let x = nums.first()?.trim().parse().ok()?;
    let y = nums.get(1)?.trim().parse().ok()?;
    let scale = nums.get(2)?.trim().parse().ok()?;
    // Mode courant : dans la liste des moniteurs physiques « (('eDP-1', … ), [modes…]) ».
    let mode = state.find(&format!("(('{connector}',")).and_then(|i| {
        let rest = &state[i..];
        let end = rest[2..].find("(('").map_or(rest.len(), |e| e + 2);
        let block = &rest[..end];
        let cur = block.find("'is-current': <true>")?;
        let open = block[..cur].rfind("('")?;
        let name = &block[open + 2..];
        Some(name[..name.find('\'')?].to_string())
    });
    Some(MutterOutput { x, y, scale, mode })
}

pub fn mutter_output(connector: &str) -> Option<MutterOutput> {
    let state = run(
        "gdbus",
        &[
            "call",
            "--session",
            "--dest",
            "org.gnome.Mutter.DisplayConfig",
            "--object-path",
            "/org/gnome/Mutter/DisplayConfig",
            "--method",
            "org.gnome.Mutter.DisplayConfig.GetCurrentState",
        ],
    );
    parse_mutter(&state, connector)
}

/// Géométrie X11 (XWayland) d'une sortie : (x, y, largeur, hauteur), d'après `xrandr --listmonitors`.
pub fn parse_xrandr(listing: &str, connector: &str) -> Option<(i32, i32, u32, u32)> {
    listing.lines().find_map(|l| {
        let f: Vec<&str> = l.split_whitespace().collect();
        if f.last() != Some(&connector) || f.len() < 3 {
            return None;
        }
        // « 3840/340x2400/220+0+1056 »
        let (size, pos) = f[2].split_once('+')?;
        let (px, py) = pos.split_once('+')?;
        let (w, h) = size.split_once('x')?;
        let num = |s: &str| s.split('/').next()?.parse().ok();
        Some((px.parse().ok()?, py.parse().ok()?, num(w)?, num(h)?))
    })
}

pub fn xrandr_output(connector: &str) -> Option<(i32, i32, u32, u32)> {
    parse_xrandr(&run("xrandr", &["--listmonitors"]), connector)
}

#[cfg(test)]
mod tests {
    use super::*;

    const STATE: &str = "(uint32 1, [(('DP-3', 'BNQ', 'BenQ RD320U', 'K6S'), [('3840x2160@60.000', 3840, 2160, 60.0, 1.25, [1.0], {'is-current': <true>, 'is-preferred': <true>}), ('3840x2160@59.968', 3840, 2160, 59.9, 1.25, [1.0], {})], {'is-builtin': <false>}), (('eDP-1', 'BOE', '0x0bc9', '0x00000000'), [('2560x1600@165.000', 2560, 1600, 165.0, 1.33, [1.0], {'is-current': <true>, 'is-preferred': <true>}), ('2560x1600@60.000', 2560, 1600, 60.0, 1.33, [1.0], {})], {'is-builtin': <true>})], [(1920, 0, 1.25, uint32 0, true, [('DP-3', 'BNQ', 'BenQ RD320U', 'K6S')], @a{sv} {}), (0, 528, 1.3333333730697632, uint32 0, false, [('eDP-1', 'BOE', '0x0bc9', '0x00000000')], @a{sv} {})], {'layout-mode': <uint32 2>})";

    #[test]
    fn mutter_geometry_and_mode() {
        let e = parse_mutter(STATE, "eDP-1").unwrap();
        assert_eq!((e.x, e.y), (0, 528));
        assert!((e.scale - 1.3333).abs() < 1e-3);
        assert_eq!(e.mode.as_deref(), Some("2560x1600@165.000"));
        let d = parse_mutter(STATE, "DP-3").unwrap();
        assert_eq!(
            (d.x, d.y, d.mode.as_deref()),
            (1920, 0, Some("3840x2160@60.000"))
        );
        assert!(parse_mutter(STATE, "HDMI-1").is_none());
        // Sortie réelle de la machine de référence, si disponible.
        if let Ok(real) = std::env::var("BENCH_MUTTER_STATE_FILE") {
            let s = std::fs::read_to_string(real).unwrap();
            eprintln!(
                "{:?} / {:?}",
                parse_mutter(&s, "eDP-1"),
                parse_mutter(&s, "DP-3")
            );
        }
    }

    #[test]
    fn xrandr_geometry() {
        let l = "Monitors: 2\n 0: +*DP-3 6144/700x3456/390+3840+0  DP-3\n 1: +eDP-1 3840/340x2400/220+0+1056  eDP-1\n";
        assert_eq!(parse_xrandr(l, "eDP-1"), Some((0, 1056, 3840, 2400)));
        assert_eq!(parse_xrandr(l, "DP-3"), Some((3840, 0, 6144, 3456)));
        assert_eq!(parse_xrandr(l, "DP-1"), None);
    }
}
