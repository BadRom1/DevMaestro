//! Moteur du banc, indépendant du transport : sessions simulées, historiques, boucle d'envoi par
//! lots, jetons d'écho, pic, préremplissage, sessions envoyées, marques, CPU, rapport.
//! L'hôte (Tauri ou bench-web) fournit, par session, une fonction d'envoi (`Sink`) et ses
//! informations d'environnement ; il expose les méthodes ci-dessous comme commandes.

use crate::config::Config;
use crate::replay::Feed;
use crate::report::{
    cells, conclude, FrontEnv, Parity, RawScenario, RenderProcess, Report, ScenarioReport, NOTES,
};
use crate::ring::{concat_tail, ByteRing};
use crate::sampler::{self, Sampler};
use crate::stats::Summary;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Taille maximale d'un message (les pics et l'historique sont découpés).
pub const MAX_MESSAGE: usize = 256 * 1024;
/// Code de sortie quand le garde-fou a écrit un rapport partiel.
pub const EXIT_PARTIAL: i32 = 3;

/// Envoi d'un message (octets bruts d'une session) vers le front.
pub type Sink = Arc<dyn Fn(Vec<u8>) + Send + Sync>;

/// Ce qui distingue un hôte de l'autre dans le rapport.
pub struct Host {
    pub title: String,
    pub engine: String,
    pub transport: String,
    pub encoding: String,
    /// Libellé de l'en-tête pour la part des messages < 1 Ko.
    pub small_label: String,
    pub render: RenderProcess,
    pub notes: Vec<String>,
}

/// Une session simulée.
struct Slot {
    feed: Feed,
    sink: Option<Sink>,
    /// Octets à insérer au prochain lot (jetons d'écho, sortie du vrai PTY).
    inject: Vec<u8>,
    /// Pic demandé : identifiant du marqueur de fin.
    burst: Option<u64>,
    prefill: bool,
    /// Faux pour la session reliée au vrai PTY.
    simulated: bool,
    /// Ses octets traversent le transport (toujours vrai en mode prudent).
    streamed: bool,
    /// Tout ce que la session a produit (derniers 1 Mo), rejoué au changement en mode réaliste.
    ring: ByteRing,
    /// Changement demandé : envoyer l'historique puis le marqueur `⟦h<id>⟧`.
    switch: Option<u64>,
}

struct Mark {
    t_s: f64,
    sent: Vec<u64>,
}

pub struct Engine {
    pub cfg: Config,
    pub host: Host,
    slots: Mutex<Vec<Slot>>,
    /// Octets confiés au transport pour chaque session depuis le démarrage.
    sent: Vec<AtomicU64>,
    burst_data: Arc<Vec<u8>>,
    history_data: Vec<Arc<Vec<u8>>>,
    streaming: AtomicBool,
    sampler: Mutex<Sampler>,
    mark_start: Mutex<Option<Mark>>,
    mark_end: Mutex<Option<Mark>>,
    runs: Mutex<Vec<ScenarioReport>>,
    front: Mutex<FrontEnv>,
    /// Rapport complet écrit : le garde-fou ne doit plus l'écraser.
    pub done: AtomicBool,
    /// Environnement propre à l'hôte (versions, fenêtre, navigateur…), ajouté au rapport.
    pub env_extra: Mutex<BTreeMap<String, String>>,
    /// Ce que l'hôte a obtenu pour `--monitor` (écran atteint ou non, et pourquoi).
    pub screen_result: Mutex<String>,
    /// `--monitor` : écran atteint (et plein écran) ? `None` tant que l'hôte n'a pas vérifié.
    pub screen_ok: Mutex<Option<bool>>,
    /// Lignes d'en-tête propres à l'hôte (plateforme, drapeaux, inhibition…).
    pub header_extra: Mutex<BTreeMap<String, String>>,
    /// Empreinte du front servi ou embarqué (`dist/`).
    pub dist_hash: Mutex<String>,
    /// Débit réellement produit par une session simulée (o/s), mesuré sur 10 s simulées.
    produced_rate: f64,
    loadavg_start: String,
    /// Libellé du processus backend dans l'échantillonnage CPU.
    backend_comm: String,
}

