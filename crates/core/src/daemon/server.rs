//! Sockets du démon : connexions, trames, méthodes JSON-RPC.
//!
//! - socket de contrôle ([`handle_connection`]) : JSON-RPC et entrées de PTY ;
//!   les trames de hook et de statusline y ferment la connexion ;
//! - socket des relais ([`handle_relay_connection`]) : trames de hook et de
//!   statusline seulement ; toute autre trame ferme la connexion.
//!
//! Chaque connexion a une tâche d'écriture alimentée par une file bornée.
//! Les sorties de PTY auxquelles elle est abonnée et les notifications sont
//! poussées dans cette file par des tâches séparées : un client lent ne
//! ralentit que lui-même (ses abonnements prennent du retard puis sont
//! resynchronisés), jamais le PTY ni les autres clients.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::sync::{broadcast, mpsc};
use tokio::task::JoinHandle;
use uuid::Uuid;

use super::log::warning;
use super::peer::Peer;
use super::supervisor::{
    DEFAULT_SIZE, Daemon, Event, PromptToSend, ReviewToSend, RpcError, SetModeError, Subscription,
    opt_str, runners::process_id_param, session_id_param, size_param,
};
use super::terminal::{Chunk, Snapshot, Terminal};
use crate::protocol::{
    Frame, PROTOCOL_VERSION, error_code, error_response, error_response_data, notification,
    read_frame_async, response,
};

/// Trames en attente d'écriture vers un client.
const OUT_QUEUE: usize = 1024;
/// Attente maximale d'un `sessions.setMode` derrière un changement de mode
/// pas encore confirmé (le pied de la TUI confirme en général en quelques
/// dizaines de millisecondes).
const SET_MODE_RETRY: std::time::Duration = std::time::Duration::from_secs(1);
/// Intervalle entre deux essais.
const SET_MODE_RETRY_STEP: std::time::Duration = std::time::Duration::from_millis(25);
/// Taille maximale d'une trame de sortie de PTY regroupant plusieurs morceaux.
const PTY_BATCH: usize = 64 * 1024;

/// Représentation JSON d'un instantané d'écran.
pub fn snapshot_json(s: &Snapshot) -> Value {
    json!({
        "cols": s.cols,
        "rows": s.rows,
        "cursor": {"row": s.cursor_row, "col": s.cursor_col, "visible": s.cursor_visible},
        "ansi": s.ansi,
        "text": s.text,
    })
}

/// Révision de chaque conversation lue par une connexion : ses
/// `conversation.changed` partent de là.
type ConvCursors = Arc<std::sync::Mutex<HashMap<Uuid, u64>>>;

struct Connection {
    daemon: Arc<Daemon>,
    conv_cursors: ConvCursors,
    out: mpsc::Sender<Frame>,
    subscriptions: HashMap<Uuid, JoinHandle<()>>,
    notifications: Option<JoinHandle<()>>,
}

impl Drop for Connection {
    fn drop(&mut self) {
        for (_, task) in self.subscriptions.drain() {
            task.abort();
        }
        if let Some(task) = self.notifications.take() {
            task.abort();
        }
    }
}

/// Sert une connexion jusqu'à sa fermeture.
pub async fn handle_connection(daemon: Arc<Daemon>, stream: UnixStream) {
    let (mut rd, mut wr) = stream.into_split();
    let (out, mut out_rx) = mpsc::channel::<Frame>(OUT_QUEUE);
    let writer = tokio::spawn(async move {
        while let Some(frame) = out_rx.recv().await {
            if wr.write_all(&frame.encode()).await.is_err() {
                break;
            }
        }
        let _ = wr.shutdown().await;
    });
    let mut conn = Connection {
        daemon,
        conv_cursors: ConvCursors::default(),
        out,
        subscriptions: HashMap::new(),
        notifications: None,
    };
    loop {
        let frame = match read_frame_async(&mut rd).await {
            Ok(Some(f)) => f,
            Ok(None) => break,
            // Client parti sans fermer proprement : fin de connexion ordinaire.
            Err(crate::protocol::FrameError::Io(e))
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::BrokenPipe
                ) =>
            {
                break;
            }
            Err(e) => {
                warning!("connexion fermée sur une trame illisible : {e}");
                break;
            }
        };
        match frame {
            Frame::Rpc(bytes) => conn.on_rpc(&bytes).await,
            Frame::PtyInput { session, data } => {
                // File bornée : si `claude` lit moins vite, ce client attend
                // (et lui seul). Une session qui ne tourne pas ignore l'entrée.
                if let Ok(tx) = conn.daemon.input_sender(&session) {
                    // Jamais au milieu d'une revue ou de Shift+Tab.
                    let lock = conn.daemon.pty_lock(&session);
                    let _guard = match &lock {
                        Some(l) => Some(l.lock().await),
                        None => None,
                    };
                    let _ = tx.send(data).await;
                } else if let Ok(tx) = conn.daemon.runner_input_sender(&session) {
                    // Identifiant d'un processus de runner (v0.3, lot 14a).
                    let _ = tx.send(data).await;
                }
            }
            // Type inconnu : ignoré (compatibilité ascendante).
            Frame::Unknown { .. } => {}
            // Type connu mais inattendu ici (trame de relais, ou trame que
            // seul le démon envoie) : connexion fermée.
            other @ (Frame::Hook { .. }
            | Frame::Statusline { .. }
            | Frame::PtyOutput { .. }
            | Frame::Ack
            | Frame::Decision(_)) => {
                warning!(
                    "trame 0x{:02x} refusée sur le socket de contrôle : connexion fermée",
                    other.kind()
                );
                break;
            }
        }
    }
    drop(conn);
    let _ = writer.await;
}

