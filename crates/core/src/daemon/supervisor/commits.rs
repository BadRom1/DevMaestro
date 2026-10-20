//! Historique des commits d'une session (v0.3, lot 9) côté démon :
//! `sessions.commits`, `sessions.commitDiff`, `sessions.commitDiffFile`, et
//! la validation des commentaires de commit de `sessions.sendReview`.
//!
//! Un sha n'est jamais passé à `git` s'il n'est pas un commit de
//! l'historique courant de la session (la dernière liste calculée si elle a
//! moins de [`DIFF_REUSE`], sinon une liste recalculée, sans compteurs, de
//! [`MAX_COMMITS`] commits au plus) : aucun objet arbitraire n'est lu. Un
//! chemin doit faire partie des fichiers de ce commit.

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use uuid::Uuid;

use super::{
    DIFF_REUSE, Daemon, RpcError, changeset_json, diff_error, file_diff_json, opt_str,
    session_id_param,
};
use crate::domain::commits::{
    Commit, CommitLog, CommitRange, DEFAULT_COMMITS, MAX_COMMITS, is_object_id, short_sha,
};
use crate::domain::diff::ChangeSet;

/// Fichiers de commits gardés au plus par session (un commit ne change
/// jamais : le cache n'expire pas, il est seulement borné).
const COMMIT_CHANGES_KEPT: usize = 16;

/// Après un `git log --numstat` trop lent, durée pendant laquelle
/// `sessions.commits` liste la session sans compteurs (sans retenter le
/// calcul coûteux à chaque `session.diff_changed`).
pub const SLOW_STATS_BACKOFF: Duration = Duration::from_secs(5 * 60);

/// Un commit en JSON ; compteurs à `null` s'ils n'ont pas été calculés.
fn commit_json(c: &Commit, stats: bool) -> Value {
    let count = |n: u64| if stats { json!(n) } else { Value::Null };
    json!({
        "sha": c.sha,
        "parents": c.parents,
        "author": c.author,
        "date": c.date,
        "subject": c.subject,
        "body": c.body,
        "files": count(c.files),
        "additions": count(c.additions),
        "deletions": count(c.deletions),
    })
}

/// Lit `sha` : 40 ou 64 chiffres hexadécimaux en minuscules.
pub(super) fn sha_param(v: Option<&Value>) -> Result<String, String> {
    let s = match v {
        None | Some(Value::Null) => return Err("« sha » manquant".into()),
        Some(Value::String(s)) => s,
        Some(_) => return Err("« sha » doit être une chaîne".into()),
    };
    if !is_object_id(s) {
        return Err("« sha » : identifiant de commit complet attendu (40 ou 64 caractères hexadécimaux en minuscules)".into());
    }
    Ok(s.clone())
}

/// Erreur d'un commit absent de l'historique de la session.
pub(super) fn foreign_commit(sha: &str) -> String {
    format!(
        "le commit « {} » ne fait pas partie de l'historique de la session",
        short_sha(sha)
    )
}