/// Découpe sur des frontières UTF-8, en morceaux d'au plus `MAX_MESSAGE` octets.
pub fn split_utf8(bytes: &[u8]) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    let mut rest = bytes;
    while !rest.is_empty() {
        let mut cut = rest.len().min(MAX_MESSAGE);
        while cut < rest.len() && (rest[cut] & 0xC0) == 0x80 {
            cut += 1;
        }
        out.push(rest[..cut].to_vec());
        rest = &rest[cut..];
    }
    out
}

/// Ce qu'une session doit envoyer à ce tour ; préparé sous le verrou, envoyé hors du verrou.
struct Outgoing {
    session: usize,
    sink: Sink,
    prefill: Option<Arc<Vec<u8>>>,
    history: Option<(Vec<Arc<Vec<u8>>>, u64)>,
    live: Arc<Vec<u8>>,
    burst: Option<(Arc<Vec<u8>>, u64)>,
}

impl Engine {
    /// Prépare les sessions (pic et historiques pré-générés) ; `simulated(i)` est faux pour un vrai PTY.
    pub fn new(
        cfg: Config,
        host: Host,
        simulated: impl Fn(usize) -> bool,
    ) -> Result<Arc<Self>, String> {
        let t = Instant::now();
        let capture = match &cfg.replay {
            None => None,
            Some(p) => {
                let data = std::fs::read(p).map_err(|e| format!("{} : {e}", p.display()))?;
                if data.is_empty() {
                    return Err(format!("{} : capture vide", p.display()));
                }
                Some(Arc::new(crate::replay::strip_alt_screen(&data)))
            }
        };
        let rate = cfg.rate_bytes_per_s;
        let mut probe = Feed::new(99, rate, capture.as_ref());
        let produced_rate = (0..1000).map(|_| probe.tick(0.01).len()).sum::<usize>() as f64 / 10.0;
        let burst_data = Arc::new(Feed::new(1000, rate, capture.as_ref()).fill(cfg.burst_bytes));
        let history_data = (0..cfg.sessions)
            .map(|i| {
                Arc::new(Feed::new(2000 + i as u64, rate, capture.as_ref()).fill(cfg.history_bytes))
            })
            .collect();
        eprintln!(
            "[bench] pic et historiques pré-générés en {} ms",
            t.elapsed().as_millis()
        );
        let slots = (0..cfg.sessions)
            .map(|i| Slot {
                feed: Feed::new(i as u64 + 1, rate, capture.as_ref()),
                sink: None,
                inject: Vec::new(),
                burst: None,
                prefill: false,
                simulated: simulated(i),
                streamed: true,
                ring: ByteRing::new(cfg.history_bytes),
                switch: None,
            })
            .collect();
        let pid = std::process::id();
        Ok(Arc::new(Self {
            slots: Mutex::new(slots),
            sent: (0..cfg.sessions).map(|_| AtomicU64::new(0)).collect(),
            burst_data,
            history_data,
            streaming: AtomicBool::new(false),
            sampler: Mutex::new(Sampler::new(pid)),
            mark_start: Mutex::new(None),
            mark_end: Mutex::new(None),
            runs: Mutex::new(Vec::new()),
            front: Mutex::new(FrontEnv::default()),
            done: AtomicBool::new(false),
            env_extra: Mutex::new(BTreeMap::new()),
            screen_result: Mutex::new("aucun écran demandé (placement par le compositeur)".into()),
            screen_ok: Mutex::new(None),
            header_extra: Mutex::new(BTreeMap::new()),
            dist_hash: Mutex::new("?".into()),
            produced_rate,
            loadavg_start: loadavg(),
            backend_comm: sampler::comm(pid).unwrap_or_default(),
            cfg,
            host,
        }))
    }