/// Lit une trame ; `None` en fin de flux ou sur une erreur (journalisée si
/// ce n'est pas une simple déconnexion).
async fn next_frame<R: AsyncRead + Unpin>(rd: &mut R) -> Option<Frame> {
    match read_frame_async(rd).await {
        Ok(f) => f,
        Err(crate::protocol::FrameError::Io(e))
            if matches!(
                e.kind(),
                std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::BrokenPipe
            ) =>
        {
            None
        }
        Err(e) => {
            warning!("connexion fermée sur une trame illisible : {e}");
            None
        }
    }
}

/// Sert une connexion du socket des relais jusqu'à sa fermeture.
///
/// - hook : appliqué, puis accusé `0x12` (les hooks d'une session restent
///   ainsi dans l'ordre) ;
/// - hook `PermissionRequest` : appliqué, puis la connexion attend la
///   décision de l'app (trame `0x13`) ou la libération sans décision
///   (`0x12`) ; si le relais s'en va avant, il est détaché de sa demande ;
/// - statusline : appliquée, puis accusé `0x12` ;
/// - toute autre trame (JSON-RPC, entrée de PTY…) : connexion fermée.
pub async fn handle_relay_connection(daemon: Arc<Daemon>, stream: UnixStream) {
    let peer = match Peer::of(&stream) {
        Ok(p) => Arc::new(p),
        Err(e) => {
            warning!("relais : identité du pair illisible ({e}), connexion fermée");
            return;
        }
    };
    let (mut rd, mut wr) = stream.into_split();
    while let Some(frame) = next_frame(&mut rd).await {
        // Seul un processus de la session du jeton peut parler pour elle.
        if let Frame::Hook { token, .. } | Frame::Statusline { token, .. } = &frame {
            let (d, p, t) = (daemon.clone(), peer.clone(), token.clone());
            let verdict = tokio::task::spawn_blocking(move || d.check_relay_peer(&t, &p))
                .await
                .unwrap_or_else(|e| Err(e.to_string()));
            if let Err(why) = verdict {
                warning!("trame de relais ignorée : {why}");
                if wr.write_all(&Frame::Ack.encode()).await.is_err() {
                    break;
                }
                continue;
            }
        }
        match frame {
            Frame::Hook { token, event, json } if event == "PermissionRequest" => {
                let Some(wait) = daemon.on_permission_request(&token, &json) else {
                    let _ = wr.write_all(&Frame::Ack.encode()).await;
                    continue;
                };
                let (session, request, waiter) = (wait.session, wait.request, wait.waiter);
                let decision = tokio::select! {
                    d = wait.decision => d.unwrap_or(None),
                    // Le relais n'envoie rien d'autre : fin de flux = relais parti.
                    _ = next_frame(&mut rd) => {
                        daemon.detach_waiter(session, request, waiter);
                        break;
                    }
                };
                let reply = match decision {
                    Some(json) => Frame::Decision(json),
                    None => Frame::Ack,
                };
                if wr.write_all(&reply.encode()).await.is_err() {
                    break;
                }
            }
            Frame::Hook { token, event, json } => {
                daemon.on_hook(&token, &event, &json);
                if wr.write_all(&Frame::Ack.encode()).await.is_err() {
                    break;
                }
            }
            Frame::Statusline { token, json } => {
                daemon.on_statusline(&token, &json);
                if wr.write_all(&Frame::Ack.encode()).await.is_err() {
                    break;
                }
            }
            Frame::Unknown { .. } => {}
            other => {
                warning!(
                    "trame 0x{:02x} refusée sur le socket des relais : connexion fermée",
                    other.kind()
                );
                break;
            }
        }
    }
    let _ = wr.shutdown().await;
}

impl Connection {
    async fn send(&self, value: Value) {
        let _ = self.out.send(Frame::rpc(&value)).await;
    }

    /// Démarre le relais des notifications au premier message JSON-RPC (les
    /// relais de hooks n'en reçoivent jamais).
    fn ensure_notifications(&mut self) {
        if self.notifications.is_some() {
            return;
        }
        let rx = self.daemon.events();
        let out = self.out.clone();
        let daemon = self.daemon.clone();
        let cursors = self.conv_cursors.clone();
        self.notifications = Some(tokio::spawn(forward_events(daemon, rx, out, cursors)));
    }

    async fn on_rpc(&mut self, bytes: &[u8]) {
        let msg: Value = match serde_json::from_slice(bytes) {
            Ok(v) => v,
            Err(e) => {
                self.send(error_response(
                    Value::Null,
                    error_code::PARSE_ERROR,
                    format!("JSON invalide : {e}"),
                ))
                .await;
                return;
            }
        };
        let Some(method) = msg.get("method").and_then(Value::as_str) else {
            if msg.get("result").is_none() && msg.get("error").is_none() {
                self.send(error_response(
                    msg.get("id").cloned().unwrap_or(Value::Null),
                    error_code::INVALID_REQUEST,
                    "requête sans « method »",
                ))
                .await;
            }
            return;
        };
        self.ensure_notifications();
        let id = msg.get("id").cloned();
        let params = msg.get("params").cloned().unwrap_or_else(|| json!({}));
        let result = self.dispatch(method, &params, id.clone()).await;
        let Some(id) = id else {
            return; // notification du client : pas de réponse
        };
        match result {
            Ok(Some(value)) => self.send(response(id, value)).await,
            Ok(None) => {} // réponse déjà envoyée
            Err(e) => {
                self.send(error_response_data(id, e.code, e.message, e.data))
                    .await
            }
        }
    }

