//! Runners (v0.3, lot 14a) côté démon : `runners.list`, `runners.start`,
//! `runners.stop`, `runners.subscribe` / `runners.unsubscribe`,
//! `runners.resize`, notification `runners.changed`.
//!
//! La détection est dans le domaine ([`crate::domain::runners`]) ; ici, la
//! lecture du worktree (mêmes garanties que `files.read`), le lancement en
//! PTY (scope systemd `devmaestro-runner-….scope`, environnement nettoyé),
//! le port du worktree et l'arrêt.
//!
//! **Aucune commande libre** : `runners.start` ne prend qu'un `runner_id`,
//! cherché dans une détection refaite à l'instant sur le disque ; la
//! commande lancée est celle que la détection a construite.
//!
//! Verrous : la table des runners a son propre verrou, jamais pris en même
//! temps que celui du registre des sessions (ni dans un sens ni dans
//! l'autre) ; celui du terminal est relâché avant de prendre celui de la
//! table. `runner_start` sérialise les lancements (contrôle de la limite,
//! choix du port, inscription) et la suppression d'un worktree.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use time::OffsetDateTime;
use tokio::sync::mpsc;
use uuid::Uuid;

use super::{
    Daemon, Event, INPUT_QUEUE, RpcError, Subscription, opt_str, session_id_param, size_param,
    spawn_thread,
};
use crate::daemon::launch::{self, RunnerSpec, ScopeSpec};
use crate::daemon::log::{info, warning};
use crate::daemon::peer::{self, SupervisedProc};
use crate::daemon::terminal::Terminal;
use crate::domain::files::EntryKind;
use crate::domain::runners::{
    self, Loaded, MAX_HASH_BYTES, MAX_LIVE_PER_SESSION, MAX_SOURCE_BYTES, RepoView, Runner,
    RunnerKind, UrlScanner,
};
use crate::ports::{ExitStatus, FileAccess, PtyControl, TermSize};
use crate::protocol::error_code;
use crate::protocol::json::time_json;

/// Taille du terminal d'un runner quand le client n'en donne pas.
pub const RUNNER_SIZE: TermSize = TermSize {
    cols: 120,
    rows: 30,
};

/// Processus terminés gardés au plus par session (les plus anciens partent).
pub const MAX_EXITED_PER_SESSION: usize = 16;

/// Lecture du worktree pour la détection, confinée à sa racine.
struct FsView<'a> {
    files: &'a dyn FileAccess,
    root: &'a Path,
}

impl FsView<'_> {
    fn entries(&self, rel: &str, kind: EntryKind) -> Vec<String> {
        let mut names: Vec<String> = self
            .files
            .list_dir(self.root, rel)
            .map(|(e, _)| e)
            .unwrap_or_default()
            .into_iter()
            .filter(|e| e.kind == kind)
            .map(|e| e.name)
            .collect();
        names.sort();
        names
    }
}

impl RepoView for FsView<'_> {
    fn read(&self, rel: &str) -> Option<String> {
        let f = self
            .files
            .read_beneath(self.root, rel, MAX_SOURCE_BYTES)
            .ok()?;
        String::from_utf8(f.bytes?).ok()
    }
    fn is_file(&self, rel: &str) -> bool {
        self.files
            .lstat(self.root, rel)
            .is_some_and(|e| e.kind == EntryKind::File)
    }
    fn is_dir(&self, rel: &str) -> bool {
        self.files
            .lstat(self.root, rel)
            .is_some_and(|e| e.kind == EntryKind::Dir)
    }
    fn subdirs(&self, rel: &str) -> Vec<String> {
        self.entries(rel, EntryKind::Dir)
    }
    fn files(&self, rel: &str) -> Vec<String> {
        self.entries(rel, EntryKind::File)
    }
    fn hash_large(&self, rel: &str) -> Option<(u64, Option<String>)> {
        self.files
            .hash_beneath(self.root, rel, runners::MAX_STREAM_HASH_BYTES)
            .ok()
    }
    fn load(&self, rel: &str) -> Loaded {
        use crate::ports::FileError;
        match self.files.read_beneath(self.root, rel, MAX_HASH_BYTES) {
            Ok(f) => match f.bytes {
                Some(b) => Loaded::Bytes(b),
                None => Loaded::TooLarge(f.size),
            },
            Err(FileError::NotFound) => Loaded::Absent(None),
            Err(FileError::Outside(_)) => Loaded::Outside,
            Err(FileError::NotRegular) => Loaded::Absent(Some("pas un fichier ordinaire".into())),
            Err(FileError::Denied) => Loaded::Absent(Some("lecture refusée".into())),
            Err(_) => Loaded::Absent(Some("illisible".into())),
        }
    }
}