impl Daemon {
    /// Historique d'une session (calcul complet), mémorisé avec, si
    /// `requested` est `Some`, la plage demandée (même verrou). Compteurs
    /// demandés mais abandonnés (trop lents) : la session est listée sans
    /// eux pendant [`SLOW_STATS_BACKOFF`]. Bloquant.
    fn compute_commits(
        &self,
        id: Uuid,
        cwd: &Path,
        limit: usize,
        stats: bool,
        range: Option<CommitRange>,
        requested: Option<Option<CommitRange>>,
    ) -> Result<Arc<CommitLog>, RpcError> {
        if !cwd.is_dir() {
            return Err(RpcError::cwd_missing(cwd));
        }
        let slow = self
            .diff_watch
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&id)
            .and_then(|w| w.slow_stats_until)
            .is_some_and(|until| Instant::now() < until);
        let try_stats = stats && !slow;
        let log = Arc::new(
            self.deps
                .diff
                .commits(cwd, limit, try_stats, range)
                .map_err(diff_error)?,
        );
        let mut watch = self.diff_watch.lock().unwrap_or_else(|e| e.into_inner());
        let w = watch.entry(id).or_default();
        w.commits = Some((log.clone(), Instant::now()));
        if let Some(r) = requested {
            w.commits_range = r;
        }
        if try_stats && !log.stats {
            w.slow_stats_until = Some(Instant::now() + SLOW_STATS_BACKOFF);
        }
        Ok(log)
    }

    /// Historique courant contenant tous les commits `shas` si possible :
    /// la dernière liste si elle a moins de [`DIFF_REUSE`] et les contient
    /// tous, sinon une liste recalculée (sans compteurs, [`MAX_COMMITS`] au
    /// plus, même plage demandée que le dernier `sessions.commits`). Les
    /// absents sont à refuser par l'appelant. Bloquant.
    pub(super) fn history_log(
        &self,
        id: Uuid,
        cwd: &Path,
        shas: &[&str],
    ) -> Result<Arc<CommitLog>, RpcError> {
        let (cached, range) = {
            let watch = self.diff_watch.lock().unwrap_or_else(|e| e.into_inner());
            let w = watch.get(&id);
            (
                w.and_then(|w| w.commits.clone())
                    .filter(|(_, at)| at.elapsed() < DIFF_REUSE)
                    .map(|(log, _)| log),
                w.and_then(|w| w.commits_range),
            )
        };
        if let Some(log) = cached
            && shas.iter().all(|s| log.commit(s).is_some())
        {
            return Ok(log);
        }
        self.compute_commits(id, cwd, MAX_COMMITS, false, range, None)
    }

    /// Fichiers d'un commit de l'historique (cache borné par session).
    /// Bloquant.
    pub(super) fn commit_files(
        &self,
        id: Uuid,
        log: &CommitLog,
        commit: &Commit,
    ) -> Result<Arc<ChangeSet>, RpcError> {
        let cached = self
            .diff_watch
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&id)
            .and_then(|w| w.commit_changes.get(&commit.sha).cloned())
            .filter(|c| c.root == log.root);
        if let Some(c) = cached {
            return Ok(c);
        }
        let changes = Arc::new(
            self.deps
                .diff
                .commit_changes(&log.root, commit)
                .map_err(diff_error)?,
        );
        let mut watch = self.diff_watch.lock().unwrap_or_else(|e| e.into_inner());
        let kept = &mut watch.entry(id).or_default().commit_changes;
        if kept.len() >= COMMIT_CHANGES_KEPT {
            kept.clear();
        }
        kept.insert(commit.sha.clone(), changes.clone());
        Ok(changes)
    }

    /// Commit `sha` (paramètre) de l'historique d'une session et ses fichiers.
    fn commit_param(&self, params: &Value) -> Result<(Uuid, Arc<ChangeSet>), RpcError> {
        let id = session_id_param(params)?;
        let sha = sha_param(params.get("sha")).map_err(RpcError::params)?;
        let (cwd, _) = self.session_cwd(&id)?;
        let log = self.history_log(id, &cwd, &[&sha])?;
        let commit = log
            .commit(&sha)
            .ok_or_else(|| RpcError::params(foreign_commit(&sha)))?;
        Ok((id, self.commit_files(id, &log, commit)?))
    }

    /// `sessions.commits {id, limit?, range?}` (toujours un calcul complet).
    /// Bloquant (`git`).
    pub fn commits(&self, params: &Value) -> Result<Value, RpcError> {
        let id = session_id_param(params)?;
        let limit = match params.get("limit") {
            None | Some(Value::Null) => DEFAULT_COMMITS,
            Some(v) => v
                .as_u64()
                .filter(|n| (1..=MAX_COMMITS as u64).contains(n))
                .ok_or_else(|| {
                    RpcError::params(format!("« limit » : entier de 1 à {MAX_COMMITS}"))
                })? as usize,
        };
        let range =
            match params.get("range") {
                None | Some(Value::Null) => None,
                Some(v) => Some(v.as_str().and_then(CommitRange::parse).ok_or_else(|| {
                    RpcError::params("« range » : « branch » ou « recent » attendu")
                })?),
            };
        let (cwd, _) = self.session_cwd(&id)?;
        let log = self.compute_commits(id, &cwd, limit, true, range, Some(range))?;
        Ok(json!({
            "range": log.range.as_str(),
            "stats": log.stats,
            "base": {
                "ref": log.base.reference,
                "sha": log.base.sha,
                "kind": log.base.kind.as_str(),
            },
            "head": log.head,
            "commits": log.commits.iter().map(|c| commit_json(c, log.stats)).collect::<Vec<_>>(),
            "truncated": log.truncated,
        }))
    }

    /// `sessions.commitDiff {id, sha}` : fichiers du commit contre son
    /// premier parent (arbre vide pour un commit racine). Bloquant (`git`).
    pub fn commit_diff(&self, params: &Value) -> Result<Value, RpcError> {
        let (_, changes) = self.commit_param(params)?;
        let mut v = changeset_json(&changes);
        v["sha"] = json!(changes.target);
        Ok(v)
    }

    /// `sessions.commitDiffFile {id, sha, path}` : `path` doit être un
    /// fichier de `sessions.commitDiff`. Bloquant (`git`).
    pub fn commit_diff_file(&self, params: &Value) -> Result<Value, RpcError> {
        let path = opt_str(params, "path")?.ok_or_else(|| RpcError::params("« path » manquant"))?;
        let (_, changes) = self.commit_param(params)?;
        let file = changes.file(&path).ok_or_else(|| {
            RpcError::params(format!("« {path} » ne fait pas partie du diff du commit"))
        })?;
        let d = self
            .deps
            .diff
            .file_diff(&changes, file)
            .map_err(diff_error)?;
        Ok(file_diff_json(&d))
    }
}