    async fn dispatch(
        &mut self,
        method: &str,
        params: &Value,
        id: Option<Value>,
    ) -> Result<Option<Value>, RpcError> {
        let d = self.daemon.clone();
        let value = match method {
            "hello" => json!({
                "server": "orchd",
                "version": env!("CARGO_PKG_VERSION"),
                "protocol": PROTOCOL_VERSION,
                "pid": std::process::id(),
                // Fonctions du démon détectables par le client (lot 13a).
                "capabilities": {"initial_prompt": true, "runners": true, "send_prompt_paste": true, "ci": true, "slash_commands": true, "review_instruction": true, "plugins": true},
            }),
            "profiles.list" => d.profiles()?,
            "projects.resolve" => {
                let path = opt_str(params, "path")?
                    .ok_or_else(|| RpcError::params("« path » manquant"))?;
                // `git` et système de fichiers : hors du runtime.
                let d2 = d.clone();
                tokio::task::spawn_blocking(move || d2.resolve_project(std::path::Path::new(&path)))
                    .await
                    .map_err(|e| RpcError::new(error_code::INTERNAL_ERROR, e.to_string()))??
            }
            "sessions.list" => {
                // `resumable` relu (système de fichiers) hors du runtime.
                let d2 = d.clone();
                let _ = tokio::task::spawn_blocking(move || d2.refresh_resumable(None)).await;
                d.list()
            }
            "sessions.get" => {
                let sid = session_id_param(params)?;
                let d2 = d.clone();
                let _ = tokio::task::spawn_blocking(move || d2.refresh_resumable(Some(sid))).await;
                d.get(&sid)?
            }
            "sessions.launch" => {
                // `git` (worktree, dépôt) : hors du runtime.
                let (d2, params) = (d.clone(), params.clone());
                tokio::task::spawn_blocking(move || d2.launch(&params))
                    .await
                    .map_err(|e| RpcError::new(error_code::INTERNAL_ERROR, e.to_string()))??
            }
            "worktrees.list" | "worktrees.remove" => {
                // `git` : hors du runtime.
                let (d2, params, m) = (d.clone(), params.clone(), method.to_owned());
                tokio::task::spawn_blocking(move || {
                    if m == "worktrees.list" {
                        d2.worktrees_list(&params)
                    } else {
                        d2.worktrees_remove(&params)
                    }
                })
                .await
                .map_err(|e| RpcError::new(error_code::INTERNAL_ERROR, e.to_string()))??
            }
            "sessions.resume" => {
                // `git` (dépôt du dossier) : hors du runtime.
                let (d2, params) = (d.clone(), params.clone());
                tokio::task::spawn_blocking(move || d2.resume(&params))
                    .await
                    .map_err(|e| RpcError::new(error_code::INTERNAL_ERROR, e.to_string()))??
            }
            "sessions.stop" => {
                let sid = session_id_param(params)?;
                let stop_runners = match params.get("stop_runners") {
                    None | Some(Value::Null) => false,
                    Some(Value::Bool(b)) => *b,
                    Some(_) => return Err(RpcError::params("« stop_runners » : booléen attendu")),
                };
                let mut v = d.stop(&sid)?;
                if stop_runners {
                    v["runners_stopping"] = json!(d.stop_session_runners(&sid));
                }
                v
            }
            "runners.list" | "runners.start" => {
                // Disque (détection), sonde du port, lancement : hors du runtime.
                let (d2, params, m) = (d.clone(), params.clone(), method.to_owned());
                tokio::task::spawn_blocking(move || {
                    if m == "runners.list" {
                        d2.runners_list(&params)
                    } else {
                        d2.runners_start(&params)
                    }
                })
                .await
                .map_err(|e| RpcError::new(error_code::INTERNAL_ERROR, e.to_string()))??
            }
            "plugins.list" | "plugins.accept" | "plugins.revoke" | "plugins.panel"
            | "plugins.action" => {
                // Disque (manifestes, fichiers hachés), processus du plugin :
                // hors du runtime.
                let (d2, params, m) = (d.clone(), params.clone(), method.to_owned());
                tokio::task::spawn_blocking(move || match m.as_str() {
                    "plugins.list" => d2.plugins_list(&params),
                    "plugins.accept" => d2.plugins_accept(&params),
                    "plugins.revoke" => d2.plugins_revoke(&params),
                    "plugins.panel" => d2.plugins_panel(&params),
                    _ => d2.plugins_action(&params),
                })
                .await
                .map_err(|e| RpcError::new(error_code::INTERNAL_ERROR, e.to_string()))??
            }
            "runners.stop" => d.runners_stop(params)?,
            "runners.resize" => d.runners_resize(params)?,
            "runners.subscribe" => {
                let (pid, sub) = d.runner_subscribe(params)?;
                self.start_stream(Stream::Runner(pid), sub, id).await;
                return Ok(None);
            }
            "runners.unsubscribe" => {
                let pid = process_id_param(params)?;
                let was = self.subscriptions.remove(&pid).map(|t| t.abort()).is_some();
                json!({"unsubscribed": was})
            }
            "sessions.resize" => {
                let sid = session_id_param(params)?;
                let size = size_param(params, DEFAULT_SIZE)?;
                d.resize(&sid, size)?
            }
            "sessions.input" => {
                let sid = session_id_param(params)?;
                let data = opt_str(params, "data")?
                    .ok_or_else(|| RpcError::params("« data » manquant"))?;
                let tx = d.input_sender(&sid)?;
                let lock = d.pty_lock(&sid);
                let _guard = match &lock {
                    Some(l) => Some(l.lock().await),
                    None => None,
                };
                tx.send(data.into_bytes()).await.map_err(|_| {
                    RpcError::new(error_code::INVALID_STATE, "la session ne tourne plus")
                })?;
                json!({})
            }
            "sessions.subscribe" => {
                let sid = session_id_param(params)?;
                let history = params
                    .get("history")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                self.subscribe(sid, history, id).await?;
                return Ok(None);
            }
            "sessions.unsubscribe" => {
                let sid = session_id_param(params)?;
                let was = self.subscriptions.remove(&sid).map(|t| t.abort()).is_some();
                json!({"unsubscribed": was})
            }
            "sessions.setMode" => {
                match d.set_mode(params) {
                    Ok(keys) => send_mode_keys(&d, params, keys).await?,
                    // Changement précédent pas encore confirmé : réessayé dans
                    // une tâche à part, pour ne pas bloquer la connexion (les
                    // touches et requêtes suivantes passent ; la réponse peut
                    // arriver après d'autres, l'`id` JSON-RPC les distingue).
                    Err(SetModeError::Unconfirmed(_)) => {
                        let (out, params) = (self.out.clone(), params.clone());
                        tokio::spawn(async move {
                            let result = set_mode_with_retry(&d, &params).await;
                            if let Some(id) = id {
                                let msg = match result {
                                    Ok(v) => response(id, v),
                                    Err(e) => error_response_data(id, e.code, e.message, e.data),
                                };
                                let _ = out.send(Frame::rpc(&msg)).await;
                            }
                        });
                        return Ok(None);
                    }
                    Err(e) => return Err(e.into_rpc()),
                }
            }
            "sessions.update" => d.update_session(params)?,
            "sessions.forget" => {
                let sid = session_id_param(params)?;
                let d2 = d.clone();
                tokio::task::spawn_blocking(move || d2.forget(&sid))
                    .await
                    .map_err(|e| RpcError::new(error_code::INTERNAL_ERROR, e.to_string()))??
            }
            // Socket de contrôle seulement (le socket des relais ferme toute
            // connexion qui envoie du JSON-RPC) : `forge.submitReview`, seule
            // écriture vers la forge, ne part que d'une action de l'utilisateur
            // dans l'app (ADR 0006, point 5).
            "forge.status"
            | "forge.issues"
            | "forge.issue"
            | "forge.labels"
            | "forge.pulls"
            | "forge.pull"
            | "forge.pullFile"
            | "forge.pullForBranch"
            | "forge.runs"
            | "forge.runFailure"
            | "forge.sessionCi"
            | "forge.configure"
            | "forge.submitReview" => {
                // `git` et `gh` : hors du runtime.
                let (d2, params, m) = (d.clone(), params.clone(), method.to_owned());
                tokio::task::spawn_blocking(move || match m.as_str() {
                    "forge.status" => d2.forge_status(&params),
                    "forge.issues" => d2.forge_issues(&params),
                    "forge.issue" => d2.forge_issue(&params),
                    "forge.labels" => d2.forge_labels(&params),
                    "forge.pulls" => d2.forge_pulls(&params),
                    "forge.pull" => d2.forge_pull(&params),
                    "forge.pullFile" => d2.forge_pull_file(&params),
                    "forge.pullForBranch" => d2.forge_pull_for_branch(&params),
                    "forge.runs" => d2.forge_runs(&params),
                    "forge.runFailure" => d2.forge_run_failure(&params),
                    "forge.sessionCi" => d2.forge_session_ci(&params),
                    "forge.configure" => d2.forge_configure(&params),
                    _ => d2.forge_submit_review(&params),
                })
                .await
                .map_err(|e| RpcError::new(error_code::INTERNAL_ERROR, e.to_string()))??
            }
            "commands.list" => {
                // Lecture de fichiers : hors du runtime.
                let (d2, params) = (d.clone(), params.clone());
                tokio::task::spawn_blocking(move || d2.commands_list(&params))
                    .await
                    .map_err(|e| RpcError::new(error_code::INTERNAL_ERROR, e.to_string()))??
            }
            "files.list" | "files.read" | "files.write" => {
                // Système de fichiers et `git` : hors du runtime.
                let (d2, params, m) = (d.clone(), params.clone(), method.to_owned());
                tokio::task::spawn_blocking(move || match m.as_str() {
                    "files.list" => d2.files_list(&params),
                    "files.read" => d2.files_read(&params),
                    _ => d2.files_write(&params),
                })
                .await
                .map_err(|e| RpcError::new(error_code::INTERNAL_ERROR, e.to_string()))??
            }
            "sessions.diff"
            | "sessions.diffFile"
            | "sessions.commits"
            | "sessions.commitDiff"
            | "sessions.commitDiffFile"
            | "sessions.sendReview" => {
                // `git` : hors du runtime.
                let (d2, params, m) = (d.clone(), params.clone(), method.to_owned());
                let r = tokio::task::spawn_blocking(move || match m.as_str() {
                    "sessions.diff" => d2.diff(&params).map(|v| (v, None)),
                    "sessions.diffFile" => d2.diff_file(&params).map(|v| (v, None)),
                    "sessions.commits" => d2.commits(&params).map(|v| (v, None)),
                    "sessions.commitDiff" => d2.commit_diff(&params).map(|v| (v, None)),
                    "sessions.commitDiffFile" => d2.commit_diff_file(&params).map(|v| (v, None)),
                    _ => d2
                        .prepare_review(&params)
                        .map(|keys| (json!({"sent": true}), Some(keys))),
                })
                .await
                .map_err(|e| RpcError::new(error_code::INTERNAL_ERROR, e.to_string()))??;
                if let (value, Some(review)) = r {
                    send_review(&d, &review).await?;
                    value
                } else {
                    r.0
                }
            }
            "quotas.get" => {
                let refresh = match params.get("refresh") {
                    None | Some(Value::Null) => false,
                    Some(Value::Bool(b)) => *b,
                    Some(_) => return Err(RpcError::params("« refresh » doit être un booléen")),
                };
                let d2 = d.clone();
                tokio::task::spawn_blocking(move || d2.quotas_get(refresh))
                    .await
                    .map_err(|e| RpcError::new(error_code::INTERNAL_ERROR, e.to_string()))?
            }
            "transcripts.hide" => d.set_transcript_hidden(params, true)?,
            "transcripts.unhide" => d.set_transcript_hidden(params, false)?,
            "conversation.get" | "conversation.subagent" => {
                // Lecture du transcript : hors du runtime.
                let (d2, params, sub) =
                    (d.clone(), params.clone(), method == "conversation.subagent");
                let (value, sid, rev) =
                    tokio::task::spawn_blocking(move || d2.conversation_get(&params, sub))
                        .await
                        .map_err(|e| RpcError::new(error_code::INTERNAL_ERROR, e.to_string()))??;
                // Les `conversation.changed` de cette connexion partent de
                // l'instantané (une révision déjà posée est gardée : rien ne
                // se perd, au pire un doublon).
                self.conv_cursors
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .entry(sid)
                    .or_insert(rev);
                // Un changement survenu entre l'instantané et la pose de la
                // révision a pu partir sans elle : on refait un envoi.
                d.conversation_touched(sid);
                value
            }
            "conversation.full" => {
                let (d2, params) = (d.clone(), params.clone());
                tokio::task::spawn_blocking(move || d2.conversation_full(&params))
                    .await
                    .map_err(|e| RpcError::new(error_code::INTERNAL_ERROR, e.to_string()))??
            }
            "sessions.sendPrompt" => {
                let prompt = d.prepare_prompt(params)?;
                send_prompt(&d, &prompt).await?;
                json!({"sent": true})
            }
            "sessions.subagents" => d.subagents_list(params)?,
            "sessions.subagent" => d.subagent_detail(params)?,
            "sessions.answerPermission" => d.answer_permission(params)?,
            "sessions.answerQuestion" => d.answer_question(params)?,
            "transcripts.list" => {
                // Lecture des transcripts : hors du runtime.
                let (d2, params) = (d.clone(), params.clone());
                tokio::task::spawn_blocking(move || d2.transcripts(&params))
                    .await
                    .map_err(|e| RpcError::new(error_code::INTERNAL_ERROR, e.to_string()))??
            }
            other => {
                return Err(RpcError::new(
                    error_code::METHOD_NOT_FOUND,
                    format!("méthode inconnue : {other}"),
                ));
            }
        };
        Ok(Some(value))
    }