/// Un processus de runner (vivant ou terminé).
pub(super) struct RunnerProc {
    process_id: Uuid,
    session_id: Uuid,
    runner: Runner,
    /// Racine du worktree (résolue).
    root: PathBuf,
    port: u16,
    seq: u64,
    started_at: OffsetDateTime,
    ended_at: Option<OffsetDateTime>,
    exit: Option<ExitStatus>,
    pid: Option<u32>,
    terminal: Arc<Terminal>,
    control: Box<dyn PtyControl>,
    input: mpsc::Sender<Vec<u8>>,
    urls: Vec<String>,
}

impl RunnerProc {
    fn alive(&self) -> bool {
        self.ended_at.is_none()
    }

    fn json(&self) -> Value {
        let (exit_code, signal) = match &self.exit {
            Some(ExitStatus::Code(c)) => (json!(c), Value::Null),
            Some(ExitStatus::Signal(s)) => (Value::Null, json!(s)),
            None => (Value::Null, Value::Null),
        };
        json!({
            "process_id": self.process_id,
            "runner_id": self.runner.id,
            "session_id": self.session_id,
            "label": self.runner.label,
            "kind": self.runner.kind.as_str(),
            "command": self.runner.command,
            "cwd": self.runner.cwd,
            "port": self.port,
            "started_at": time_json(Some(self.started_at)),
            "ended_at": time_json(self.ended_at),
            "state": if self.alive() { "running" } else { "exited" },
            "exit_code": exit_code,
            "signal": signal,
            "urls": self.urls,
        })
    }
}

/// Processus des runners et ports des worktrees.
#[derive(Default)]
pub(super) struct RunnerTable {
    procs: HashMap<Uuid, RunnerProc>,
    /// Port attribué à chaque worktree (racine résolue), pour la vie du démon.
    ports: HashMap<PathBuf, u16>,
    next_seq: u64,
}

impl RunnerTable {
    fn of_session(&self, sid: &Uuid) -> Vec<&RunnerProc> {
        let mut v: Vec<&RunnerProc> = self
            .procs
            .values()
            .filter(|p| p.session_id == *sid)
            .collect();
        v.sort_by_key(|p| p.seq);
        v
    }

    /// Garde au plus [`MAX_EXITED_PER_SESSION`] processus terminés.
    fn prune_exited(&mut self, sid: &Uuid) {
        let mut exited: Vec<(u64, Uuid)> = self
            .procs
            .values()
            .filter(|p| p.session_id == *sid && !p.alive())
            .map(|p| (p.seq, p.process_id))
            .collect();
        if exited.len() <= MAX_EXITED_PER_SESSION {
            return;
        }
        exited.sort();
        let excess = exited.len() - MAX_EXITED_PER_SESSION;
        for (_, id) in exited.into_iter().take(excess) {
            self.procs.remove(&id);
        }
    }
}

fn unknown_runner(id: &str) -> RpcError {
    RpcError::new(
        error_code::UNKNOWN_RUNNER,
        format!("runner inconnu : « {id} » (absent de la détection actuelle)"),
    )
}

fn unknown_process(id: &Uuid) -> RpcError {
    RpcError::new(
        error_code::UNKNOWN_RUNNER_PROCESS,
        format!("processus de runner inconnu : {id}"),
    )
}

/// `process_id` (UUID) des paramètres.
pub fn process_id_param(params: &Value) -> Result<Uuid, RpcError> {
    opt_str(params, "process_id")?
        .ok_or_else(|| RpcError::params("« process_id » manquant"))?
        .parse()
        .map_err(|_| RpcError::params("« process_id » : UUID invalide"))
}

/// `id` (session) facultatif des méthodes sur un processus : s'il est
/// donné, le processus doit appartenir à cette session.
fn owner_param(params: &Value) -> Result<Option<Uuid>, RpcError> {
    match params.get("id") {
        None | Some(Value::Null) => Ok(None),
        Some(_) => session_id_param(params).map(Some),
    }
}

/// Processus `process_id`, de la session `owner` si elle est donnée.
fn proc_of<'a>(
    t: &'a RunnerTable,
    process_id: &Uuid,
    owner: Option<Uuid>,
) -> Result<&'a RunnerProc, RpcError> {
    t.procs
        .get(process_id)
        .filter(|p| owner.is_none_or(|o| o == p.session_id))
        .ok_or_else(|| unknown_process(process_id))
}

