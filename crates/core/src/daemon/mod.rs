//! Le démon `orchd` (ADR 0001) : il porte les sessions Claude Code dans des
//! PTY, garde leur état et leur écran, et sert les clients sur un socket Unix.
//!
//! - une seule instance par utilisateur (verrou `orchd.lock`) ;
//! - deux sockets dans `$XDG_RUNTIME_DIR/devmaestro` (dossier en 0700,
//!   sockets en 0600) : `orchd.sock` pour les clients (front, `orchd ctl`),
//!   refusé aux sessions supervisées et à leurs descendants ([`peer`]), et
//!   `relay.sock` pour les relais de hooks et de statusline (seules les
//!   trames de hook et de statusline y sont acceptées) ;
//! - journal sur la sortie d'erreur et dans `$XDG_STATE_HOME/devmaestro/orchd.log` ;
//! - arrêt propre sur `SIGTERM`, `SIGINT` ou `SIGHUP` : chaque session reçoit
//!   `SIGHUP` (puis `SIGKILL` si elle traîne) ; un second signal pendant
//!   l'arrêt envoie `SIGKILL` à tout et sort aussitôt. **Arrêter le démon
//!   termine donc les sessions** ; elles restent reprenables (`sessions.resume`).

pub mod claude_config;
pub mod launch;
pub(crate) mod log;
pub mod peer;
pub mod server;
pub mod settings;
pub mod supervisor;
pub mod terminal;

use std::fs::OpenOptions;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use nix::fcntl::{Flock, FlockArg};
use tokio::net::UnixListener;
use tokio::signal::unix::{SignalKind, signal};

use crate::adapters::{
    FsFiles, FsProfileSource, FsTranscriptFollower, FsTranscriptSource, GitCli, GitDiff,
    GitWorktrees, GithubCli, NativePty, SqliteStore, SystemClock, UsageApi,
};
use crate::paths::{Paths, create_private_dir};
use log::{error, info};
pub use supervisor::{Config, Daemon, Deps};