    /// Envoie la réponse (instantané) puis lance le relais de la sortie :
    /// la réponse précède toujours les octets qui la suivent.
    async fn subscribe(
        &mut self,
        sid: Uuid,
        history: bool,
        id: Option<Value>,
    ) -> Result<(), RpcError> {
        let sub = self.daemon.subscribe(&sid, history)?;
        self.start_stream(Stream::Session(sid), sub, id).await;
        Ok(())
    }

    /// Réponse (instantané) puis relais de la sortie d'un flux.
    async fn start_stream(&mut self, stream: Stream, sub: Subscription, id: Option<Value>) {
        let sid = stream.id();
        let (snap, hist, rx, terminal) = sub;
        if let Some(old) = self.subscriptions.remove(&sid) {
            old.abort();
        }
        let mut result = match stream {
            Stream::Session(_) => json!({"id": sid, "snapshot": snapshot_json(&snap)}),
            Stream::Runner(_) => json!({"process_id": sid, "snapshot": snapshot_json(&snap)}),
        };
        if let Some(hist) = hist {
            result["history"] = json!(String::from_utf8_lossy(&hist));
        }
        if let Some(id) = id {
            self.send(response(id, result)).await;
        }
        let out = self.out.clone();
        let task = tokio::spawn(forward_output(stream, rx, terminal, out));
        self.subscriptions.insert(sid, task);
    }
}

