//! Livraison et suivi de CI (v0.3, lot 14b, ADR 0006) : `forge.runs`,
//! `forge.runFailure`, `forge.sessionCi`, et le sondage de la CI des
//! sessions suivies (`forge.ci_changed`).
//!
//! Lecture seule : rien n'est écrit vers la forge. La livraison elle-même
//! (ouvrir une demande de fusion, fusionner) est faite par Claude dans sa
//! session, à partir d'une consigne tapée par l'app (`sessions.sendPrompt`),
//! sous ses demandes de permission habituelles.
//!
//! Le suivi d'une session commence au premier `forge.sessionCi` (l'app
//! l'appelle quand elle affiche la session) et reste en mémoire seulement ;
//! le sondage ne relance `gh` que pour les sessions dont une exécution est
//! en cours, vivantes ou arrêtées depuis moins de [`CI_RECENT`].

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use uuid::Uuid;

use super::super::{Daemon, Event, RpcError, opt_str, session_id_param};
use super::{
    Cached, PULL_CACHE_TTL, bool_param, cache_key, forge_error, pulls::pull_json, root_param,
};
use crate::domain::commits::CommitRange;
use crate::domain::forge::RemoteRepo;
use crate::domain::forge::pulls::{ChecksState, Pull, PullState, normalize_sha, valid_branch};
use crate::domain::forge::runs::{
    CI_FAILURE_INSTRUCTION, DEFAULT_RUNS_LIMIT, DeliveryMode, DeliveryState, MAX_RUNS_LIMIT, Run,
    RunFailure, RunFilter, delivery_state, failure_excerpt, latest_session_commit, summarize_runs,
};
use crate::ports::ForgeError;

/// Intervalle du sondage de la CI des sessions suivies.
pub const CI_POLL_INTERVAL: Duration = Duration::from_secs(60);
/// Une session arrêtée depuis moins longtemps reste sondée (« récente »).
pub const CI_RECENT: Duration = Duration::from_secs(30 * 60);
/// Durée pendant laquelle un commit suivi sans exécution reste sondé
/// (GitHub crée les exécutions quelques secondes après un push).
pub const CI_EXPECT: Duration = Duration::from_secs(10 * 60);
/// Sondages en échec d'affilée avant d'oublier le suivi d'une session.
const CI_MAX_ERRORS: u8 = 5;
/// Sessions suivies au plus (les plus anciennes partent d'abord).
const CI_WATCH_MAX: usize = 256;
/// Commits relus pour trouver ceux de la session (mode trunk-based).
const SESSION_COMMITS: usize = 20;
/// Durée de vie d'un échec d'exécution terminée gardé en mémoire (ses
/// journaux ne changent plus).
pub const FAILURE_CACHE_TTL: Duration = Duration::from_secs(10 * 60);
/// Échecs gardés au plus (jusqu'à 256 Kio chacun).
pub(super) const FAILURE_CACHE_MAX: usize = 8;
/// Plus grand identifiant d'exécution accepté (entier exact en JavaScript).
const MAX_RUN_ID: u64 = (1 << 53) - 1;

/// Suivi de la CI d'une session (mémoire seulement).
#[derive(Debug, Clone)]
pub(in crate::daemon::supervisor) struct CiWatch {
    mode: DeliveryMode,
    delivery: DeliveryState,
    pull: Option<(u64, String)>,
    ci: ChecksState,
    /// Dernière mise à jour du suivi.
    at: Instant,
    /// Commit suivi sans exécution encore créée (juste après un push) :
    /// depuis quand. Sondé pendant [`CI_EXPECT`].
    none_since: Option<Instant>,
    /// Sondages en échec d'affilée (forge indisponible, dossier disparu…).
    errors: u8,
    /// Encore sondée. Faux : session arrêtée depuis plus de [`CI_RECENT`],
    /// ou sondages en échec ; la dernière livraison connue reste montrée
    /// (`Session.delivery`) jusqu'au prochain `forge.sessionCi`.
    polled: bool,
}

/// Ce que `forge.sessionCi` a calculé pour une session.
struct SessionCi {
    mode: DeliveryMode,
    delivery: DeliveryState,
    pull: Option<Pull>,
    base_branch: Option<String>,
    sha: Option<String>,
    runs: Vec<Run>,
    truncated: bool,
}