/// Réglages par défaut, depuis l'environnement du processus.
pub fn default_config(paths: Paths) -> Result<Config, String> {
    let settings = settings::DaemonSettings::load(&paths.config_file());
    let orchd_exe = std::env::current_exe()
        .and_then(|p| p.canonicalize())
        .map_err(|e| format!("chemin du binaire orchd introuvable : {e}"))?;
    Ok(Config {
        orchd_exe,
        claude_bin_env: std::env::var_os("DEVMAESTRO_CLAUDE_BIN"),
        path_env: std::env::var_os("PATH"),
        exit_grace: Duration::from_millis(500),
        stop_timeout: stop_timeout(),
        // Réglage réservé aux tests : jamais transmis aux processus `claude`.
        permission_timeout_secs: std::env::var("DEVMAESTRO_PERMISSION_TIMEOUT_SECS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .filter(|n| (2..=3600).contains(n))
            .unwrap_or(claude_config::DEFAULT_PERMISSION_TIMEOUT_SECS),
        allow_dangerous_modes: settings.allow_dangerous_modes,
        usage_api: settings.usage_api,
        quota_min_interval: quota_min_interval(),
        systemd_run: detect_systemd_scope(),
        systemd_runtime_dir: std::env::var_os("DEVMAESTRO_SYSTEMD_RUNTIME_DIR"),
        initial_prompt_timeout: initial_prompt_timeout(),
        ci_poll_interval: ci_poll_interval(),
        paths,
    })
}

/// Intervalle minimal entre deux appels à l'API d'usage par profil. Seul un
/// binaire de test (`test-support`) le lit dans
/// `DEVMAESTRO_QUOTA_MIN_INTERVAL_MS`.
fn quota_min_interval() -> Duration {
    #[cfg(feature = "test-support")]
    if let Some(ms) = std::env::var("DEVMAESTRO_QUOTA_MIN_INTERVAL_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
    {
        return Duration::from_millis(ms);
    }
    supervisor::QUOTA_MIN_INTERVAL
}

/// Délai entre le premier signal d'arrêt (`SIGHUP` d'une session, `SIGTERM`
/// d'un runner) et `SIGKILL` : 3 s. Seul un binaire de test
/// (`test-support`) lit `DEVMAESTRO_STOP_TIMEOUT_MS`.
fn stop_timeout() -> Duration {
    #[cfg(feature = "test-support")]
    if let Some(ms) = std::env::var("DEVMAESTRO_STOP_TIMEOUT_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
    {
        return Duration::from_millis(ms);
    }
    Duration::from_secs(3)
}

/// Intervalle du sondage de la CI. Seul un binaire de test
/// (`test-support`) lit `DEVMAESTRO_CI_POLL_MS`.
fn ci_poll_interval() -> Duration {
    #[cfg(feature = "test-support")]
    if let Some(ms) = std::env::var("DEVMAESTRO_CI_POLL_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|ms| *ms > 0)
    {
        return Duration::from_millis(ms);
    }
    supervisor::forge::runs::CI_POLL_INTERVAL
}

/// Délai du prompt initial. Seul un binaire de test (`test-support`) lit
/// `DEVMAESTRO_INITIAL_PROMPT_TIMEOUT_MS`.
fn initial_prompt_timeout() -> Duration {
    #[cfg(feature = "test-support")]
    if let Some(ms) = std::env::var("DEVMAESTRO_INITIAL_PROMPT_TIMEOUT_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
    {
        return Duration::from_millis(ms);
    }
    supervisor::forge::INITIAL_PROMPT_TIMEOUT
}

/// `systemd-run`, si `DEVMAESTRO_SYSTEMD_SCOPE` ne vaut pas `off` et qu'un
/// scope de test se lance (gestionnaire systemd utilisateur joignable) en
/// moins de 3 s ; sinon `None` (lancement direct).
fn detect_systemd_scope() -> Option<PathBuf> {
    if std::env::var("DEVMAESTRO_SYSTEMD_SCOPE").is_ok_and(|v| v == "off") {
        return None;
    }
    let bin = std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|d| d.join("systemd-run"))
        .find(|p| p.is_file())?;
    let mut probe = std::process::Command::new(&bin);
    if let Some(dir) = std::env::var_os("DEVMAESTRO_SYSTEMD_RUNTIME_DIR") {
        probe.env("XDG_RUNTIME_DIR", dir);
    }
    let mut child = probe
        .args(["--user", "--scope", "--quiet", "--collect", "--", "true"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success().then_some(bin),
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

/// Retire de l'environnement du démon les marqueurs de session Claude Code
/// hérités (voir [`launch::CLAUDE_SESSION_MARKERS`]) : ni les sous-processus
/// du démon (`git`, `systemd-run`…) ni les `claude` lancés ne doivent se
/// croire dans une session Claude Code. Renvoie les noms retirés (jamais les
/// valeurs).
///
/// À appeler tant que le processus n'a qu'un fil (avant le runtime tokio).
fn scrub_claude_session_markers() -> Vec<String> {
    let names: Vec<std::ffi::OsString> = std::env::vars_os()
        .map(|(k, _)| k)
        .filter(|k| k.to_str().is_some_and(launch::is_claude_session_marker))
        .collect();
    for name in &names {
        // SAFETY : appelé depuis `run_foreground` avant la création du runtime
        // tokio et de tout autre fil : aucun accès concurrent à
        // l'environnement n'est possible.
        unsafe { std::env::remove_var(name) };
    }
    names
        .into_iter()
        .map(|n| n.to_string_lossy().into_owned())
        .collect()
}

/// Lance le démon au premier plan, jusqu'à un signal d'arrêt.
pub fn run_foreground() -> Result<(), String> {
    let scrubbed = scrub_claude_session_markers();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .worker_threads(2)
        .thread_name("orchd")
        .build()
        .map_err(|e| format!("démarrage du runtime : {e}"))?;
    runtime.block_on(run(Paths::from_env(), scrubbed))
}

async fn run(paths: Paths, scrubbed: Vec<String>) -> Result<(), String> {
    // Dossiers privés (0700, pas de lien symbolique, à l'utilisateur) : le
    // repli du dossier runtime dans /tmp notamment ne doit pas être détourné.
    for dir in [&paths.runtime_dir, &paths.data_dir, &paths.state_dir] {
        create_private_dir(dir).map_err(|e| format!("dossier {} : {e}", dir.display()))?;
    }
    // Verrou d'instance unique, gardé jusqu'à la fin de la fonction.
    let lock_path = paths.lock_file();
    let lock_file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .mode(0o600)
        .open(&lock_path)
        .map_err(|e| format!("ouverture du verrou {} : {e}", lock_path.display()))?;
    let _lock = Flock::lock(lock_file, FlockArg::LockExclusiveNonblock).map_err(|_| {
        format!(
            "un autre démon orchd tourne déjà (verrou {})",
            lock_path.display()
        )
    })?;

    if let Err(e) = log::init(&paths.log_file()) {
        eprintln!(
            "orchd : journal {} indisponible : {e}",
            paths.log_file().display()
        );
    }
    if !scrubbed.is_empty() {
        info!(
            "marqueurs de session Claude Code hérités, retirés de l'environnement : {}",
            scrubbed.join(", ")
        );
    }

    let store = SqliteStore::open(&paths.database())
        .map_err(|e| format!("ouverture de la base {} : {e}", paths.database().display()))?;
    if let Some(aside) = store.set_aside() {
        log::warning!(
            "base illisible mise de côté sous {} ; nouvelle base vide",
            aside.display()
        );
    }
    let config = default_config(paths.clone())?;
    match &config.systemd_run {
        Some(bin) => info!(
            "sessions lancées chacune dans un scope systemd ({} --user --scope)",
            bin.display()
        ),
        None => info!("pas de gestionnaire systemd utilisateur : sessions lancées directement"),
    }
    if config.allow_dangerous_modes {
        log::warning!("allow_dangerous_modes = true : bypassPermissions et dontAsk autorisés");
    }
    let deps = Deps {
        pty: Box::new(NativePty),
        vcs: Box::new(GitCli::default()),
        profiles: Box::new(FsProfileSource::new(paths.home.clone())),
        transcripts: Box::new(FsTranscriptSource::default()),
        store: Box::new(store),
        clock: Box::new(SystemClock),
        quotas: Box::new(UsageApi::from_env()),
        diff: Box::new(GitDiff::default()),
        files: Box::new(FsFiles),
        worktrees: Box::new(GitWorktrees::default()),
        follower: Box::new(FsTranscriptFollower::default()),
        forge: Box::new(GithubCli::from_env()),
    };
    if !config.usage_api {
        info!("[quotas] usage_api = false : quotas lus dans les statuslines seulement");
    }
    let daemon = Daemon::new(config, deps);
    daemon.write_claude_config();
    daemon.restore();
    daemon.start_quota_polling();
    daemon.start_diff_polling();
    daemon.start_worktree_polling();
    daemon.start_ci_polling();
    daemon.start_conversation_follow();

    let socket = paths.socket();
    let relay_socket = paths.relay_socket();
    let listener = bind_private(&socket)?;
    let relay_listener = bind_private(&relay_socket)?;
    info!(
        "orchd {} à l'écoute sur {} (relais : {}) (pid {})",
        env!("CARGO_PKG_VERSION"),
        socket.display(),
        relay_socket.display(),
        std::process::id()
    );

    let accept_daemon = daemon.clone();
    let accept = tokio::spawn(async move { accept_loop(accept_daemon, listener).await });
    let relay_daemon = daemon.clone();
    let accept_relays =
        tokio::spawn(async move { accept_relay_loop(relay_daemon, relay_listener).await });

    wait_for_stop_signal().await?;
    info!("signal d'arrêt reçu");
    // Le socket reste ouvert pendant l'arrêt : les SessionEnd peuvent arriver.
    // Un second signal pendant l'arrêt : SIGKILL à tout, sortie immédiate.
    tokio::select! {
        () = daemon.shutdown() => {}
        second = wait_for_stop_signal() => {
            second?;
            info!("second signal : arrêt immédiat");
            daemon.kill_all();
            daemon.mark_all_stopped();
        }
    }
    accept.abort();
    accept_relays.abort();
    remove_socket(&socket);
    remove_socket(&relay_socket);
    info!("orchd arrêté");
    Ok(())
}

fn remove_socket(socket: &PathBuf) {
    if let Err(e) = std::fs::remove_file(socket)
        && e.kind() != std::io::ErrorKind::NotFound
    {
        error!("suppression du socket : {e}");
    }
}

/// Écoute sur un socket en 0600. Le verrou est pris : un socket présent est
/// celui d'un démon mort.
fn bind_private(path: &PathBuf) -> Result<UnixListener, String> {
    let _ = std::fs::remove_file(path);
    let listener =
        UnixListener::bind(path).map_err(|e| format!("écoute sur {} : {e}", path.display()))?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("droits du socket {} : {e}", path.display()))?;
    Ok(listener)
}

/// Socket de contrôle : chaque pair est vérifié ([`peer::check`]) avant
/// d'être servi ; un refus ferme la connexion sans rien envoyer.
async fn accept_loop(daemon: Arc<Daemon>, listener: UnixListener) {
    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                // Les lectures de /proc se font hors du runtime.
                let d = daemon.clone();
                let verdict = tokio::task::spawn_blocking(move || {
                    let peer = peer::Peer::of(&stream)?;
                    d.check_control_peer(&peer).map(|()| stream)
                })
                .await
                .unwrap_or_else(|e| Err(format!("contrôle du pair : {e}")));
                match verdict {
                    Ok(stream) => {
                        tokio::spawn(server::handle_connection(daemon.clone(), stream));
                    }
                    Err(why) => log::warning!("connexion au socket de contrôle refusée : {why}"),
                }
            }
            Err(e) => {
                error!("accept : {e}");
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }
}

/// Socket des relais : authentification par jeton, trames de hook et de
/// statusline seulement.
async fn accept_relay_loop(daemon: Arc<Daemon>, listener: UnixListener) {
    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                tokio::spawn(server::handle_relay_connection(daemon.clone(), stream));
            }
            Err(e) => {
                error!("accept (relais) : {e}");
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }
}

async fn wait_for_stop_signal() -> Result<(), String> {
    let mk = |k: SignalKind| signal(k).map_err(|e| format!("installation des signaux : {e}"));
    let mut term = mk(SignalKind::terminate())?;
    let mut int = mk(SignalKind::interrupt())?;
    let mut hup = mk(SignalKind::hangup())?;
    tokio::select! {
        _ = term.recv() => {}
        _ = int.recv() => {}
        _ = hup.recv() => {}
    }
    Ok(())
}