/// Délai entre la consigne tapée, la revue collée et l'Entrée : la TUI
/// traite chaque morceau à part (une consigne tapée d'un bloc reste du texte
/// tapé, la revue reste un collage).
const REVIEW_STEP: std::time::Duration = std::time::Duration::from_millis(80);

/// Tape la consigne (celle de la revue, ou celle des extraits de fichiers),
/// colle la revue en *bracketed paste*, puis Entrée (architecture § 9 : seul
/// le contenu est collé).
///
/// Le verrou des écritures de la session est tenu pendant les trois envois :
/// ni une autre revue, ni des Shift+Tab, ni une entrée clavier passée par le
/// démon ne s'intercalent. (Des touches tapées par l'utilisateur pendant ces
/// 160 ms attendent derrière le verrou.) Une fois le verrou pris, l'état de
/// la session est revérifié : une demande apparue pendant la préparation
/// (lecture du disque, `git`) fait refuser la revue, sans rien écrire.
async fn send_review(d: &Arc<Daemon>, review: &ReviewToSend) -> Result<(), RpcError> {
    let _guard = review.lock.lock().await;
    d.recheck_review(review)?;
    let tx = &review.input;
    let gone = |_| RpcError::new(error_code::INVALID_STATE, "la session ne tourne plus");
    tx.send(review.instruction.as_bytes().to_vec())
        .await
        .map_err(gone)?;
    tokio::time::sleep(REVIEW_STEP).await;
    tx.send(bracketed_paste(&review.text)).await.map_err(gone)?;
    tokio::time::sleep(REVIEW_STEP).await;
    enter_if_still_free(d, &review.id, tx).await
}

/// Texte encadré pour un *bracketed paste* (le texte ne contient plus de
/// caractère de contrôle autre que saut de ligne et tabulation : il ne peut
/// pas fermer l'encadrement).
fn bracketed_paste(text: &str) -> Vec<u8> {
    let mut paste = b"\x1b[200~".to_vec();
    paste.extend_from_slice(text.as_bytes());
    paste.extend_from_slice(b"\x1b[201~");
    paste
}

/// Entrée finale, après une dernière vérification : une demande apparue
/// pendant l'envoi (Claude a ouvert une permission) fait abandonner sans
/// Entrée, avec la même erreur que le refus initial — le texte reste alors
/// dans le champ de la TUI. Risque résiduel : une demande qui s'ouvre entre
/// cette vérification et la lecture de l'Entrée par la TUI (quelques
/// millisecondes) ; l'Entrée irait au dialogue.
async fn enter_if_still_free(
    d: &Arc<Daemon>,
    id: &uuid::Uuid,
    tx: &mpsc::Sender<Vec<u8>>,
) -> Result<(), RpcError> {
    d.recheck_input(id, tx)?;
    tx.send(b"\r".to_vec())
        .await
        .map_err(|_| RpcError::new(error_code::INVALID_STATE, "la session ne tourne plus"))
}

