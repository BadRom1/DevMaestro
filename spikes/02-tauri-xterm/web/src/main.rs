//! Mode web du banc : sert le front construit (`dist/`) en HTTP sur 127.0.0.1 et le relie au
//! moteur (`bench_core::engine`) par une WebSocket sur le même port. Trames binaires : un octet de
//! session puis les octets du terminal ; trames texte JSON : les mêmes commandes que Tauri.
//!
//! Usage : `bench-web [--bench] [--port N] [--dist DIR] [-- <commande Chrome et drapeaux>]`.
//! Avec une commande, bench-web lance Chrome lui-même (en ajoutant `--app=<url>`) pour connaître
//! son PID, l'échantillonner avec ses descendants, puis le fermer à la fin.

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use axum::routing::get;
use axum::serve::ListenerExt;
use axum::Router;
use bench_core::config::Config;
use bench_core::display::xrandr_output;
use bench_core::engine::{run, Engine, Host, Sink, EXIT_PARTIAL};
use bench_core::report::{FrontEnv, CHROME, WEB_NOTES, WS_ENCODING};
use bench_core::sampler::{cmdline, is_alive, process_tree};
use futures_util::{SinkExt, StreamExt};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};
use std::process::Command;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};
use tower_http::services::ServeDir;

struct App {
    engine: Arc<Engine>,
    /// Sortie X11 visée par `--monitor` (XWayland) : (x, y, largeur, hauteur) en pixels X.
    target: Option<(i32, i32, u32, u32)>,
    /// PID de l'instance Chrome lancée par bench-web.
    browser: Option<u32>,
}

/// Arguments propres à bench-web (`--bench` et le reste passent par `Config::from_env`).
struct Args {
    port: u16,
    dist: String,
    browser: Vec<String>,
}

fn parse_args() -> Result<Args, String> {
    let mut args = std::env::args().skip(1);
    let mut a = Args {
        port: 0,
        dist: "dist".into(),
        browser: Vec::new(),
    };
    let mut port = None;
    while let Some(x) = args.next() {
        match x.as_str() {
            "--port" => {
                port = Some(
                    args.next()
                        .and_then(|p| p.parse().ok())
                        .ok_or("--port attend un nombre")?,
                )
            }
            "--dist" => a.dist = args.next().ok_or("--dist attend un dossier")?,
            "--bench" | "--print-report-name" => {}
            "--" => a.browser = args.by_ref().collect(),
            other => return Err(format!("option inconnue : {other}")),
        }
    }
    // Sans navigateur à lancer (mode manuel, test) : port fixe, plus pratique à ouvrir à la main.
    a.port = port.unwrap_or(if a.browser.is_empty() { 5180 } else { 0 });
    Ok(a)
}

