//! Processus d'un plugin (v0.3, lot 22a, ADR 0007, prototype n° 6).
//!
//! `std::process` et des fils dédiés (jamais le runtime tokio) :
//! - **lecture de stdout** : une ligne JSON par message, lue par
//!   `take(1 Mio + 1)` (une ligne géante sans fin de ligne est refusée en
//!   temps borné), classée puis transmise par une file bornée (le plugin
//!   attend si l'hôte ne lit pas) ; toute ligne invalide arrête la lecture ;
//! - **vidage de stderr** en continu, 4 Kio de fin gardés ;
//! - **écriture de stdin** par une file : une requête volumineuse vers un
//!   plugin qui ne lit pas ne bloque jamais l'appelant (son délai court) ;
//! - **attente** : seul fil qui récolte le processus (pas de zombie), puis
//!   `on_exit`.
//!
//! Lancement : environnement vidé puis liste d'autorisation, groupe de
//! processus propre, scope `systemd-run --user --scope` si demandé.
//! Arrêt ([`PluginProcess::stop`]) : `shutdown` poli (1 s), fermeture de
//! stdin, `systemctl --user kill --signal=SIGTERM` au scope, 1 s,
//! `--signal=SIGKILL` (jamais `systemctl stop`, qui attend 90 s), `SIGKILL`
//! au groupe, attente de la fin. Le groupe n'est signalé que si son
//! identifiant ne peut pas avoir été réattribué (chef pas encore récolté,
//! ou membres encore vivants) : voir `Proc::signal_group`. Le scope est tué même si le processus
//! principal est sorti seul (petits-enfants détachés).

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::domain::plugins::{
    MAX_LINE_BYTES, MAX_NOTIFICATIONS, STDERR_TAIL_BYTES, clean_stderr_tail,
};
use crate::ports::{PluginError, PluginHost, PluginLaunch, PluginProcess, PluginScope};

/// Délai du `shutdown` poli.
pub const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(1);
/// Délai entre `SIGTERM` et `SIGKILL`.
pub const TERM_GRACE: Duration = Duration::from_secs(1);
/// Attente maximale de la fin après `SIGKILL`.
const KILL_WAIT: Duration = Duration::from_secs(3);
/// Délai d'un appel à `systemctl`.
const SYSTEMCTL_TIMEOUT: Duration = Duration::from_secs(3);
/// Messages lus d'avance au plus (file bornée entre le lecteur et l'hôte).
const LINE_QUEUE: usize = 64;

/// [`PluginHost`] par `std::process`.
#[derive(Debug, Clone, Copy, Default)]
pub struct ProcessPluginHost;

/// Ce que le lecteur de stdout transmet.
enum Incoming {
    Message(Value),
    Fatal(PluginError),
}

/// Fin du processus, posée par le fil d'attente.
type Exited = Arc<(Mutex<bool>, Condvar)>;

struct Proc {
    pid: u32,
    scope: Option<PluginScope>,
    /// File d'écriture vers stdin ; `None` une fois stdin fermé.
    stdin: Mutex<Option<mpsc::Sender<Vec<u8>>>>,
    /// Messages lus ; son verrou sérialise les requêtes.
    lines: Mutex<Receiver<Incoming>>,
    next_id: AtomicU64,
    /// Défaillance fatale, rendue à toute requête suivante.
    broken: Mutex<Option<PluginError>>,
    stderr: Arc<Mutex<VecDeque<u8>>>,
    exited: Exited,
    stopping: AtomicBool,
}

fn spawn_thread(name: &str, f: impl FnOnce() + Send + 'static) -> std::io::Result<()> {
    std::thread::Builder::new()
        .name(name.to_owned())
        .spawn(f)
        .map(|_| ())
}