/// Écrit un prompt (`sessions.sendPrompt`) : tapé d'un bloc s'il est court
/// et sur une ligne, sinon collé en *bracketed paste* ; puis Entrée (règle
/// du prototype n° 1, Q8, et ADR 0005). Avec `pasted` (lot 14b) : la
/// consigne est tapée, le contenu collé, puis Entrée (comme
/// `sessions.sendReview`). Verrou des écritures tenu pendant tout l'envoi,
/// état revérifié une fois le verrou pris (demande apparue, processus
/// changé : refus sans rien écrire).
async fn send_prompt(d: &Arc<Daemon>, p: &PromptToSend) -> Result<(), RpcError> {
    let _guard = p.lock.lock().await;
    d.recheck_input(&p.id, &p.input)?;
    let gone = |_| RpcError::new(error_code::INVALID_STATE, "la session ne tourne plus");
    let bytes = if p.paste {
        bracketed_paste(&p.text)
    } else {
        p.text.as_bytes().to_vec()
    };
    p.input.send(bytes).await.map_err(gone)?;
    tokio::time::sleep(REVIEW_STEP).await;
    if let Some(pasted) = &p.pasted {
        p.input.send(bracketed_paste(pasted)).await.map_err(gone)?;
        tokio::time::sleep(REVIEW_STEP).await;
    }
    enter_if_still_free(d, &p.id, &p.input).await
}

/// Attente entre deux examens de l'état de la session, pour le prompt initial.
const INITIAL_POLL: std::time::Duration = std::time::Duration::from_millis(100);
/// La session doit être restée prête (inactive, sans demande) ce temps-là
/// avant que le prompt initial ne parte : la TUI a fini de s'afficher.
const INITIAL_SETTLE: std::time::Duration = std::time::Duration::from_millis(300);

/// Envoie le prompt initial d'une session lancée avec `initial` (lot 13a) :
/// attend que la TUI soit prête (`SessionStart` ou `idle_prompt` reçu,
/// session inactive sans demande, depuis [`INITIAL_SETTLE`]), puis, verrou
/// des écritures pris et état revérifié, **tape** la consigne, **colle** le
/// contenu en *bracketed paste* et envoie Entrée (même règle que
/// `sessions.sendReview` et `sessions.sendPrompt`). Une demande ouverte fait
/// attendre : avant d'écrire, rien n'est écrit ; après, seule l'Entrée est
/// renvoyée plus tard. Abandon au bout du délai, ou si la session s'arrête :
/// effet `initial_prompt_failed {reason}` ; sinon `initial_prompt_sent`.
pub(crate) async fn deliver_initial(
    d: Arc<Daemon>,
    id: Uuid,
    input: mpsc::Sender<Vec<u8>>,
    lock: super::supervisor::PtyLock,
    initial: super::supervisor::forge::InitialPrompt,
) {
    let deadline = tokio::time::Instant::now() + d.initial_prompt_timeout();
    let result = deliver_initial_until(&d, &id, &input, &lock, &initial, deadline).await;
    d.initial_prompt_done(id, result);
}

async fn deliver_initial_until(
    d: &Arc<Daemon>,
    id: &Uuid,
    input: &mpsc::Sender<Vec<u8>>,
    lock: &super::supervisor::PtyLock,
    initial: &super::supervisor::forge::InitialPrompt,
    deadline: tokio::time::Instant,
) -> Result<(), String> {
    use super::supervisor::forge::InitialReadiness;
    let gone = || "prompt initial abandonné : la session s'est arrêtée avant son envoi".to_owned();
    let mut typed = false;
    let mut ready_since: Option<tokio::time::Instant> = None;
    loop {
        let now = tokio::time::Instant::now();
        if now >= deadline {
            return Err(format!(
                "prompt initial abandonné : la session n'était pas prête (ou une demande \
                 attendait une réponse) au bout de {} s{}",
                d.initial_prompt_timeout().as_secs(),
                if typed {
                    " ; le texte est resté dans le champ de saisie"
                } else {
                    ""
                }
            ));
        }
        match d.initial_readiness(id, input) {
            InitialReadiness::Gone => return Err(gone()),
            InitialReadiness::Wait => {
                ready_since = None;
                tokio::time::sleep(INITIAL_POLL).await;
                continue;
            }
            InitialReadiness::Ready => {}
        }
        if now.duration_since(*ready_since.get_or_insert(now)) < INITIAL_SETTLE {
            tokio::time::sleep(INITIAL_POLL).await;
            continue;
        }
        let guard = lock.lock().await;
        // Revérifié verrou pris : une demande apparue entre-temps fait attendre.
        if d.recheck_input(id, input).is_err() {
            drop(guard);
            ready_since = None;
            tokio::time::sleep(INITIAL_POLL).await;
            continue;
        }
        if !typed {
            let text = &initial.instruction;
            // Seule, une consigne qui finit par `\` passerait à la ligne :
            // collée comme `sessions.sendPrompt` le ferait.
            let bytes = if initial.pasted.is_empty() && text.ends_with('\\') {
                bracketed_paste(text)
            } else {
                text.as_bytes().to_vec()
            };
            input.send(bytes).await.map_err(|_| gone())?;
            if !initial.pasted.is_empty() {
                tokio::time::sleep(REVIEW_STEP).await;
                input
                    .send(bracketed_paste(&initial.pasted))
                    .await
                    .map_err(|_| gone())?;
            }
            typed = true;
            tokio::time::sleep(REVIEW_STEP).await;
            // Demande ouverte pendant l'écriture : l'Entrée attendra.
            if d.recheck_input(id, input).is_err() {
                drop(guard);
                ready_since = None;
                continue;
            }
        }
        input.send(b"\r".to_vec()).await.map_err(|_| gone())?;
        return Ok(());
    }
}

