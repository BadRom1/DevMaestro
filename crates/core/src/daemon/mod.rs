//! Le démon `orchd` (ADR 0001) : il porte les sessions Claude Code dans des
//! PTY, garde leur état et leur écran, et sert les clients sur un socket Unix.
//!
//! - une seule instance par utilisateur (verrou `orchd.lock`) ;
//! - socket `$XDG_RUNTIME_DIR/devmaestro/orchd.sock`, dossier en 0700,
//!   socket en 0600 ;
//! - journal sur la sortie d'erreur et dans `$XDG_STATE_HOME/devmaestro/orchd.log` ;
//! - arrêt propre sur `SIGTERM`, `SIGINT` ou `SIGHUP` : chaque session reçoit
//!   `SIGHUP` (puis `SIGKILL` si elle traîne) ; un second signal pendant
//!   l'arrêt envoie `SIGKILL` à tout et sort aussitôt. **Arrêter le démon
//!   termine donc les sessions** ; elles restent reprenables (`sessions.resume`).

pub mod claude_config;
pub mod launch;
pub(crate) mod log;
pub mod server;
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
    FsProfileSource, FsTranscriptSource, GitCli, NativePty, SqliteStore, SystemClock,
};
use crate::paths::{Paths, create_private_dir};
use log::{error, info};
pub use supervisor::{Config, Daemon, Deps};

/// Réglages par défaut, depuis l'environnement du processus.
pub fn default_config(paths: Paths) -> Result<Config, String> {
    let orchd_exe = std::env::current_exe()
        .and_then(|p| p.canonicalize())
        .map_err(|e| format!("chemin du binaire orchd introuvable : {e}"))?;
    Ok(Config {
        paths,
        orchd_exe,
        claude_bin_env: std::env::var_os("DEVMAESTRO_CLAUDE_BIN"),
        path_env: std::env::var_os("PATH"),
        exit_grace: Duration::from_millis(500),
        stop_timeout: Duration::from_secs(3),
    })
}

/// Lance le démon au premier plan, jusqu'à un signal d'arrêt.
pub fn run_foreground() -> Result<(), String> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .worker_threads(2)
        .thread_name("orchd")
        .build()
        .map_err(|e| format!("démarrage du runtime : {e}"))?;
    runtime.block_on(run(Paths::from_env()))
}

async fn run(paths: Paths) -> Result<(), String> {
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

    let store = SqliteStore::open(&paths.database())
        .map_err(|e| format!("ouverture de la base {} : {e}", paths.database().display()))?;
    if let Some(aside) = store.set_aside() {
        log::warning!(
            "base illisible mise de côté sous {} ; nouvelle base vide",
            aside.display()
        );
    }
    let config = default_config(paths.clone())?;
    let deps = Deps {
        pty: Box::new(NativePty),
        vcs: Box::new(GitCli::default()),
        profiles: Box::new(FsProfileSource::new(paths.home.clone())),
        transcripts: Box::new(FsTranscriptSource),
        store: Box::new(store),
        clock: Box::new(SystemClock),
    };
    let daemon = Daemon::new(config, deps);
    daemon.write_claude_config();
    daemon.restore();

    let socket = paths.socket();
    // Le verrou est pris : un socket présent est celui d'un démon mort.
    let _ = std::fs::remove_file(&socket);
    let listener = UnixListener::bind(&socket)
        .map_err(|e| format!("écoute sur {} : {e}", socket.display()))?;
    std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("droits du socket : {e}"))?;
    info!(
        "orchd {} à l'écoute sur {} (pid {})",
        env!("CARGO_PKG_VERSION"),
        socket.display(),
        std::process::id()
    );

    let accept_daemon = daemon.clone();
    let accept = tokio::spawn(async move { accept_loop(accept_daemon, listener).await });

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
    remove_socket(&socket);
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

async fn accept_loop(daemon: Arc<Daemon>, listener: UnixListener) {
    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                tokio::spawn(server::handle_connection(daemon.clone(), stream));
            }
            Err(e) => {
                error!("accept : {e}");
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
