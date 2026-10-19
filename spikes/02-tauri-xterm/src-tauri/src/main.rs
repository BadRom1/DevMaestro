//! Banc d'essai Tauri 2 + xterm.js : le moteur (`bench_core::engine`) produit les sessions,
//! chaque lot part vers la webview par un `tauri::ipc::Channel` ; ici, seulement les commandes
//! Tauri et l'environnement propre à WebKitGTK.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod monitor;
mod pty;

use bench_core::config::Config;
use bench_core::engine::{run, Engine, Host, Sink};
use bench_core::report::{FrontEnv, RawScenario, IPC_ENCODING, TAURI_NOTES, WEBKIT};
use std::sync::Arc;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager, State};

type AppState = Arc<Engine>;

/// Vrai PTY du mode `--pty` (manuel).
struct PtyState(std::sync::Mutex<Option<pty::Pty>>);

#[tauri::command]
fn get_config(state: State<AppState>) -> Config {
    state.cfg.clone()
}

#[tauri::command]
fn open_session(
    state: State<AppState>,
    id: usize,
    channel: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    let sink: Sink = Arc::new(move |m| {
        let _ = channel.send(InvokeResponseBody::Raw(m));
    });
    state.open_session(id, sink)
}

#[tauri::command(async)]
fn set_streaming(state: State<AppState>, on: bool) {
    state.set_streaming(on);
}

#[tauri::command(async)]
fn register_env(state: State<AppState>, env: FrontEnv) {
    state.register_env(env);
}

#[tauri::command(async)]
fn echo(state: State<AppState>, session: usize, id: u64) {
    state.echo(session, id);
}

#[tauri::command(async)]
fn burst(state: State<AppState>, session: usize, id: u64) {
    state.burst(session, id);
}

#[tauri::command(async)]
fn set_streamed(state: State<AppState>, sessions: Vec<usize>) {
    state.set_streamed(&sessions);
}

#[tauri::command(async)]
fn switch_stream(state: State<AppState>, from: usize, to: usize, id: u64) -> Result<(), String> {
    state.switch_stream(from, to, id)
}

#[tauri::command(async)]
fn prefill(state: State<AppState>) {
    state.prefill();
}

#[tauri::command(async)]
fn mark_start(state: State<AppState>) -> Vec<u64> {
    state.mark_start()
}

#[tauri::command(async)]
fn mark_end(state: State<AppState>) -> Vec<u64> {
    state.mark_end()
}

#[tauri::command(async)]
fn finish_scenario(state: State<AppState>, raw: RawScenario) {
    state.finish_scenario(raw);
}

#[tauri::command(async)]
fn finish_bench(
    app: AppHandle,
    state: State<AppState>,
    notes: Vec<String>,
    errors: Vec<String>,
) -> Result<(), String> {
    state.finish_bench(notes, errors)?;
    if state.cfg.bench {
        app.exit(0);
    }
    Ok(())
}

#[tauri::command(async)]
fn log(msg: String) {
    eprintln!("[front] {msg}");
}

#[tauri::command]
fn pty_write(pty: State<PtyState>, data: String) {
    if let Some(p) = pty.0.lock().unwrap().as_mut() {
        p.write(data.as_bytes());
    }
}

#[tauri::command]
fn pty_resize(pty: State<PtyState>, cols: u16, rows: u16) {
    if let Some(p) = pty.0.lock().unwrap().as_ref() {
        p.resize(cols, rows);
    }
}

fn host() -> Host {
    let webkit = tauri::webview_version().unwrap_or_else(|e| format!("? ({e})"));
    Host {
        title: "Tauri + xterm.js".into(),
        engine: format!("WebKitGTK {webkit}"),
        transport: "IPC Tauri (`tauri::ipc::Channel`, binaire brut)".into(),
        encoding: IPC_ENCODING.into(),
        small_label: "messages < 1 Ko (chemin eval)".into(),
        render: WEBKIT,
        notes: TAURI_NOTES.iter().map(|s| s.to_string()).collect(),
    }
}