/// Écrit les Shift+Tab d'un `sessions.setMode` accepté. Si l'écriture
/// échoue (processus terminé), le changement attendu est abandonné.
async fn send_mode_keys(
    d: &Arc<Daemon>,
    params: &Value,
    (tx, bytes, sent): super::supervisor::ModeKeys,
) -> Result<Value, RpcError> {
    let lock = session_id_param(params).ok().and_then(|id| d.pty_lock(&id));
    let _guard = match &lock {
        Some(l) => Some(l.lock().await),
        None => None,
    };
    if sent > 0 && tx.send(bytes).await.is_err() {
        if let Ok(id) = session_id_param(params) {
            d.cancel_mode_change(&id);
        }
        return Err(RpcError::new(
            error_code::INVALID_STATE,
            "la session ne tourne plus",
        ));
    }
    Ok(json!({"sent": sent}))
}

/// `sessions.setMode` réessayé toutes les [`SET_MODE_RETRY_STEP`] pendant
/// au plus [`SET_MODE_RETRY`] tant que le changement précédent n'est pas
/// confirmé ; ensuite l'erreur `-32002`.
async fn set_mode_with_retry(d: &Arc<Daemon>, params: &Value) -> Result<Value, RpcError> {
    let deadline = tokio::time::Instant::now() + SET_MODE_RETRY;
    loop {
        match d.set_mode(params) {
            Ok(keys) => return send_mode_keys(d, params, keys).await,
            Err(SetModeError::Unconfirmed(_)) if tokio::time::Instant::now() < deadline => {
                tokio::time::sleep(SET_MODE_RETRY_STEP).await;
            }
            Err(e) => return Err(e.into_rpc()),
        }
    }
}

/// Flux de terminal auquel un client s'abonne : une session, ou un
/// processus de runner (v0.3, lot 14a). Les trames `0x02` / `0x03` portent
/// l'UUID de l'un ou de l'autre.
#[derive(Debug, Clone, Copy)]
enum Stream {
    Session(Uuid),
    Runner(Uuid),
}

impl Stream {
    fn id(self) -> Uuid {
        match self {
            Self::Session(id) | Self::Runner(id) => id,
        }
    }
}

/// Relaie la sortie d'un PTY vers un client, en regroupant les morceaux
/// disponibles. Sur `Lagged`, renvoie un instantané (`session.resync`).
async fn forward_output(
    stream: Stream,
    mut rx: broadcast::Receiver<Chunk>,
    terminal: Arc<Terminal>,
    out: mpsc::Sender<Frame>,
) {
    use broadcast::error::{RecvError, TryRecvError};
    loop {
        let mut lagged = false;
        let mut data = match rx.recv().await {
            Ok(chunk) => chunk.to_vec(),
            Err(RecvError::Lagged(_)) => {
                lagged = true;
                Vec::new()
            }
            Err(RecvError::Closed) => return,
        };
        while !lagged && data.len() < PTY_BATCH {
            match rx.try_recv() {
                Ok(chunk) => data.extend_from_slice(&chunk),
                Err(TryRecvError::Lagged(_)) => lagged = true,
                // Vide ou fermé : la fermeture est vue au prochain `recv`.
                Err(_) => break,
            }
        }
        if lagged {
            // Des octets manquent : on jette le lot et on renvoie l'écran.
            let (snap, new_rx) = terminal.subscribe();
            rx = new_rx;
            let n = match stream {
                Stream::Session(sid) => notification(
                    "session.resync",
                    json!({"id": sid, "snapshot": snapshot_json(&snap)}),
                ),
                Stream::Runner(pid) => notification(
                    "runners.resync",
                    json!({"process_id": pid, "snapshot": snapshot_json(&snap)}),
                ),
            };
            if out.send(Frame::rpc(&n)).await.is_err() {
                return;
            }
            continue;
        }
        if out
            .send(Frame::PtyOutput {
                session: stream.id(),
                data,
            })
            .await
            .is_err()
        {
            return;
        }
    }
}

/// Événements en attente au plus pour une connexion ; au-delà, la file est
/// remplacée par un `session.updated` par session (les effets en trop sont perdus).
const MAX_PENDING_EVENTS: usize = 4096;

fn queue_event(daemon: &Daemon, queue: &mut VecDeque<Event>, ev: Event) {
    if matches!(ev, Event::Quotas) && queue.iter().any(|e| matches!(e, Event::Quotas)) {
        return; // Regroupé : relu au moment d'envoyer.
    }
    if let Event::DiffChanged(id) = &ev
        && queue
            .iter()
            .any(|e| matches!(e, Event::DiffChanged(other) if other == id))
    {
        return;
    }
    if let Event::SubagentsChanged(id) = &ev
        && queue
            .iter()
            .any(|e| matches!(e, Event::SubagentsChanged(other) if other == id))
    {
        return; // Regroupé : la liste est relue au moment d'envoyer.
    }
    if let Event::ConversationChanged(id) = &ev
        && queue
            .iter()
            .any(|e| matches!(e, Event::ConversationChanged(other) if other == id))
    {
        return; // Regroupé : calculé depuis la révision de la connexion à l'envoi.
    }
    if let Event::RunnersChanged(id) = &ev
        && queue
            .iter()
            .any(|e| matches!(e, Event::RunnersChanged(other) if other == id))
    {
        return; // Regroupé : la liste est relue au moment d'envoyer.
    }
    if let Event::WorktreesChanged(root) = &ev
        && queue
            .iter()
            .any(|e| matches!(e, Event::WorktreesChanged(other) if other == root))
    {
        return;
    }
    if matches!(ev, Event::PluginsChanged)
        && queue.iter().any(|e| matches!(e, Event::PluginsChanged))
    {
        return; // Regroupé : la notification est sans contenu.
    }
    if let Event::Updated(id) = &ev
        && queue
            .iter()
            .any(|e| matches!(e, Event::Updated(other) if other == id))
    {
        // Regroupé : l'état est relu au moment d'envoyer.
        return;
    }
    if queue.len() >= MAX_PENDING_EVENTS {
        warning!("client lent : notifications regroupées, renvoi de l'état");
        resync_events(daemon, queue);
        return;
    }
    queue.push_back(ev);
}

