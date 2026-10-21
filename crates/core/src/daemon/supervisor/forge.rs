//! Forge (v0.3, lot 13a, ADR 0006) : `forge.status`, `forge.issues`,
//! `forge.issue`, et le lien session ↔ issue de `sessions.launch` ;
//! demandes de fusion, CI et revue (lot 13b) : [`pulls`].
//!
//! Les appels à la forge passent par le port [`crate::ports::Forge`], hors
//! du runtime et jamais sous le verrou du registre. Les réponses sont
//! gardées en mémoire 60 s (30 s pour les demandes de fusion) par dépôt et par requête (rafraîchissement forcé
//! par `refresh: true`) ; rien n'est écrit en base ni au journal.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use super::{Daemon, RpcError, opt_str};
use crate::domain::forge::{
    Capabilities, ForgeStatus, Issue, IssueFilter, IssueRef, MAX_ISSUES_LIMIT, MAX_LABEL_CHARS,
    MAX_SEARCH_CHARS, RemoteRepo, SessionIssue, StateFilter,
};
use crate::ports::ForgeError;
use crate::protocol::error_code;

pub mod pulls;

/// Consigne tapée d'un prompt initial, en caractères au plus.
pub const MAX_INITIAL_INSTRUCTION_CHARS: usize = 2000;
/// Délai au-delà duquel un prompt initial qui n'a pas pu partir (TUI pas
/// prête, demande restée ouverte) est abandonné.
pub const INITIAL_PROMPT_TIMEOUT: Duration = Duration::from_secs(60);

/// Prompt initial de `sessions.launch` (`initial`), en deux temps (règle de
/// l'architecture § 9) : la consigne est **tapée** (elle a l'autorité d'un
/// prompt de l'utilisateur), le contenu (corps d'une issue, non fiable) est
/// **collé** en *bracketed paste* : Claude Code l'encadre comme un contenu
/// venu d'ailleurs. Puis Entrée.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InitialPrompt {
    /// Une ligne, sans caractère de contrôle ni invisible.
    pub instruction: String,
    /// Texte nettoyé ([`crate::domain::forge::clean_text`]), peut être vide.
    pub pasted: String,
}

/// La session est-elle prête à recevoir le prompt initial ?
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InitialReadiness {
    /// Inactive (`SessionStart` reçu, ou `idle_prompt`), aucune demande ouverte.
    Ready,
    /// Pas encore (démarrage, tour en cours, demande ouverte).
    Wait,
    /// Arrêtée, ou relancée par un autre processus.
    Gone,
}

/// `initial: {instruction, pasted}` de `sessions.launch` : consigne ramenée
/// à une ligne (contrôles et invisibles retirés), non vide,
/// [`MAX_INITIAL_INSTRUCTION_CHARS`] au plus ; `pasted` nettoyé (fins de
/// ligne, contrôles sauf `\n` et `\t`, invisibles), blancs de bord retirés,
/// [`super::MAX_PROMPT_BYTES`] au plus.
pub(super) fn initial_param(params: &Value) -> Result<Option<InitialPrompt>, RpcError> {
    let bad = || RpcError::params("« initial » doit être un objet {instruction, pasted}");
    let o = match params.get("initial") {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::Object(o)) => o,
        Some(_) => return Err(bad()),
    };
    let instruction = o
        .get("instruction")
        .and_then(Value::as_str)
        .ok_or_else(bad)?;
    let pasted = match o.get("pasted") {
        None | Some(Value::Null) => "",
        Some(Value::String(s)) => s.as_str(),
        Some(_) => return Err(bad()),
    };
    let instruction = crate::domain::forge::one_line(instruction);
    if instruction.is_empty() {
        return Err(RpcError::params("« initial.instruction » vide"));
    }
    let n = instruction.chars().count();
    if n > MAX_INITIAL_INSTRUCTION_CHARS {
        return Err(RpcError::params(format!(
            "« initial.instruction » : {n} caractères, {MAX_INITIAL_INSTRUCTION_CHARS} au plus"
        )));
    }
    let pasted = crate::domain::forge::clean_text(pasted).trim().to_owned();
    if pasted.len() > super::MAX_PROMPT_BYTES {
        return Err(RpcError::params(format!(
            "« initial.pasted » trop long : {} octets, {} au plus",
            pasted.len(),
            super::MAX_PROMPT_BYTES
        )));
    }
    Ok(Some(InitialPrompt {
        instruction,
        pasted,
    }))
}