pub fn run_json(r: &Run) -> Value {
    json!({
        "id": r.id,
        "name": r.name,
        "workflow": r.workflow,
        "status": r.status.as_str(),
        "conclusion": r.conclusion,
        "state": r.state.as_str(),
        "url": r.url,
        "head_sha": r.head_sha,
        "branch": r.branch,
        "event": r.event,
        "created_at": r.created_at,
        "updated_at": r.updated_at,
    })
}

fn failure_json(f: &RunFailure) -> Value {
    let (excerpt, cut) = if f.in_progress {
        (Value::Null, false)
    } else {
        let (e, cut) = failure_excerpt(f);
        (json!(e), cut)
    };
    json!({
        "run": run_json(&f.run),
        "failed_jobs": f.failed_jobs.iter().map(|j| json!({
            "name": j.name,
            "state": j.state.as_str(),
            "conclusion": j.conclusion,
            "url": j.url,
            "failed_steps": j.failed_steps,
        })).collect::<Vec<_>>(),
        "logs": f.logs.iter().map(|l| json!({
            "job": l.name,
            "text": l.text,
            "truncated": l.truncated,
        })).collect::<Vec<_>>(),
        "truncated": f.truncated || cut,
        "in_progress": f.in_progress,
        "instruction": CI_FAILURE_INSTRUCTION,
        "excerpt": excerpt,
    })
}

fn limit_param(params: &Value) -> Result<usize, RpcError> {
    match params.get("limit") {
        None | Some(Value::Null) => Ok(DEFAULT_RUNS_LIMIT),
        Some(v) => v
            .as_u64()
            .filter(|n| (1..=MAX_RUNS_LIMIT as u64).contains(n))
            .map(|n| n as usize)
            .ok_or_else(|| RpcError::params(format!("« limit » : entier de 1 à {MAX_RUNS_LIMIT}"))),
    }
}

/// `branch?`, `sha?`, `limit?` de `forge.runs`.
fn run_filter_param(params: &Value) -> Result<RunFilter, RpcError> {
    let branch = match opt_str(params, "branch")? {
        None => None,
        Some(b) if valid_branch(&b) => Some(b),
        Some(b) => {
            return Err(RpcError::params(format!(
                "« branch » : nom de branche invalide : {}",
                crate::domain::forge::one_line(&b)
            )));
        }
    };
    let sha = match opt_str(params, "sha")? {
        None => None,
        Some(s) => Some(normalize_sha(&s).ok_or_else(|| {
            RpcError::params("« sha » : empreinte de commit complète attendue (40 ou 64 caractères hexadécimaux)")
        })?),
    };
    Ok(RunFilter {
        branch,
        sha,
        limit: limit_param(params)?,
    })
}

fn run_id_param(params: &Value) -> Result<u64, RpcError> {
    params
        .get("run_id")
        .and_then(Value::as_u64)
        .filter(|n| (1..=MAX_RUN_ID).contains(n))
        .ok_or_else(|| RpcError::params("« run_id » : entier positif attendu"))
}

fn mode_param(params: &Value) -> Result<DeliveryMode, RpcError> {
    match opt_str(params, "mode")? {
        None => Ok(DeliveryMode::Pull),
        Some(m) => DeliveryMode::parse(&m).ok_or_else(|| {
            RpcError::params(format!("« mode » inconnu : {m} (attendu : pr, trunk)"))
        }),
    }
}

/// Nom court de la branche de référence (`origin/main` → `main`) ; `HEAD`
/// (aucune référence) : `None`.
fn base_branch_name(reference: &str) -> Option<String> {
    if reference == "HEAD" || reference.is_empty() {
        return None;
    }
    let name = reference
        .strip_prefix("refs/remotes/")
        .or_else(|| reference.strip_prefix("refs/heads/"))
        .unwrap_or(reference);
    let name = match name.split_once('/') {
        Some((remote, rest)) if remote == "origin" || remote == "upstream" => rest,
        _ => name,
    };
    Some(name.to_owned())
}

