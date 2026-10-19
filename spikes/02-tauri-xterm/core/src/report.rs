//! Agrégation des mesures brutes envoyées par le front : validité de chaque passage,
//! critères de réussite (sur la médiane des répétitions), verdict, `report.json` / `report.md`.

use crate::sampler::CpuSummary;
use crate::stats::{share_above, Spread, Summary};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fmt::Write as _;

// Seuils du spec (docs/spikes/02-tauri-xterm.md, « Critères de réussite »).
pub const FRAME_P95_MAX_MS: f64 = 25.0;
pub const FRAME_SLOW_MS: f64 = 33.0;
pub const FRAME_SLOW_MAX_PCT: f64 = 2.0;
pub const ECHO_P95_MAX_MS: f64 = 50.0;
pub const DRAIN_MAX_MS: f64 = 3000.0;
pub const SWITCH_MAX_MS: f64 = 150.0;
pub const CPU_MAX_PCT: f64 = 25.0;
// Règles de validité d'un passage.
pub const ECHO_SEEN_MIN: f64 = 0.95;
pub const INTEGRITY_MIN_PCT: f64 = 98.0;

/// Processus de rendu dont la présence dans l'échantillonnage valide le CPU d'un passage.
#[derive(Debug, Clone, Copy)]
pub struct RenderProcess {
    pub check: &'static str,
    /// Sous-chaîne du libellé du processus (voir `sampler::label`).
    pub pattern: &'static str,
    /// Processus GPU exigé quand WebGL est actif (Chrome : `(gpu-process)`).
    pub gpu: Option<&'static str>,
}

pub const WEBKIT: RenderProcess = RenderProcess {
    check: "processus WebKit échantillonné",
    pattern: "WebKitWebProces",
    gpu: None,
};
pub const CHROME: RenderProcess = RenderProcess {
    check: "processus renderer de Chrome échantillonné",
    pattern: "(renderer)",
    gpu: Some("(gpu-process)"),
};

/// Scénarios requis par moteur pour conclure.
pub const REQUIRED: [&str; 3] = ["S1", "S2", "S3"];
pub const ALL_SCENARIOS: [&str; 5] = ["S0", "S1", "S2", "S3", "S4"];

/// Mesures brutes d'un passage (scénario × moteur × répétition), collectées par le front.
#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RawScenario {
    pub scenario: String,
    pub renderer: String,
    pub round: u32,
    /// Erreur du front pendant ce passage : le passage est invalide.
    pub error: Option<String>,
    /// « ok », « échec : … », « contexte perdu … », ou absent (DOM, S0).
    pub webgl: Option<String>,
    /// La fenêtre a été cachée pendant la mesure.
    pub hidden: bool,
    pub visible_terminals: u32,
    pub measured_ms: f64,
    pub frame_intervals_ms: Vec<f64>,
    /// Échos vus (ms).
    pub echo_ms: Vec<f64>,
    /// Échos jamais vus : borne basse (fin de passage − envoi), en ms.
    pub echo_lost_ms: Vec<f64>,
    pub echo_sent: u32,
    /// S3 : jetons abandonnés car la session a changé avant leur arrivée.
    pub echo_dropped_on_switch: u32,
    /// Échantillons (t ms depuis le début de la mesure, octets en attente dans xterm).
    pub queue_samples: Vec<[f64; 2]>,
    /// Maximum de la file, relevé à chaque écriture (pas seulement à chaque image).
    pub queue_max_bytes: f64,
    pub burst: Option<BurstRaw>,
    pub switch_ms: Vec<f64>,
    pub switch_skipped: u32,
    /// Octets de la fenêtre de mesure effectivement reçus par le front, compté sur le flux ordonné
    /// de chaque session : Σ min(reçus, envoyés à la fin) − envoyés au début.
    pub delivered_bytes: u64,
    /// Fin de la fenêtre → tous les octets de la fenêtre reçus (absent si pas dans le délai de grâce).
    pub deliver_lag_ms: Option<f64>,
    pub bytes_written: u64,
    pub bytes_acked: u64,
    pub ipc_messages: u64,
    pub ipc_small_messages: u64,
    /// Taille des terminaux affichés, « colonnes×lignes » (identique d'un moteur à l'autre : boîte fixe).
    pub terminal_size: Option<String>,
    /// La boîte fixe des terminaux tenait dans la fenêtre à la fin du passage.
    pub box_fits: Option<bool>,
    /// La fenêtre était en plein écran à la fin du passage.
    pub fullscreen: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct BurstRaw {
    pub bytes: u64,
    /// Demande du pic → dernier morceau reçu par le front.
    pub received_ms: Option<f64>,
    /// Demande du pic → dernier morceau traité par xterm + image suivante.
    pub drained_ms: Option<f64>,
    /// Dernier morceau reçu → traité : la résorption de la file de xterm (critère ≤ 3 s).
    pub queue_drain_ms: Option<f64>,
    pub queue_max_bytes: f64,
}

/// Informations d'environnement collectées par le front au début du banc.
#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct FrontEnv {
    pub user_agent: String,
    pub xterm_version: String,
    pub webgl_renderer: Option<String>,
    pub webgl_vendor: Option<String>,
    pub device_pixel_ratio: f64,
    pub window_inner: String,
    pub idle_frame_intervals_ms: Vec<f64>,
    /// Écran vu par la page : taille, position de la fenêtre, plein écran.
    pub screen: String,
    pub screen_x: f64,
    pub screen_y: f64,
    pub screen_width: f64,
    pub screen_height: f64,
    pub fullscreen: bool,
    /// Boîte fixe des terminaux (px CSS) et si elle tient dans la fenêtre.
    pub terminal_box: String,
    pub terminal_box_fits: bool,
}