/// Durée de vie d'une réponse de la forge gardée en mémoire (état, issues).
pub const FORGE_CACHE_TTL: Duration = Duration::from_secs(60);
/// Durée de vie des états des demandes de fusion et de leur CI (lot 13b).
pub const PULL_CACHE_TTL: Duration = Duration::from_secs(30);
/// Durée de vie du diff d'une demande de fusion, gardé par tête (`head.sha`) :
/// un diff ne change pas tant que la tête ne bouge pas.
pub const PULL_DIFF_TTL: Duration = Duration::from_secs(10 * 60);
/// Réponses gardées au plus (les plus anciennes partent d'abord).
const FORGE_CACHE_MAX: usize = 128;
/// Diffs de demandes de fusion gardés au plus (jusqu'à 8 Mio chacun).
const PULL_DIFF_CACHE_MAX: usize = 8;
/// Raison quand l'accès aux forges est désactivé dans les réglages de l'app.
pub const DISABLED_REASON: &str = "désactivé dans les réglages";

/// Diff d'une demande de fusion, par fichier (nouveau chemin).
pub(super) type PullDiff = std::collections::HashMap<String, crate::domain::diff::FileDiff>;

/// Réponses récentes de la forge, par clé (tableaux JSON `["status", …]`,
/// `["issues", …]`, `["issue", …]`, `["pulls", …]`, `["pull", …]`,
/// `["pull_for_branch", …]`), chacune avec sa durée de vie ; diffs des
/// demandes de fusion à part (`["pull_diff", dépôt, numéro, tête]`).
#[derive(Debug, Default)]
pub(super) struct ForgeCache {
    entries: std::collections::HashMap<String, (Instant, Duration, Arc<Cached>)>,
    diffs: std::collections::HashMap<String, (Instant, Arc<PullDiff>)>,
}

#[derive(Debug)]
pub(super) enum Cached {
    Status(ForgeStatus),
    Json(Value),
}

impl ForgeCache {
    fn get(&mut self, key: &str, now: Instant) -> Option<Arc<Cached>> {
        match self.entries.get(key) {
            Some((at, ttl, v)) if now.duration_since(*at) < *ttl => Some(v.clone()),
            Some(_) => {
                self.entries.remove(key);
                None
            }
            None => None,
        }
    }

    fn put(&mut self, key: String, value: Cached, now: Instant, ttl: Duration) -> Arc<Cached> {
        self.entries
            .retain(|_, (at, ttl, _)| now.duration_since(*at) < *ttl);
        while self.entries.len() >= FORGE_CACHE_MAX {
            let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, (at, _, _))| *at)
                .map(|(k, _)| k.clone())
            else {
                break;
            };
            self.entries.remove(&oldest);
        }
        let value = Arc::new(value);
        self.entries.insert(key, (now, ttl, value.clone()));
        value
    }

    fn get_diff(&mut self, key: &str, now: Instant) -> Option<Arc<PullDiff>> {
        match self.diffs.get(key) {
            Some((at, d)) if now.duration_since(*at) < PULL_DIFF_TTL => Some(d.clone()),
            Some(_) => {
                self.diffs.remove(key);
                None
            }
            None => None,
        }
    }

    fn put_diff(&mut self, key: String, diff: Arc<PullDiff>, now: Instant) {
        self.diffs
            .retain(|_, (at, _)| now.duration_since(*at) < PULL_DIFF_TTL);
        while self.diffs.len() >= PULL_DIFF_CACHE_MAX {
            let Some(oldest) = self
                .diffs
                .iter()
                .min_by_key(|(_, (at, _))| *at)
                .map(|(k, _)| k.clone())
            else {
                break;
            };
            self.diffs.remove(&oldest);
        }
        self.diffs.insert(key, (now, diff));
    }

    /// Oublie les réponses sur les demandes de fusion d'un dépôt (après une
    /// revue publiée : décision de revue, fils).
    fn forget_pulls(&mut self, slug: &str) {
        self.entries.retain(|k, _| {
            serde_json::from_str::<Value>(k).map_or(true, |v| {
                !(matches!(v[0].as_str(), Some("pulls" | "pull" | "pull_for_branch"))
                    && v[1] == slug)
            })
        });
    }
}

/// Premier élément de la clé d'un état gardé (`forge.status`).
const STATUS_KEY: &str = "status";

