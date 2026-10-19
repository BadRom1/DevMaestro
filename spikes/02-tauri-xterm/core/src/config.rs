//! Configuration du banc, lue dans l'environnement (commune à Tauri et au mode web).

use crate::engine::run;
use crate::report::ALL_SCENARIOS;
use serde::Serialize;
use std::path::PathBuf;

/// Pic de S2 et historique rejoué en S3, pré-générés au démarrage.
pub const BURST_BYTES: usize = 5_000_000;
pub const HISTORY_BYTES: usize = 1 << 20;
/// Débit par défaut d'une session (Ko/s) : les rapports à ce débit ne portent pas `-r<N>` dans leur nom.
pub const DEFAULT_RATE_KBPS: f64 = 20.0;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub bench: bool,
    pub pty: bool,
    pub quick: bool,
    /// Vrai (défaut, prudent) : les 10 sessions traversent l'IPC. Faux (réaliste) : seules les affichées.
    pub hidden_ipc: bool,
    pub sessions: usize,
    pub rate_bytes_per_s: f64,
    pub batch_ms: u64,
    pub scenario_s: f64,
    pub warmup_s: f64,
    pub repeat: u32,
    pub scenarios: Vec<String>,
    pub renderers: Vec<String>,
    pub burst_bytes: usize,
    pub history_bytes: usize,
    /// Capture PTY rejouée en boucle à la place du générateur (`BENCH_SOURCE=replay`).
    pub replay: Option<PathBuf>,
    /// Sortie (connecteur, ex. « eDP-1 ») où mettre la fenêtre en plein écran (`BENCH_MONITOR`).
    pub monitor: Option<String>,
    pub out_dir: PathBuf,
    pub report_name: String,
    pub timeout_s: u64,
}

/// Variable d'environnement typée : absente → défaut, invalide → erreur.
pub fn env_or<T: std::str::FromStr>(name: &str, default: T) -> Result<T, String> {
    match std::env::var(name) {
        Err(_) => Ok(default),
        Ok(v) => v
            .trim()
            .parse()
            .map_err(|_| format!("{name}={v} : valeur invalide")),
    }
}

fn env_list(name: &str, default: &str, allowed: &[&str]) -> Result<Vec<String>, String> {
    let list: Vec<String> = std::env::var(name)
        .unwrap_or_else(|_| default.into())
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if let Some(bad) = list.iter().find(|s| !allowed.contains(&s.as_str())) {
        return Err(format!(
            "{name} : « {bad} » inconnu (attendu : {})",
            allowed.join(", ")
        ));
    }
    if list.is_empty() {
        return Err(format!("{name} : liste vide"));
    }
    Ok(list)
}

/// Capture rejouée par défaut (la session Claude Code réelle du prototype n° 1).
pub const DEFAULT_REPLAY: &str = "pty-raw-session-reelle-2026-10-19.bin";

/// Nom du rapport : `report[-quick]-<complet|realiste>-b<lots>[-r<débit>]` puis les marques non vides
/// dans l'ordre (rejeu, répétitions, scénarios, moteurs, écran, dmabuf, mode, suffixe, horodatage).
pub fn report_name(
    quick: bool,
    hidden_ipc: bool,
    batch_ms: u64,
    rate_kbps: f64,
    marks: &[String],
) -> String {
    let mut n = format!(
        "report{}-{}-b{batch_ms}",
        if quick { "-quick" } else { "" },
        if hidden_ipc { "complet" } else { "realiste" }
    );
    if rate_kbps != DEFAULT_RATE_KBPS {
        n += &format!("-r{rate_kbps}");
    }
    for m in marks.iter().filter(|m| !m.is_empty()) {
        n += &format!("-{m}");
    }
    n
}