impl CiWatch {
    fn json(&self) -> Value {
        json!({
            "mode": self.mode.as_str(),
            "state": self.delivery.as_str(),
            "pull": self.pull.as_ref().map(|(n, u)| json!({"number": n, "url": u})),
            "ci": self.ci.as_str(),
        })
    }
}

impl Daemon {
    /// `delivery` d'une session (`Session.delivery`) : `null` tant que
    /// `forge.sessionCi` ne l'a pas calculé. Verrou feuille.
    pub(in crate::daemon::supervisor) fn delivery_json_of(&self, id: &Uuid) -> Value {
        self.ci_watch
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .map_or(Value::Null, CiWatch::json)
    }

    /// `forge.runs {root, branch?, sha?, limit?, enabled?, refresh?}` :
    /// exécutions du dépôt, gardées [`PULL_CACHE_TTL`].
    pub fn forge_runs(&self, params: &Value) -> Result<Value, RpcError> {
        let root = root_param(params)?;
        let refresh = bool_param(params, "refresh", false)?;
        let filter = run_filter_param(params)?;
        let remote = self.forge_remote(&root, params, refresh)?;
        self.runs_value(&root, &remote, &filter, refresh)
    }

    fn runs_value(
        &self,
        root: &Path,
        remote: &RemoteRepo,
        filter: &RunFilter,
        refresh: bool,
    ) -> Result<Value, RpcError> {
        let key = cache_key(&json!([
            "runs",
            remote.slug(),
            filter.branch,
            filter.sha,
            filter.limit
        ]));
        self.forge_cached_for(key, refresh, PULL_CACHE_TTL, || {
            let (runs, truncated) = self.deps.forge.runs(root, remote, filter)?;
            Ok(json!({
                "runs": runs.iter().map(run_json).collect::<Vec<_>>(),
                "truncated": truncated,
            }))
        })
    }

    /// `forge.runFailure {root, run_id, enabled?, refresh?}` : jobs en
    /// échec, journaux de leurs étapes en échec (nettoyés, bornés), consigne
    /// et extrait à coller. Une exécution terminée est gardée
    /// [`FAILURE_CACHE_TTL`] (8 au plus) ; en cours : jamais gardée.
    pub fn forge_run_failure(&self, params: &Value) -> Result<Value, RpcError> {
        let root = root_param(params)?;
        let refresh = bool_param(params, "refresh", false)?;
        let run_id = run_id_param(params)?;
        let remote = self.forge_remote(&root, params, refresh)?;
        let key = cache_key(&json!(["run_failure", remote.slug(), run_id]));
        if !refresh && let Some(v) = self.forge_cache().get_failure(&key, Instant::now()) {
            return Ok(v.as_ref().clone());
        }
        let failure = self
            .deps
            .forge
            .run_failure(&root, &remote, run_id)
            .map_err(|e| self.forge_failed(e))?;
        let value = failure_json(&failure);
        if !failure.in_progress {
            self.forge_cache()
                .put_failure(key, Arc::new(value.clone()), Instant::now());
        }
        Ok(value)
    }

    /// Erreur de la forge ; indisponible : l'état gardé est oublié.
    fn forge_failed(&self, e: ForgeError) -> RpcError {
        if matches!(e, ForgeError::Unavailable(_)) {
            self.forge_cache().forget_status();
        }
        forge_error(e)
    }

    /// Dossier, branche, date de lancement et état d'une session.
    fn ci_session(
        &self,
        id: &Uuid,
    ) -> Result<(PathBuf, Option<String>, time::OffsetDateTime), RpcError> {
        let reg = self.lock();
        let e = reg
            .sessions
            .get(id)
            .ok_or_else(|| RpcError::unknown_session(id))?;
        Ok((
            e.session.cwd.clone(),
            e.session.branch.clone(),
            e.created_at,
        ))
    }