/// Clé de cache non ambiguë : la requête encodée en JSON (un `|` ou un
/// texte vide dans une recherche ne peut pas imiter une autre requête).
fn cache_key(parts: &Value) -> String {
    parts.to_string()
}

fn is_status_key(key: &str) -> bool {
    serde_json::from_str::<Value>(key).is_ok_and(|v| v[0] == STATUS_KEY)
}

fn bool_param(params: &Value, key: &str, default: bool) -> Result<bool, RpcError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(default),
        Some(Value::Bool(b)) => Ok(*b),
        Some(_) => Err(RpcError::params(format!("« {key} » doit être un booléen"))),
    }
}

/// `root` : chemin absolu d'un dossier existant (résolu).
fn root_param(params: &Value) -> Result<PathBuf, RpcError> {
    let root = opt_str(params, "root")?.ok_or_else(|| RpcError::params("« root » manquant"))?;
    if !Path::new(&root).is_absolute() {
        return Err(RpcError::params(format!(
            "« root » doit être absolu : {root}"
        )));
    }
    let path = Path::new(&root)
        .canonicalize()
        .map_err(|e| RpcError::params(format!("dossier introuvable : {root} ({e})")))?;
    if !path.is_dir() {
        return Err(RpcError::params(format!("pas un dossier : {root}")));
    }
    Ok(path)
}

/// Texte facultatif : blancs de bord retirés, vide = absent, sans caractère
/// de contrôle, `max` caractères au plus.
fn text_param(params: &Value, key: &str, max: usize) -> Result<Option<String>, RpcError> {
    let Some(s) = opt_str(params, key)? else {
        return Ok(None);
    };
    let s = s.trim();
    if s.is_empty() {
        return Ok(None);
    }
    if s.chars().any(char::is_control) {
        return Err(RpcError::params(format!(
            "« {key} » : caractère de contrôle refusé"
        )));
    }
    if s.chars().count() > max {
        return Err(RpcError::params(format!(
            "« {key} » : {max} caractères au plus"
        )));
    }
    Ok(Some(s.to_owned()))
}

fn filter_param(params: &Value) -> Result<IssueFilter, RpcError> {
    let state = match opt_str(params, "state")? {
        None => StateFilter::Open,
        Some(s) => StateFilter::parse(&s).ok_or_else(|| {
            RpcError::params(format!(
                "« state » inconnu : {s} (attendu : open, closed, all)"
            ))
        })?,
    };
    let assigned_to_me = match opt_str(params, "assignee")? {
        None => false,
        Some(a) if a == "@me" => true,
        Some(a) => {
            return Err(RpcError::params(format!(
                "« assignee » : seul « @me » est accepté (reçu : {a})"
            )));
        }
    };
    let limit = match params.get("limit") {
        None | Some(Value::Null) => crate::domain::forge::DEFAULT_ISSUES_LIMIT,
        Some(v) => v
            .as_u64()
            .filter(|n| (1..=MAX_ISSUES_LIMIT as u64).contains(n))
            .map(|n| n as usize)
            .ok_or_else(|| {
                RpcError::params(format!("« limit » : entier de 1 à {MAX_ISSUES_LIMIT}"))
            })?,
    };
    Ok(IssueFilter {
        state,
        search: text_param(params, "search", MAX_SEARCH_CHARS)?,
        assigned_to_me,
        label: text_param(params, "label", MAX_LABEL_CHARS)?,
        limit,
    })
}

/// `issue: {number, title, url}` de `sessions.launch`, validé ([`SessionIssue::new`]).
pub(super) fn issue_param(params: &Value) -> Result<Option<SessionIssue>, RpcError> {
    let bad = || RpcError::params("« issue » doit être un objet {number, title, url}");
    match params.get("issue") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Object(o)) => {
            let number = o.get("number").and_then(Value::as_u64).ok_or_else(bad)?;
            let title = o.get("title").and_then(Value::as_str).ok_or_else(bad)?;
            let url = o.get("url").and_then(Value::as_str).ok_or_else(bad)?;
            SessionIssue::new(number, title, url)
                .map(Some)
                .map_err(|e| RpcError::params(format!("« issue » : {}", e.0)))
        }
        Some(_) => Err(bad()),
    }
}

fn capabilities_json(c: &Capabilities) -> Value {
    json!({
        "sub_issues": c.sub_issues,
        "epics": c.epics,
        "review_comments": c.review_comments,
        "checks": c.checks,
        // `sessions.launch` accepte `initial` (prompt initial en deux temps).
        "initial_prompt": true,
    })
}