fn resync_events(daemon: &Daemon, queue: &mut VecDeque<Event>) {
    queue.clear();
    // Les retraits récents d'abord : un client en retard apprend aussi quelles
    // sessions ont disparu (un `session.removed` inconnu est sans effet).
    queue.extend(daemon.removed_ids().into_iter().map(Event::Removed));
    let ids = daemon.session_ids();
    queue.extend(ids.iter().copied().map(Event::Updated));
    // Un client en retard a pu manquer des changements de diff.
    queue.extend(ids.into_iter().map(Event::DiffChanged));
    queue.extend(
        daemon
            .sessions_with_subagents()
            .into_iter()
            .map(Event::SubagentsChanged),
    );
    queue.extend(
        daemon
            .worktree_roots()
            .into_iter()
            .map(Event::WorktreesChanged),
    );
    // Les conversations : rien n'est perdu, tout part de la révision de la connexion.
    queue.extend(
        daemon
            .sessions_with_conversation()
            .into_iter()
            .map(Event::ConversationChanged),
    );
    queue.extend(
        daemon
            .sessions_with_runners()
            .into_iter()
            .map(Event::RunnersChanged),
    );
    queue.push_back(Event::Quotas);
    queue.push_back(Event::PluginsChanged);
}

fn event_frame(daemon: &Daemon, ev: Event) -> Option<Frame> {
    let value = match ev {
        Event::Updated(id) => notification(
            "session.updated",
            json!({"session": daemon.session_json(&id)?}),
        ),
        Event::Effect { id, effect } => {
            notification("session.effect", json!({"id": id, "effect": *effect}))
        }
        Event::Removed(id) => notification("session.removed", json!({"id": id})),
        Event::Quotas => notification("quotas.updated", daemon.quotas_json()),
        Event::DiffChanged(id) => notification("session.diff_changed", json!({"id": id})),
        Event::SubagentsChanged(id) => {
            notification("session.subagents_changed", daemon.subagents_json(&id)?)
        }
        Event::WorktreesChanged(root) => {
            notification("project.worktrees_changed", json!({"root": root}))
        }
        Event::RunnersChanged(id) => notification(
            "runners.changed",
            json!({"id": id, "running": daemon.runners_running_json(&id)}),
        ),
        Event::CiChanged { id, state } => {
            notification("forge.ci_changed", json!({"id": id, "state": state}))
        }
        Event::PluginsChanged => notification("plugins.changed", json!({})),
        // Calculée par connexion (voir `forward_events`).
        Event::ConversationChanged(_) => return None,
    };
    Some(Frame::rpc(&value))
}

/// Relaie les événements du démon vers une connexion. Les `session.updated`
/// en attente d'une même session sont regroupés : un client lent reçoit
/// toujours l'état le plus récent, avec une file bornée en nombre et petite
/// en taille (identifiants et effets seulement).
async fn forward_events(
    daemon: Arc<Daemon>,
    mut rx: broadcast::Receiver<Event>,
    out: mpsc::Sender<Frame>,
    cursors: ConvCursors,
) {
    use broadcast::error::{RecvError, TryRecvError};
    let mut queue: VecDeque<Event> = VecDeque::new();
    loop {
        loop {
            match rx.try_recv() {
                Ok(ev) => queue_event(&daemon, &mut queue, ev),
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Lagged(_)) => resync_events(&daemon, &mut queue),
                Err(TryRecvError::Closed) => return,
            }
        }
        if queue.is_empty() {
            match rx.recv().await {
                Ok(ev) => queue_event(&daemon, &mut queue, ev),
                Err(RecvError::Lagged(_)) => resync_events(&daemon, &mut queue),
                Err(RecvError::Closed) => return,
            }
            continue;
        }
        tokio::select! {
            permit = out.reserve() => {
                let Ok(permit) = permit else { return };
                match queue.pop_front() {
                    Some(Event::ConversationChanged(id)) => {
                        drop(permit);
                        if !send_conversation(&daemon, id, &out, &cursors).await {
                            return;
                        }
                    }
                    Some(ev) => {
                        if let Some(frame) = event_frame(&daemon, ev) {
                            permit.send(frame);
                        }
                    }
                    None => {}
                }
            }
            r = rx.recv() => match r {
                Ok(ev) => queue_event(&daemon, &mut queue, ev),
                Err(RecvError::Lagged(_)) => resync_events(&daemon, &mut queue),
                Err(RecvError::Closed) => return,
            },
        }
    }
}

/// `conversation.changed` d'une session pour une connexion qui l'a lue
/// (`conversation.get`) : tout ce qui a changé depuis sa révision, calculé
/// hors du runtime. `false` si la connexion est fermée.
async fn send_conversation(
    daemon: &Arc<Daemon>,
    id: Uuid,
    out: &mpsc::Sender<Frame>,
    cursors: &ConvCursors,
) -> bool {
    let Some(cursor) = cursors
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&id)
        .copied()
    else {
        return true; // Conversation pas lue par ce client.
    };
    let d = daemon.clone();
    let Ok(Some((frames, rev))) =
        tokio::task::spawn_blocking(move || d.conversation_changes(&id, cursor)).await
    else {
        return true;
    };
    for f in frames {
        if out.send(Frame::rpc(&f)).await.is_err() {
            return false;
        }
    }
    if let Some(c) = cursors
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get_mut(&id)
    {
        *c = (*c).max(rev);
    }
    true
}