impl FrontEnv {
    /// WebGL rendu par le processeur (llvmpipe, softpipe, SwiftShader…) : les cases WebGL ne valent rien.
    pub fn software_gl(&self) -> bool {
        let r = self.webgl_renderer.as_deref().unwrap_or("").to_lowercase();
        ["llvmpipe", "softpipe", "swiftshader", "software"]
            .iter()
            .any(|s| r.contains(s))
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Check {
    pub name: String,
    pub ok: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Criterion {
    pub name: String,
    pub value: Option<f64>,
    pub limit: String,
    pub pass: bool,
}

/// Un critère du spec : clé de mesure, libellé, seuil.
struct Def {
    key: &'static str,
    label: &'static str,
    limit: &'static str,
    ok: fn(f64) -> bool,
}

const FRAMES_P95: Def = Def {
    key: "frames_p95",
    label: "images p95 (ms)",
    limit: "≤ 25",
    ok: |v| v <= FRAME_P95_MAX_MS,
};
const FRAMES_SLOW: Def = Def {
    key: "frames_over33_pct",
    label: "images > 33 ms (%)",
    limit: "< 2",
    ok: |v| v < FRAME_SLOW_MAX_PCT,
};
const ECHO_P95: Def = Def {
    key: "echo_p95",
    label: "frappe p95 (ms)",
    limit: "≤ 50",
    ok: |v| v <= ECHO_P95_MAX_MS,
};
const CPU: Def = Def {
    key: "cpu_pct",
    label: "CPU moyen (% d'un cœur)",
    limit: "≤ 25",
    ok: |v| v <= CPU_MAX_PCT,
};
const DRAIN: Def = Def {
    key: "drain_ms",
    label: "pic : file reçue → vide (ms)",
    limit: "≤ 3000",
    ok: |v| v <= DRAIN_MAX_MS,
};
const SWITCH: Def = Def {
    key: "switch_p95",
    label: "changement p95 (ms)",
    limit: "≤ 150",
    ok: |v| v <= SWITCH_MAX_MS,
};

fn criteria_defs(scenario: &str) -> Vec<&'static Def> {
    match scenario {
        "S1" | "S4" => vec![&FRAMES_P95, &FRAMES_SLOW, &ECHO_P95, &CPU],
        "S2" => vec![&FRAMES_P95, &FRAMES_SLOW, &ECHO_P95, &DRAIN],
        "S3" => vec![&FRAMES_P95, &FRAMES_SLOW, &ECHO_P95, &SWITCH],
        _ => vec![],
    }
}

fn evaluate(scenario: &str, metric: impl Fn(&str) -> Option<f64>) -> Vec<Criterion> {
    criteria_defs(scenario)
        .into_iter()
        .map(|d| {
            let value = metric(d.key);
            Criterion {
                name: d.label.into(),
                value,
                limit: d.limit.into(),
                pass: value.is_some_and(d.ok),
            }
        })
        .collect()
}

/// Un passage, mesures résumées et validité.
#[derive(Debug, Clone, Serialize)]
pub struct ScenarioReport {
    pub scenario: String,
    pub renderer: String,
    pub round: u32,
    pub error: Option<String>,
    pub webgl: Option<String>,
    pub visible_terminals: u32,
    pub measured_ms: f64,
    pub frames: Summary,
    pub frames_over_33ms_pct: Option<f64>,
    /// Échos vus et bornes basses des échos perdus.
    pub echo: Summary,
    pub echo_sent: u32,
    pub echo_seen: usize,
    pub echo_lost: usize,
    pub echo_dropped_on_switch: u32,
    pub queue_max_bytes: Option<f64>,
    /// Série (t ms, octets en attente), sous-échantillonnée.
    pub queue_series: Vec<[f64; 2]>,
    pub burst: Option<BurstRaw>,
    pub switch: Summary,
    pub switch_skipped: u32,
    /// Octets envoyés par le Rust pendant la fenêtre (toutes sessions).
    pub bytes_sent_window: u64,
    pub bytes_delivered: u64,
    pub integrity_pct: Option<f64>,
    pub deliver_lag_ms: Option<f64>,
    pub bytes_written: u64,
    pub bytes_acked: u64,
    pub ipc_messages: u64,
    pub ipc_small_messages: u64,
    pub ipc_small_messages_pct: Option<f64>,
    /// Coût du transport pendant la fenêtre (surtout parlant en S0, sans xterm).
    pub transport: TransportStats,
    pub cpu: CpuSummary,
    /// Sessions dont des octets ont traversé l'IPC pendant la fenêtre.
    pub streamed_sessions: Vec<usize>,
    pub terminal_size: Option<String>,
    pub fullscreen_at_end: Option<bool>,
    pub validity: Vec<Check>,
    pub valid: bool,
    /// Critères évalués sur ce seul passage (le verdict utilise la médiane des passages).
    pub criteria: Vec<Criterion>,
    pub pass: bool,
}

/// Débit et coût CPU du transport (IPC Tauri ou WebSocket) sur la fenêtre de mesure.
#[derive(Debug, Clone, Serialize, Default)]
pub struct TransportStats {
    pub messages_per_s: Option<f64>,
    pub bytes_per_s: Option<f64>,
    pub avg_message_bytes: Option<f64>,
    /// CPU du processus backend (générateurs + envoi), en % d'un cœur.
    pub backend_cpu_pct: Option<f64>,
    /// CPU du reste de l'arbre (moteur web : réception, JS, rendu).
    pub browser_cpu_pct: Option<f64>,
    pub backend_us_per_message: Option<f64>,
    pub browser_us_per_message: Option<f64>,
}

impl TransportStats {
    fn of(messages: u64, bytes: u64, measured_ms: f64, cpu: &CpuSummary, backend: &str) -> Self {
        let secs = measured_ms / 1000.0;
        let rate = (secs > 0.0 && messages > 0).then(|| messages as f64 / secs);
        let backend_cpu = (!backend.is_empty())
            .then(|| cpu.cpu_avg_pct_by_process.get(backend).copied())
            .flatten();
        let browser_cpu = cpu
            .cpu_avg_pct
            .zip(backend_cpu)
            .map(|(all, b)| (all - b).max(0.0));
        // % d'un cœur → µs de CPU par message.
        let per_msg = |pct: Option<f64>| pct.zip(rate).map(|(p, r)| p / 100.0 * 1e6 / r);
        Self {
            messages_per_s: rate,
            bytes_per_s: (secs > 0.0).then(|| bytes as f64 / secs),
            avg_message_bytes: (messages > 0).then(|| bytes as f64 / messages as f64),
            backend_cpu_pct: backend_cpu,
            browser_cpu_pct: browser_cpu,
            backend_us_per_message: per_msg(backend_cpu),
            browser_us_per_message: per_msg(browser_cpu),
        }
    }
}

impl ScenarioReport {
    /// Passage Tauri (processus WebKit attendu, backend non distingué) : forme historique.
    pub fn build(
        raw: RawScenario,
        bytes_sent_window: u64,
        cpu: CpuSummary,
        software_gl: bool,
    ) -> Self {
        Self::build_for(raw, bytes_sent_window, cpu, software_gl, WEBKIT, "")
    }

    /// `render` : processus de rendu attendu ; `backend` : libellé du processus backend dans le CPU.
    pub fn build_for(
        raw: RawScenario,
        bytes_sent_window: u64,
        cpu: CpuSummary,
        software_gl: bool,
        render: RenderProcess,
        backend: &str,
    ) -> Self {
        let frames = Summary::of(&raw.frame_intervals_ms);
        let over33 = share_above(&raw.frame_intervals_ms, FRAME_SLOW_MS);
        let all_echo: Vec<f64> = raw
            .echo_ms
            .iter()
            .chain(&raw.echo_lost_ms)
            .copied()
            .collect();
        let echo = Summary::of(&all_echo);
        let switch = Summary::of(&raw.switch_ms);
        let queue_max = raw
            .queue_samples
            .iter()
            .map(|s| s[1])
            .chain([raw.queue_max_bytes])
            .reduce(f64::max)
            .filter(|_| raw.visible_terminals > 0);
        let integrity = (bytes_sent_window > 0)
            .then(|| 100.0 * raw.delivered_bytes as f64 / bytes_sent_window as f64);
        let pct = |a: u64, b: u64| (b > 0).then(|| 100.0 * a as f64 / b as f64);

        let mut validity = Vec::new();
        let mut check = |name: &str, ok: bool, detail: String| {
            validity.push(Check {
                name: name.into(),
                ok,
                detail,
            })
        };
        check(
            "sans erreur du front",
            raw.error.is_none(),
            raw.error.clone().unwrap_or_default(),
        );
        check(
            "fenêtre visible",
            !raw.hidden,
            if raw.hidden {
                "cachée pendant la mesure".into()
            } else {
                String::new()
            },
        );
        if raw.renderer == "webgl" {
            let w = raw.webgl.clone().unwrap_or_else(|| "absent".into());
            check("WebGL actif", w == "ok", w);
            check(
                "WebGL matériel",
                !software_gl,
                if software_gl {
                    "rendu logiciel".into()
                } else {
                    String::new()
                },
            );
        }
        let expected = raw.echo_sent.saturating_sub(raw.echo_dropped_on_switch);
        let seen = raw.echo_ms.len();
        check(
            "échos vus ≥ 95 %",
            expected > 0 && seen as f64 >= ECHO_SEEN_MIN * expected as f64,
            format!("{seen} / {expected}"),
        );
        let webkit = cpu
            .cpu_avg_pct_by_process
            .keys()
            .any(|k| k.contains(render.pattern));
        check(
            render.check,
            webkit,
            if webkit {
                String::new()
            } else {
                "CPU invalide".into()
            },
        );
        if matches!(raw.scenario.as_str(), "S0" | "S1" | "S4") {
            check(
                "octets reçus ≥ 98 % des envoyés",
                integrity.is_some_and(|v| v >= INTEGRITY_MIN_PCT),
                integrity.map_or("—".into(), |v| format!("{v:.1} %")),
            );
        }
        if let Some(gpu) = render.gpu {
            if raw.renderer == "webgl" && raw.webgl.as_deref() == Some("ok") {
                let seen = cpu.cpu_avg_pct_by_process.keys().any(|k| k.contains(gpu));
                check(
                    "processus GPU de Chrome échantillonné",
                    seen,
                    if seen {
                        String::new()
                    } else {
                        "WebGL sans processus GPU : rendu suspect".into()
                    },
                );
            }
        }
        if let Some(fits) = raw.box_fits {
            check(
                "boîte des terminaux dans la fenêtre",
                fits,
                if fits {
                    String::new()
                } else {
                    "fenêtre trop petite : terminaux rognés".into()
                },
            );
        }
        let valid = validity.iter().all(|c| c.ok);
        let transport = TransportStats::of(
            raw.ipc_messages,
            bytes_sent_window,
            raw.measured_ms,
            &cpu,
            backend,
        );

        let mut r = Self {
            scenario: raw.scenario,
            renderer: raw.renderer,
            round: raw.round,
            error: raw.error,
            webgl: raw.webgl,
            visible_terminals: raw.visible_terminals,
            measured_ms: raw.measured_ms,
            frames,
            frames_over_33ms_pct: over33,
            echo,
            echo_sent: raw.echo_sent,
            echo_seen: seen,
            echo_lost: raw.echo_lost_ms.len(),
            echo_dropped_on_switch: raw.echo_dropped_on_switch,
            queue_max_bytes: queue_max,
            queue_series: downsample(&raw.queue_samples, 300),
            burst: raw.burst,
            switch,
            switch_skipped: raw.switch_skipped,
            bytes_sent_window,
            bytes_delivered: raw.delivered_bytes,
            integrity_pct: integrity,
            deliver_lag_ms: raw.deliver_lag_ms,
            bytes_written: raw.bytes_written,
            bytes_acked: raw.bytes_acked,
            ipc_messages: raw.ipc_messages,
            ipc_small_messages: raw.ipc_small_messages,
            ipc_small_messages_pct: pct(raw.ipc_small_messages, raw.ipc_messages),
            transport,
            cpu,
            streamed_sessions: Vec::new(),
            terminal_size: raw.terminal_size,
            fullscreen_at_end: raw.fullscreen,
            validity,
            valid,
            criteria: Vec::new(),
            pass: false,
        };
        r.criteria = evaluate(&r.scenario, |k| r.metric(k));
        r.pass = r.criteria.iter().all(|c| c.pass);
        r
    }

    /// Valeur d'une mesure par clé (utilisée pour les critères et les médianes).
    pub fn metric(&self, key: &str) -> Option<f64> {
        let b = self.burst.as_ref();
        match key {
            "frames_p95" => self.frames.p95,
            "frames_p50" => self.frames.p50,
            "frames_over33_pct" => self.frames_over_33ms_pct,
            "echo_p95" => self.echo.p95,
            "echo_p50" => self.echo.p50,
            "queue_max_bytes" => self.queue_max_bytes,
            "drain_ms" => b.and_then(|b| b.queue_drain_ms),
            "burst_received_ms" => b.and_then(|b| b.received_ms),
            "burst_drained_ms" => b.and_then(|b| b.drained_ms),
            "switch_p95" => self.switch.p95,
            "switch_p50" => self.switch.p50,
            "cpu_pct" => self.cpu.cpu_avg_pct,
            "rss_mb" => self.cpu.rss_max_mb,
            "integrity_pct" => self.integrity_pct,
            "msgs_per_s" => self.transport.messages_per_s,
            "kbytes_per_s" => self.transport.bytes_per_s.map(|v| v / 1000.0),
            "avg_msg_bytes" => self.transport.avg_message_bytes,
            "backend_cpu_pct" => self.transport.backend_cpu_pct,
            "browser_cpu_pct" => self.transport.browser_cpu_pct,
            "backend_us_per_msg" => self.transport.backend_us_per_message,
            "browser_us_per_msg" => self.transport.browser_us_per_message,
            _ => None,
        }
    }

    /// Ajoute une règle de validité décidée par l'hôte (écran atteint…).
    pub fn add_check(&mut self, name: &str, ok: bool, detail: String) {
        self.validity.push(Check {
            name: name.into(),
            ok,
            detail,
        });
        self.valid = self.validity.iter().all(|c| c.ok);
    }

    pub fn invalid_reasons(&self) -> Vec<String> {
        self.validity
            .iter()
            .filter(|c| !c.ok)
            .map(|c| {
                if c.detail.is_empty() {
                    c.name.clone()
                } else {
                    format!("{} ({})", c.name, c.detail)
                }
            })
            .collect()
    }
}

/// Garde au plus `max` points, en conservant le maximum de chaque paquet.
fn downsample(series: &[[f64; 2]], max: usize) -> Vec<[f64; 2]> {
    if series.len() <= max {
        return series.to_vec();
    }
    let step = series.len().div_ceil(max);
    series
        .chunks(step)
        .map(|c| *c.iter().max_by(|a, b| a[1].total_cmp(&b[1])).unwrap())
        .collect()
}

const CELL_METRICS: &[&str] = &[
    "frames_p95",
    "frames_p50",
    "frames_over33_pct",
    "echo_p95",
    "echo_p50",
    "queue_max_bytes",
    "drain_ms",
    "burst_received_ms",
    "burst_drained_ms",
    "switch_p95",
    "switch_p50",
    "cpu_pct",
    "rss_mb",
    "integrity_pct",
    "msgs_per_s",
    "kbytes_per_s",
    "avg_msg_bytes",
    "backend_cpu_pct",
    "browser_cpu_pct",
    "backend_us_per_msg",
    "browser_us_per_msg",
];

/// Une case du tableau : un scénario × un moteur, sur toutes les répétitions.
#[derive(Debug, Clone, Serialize)]
pub struct Cell {
    pub scenario: String,
    pub renderer: String,
    pub runs: usize,
    /// Tous les passages sont valides.
    pub valid: bool,
    pub invalid_reasons: Vec<String>,
    pub metrics: BTreeMap<String, Spread>,
    /// Critères évalués sur la médiane des passages.
    pub criteria: Vec<Criterion>,
    pub pass: bool,
    pub informative: bool,
}

pub fn cells(runs: &[ScenarioReport]) -> Vec<Cell> {
    let mut keys: Vec<(String, String)> = Vec::new();
    for r in runs {
        let k = (r.scenario.clone(), r.renderer.clone());
        if !keys.contains(&k) {
            keys.push(k);
        }
    }
    keys.sort_by_key(|(s, r)| (ALL_SCENARIOS.iter().position(|x| x == s), r.clone()));
    keys.into_iter()
        .map(|(scenario, renderer)| {
            let rs: Vec<&ScenarioReport> = runs
                .iter()
                .filter(|r| r.scenario == scenario && r.renderer == renderer)
                .collect();
            let mut metrics = BTreeMap::new();
            for &k in CELL_METRICS {
                let vals: Vec<f64> = rs.iter().filter_map(|r| r.metric(k)).collect();
                if let Some(s) = Spread::of(&vals) {
                    metrics.insert(k.to_string(), s);
                }
            }
            let mut invalid_reasons = Vec::new();
            for r in &rs {
                for why in r.invalid_reasons() {
                    invalid_reasons.push(format!("passage {} : {why}", r.round + 1));
                }
            }
            let criteria = evaluate(&scenario, |k| metrics.get(k).map(|s| s.median));
            Cell {
                informative: !REQUIRED.contains(&scenario.as_str()),
                pass: !criteria.is_empty() && criteria.iter().all(|c| c.pass),
                valid: invalid_reasons.is_empty(),
                runs: rs.len(),
                invalid_reasons,
                metrics,
                criteria,
                scenario,
                renderer,
            }
        })
        .collect()
}

#[derive(Debug, Clone, Serialize)]
pub struct Conclusion {
    /// « RÉUSSI », « ÉCHEC » ou « INCOMPLET ».
    pub verdict: String,
    pub reasons: Vec<String>,
    /// Par moteur demandé : « réussi », « échec » ou « incomplet » (S1–S3).
    pub by_renderer: BTreeMap<String, String>,
    pub best_renderer: Option<String>,
    /// S4 (informatif) par moteur.
    pub mosaic: BTreeMap<String, String>,
}

pub fn conclude(
    cells: &[Cell],
    renderers: &[String],
    partial: bool,
    errors: &[String],
) -> Conclusion {
    let mut reasons = Vec::new();
    let mut by_renderer = BTreeMap::new();
    let mut mosaic = BTreeMap::new();
    let mut passing: Vec<(String, f64)> = Vec::new();
    for r in renderers {
        let mut state = "réussi";
        let mut p95 = Vec::new();
        for s in REQUIRED {
            match cells.iter().find(|c| c.scenario == s && &c.renderer == r) {
                None => {
                    reasons.push(format!("{s} · {} absent", label(r)));
                    state = "incomplet";
                }
                Some(c) if !c.valid => {
                    reasons.push(format!(
                        "{s} · {} invalide : {}",
                        label(r),
                        c.invalid_reasons.join(" ; ")
                    ));
                    state = "incomplet";
                }
                Some(c) => {
                    if !c.pass && state == "réussi" {
                        state = "échec";
                    }
                    p95.extend(c.metrics.get("frames_p95").map(|s| s.median));
                }
            }
        }
        if state == "réussi" {
            passing.push((r.clone(), p95.iter().sum::<f64>() / p95.len().max(1) as f64));
        }
        by_renderer.insert(r.clone(), state.to_string());
        if let Some(c) = cells
            .iter()
            .find(|c| c.scenario == "S4" && &c.renderer == r)
        {
            let s = if !c.valid {
                "invalide"
            } else if c.pass {
                "réussi"
            } else {
                "échec"
            };
            mosaic.insert(r.clone(), s.to_string());
        }
    }
    if partial {
        reasons.insert(0, "rapport partiel (garde-fou)".into());
    }
    for e in errors {
        reasons.push(format!("erreur du front : {e}"));
    }
    passing.sort_by(|a, b| a.1.total_cmp(&b.1));
    let best_renderer = passing.first().map(|(r, _)| r.clone());
    let verdict = if partial || !errors.is_empty() {
        "INCOMPLET"
    } else if best_renderer.is_some() {
        "RÉUSSI"
    } else if by_renderer.values().any(|s| s == "incomplet") || renderers.is_empty() {
        "INCOMPLET"
    } else {
        "ÉCHEC"
    };
    Conclusion {
        verdict: verdict.into(),
        reasons,
        by_renderer,
        best_renderer,
        mosaic,
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Report {
    /// Ce qui doit être identique entre deux rapports comparés (`compare-reports.py`).
    pub parity: Parity,
    /// « Tauri + xterm.js » ou « Chrome + xterm.js (mode web) ».
    pub title: String,
    /// Moteur web et version (WebKitGTK …, Chromium …).
    pub engine: String,
    /// IPC Tauri ou WebSocket.
    pub transport: String,
    pub generated_at: String,
    /// Écrit par le garde-fou : le banc ne s'est pas terminé.
    pub partial: bool,
    pub quick: bool,
    /// Vrai : les 10 sessions traversent l'IPC (prudent). Faux : seules les sessions affichées (réaliste).
    pub hidden_ipc: bool,
    pub batch_ms: u64,
    pub header: BTreeMap<String, String>,
    pub env: BTreeMap<String, String>,
    pub front: FrontEnv,
    pub software_gl: bool,
    pub idle_frames: Summary,
    pub refresh_hz_estimate: Option<f64>,
    pub ipc_encoding: String,
    pub conclusion: Conclusion,
    pub cells: Vec<Cell>,
    /// Tous les passages, dans l'ordre.
    pub runs: Vec<ScenarioReport>,
    pub errors: Vec<String>,
    pub notes: Vec<String>,
}

/// Conditions à comparer entre deux rapports (WebKitGTK contre Chromium).
#[derive(Debug, Clone, Serialize, Default)]
pub struct Parity {
    pub device_pixel_ratio: f64,
    pub terminals_single: Option<String>,
    pub terminals_grid: Option<String>,
    pub refresh_hz_estimate: Option<f64>,
    pub rate_kbps: f64,
    pub source: String,
    pub batch_ms: u64,
    pub hidden_ipc: bool,
    pub dist_hash: String,
    pub monitor: Option<String>,
    pub monitor_reached: Option<bool>,
}

pub const IPC_ENCODING: &str = "Chaque lot est envoyé par un `tauri::ipc::Channel` en `InvokeResponseBody::Raw(Vec<u8>)`. \
Tauri 2.12 choisit selon la taille : moins de 1024 octets, le Rust fait un `webview.eval()` d'un littéral JS \
`new Uint8Array([27,91,…]).buffer` (texte ~3,5× plus gros que les octets, à parser par JavaScriptCore) ; \
à partir de 1024 octets, le lot est mis en file côté Rust et le JS le récupère par une requête sur le protocole \
IPC personnalisé (`plugin:__TAURI_CHANNEL__|fetch`), en binaire brut (ArrayBuffer, sans base64). \
À ~20 Ko/s par session et des lots de 10 ms, presque tous les messages (~200 o) passent par `eval` ; \
`--batch-ms 50` permet de comparer avec des lots plus gros.";

pub const NOTES: &[&str] = &[
    "S0 (témoin) : même flux IPC que S1 (selon le mode, 10 sessions ou une seule), tampons JS, aucun terminal. \
     Il isole le coût de l'IPC et de la génération de celui de xterm. Son écho est mesuré à la réception du jeton (pas de rendu).",
    "Écho : de l'envoi de la commande au backend jusqu'à l'image qui suit le callback de `write` de xterm (rendu émis, \
     pas forcément peint à l'écran). Un écho jamais vu compte avec une borne basse (fin du passage − envoi).",
    "S2 : le critère « ≤ 3 s » porte sur la file de xterm (dernier morceau reçu → traité). La demande → reçu (IPC) \
     et la demande → affiché sont données à côté.",
    "S3 : le changement écrit `ESC c` (RIS) puis l'historique, dans la file de xterm (un `reset()` direct passerait avant \
     les écritures encore en attente). Mode prudent : l'historique vient du tampon JS. Mode réaliste : le front le demande \
     au Rust, qui l'envoie par le canal (chemin `fetch`) puis enchaîne sur le direct ; le temps court de la demande \
     à l'image qui suit l'écriture de l'historique et du premier lot direct. Un changement ne démarre pas tant que le précédent n'est pas affiché ; \
     les jetons d'écho en vol vers l'ancienne session sont abandonnés et comptés à part.",
    "Avec plusieurs répétitions, l'ordre des moteurs alterne (DOM → WebGL, puis WebGL → DOM) ; \
     les critères portent sur la médiane, min et max sont donnés entre parenthèses.",
    "Intégrité : octets reçus par la page entre ses envois de mark_start et de mark_end (avant toute réponse), \
     rapportés aux octets envoyés par le backend entre ces deux marques ; même méthode pour l'IPC Tauri et la WebSocket. \
     Délai de livraison : de l'envoi de mark_end à la réception de tout ce que le backend avait envoyé.",
    "Validité supplémentaire : avec `--monitor`, l'écran demandé doit être atteint et la fenêtre en plein écran ; \
     la boîte fixe des terminaux doit tenir dans la fenêtre. CPU « hors total » : gnome-shell et Xwayland, mesurés à part.",
    "Transport : messages/s et Ko/s sur la fenêtre de mesure ; le CPU par message divise le CPU moyen (backend, \
     ou reste de l'arbre = moteur web) par le nombre de messages par seconde. Seul S0 (sans xterm) l'isole du rendu.",
];

/// Remarques propres au mode Tauri.
pub const TAURI_NOTES: &[&str] = &[
    "CPU : somme de l'app (générateurs compris) et de ses descendants (WebKitWebProcess, WebKitNetworkProcess, bwrap…). \
     Le compositeur (gnome-shell) n'est pas compté. La fenêtre est alignée sur les échantillons à 1 s. \
     La RSS est une somme par processus : les pages partagées sont comptées plusieurs fois.",
    "Si les critères échouent : relancer le même front dans Chromium pour savoir si le problème vient de WebKitGTK ou du code.",
    "Transport, colonne « backend » : en mode Tauri, le processus de l'app est aussi le processus d'interface de la webview \
     (boucle GTK, envoi des `eval`, composition) ; en mode web, ce travail est côté Chrome (navigateur, GPU). \
     Comparer les moteurs sur le total ou sur S0, pas sur la seule colonne backend.",
];

/// Remarques propres au mode web (Chrome).
pub const WEB_NOTES: &[&str] = &[
    "Mode web : même front, mêmes scénarios, mêmes générateurs et mêmes lots que le mode Tauri ; seuls changent \
     le moteur (Chromium au lieu de WebKitGTK) et le transport (WebSocket au lieu de l'IPC Tauri). S0 mesure ce transport.",
    "CPU : somme de bench-web (générateurs + serveur) et de l'instance Chrome qu'il lance (navigateur, zygotes, \
     renderer, GPU, utilitaires, tous descendants), par rôle (`--type=`). Le compositeur (gnome-shell) n'est pas compté ; \
     `chrome_crashpad_handler`, détaché de l'arbre, non plus (négligeable). La fenêtre est alignée sur les échantillons à 1 s. \
     La RSS est une somme par processus : les pages partagées sont comptées plusieurs fois.",
    "Profil Chrome jetable (`out/chrome-profile`), supprimé avant chaque passage (démarrage à froid, comme Tauri) ; \
     tâches de fond réseau, mises à jour de composants et synchronisation coupées pour limiter le bruit ; ralentissement \
     des fenêtres masquées et des minuteries de fond désactivé (voir « drapeaux Chrome »).",
    "GPU : un passage WebGL exige un processus `chrome (gpu-process)` échantillonné. L'état des fonctions GPU de Chrome \
     (chrome://gpu) n'est pas relevé ; seul le renderer WebGL annoncé à la page l'est (ligne « GPU (WebGL) »).",
];

pub const WS_ENCODING: &str = "Chaque lot part en trame WebSocket binaire (un octet d'identifiant de session, puis les \
octets bruts), sur une seule connexion locale (127.0.0.1, TCP_NODELAY). Les commandes (écho, pic, changement, marques) \
sont des trames texte JSON `{id, cmd, args}`, réponses `{id, ok, result | error}`, mêmes noms et arguments que les \
commandes Tauri. Aucun chemin `eval` : la colonne « < 1 Ko » n'est ici qu'une distribution des tailles.";

fn fmt_ms(v: Option<f64>) -> String {
    v.map_or("—".into(), |v| format!("{v:.1} ms"))
}

fn fmt_bytes(v: f64) -> String {
    if v >= 1e6 {
        format!("{:.2} Mo", v / 1e6)
    } else if v >= 1e3 {
        format!("{:.0} Ko", v / 1e3)
    } else {
        format!("{v:.0} o")
    }
}

fn label(r: &str) -> &str {
    match r {
        "webgl" => "WebGL",
        "dom" => "DOM",
        "none" => "—",
        other => other,
    }
}

impl Cell {
    /// « médiane » ou « médiane (min–max) » selon le nombre de passages.
    fn show(&self, key: &str, f: fn(f64) -> String) -> String {
        match self.metrics.get(key) {
            None => "—".into(),
            Some(s) if s.n > 1 => format!("{} ({}–{})", f(s.median), f(s.min), f(s.max)),
            Some(s) => f(s.median),
        }
    }
}

impl Report {
    pub fn to_markdown(&self) -> String {
        let ms = |v: f64| format!("{v:.1} ms");
        let pct = |v: f64| format!("{v:.1} %");
        let cpu = |v: f64| format!("{v:.0} %");
        let mut md = String::new();
        let _ = writeln!(
            md,
            "# Prototype n° 2 : rapport du banc d'essai {}\n",
            self.title
        );
        let mut kind = String::new();
        if self.quick {
            kind.push_str(" — **passage rapide (--quick), non concluant**");
        }
        if self.partial {
            kind.push_str(" — **RAPPORT PARTIEL**");
        }
        let _ = writeln!(
            md,
            "Généré le {}{kind}. Mode {}, lots de {} ms.\n",
            self.generated_at,
            if self.hidden_ipc {
                "prudent (les 10 sessions traversent l'IPC)"
            } else {
                "réaliste (seules les sessions affichées traversent l'IPC)"
            },
            self.batch_ms
        );
        let _ = writeln!(
            md,
            "Moteur web : **{}**. Transport : **{}**.\n",
            self.engine, self.transport
        );

        let c = &self.conclusion;
        let _ = write!(md, "## Verdict : {}", c.verdict);
        if let Some(b) = &c.best_renderer {
            let _ = write!(md, " (meilleur moteur : {})", label(b));
        }
        let _ = writeln!(md, "\n");
        for (r, s) in &c.by_renderer {
            let _ = writeln!(md, "- {} : S1–S3 {s}", label(r));
        }
        for (r, s) in &c.mosaic {
            let _ = writeln!(md, "- {} : S4 (mosaïque, informatif) {s}", label(r));
        }
        for why in &c.reasons {
            let _ = writeln!(md, "- ⚠ {why}");
        }

        let _ = writeln!(md, "\n## En-tête\n");
        for (k, v) in &self.header {
            let _ = writeln!(md, "- {k} : {v}");
        }

        let _ = writeln!(md, "\n## Résultats\n");
        let _ = writeln!(md, "| Scénario | Moteur | Images p95 / > 33 ms | Frappe p95 | File max / retour à zéro | Changement | CPU moyen | Verdict |");
        let _ = writeln!(md, "|---|---|---|---|---|---|---|---|");
        for cell in &self.cells {
            let frames = format!(
                "{} / {}",
                cell.show("frames_p95", ms),
                cell.show("frames_over33_pct", pct)
            );
            let queue = format!(
                "{} / {}",
                cell.show("queue_max_bytes", fmt_bytes),
                cell.show("drain_ms", ms)
            );
            let switch = if cell.scenario == "S3" {
                cell.show("switch_p95", ms)
            } else {
                "—".into()
            };
            let failed: Vec<&str> = cell
                .criteria
                .iter()
                .filter(|c| !c.pass)
                .map(|c| c.name.as_str())
                .collect();
            let mut verdict = if !cell.valid {
                "INVALIDE".to_string()
            } else if cell.criteria.is_empty() {
                "témoin".to_string()
            } else if cell.pass {
                "OK".to_string()
            } else {
                format!("ÉCHEC ({})", failed.join(", "))
            };
            if cell.informative && !cell.criteria.is_empty() {
                verdict = format!("info : {verdict}");
            }
            let _ = writeln!(
                md,
                "| {} | {} | {} | {} | {} | {} | {} | {} |",
                cell.scenario,
                label(&cell.renderer),
                frames,
                cell.show("echo_p95", ms),
                queue,
                switch,
                cell.show("cpu_pct", cpu),
                verdict
            );
        }
        let runs = self.cells.iter().map(|c| c.runs).max().unwrap_or(0);
        if runs > 1 {
            let _ = writeln!(
                md,
                "\nMédiane sur {runs} passages, (min–max) entre parenthèses."
            );
        }

        let _ = writeln!(md, "\n## Critères et validité, case par case\n");
        for cell in &self.cells {
            let _ = write!(md, "- **{} · {}** :", cell.scenario, label(&cell.renderer));
            for c in &cell.criteria {
                let v = c.value.map_or("absent".into(), |v| format!("{v:.1}"));
                let _ = write!(
                    md,
                    " {} = {} ({}) {} ;",
                    c.name,
                    v,
                    c.limit,
                    if c.pass { "✓" } else { "✗" }
                );
            }
            if cell.valid {
                let _ = writeln!(md, " valide.");
            } else {
                let _ = writeln!(md, " **invalide** : {}.", cell.invalid_reasons.join(" ; "));
            }
        }

        let _ = writeln!(md, "\n## Compléments\n");
        let _ = writeln!(md, "| Scénario | Moteur | Images p50 | Frappe p50 | Pic : demande → reçu / → affiché | Changement p50 | Octets reçus / envoyés | RSS max |");
        let _ = writeln!(md, "|---|---|---|---|---|---|---|---|");
        for cell in &self.cells {
            let burst = if cell.scenario == "S2" {
                format!(
                    "{} / {}",
                    cell.show("burst_received_ms", ms),
                    cell.show("burst_drained_ms", ms)
                )
            } else {
                "—".into()
            };
            let switch = if cell.scenario == "S3" {
                cell.show("switch_p50", ms)
            } else {
                "—".into()
            };
            let _ = writeln!(
                md,
                "| {} | {} | {} | {} | {} | {} | {} | {} |",
                cell.scenario,
                label(&cell.renderer),
                cell.show("frames_p50", ms),
                cell.show("echo_p50", ms),
                burst,
                switch,
                cell.show("integrity_pct", pct),
                cell.show("rss_mb", |v| format!("{v:.0} Mo")),
            );
        }

        let _ = writeln!(md, "\n## Transport\n");
        let _ = writeln!(md, "| Scénario | Moteur | Messages/s | Ko/s | Taille moyenne | CPU backend | CPU moteur web | µs CPU / message (backend / moteur web) |");
        let _ = writeln!(md, "|---|---|---|---|---|---|---|---|");
        for cell in &self.cells {
            let _ = writeln!(
                md,
                "| {} | {} | {} | {} | {} | {} | {} | {} / {} |",
                cell.scenario,
                label(&cell.renderer),
                cell.show("msgs_per_s", |v| format!("{v:.0}")),
                cell.show("kbytes_per_s", |v| format!("{v:.1}")),
                cell.show("avg_msg_bytes", fmt_bytes),
                cell.show("backend_cpu_pct", cpu),
                cell.show("browser_cpu_pct", cpu),
                cell.show("backend_us_per_msg", |v| format!("{v:.0}")),
                cell.show("browser_us_per_msg", |v| format!("{v:.0}")),
            );
        }

        let _ = writeln!(md, "\n## Passages\n");
        let _ = writeln!(md, "| # | Scénario | Moteur | Valide | Images p95 | Écho vus / perdus / abandonnés / envoyés | Messages IPC (< 1 Ko) | Changements sautés | Sessions sur l'IPC | CPU par processus | Hors total (compositeur) |");
        let _ = writeln!(md, "|---|---|---|---|---|---|---|---|---|---|---|");
        for r in &self.runs {
            let per_proc: Vec<String> = r
                .cpu
                .cpu_avg_pct_by_process
                .iter()
                .filter(|(_, v)| **v >= 0.5)
                .map(|(k, v)| format!("{k} {v:.0} %"))
                .collect();
            let _ = writeln!(
                md,
                "| {} | {} | {} | {} | {} | {} / {} / {} / {} | {} ({}) | {} | {} | {} | {} |",
                r.round + 1,
                r.scenario,
                label(&r.renderer),
                if r.valid {
                    "oui".to_string()
                } else {
                    format!("non : {}", r.invalid_reasons().join(" ; "))
                },
                fmt_ms(r.frames.p95),
                r.echo_seen,
                r.echo_lost,
                r.echo_dropped_on_switch,
                r.echo_sent,
                r.ipc_messages,
                r.ipc_small_messages_pct
                    .map_or("—".into(), |v| format!("{v:.0} %")),
                r.switch_skipped,
                if r.streamed_sessions.is_empty() {
                    "—".to_string()
                } else {
                    format!("{:?}", r.streamed_sessions)
                },
                per_proc.join(", "),
                r.cpu
                    .outside_cpu_avg_pct_by_process
                    .iter()
                    .map(|(k, v)| format!("{k} {v:.0} %"))
                    .collect::<Vec<_>>()
                    .join(", "),
            );
        }

        let _ = writeln!(md, "\n## Environnement\n");
        for (k, v) in &self.env {
            let _ = writeln!(md, "- {k} : {v}");
        }
        let f = &self.front;
        let _ = writeln!(md, "- user agent : {}", f.user_agent);
        let _ = writeln!(md, "- xterm.js : {}", f.xterm_version);
        let _ = writeln!(
            md,
            "- GPU (WebGL) : {} / {}{}",
            f.webgl_vendor.as_deref().unwrap_or("?"),
            f.webgl_renderer.as_deref().unwrap_or("?"),
            if self.software_gl {
                " — **rendu logiciel : cases WebGL invalides**"
            } else {
                ""
            }
        );
        let _ = writeln!(
            md,
            "- fenêtre : {} (devicePixelRatio {}) ; écran vu par la page : {} ; boîte des terminaux : {}{}",
            f.window_inner,
            f.device_pixel_ratio,
            f.screen,
            f.terminal_box,
            if f.terminal_box_fits || f.terminal_box.is_empty() {
                ""
            } else {
                " — **ne tient pas dans la fenêtre (rognée)**"
            }
        );
        let _ = writeln!(
            md,
            "- images au repos (3 s) : p50 {}, p95 {} → ~{} Hz",
            fmt_ms(self.idle_frames.p50),
            fmt_ms(self.idle_frames.p95),
            self.refresh_hz_estimate
                .map_or("?".into(), |v| format!("{v:.0}"))
        );
        let _ = writeln!(md, "\n## Encodage du transport\n\n{}", self.ipc_encoding);
        if !self.errors.is_empty() {
            let _ = writeln!(md, "\n## Erreurs\n");
            for e in &self.errors {
                let _ = writeln!(md, "- {e}");
            }
        }
        let _ = writeln!(md, "\n## Remarques\n");
        for n in &self.notes {
            let _ = writeln!(md, "- {n}");
        }
        md
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(scenario: &str, renderer: &str, frame: f64) -> RawScenario {
        RawScenario {
            scenario: scenario.into(),
            renderer: renderer.into(),
            webgl: (renderer == "webgl").then(|| "ok".into()),
            visible_terminals: 1,
            frame_intervals_ms: vec![frame; 100],
            echo_ms: vec![10.0; 20],
            echo_sent: 20,
            switch_ms: vec![80.0; 10],
            delivered_bytes: 1000,
            burst: Some(BurstRaw {
                queue_drain_ms: Some(1200.0),
                drained_ms: Some(4000.0),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    fn cpu(pct: f64) -> CpuSummary {
        let mut c = CpuSummary {
            cpu_avg_pct: Some(pct),
            ..Default::default()
        };
        c.cpu_avg_pct_by_process
            .insert("WebKitWebProces".into(), pct / 2.0);
        c
    }

    fn run(r: RawScenario, c: f64) -> ScenarioReport {
        ScenarioReport::build(r, 1000, cpu(c), false)
    }

    fn renderers() -> Vec<String> {
        vec!["dom".into(), "webgl".into()]
    }

    fn full(dom_frame: f64, webgl_frame: f64) -> Vec<ScenarioReport> {
        let mut v = Vec::new();
        for (r, f) in [("dom", dom_frame), ("webgl", webgl_frame)] {
            for s in ["S1", "S2", "S3", "S4"] {
                v.push(run(raw(s, r, f), 10.0));
            }
        }
        v
    }

    #[test]
    fn criteria_per_run() {
        let r = run(raw("S1", "dom", 40.0), 10.0);
        assert!(r.valid && !r.pass);
        // Le critère du pic porte sur la file (1,2 s), pas sur demande → affiché (4 s).
        assert!(run(raw("S2", "dom", 16.7), 10.0).pass);
        // Le CPU ne compte qu'en S1 / S4.
        assert!(run(raw("S3", "dom", 16.7), 90.0).pass);
    }

    #[test]
    fn best_renderer_is_the_one_that_passes() {
        let c = conclude(&cells(&full(16.7, 40.0)), &renderers(), false, &[]);
        assert_eq!(c.verdict, "RÉUSSI");
        assert_eq!(c.best_renderer.as_deref(), Some("dom"));
        // Les deux passent : le meilleur p95 l'emporte.
        let c = conclude(&cells(&full(20.0, 16.7)), &renderers(), false, &[]);
        assert_eq!(c.best_renderer.as_deref(), Some("webgl"));
        let c = conclude(&cells(&full(40.0, 40.0)), &renderers(), false, &[]);
        assert_eq!(c.verdict, "ÉCHEC");
    }

    #[test]
    fn webgl_fallback_is_invalid() {
        let mut runs = full(40.0, 16.7);
        for r in runs.iter_mut().filter(|r| r.renderer == "webgl") {
            let mut x = raw(&r.scenario, "webgl", 16.7);
            x.webgl = Some("échec : WebGL2 not supported".into());
            *r = run(x, 10.0);
        }
        let c = conclude(&cells(&runs), &renderers(), false, &[]);
        assert_eq!(c.verdict, "INCOMPLET");
        assert_eq!(c.by_renderer["webgl"], "incomplet");
        // Rendu logiciel : invalide aussi.
        let r = ScenarioReport::build(raw("S1", "webgl", 16.7), 1000, cpu(10.0), true);
        assert!(!r.valid);
    }

    #[test]
    fn missing_scenario_partial_or_errors_are_incomplete() {
        let runs: Vec<_> = full(16.7, 16.7)
            .into_iter()
            .filter(|r| r.scenario != "S2")
            .collect();
        assert_eq!(
            conclude(&cells(&runs), &renderers(), false, &[]).verdict,
            "INCOMPLET"
        );
        let all = cells(&full(16.7, 16.7));
        assert_eq!(conclude(&all, &renderers(), true, &[]).verdict, "INCOMPLET");
        assert_eq!(
            conclude(&all, &renderers(), false, &["boum".into()]).verdict,
            "INCOMPLET"
        );
        assert_eq!(conclude(&all, &renderers(), false, &[]).verdict, "RÉUSSI");
    }

    #[test]
    fn validity_rules() {
        // Échos vus < 95 % des attendus.
        let mut x = raw("S1", "dom", 16.7);
        x.echo_ms = vec![10.0; 18];
        x.echo_lost_ms = vec![300.0; 2];
        let r = run(x, 10.0);
        assert!(!r.valid);
        assert_eq!(r.echo.n, 20, "les perdus comptent en borne basse");
        // Les jetons abandonnés au changement de session ne comptent pas comme attendus.
        let mut x = raw("S3", "dom", 16.7);
        x.echo_ms = vec![10.0; 15];
        x.echo_dropped_on_switch = 5;
        assert!(run(x, 10.0).valid);
        // Pas de WebKitWebProcess dans l'échantillonnage : invalide.
        let r = ScenarioReport::build(raw("S1", "dom", 16.7), 1000, CpuSummary::default(), false);
        assert!(!r.valid);
        // Intégrité < 98 % en S1.
        let r = ScenarioReport::build(raw("S1", "dom", 16.7), 2000, cpu(10.0), false);
        assert!(!r.valid);
        // Erreur du front.
        let mut x = raw("S2", "dom", 16.7);
        x.error = Some("boum".into());
        assert!(!run(x, 10.0).valid);
    }

    #[test]
    fn medians_over_repeats() {
        let mut runs = full(16.7, 16.7);
        let mut slow = raw("S1", "dom", 40.0);
        slow.round = 1;
        runs.push(run(slow, 10.0));
        let mut ok = raw("S1", "dom", 16.7);
        ok.round = 2;
        runs.push(run(ok, 10.0));
        let cs = cells(&runs);
        let s1 = cs
            .iter()
            .find(|c| c.scenario == "S1" && c.renderer == "dom")
            .unwrap();
        assert_eq!(s1.runs, 3);
        let p = s1.metrics["frames_p95"];
        assert_eq!((p.median, p.max), (16.7, 40.0));
        assert!(s1.pass);
    }

    #[test]
    fn markdown_renders() {
        let runs = full(16.7, 40.0);
        let cs = cells(&runs);
        let report = Report {
            parity: Parity::default(),
            title: "Tauri + xterm.js".into(),
            engine: "WebKitGTK".into(),
            transport: "IPC Tauri".into(),
            generated_at: "maintenant".into(),
            partial: false,
            quick: true,
            hidden_ipc: false,
            batch_ms: 16,
            header: BTreeMap::new(),
            env: BTreeMap::new(),
            front: FrontEnv::default(),
            software_gl: false,
            idle_frames: Summary::of(&[16.7; 10]),
            refresh_hz_estimate: Some(60.0),
            ipc_encoding: IPC_ENCODING.into(),
            conclusion: conclude(&cs, &renderers(), false, &[]),
            cells: cs,
            runs,
            errors: vec![],
            notes: NOTES.iter().map(|s| s.to_string()).collect(),
        };
        let md = report.to_markdown();
        assert!(md.contains("| Scénario | Moteur | Images p95 / > 33 ms |"));
        assert!(md.contains("| S2 | DOM |"));
        assert!(md.contains("1200.0 ms"));
        assert!(md.contains("Verdict : RÉUSSI (meilleur moteur : DOM)"));
        assert!(md.contains("non concluant"));
        assert!(md.contains("Mode réaliste"));
        assert!(serde_json::to_string(&report).is_ok());
    }

    #[test]
    fn chrome_validity_and_transport_cost() {
        let mut c = CpuSummary {
            cpu_avg_pct: Some(30.0),
            ..Default::default()
        };
        c.cpu_avg_pct_by_process.insert("bench-web".into(), 10.0);
        c.cpu_avg_pct_by_process
            .insert("chrome (renderer)".into(), 20.0);
        let mut x = raw("S0", "none", 16.7);
        x.measured_ms = 10_000.0;
        x.ipc_messages = 1000;
        // Processus WebKit attendu : absent en mode web.
        assert!(!ScenarioReport::build(x.clone(), 1000, c.clone(), false).valid);
        let r = ScenarioReport::build_for(x, 1000, c, false, CHROME, "bench-web");
        assert!(r.valid, "{:?}", r.invalid_reasons());
        let t = &r.transport;
        assert_eq!(t.messages_per_s, Some(100.0));
        assert_eq!(t.bytes_per_s, Some(100.0));
        assert_eq!(t.browser_cpu_pct, Some(20.0));
        // 10 % d'un cœur pour 100 messages/s : 1000 µs par message.
        assert!((t.backend_us_per_message.unwrap() - 1000.0).abs() < 1e-9);
    }

    #[test]
    fn software_gl_detection() {
        let f = |s: &str| {
            FrontEnv {
                webgl_renderer: Some(s.into()),
                ..Default::default()
            }
            .software_gl()
        };
        assert!(f("llvmpipe (LLVM 19.1.1, 256 bits)"));
        assert!(f("Google SwiftShader"));
        assert!(!f("AMD Radeon 780M (radeonsi, phoenix, LLVM 19)"));
    }

    #[test]
    fn downsample_keeps_peak() {
        let series: Vec<[f64; 2]> = (0..1000)
            .map(|i| [i as f64, if i == 517 { 9e6 } else { 1.0 }])
            .collect();
        let d = downsample(&series, 100);
        assert!(d.len() <= 100);
        assert!(d.iter().any(|p| p[1] == 9e6));
    }
}