fn status_json(s: &ForgeStatus, caps: &Capabilities) -> Value {
    json!({
        "available": s.available,
        "kind": s.kind.map(|k| k.as_str()),
        "host": s.remote.as_ref().map(|r| r.host.clone()),
        "repo": s.remote.as_ref().map(RemoteRepo::full_name),
        "reason": s.reason,
        "capabilities": if s.kind.is_some() { capabilities_json(caps) } else { Value::Null },
    })
}

fn issue_ref_json(r: &IssueRef) -> Value {
    json!({"number": r.number, "title": r.title, "state": r.state.as_str(), "url": r.url})
}

/// Issue au format du protocole ; `full` : avec le corps (`body`, `truncated`).
pub fn issue_json(i: &Issue, full: bool) -> Value {
    let mut v = json!({
        "number": i.number,
        "title": i.title,
        "state": i.state.as_str(),
        "url": i.url,
        "author": i.author,
        "labels": i.labels.iter()
            .map(|l| json!({"name": l.name, "color": l.color}))
            .collect::<Vec<_>>(),
        "assignees": i.assignees,
        "updated_at": i.updated_at,
        "parent": i.parent,
        "sub_issues": i.sub_issues.iter().map(issue_ref_json).collect::<Vec<_>>(),
        "sub_issues_summary": i.sub_issues_summary
            .map(|s| json!({"total": s.total, "completed": s.completed})),
    });
    if full {
        v["body"] = json!(i.body.as_deref().unwrap_or(""));
        v["truncated"] = json!(i.body_truncated);
    }
    v
}

fn forge_error(e: ForgeError) -> RpcError {
    match e {
        ForgeError::Unavailable(reason) => unavailable(&reason),
        ForgeError::NotFound(m) => RpcError::params(m),
        ForgeError::Failed(m) => RpcError::new(error_code::INTERNAL_ERROR, m),
    }
}

fn unavailable(reason: &str) -> RpcError {
    RpcError::new(
        error_code::FORGE_UNAVAILABLE,
        format!("forge indisponible : {reason}"),
    )
    .with_data(json!({"reason": reason}))
}

impl Daemon {
    /// Prête à recevoir le prompt initial ? (Même processus qu'au lancement.)
    pub fn initial_readiness(
        &self,
        id: &uuid::Uuid,
        input: &tokio::sync::mpsc::Sender<Vec<u8>>,
    ) -> InitialReadiness {
        let reg = self.lock();
        let Some(e) = reg.sessions.get(id) else {
            return InitialReadiness::Gone;
        };
        match &e.run {
            Some(run) if run.input.same_channel(input) => {}
            _ => return InitialReadiness::Gone,
        }
        if e.session.state.status() == crate::domain::SessionStatus::Idle
            && e.session.state.pending().is_empty()
        {
            InitialReadiness::Ready
        } else {
            InitialReadiness::Wait
        }
    }

    /// Délai du prompt initial.
    pub fn initial_prompt_timeout(&self) -> Duration {
        self.config.initial_prompt_timeout
    }

    /// Fin de l'envoi du prompt initial : effet `initial_prompt_sent`, ou
    /// `initial_prompt_failed {reason}` (journalisé, sans le contenu).
    pub fn initial_prompt_done(&self, id: uuid::Uuid, result: Result<(), String>) {
        let effect = match result {
            Ok(()) => {
                super::info!("session {id} : prompt initial envoyé");
                json!({"type": "initial_prompt_sent"})
            }
            Err(reason) => {
                super::warning!("session {id} : {reason}");
                json!({"type": "initial_prompt_failed", "reason": reason})
            }
        };
        let _ = self.events.send(super::Event::Effect {
            id,
            effect: Arc::new(effect),
        });
    }

    fn forge_cache(&self) -> std::sync::MutexGuard<'_, ForgeCache> {
        self.forge_cache.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// État de la forge de `root` (gardé 60 s, sauf `refresh`). Désactivé :
    /// rien n'est lancé, ni `git` ni `gh`.
    fn forge_state(&self, root: &Path, enabled: bool, refresh: bool) -> ForgeStatus {
        if !enabled {
            return ForgeStatus::unavailable(None, None, DISABLED_REASON);
        }
        let key = cache_key(&json!([STATUS_KEY, root.to_string_lossy()]));
        if !refresh
            && let Some(c) = self.forge_cache().get(&key, Instant::now())
            && let Cached::Status(s) = c.as_ref()
        {
            return s.clone();
        }
        // Hors du verrou du cache : `git` et `gh` peuvent prendre du temps.
        let status = self.deps.forge.status(root);
        self.forge_cache().put(
            key,
            Cached::Status(status.clone()),
            Instant::now(),
            FORGE_CACHE_TTL,
        );
        status
    }