/// Le port est-il pris sur la boucle locale (IPv4 ou IPv6) ? Sonde par
/// `bind` sans `listen` (aucun port n'est ouvert), avec `SO_REUSEADDR` pour
/// ne pas compter les connexions en `TIME_WAIT` d'un serveur arrêté.
fn port_in_use(port: u16) -> bool {
    use nix::errno::Errno;
    use nix::sys::socket::{
        AddressFamily, SockFlag, SockType, SockaddrIn, SockaddrIn6, bind, setsockopt, socket,
        sockopt,
    };
    use std::net::{Ipv4Addr, Ipv6Addr, SocketAddrV4, SocketAddrV6};
    use std::os::fd::AsRawFd;
    let probe = |v6: bool| -> bool {
        let family = if v6 {
            AddressFamily::Inet6
        } else {
            AddressFamily::Inet
        };
        let Ok(fd) = socket(family, SockType::Stream, SockFlag::SOCK_CLOEXEC, None) else {
            return false;
        };
        let _ = setsockopt(&fd, sockopt::ReuseAddr, &true);
        let r = if v6 {
            bind(
                fd.as_raw_fd(),
                &SockaddrIn6::from(SocketAddrV6::new(Ipv6Addr::LOCALHOST, port, 0, 0)),
            )
        } else {
            bind(
                fd.as_raw_fd(),
                &SockaddrIn::from(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)),
            )
        };
        r == Err(Errno::EADDRINUSE)
    };
    probe(false) || probe(true)
}

impl Daemon {
    /// Runners détectés dans le worktree d'une session, et sa racine. Bloquant.
    fn detect_runners(&self, sid: &Uuid) -> Result<(Vec<Runner>, PathBuf, PathBuf), RpcError> {
        let (cwd, root, _) = self.files_root(sid)?;
        let view = FsView {
            files: self.deps.files.as_ref(),
            root: &root,
        };
        Ok((runners::detect(&view), root, cwd))
    }

    fn runner_table(&self) -> std::sync::MutexGuard<'_, RunnerTable> {
        self.runners.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Processus de runners d'une session (ordre de lancement).
    pub fn runners_running_json(&self, sid: &Uuid) -> Value {
        Value::Array(
            self.runner_table()
                .of_session(sid)
                .into_iter()
                .map(RunnerProc::json)
                .collect(),
        )
    }

    /// Sessions qui ont des processus de runners (renvoi de l'état).
    pub fn sessions_with_runners(&self) -> Vec<Uuid> {
        let set: HashSet<Uuid> = self
            .runner_table()
            .procs
            .values()
            .map(|p| p.session_id)
            .collect();
        set.into_iter().collect()
    }

    fn runners_changed(&self, sid: Uuid) {
        let live = self
            .runner_table()
            .procs
            .values()
            .filter(|p| p.session_id == sid && p.alive())
            .count();
        let changed = {
            let mut m = self.runner_live.lock().unwrap_or_else(|e| e.into_inner());
            let old = if live == 0 {
                m.remove(&sid)
            } else {
                m.insert(sid, live)
            };
            old.unwrap_or(0) != live
        };
        let _ = self.events.send(Event::RunnersChanged(sid));
        if changed {
            // `Session.runners_running` a changé.
            let _ = self.events.send(Event::Updated(sid));
        }
    }

    /// Runners vivants d'une session (`Session.runners_running`).
    pub(super) fn live_runners_of(&self, sid: &Uuid) -> usize {
        self.runner_live
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(sid)
            .copied()
            .unwrap_or(0)
    }

    /// `runners.list {id}` → `{runners, running}`. Bloquant (disque).
    pub fn runners_list(&self, params: &Value) -> Result<Value, RpcError> {
        let sid = session_id_param(params)?;
        let (detected, _, _) = self.detect_runners(&sid)?;
        Ok(json!({
            "runners": detected.iter().map(runner_json).collect::<Vec<_>>(),
            "running": self.runners_running_json(&sid),
        }))
    }