/// Ferme Chrome : SIGTERM au processus racine (arrêt propre), jusqu'à 3 s d'attente, puis SIGTERM
/// au reste de l'arbre, et SIGKILL à ce qui vit encore 2 s plus tard.
fn kill_tree(pid: u32) {
    let tree = process_tree(pid);
    let kill = |sig: &str, pids: &[u32]| {
        let pids: Vec<String> = pids
            .iter()
            .filter(|p| is_alive(**p))
            .map(|p| p.to_string())
            .collect();
        if !pids.is_empty() {
            let _ = Command::new("kill").arg(sig).args(pids).output();
        }
    };
    let wait = |pids: &[u32], secs: u64| {
        for _ in 0..secs * 10 {
            if !pids.iter().any(|p| is_alive(*p)) {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    };
    kill("-TERM", &[pid]);
    wait(&[pid], 3);
    kill("-TERM", &tree);
    wait(&tree, 2);
    kill("-KILL", &tree);
}

/// Rapport partiel, fermeture de Chrome, sortie (code 3, comme le garde-fou).
fn abort(app: &App, note: &str) -> ! {
    app.engine.abort(note);
    if let Some(pid) = app.browser {
        kill_tree(pid);
    }
    std::process::exit(EXIT_PARTIAL);
}

/// Plateforme Ozone choisie par Chrome (`--ozone-platform=` propagé aux processus fils), si visible.
fn ozone_of(pid: u32) -> String {
    process_tree(pid)
        .into_iter()
        .find_map(|p| {
            let c = String::from_utf8_lossy(&cmdline(p)).replace('\0', " ");
            c.split(' ')
                .find_map(|a| a.strip_prefix("--ozone-platform=").map(str::to_string))
        })
        .unwrap_or_else(|| "non visible dans les lignes de commande (défaut, non forcé)".into())
}

/// La fenêtre est-elle sur la sortie visée ? Coordonnées X11 = px CSS × devicePixelRatio.
fn landing(
    env: &FrontEnv,
    (x, y, w, h): (i32, i32, u32, u32),
    connector: &str,
    screen_ok: &std::sync::Mutex<Option<bool>>,
) -> String {
    let d = env.device_pixel_ratio.max(1.0);
    let near = |css: f64, px: f64| (css * d - px).abs() <= 2.0 * d;
    let ok = near(env.screen_x, x as f64)
        && near(env.screen_y, y as f64)
        && near(env.screen_width, w as f64)
        && near(env.screen_height, h as f64);
    *screen_ok.lock().unwrap() = Some(ok && env.fullscreen);
    format!(
        " ; constaté par la page : {} (plein écran {}) → {}",
        env.screen,
        env.fullscreen,
        if ok && env.fullscreen {
            format!("{connector} atteint")
        } else {
            format!("**{connector} NON atteint**")
        }
    )
}

#[derive(Deserialize)]
struct Request {
    id: u64,
    cmd: String,
    #[serde(default)]
    args: Value,
}

fn arg<T: DeserializeOwned>(args: &Value, key: &str) -> Result<T, String> {
    serde_json::from_value(args.get(key).cloned().unwrap_or(Value::Null))
        .map_err(|e| format!("argument « {key} » : {e}"))
}

enum Out {
    Data(Vec<u8>),
    Text(String),
}

/// Exécute une commande du front ; même nom et mêmes arguments que la commande Tauri.
fn dispatch(app: &App, cmd: &str, a: &Value, tx: &UnboundedSender<Out>) -> Result<Value, String> {
    let e = &app.engine;
    Ok(match cmd {
        "get_config" => serde_json::to_value(&e.cfg).map_err(|x| x.to_string())?,
        "open_session" => {
            let id: usize = arg(a, "id")?;
            let tag = u8::try_from(id).map_err(|_| "session hors limites")?;
            let tx = tx.clone();
            let sink: Sink = Arc::new(move |m: Vec<u8>| {
                let mut frame = Vec::with_capacity(m.len() + 1);
                frame.push(tag);
                frame.extend_from_slice(&m);
                let _ = tx.send(Out::Data(frame));
            });
            e.open_session(id, sink)?;
            Value::Null
        }
        "set_streaming" => {
            e.set_streaming(arg(a, "on")?);
            Value::Null
        }
        "register_env" => {
            let env: FrontEnv = arg(a, "env")?;
            if let (Some(t), Some(c)) = (app.target, &e.cfg.monitor) {
                e.screen_result
                    .lock()
                    .unwrap()
                    .push_str(&landing(&env, t, c, &e.screen_ok));
            }
            e.register_env(env);
            Value::Null
        }
        "echo" => {
            e.echo(arg(a, "session")?, arg(a, "id")?);
            Value::Null
        }
        "burst" => {
            e.burst(arg(a, "session")?, arg(a, "id")?);
            Value::Null
        }
        "prefill" => {
            e.prefill();
            Value::Null
        }
        "set_streamed" => {
            e.set_streamed(&arg::<Vec<usize>>(a, "sessions")?);
            Value::Null
        }
        "switch_stream" => {
            e.switch_stream(arg(a, "from")?, arg(a, "to")?, arg(a, "id")?)?;
            Value::Null
        }
        "mark_start" => json!(e.mark_start()),
        "mark_end" => json!(e.mark_end()),
        "finish_scenario" => {
            e.finish_scenario(arg(a, "raw")?);
            Value::Null
        }
        "finish_bench" => {
            e.finish_bench(arg(a, "notes")?, arg(a, "errors")?)?;
            if e.cfg.bench {
                // Laisse partir la réponse, puis ferme Chrome et quitte.
                let browser = app.browser;
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(300));
                    if let Some(pid) = browser {
                        kill_tree(pid);
                    }
                    std::process::exit(0);
                });
            }
            Value::Null
        }
        "log" => {
            eprintln!("[front] {}", arg::<String>(a, "msg")?);
            Value::Null
        }
        // Pas de vrai PTY en mode web.
        "pty_write" | "pty_resize" => Value::Null,
        other => return Err(format!("commande inconnue : {other}")),
    })
}