    /// Dépôt de la forge de `root`, ou `-32022`.
    fn forge_remote(
        &self,
        root: &Path,
        params: &Value,
        refresh: bool,
    ) -> Result<RemoteRepo, RpcError> {
        let enabled = bool_param(params, "enabled", true)?;
        let status = self.forge_state(root, enabled, refresh);
        match (status.available, status.remote) {
            (true, Some(remote)) => Ok(remote),
            _ => Err(unavailable(
                status.reason.as_deref().unwrap_or("forge non reconnue"),
            )),
        }
    }

    /// Réponse gardée en cache sous `key`, sinon calculée par `fetch`
    /// (une erreur n'est pas gardée).
    fn forge_cached(
        &self,
        key: String,
        refresh: bool,
        fetch: impl FnOnce() -> Result<Value, ForgeError>,
    ) -> Result<Value, RpcError> {
        self.forge_cached_for(key, refresh, FORGE_CACHE_TTL, fetch)
    }

    /// [`Daemon::forge_cached`] avec une durée de vie donnée.
    fn forge_cached_for(
        &self,
        key: String,
        refresh: bool,
        ttl: Duration,
        fetch: impl FnOnce() -> Result<Value, ForgeError>,
    ) -> Result<Value, RpcError> {
        if !refresh
            && let Some(c) = self.forge_cache().get(&key, Instant::now())
            && let Cached::Json(v) = c.as_ref()
        {
            return Ok(v.clone());
        }
        let value = fetch().map_err(|e| {
            // Forge devenue indisponible (déconnexion…) : l'état gardé est oublié.
            if matches!(e, ForgeError::Unavailable(_)) {
                self.forge_cache().entries.retain(|k, _| !is_status_key(k));
            }
            forge_error(e)
        })?;
        self.forge_cache()
            .put(key, Cached::Json(value.clone()), Instant::now(), ttl);
        Ok(value)
    }

    /// `forge.status {root, enabled?, refresh?}`.
    pub fn forge_status(&self, params: &Value) -> Result<Value, RpcError> {
        let root = root_param(params)?;
        let enabled = bool_param(params, "enabled", true)?;
        let refresh = bool_param(params, "refresh", false)?;
        let status = self.forge_state(&root, enabled, refresh);
        Ok(status_json(&status, &self.deps.forge.capabilities()))
    }

    /// `forge.issues {root, enabled?, refresh?, state?, search?, assignee?, label?, limit?}`.
    pub fn forge_issues(&self, params: &Value) -> Result<Value, RpcError> {
        let root = root_param(params)?;
        let refresh = bool_param(params, "refresh", false)?;
        let filter = filter_param(params)?;
        let remote = self.forge_remote(&root, params, refresh)?;
        let key = cache_key(&json!([
            "issues",
            remote.slug(),
            filter.state.as_str(),
            filter.search,
            filter.assigned_to_me,
            filter.label,
            filter.limit,
        ]));
        self.forge_cached(key, refresh, || {
            let (issues, truncated) = self.deps.forge.issues(&root, &remote, &filter)?;
            Ok(json!({
                "issues": issues.iter().map(|i| issue_json(i, false)).collect::<Vec<_>>(),
                "truncated": truncated,
            }))
        })
    }