fn main() {
    if std::env::args().any(|a| a == "--list-monitors") {
        monitor::list();
        return;
    }
    let cfg = match Config::from_env("") {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[bench] configuration invalide : {e}");
            std::process::exit(2);
        }
    };
    if std::env::args().any(|a| a == "--print-report-name") {
        println!("{}", cfg.report_name);
        return;
    }
    eprintln!("[bench] configuration : {cfg:?}");
    let pty_session0 = cfg.pty && !cfg.bench;
    let state = match Engine::new(cfg, host(), |i| !(pty_session0 && i == 0)) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[bench] démarrage impossible : {e}");
            std::process::exit(2);
        }
    };
    {
        let mut env = state.env_extra.lock().unwrap();
        env.insert(
            "WebKitGTK (bibliothèque chargée)".into(),
            tauri::webview_version().unwrap_or_else(|e| format!("? ({e})")),
        );
        env.insert(
            "WebKitGTK (pkg-config, compilation)".into(),
            run("pkg-config", &["--modversion", "webkit2gtk-4.1"]),
        );
        env.insert(
            "WebKitGTK (paquet, exécution)".into(),
            run(
                "dpkg-query",
                &["-W", "-f=${Version}", "libwebkit2gtk-4.1-0"],
            ),
        );
        env.insert("Tauri".into(), tauri::VERSION.to_string());
        drop(env);
        *state.dist_hash.lock().unwrap() =
            format!("{} (embarqué à la compilation)", env!("BENCH_DIST_HASH"));
        let x11 = std::env::var("GDK_BACKEND").is_ok_and(|b| b.starts_with("x11"))
            || std::env::var("WAYLAND_DISPLAY").is_err();
        state.header_extra.lock().unwrap().insert(
            "plateforme d'affichage".into(),
            if x11 {
                "X11 / XWayland (GDK)"
            } else {
                "Wayland natif (GDK)"
            }
            .into(),
        );
        let mut env = state.env_extra.lock().unwrap();
        env.insert("fenêtre toujours au-dessus".into(), "non demandé".into());
    }
    state.start();

    tauri::Builder::default()
        .manage(state.clone())
        .manage(PtyState(Default::default()))
        .setup(move |app| {
            let st = state.clone();
            let window = app.get_webview_window("main");
            if let (Some(c), None) = (&st.cfg.monitor, &window) {
                *st.screen_result.lock().unwrap() = format!("{c} demandé, fenêtre introuvable");
                *st.screen_ok.lock().unwrap() = Some(false);
            }
            if let (Some(c), Some(w)) = (st.cfg.monitor.clone(), window) {
                *st.screen_result.lock().unwrap() = monitor::fullscreen_on(&w, &c);
                // Vérification une fois le plein écran appliqué par le compositeur.
                let (st, w2) = (st.clone(), w.clone());
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    let _ = w2.run_on_main_thread(move || {
                        let cur = monitor::current(&w);
                        let ok =
                            cur.starts_with(&format!("{c} ")) && cur.ends_with("plein écran true");
                        *st.screen_ok.lock().unwrap() = Some(ok);
                        st.screen_result.lock().unwrap().push_str(&format!(
                            " ; constaté après 3 s : {cur}{}",
                            if ok {
                                ""
                            } else {
                                " — **écran demandé NON atteint**"
                            }
                        ));
                    });
                });
            }
            if st.cfg.bench {
                if let Some(w) = app.get_webview_window("main") {
                    // WebKit ralentit les fenêtres cachées : on demande le premier plan.
                    let res = w.set_always_on_top(true);
                    let on_top = match (res, w.is_always_on_top()) {
                        (Err(e), _) => format!("échec : {e}"),
                        (Ok(()), Ok(on)) => format!(
                            "demandé, état rapporté : {on} (Mutter peut l'ignorer sous Wayland)"
                        ),
                        (Ok(()), Err(e)) => format!("demandé, état inconnu : {e}"),
                    };
                    st.env_extra
                        .lock()
                        .unwrap()
                        .insert("fenêtre toujours au-dessus".into(), on_top);
                    let _ = w.set_focus();
                }
                // Garde-fou : si le front ne termine jamais, on écrit ce qu'on a et on sort.
                st.spawn_watchdog(|| {});
            } else if st.cfg.pty {
                match pty::Pty::spawn(st.clone()) {
                    Ok(p) => *app.state::<PtyState>().0.lock().unwrap() = Some(p),
                    Err(e) => eprintln!("[bench] PTY indisponible : {e}"),
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            open_session,
            set_streaming,
            register_env,
            echo,
            burst,
            prefill,
            set_streamed,
            switch_stream,
            mark_start,
            mark_end,
            finish_scenario,
            finish_bench,
            log,
            pty_write,
            pty_resize
        ])
        .run(tauri::generate_context!())
        .expect("échec du lancement de l'app");
}