impl Config {
    /// `marker` : marque du mode dans le nom du rapport (« chrome » en mode web, vide pour Tauri).
    pub fn from_env(marker: &str) -> Result<Self, String> {
        let args: Vec<String> = std::env::args().collect();
        let flag = |f: &str| args.iter().any(|a| a == f);
        let quick = std::env::var("BENCH_QUICK").is_ok_and(|v| v == "1");
        let scenario_s: f64 = env_or("BENCH_SCENARIO_S", 25.0)?;
        let warmup_s: f64 = env_or("BENCH_WARMUP_S", 3.0)?;
        let repeat: u32 = env_or("BENCH_REPEAT", 1)?;
        let batch_ms: u64 = env_or("BENCH_BATCH_MS", 10)?;
        let rate: f64 = env_or("BENCH_RATE_KBPS", DEFAULT_RATE_KBPS)?;
        let hidden_ipc = match std::env::var("BENCH_HIDDEN_IPC").as_deref() {
            Err(_) | Ok("1") | Ok("on") => true,
            Ok("0") | Ok("off") => false,
            Ok(v) => return Err(format!("BENCH_HIDDEN_IPC={v} : attendu 1/on ou 0/off")),
        };
        let replay = match std::env::var("BENCH_SOURCE").as_deref() {
            Err(_) | Ok("synth") => None,
            Ok("replay") => Some(PathBuf::from(
                std::env::var("BENCH_REPLAY_FILE")
                    .map_err(|_| "BENCH_SOURCE=replay demande BENCH_REPLAY_FILE")?,
            )),
            Ok(v) => return Err(format!("BENCH_SOURCE={v} : attendu synth ou replay")),
        };
        if scenario_s <= 0.0 || warmup_s < 0.0 || repeat == 0 || batch_ms == 0 || rate <= 0.0 {
            return Err("durées, répétitions, lots et débit doivent être positifs".into());
        }
        let scenarios = env_list("BENCH_SCENARIOS", "S0,S1,S2,S3,S4", &ALL_SCENARIOS)?;
        let renderers = env_list("BENCH_RENDERERS", "dom,webgl", &["dom", "webgl"])?;
        let monitor = std::env::var("BENCH_MONITOR")
            .ok()
            .filter(|m| !m.is_empty());
        let var = |n: &str| std::env::var(n).unwrap_or_default();
        let replay_mark = replay.as_ref().map(|p| {
            let base = p
                .file_name()
                .map_or(String::new(), |f| f.to_string_lossy().to_string());
            if base == DEFAULT_REPLAY {
                "replay".to_string()
            } else {
                format!("replay-{}", base.split('.').next().unwrap_or(&base))
            }
        });
        let marks = [
            replay_mark.unwrap_or_default(),
            if repeat > 1 {
                format!("x{repeat}")
            } else {
                String::new()
            },
            if scenarios.join(",") != "S0,S1,S2,S3,S4" {
                format!("s{}", scenarios.join(""))
            } else {
                String::new()
            },
            if renderers.join(",") != "dom,webgl" {
                renderers.join("")
            } else {
                String::new()
            },
            monitor.clone().unwrap_or_default(),
            if marker.is_empty() && var("WEBKIT_DISABLE_DMABUF_RENDERER") == "1" {
                "nodmabuf".into()
            } else {
                String::new()
            },
            marker.to_string(),
            var("BENCH_NAME"),
            // Horodatage fourni par le script (même nom pour `--print-report-name` et le passage).
            std::env::var("BENCH_STAMP").unwrap_or_else(|_| run("date", &["+%Y%m%d-%H%M%S"])),
        ];
        let default_name = report_name(quick, hidden_ipc, batch_ms, rate, &marks);
        // S0 se joue une fois par répétition, les autres une fois par moteur.
        let runs = scenarios.iter().filter(|s| *s != "S0").count() * renderers.len()
            + usize::from(scenarios.iter().any(|s| s == "S0"));
        let estimate = repeat as f64 * runs as f64 * (scenario_s + warmup_s + 8.0) + 120.0;
        Ok(Self {
            bench: flag("--bench") || std::env::var("BENCH").is_ok_and(|v| v == "1"),
            pty: flag("--pty"),
            quick,
            hidden_ipc,
            sessions: 10,
            rate_bytes_per_s: rate * 1000.0,
            batch_ms,
            scenario_s,
            warmup_s,
            repeat,
            scenarios,
            renderers,
            burst_bytes: BURST_BYTES,
            history_bytes: HISTORY_BYTES,
            replay,
            monitor: std::env::var("BENCH_MONITOR")
                .ok()
                .filter(|m| !m.is_empty()),
            out_dir: std::env::var("BENCH_OUT")
                .map(PathBuf::from)
                .unwrap_or_else(|_| "out".into()),
            report_name: std::env::var("BENCH_REPORT_NAME").unwrap_or(default_name),
            timeout_s: env_or("BENCH_TIMEOUT_S", estimate.ceil() as u64)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn report_names() {
        // Débit par défaut, sans marque : forme des anciens rapports.
        assert_eq!(
            report_name(false, false, 16, 20.0, &[]),
            "report-realiste-b16"
        );
        let m = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            report_name(
                true,
                true,
                10,
                2.0,
                &m(&["replay", "", "x3", "eDP-1", "chrome", "20261019-143000"])
            ),
            "report-quick-complet-b10-r2-replay-x3-eDP-1-chrome-20261019-143000"
        );
        assert_eq!(
            report_name(false, false, 16, 0.8, &m(&["chrome"])),
            "report-realiste-b16-r0.8-chrome"
        );
    }
}