async fn ws(upgrade: WebSocketUpgrade, State(app): State<Arc<App>>) -> Response {
    upgrade.on_upgrade(move |socket| connection(socket, app))
}

/// Une connexion : une tâche d'envoi (lots des sessions et réponses, dans l'ordre, par une seule
/// file) et une tâche de lecture, pour qu'un gros envoi (pic de 5 Mo) ne retarde jamais une requête.
async fn connection(socket: WebSocket, app: Arc<App>) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = unbounded_channel::<Out>();
    let sender = tokio::spawn(async move {
        while let Some(out) = rx.recv().await {
            let msg = match out {
                Out::Data(b) => Message::Binary(b.into()),
                Out::Text(t) => Message::Text(t.into()),
            };
            if sink.send(msg).await.is_err() {
                break;
            }
        }
    });
    while let Some(msg) = stream.next().await {
        let text = match msg {
            Ok(Message::Text(t)) => t,
            Ok(Message::Close(_)) | Err(_) => break,
            Ok(_) => continue,
        };
        let reply = match serde_json::from_str::<Request>(&text) {
            Err(e) => {
                // Renvoie l'identifiant s'il est lisible : le front rejette alors la bonne requête.
                let id = serde_json::from_str::<Value>(&text)
                    .ok()
                    .and_then(|v| v.get("id").cloned())
                    .unwrap_or(Value::Null);
                json!({ "id": id, "ok": false, "error": format!("requête invalide : {e}") })
            }
            Ok(r) => match dispatch(&app, &r.cmd, &r.args, &tx) {
                Ok(v) => json!({ "id": r.id, "ok": true, "result": v }),
                Err(e) => json!({ "id": r.id, "ok": false, "error": e }),
            },
        };
        let _ = tx.send(Out::Text(reply.to_string()));
    }
    sender.abort();
    if app.engine.cfg.bench && !app.engine.done.load(Ordering::SeqCst) {
        abort(
            &app,
            "Connexion WebSocket fermée avant la fin (fenêtre Chrome fermée ?) : RAPPORT PARTIEL.",
        );
    }
}

fn host(browser_version: &str, xwayland: bool) -> Host {
    Host {
        title: "Chrome + xterm.js (mode web)".into(),
        engine: format!(
            "Chromium ({browser_version}){}",
            if xwayland {
                " — **XWayland forcé (--ozone-platform=x11) pour --monitor**"
            } else {
                ""
            }
        ),
        transport: "WebSocket (127.0.0.1, trames binaires)".into(),
        encoding: WS_ENCODING.into(),
        small_label: "messages < 1 Ko".into(),
        render: CHROME,
        notes: WEB_NOTES.iter().map(|s| s.to_string()).collect(),
    }
}