/// Lecteur de stdout : une ligne JSON-RPC 2.0 par message.
fn read_stdout(stdout: impl Read, tx: SyncSender<Incoming>) {
    let mut reader = BufReader::with_capacity(64 * 1024, stdout);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        let n = match (&mut reader)
            .take(MAX_LINE_BYTES as u64 + 1)
            .read_until(b'\n', &mut buf)
        {
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => 0,
        };
        let fatal = if n == 0 {
            PluginError::Closed
        } else if buf.last() != Some(&b'\n') {
            if buf.len() > MAX_LINE_BYTES {
                PluginError::LineTooLong
            } else {
                // Fin du flux au milieu d'une ligne.
                PluginError::Closed
            }
        } else {
            buf.pop();
            match classify(&buf) {
                Ok(v) => {
                    if tx.send(Incoming::Message(v)).is_err() {
                        return;
                    }
                    continue;
                }
                Err(e) => e,
            }
        };
        let _ = tx.send(Incoming::Fatal(fatal));
        return;
    }
}

/// Une ligne : objet JSON-RPC 2.0, sinon défaillance.
fn classify(line: &[u8]) -> Result<Value, PluginError> {
    let text = std::str::from_utf8(line).map_err(|_| PluginError::NotJson)?;
    let v: Value = serde_json::from_str(text).map_err(|_| PluginError::NotJson)?;
    if !v.is_object() || v.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Err(PluginError::Protocol(
            "message qui n'est pas un objet JSON-RPC 2.0".into(),
        ));
    }
    Ok(v)
}

/// Vide stderr en continu, en gardant les derniers octets.
fn drain_stderr(mut stderr: impl Read, tail: Arc<Mutex<VecDeque<u8>>>) {
    let mut buf = vec![0u8; 16 * 1024];
    loop {
        let n = match stderr.read(&mut buf) {
            Ok(0) => return,
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return,
        };
        let mut t = tail.lock().unwrap_or_else(|e| e.into_inner());
        let chunk = &buf[n.saturating_sub(STDERR_TAIL_BYTES)..n];
        t.extend(chunk);
        let excess = t.len().saturating_sub(STDERR_TAIL_BYTES);
        t.drain(..excess);
    }
}

/// `systemctl --user kill --signal=<sig> <unité>`, borné ; erreurs ignorées
/// (scope déjà récolté).
fn kill_scope(scope: &PluginScope, signal: &str) {
    let mut cmd = Command::new(&scope.systemctl);
    cmd.args(["--user", "kill", &format!("--signal={signal}"), &scope.unit])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(dir) = &scope.runtime_dir {
        cmd.env("XDG_RUNTIME_DIR", dir);
    }
    let Ok(mut child) = cmd.spawn() else {
        return;
    };
    let deadline = Instant::now() + SYSTEMCTL_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return;
            }
        }
    }
}

fn killpg(pid: u32, sig: nix::sys::signal::Signal) {
    let _ = nix::sys::signal::killpg(nix::unistd::Pid::from_raw(pid as i32), sig);
}

/// Un processus vit-il encore dans le groupe `pgid` (`/proc/*/stat`) ?
fn group_has_members(pgid: u32) -> bool {
    let Ok(dir) = std::fs::read_dir("/proc") else {
        return false;
    };
    dir.flatten()
        .filter_map(|e| e.file_name().to_str()?.parse::<u32>().ok())
        .filter_map(|pid| std::fs::read_to_string(format!("/proc/{pid}/stat")).ok())
        .any(|stat| {
            // Champs après le nom (entre parenthèses) : état, ppid, pgrp.
            stat.rsplit_once(')')
                .and_then(|(_, rest)| rest.split_whitespace().nth(2)?.parse::<u32>().ok())
                == Some(pgid)
        })
}

impl Proc {
    fn wait_exit(&self, max: Duration) -> bool {
        let (done, cv) = &*self.exited;
        let guard = done.lock().unwrap_or_else(|e| e.into_inner());
        let (guard, _) = cv
            .wait_timeout_while(guard, max, |d| !*d)
            .unwrap_or_else(|e| e.into_inner());
        *guard
    }

