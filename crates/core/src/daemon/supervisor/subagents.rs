//! Sous-agents des sessions (v0.2, lot 5) côté démon : méthodes
//! `sessions.subagents` / `sessions.subagent`, persistance, et notification
//! `session.subagents_changed`.
//!
//! La construction des sous-agents est dans le domaine
//! ([`crate::domain::subagents`]) ; ici, seulement l'exposition. Rapports,
//! descriptions et types viennent de Claude : ce sont des données, jamais
//! interprétées (transmises telles quelles au client).

use std::time::{Duration, Instant};

use serde_json::{Value, json};
use uuid::Uuid;

use super::{Daemon, Entry, Event, RpcError, opt_str, session_id_param};
use crate::domain::SubagentChange;
use crate::protocol::error_code;
use crate::protocol::json::subagent_json;

/// Intervalle minimal entre deux `session.subagents_changed` d'une session
/// dus aux seuls compteurs d'outils.
pub const COUNTERS_INTERVAL: Duration = Duration::from_millis(500);

/// Suivi des notifications d'une session.
#[derive(Debug, Default)]
pub(super) struct NotifyState {
    /// Dernière notification envoyée.
    last: Option<Instant>,
    /// Une notification différée est prévue.
    scheduled: bool,
}

impl Daemon {
    /// `sessions.subagents {id}` → `{agents}` (ordre de lancement, sans `report`).
    pub fn subagents_list(&self, params: &Value) -> Result<Value, RpcError> {
        let id = session_id_param(params)?;
        self.subagents_json(&id)
            .map(|mut v| {
                v.as_object_mut().map(|o| o.remove("id"));
                v
            })
            .ok_or_else(|| RpcError::unknown_session(&id))
    }

    /// `sessions.subagent {id, agent_id}` → `Subagent` avec `report`.
    pub fn subagent_detail(&self, params: &Value) -> Result<Value, RpcError> {
        let id = session_id_param(params)?;
        let agent_id = opt_str(params, "agent_id")?
            .filter(|a| !a.is_empty())
            .ok_or_else(|| RpcError::params("« agent_id » manquant"))?;
        let reg = self.lock();
        let entry = reg
            .sessions
            .get(&id)
            .ok_or_else(|| RpcError::unknown_session(&id))?;
        let agent = entry
            .session
            .state
            .subagents()
            .get(&agent_id)
            .ok_or_else(|| {
                RpcError::new(
                    error_code::UNKNOWN_SUBAGENT,
                    format!("sous-agent inconnu dans cette session : {agent_id}"),
                )
            })?;
        Ok(subagent_json(agent, true))
    }

    /// Paramètres de `session.subagents_changed` : `{id, agents}` (sans
    /// `report`). `None` si la session n'existe plus.
    pub fn subagents_json(&self, id: &Uuid) -> Option<Value> {
        let reg = self.lock();
        let entry = reg.sessions.get(id)?;
        let agents: Vec<Value> = entry
            .session
            .state
            .subagents()
            .list()
            .iter()
            .map(|a| subagent_json(a, false))
            .collect();
        Some(json!({"id": id, "agents": agents}))
    }

    /// Sessions qui ont des sous-agents (resynchronisation d'un client en retard).
    pub fn sessions_with_subagents(&self) -> Vec<Uuid> {
        self.lock()
            .sessions
            .values()
            .filter(|e| e.session.state.subagents().total() > 0)
            .map(|e| e.session.id)
            .collect()
    }

    /// Écrit en base les sous-agents qui ont changé depuis la dernière
    /// écriture, et retire ceux que la mémoire a oubliés (plafond de 100 :
    /// même règle des deux côtés).
    pub(super) fn persist_subagents(&self, entry: &mut Entry) {
        let id = entry.session.id;
        let agents = entry.session.state.subagents();
        let changed: Vec<_> = agents
            .list()
            .iter()
            .filter(|a| entry.subagents_persisted.get(&a.agent_id) != Some(&a.fingerprint()))
            .cloned()
            .collect();
        let gone: Vec<String> = entry
            .subagents_persisted
            .keys()
            .filter(|k| agents.get(k).is_none())
            .cloned()
            .collect();
        if !gone.is_empty() {
            match self.deps.store.delete_subagents(&id, &gone) {
                Ok(()) => {
                    for k in &gone {
                        entry.subagents_persisted.remove(k);
                    }
                }
                Err(e) => super::error!("retrait des sous-agents de la session {id} en base : {e}"),
            }
        }
        if changed.is_empty() {
            return;
        }
        if let Err(e) = self.deps.store.upsert_subagents(&id, &changed) {
            super::error!("écriture des sous-agents de la session {id} en base : {e}");
            return;
        }
        for a in changed {
            entry
                .subagents_persisted
                .insert(a.agent_id.clone(), a.fingerprint());
        }
    }

    /// Tic périodique (sondage du diff, toutes les 5 s) : une session que
    /// des sous-agents retenaient `running` passe `idle` quand le délai de
    /// grâce de leur `task-notification` est écoulé.
    pub fn tick_subagents(&self) {
        let now = self.now();
        let mut reg = self.lock();
        for entry in reg.sessions.values_mut() {
            if entry.session.state.tick(now) {
                entry.updated_at = now;
                self.commit(entry);
            }
        }
    }

    /// Signale un changement des sous-agents : tout de suite pour une
    /// création ou un statut, au plus toutes les [`COUNTERS_INTERVAL`] pour
    /// les compteurs d'outils (la notification différée relit l'état).
    pub(super) fn signal_subagents(&self, id: Uuid, change: SubagentChange) {
        if change == SubagentChange::None {
            return;
        }
        let delay = {
            let mut map = self
                .subagent_notify
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let st = map.entry(id).or_default();
            let delay = match change {
                SubagentChange::None | SubagentChange::Structural => None,
                SubagentChange::Counters if st.scheduled => return,
                SubagentChange::Counters => st
                    .last
                    .map(|t| t.elapsed())
                    .filter(|e| *e < COUNTERS_INTERVAL)
                    .map(|e| COUNTERS_INTERVAL - e),
            };
            match delay {
                Some(_) => st.scheduled = true,
                None => st.last = Some(Instant::now()),
            }
            delay
        };
        match delay {
            None => {
                let _ = self.events.send(Event::SubagentsChanged(id));
            }
            Some(delay) => {
                let Some(daemon) = self.me.upgrade() else {
                    return;
                };
                self.runtime.spawn(async move {
                    tokio::time::sleep(delay).await;
                    daemon.flush_subagents(id);
                });
            }
        }
    }

    /// Notification différée des compteurs d'outils.
    fn flush_subagents(&self, id: Uuid) {
        {
            let mut map = self
                .subagent_notify
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let Some(st) = map.get_mut(&id) else {
                return;
            };
            st.scheduled = false;
            st.last = Some(Instant::now());
        }
        let _ = self.events.send(Event::SubagentsChanged(id));
    }
}