    /// Lance la boucle d'envoi et l'échantillonneur (une fois par seconde).
    pub fn start(self: &Arc<Self>) {
        let e = self.clone();
        std::thread::spawn(move || e.pump());
        let e = self.clone();
        std::thread::spawn(move || loop {
            e.sampler.lock().unwrap().sample();
            std::thread::sleep(Duration::from_secs(1));
        });
    }

    /// Garde-fou : si le front ne termine jamais, écrit ce qu'on a, appelle `cleanup` et sort.
    pub fn spawn_watchdog(self: &Arc<Self>, cleanup: impl FnOnce() + Send + 'static) {
        let e = self.clone();
        let timeout = e.cfg.timeout_s;
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(timeout));
            if e.done.load(Ordering::SeqCst) {
                std::process::exit(0);
            }
            e.abort(&format!(
                "Délai de {timeout} s dépassé : RAPPORT PARTIEL écrit par le garde-fou."
            ));
            cleanup();
            std::process::exit(EXIT_PARTIAL);
        });
    }

    /// Écrit un rapport partiel avec `note` (sauf si le rapport complet est déjà écrit).
    pub fn abort(&self, note: &str) {
        if self.done.swap(true, Ordering::SeqCst) {
            return;
        }
        eprintln!("[bench] {note}");
        let _ = self.write_report(vec![note.into()], vec![], true);
    }

    fn snapshot(&self) -> Mark {
        Mark {
            t_s: self.sampler.lock().unwrap().now_s(),
            sent: self.sent.iter().map(|c| c.load(Ordering::SeqCst)).collect(),
        }
    }

    /// Boucle d'envoi : toutes les `batch_ms`, chaque session produit les octets dus et les pousse.
    fn pump(&self) {
        let period = Duration::from_millis(self.cfg.batch_ms);
        let mut last = Instant::now();
        let mut next = last + period;
        loop {
            let now = Instant::now();
            if next > now {
                std::thread::sleep(next - now);
            }
            next += period;
            let now = Instant::now();
            // Rattrape sans rafale si la boucle a pris du retard.
            if next < now {
                next = now + period;
            }
            let dt = (now - last).as_secs_f64();
            last = now;
            let streaming = self.streaming.load(Ordering::SeqCst);

            // Sous le verrou : uniquement les quelques centaines d'octets du tour et des déplacements.
            let mut outgoing = Vec::new();
            {
                let mut slots = self.slots.lock().unwrap();
                for (session, slot) in slots.iter_mut().enumerate() {
                    let Some(sink) = slot.sink.clone() else {
                        continue;
                    };
                    let mut live = if streaming && slot.simulated {
                        slot.feed.tick(dt)
                    } else {
                        Vec::new()
                    };
                    live.append(&mut slot.inject);
                    let live = Arc::new(live);
                    let prefill = std::mem::take(&mut slot.prefill)
                        .then(|| self.history_data[session].clone());
                    let burst = slot.burst.take().map(|id| (self.burst_data.clone(), id));
                    // L'historique Rust reçoit tout, envoyé ou non ; l'instantané d'un changement
                    // est pris avant le lot de ce tour, qui part juste après lui.
                    if let Some(h) = &prefill {
                        slot.ring.push(h.clone());
                    }
                    let history = slot.switch.take().map(|id| (slot.ring.chunks(), id));
                    slot.ring.push(live.clone());
                    if let Some((b, _)) = &burst {
                        slot.ring.push(b.clone());
                    }
                    if !slot.streamed {
                        continue;
                    }
                    // Mode réaliste : l'historique initial reste côté Rust.
                    let prefill = prefill.filter(|_| self.cfg.hidden_ipc);
                    if live.is_empty() && prefill.is_none() && burst.is_none() && history.is_none()
                    {
                        continue;
                    }
                    outgoing.push(Outgoing {
                        session,
                        sink,
                        prefill,
                        history,
                        live,
                        burst,
                    });
                }
            }

            for o in outgoing {
                let mut messages = Vec::new();
                if let Some(h) = &o.prefill {
                    messages.extend(split_utf8(h));
                }
                if let Some((chunks, _)) = &o.history {
                    messages.extend(split_utf8(&concat_tail(chunks, self.cfg.history_bytes)));
                }
                // Jetons et marqueurs restent entiers : `live` est petit, les marqueurs partent seuls.
                if !o.live.is_empty() {
                    messages.extend(split_utf8(&o.live));
                }
                if let Some((_, id)) = &o.history {
                    messages.push(format!("⟦h{id}⟧").into_bytes());
                }
                if let Some((data, id)) = &o.burst {
                    messages.extend(split_utf8(data));
                    messages.push(format!("\r\n⟦b{id}⟧\r\n").into_bytes());
                }
                for m in messages {
                    self.sent[o.session].fetch_add(m.len() as u64, Ordering::SeqCst);
                    (o.sink)(m);
                }
            }
        }
    }

    // ---------- Commandes du front (mêmes noms côté Tauri et WebSocket) ----------

    pub fn open_session(&self, id: usize, sink: Sink) -> Result<(), String> {
        let mut slots = self.slots.lock().unwrap();
        let slot = slots.get_mut(id).ok_or("session inconnue")?;
        slot.sink = Some(sink);
        Ok(())
    }

    pub fn set_streaming(&self, on: bool) {
        self.streaming.store(on, Ordering::SeqCst);
    }

    /// Environnement du front (sonde WebGL, référence au repos), envoyé au début du banc.
    pub fn register_env(&self, env: FrontEnv) {
        *self.front.lock().unwrap() = env;
    }

    /// Simule une frappe : le jeton `⟦k<id>⟧` ressort dans le flux de la session.
    pub fn echo(&self, session: usize, id: u64) {
        self.inject(session, format!("⟦k{id}⟧\r\n").as_bytes());
    }

    /// Octets à insérer au prochain lot d'une session (jeton d'écho, sortie d'un vrai PTY).
    pub fn inject(&self, session: usize, bytes: &[u8]) {
        if let Some(s) = self.slots.lock().unwrap().get_mut(session) {
            s.inject.extend_from_slice(bytes);
        }
    }

    /// Pic de sortie (un `cat` de gros fichier, pré-généré), terminé par le marqueur `⟦b<id>⟧`.
    pub fn burst(&self, session: usize, id: u64) {
        if let Some(s) = self.slots.lock().unwrap().get_mut(session) {
            s.burst = Some(id);
        }
    }

    /// Sessions dont les octets traversent le transport (mode réaliste ; en mode prudent : toutes).
    pub fn set_streamed(&self, sessions: &[usize]) {
        let all = self.cfg.hidden_ipc;
        for (i, s) in self.slots.lock().unwrap().iter_mut().enumerate() {
            s.streamed = all || sessions.contains(&i);
        }
    }

    /// Mode réaliste : `from` cesse d'être envoyée ; `to` reçoit son historique (1 Mo), le marqueur
    /// `⟦h<id>⟧`, puis son flux direct.
    pub fn switch_stream(&self, from: usize, to: usize, id: u64) -> Result<(), String> {
        let mut slots = self.slots.lock().unwrap();
        if to >= slots.len() || from >= slots.len() {
            return Err("session inconnue".into());
        }
        if from != to && !self.cfg.hidden_ipc {
            slots[from].streamed = false;
        }
        slots[to].streamed = true;
        slots[to].switch = Some(id);
        Ok(())
    }

    /// Envoie d'un coup l'historique pré-généré (1 Mo) à chaque session simulée
    /// (mode réaliste : seulement dans l'historique Rust).
    pub fn prefill(&self) {
        for s in self
            .slots
            .lock()
            .unwrap()
            .iter_mut()
            .filter(|s| s.simulated)
        {
            s.prefill = true;
        }
    }

    /// Début de la fenêtre de mesure : renvoie les octets déjà envoyés par session.
    pub fn mark_start(&self) -> Vec<u64> {
        let m = self.snapshot();
        let sent = m.sent.clone();
        *self.mark_start.lock().unwrap() = Some(m);
        *self.mark_end.lock().unwrap() = None;
        sent
    }

    /// Fin de la fenêtre de mesure : renvoie les octets envoyés par session.
    pub fn mark_end(&self) -> Vec<u64> {
        let m = self.snapshot();
        let sent = m.sent.clone();
        *self.mark_end.lock().unwrap() = Some(m);
        sent
    }

    pub fn finish_scenario(&self, raw: RawScenario) {
        let start = self.mark_start.lock().unwrap().take();
        let end = self
            .mark_end
            .lock()
            .unwrap()
            .take()
            .unwrap_or_else(|| self.snapshot());
        let (from_s, sent0) = start.map_or((end.t_s, end.sent.clone()), |m| (m.t_s, m.sent));
        let sent_window: u64 = end
            .sent
            .iter()
            .zip(&sent0)
            .map(|(b, a)| b.saturating_sub(*a))
            .sum();
        let cpu = self.sampler.lock().unwrap().summarize(from_s, end.t_s);
        let software_gl = self.front.lock().unwrap().software_gl();
        let mut r = ScenarioReport::build_for(
            raw,
            sent_window,
            cpu,
            software_gl,
            self.host.render,
            &self.backend_comm,
        );
        if let Some(m) = &self.cfg.monitor {
            let ok = *self.screen_ok.lock().unwrap();
            let full = r.fullscreen_at_end;
            r.add_check(
                "écran demandé atteint, en plein écran",
                ok == Some(true) && full != Some(false),
                match (ok, full) {
                    (None, _) => format!("{m} : non vérifié"),
                    (Some(false), _) => format!("{m} non atteint"),
                    (_, Some(false)) => "plein écran perdu pendant le passage".into(),
                    _ => String::new(),
                },
            );
        }
        r.streamed_sessions = (0..end.sent.len())
            .filter(|&i| end.sent[i] > sent0.get(i).copied().unwrap_or(0))
            .collect();
        eprintln!(
            "[bench] passage {} {} {} : images p95 {:?} ms, frappe p95 {:?} ms, CPU {:?} %, {}{}",
            r.round + 1,
            r.scenario,
            r.renderer,
            r.frames.p95.map(|v| v.round()),
            r.echo.p95.map(|v| v.round()),
            r.cpu.cpu_avg_pct.map(|v| v.round()),
            if r.pass { "OK" } else { "ÉCHEC" },
            if r.valid {
                String::new()
            } else {
                format!(" (INVALIDE : {})", r.invalid_reasons().join(" ; "))
            }
        );
        self.runs.lock().unwrap().push(r);
    }

    /// Fin du banc : écrit le rapport complet. L'hôte se charge ensuite de quitter.
    pub fn finish_bench(&self, notes: Vec<String>, errors: Vec<String>) -> Result<PathBuf, String> {
        let path = self.write_report(notes, errors, false)?;
        self.done.store(true, Ordering::SeqCst);
        eprintln!("[bench] rapport écrit : {}", path.display());
        Ok(path)
    }

    pub fn write_report(
        &self,
        mut notes: Vec<String>,
        errors: Vec<String>,
        partial: bool,
    ) -> Result<PathBuf, String> {
        let cfg = &self.cfg;
        let runs = self.runs.lock().unwrap().clone();
        let front = self.front.lock().unwrap().clone();
        let idle_frames = Summary::of(&front.idle_frame_intervals_ms);
        let refresh_hz_estimate = idle_frames.p50.filter(|v| *v > 0.0).map(|v| 1000.0 / v);
        let (msgs, small) = runs.iter().fold((0, 0), |(m, s), r| {
            (m + r.ipc_messages, s + r.ipc_small_messages)
        });

        let mut h = BTreeMap::new();
        h.insert(
            "moteur web".into(),
            if front.user_agent.is_empty() {
                self.host.engine.clone()
            } else {
                format!("{} — user agent : {}", self.host.engine, front.user_agent)
            },
        );
        h.insert("transport".into(), self.host.transport.clone());
        h.insert(
            "lots IPC".into(),
            format!(
                "toutes les {} ms, ≤ {} Ko par message",
                cfg.batch_ms,
                MAX_MESSAGE / 1024
            ),
        );
        h.insert(
            self.host.small_label.clone(),
            if msgs > 0 {
                format!(
                    "{:.1} % de {msgs} messages",
                    100.0 * small as f64 / msgs as f64
                )
            } else {
                "—".into()
            },
        );
        h.insert(
            "sessions".into(),
            format!("{} × {} Ko/s", cfg.sessions, cfg.rate_bytes_per_s / 1000.0),
        );
        h.insert(
            "débit par session (--rate)".into(),
            format!("{} Ko/s", cfg.rate_bytes_per_s / 1000.0),
        );
        h.insert(
            "source du flux".into(),
            match &cfg.replay {
                None => "générateur synthétique".into(),
                Some(p) => format!("rejeu en boucle de {}", p.display()),
            },
        );
        h.insert(
            "durée par passage".into(),
            format!(
                "{} s mesurées (+ {} s d'échauffement exclues)",
                cfg.scenario_s, cfg.warmup_s
            ),
        );
        h.insert("répétitions".into(), cfg.repeat.to_string());
        h.insert(
            "IPC des sessions cachées (hidden_ipc)".into(),
            if cfg.hidden_ipc {
                "oui — mode prudent : les 10 sessions traversent l'IPC".into()
            } else {
                "non — mode réaliste : seules les sessions affichées traversent l'IPC".into()
            },
        );
        h.insert("batch_ms".into(), cfg.batch_ms.to_string());
        h.insert("fichier".into(), cfg.report_name.clone());
        h.insert("scénarios".into(), cfg.scenarios.join(", "));
        h.insert("moteurs".into(), cfg.renderers.join(", "));
        h.insert("passage rapide".into(), cfg.quick.to_string());
        h.insert(
            "charge (loadavg) début → fin".into(),
            format!("{} → {}", self.loadavg_start, loadavg()),
        );
        h.insert("énergie".into(), power_profile());
        h.insert(
            "débit produit par session (10 s simulées)".into(),
            format!(
                "{:.2} Ko/s{}",
                self.produced_rate / 1000.0,
                if self.produced_rate > 1.1 * cfg.rate_bytes_per_s {
                    " — **au-dessus de --rate : le générateur a un minimum (spinner ≈ 1,05 Ko/s)**"
                } else {
                    ""
                }
            ),
        );
        h.insert(
            "empreinte du front (dist/)".into(),
            self.dist_hash.lock().unwrap().clone(),
        );
        h.insert(
            "veille / verrouillage".into(),
            std::env::var("BENCH_INHIBIT")
                .map(|v| format!("inhibés par `{v}`"))
                .unwrap_or_else(|_| "non inhibés".into()),
        );
        h.extend(self.header_extra.lock().unwrap().clone());
        h.insert(
            "écran demandé (--monitor)".into(),
            cfg.monitor.clone().unwrap_or_else(|| "aucun".into()),
        );
        h.insert(
            "écran : résultat".into(),
            self.screen_result.lock().unwrap().clone(),
        );
        if let Some(m) = &cfg.monitor {
            h.insert(
                "écran (Mutter)".into(),
                crate::display::mutter_output(m)
                    .map_or_else(|| format!("{m} : introuvable"), |o| o.describe(m)),
            );
        }
        h.insert(
            "fenêtre (page)".into(),
            format!(
                "{} px CSS, devicePixelRatio {}, plein écran {} ; écran vu par la page : {}",
                front.window_inner, front.device_pixel_ratio, front.fullscreen, front.screen
            ),
        );
        let size = |pred: &dyn Fn(&ScenarioReport) -> bool| {
            runs.iter()
                .find(|r| pred(r) && r.terminal_size.is_some())
                .and_then(|r| r.terminal_size.clone())
                .unwrap_or_else(|| "—".into())
        };
        h.insert(
            "terminaux (colonnes×lignes)".into(),
            format!(
                "boîte fixe {}{} ; S1–S3 : {} ; S4 : 10 × {}",
                front.terminal_box,
                if front.terminal_box_fits || front.terminal_box.is_empty() {
                    ""
                } else {
                    " (ne tient pas dans la fenêtre : rognée)"
                },
                size(&|r| r.visible_terminals == 1),
                size(&|r| r.visible_terminals > 1)
            ),
        );

        if cfg.replay.is_some() {
            notes.insert(
                0,
                "Rejeu : la capture est jouée en boucle, sans ses bascules d'écran alternatif (`ESC[?1049h/l`, `?47`, `?1047`). \
                 Le pic de S2 et l'historique de S3 sont alors des redessins de TUI rejoués, pas un `cat` de fichier."
                    .into(),
            );
        }
        let fixed = NOTES
            .iter()
            .map(|s| s.to_string())
            .chain(self.host.notes.iter().cloned());
        notes.splice(0..0, fixed);
        notes.insert(
            0,
            if cfg.hidden_ipc {
                "Mode prudent : les sessions non affichées reçoivent quand même leurs octets par IPC (tampon JS de 1 Mo chacune). \
                 Dans le vrai produit, une session cachée ne traverserait même pas l'IPC (voir `--hidden-ipc off`)."
            } else {
                "Mode réaliste : seules les sessions affichées traversent l'IPC ; les autres restent dans un historique Rust \
                 de 1 Mo, envoyé au changement de session. L'intégrité ne porte que sur les sessions envoyées (colonne « Sessions sur l'IPC »)."
            }
            .into(),
        );
        let mut env = env_info();
        env.extend(self.env_extra.lock().unwrap().clone());
        let cells = cells(&runs);
        let size = |many: bool| {
            runs.iter()
                .find(|r| (r.visible_terminals > 1) == many && r.terminal_size.is_some())
                .and_then(|r| r.terminal_size.clone())
        };
        let parity = Parity {
            device_pixel_ratio: front.device_pixel_ratio,
            terminals_single: size(false),
            terminals_grid: size(true),
            refresh_hz_estimate,
            rate_kbps: cfg.rate_bytes_per_s / 1000.0,
            source: cfg
                .replay
                .as_ref()
                .map_or("synth".into(), |p| format!("replay:{}", p.display())),
            batch_ms: cfg.batch_ms,
            hidden_ipc: cfg.hidden_ipc,
            dist_hash: self.dist_hash.lock().unwrap().clone(),
            monitor: cfg.monitor.clone(),
            monitor_reached: cfg.monitor.as_ref().and(*self.screen_ok.lock().unwrap()),
        };
        let report = Report {
            parity,
            title: self.host.title.clone(),
            engine: self.host.engine.clone(),
            transport: self.host.transport.clone(),
            generated_at: run("date", &["-Iseconds"]),
            partial,
            quick: cfg.quick,
            hidden_ipc: cfg.hidden_ipc,
            batch_ms: cfg.batch_ms,
            header: h,
            env,
            software_gl: front.software_gl(),
            front,
            idle_frames,
            refresh_hz_estimate,
            ipc_encoding: self.host.encoding.clone(),
            conclusion: conclude(&cells, &cfg.renderers, partial, &errors),
            cells,
            runs,
            errors,
            notes,
        };
        std::fs::create_dir_all(&cfg.out_dir).map_err(|e| e.to_string())?;
        let json = serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?;
        // Pas de `with_extension` : le nom peut contenir un point (`-r0.8`).
        let path = |ext: &str| cfg.out_dir.join(format!("{}.{ext}", cfg.report_name));
        std::fs::write(path("json"), json).map_err(|e| e.to_string())?;
        std::fs::write(path("md"), report.to_markdown()).map_err(|e| e.to_string())?;
        Ok(path("md"))
    }
}

