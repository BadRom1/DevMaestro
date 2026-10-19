//! Socket du démon : connexions, trames, méthodes JSON-RPC.
//!
//! Chaque connexion a une tâche d'écriture alimentée par une file bornée.
//! Les sorties de PTY auxquelles elle est abonnée et les notifications sont
//! poussées dans cette file par des tâches séparées : un client lent ne
//! ralentit que lui-même (ses abonnements prennent du retard puis sont
//! resynchronisés), jamais le PTY ni les autres clients.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;
use tokio::net::UnixStream;
use tokio::sync::{broadcast, mpsc};
use tokio::task::JoinHandle;
use uuid::Uuid;

use super::log::warning;
use super::supervisor::{
    DEFAULT_SIZE, Daemon, Event, RpcError, opt_str, session_id_param, size_param,
};
use super::terminal::{Chunk, Snapshot, Terminal};
use crate::protocol::{
    Frame, PROTOCOL_VERSION, error_code, error_response, notification, read_frame_async, response,
};

/// Trames en attente d'écriture vers un client.
const OUT_QUEUE: usize = 1024;
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

struct Connection {
    daemon: Arc<Daemon>,
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
                    let _ = tx.send(data).await;
                }
            }
            Frame::Hook { token, event, json } => {
                conn.daemon.on_hook(&token, &event, &json);
                // L'accusé rend la main au relais une fois l'événement appliqué :
                // deux hooks successifs sont ainsi traités dans l'ordre.
                let _ = conn.out.send(Frame::Ack).await;
            }
            Frame::Statusline { token, json } => conn.daemon.on_statusline(&token, &json),
            Frame::PtyOutput { .. } | Frame::Ack | Frame::Unknown { .. } => {}
        }
    }
    drop(conn);
    let _ = writer.await;
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
        self.notifications = Some(tokio::spawn(forward_events(daemon, rx, out)));
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
            Err(e) => self.send(error_response(id, e.code, e.message)).await,
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
            }),
            "profiles.list" => d.profiles()?,
            "projects.resolve" => {
                let path = opt_str(params, "path")?
                    .ok_or_else(|| RpcError::params("« path » manquant"))?;
                d.resolve_project(std::path::Path::new(&path))?
            }
            "sessions.list" => d.list(),
            "sessions.get" => d.get(&session_id_param(params)?)?,
            "sessions.launch" => d.launch(params)?,
            "sessions.resume" => d.resume(params)?,
            "sessions.stop" => d.stop(&session_id_param(params)?)?,
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
                return Err(RpcError::new(
                    error_code::METHOD_NOT_FOUND,
                    "sessions.setMode n'est pas encore disponible (lot 3)",
                ));
            }
            "transcripts.list" => {
                let profile = opt_str(params, "profile")?
                    .unwrap_or_else(|| crate::domain::profile::DEFAULT_PROFILE_NAME.to_owned());
                let limit = params
                    .get("limit")
                    .and_then(Value::as_u64)
                    .map(|n| n as usize)
                    .or(Some(50));
                d.transcripts(&profile, limit)?
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
        let (snap, hist, rx, terminal) = self.daemon.subscribe(&sid, history)?;
        if let Some(old) = self.subscriptions.remove(&sid) {
            old.abort();
        }
        let mut result = json!({"id": sid, "snapshot": snapshot_json(&snap)});
        if let Some(hist) = hist {
            result["history"] = json!(String::from_utf8_lossy(&hist));
        }
        if let Some(id) = id {
            self.send(response(id, result)).await;
        }
        let out = self.out.clone();
        let task = tokio::spawn(forward_output(sid, rx, terminal, out));
        self.subscriptions.insert(sid, task);
        Ok(())
    }
}

/// Relaie la sortie d'un PTY vers un client, en regroupant les morceaux
/// disponibles. Sur `Lagged`, renvoie un instantané (`session.resync`).
async fn forward_output(
    sid: Uuid,
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
            let n = notification(
                "session.resync",
                json!({"id": sid, "snapshot": snapshot_json(&snap)}),
            );
            if out.send(Frame::rpc(&n)).await.is_err() {
                return;
            }
            continue;
        }
        if out
            .send(Frame::PtyOutput { session: sid, data })
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
    queue.extend(daemon.session_ids().into_iter().map(Event::Updated));
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
                if let Some(frame) = queue.pop_front().and_then(|ev| event_frame(&daemon, ev)) {
                    permit.send(frame);
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