    fn has_exited(&self) -> bool {
        *self.exited.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Signal au groupe du plugin, **seulement** quand l'identifiant du
    /// groupe ne peut pas avoir été réattribué : le chef n'est pas encore
    /// récolté, ou d'autres processus vivent encore dans le groupe (le noyau
    /// ne réattribue pas un pid utilisé comme identifiant de groupe). Un
    /// groupe vide après la récolte n'est jamais signalé : un `killpg` sur
    /// un pid libéré pourrait toucher un autre groupe. Les petits-enfants
    /// détachés de leur groupe ne sont atteints que par le scope.
    fn signal_group(&self, sig: nix::sys::signal::Signal) {
        if !self.has_exited() || group_has_members(self.pid) {
            killpg(self.pid, sig);
        }
    }

    fn set_broken(&self, e: &PluginError) {
        let mut b = self.broken.lock().unwrap_or_else(|e| e.into_inner());
        if b.is_none() {
            *b = Some(e.clone());
        }
    }

    fn close_stdin(&self) {
        self.stdin.lock().unwrap_or_else(|e| e.into_inner()).take();
    }

    /// Requête, verrou des messages pris.
    fn exchange(
        &self,
        rx: &Receiver<Incoming>,
        method: &str,
        params: Option<Value>,
        timeout: Duration,
    ) -> Result<Value, PluginError> {
        if let Some(e) = self
            .broken
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
        {
            return Err(e);
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let mut msg = json!({"jsonrpc": "2.0", "id": id, "method": method});
        if let Some(p) = params {
            msg["params"] = p;
        }
        let mut line = msg.to_string().into_bytes();
        line.push(b'\n');
        let sent = self
            .stdin
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .is_some_and(|tx| tx.send(line).is_ok());
        if !sent {
            return Err(PluginError::Closed);
        }
        let deadline = Instant::now() + timeout;
        let mut notifications = 0usize;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let incoming = match rx.recv_timeout(left) {
                Ok(i) => i,
                Err(RecvTimeoutError::Timeout) => return Err(PluginError::Timeout),
                Err(RecvTimeoutError::Disconnected) => return Err(PluginError::Closed),
            };
            let v = match incoming {
                Incoming::Message(v) => v,
                Incoming::Fatal(e) => return Err(e),
            };
            if v.get("method").is_some() {
                if v.get("id").is_some() {
                    return Err(PluginError::Protocol(
                        "requête du plugin vers l'hôte (non prise en charge)".into(),
                    ));
                }
                notifications += 1;
                if notifications > MAX_NOTIFICATIONS {
                    return Err(PluginError::Flood);
                }
                continue;
            }
            if v.get("id").and_then(Value::as_u64) != Some(id) {
                return Err(PluginError::Protocol("réponse à un id inconnu".into()));
            }
            return match (v.get("result"), v.get("error")) {
                (Some(r), None) => Ok(r.clone()),
                (None, Some(e)) => Err(PluginError::Error {
                    code: e.get("code").and_then(Value::as_i64).unwrap_or(0),
                    message: e
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                }),
                _ => Err(PluginError::Protocol(
                    "réponse sans « result » ni « error »".into(),
                )),
            };
        }
    }
}

impl PluginProcess for Proc {
    fn pid(&self) -> Option<u32> {
        Some(self.pid)
    }

    fn request(
        &self,
        method: &str,
        params: Option<Value>,
        timeout: Duration,
    ) -> Result<Value, PluginError> {
        let rx = self.lines.lock().unwrap_or_else(|e| e.into_inner());
        let r = self.exchange(&rx, method, params, timeout);
        if let Err(e) = &r
            && e.is_fatal()
        {
            self.set_broken(e);
        }
        r
    }