#[tokio::main]
async fn main() {
    let fail = |e: String| -> ! {
        eprintln!("[bench] configuration invalide : {e}");
        std::process::exit(2);
    };
    let mut args = parse_args().unwrap_or_else(|e| fail(e));
    let cfg = Config::from_env("chrome").unwrap_or_else(|e| fail(e));
    if std::env::args().any(|a| a == "--print-report-name") {
        println!("{}", cfg.report_name);
        return;
    }
    eprintln!("[bench] configuration : {cfg:?}");
    let version = match args.browser.first() {
        Some(b) => run(b, &["--version"]),
        None => "aucun navigateur lancé par bench-web".into(),
    };
    // `--monitor` : sous Wayland natif, Chrome ignore toute position de fenêtre ; on le passe en
    // XWayland pour le placer sur la sortie (position X11 lue par xrandr) puis en plein écran.
    let mut screen_result = None;
    let target = match (&cfg.monitor, args.browser.is_empty()) {
        (Some(c), false) => match xrandr_output(c) {
            Some((x, y, w, h)) => {
                args.browser.extend([
                    "--ozone-platform=x11".to_string(),
                    format!("--window-position={x},{y}"),
                    "--start-fullscreen".to_string(),
                ]);
                screen_result = Some(format!(
                    "Chrome en **XWayland** (--ozone-platform=x11), fenêtre placée sur {c} \
                     (X11 : {w}×{h} à ({x}, {y})) puis --start-fullscreen"
                ));
                Some((x, y, w, h))
            }
            None => {
                screen_result = Some(format!(
                    "{c} introuvable dans `xrandr --listmonitors` : Chrome laissé en natif, placé par le compositeur"
                ));
                None
            }
        },
        (Some(c), true) => {
            screen_result = Some(format!(
                "{c} demandé, mais aucun navigateur lancé par bench-web"
            ));
            None
        }
        (None, _) => None,
    };
    // Même densité de pixels que WebKitGTK (échelle GDK de la sortie), si le script la fournit.
    let dpr = std::env::var("BENCH_DPR").ok().filter(|d| !d.is_empty());
    if let (Some(d), false) = (&dpr, args.browser.is_empty()) {
        args.browser
            .push(format!("--force-device-scale-factor={d}"));
    }
    let engine =
        Engine::new(cfg, host(&version, target.is_some()), |_| true).unwrap_or_else(|e| fail(e));
    *engine.dist_hash.lock().unwrap() = format!(
        "{} (servi depuis {})",
        bench_core::engine::dist_hash(std::path::Path::new(&args.dist)),
        args.dist
    );
    {
        let mut h = engine.header_extra.lock().unwrap();
        h.insert(
            "Chrome sous XWayland".into(),
            if target.is_some() {
                "**oui** (forcé par --monitor : --ozone-platform=x11)".into()
            } else {
                "non demandé (plateforme par défaut de Chrome, voir « Chrome --ozone-platform »)"
                    .into()
            },
        );
        h.insert(
            "devicePixelRatio forcé (Chrome)".into(),
            dpr.map_or("non (densité par défaut de Chrome)".into(), |d| {
                format!("--force-device-scale-factor={d}")
            }),
        );
        if !args.browser.is_empty() {
            h.insert("drapeaux Chrome".into(), args.browser[1..].join(" "));
        }
    }
    if let Some(r) = screen_result {
        *engine.screen_result.lock().unwrap() = r;
    }

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", args.port))
        .await
        .unwrap_or_else(|e| fail(format!("127.0.0.1:{} : {e}", args.port)));
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(args.port);
    let url = format!("http://127.0.0.1:{port}/?transport=ws");
    eprintln!("[bench] front servi sur {url} (dossier {})", args.dist);
    {
        let mut env = engine.env_extra.lock().unwrap();
        env.insert("navigateur (--version)".into(), version);
        env.insert("serveur".into(), format!("bench-web, {url}"));
        if !args.browser.is_empty() {
            env.insert("drapeaux Chrome".into(), args.browser[1..].join(" "));
        }
    }
    engine.start();

    let browser = match args.browser.split_first() {
        None => None,
        Some((cmd, flags)) => {
            let mut child = Command::new(cmd)
                .args(flags)
                .arg(format!("--app={url}"))
                .spawn()
                .unwrap_or_else(|e| fail(format!("lancement de {cmd} : {e}")));
            let pid = child.id();
            eprintln!("[bench] Chrome lancé, PID {pid}");
            engine
                .env_extra
                .lock()
                .unwrap()
                .insert("PID Chrome".into(), pid.to_string());
            let e = engine.clone();
            std::thread::spawn(move || {
                // Après le démarrage : la plateforme Ozone se lit sur les processus fils.
                std::thread::sleep(Duration::from_secs(5));
                e.env_extra
                    .lock()
                    .unwrap()
                    .insert("Chrome --ozone-platform".into(), ozone_of(pid));
            });
            let e = engine.clone();
            std::thread::spawn(move || {
                let status = child.wait();
                if e.cfg.bench && !e.done.load(Ordering::SeqCst) {
                    e.abort(&format!(
                        "Chrome s'est terminé avant la fin ({status:?}) : RAPPORT PARTIEL. \
                         Une autre instance utilise-t-elle déjà ce profil ?"
                    ));
                    std::process::exit(EXIT_PARTIAL);
                }
            });
            Some(pid)
        }
    };
    if engine.cfg.bench {
        engine.spawn_watchdog(move || {
            if let Some(pid) = browser {
                kill_tree(pid);
            }
        });
    }

    let app = Arc::new(App {
        engine,
        target,
        browser,
    });
    let router = Router::new()
        .route("/ws", get(ws))
        .fallback_service(ServeDir::new(&args.dist))
        .with_state(app);
    // Sans Nagle : chaque lot part tout de suite, comme un message IPC.
    let listener = listener.tap_io(|tcp| {
        let _ = tcp.set_nodelay(true);
    });
    if let Err(e) = axum::serve(listener, router).await {
        eprintln!("[bench] serveur arrêté : {e}");
    }
}