    /// `forge.sessionCi {id, mode?, enabled?, refresh?}` : état de livraison
    /// et CI d'une session, et début (ou mise à jour) de son suivi.
    /// Désactivé : le suivi s'arrête, `-32022`. Bloquant (`git`, `gh`).
    pub fn forge_session_ci(&self, params: &Value) -> Result<Value, RpcError> {
        let id = session_id_param(params)?;
        let mode = mode_param(params)?;
        let refresh = bool_param(params, "refresh", false)?;
        let enabled = bool_param(params, "enabled", true)?;
        if !enabled {
            let removed = self
                .ci_watch
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&id);
            if removed.is_some() {
                let _ = self.events.send(Event::Updated(id));
            }
        }
        let ci = self.session_ci(&id, mode, params, refresh, refresh)?;
        self.note_ci(id, &ci);
        let summary = summarize_runs(&ci.runs);
        Ok(json!({
            "mode": ci.mode.as_str(),
            "delivery": ci.delivery.as_str(),
            "pull": ci.pull.as_ref().map(|p| pull_json(p, false)),
            "base_branch": ci.base_branch,
            "ci": {
                "state": summary.state.as_str(),
                "sha": ci.sha,
                "total": summary.total,
                "passed": summary.passed,
                "failed": summary.failed,
                "pending": summary.pending,
                "runs": ci.runs.iter().map(run_json).collect::<Vec<_>>(),
                "truncated": ci.truncated,
            },
        }))
    }

    /// Calcule la livraison et la CI d'une session. `refresh_status` revérifie
    /// l'accès à la forge, `refresh` relit les demandes et les exécutions.
    fn session_ci(
        &self,
        id: &Uuid,
        mode: DeliveryMode,
        params: &Value,
        refresh_status: bool,
        refresh: bool,
    ) -> Result<SessionCi, RpcError> {
        let (cwd, branch, created_at) = self.ci_session(id)?;
        if !cwd.is_dir() {
            return Err(RpcError::cwd_missing(&cwd));
        }
        let remote = self.forge_remote(&cwd, params, refresh_status)?;
        // Branche de référence et derniers commits (lot 9) ; hors dépôt ou
        // sans commit : rien.
        let range = match mode {
            DeliveryMode::Pull => None,
            DeliveryMode::Trunk => Some(CommitRange::Recent),
        };
        let log = self
            .deps
            .diff
            .commits(&cwd, SESSION_COMMITS, false, range)
            .ok();
        let base_branch = log
            .as_ref()
            .and_then(|l| base_branch_name(&l.base.reference));
        let (pull, sha, delivery) = match mode {
            DeliveryMode::Pull => {
                let own = branch
                    .as_deref()
                    .filter(|b| valid_branch(b) && base_branch.as_deref() != Some(*b));
                let pull = match own {
                    Some(b) => self.last_pull_cached(&cwd, &remote, b, refresh)?,
                    None => None,
                };
                // Une demande fusionnée ne vaut livraison que si la session n'a
                // rien commité depuis (sa tête est celle de la demande) : sinon
                // la suite reste à livrer, et « Ouvrir » reste possible.
                let head = log.as_ref().and_then(|l| l.head.as_deref());
                let pull = pull.filter(|p| {
                    p.state != PullState::Merged || head.is_none_or(|h| h == p.head_sha)
                });
                let sha = pull
                    .as_ref()
                    .filter(|p| p.state != PullState::Closed)
                    .map(|p| p.head_sha.clone());
                let delivery = delivery_state(pull.as_ref().map(|p| p.state), false);
                (pull, sha, delivery)
            }
            DeliveryMode::Trunk => {
                let email = self.deps.diff.user_email(&cwd);
                let mine = log
                    .as_ref()
                    .and_then(|l| latest_session_commit(&l.commits, created_at, email.as_deref()));
                // Tout est poussé (la tête est la branche par défaut **distante**,
                // `origin/…`) et la session a commité : ses commits sont dans la
                // branche par défaut de la forge. Une référence locale (`main`,
                // sans `origin/HEAD`) ne prouve rien.
                let pushed = mine.is_some()
                    && log.as_ref().is_some_and(|l| {
                        l.base.reference.starts_with("origin/")
                            && l.head.as_deref() == Some(l.base.sha.as_str())
                    });
                (
                    None,
                    mine.map(|c| c.sha.clone()),
                    delivery_state(None, pushed),
                )
            }
        };
        let (runs, truncated) = match &sha {
            Some(s) => {
                let filter = RunFilter {
                    branch: None,
                    sha: Some(s.clone()),
                    limit: DEFAULT_RUNS_LIMIT,
                };
                let v = self.runs_value(&cwd, &remote, &filter, refresh)?;
                (
                    runs_from_json(&v["runs"]),
                    v["truncated"].as_bool().unwrap_or(false),
                )
            }
            None => (Vec::new(), false),
        };
        Ok(SessionCi {
            mode,
            delivery,
            pull,
            base_branch,
            sha,
            runs,
            truncated,
        })
    }

    /// Dernière demande de la branche, gardée [`PULL_CACHE_TTL`].
    fn last_pull_cached(
        &self,
        root: &Path,
        remote: &RemoteRepo,
        branch: &str,
        refresh: bool,
    ) -> Result<Option<Pull>, RpcError> {
        let key = cache_key(&json!(["last_pull_for_branch", remote.slug(), branch]));
        if !refresh
            && let Some(c) = self.forge_cache().get(&key, Instant::now())
            && let Cached::Pull(p) = c.as_ref()
        {
            return Ok(p.clone());
        }
        let pull = self
            .deps
            .forge
            .last_pull_for_branch(root, remote, branch)
            .map_err(|e| self.forge_failed(e))?;
        self.forge_cache().put(
            key,
            Cached::Pull(pull.clone()),
            Instant::now(),
            PULL_CACHE_TTL,
        );
        Ok(pull)
    }

    /// Retient le suivi d'une session ; diffuse `session.updated` si sa
    /// livraison ou sa CI a changé, et `forge.ci_changed` si l'état de sa
    /// CI a changé depuis le dernier calcul (pas au premier).
    fn note_ci(&self, id: Uuid, ci: &SessionCi) {
        let state = summarize_runs(&ci.runs).state;
        let mut watch = CiWatch {
            mode: ci.mode,
            delivery: ci.delivery,
            pull: ci.pull.as_ref().map(|p| (p.number, p.url.clone())),
            ci: state,
            at: Instant::now(),
            none_since: None,
            errors: 0,
            polled: true,
        };
        let mut evicted = None;
        let previous = {
            let mut w = self.ci_watch.lock().unwrap_or_else(|e| e.into_inner());
            if state == ChecksState::None && ci.sha.is_some() {
                watch.none_since = Some(w.get(&id).and_then(|p| p.none_since).unwrap_or(watch.at));
            }
            if !w.contains_key(&id) && w.len() >= CI_WATCH_MAX {
                evicted = w.iter().min_by_key(|(_, v)| v.at).map(|(k, _)| *k);
                if let Some(k) = evicted {
                    w.remove(&k);
                }
            }
            w.insert(id, watch.clone())
        };
        // Livraison oubliée (plafond) : les clients l'apprennent.
        if let Some(k) = evicted {
            let _ = self.events.send(Event::Updated(k));
        }
        let changed = previous.as_ref().is_none_or(|p| {
            p.ci != watch.ci || p.delivery != watch.delivery || p.pull != watch.pull
        });
        if changed {
            let _ = self.events.send(Event::Updated(id));
        }
        if let Some(p) = previous
            && p.ci != state
        {
            super::super::info!("session {id} : CI {} → {}", p.ci.as_str(), state.as_str());
            let _ = self.events.send(Event::CiChanged {
                id,
                state: state.as_str(),
            });
        }
    }

    /// Sessions à sonder : CI en cours (ou tête sans exécution depuis moins
    /// de [`CI_EXPECT`]), session vivante ou arrêtée depuis moins de
    /// [`CI_RECENT`]. Une session plus ancienne n'est plus sondée mais garde
    /// sa dernière livraison connue ; le suivi d'une session retirée est oublié.
    fn ci_poll_targets(&self) -> Vec<(Uuid, DeliveryMode)> {
        let watched: Vec<(Uuid, DeliveryMode, bool)> = self
            .ci_watch
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter(|(_, w)| w.polled)
            .map(|(id, w)| {
                let expected = w.none_since.is_some_and(|t| t.elapsed() < CI_EXPECT);
                (*id, w.mode, w.ci == ChecksState::Pending || expected)
            })
            .collect();
        let now = time::OffsetDateTime::now_utc();
        let mut targets = Vec::new();
        let mut gone = Vec::new();
        let mut stale = Vec::new();
        {
            let reg = self.lock();
            for (id, mode, due) in watched {
                let Some(e) = reg.sessions.get(&id) else {
                    gone.push(id);
                    continue;
                };
                let recent = e.run.is_some() || (now - e.updated_at).unsigned_abs() < CI_RECENT;
                if !recent {
                    stale.push(id);
                } else if due {
                    targets.push((id, mode));
                }
            }
        }
        if !gone.is_empty() || !stale.is_empty() {
            let mut w = self.ci_watch.lock().unwrap_or_else(|e| e.into_inner());
            for id in gone {
                w.remove(&id);
            }
            for id in stale {
                if let Some(watch) = w.get_mut(&id) {
                    watch.polled = false;
                }
            }
        }
        targets
    }

    /// Accès aux forges autorisé (dernier `enabled` reçu, `forge.configure`).
    pub(in crate::daemon::supervisor) fn forge_allowed(&self) -> bool {
        self.forge_enabled
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Retient l'accès aux forges ; coupé : le suivi de la CI est vidé (et
    /// chaque session concernée renvoyée, `delivery: null`).
    pub(in crate::daemon::supervisor) fn note_forge_enabled(&self, enabled: bool) {
        self.forge_enabled
            .store(enabled, std::sync::atomic::Ordering::Relaxed);
        if enabled {
            return;
        }
        let ids: Vec<Uuid> = {
            let mut w = self.ci_watch.lock().unwrap_or_else(|e| e.into_inner());
            w.drain().map(|(id, _)| id).collect()
        };
        for id in ids {
            let _ = self.events.send(Event::Updated(id));
        }
    }

    /// `forge.configure {enabled}` (processus principal de l'app, au
    /// changement du réglage « Accès aux forges » et à la connexion) → `{}`.
    pub fn forge_configure(&self, params: &Value) -> Result<Value, RpcError> {
        let enabled = match params.get("enabled") {
            Some(Value::Bool(b)) => *b,
            _ => return Err(RpcError::params("« enabled » : booléen attendu")),
        };
        self.note_forge_enabled(enabled);
        Ok(json!({}))
    }

    /// Une passe du sondage (bloquant) : relit la CI de chaque session à
    /// sonder (demandes et exécutions sans cache, accès à la forge gardé).
    /// Accès aux forges coupé : rien n'est lancé, le suivi est vidé. Une
    /// erreur (forge indisponible…) laisse le suivi tel quel, journalisée
    /// une fois ; après [`CI_MAX_ERRORS`] échecs d'affilée, la session n'est
    /// plus sondée (sa dernière livraison connue reste).
    pub fn poll_ci_once(&self) {
        if !self.forge_allowed() {
            self.note_forge_enabled(false);
            return;
        }
        for (id, mode) in self.ci_poll_targets() {
            if !self.forge_allowed() {
                return;
            }
            match self.session_ci(&id, mode, &json!({}), false, true) {
                Ok(ci) => self.note_ci(id, &ci),
                Err(e) => {
                    let (first, stopped) = {
                        let mut w = self.ci_watch.lock().unwrap_or_else(|e| e.into_inner());
                        match w.get_mut(&id) {
                            Some(watch) => {
                                watch.errors = watch.errors.saturating_add(1);
                                let n = watch.errors;
                                if n >= CI_MAX_ERRORS {
                                    watch.polled = false;
                                }
                                (n == 1, n == CI_MAX_ERRORS)
                            }
                            None => (false, false),
                        }
                    };
                    if first {
                        super::super::warning!("session {id} : CI non relue : {}", e.message);
                    }
                    if stopped {
                        super::super::warning!(
                            "session {id} : sondage de la CI arrêté après {CI_MAX_ERRORS} échecs"
                        );
                    }
                }
            }
        }
    }

    /// Sondage de la CI toutes les [`Config::ci_poll_interval`] (60 s).
    ///
    /// [`Config::ci_poll_interval`]: super::super::Config::ci_poll_interval
    pub fn start_ci_polling(self: &Arc<Self>) {
        let daemon = Arc::clone(self);
        self.runtime.spawn(async move {
            loop {
                tokio::time::sleep(daemon.config.ci_poll_interval).await;
                let d = daemon.clone();
                let _ = tokio::task::spawn_blocking(move || d.poll_ci_once()).await;
            }
        });
    }
}

