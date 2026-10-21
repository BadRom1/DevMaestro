//! Demandes de fusion (v0.3, lot 13b, ADR 0006) : `forge.pulls`,
//! `forge.pull`, `forge.pullFile`, `forge.pullForBranch` et la seule
//! écriture vers la forge, `forge.submitReview`.
//!
//! `forge.submitReview` n'est servie que sur le socket de contrôle (le
//! socket des relais ferme toute connexion qui envoie du JSON-RPC, et le
//! socket de contrôle refuse les processus des sessions) : elle ne part que
//! d'une action de l'utilisateur dans l'app (ADR 0006, point 5).

use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use serde_json::{Map, Value, json};

use super::super::{Daemon, RpcError, opt_str};
use super::{PULL_CACHE_TTL, PullDiff, bool_param, cache_key, forge_error, root_param, text_param};
use crate::domain::diff::{FileDiff, Side};
use crate::domain::forge::pulls::{
    CheckRun, ForgeReview, ForgeReviewComment, MAX_PULLS_LIMIT, Pull, PullDetail, PullFilter,
    PullStateFilter, ReviewEvent, ReviewRefusal, ReviewThread, summarize_checks, valid_branch,
};
use crate::domain::forge::{MAX_SEARCH_CHARS, RemoteRepo};
use crate::protocol::error_code;

/// Message du conflit de tête (`-32023`).
pub const HEAD_CHANGED: &str = "la demande de fusion a changé depuis son ouverture";

fn number_param(params: &Value) -> Result<u64, RpcError> {
    params
        .get("number")
        .and_then(Value::as_u64)
        .filter(|n| (1..=i32::MAX as u64).contains(n))
        .ok_or_else(|| RpcError::params("« number » : entier positif attendu"))
}

fn pull_filter_param(params: &Value) -> Result<PullFilter, RpcError> {
    let state = match opt_str(params, "state")? {
        None => PullStateFilter::Open,
        Some(s) => PullStateFilter::parse(&s).ok_or_else(|| {
            RpcError::params(format!(
                "« state » inconnu : {s} (attendu : open, closed, merged, all)"
            ))
        })?,
    };
    let mine = match opt_str(params, "author")? {
        None => false,
        Some(a) if a == "@me" => true,
        Some(a) => {
            return Err(RpcError::params(format!(
                "« author » : seul « @me » est accepté (reçu : {a})"
            )));
        }
    };
    let limit = match params.get("limit") {
        None | Some(Value::Null) => crate::domain::forge::pulls::DEFAULT_PULLS_LIMIT,
        Some(v) => v
            .as_u64()
            .filter(|n| (1..=MAX_PULLS_LIMIT as u64).contains(n))
            .map(|n| n as usize)
            .ok_or_else(|| {
                RpcError::params(format!("« limit » : entier de 1 à {MAX_PULLS_LIMIT}"))
            })?,
    };
    Ok(PullFilter {
        state,
        search: text_param(params, "search", MAX_SEARCH_CHARS)?,
        mine,
        limit,
    })
}

fn check_json(c: &CheckRun) -> Value {
    json!({
        "name": c.name,
        "workflow": c.workflow,
        "state": c.state.as_str(),
        "url": c.url,
        "started_at": c.started_at,
        "completed_at": c.completed_at,
    })
}

fn side_str(side: Side) -> &'static str {
    match side {
        Side::New => "new",
        Side::Old => "old",
    }
}

fn thread_json(t: &ReviewThread) -> Value {
    json!({
        "path": t.path,
        "line": t.line,
        "side": side_str(t.side),
        "resolved": t.resolved,
        "outdated": t.outdated,
        "comments": t.comments.iter().map(|c| json!({
            "author": c.author,
            "body": c.body,
            "created_at": c.created_at,
        })).collect::<Vec<_>>(),
        "comments_truncated": t.comments_truncated,
    })
}