    fn stop(&self) {
        if self.stopping.swap(true, Ordering::SeqCst) {
            // Arrêt déjà demandé ailleurs : attendre sa fin.
            self.wait_exit(TERM_GRACE + KILL_WAIT);
            return;
        }
        // `shutdown` poli, si aucune requête n'est en cours et que le plugin
        // fonctionne encore.
        let healthy = self
            .broken
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_none();
        if healthy
            && !self.has_exited()
            && let Ok(rx) = self.lines.try_lock()
        {
            let _ = self.exchange(&rx, "shutdown", None, SHUTDOWN_TIMEOUT);
        }
        self.set_broken(&PluginError::Closed);
        self.close_stdin();
        if let Some(scope) = &self.scope {
            kill_scope(scope, "SIGTERM");
        } else {
            self.signal_group(nix::sys::signal::Signal::SIGTERM);
        }
        self.wait_exit(TERM_GRACE);
        if let Some(scope) = &self.scope {
            // Toujours : des petits-enfants détachés peuvent rester.
            kill_scope(scope, "SIGKILL");
        }
        self.signal_group(nix::sys::signal::Signal::SIGKILL);
        self.wait_exit(KILL_WAIT);
    }

    fn kill(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        self.set_broken(&PluginError::Closed);
        self.close_stdin();
        if let Some(scope) = &self.scope {
            kill_scope(scope, "SIGKILL");
        }
        self.signal_group(nix::sys::signal::Signal::SIGKILL);
    }

    fn stderr_tail(&self) -> String {
        let t = self.stderr.lock().unwrap_or_else(|e| e.into_inner());
        let (a, b) = t.as_slices();
        let mut bytes = Vec::with_capacity(t.len());
        bytes.extend_from_slice(a);
        bytes.extend_from_slice(b);
        // Début coupé au milieu d'un caractère : octets de suite retirés.
        let start = bytes
            .iter()
            .position(|b| (*b & 0xC0) != 0x80)
            .unwrap_or(bytes.len());
        clean_stderr_tail(&bytes[start..])
    }

    fn alive(&self) -> bool {
        !self.has_exited()
    }
}

impl PluginHost for ProcessPluginHost {
    fn spawn(
        &self,
        launch: &PluginLaunch,
        on_exit: Box<dyn FnOnce() + Send>,
    ) -> Result<Arc<dyn PluginProcess>, PluginError> {
        let mut cmd = match &launch.scope {
            Some(scope) => {
                let mut c = Command::new(&scope.systemd_run);
                c.args([
                    "--user",
                    "--scope",
                    "--quiet",
                    "--collect",
                    &format!("--unit={}", scope.unit),
                    "--",
                ])
                .arg(&launch.program)
                .args(&launch.args);
                c
            }
            None => {
                let mut c = Command::new(&launch.program);
                c.args(&launch.args);
                c
            }
        };
        cmd.env_clear()
            .envs(launch.env.iter().map(|(k, v)| (k, v)))
            .current_dir(&launch.cwd)
            .process_group(0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(dir) = launch.scope.as_ref().and_then(|s| s.runtime_dir.as_ref()) {
            cmd.env("XDG_RUNTIME_DIR", dir);
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| PluginError::Launch(format!("{} : {e}", launch.program.display())))?;
        let pid = child.id();
        let (Some(stdin), Some(stdout), Some(stderr)) =
            (child.stdin.take(), child.stdout.take(), child.stderr.take())
        else {
            let _ = child.kill();
            let _ = child.wait();
            return Err(PluginError::Launch("tubes indisponibles".into()));
        };
        let short = &launch.name[..launch.name.len().min(8)];
        let (line_tx, line_rx) = mpsc::sync_channel::<Incoming>(LINE_QUEUE);
        let (in_tx, in_rx) = mpsc::channel::<Vec<u8>>();
        let tail = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_TAIL_BYTES)));
        let exited: Exited = Arc::new((Mutex::new(false), Condvar::new()));