    /// Port du worktree : celui déjà attribué s'il est encore libre (ou tenu
    /// par un runner vivant de ce worktree), sinon le premier libre de la
    /// plage à partir du port préféré. Sous `runner_start`. Rien n'est
    /// enregistré ici : l'attribution n'est retenue qu'après un lancement
    /// réussi.
    fn worktree_port(&self, root: &Path) -> Result<u16, RpcError> {
        let (assigned, held, reserved) = {
            let t = self.runner_table();
            let held = t.procs.values().any(|p| p.alive() && p.root == root);
            let reserved: HashSet<u16> = t
                .ports
                .iter()
                .filter(|(r, _)| r.as_path() != root)
                .map(|(_, p)| *p)
                .collect();
            (t.ports.get(root).copied(), held, reserved)
        };
        if let Some(p) = assigned
            && (held || !port_in_use(p))
        {
            return Ok(p);
        }
        let preferred = assigned.unwrap_or_else(|| runners::preferred_port(root));
        let port = runners::pick_port(preferred, &reserved, port_in_use).ok_or_else(|| {
            RpcError::launch(format!(
                "aucun port libre entre {} et {}",
                runners::PORT_MIN,
                runners::PORT_MAX
            ))
        })?;
        Ok(port)
    }

    /// `runners.start {id, runner_id, cols?, rows?}` → `RunnerProcess`.
    /// Bloquant (détection sur le disque, sonde du port, lancement).
    pub fn runners_start(self: &Arc<Self>, params: &Value) -> Result<Value, RpcError> {
        let sid = session_id_param(params)?;
        let runner_id = opt_str(params, "runner_id")?
            .filter(|r| !r.is_empty())
            .ok_or_else(|| RpcError::params("« runner_id » manquant"))?;
        let expected = opt_str(params, "expected_fingerprint")?
            .filter(|f| !f.is_empty())
            .ok_or_else(|| RpcError::params("« expected_fingerprint » manquant"))?;
        let size = size_param(params, RUNNER_SIZE)?;
        self.refuse_if_shutting_down()?;
        let (detected, root, cwd) = self.detect_runners(&sid)?;
        let runner = detected
            .into_iter()
            .find(|r| r.id == runner_id)
            .ok_or_else(|| unknown_runner(&runner_id))?;
        // Ce que l'utilisateur a confirmé doit être ce qui va tourner : un
        // corps de script, une recette ou un verrou changés depuis
        // `runners.list` font refuser le lancement.
        let fingerprint = runner.fingerprint();
        if fingerprint != expected {
            return Err(RpcError::new(
                error_code::UNKNOWN_RUNNER,
                "la commande a changé depuis sa confirmation",
            )
            .with_data(json!({"fingerprint": fingerprint})));
        }
        let (program, args) = runner
            .command
            .split_first()
            .expect("la détection construit toujours un programme");
        let program =
            launch::find_in_path(program, self.config.path_env.as_deref()).ok_or_else(|| {
                RpcError::launch(format!("« {program} » introuvable dans le PATH du démon"))
            })?;
        let dir = if runner.cwd.is_empty() {
            root.clone()
        } else {
            root.join(&runner.cwd)
        };

        let _start = self.runner_start.lock().unwrap_or_else(|e| e.into_inner());
        if self.being_removed(&root) || self.being_removed(&cwd) {
            return Err(RpcError::new(
                error_code::WORKTREE_IN_USE,
                "ce worktree est en cours de suppression",
            ));
        }
        let mut warnings: Vec<String> = Vec::new();
        {
            let t = self.runner_table();
            // Un `PORT` par worktree : deux serveurs de développement du même
            // worktree se le disputeraient.
            if runner.kind == RunnerKind::Dev
                && let Some(other) = t.procs.values().find(|p| {
                    p.alive()
                        && p.root == root
                        && p.runner.kind == RunnerKind::Dev
                        && p.runner.id != runner.id
                })
            {
                warnings.push(format!(
                    "le runner « {} » tourne déjà dans ce worktree avec le même PORT={} : les deux serveurs risquent de se disputer le port",
                    other.runner.label, other.port
                ));
            }
            let live: Vec<&RunnerProc> = t
                .of_session(&sid)
                .into_iter()
                .filter(|p| p.alive())
                .collect();
            if live.iter().any(|p| p.runner.id == runner.id) {
                return Err(RpcError::new(
                    error_code::INVALID_STATE,
                    format!("le runner « {} » tourne déjà", runner.label),
                ));
            }
            if live.len() >= MAX_LIVE_PER_SESSION {
                return Err(RpcError::new(
                    error_code::TOO_MANY_RUNNERS,
                    format!(
                        "{MAX_LIVE_PER_SESSION} runners tournent déjà pour cette session : en arrêter un d'abord"
                    ),
                ));
            }
        }
        let port = self.worktree_port(&root)?;
        let process_id = Uuid::new_v4();
        let inherited_env: Vec<String> = std::env::vars_os()
            .filter_map(|(k, _)| k.into_string().ok())
            .collect();
        let scope = self.config.systemd_run.as_ref().map(|_| {
            format!(
                "{}{}-{}.scope",
                peer::RUNNER_SCOPE_PREFIX,
                &sid.simple().to_string()[..8],
                &process_id.simple().to_string()[..8],
            )
        });
        let command = launch::build_runner(&RunnerSpec {
            program: &program,
            args,
            cwd: &dir,
            port,
            inherited_env: &inherited_env,
            scope: self
                .config
                .systemd_run
                .as_deref()
                .zip(scope.as_deref())
                .map(|(systemd_run, unit)| ScopeSpec {
                    systemd_run,
                    unit,
                    runtime_dir: self.config.systemd_runtime_dir.as_deref(),
                }),
        });
        let spawned =
            self.deps.pty.spawn(&command, size).map_err(|e| {
                RpcError::launch(format!("lancement de {} : {e}", program.display()))
            })?;
        let pid = spawned.child.pid();
        if let Some(pid) = pid {
            // Ses descendants n'ont pas accès au socket de contrôle, et
            // `signal_group` vérifie la date de démarrage.
            self.supervised
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(
                    pid,
                    SupervisedProc {
                        start: peer::start_time(pid),
                        scope: scope.clone(),
                    },
                );
        }
        let terminal = Arc::new(Terminal::new(size));
        let (input_tx, mut input_rx) = mpsc::channel::<Vec<u8>>(INPUT_QUEUE);
        let proc = RunnerProc {
            process_id,
            session_id: sid,
            runner: runner.clone(),
            root: root.clone(),
            port,
            seq: 0,
            started_at: self.now(),
            ended_at: None,
            exit: None,
            pid,
            terminal: terminal.clone(),
            control: spawned.control,
            input: input_tx,
            urls: Vec::new(),
        };
        let json = {
            let mut t = self.runner_table();
            // Relancer remplace le processus terminé du même runner.
            t.procs
                .retain(|_, p| !(p.session_id == sid && p.runner.id == runner.id && !p.alive()));
            t.next_seq += 1;
            let seq = t.next_seq;
            let mut proc = proc;
            proc.seq = seq;
            let mut json = proc.json();
            json["warnings"] = json!(warnings);
            t.procs.insert(process_id, proc);
            // Le port n'est retenu pour le worktree qu'une fois le lancement réussi.
            t.ports.insert(root.clone(), port);
            json
        };
        info!(
            "runner {} lancé pour la session {sid} ({process_id}, PORT={port})",
            runner.id
        );

        // Lecteur : terminal, puis URL (verrou du terminal relâché avant
        // celui de la table).
        let mut reader = spawned.reader;
        let daemon = Arc::clone(self);
        let term = terminal;
        spawn_thread(
            &format!("runner-lecture-{}", &process_id.simple().to_string()[..8]),
            move || {
                let mut buf = vec![0u8; 64 * 1024];
                let mut scanner = UrlScanner::new();
                loop {
                    let n = match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => n,
                        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(_) => break,
                    };
                    term.feed(&buf[..n]);
                    if scanner.feed(&buf[..n]) {
                        daemon.set_runner_urls(&process_id, scanner.urls());
                    }
                }
                if scanner.finish() {
                    daemon.set_runner_urls(&process_id, scanner.urls());
                }
            },
        );