/// Demande de fusion au format du protocole ; `full` : avec le corps.
pub fn pull_json(p: &Pull, full: bool) -> Value {
    let s = summarize_checks(&p.checks);
    let mut v = json!({
        "number": p.number,
        "title": p.title,
        "state": p.state.as_str(),
        "draft": p.draft,
        "url": p.url,
        "author": p.author,
        "head": {"branch": p.head_branch, "sha": p.head_sha},
        "base": {"branch": p.base_branch},
        "updated_at": p.updated_at,
        "additions": p.additions,
        "deletions": p.deletions,
        "changed_files": p.changed_files,
        "review_decision": p.review_decision.map(|d| d.as_str()),
        "checks": {
            "state": s.state.as_str(),
            "total": s.total,
            "passed": s.passed,
            "failed": s.failed,
            "pending": s.pending,
        },
        "labels": p.labels.iter()
            .map(|l| json!({"name": l.name, "color": l.color}))
            .collect::<Vec<_>>(),
    });
    if full {
        v["body"] = json!(p.body.as_deref().unwrap_or(""));
        v["truncated"] = json!(p.body_truncated);
    }
    v
}

/// `forge.pull` : la demande complète, ses fichiers, ses vérifications et
/// ses fils de revue.
pub fn pull_detail_json(d: &PullDetail) -> Value {
    let mut v = pull_json(&d.pull, true);
    v["files"] = d
        .files
        .iter()
        .map(|f| {
            let mut o = json!({
                "path": f.path,
                "status": f.status.as_str(),
                "additions": f.additions,
                "deletions": f.deletions,
            });
            if let Some(old) = &f.old_path {
                o["old_path"] = json!(old);
            }
            o
        })
        .collect();
    v["files_truncated"] = json!(d.files_truncated);
    v["check_runs"] = d.pull.checks.iter().map(check_json).collect();
    v["review_threads"] = d.threads.iter().map(thread_json).collect();
    v["review_threads_truncated"] = json!(d.threads_truncated);
    v
}

/// Erreur `-32602` d'un commentaire de revue : `data: {index, path, line,
/// side}` (valeurs telles que reçues, `null` si absentes).
fn comment_error(index: usize, raw: &Value, message: impl Into<String>) -> RpcError {
    RpcError::params(message).with_data(json!({
        "index": index,
        "path": raw.get("path").cloned().unwrap_or(Value::Null),
        "line": raw.get("line").cloned().unwrap_or(Value::Null),
        "side": raw.get("side").cloned().unwrap_or(Value::Null),
    }))
}

fn refusal_error(r: ReviewRefusal, raw: &[Value]) -> RpcError {
    match r.index {
        Some(i) => comment_error(i, raw.get(i).unwrap_or(&Value::Null), r.message),
        None => RpcError::params(r.message),
    }
}

/// Paramètres de `forge.submitReview` lus et validés (sans la forge).
fn review_param(params: &Value) -> Result<(ForgeReview, Vec<Value>), RpcError> {
    let sha = opt_str(params, "expected_head_sha")?
        .ok_or_else(|| RpcError::params("« expected_head_sha » manquant"))?;
    let event = opt_str(params, "event")?.ok_or_else(|| RpcError::params("« event » manquant"))?;
    let event = ReviewEvent::parse(&event).ok_or_else(|| {
        RpcError::params(format!(
            "« event » inconnu : {event} (attendu : comment, approve, request_changes)"
        ))
    })?;
    let body = opt_str(params, "body")?.unwrap_or_default();
    let raw: Vec<Value> = match params.get("comments") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(a)) => a.clone(),
        Some(_) => return Err(RpcError::params("« comments » doit être un tableau")),
    };
    if raw.len() > crate::domain::forge::pulls::MAX_FORGE_REVIEW_COMMENTS {
        return Err(RpcError::params(format!(
            "{} commentaires : {} au plus",
            raw.len(),
            crate::domain::forge::pulls::MAX_FORGE_REVIEW_COMMENTS
        )));
    }
    let mut comments = Vec::with_capacity(raw.len());
    for (i, c) in raw.iter().enumerate() {
        let n = i + 1;
        let o: &Map<String, Value> = c
            .as_object()
            .ok_or_else(|| comment_error(i, c, format!("commentaire {n} : objet attendu")))?;
        let path = o
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| comment_error(i, c, format!("commentaire {n} : « path » manquant")))?;
        let line = o
            .get("line")
            .and_then(Value::as_u64)
            .filter(|l| (1..=i32::MAX as u64).contains(l))
            .ok_or_else(|| {
                comment_error(
                    i,
                    c,
                    format!("commentaire {n} : « line » : entier ≥ 1 attendu"),
                )
            })?;
        let side = match o.get("side").and_then(Value::as_str) {
            Some("new") => Side::New,
            Some("old") => Side::Old,
            _ => {
                return Err(comment_error(
                    i,
                    c,
                    format!("commentaire {n} : « side » : « new » ou « old » attendu"),
                ));
            }
        };
        let text = o
            .get("body")
            .and_then(Value::as_str)
            .ok_or_else(|| comment_error(i, c, format!("commentaire {n} : « body » manquant")))?;
        comments.push(ForgeReviewComment {
            path: path.to_owned(),
            line: line as u32,
            side,
            body: text.to_owned(),
        });
    }
    let review =
        ForgeReview::new(&sha, event, &body, comments).map_err(|r| refusal_error(r, &raw))?;
    Ok((review, raw))
}

