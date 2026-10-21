//! Processus d'un plugin (v0.3, lot 22a) : la matrice du prototype n° 6
//! contre l'adaptateur [`ProcessPluginHost`], sans démon. Sautée sans
//! `python3` ; les cas qui demandent un scope systemd sont sautés sans
//! gestionnaire systemd utilisateur.

mod common;

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use common::plugin::{FAKE_PLUGIN_PY, no_python, no_systemd, process_alive};
use devmaestro_core::adapters::ProcessPluginHost;
use devmaestro_core::ports::{PluginError, PluginHost, PluginLaunch, PluginProcess, PluginScope};
use serde_json::json;

const QUICK: Duration = Duration::from_secs(5);

struct Running {
    proc: Arc<dyn PluginProcess>,
    exited: Arc<AtomicBool>,
    _dir: tempfile::TempDir,
}

fn launch(mode: &str, scoped: bool, extra: &[&str]) -> Running {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("fake_plugin.py"), FAKE_PLUGIN_PY).unwrap();
    let python = std::env::split_paths(&std::env::var_os("PATH").unwrap())
        .map(|d| d.join("python3"))
        .find(|p| p.is_file())
        .unwrap();
    let mut args = vec!["-I".to_owned(), "fake_plugin.py".into(), mode.into()];
    args.extend(extra.iter().map(|s| (*s).to_owned()));
    let scope = scoped.then(|| PluginScope {
        systemd_run: "/usr/bin/systemd-run".into(),
        systemctl: "/usr/bin/systemctl".into(),
        unit: format!(
            "devmaestro-plugin-test-{}-{mode}.scope",
            &uuid::Uuid::new_v4().simple().to_string()[..8]
        ),
        runtime_dir: None,
    });
    let env: Vec<(String, std::ffi::OsString)> = ["PATH", "HOME", "XDG_RUNTIME_DIR"]
        .iter()
        .filter_map(|k| Some(((*k).to_owned(), std::env::var_os(k)?)))
        .collect();
    let exited = Arc::new(AtomicBool::new(false));
    let e2 = exited.clone();
    let proc = ProcessPluginHost
        .spawn(
            &PluginLaunch {
                name: format!("test-{mode}"),
                program: python,
                args,
                cwd: dir.path().to_path_buf(),
                env,
                scope,
            },
            Box::new(move || e2.store(true, Ordering::SeqCst)),
        )
        .unwrap();
    let init = proc
        .request("initialize", Some(json!({"api_version": 1})), QUICK)
        .unwrap();
    assert_eq!(init["api_version"], 1);
    Running {
        proc,
        exited,
        _dir: dir,
    }
}

fn render(r: &Running, timeout: Duration) -> Result<serde_json::Value, PluginError> {
    r.proc.request(
        "panel.render",
        Some(json!({"session": {"id": "s"}})),
        timeout,
    )
}

fn stop_and_check(r: &Running) -> Duration {
    let start = Instant::now();
    r.proc.stop();
    let took = start.elapsed();
    assert!(!r.proc.alive(), "le plugin tourne encore après stop");
    let pid = r.proc.pid().unwrap();
    assert!(!process_alive(pid), "processus {pid} encore là (zombie ?)");
    let deadline = Instant::now() + Duration::from_secs(2);
    while !r.exited.load(Ordering::SeqCst) {
        assert!(Instant::now() < deadline, "on_exit jamais appelé");
        std::thread::sleep(Duration::from_millis(10));
    }
    took
}

fn skip() -> bool {
    no_python()
}

#[test]
fn nominal_render_then_polite_shutdown() {
    if skip() {
        return;
    }
    for scoped in [false, true] {
        if scoped && no_systemd("variante avec scope") {
            continue;
        }
        let r = launch("notify", scoped, &[]);
        let start = Instant::now();
        let doc = render(&r, QUICK).unwrap();
        assert!(start.elapsed() < Duration::from_secs(2));
        assert_eq!(doc["blocks"][0]["type"], "markdown");
        // Deux requêtes à la suite, ids distincts.
        render(&r, QUICK).unwrap();
        // Une réponse `error` n'arrête pas le plugin.
        let e = r
            .proc
            .request("action.run", Some(json!({"action": "fail"})), QUICK)
            .unwrap_err();
        assert!(matches!(e, PluginError::Error { code: -1, .. }));
        assert!(r.proc.alive());
        render(&r, QUICK).unwrap();
        let took = stop_and_check(&r);
        // `shutdown` poli : pas besoin d'attendre SIGKILL.
        assert!(took < Duration::from_secs(3), "arrêt en {took:?}");
    }
}

#[test]
fn blocked_plugin_times_out() {
    if skip() {
        return;
    }
    let r = launch("sleep", false, &[]);
    let start = Instant::now();
    assert_eq!(
        render(&r, Duration::from_millis(500)),
        Err(PluginError::Timeout)
    );
    assert!(start.elapsed() < Duration::from_secs(2));
    // Après une défaillance, toute requête rend la même erreur.
    assert_eq!(render(&r, QUICK), Err(PluginError::Timeout));
    stop_and_check(&r);
}

#[test]
fn flood_of_notifications_stops_the_plugin() {
    if skip() {
        return;
    }
    let r = launch("flood", false, &[]);
    assert_eq!(render(&r, QUICK), Err(PluginError::Flood));
    stop_and_check(&r);
}