        let threads = (|| -> std::io::Result<()> {
            spawn_thread(&format!("plugin-out-{short}"), move || {
                read_stdout(stdout, line_tx)
            })?;
            let t = tail.clone();
            spawn_thread(&format!("plugin-err-{short}"), move || {
                drain_stderr(stderr, t)
            })?;
            spawn_thread(&format!("plugin-in-{short}"), move || {
                let mut stdin = stdin;
                while let Ok(data) = in_rx.recv() {
                    if stdin.write_all(&data).and_then(|()| stdin.flush()).is_err() {
                        break;
                    }
                }
                // File fermée : stdin fermé (fin de `stdin`).
            })?;
            Ok(())
        })();
        if let Err(e) = threads {
            killpg(pid, nix::sys::signal::Signal::SIGKILL);
            let _ = child.wait();
            return Err(PluginError::Launch(format!("création des fils : {e}")));
        }
        let ex = exited.clone();
        let mut child = child;
        let waiter = spawn_thread(&format!("plugin-wait-{short}"), move || {
            let _ = child.wait();
            let (done, cv) = &*ex;
            *done.lock().unwrap_or_else(|e| e.into_inner()) = true;
            cv.notify_all();
            on_exit();
        });
        if let Err(e) = waiter {
            // Sans fil d'attente, le processus ne peut pas être récolté : le
            // tuer (le zombie reste jusqu'à la fin du démon).
            killpg(pid, nix::sys::signal::Signal::SIGKILL);
            return Err(PluginError::Launch(format!("création des fils : {e}")));
        }
        Ok(Arc::new(Proc {
            pid,
            scope: launch.scope.clone(),
            stdin: Mutex::new(Some(in_tx)),
            lines: Mutex::new(line_rx),
            next_id: AtomicU64::new(1),
            broken: Mutex::new(None),
            stderr: tail,
            exited,
            stopping: AtomicBool::new(false),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_lines() {
        assert!(classify(br#"{"jsonrpc":"2.0","id":1,"result":null}"#).is_ok());
        assert_eq!(classify(b"bonjour"), Err(PluginError::NotJson));
        assert_eq!(classify(b""), Err(PluginError::NotJson));
        assert_eq!(classify(&[0xff, b'{']), Err(PluginError::NotJson));
        assert!(matches!(classify(b"[1]"), Err(PluginError::Protocol(_))));
        assert!(matches!(
            classify(br#"{"jsonrpc":"1.0","id":1}"#),
            Err(PluginError::Protocol(_))
        ));
    }

    #[test]
    fn reader_refuses_a_giant_line_in_bounded_time() {
        let data = vec![b'z'; MAX_LINE_BYTES * 3];
        let (tx, rx) = mpsc::sync_channel(4);
        read_stdout(&data[..], tx);
        assert!(matches!(
            rx.recv().unwrap(),
            Incoming::Fatal(PluginError::LineTooLong)
        ));
        // Une ligne de 1 Mio exactement passe (ici : refusée comme non JSON).
        let mut data = vec![b'z'; MAX_LINE_BYTES];
        data.push(b'\n');
        let (tx, rx) = mpsc::sync_channel(4);
        read_stdout(&data[..], tx);
        assert!(matches!(
            rx.recv().unwrap(),
            Incoming::Fatal(PluginError::NotJson)
        ));
    }

    #[test]
    fn stderr_keeps_the_tail() {
        let mut data = Vec::new();
        for i in 0..2000 {
            data.extend_from_slice(format!("ligne {i}\n").as_bytes());
        }
        let tail = Arc::new(Mutex::new(VecDeque::new()));
        drain_stderr(&data[..], tail.clone());
        let t = tail.lock().unwrap();
        assert_eq!(t.len(), STDERR_TAIL_BYTES);
        assert!(
            t.iter()
                .copied()
                .collect::<Vec<u8>>()
                .ends_with(b"ligne 1999\n")
        );
    }
}