        let mut writer = spawned.writer;
        spawn_thread(
            &format!("runner-ecriture-{}", &process_id.simple().to_string()[..8]),
            move || {
                while let Some(data) = input_rx.blocking_recv() {
                    if writer
                        .write_all(&data)
                        .and_then(|()| writer.flush())
                        .is_err()
                    {
                        break;
                    }
                }
            },
        );

        let mut child = spawned.child;
        let daemon = Arc::clone(self);
        spawn_thread(
            &format!("runner-attente-{}", &process_id.simple().to_string()[..8]),
            move || {
                let status = child.wait().unwrap_or(ExitStatus::Code(-1));
                if let Some(pid) = pid {
                    // Les processus restés dans le groupe reçoivent SIGHUP, comme
                    // à la fermeture d'un terminal, puis SIGKILL s'ils traînent.
                    daemon.signal_group(pid, nix::sys::signal::Signal::SIGHUP);
                    let d2 = Arc::clone(&daemon);
                    let timeout = daemon.config.stop_timeout;
                    daemon.runtime.spawn(async move {
                        tokio::time::sleep(timeout).await;
                        d2.signal_group(pid, nix::sys::signal::Signal::SIGKILL);
                    });
                }
                daemon.on_runner_exit(&process_id, status);
            },
        );