/// Exécutions relues d'un JSON gardé (`forge.runs`).
fn runs_from_json(v: &Value) -> Vec<Run> {
    use crate::domain::forge::pulls::CheckState;
    use crate::domain::forge::runs::RunStatus;
    let state = |s: &str| match s {
        "success" => Some(CheckState::Success),
        "failure" => Some(CheckState::Failure),
        "pending" => Some(CheckState::Pending),
        "skipped" => Some(CheckState::Skipped),
        "cancelled" => Some(CheckState::Cancelled),
        _ => None,
    };
    let text = |v: &Value| v.as_str().map(str::to_owned);
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|r| {
                    Some(Run {
                        id: r["id"].as_u64()?,
                        name: r["name"].as_str()?.to_owned(),
                        workflow: text(&r["workflow"]),
                        status: RunStatus::parse(r["status"].as_str()?)?,
                        conclusion: text(&r["conclusion"]),
                        state: state(r["state"].as_str()?)?,
                        url: text(&r["url"]),
                        head_sha: r["head_sha"].as_str()?.to_owned(),
                        branch: text(&r["branch"]),
                        event: text(&r["event"]),
                        created_at: text(&r["created_at"]),
                        updated_at: text(&r["updated_at"]),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::error_code;

    #[test]
    fn run_filters_are_validated() {
        let f = run_filter_param(&json!({})).unwrap();
        assert_eq!(f, RunFilter::default());
        let sha = "A".repeat(40);
        let f = run_filter_param(&json!({"branch": "main", "sha": sha, "limit": 100})).unwrap();
        assert_eq!(f.branch.as_deref(), Some("main"));
        assert_eq!(f.sha, Some("a".repeat(40)));
        assert_eq!(f.limit, 100);
        for bad in [
            json!({"branch": "--web"}),
            json!({"branch": "a b"}),
            json!({"sha": "abc"}),
            json!({"sha": "g".repeat(40)}),
            json!({"limit": 0}),
            json!({"limit": 101}),
        ] {
            assert_eq!(
                run_filter_param(&bad).unwrap_err().code,
                error_code::INVALID_PARAMS,
                "{bad}"
            );
        }
        assert_eq!(
            run_id_param(&json!({"run_id": 39574909280u64})).unwrap(),
            39574909280
        );
        for bad in [
            json!({}),
            json!({"run_id": 0}),
            json!({"run_id": "1"}),
            json!({"run_id": -3}),
            json!({"run_id": 1u64 << 60}),
        ] {
            assert!(run_id_param(&bad).is_err(), "{bad}");
        }
        assert_eq!(mode_param(&json!({})).unwrap(), DeliveryMode::Pull);
        assert_eq!(
            mode_param(&json!({"mode": "trunk"})).unwrap(),
            DeliveryMode::Trunk
        );
        assert!(mode_param(&json!({"mode": "merge"})).is_err());
    }

    #[test]
    fn base_branch_names() {
        assert_eq!(base_branch_name("origin/main").as_deref(), Some("main"));
        assert_eq!(base_branch_name("main").as_deref(), Some("main"));
        assert_eq!(
            base_branch_name("refs/remotes/origin/trunk").as_deref(),
            Some("trunk")
        );
        assert_eq!(
            base_branch_name("origin/release/2.0").as_deref(),
            Some("release/2.0")
        );
        assert_eq!(base_branch_name("HEAD"), None);
    }

    #[test]
    fn cached_runs_are_read_back() {
        let r = Run {
            id: 7,
            name: "Tests".into(),
            workflow: Some("Tests".into()),
            status: crate::domain::forge::runs::RunStatus::InProgress,
            conclusion: None,
            state: crate::domain::forge::pulls::CheckState::Pending,
            url: None,
            head_sha: "a".repeat(40),
            branch: None,
            event: Some("push".into()),
            created_at: Some("2026-10-21T10:00:00Z".into()),
            updated_at: None,
        };
        assert_eq!(runs_from_json(&json!([run_json(&r)])), vec![r]);
    }
}