// ---------- Environnement de la machine ----------

/// Sortie d'une commande, « ? » si elle échoue.
pub fn run(cmd: &str, args: &[&str]) -> String {
    Command::new(cmd)
        .args(args)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|| "?".into())
}

fn loadavg() -> String {
    std::fs::read_to_string("/proc/loadavg")
        .map(|s| s.split_whitespace().take(3).collect::<Vec<_>>().join(" "))
        .unwrap_or_else(|_| "?".into())
}

fn power_profile() -> String {
    let p = run("powerprofilesctl", &["get"]);
    if p != "?" {
        return format!("profil d'énergie {p}");
    }
    std::fs::read_to_string("/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor")
        .map(|g| format!("gouverneur {}", g.trim()))
        .unwrap_or_else(|_| "?".into())
}

/// Environnement commun aux deux hôtes (système, processeur, GPU, variables d'affichage).
fn env_info() -> BTreeMap<String, String> {
    let mut m = BTreeMap::new();
    let field = |path: &str, key: &str| {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| {
                s.lines().find_map(|l| {
                    l.strip_prefix(key).map(|v| {
                        v.trim_start_matches([' ', '\t', ':', '='])
                            .trim_matches('"')
                            .to_string()
                    })
                })
            })
            .unwrap_or_else(|| "?".into())
    };
    m.insert("système".into(), field("/etc/os-release", "PRETTY_NAME"));
    m.insert("noyau".into(), run("uname", &["-r"]));
    m.insert("processeur".into(), field("/proc/cpuinfo", "model name"));
    m.insert(
        "threads".into(),
        std::thread::available_parallelism().map_or("?".into(), |n| n.to_string()),
    );
    m.insert(
        "GPU (lspci)".into(),
        run("sh", &["-c", "lspci | grep -iE 'vga|display|3d'"]).replace('\n', " ; "),
    );
    for var in [
        "XDG_SESSION_TYPE",
        "XDG_CURRENT_DESKTOP",
        "WAYLAND_DISPLAY",
        "DISPLAY",
        "GDK_BACKEND",
        "WEBKIT_DISABLE_DMABUF_RENDERER",
        "WEBKIT_DISABLE_COMPOSITING_MODE",
    ] {
        m.insert(
            var.into(),
            std::env::var(var).unwrap_or_else(|_| "(absent)".into()),
        );
    }
    m
}

/// Empreinte d'un dossier (`dist/`) : FNV-1a 64 bits des chemins relatifs triés et des contenus.
pub fn dist_hash(dir: &std::path::Path) -> String {
    fn walk(dir: &std::path::Path, out: &mut Vec<PathBuf>) {
        if let Ok(rd) = std::fs::read_dir(dir) {
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, out);
                } else {
                    out.push(p);
                }
            }
        }
    }
    let mut files = Vec::new();
    walk(dir, &mut files);
    if files.is_empty() {
        return format!("? ({} vide ou absent)", dir.display());
    }
    files.sort();
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut feed = |bytes: &[u8]| {
        for &b in bytes {
            h = (h ^ b as u64).wrapping_mul(0x0100_0000_01b3);
        }
    };
    for f in &files {
        let rel = f.strip_prefix(dir).unwrap_or(f);
        feed(rel.to_string_lossy().as_bytes());
        feed(&std::fs::read(f).unwrap_or_default());
    }
    format!("{h:016x} ({} fichiers)", files.len())
}