    /// `forge.issue {root, number, enabled?, refresh?}`.
    pub fn forge_issue(&self, params: &Value) -> Result<Value, RpcError> {
        let root = root_param(params)?;
        let refresh = bool_param(params, "refresh", false)?;
        let number = params
            .get("number")
            .and_then(Value::as_u64)
            .filter(|n| (1..=i32::MAX as u64).contains(n))
            .ok_or_else(|| RpcError::params("« number » : entier positif attendu"))?;
        let remote = self.forge_remote(&root, params, refresh)?;
        let key = cache_key(&json!(["issue", remote.slug(), number]));
        self.forge_cached(key, refresh, || {
            let issue = self.deps.forge.issue(&root, &remote, number)?;
            Ok(issue_json(&issue, true))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_expires_and_is_bounded() {
        let mut c = ForgeCache::default();
        let t0 = Instant::now();
        c.put("a".into(), Cached::Json(json!(1)), t0, FORGE_CACHE_TTL);
        assert!(c.get("a", t0 + Duration::from_secs(59)).is_some());
        assert!(c.get("a", t0 + FORGE_CACHE_TTL).is_none());
        assert!(c.entries.is_empty());
        for i in 0..(FORGE_CACHE_MAX + 10) {
            c.put(
                format!("k{i}"),
                Cached::Json(json!(i)),
                t0 + Duration::from_millis(i as u64),
                FORGE_CACHE_TTL,
            );
        }
        assert_eq!(c.entries.len(), FORGE_CACHE_MAX);
        assert!(c.get("k0", t0).is_none(), "le plus ancien est parti");
        assert!(c.get(&format!("k{}", FORGE_CACHE_MAX + 9), t0).is_some());
    }

    #[test]
    fn cache_keys_are_unambiguous() {
        let a = cache_key(&json!(["issues", "h/o/r", "open", "a|b", false, null, 50]));
        let b = cache_key(&json!(["issues", "h/o/r", "open", "a", false, "b", 50]));
        let c = cache_key(&json!(["issues", "h/o/r", "open", null, false, null, 50]));
        let d = cache_key(&json!(["issues", "h/o/r", "open", "", false, null, 50]));
        assert_ne!(a, b);
        assert_ne!(c, d);
        assert!(is_status_key(&cache_key(&json!([STATUS_KEY, "/p"]))));
        assert!(!is_status_key(&a));
    }

    #[test]
    fn filters_are_validated() {
        let f = filter_param(&json!({})).unwrap();
        assert_eq!(f, IssueFilter::default());
        let f = filter_param(&json!({
            "state": "all", "search": "  relais  ", "assignee": "@me", "label": "bug", "limit": 200
        }))
        .unwrap();
        assert_eq!(f.state, StateFilter::All);
        assert_eq!(f.search.as_deref(), Some("relais"));
        assert!(f.assigned_to_me);
        assert_eq!(f.label.as_deref(), Some("bug"));
        assert_eq!(f.limit, 200);
        let f = filter_param(&json!({"search": " ", "assignee": null, "label": ""})).unwrap();
        assert_eq!((f.search, f.assigned_to_me, f.label), (None, false, None));
        for bad in [
            json!({"state": "merged"}),
            json!({"assignee": "octocat"}),
            json!({"limit": 0}),
            json!({"limit": 201}),
            json!({"limit": "10"}),
            json!({"search": "a\nb"}),
            json!({"search": "x".repeat(MAX_SEARCH_CHARS + 1)}),
            json!({"label": 3}),
        ] {
            let e = filter_param(&bad).unwrap_err();
            assert_eq!(e.code, error_code::INVALID_PARAMS, "{bad}");
        }
    }

    #[test]
    fn issue_params() {
        assert_eq!(issue_param(&json!({})).unwrap(), None);
        assert_eq!(issue_param(&json!({"issue": null})).unwrap(), None);
        let i = issue_param(&json!({"issue": {
            "number": 42, "title": "Titre", "url": "https://github.com/o/r/issues/42"
        }}))
        .unwrap()
        .unwrap();
        assert_eq!(i.number, 42);
        for bad in [
            json!({"issue": 42}),
            json!({"issue": {"number": 42, "title": "t"}}),
            json!({"issue": {"number": -1, "title": "t", "url": "https://x/1"}}),
            json!({"issue": {"number": 1, "title": "t", "url": "file:///etc/passwd"}}),
        ] {
            assert_eq!(
                issue_param(&bad).unwrap_err().code,
                error_code::INVALID_PARAMS,
                "{bad}"
            );
        }
    }

    #[test]
    fn unavailable_errors_carry_the_reason() {
        let e = forge_error(ForgeError::Unavailable("gh absent".into()));
        assert_eq!(e.code, error_code::FORGE_UNAVAILABLE);
        assert_eq!(e.data, Some(json!({"reason": "gh absent"})));
        assert_eq!(
            forge_error(ForgeError::NotFound("x".into())).code,
            error_code::INVALID_PARAMS
        );
        assert_eq!(
            forge_error(ForgeError::Failed("x".into())).code,
            error_code::INTERNAL_ERROR
        );
    }
}