#[test]
fn giant_line_without_newline_is_refused_quickly() {
    if skip() {
        return;
    }
    let r = launch("hugeline", false, &[]);
    let start = Instant::now();
    assert_eq!(render(&r, QUICK), Err(PluginError::LineTooLong));
    assert!(start.elapsed() < Duration::from_secs(3));
    stop_and_check(&r);
}

#[test]
fn crash_is_detected_at_once() {
    if skip() {
        return;
    }
    let r = launch("crash", false, &[]);
    let start = Instant::now();
    assert_eq!(render(&r, QUICK), Err(PluginError::Closed));
    assert!(start.elapsed() < Duration::from_secs(2));
    stop_and_check(&r);
}

#[test]
fn massive_stderr_does_not_block() {
    if skip() {
        return;
    }
    let r = launch("stderr_spam", false, &[]);
    // ~6 Mio sur stderr avant la réponse.
    let doc = render(&r, Duration::from_secs(20)).unwrap();
    assert_eq!(doc["blocks"][0]["type"], "markdown");
    // stderr est lu par son propre fil : sa fin peut arriver après la réponse.
    let deadline = Instant::now() + QUICK;
    loop {
        let tail = r.proc.stderr_tail();
        assert!(tail.len() <= 4096, "{}", tail.len());
        if tail.ends_with("fin du bruit\n") {
            break;
        }
        assert!(Instant::now() < deadline, "{tail:?}");
        std::thread::sleep(Duration::from_millis(10));
    }
    stop_and_check(&r);
}

#[test]
fn noise_is_not_json() {
    if skip() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("p.py"), FAKE_PLUGIN_PY).unwrap();
    let proc = ProcessPluginHost
        .spawn(
            &PluginLaunch {
                name: "noise".into(),
                program: "/usr/bin/env".into(),
                args: vec!["python3".into(), "-I".into(), "p.py".into(), "noise".into()],
                cwd: dir.path().to_path_buf(),
                env: vec![("PATH".into(), std::env::var_os("PATH").unwrap())],
                scope: None,
            },
            Box::new(|| {}),
        )
        .unwrap();
    assert_eq!(
        proc.request("initialize", Some(json!({})), QUICK),
        Err(PluginError::NotJson)
    );
    proc.stop();
    assert!(!proc.alive());
}

#[test]
fn request_from_plugin_and_unknown_id_stop_it() {
    if skip() {
        return;
    }
    let r = launch("request", false, &[]);
    assert!(matches!(render(&r, QUICK), Err(PluginError::Protocol(_))));
    stop_and_check(&r);
    let r = launch("unknown_id", false, &[]);
    assert!(matches!(render(&r, QUICK), Err(PluginError::Protocol(_))));
    stop_and_check(&r);
}

#[test]
fn detached_grandchild_dies_with_the_scope() {
    if skip() {
        return;
    }
    if no_systemd("petit-enfant détaché et scope") {
        return;
    }
    let pids = tempfile::tempdir().unwrap();
    let pidfile = pids.path().join("petit-enfant");
    let r = launch("fork", true, &[pidfile.to_str().unwrap()]);
    let grandchild = read_pid(&pidfile);
    assert!(process_alive(grandchild));
    render(&r, QUICK).unwrap();
    stop_and_check(&r);
    wait_dead(grandchild);
}

#[test]
fn scope_is_killed_even_when_the_plugin_exits_alone() {
    if skip() {
        return;
    }
    if no_systemd("petit-enfant détaché et scope") {
        return;
    }
    let pids = tempfile::tempdir().unwrap();
    let pidfile = pids.path().join("petit-enfant");
    let r = launch("fork", true, &[pidfile.to_str().unwrap()]);
    let grandchild = read_pid(&pidfile);
    // Le plugin sort seul (`shutdown`), son petit-enfant reste.
    let _ = r.proc.request("shutdown", None, QUICK);
    let deadline = Instant::now() + QUICK;
    while r.proc.alive() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(process_alive(grandchild));
    stop_and_check(&r);
    wait_dead(grandchild);
}

#[test]
fn sigterm_ignored_gets_sigkill_after_a_second() {
    if skip() {
        return;
    }
    for scoped in [true, false] {
        if scoped && no_systemd("variante avec scope") {
            continue;
        }
        let r = launch("ignore_term", scoped, &[]);
        assert_eq!(
            render(&r, Duration::from_millis(300)),
            Err(PluginError::Timeout)
        );
        let took = stop_and_check(&r);
        assert!(
            took >= Duration::from_millis(900) && took < Duration::from_secs(4),
            "arrêt en {took:?}"
        );
    }
}

fn read_pid(path: &Path) -> u32 {
    let deadline = Instant::now() + QUICK;
    loop {
        if let Some(pid) = std::fs::read_to_string(path)
            .ok()
            .and_then(|s| s.trim().parse().ok())
        {
            return pid;
        }
        assert!(Instant::now() < deadline, "pid du petit-enfant absent");
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn wait_dead(pid: u32) {
    let deadline = Instant::now() + QUICK;
    while process_alive(pid) {
        assert!(
            Instant::now() < deadline,
            "petit-enfant {pid} encore vivant"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}