impl Daemon {
    /// Diff de la demande `number` à la tête `head_sha`, gardé par tête
    /// (sauf `refresh`).
    fn pull_diff_cached(
        &self,
        root: &Path,
        remote: &RemoteRepo,
        number: u64,
        head_sha: &str,
        refresh: bool,
    ) -> Result<Arc<PullDiff>, RpcError> {
        let key = cache_key(&json!(["pull_diff", remote.slug(), number, head_sha]));
        if !refresh && let Some(d) = self.forge_cache().get_diff(&key, Instant::now()) {
            return Ok(d);
        }
        let files = self
            .deps
            .forge
            .pull_diff(root, remote, number)
            .map_err(forge_error)?;
        let mut map = PullDiff::with_capacity(files.len());
        for (path, diff) in files {
            map.entry(path).or_insert(diff);
        }
        let map = Arc::new(map);
        self.forge_cache()
            .put_diff(key, map.clone(), Instant::now());
        Ok(map)
    }

    /// Détail de la demande (gardé 30 s, sauf `refresh`).
    fn pull_detail_value(
        &self,
        root: &Path,
        remote: &RemoteRepo,
        number: u64,
        refresh: bool,
    ) -> Result<Value, RpcError> {
        let key = cache_key(&json!(["pull", remote.slug(), number]));
        self.forge_cached_for(key, refresh, PULL_CACHE_TTL, || {
            Ok(pull_detail_json(
                &self.deps.forge.pull(root, remote, number)?,
            ))
        })
    }

    /// `forge.pulls {root, enabled?, refresh?, state?, search?, author?, limit?}`.
    pub fn forge_pulls(&self, params: &Value) -> Result<Value, RpcError> {
        let root = root_param(params)?;
        let refresh = bool_param(params, "refresh", false)?;
        let filter = pull_filter_param(params)?;
        let remote = self.forge_remote(&root, params, refresh)?;
        let key = cache_key(&json!([
            "pulls",
            remote.slug(),
            filter.state.as_str(),
            filter.search,
            filter.mine,
            filter.limit,
        ]));
        self.forge_cached_for(key, refresh, PULL_CACHE_TTL, || {
            let (pulls, truncated) = self.deps.forge.pulls(&root, &remote, &filter)?;
            Ok(json!({
                "pulls": pulls.iter().map(|p| pull_json(p, false)).collect::<Vec<_>>(),
                "truncated": truncated,
            }))
        })
    }

    /// `forge.pull {root, number, enabled?, refresh?}`.
    pub fn forge_pull(&self, params: &Value) -> Result<Value, RpcError> {
        let root = root_param(params)?;
        let refresh = bool_param(params, "refresh", false)?;
        let number = number_param(params)?;
        let remote = self.forge_remote(&root, params, refresh)?;
        self.pull_detail_value(&root, &remote, number, refresh)
    }