        self.runners_changed(sid);
        Ok(json)
    }

    fn set_runner_urls(&self, process_id: &Uuid, urls: &[String]) {
        let sid = {
            let mut t = self.runner_table();
            let Some(p) = t.procs.get_mut(process_id) else {
                return;
            };
            if p.urls == urls {
                return;
            }
            p.urls = urls.to_vec();
            p.session_id
        };
        self.runners_changed(sid);
    }

    fn on_runner_exit(&self, process_id: &Uuid, status: ExitStatus) {
        let now = self.now();
        let sid = {
            let mut t = self.runner_table();
            let Some(p) = t.procs.get_mut(process_id) else {
                return;
            };
            info!("runner {} ({process_id}) terminé : {status:?}", p.runner.id);
            p.exit = Some(status);
            p.ended_at = Some(now);
            let sid = p.session_id;
            t.prune_exited(&sid);
            sid
        };
        self.runners_changed(sid);
    }

    /// `SIGTERM` au groupe d'un runner vivant, `SIGKILL` après
    /// [`super::Config::stop_timeout`] s'il tourne encore. `false` s'il ne
    /// tournait pas.
    fn terminate_runner(self: &Arc<Self>, process_id: &Uuid) -> bool {
        let pid = {
            let t = self.runner_table();
            match t.procs.get(process_id) {
                Some(p) if p.alive() => p.pid,
                _ => return false,
            }
        };
        let Some(pid) = pid else {
            return true;
        };
        self.signal_group(pid, nix::sys::signal::Signal::SIGTERM);
        let daemon = Arc::clone(self);
        let process_id = *process_id;
        let timeout = self.config.stop_timeout;
        self.runtime.spawn(async move {
            tokio::time::sleep(timeout).await;
            let still = daemon
                .runner_table()
                .procs
                .get(&process_id)
                .is_some_and(RunnerProc::alive);
            if still {
                warning!("runner {process_id} : pas sorti après SIGTERM, SIGKILL");
                daemon.signal_group(pid, nix::sys::signal::Signal::SIGKILL);
            }
        });
        true
    }

    /// `runners.stop {process_id}` → `{stopping, alive}` (la fin arrive par
    /// `runners.changed`).
    pub fn runners_stop(self: &Arc<Self>, params: &Value) -> Result<Value, RpcError> {
        let process_id = process_id_param(params)?;
        let owner = owner_param(params)?;
        proc_of(&self.runner_table(), &process_id, owner)?;
        let stopping = self.terminate_runner(&process_id);
        Ok(json!({"stopping": stopping, "alive": stopping}))
    }

    /// Arrête les runners vivants d'une session (`sessions.stop` avec
    /// `stop_runners`). Renvoie leur nombre.
    pub fn stop_session_runners(self: &Arc<Self>, sid: &Uuid) -> usize {
        let ids: Vec<Uuid> = self
            .runner_table()
            .of_session(sid)
            .into_iter()
            .filter(|p| p.alive())
            .map(|p| p.process_id)
            .collect();
        ids.iter().filter(|id| self.terminate_runner(id)).count()
    }

    /// Session oubliée : ses runners sont arrêtés et retirés de la table.
    pub(super) fn forget_session_runners(&self, sid: &Uuid) {
        let procs: Vec<RunnerProc> = {
            let mut t = self.runner_table();
            let ids: Vec<Uuid> = t
                .procs
                .values()
                .filter(|p| p.session_id == *sid)
                .map(|p| p.process_id)
                .collect();
            ids.iter().filter_map(|id| t.procs.remove(id)).collect()
        };
        self.runner_live
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(sid);
        for p in procs.iter().filter(|p| p.alive()) {
            if let Some(pid) = p.pid {
                self.signal_group(pid, nix::sys::signal::Signal::SIGTERM);
                let daemon = self.me.upgrade();
                let timeout = self.config.stop_timeout;
                if let Some(daemon) = daemon {
                    self.runtime.spawn(async move {
                        tokio::time::sleep(timeout).await;
                        daemon.signal_group(pid, nix::sys::signal::Signal::SIGKILL);
                    });
                }
            }
        }
    }

    /// Suppression d'un worktree : ses runners (toutes sessions) reçoivent
    /// `SIGTERM`, puis `SIGKILL` après [`super::Config::stop_timeout`] ; on
    /// attend leur fin (bornée) avant de supprimer. Son port est libéré.
    /// Bloquant. Appelé avec le worktree déjà marqué « en suppression ».
    pub(super) fn stop_worktree_runners(&self, path: &Path) {
        // Un lancement en cours finit de s'inscrire (il a vu le worktree
        // libre) avant qu'on relève les runners.
        drop(self.runner_start.lock().unwrap_or_else(|e| e.into_inner()));
        let canonical = path.canonicalize().ok();
        let inside = |root: &Path| {
            root.starts_with(path) || canonical.as_deref().is_some_and(|c| root.starts_with(c))
        };
        let pids: Vec<u32> = {
            let mut t = self.runner_table();
            t.ports.retain(|r, _| !inside(r));
            t.procs
                .values()
                .filter(|p| p.alive() && inside(&p.root))
                .filter_map(|p| p.pid)
                .collect()
        };
        if pids.is_empty() {
            return;
        }
        info!(
            "worktree {} : arrêt de {} runner(s)",
            path.display(),
            pids.len()
        );
        let alive = |d: &Self| {
            d.runner_table()
                .procs
                .values()
                .any(|p| p.alive() && inside(&p.root))
        };
        for pid in &pids {
            self.signal_group(*pid, nix::sys::signal::Signal::SIGTERM);
        }
        let deadline = std::time::Instant::now() + self.config.stop_timeout;
        while alive(self) && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        if alive(self) {
            for pid in &pids {
                self.signal_group(*pid, nix::sys::signal::Signal::SIGKILL);
            }
            let deadline = std::time::Instant::now() + Duration::from_secs(2);
            while alive(self) && std::time::Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }

    /// Groupes des runners vivants (arrêt du démon).
    pub(super) fn runner_pids(&self) -> Vec<u32> {
        self.runner_table()
            .procs
            .values()
            .filter(|p| p.alive())
            .filter_map(|p| p.pid)
            .collect()
    }

    /// Runners vivants (arrêt du démon).
    pub(super) fn runners_alive(&self) -> usize {
        self.runner_table()
            .procs
            .values()
            .filter(|p| p.alive())
            .count()
    }

    /// Instantané, historique (si demandé) et abonnement à la sortie d'un
    /// runner, pris ensemble (comme `sessions.subscribe`).
    ///
    /// `runners.subscribe {id?, process_id, history?, cols?, rows?}` : avec
    /// `cols`/`rows`, le terminal (et le PTY s'il tourne) est d'abord
    /// redimensionné.
    pub fn runner_subscribe(&self, params: &Value) -> Result<(Uuid, Subscription), RpcError> {
        let process_id = process_id_param(params)?;
        let owner = owner_param(params)?;
        let history = match params.get("history") {
            None | Some(Value::Null) => false,
            Some(Value::Bool(b)) => *b,
            Some(_) => return Err(RpcError::params("« history » : booléen attendu")),
        };
        let resize = params.get("cols").is_some_and(|v| !v.is_null())
            || params.get("rows").is_some_and(|v| !v.is_null());
        let t = self.runner_table();
        let p = proc_of(&t, &process_id, owner)?;
        if resize {
            let size = size_param(params, p.terminal.size())?;
            p.terminal.resize(size);
            if p.alive()
                && let Err(e) = p.control.resize(size)
            {
                warning!("runner {process_id} : redimensionnement du PTY : {e}");
            }
        }
        let (snap, hist, rx) = p.terminal.subscribe_with_history(history);
        Ok((process_id, (snap, hist, rx, p.terminal.clone())))
    }

    /// File d'entrée clavier d'un runner vivant.
    pub fn runner_input_sender(
        &self,
        process_id: &Uuid,
    ) -> Result<mpsc::Sender<Vec<u8>>, RpcError> {
        let t = self.runner_table();
        let p = t
            .procs
            .get(process_id)
            .ok_or_else(|| unknown_process(process_id))?;
        if !p.alive() {
            return Err(RpcError::new(
                error_code::INVALID_STATE,
                "le runner ne tourne pas",
            ));
        }
        Ok(p.input.clone())
    }

    /// `runners.resize {process_id, cols, rows}` → `{cols, rows}`.
    pub fn runners_resize(&self, params: &Value) -> Result<Value, RpcError> {
        let process_id = process_id_param(params)?;
        let owner = owner_param(params)?;
        let size = size_param(params, RUNNER_SIZE)?;
        let t = self.runner_table();
        let p = proc_of(&t, &process_id, owner)?;
        p.terminal.resize(size);
        if p.alive()
            && let Err(e) = p.control.resize(size)
        {
            warning!("runner {process_id} : redimensionnement du PTY : {e}");
        }
        Ok(json!({"cols": size.cols, "rows": size.rows}))
    }
}