    /// `forge.pullFile {root, number, path, enabled?, refresh?}` : hunks du
    /// fichier dans le diff de la demande, à sa tête.
    pub fn forge_pull_file(&self, params: &Value) -> Result<Value, RpcError> {
        let root = root_param(params)?;
        let refresh = bool_param(params, "refresh", false)?;
        let number = number_param(params)?;
        let path = opt_str(params, "path")?
            .filter(|p| !p.is_empty())
            .ok_or_else(|| RpcError::params("« path » manquant"))?;
        let remote = self.forge_remote(&root, params, refresh)?;
        let detail = self.pull_detail_value(&root, &remote, number, refresh)?;
        let listed = detail["files"]
            .as_array()
            .is_some_and(|f| f.iter().any(|f| f["path"] == path.as_str()));
        if !listed {
            return Err(RpcError::params(format!(
                "« {path} » ne fait pas partie de la demande de fusion #{number}"
            )));
        }
        let head = detail["head"]["sha"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        let diff = self.pull_diff_cached(&root, &remote, number, &head, refresh)?;
        // Fichier listé mais absent du diff (changement de mode seul…) : aucun bloc.
        let empty = FileDiff::default();
        Ok(super::super::file_diff_json(
            diff.get(&path).unwrap_or(&empty),
        ))
    }

    /// `forge.pullForBranch {root, branch, enabled?, refresh?}` : la demande
    /// ouverte dont la tête est cette branche du dépôt, ou `null`.
    pub fn forge_pull_for_branch(&self, params: &Value) -> Result<Value, RpcError> {
        let root = root_param(params)?;
        let refresh = bool_param(params, "refresh", false)?;
        let branch =
            opt_str(params, "branch")?.ok_or_else(|| RpcError::params("« branch » manquant"))?;
        if !valid_branch(&branch) {
            return Err(RpcError::params(format!(
                "« branch » : nom de branche invalide : {}",
                crate::domain::forge::one_line(&branch)
            )));
        }
        let remote = self.forge_remote(&root, params, refresh)?;
        let key = cache_key(&json!(["pull_for_branch", remote.slug(), branch]));
        self.forge_cached_for(key, refresh, PULL_CACHE_TTL, || {
            Ok(self
                .deps
                .forge
                .pull_for_branch(&root, &remote, &branch)?
                .map_or(Value::Null, |p| pull_json(&p, false)))
        })
    }

    /// `forge.submitReview {root, number, expected_head_sha, event, body?,
    /// comments?, enabled?}` → `{url}`. Ordre : paramètres validés (rien
    /// n'est lancé s'ils sont refusés) ; tête relue **sans cache** (conflit :
    /// `-32023`) ; lignes vérifiées contre le diff de cette tête ; puis la
    /// revue est publiée, une seule fois.
    pub fn forge_submit_review(&self, params: &Value) -> Result<Value, RpcError> {
        let root = root_param(params)?;
        let number = number_param(params)?;
        let (review, raw) = review_param(params)?;
        let remote = self.forge_remote(&root, params, false)?;
        let slug = remote.slug();
        let head = self
            .deps
            .forge
            .pull_head(&root, &remote, number)
            .map_err(forge_error)?;
        if head != review.head_sha {
            // La demande a bougé : ce qui est gardé d'elle est périmé.
            self.forge_cache().forget_pulls(&slug);
            return Err(RpcError::new(error_code::PULL_HEAD_CHANGED, HEAD_CHANGED)
                .with_data(json!({"head_sha": head})));
        }
        if !review.comments.is_empty() {
            let diff = self.pull_diff_cached(&root, &remote, number, &review.head_sha, false)?;
            review
                .check_lines(|p| diff.get(p))
                .map_err(|r| refusal_error(r, &raw))?;
        }
        let url = self
            .deps
            .forge
            .submit_review(&root, &remote, number, &review)
            .map_err(forge_error);
        // Publiée ou pas (un délai dépassé peut cacher une revue publiée),
        // l'état gardé de la demande n'est plus sûr.
        self.forge_cache().forget_pulls(&slug);
        let url = url?;
        crate::daemon::log::info!(
            "forge : revue « {} » publiée sur la demande de fusion #{number} ({} commentaire(s))",
            review.event.as_str(),
            review.comments.len()
        );
        Ok(json!({"url": url}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHA: &str = "04b392947395d0fc415e8fc028b358707f4df18c";

    #[test]
    fn pull_filters_are_validated() {
        let f = pull_filter_param(&json!({})).unwrap();
        assert_eq!(f, PullFilter::default());
        let f = pull_filter_param(&json!({
            "state": "merged", "search": "  relais ", "author": "@me", "limit": 200
        }))
        .unwrap();
        assert_eq!(f.state, PullStateFilter::Merged);
        assert_eq!(f.search.as_deref(), Some("relais"));
        assert!(f.mine);
        assert_eq!(f.limit, 200);
        assert!(!pull_filter_param(&json!({"author": null})).unwrap().mine);
        for bad in [
            json!({"state": "draft"}),
            json!({"author": "octocat"}),
            json!({"limit": 0}),
            json!({"limit": 201}),
            json!({"search": "a\nb"}),
        ] {
            assert_eq!(
                pull_filter_param(&bad).unwrap_err().code,
                error_code::INVALID_PARAMS,
                "{bad}"
            );
        }
    }

    #[test]
    fn review_params_are_validated() {
        let (r, raw) = review_param(&json!({
            "expected_head_sha": SHA, "event": "request_changes", "body": " Corps ",
            "comments": [{"path": "a.rs", "line": 3, "side": "old", "body": "x"}],
        }))
        .unwrap();
        assert_eq!(r.event, ReviewEvent::RequestChanges);
        assert_eq!(
            r.body, " Corps ",
            "seules les lignes blanches de bord partent"
        );
        assert_eq!(r.comments[0].side, Side::Old);
        assert_eq!(raw.len(), 1);
        let (r, _) = review_param(&json!({"expected_head_sha": SHA, "event": "approve"})).unwrap();
        assert!(r.body.is_empty() && r.comments.is_empty());

        let base = json!({"expected_head_sha": SHA, "event": "comment", "body": "b"});
        let with = |extra: Value| {
            let mut p = base.clone();
            for (k, v) in extra.as_object().unwrap() {
                p[k] = v.clone();
            }
            p
        };
        for bad in [
            json!({"expected_head_sha": "abc"}),
            json!({"expected_head_sha": null}),
            json!({"event": "merge"}),
            json!({"body": 3}),
            json!({"comments": {}}),
            json!({"body": "", "comments": []}),
        ] {
            let e = review_param(&with(bad.clone())).unwrap_err();
            assert_eq!(e.code, error_code::INVALID_PARAMS, "{bad}");
            assert_eq!(e.data, None, "{bad}");
        }
        // Erreurs d'un commentaire : désigné par `data`.
        for (bad, want) in [
            (json!(3), "objet attendu"),
            (
                json!({"line": 1, "side": "new", "body": "x"}),
                "« path » manquant",
            ),
            (
                json!({"path": "a", "line": 0, "side": "new", "body": "x"}),
                "« line »",
            ),
            (
                json!({"path": "a", "line": 1, "side": "LEFT", "body": "x"}),
                "« side »",
            ),
            (
                json!({"path": "a", "line": 1, "side": "new"}),
                "« body » manquant",
            ),
            (
                json!({"path": "a", "line": 1, "side": "new", "body": " \u{200B} "}),
                "corps vide",
            ),
        ] {
            let p = with(json!({"comments": [
                {"path": "ok.rs", "line": 1, "side": "new", "body": "ok"}, bad.clone()
            ]}));
            let e = review_param(&p).unwrap_err();
            assert_eq!(e.code, error_code::INVALID_PARAMS);
            assert!(e.message.starts_with("commentaire 2 : "), "{}", e.message);
            assert!(e.message.contains(want), "{} / {want}", e.message);
            let data = e.data.unwrap();
            assert_eq!(data["index"], 1);
            assert_eq!(
                data["path"],
                bad.get("path").cloned().unwrap_or(Value::Null)
            );
        }
    }

    #[test]
    fn pull_json_shape() {
        use crate::domain::forge::pulls::{CheckState, PullState, ReviewDecision};
        let p = Pull {
            number: 21,
            title: "t".into(),
            state: PullState::Open,
            draft: true,
            url: "https://github.com/o/r/pull/21".into(),
            author: Some("moi".into()),
            head_branch: "b".into(),
            head_sha: SHA.into(),
            base_branch: "main".into(),
            cross_repository: false,
            head_owner: Some("o".into()),
            updated_at: None,
            additions: 1,
            deletions: 2,
            changed_files: 3,
            review_decision: Some(ReviewDecision::Approved),
            checks: vec![CheckRun {
                name: "ci".into(),
                workflow: None,
                state: CheckState::Pending,
                url: None,
                started_at: None,
                completed_at: None,
            }],
            labels: vec![],
            body: Some("corps".into()),
            body_truncated: false,
        };
        assert_eq!(
            pull_json(&p, false),
            json!({"number": 21, "title": "t", "state": "open", "draft": true,
                   "url": "https://github.com/o/r/pull/21", "author": "moi",
                   "head": {"branch": "b", "sha": SHA}, "base": {"branch": "main"},
                   "updated_at": null, "additions": 1, "deletions": 2, "changed_files": 3,
                   "review_decision": "approved",
                   "checks": {"state": "pending", "total": 1, "passed": 0, "failed": 0, "pending": 1},
                   "labels": []})
        );
        let full = pull_json(&p, true);
        assert_eq!(
            (full["body"].as_str(), full["truncated"].as_bool()),
            (Some("corps"), Some(false))
        );
    }
}