/// `Runner` du protocole.
pub fn runner_json(r: &Runner) -> Value {
    let (body, body_truncated) = r.shown_body();
    json!({
        "body": body,
        "body_truncated": body_truncated,
        "fingerprint": r.fingerprint(),
        "id": r.id,
        "label": r.label,
        "kind": r.kind.as_str(),
        "command": r.command,
        "cwd": r.cwd,
        "source": r.source,
        "files": r.files.iter().map(|f| json!({
            "path": f.path,
            "size": f.size,
            "state": f.state.as_str(),
            "note": f.note,
        })).collect::<Vec<_>>(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::fs_files::FsFiles;

    fn write(root: &Path, rel: &str, text: &str) {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    /// Détection sur un vrai dossier, à travers l'adaptateur de fichiers :
    /// liens qui sortent de la racine ignorés, fichiers piégés écartés.
    #[test]
    fn detection_on_a_temporary_repo() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("depot");
        let outside = tmp.path().join("dehors");
        write(
            &root,
            "package.json",
            r#"{"scripts":{"dev":"vite","--inspect":"x","test -- --watch":"y"}}"#,
        );
        write(&root, "yarn.lock", "");
        write(
            &root,
            "Makefile",
            "include piege.mk lien.mk\n-include $(DEPS)\nall: build\nbuild:\n\tcc\n%.o: %.c\n-f:\nVAR=a:b\n",
        );
        write(&root, "piege.mk", "cachee:\n\trm -rf /\n");
        write(
            &root,
            "justfile",
            "run port:\n\techo\nserve port='8080':\n\techo\n",
        );
        write(&outside, "package.json", r#"{"scripts":{"fuite":"x"}}"#);
        write(&outside, "go.mod", "module x\n");
        std::os::unix::fs::symlink(&outside, root.join("lien")).unwrap();
        std::os::unix::fs::symlink(outside.join("go.mod"), root.join("go.mod")).unwrap();
        std::os::unix::fs::symlink(outside.join("go.mod"), root.join("lien.mk")).unwrap();
        let root = root.canonicalize().unwrap();
        let view = FsView {
            files: &FsFiles,
            root: &root,
        };
        let found = runners::detect(&view);
        let ids: Vec<&str> = found.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "package.json:dev",
                "Makefile:all",
                "Makefile:build",
                "justfile:serve",
            ],
        );
        assert_eq!(found[0].command, ["yarn", "run", "dev"]);
        // Fichiers pris en compte, lus à travers l'adaptateur.
        let files: Vec<(&str, &str, Option<u64>)> = found[1]
            .files
            .iter()
            .map(|f| (f.path.as_str(), f.state.as_str(), f.size))
            .collect();
        assert_eq!(
            files,
            [
                ("GNUmakefile", "absent", None),
                ("makefile", "absent", None),
                ("Makefile", "ok", Some(85)),
                ("piege.mk", "ok", Some(18)),
                ("lien.mk", "outside", None),
                ("$(DEPS)", "unresolved", None),
            ]
        );
        let json = runner_json(&found[1]);
        assert_eq!(
            json["files"][2],
            json!({"path": "Makefile", "size": 85, "state": "ok", "note": "source"})
        );
        assert!(
            json["body"]
                .as_str()
                .unwrap()
                .starts_with("Fichiers pris en compte")
        );
        // Fichier de plus de 16 Mio : haché par blocs à travers l'adaptateur ;
        // modifié à taille égale, l'empreinte change.
        let big = vec![b'#'; runners::MAX_HASH_BYTES as usize + 4096];
        std::fs::write(root.join("compose.yaml"), &big).unwrap();
        let fp = || {
            let found = runners::detect(&view);
            let r = found.iter().find(|r| r.id == "compose.yaml:up").unwrap();
            assert_eq!(r.files[0].state.as_str(), "too_large");
            assert_eq!(r.files[0].size, Some(big.len() as u64));
            r.fingerprint()
        };
        let before = fp();
        let mut changed = big.clone();
        changed[10] = b'x';
        std::fs::write(root.join("compose.yaml"), &changed).unwrap();
        assert_ne!(before, fp());
    }
}
