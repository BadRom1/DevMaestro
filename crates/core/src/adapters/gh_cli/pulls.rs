//! Demandes de fusion de GitHub par `gh` (v0.3, lot 13b) : lecture des
//! sorties de `gh pr list/view --json`, de l'API REST (fichiers), de l'API
//! GraphQL (fils de revue), et publication d'une revue (`gh api -X POST …
//! --input -`, le document passé sur l'entrée standard).

use std::path::Path;

use serde_json::{Value, json};

use super::{GhRun, GithubCli, invalid, labels_of, login_of};
use crate::domain::diff::{
    FileDiff, FileStatus, MAX_FILE_BYTES, Side, parse_unified, split_unified_diff,
};
use crate::domain::forge::pulls::{
    CheckRun, CheckState, ForgeReview, MAX_PULL_FILES, MAX_REVIEW_THREADS, MAX_THREAD_COMMENTS,
    Pull, PullDetail, PullFile, PullFilter, PullState, ReviewDecision, ReviewEvent, ReviewThread,
    ThreadComment, dedupe_checks,
};
use crate::domain::forge::{RemoteRepo, clean_text, one_line, truncate_body};
use crate::ports::ForgeError;

/// Champs demandés à `gh pr list --json` (vérifiés avec gh 2.87.2 : `gh pr
/// list --json` sans valeur liste les champs disponibles).
pub const PULL_LIST_FIELDS: &str = "number,title,state,isDraft,url,author,headRefName,headRefOid,\
baseRefName,isCrossRepository,headRepositoryOwner,updatedAt,additions,deletions,changedFiles,reviewDecision,\
statusCheckRollup,labels";
/// Champs demandés à `gh pr view --json` : ceux de la liste et le corps.
pub const PULL_VIEW_FIELDS: &str = "number,title,state,isDraft,url,author,headRefName,headRefOid,\
baseRefName,isCrossRepository,headRepositoryOwner,updatedAt,additions,deletions,changedFiles,reviewDecision,\
statusCheckRollup,labels,body";
/// Filtre `--jq` appliqué à chaque page de `…/pulls/<n>/files` : une ligne
/// JSON par fichier, sans le `patch` (le diff vient de `gh pr diff`).
pub const FILES_JQ: &str = ".[] | {filename, previous_filename, status, additions, deletions}";
/// Filtre `--jq` du repli de `gh pr diff` (diff trop gros pour GitHub ou
/// pour le démon) : une ligne JSON par fichier **avec** son `patch` (hunks
/// sans en-têtes ; absent pour un binaire ou un diff trop gros).
pub const PATCHES_JQ: &str = ".[] | {filename, status, additions, deletions, patch}";
/// Requête GraphQL des fils de revue (l'API REST n'a pas l'état « résolu »).
pub const THREADS_QUERY: &str = "query($owner:String!,$name:String!,$number:Int!){\
repository(owner:$owner,name:$name){pullRequest(number:$number){\
reviewThreads(first:100){totalCount nodes{path line diffSide isResolved isOutdated \
comments(first:50){totalCount nodes{author{login} body createdAt}}}}}}}";
/// Demandes de fusion lues pour `forge.pullForBranch` (des fourches peuvent
/// avoir une branche du même nom, ouverte vers ce dépôt).
const FOR_BRANCH_LIMIT: &str = "--limit=50";

/// URL `http(s)://` gardée telle quelle ; autre chose : `None`.
fn web_url(v: &Value) -> Option<String> {
    v.as_str()
        .filter(|u| {
            (u.starts_with("https://") || u.starts_with("http://"))
                && !u.chars().any(|c| c.is_control() || c.is_whitespace())
        })
        .map(str::to_owned)
}

fn opt_string(v: &Value) -> Option<String> {
    v.as_str().filter(|s| !s.is_empty()).map(str::to_owned)
}

/// Vérifications de `statusCheckRollup` : *check runs* (`__typename:
/// "CheckRun"`, `name`, `workflowName`, `status`, `conclusion`,
/// `detailsUrl`, `startedAt`, `completedAt`) et statuts de commit
/// (`StatusContext`, `context`, `state`, `targetUrl`, `startedAt`), sans
/// doublons.
pub fn checks_of(rollup: &Value) -> Vec<CheckRun> {
    let Some(items) = rollup.as_array() else {
        return Vec::new();
    };
    let checks = items
        .iter()
        .filter_map(|c| match c["__typename"].as_str()? {
            "CheckRun" => Some(CheckRun {
                name: one_line(c["name"].as_str()?),
                workflow: c["workflowName"]
                    .as_str()
                    .map(one_line)
                    .filter(|w| !w.is_empty()),
                state: CheckState::of_check_run(c["status"].as_str(), c["conclusion"].as_str()),
                url: web_url(&c["detailsUrl"]),
                started_at: opt_string(&c["startedAt"]),
                completed_at: opt_string(&c["completedAt"]),
            }),
            "StatusContext" => Some(CheckRun {
                name: one_line(c["context"].as_str()?),
                workflow: None,
                state: CheckState::of_status_context(c["state"].as_str()?),
                url: web_url(&c["targetUrl"]),
                started_at: opt_string(&c["startedAt"]),
                completed_at: None,
            }),
            _ => None,
        })
        .collect();
    dedupe_checks(checks)
}

/// Une demande de fusion de `gh pr list/view --json` (forme GraphQL :
/// `state: "OPEN"`, `isDraft`, `headRefOid`…) ; `None` si illisible.
fn pull_of(v: &Value, with_body: bool) -> Option<Pull> {
    let (body, body_truncated) = if with_body {
        let (b, t) = truncate_body(&clean_text(v["body"].as_str().unwrap_or("")));
        (Some(b), t)
    } else {
        (None, false)
    };
    Some(Pull {
        number: v["number"].as_u64().filter(|n| *n > 0)?,
        title: one_line(v["title"].as_str()?),
        state: PullState::parse(v["state"].as_str()?)?,
        draft: v["isDraft"].as_bool().unwrap_or(false),
        url: v["url"].as_str()?.to_owned(),
        author: v.get("author").and_then(login_of),
        head_branch: v["headRefName"].as_str()?.to_owned(),
        head_sha: v["headRefOid"].as_str()?.to_ascii_lowercase(),
        base_branch: v["baseRefName"].as_str()?.to_owned(),
        cross_repository: v["isCrossRepository"].as_bool().unwrap_or(false),
        head_owner: v.get("headRepositoryOwner").and_then(login_of),
        updated_at: opt_string(&v["updatedAt"]),
        additions: v["additions"].as_u64().unwrap_or(0),
        deletions: v["deletions"].as_u64().unwrap_or(0),
        changed_files: v["changedFiles"].as_u64().unwrap_or(0),
        review_decision: v["reviewDecision"].as_str().and_then(ReviewDecision::parse),
        checks: checks_of(&v["statusCheckRollup"]),
        labels: labels_of(&v["labels"]),
        body,
        body_truncated,
    })
}

/// `gh pr list --json` ([`PULL_LIST_FIELDS`]) ; entrées illisibles écartées.
pub fn parse_gh_pulls(stdout: &[u8]) -> Result<Vec<Pull>, ForgeError> {
    let v: Value = serde_json::from_slice(stdout).map_err(|_| invalid())?;
    let items = v.as_array().ok_or_else(invalid)?;
    Ok(items.iter().filter_map(|p| pull_of(p, false)).collect())
}

/// `gh pr view --json` ([`PULL_VIEW_FIELDS`]).
pub fn parse_gh_pull(stdout: &[u8]) -> Result<Pull, ForgeError> {
    let v: Value = serde_json::from_slice(stdout).map_err(|_| invalid())?;
    pull_of(&v, true).ok_or_else(invalid)
}

/// Fichiers de l'API REST filtrés par [`FILES_JQ`] (une ligne JSON par
/// fichier, `filename`, `previous_filename`, `status`, `additions`,
/// `deletions`), au plus [`MAX_PULL_FILES`] ; `true` s'il y en avait plus.
/// `status` : `added` → `A`, `removed` → `D`, `renamed` → `R` (avec
/// l'ancien chemin), `copied` → `A`, `modified`, `changed`, `unchanged` →
/// `M`.
pub fn parse_rest_pull_files(stdout: &[u8]) -> Result<(Vec<PullFile>, bool), ForgeError> {
    let text = std::str::from_utf8(stdout).map_err(|_| invalid())?;
    let mut files = Vec::new();
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let v: Value = serde_json::from_str(line).map_err(|_| invalid())?;
        let Some(path) = v["filename"].as_str().filter(|p| !p.is_empty()) else {
            continue;
        };
        let status = match v["status"].as_str().unwrap_or("") {
            "added" | "copied" => FileStatus::Added,
            "removed" => FileStatus::Deleted,
            "renamed" => FileStatus::Renamed,
            _ => FileStatus::Modified,
        };
        files.push(PullFile {
            path: path.to_owned(),
            old_path: (status == FileStatus::Renamed)
                .then(|| opt_string(&v["previous_filename"]))
                .flatten(),
            status,
            additions: v["additions"].as_u64().unwrap_or(0),
            deletions: v["deletions"].as_u64().unwrap_or(0),
        });
    }
    let truncated = files.len() > MAX_PULL_FILES;
    files.truncate(MAX_PULL_FILES);
    Ok((files, truncated))
}

/// Diff par fichier tiré des `patch` de l'API REST ([`PATCHES_JQ`]) : le
/// `patch` d'un fichier est lu par [`parse_unified`] (mêmes limites ; plus
/// de [`MAX_FILE_BYTES`] : `too_large`). Sans `patch` (l'API n'en dit pas
/// la raison) : `too_large` si des lignes sont comptées (diff trop gros pour
/// l'API) ; sinon aucun bloc pour un renommage pur, `binary` pour le reste
/// (fichier binaire ; un changement de mode seul est aussi vu ainsi).
pub fn parse_rest_patches(stdout: &[u8]) -> Result<Vec<(String, FileDiff)>, ForgeError> {
    let text = std::str::from_utf8(stdout).map_err(|_| invalid())?;
    let mut files = Vec::new();
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let v: Value = serde_json::from_str(line).map_err(|_| invalid())?;
        let Some(path) = v["filename"].as_str().filter(|p| !p.is_empty()) else {
            continue;
        };
        let changes = v["additions"].as_u64().unwrap_or(0) + v["deletions"].as_u64().unwrap_or(0);
        let diff = match v["patch"].as_str() {
            Some(p) if p.len() as u64 > MAX_FILE_BYTES => FileDiff::too_large(),
            Some(p) => parse_unified(p.as_bytes()),
            None if changes > 0 => FileDiff::too_large(),
            None if v["status"] == "renamed" => FileDiff::default(),
            None => FileDiff::binary(),
        };
        files.push((path.to_owned(), diff));
    }
    Ok(files)
}

/// `gh pr diff` a-t-il échoué parce que le diff est trop gros pour GitHub
/// (HTTP 406 : plus de 300 fichiers ou de 20 000 lignes) ?
fn is_diff_too_large(stderr: &[u8]) -> bool {
    let err = String::from_utf8_lossy(stderr);
    err.contains("HTTP 406") || err.contains("too_large") || err.contains("diff exceeded")
}

/// Fils de revue de la réponse GraphQL ([`THREADS_QUERY`]) : `line` (ou
/// `null` pour un fil périmé), `diffSide` `LEFT` → ancienne version,
/// sinon nouvelle ; corps nettoyés et bornés. `true` s'il y avait plus de
/// fils que lus.
pub fn parse_review_threads(stdout: &[u8]) -> Result<(Vec<ReviewThread>, bool), ForgeError> {
    let v: Value = serde_json::from_slice(stdout).map_err(|_| invalid())?;
    let threads = &v["data"]["repository"]["pullRequest"]["reviewThreads"];
    let nodes = threads["nodes"].as_array().ok_or_else(invalid)?;
    let out: Vec<ReviewThread> = nodes
        .iter()
        .take(MAX_REVIEW_THREADS)
        .filter_map(|t| {
            let comments = t["comments"]["nodes"].as_array()?;
            let total = t["comments"]["totalCount"].as_u64().unwrap_or(0);
            let comments: Vec<ThreadComment> = comments
                .iter()
                .take(MAX_THREAD_COMMENTS)
                .map(|c| ThreadComment {
                    author: c.get("author").and_then(login_of),
                    body: truncate_body(&clean_text(c["body"].as_str().unwrap_or(""))).0,
                    created_at: opt_string(&c["createdAt"]),
                })
                .collect();
            Some(ReviewThread {
                path: t["path"].as_str()?.to_owned(),
                line: t["line"].as_u64().and_then(|l| u32::try_from(l).ok()),
                side: if t["diffSide"] == "LEFT" {
                    Side::Old
                } else {
                    Side::New
                },
                resolved: t["isResolved"].as_bool().unwrap_or(false),
                outdated: t["isOutdated"].as_bool().unwrap_or(false),
                comments_truncated: total > comments.len() as u64,
                comments,
            })
        })
        .collect();
    let total = threads["totalCount"].as_u64().unwrap_or(0);
    let truncated = total > out.len() as u64 || nodes.len() > MAX_REVIEW_THREADS;
    Ok((out, truncated))
}

/// Document envoyé à `POST …/pulls/<n>/reviews` (API REST de GitHub) :
/// `commit_id` (la tête relue), `event` (`COMMENT`, `APPROVE`,
/// `REQUEST_CHANGES`), `body`, et `comments: [{path, line, side, body}]`
/// (`side` : `RIGHT` pour la nouvelle version, `LEFT` pour l'ancienne).
pub fn review_payload(review: &ForgeReview) -> Value {
    let event = match review.event {
        ReviewEvent::Comment => "COMMENT",
        ReviewEvent::Approve => "APPROVE",
        ReviewEvent::RequestChanges => "REQUEST_CHANGES",
    };
    json!({
        "commit_id": review.head_sha,
        "event": event,
        "body": review.body,
        "comments": review.comments.iter().map(|c| json!({
            "path": c.path,
            "line": c.line,
            "side": match c.side { Side::New => "RIGHT", Side::Old => "LEFT" },
            "body": c.body,
        })).collect::<Vec<_>>(),
    })
}

/// URL de la revue créée (`html_url` de la réponse).
pub fn parse_review_url(stdout: &[u8]) -> Result<String, ForgeError> {
    let v: Value = serde_json::from_slice(stdout).map_err(|_| invalid())?;
    web_url(&v["html_url"]).ok_or_else(invalid)
}

/// La sortie d'erreur dit-elle que la demande de fusion n'existe pas ?
fn is_not_found(stderr: &[u8]) -> bool {
    let err = String::from_utf8_lossy(stderr);
    err.contains("Could not resolve to a PullRequest")
        || err.contains("HTTP 404")
        || err.contains("no pull requests found")
}

fn not_found(number: u64) -> ForgeError {
    ForgeError::NotFound(format!("demande de fusion #{number} introuvable"))
}

impl GithubCli {
    /// `gh pr view <n> --repo … --json <champs>`.
    fn pr_view(
        &self,
        root: &Path,
        remote: &RemoteRepo,
        number: u64,
        fields: &str,
    ) -> Result<Vec<u8>, ForgeError> {
        let (n, repo) = (number.to_string(), remote.slug());
        let out = self.call(
            root,
            &remote.host,
            &["pr", "view", &n, "--repo", &repo, "--json", fields],
        )?;
        if !out.ok {
            if is_not_found(&out.stderr) {
                return Err(not_found(number));
            }
            return Err(self.failed(root, &out));
        }
        Ok(out.stdout)
    }

    pub(super) fn gh_pulls(
        &self,
        root: &Path,
        remote: &RemoteRepo,
        filter: &PullFilter,
    ) -> Result<(Vec<Pull>, bool), ForgeError> {
        let repo = remote.slug();
        let limit = format!("--limit={}", filter.limit + 1);
        let state = format!("--state={}", filter.state.as_str());
        let mut args = vec![
            "pr",
            "list",
            "--repo",
            &repo,
            "--json",
            PULL_LIST_FIELDS,
            &limit,
            &state,
        ];
        let search = filter.search.as_ref().map(|s| format!("--search={s}"));
        args.extend(search.as_deref());
        if filter.mine {
            args.push("--author=@me");
        }
        let out = self.call(root, &remote.host, &args)?;
        if !out.ok {
            return Err(self.failed(root, &out));
        }
        let mut pulls = parse_gh_pulls(&out.stdout)?;
        let truncated = pulls.len() > filter.limit;
        pulls.truncate(filter.limit);
        Ok((pulls, truncated))
    }

    pub(super) fn gh_pull(
        &self,
        root: &Path,
        remote: &RemoteRepo,
        number: u64,
    ) -> Result<PullDetail, ForgeError> {
        let pull = parse_gh_pull(&self.pr_view(root, remote, number, PULL_VIEW_FIELDS)?)?;
        let host = remote.host.as_str();
        let files_path = format!(
            "repos/{}/{}/pulls/{number}/files?per_page=100",
            remote.owner, remote.repo
        );
        let out = self.call(
            root,
            host,
            &[
                "api",
                "--hostname",
                host,
                &files_path,
                "--paginate",
                "--jq",
                FILES_JQ,
            ],
        )?;
        if !out.ok {
            return Err(self.failed(root, &out));
        }
        let (files, beyond) = parse_rest_pull_files(&out.stdout)?;
        // L'API REST ne donne pas plus de 3 000 fichiers : liste incomplète
        // si la demande en change plus.
        let files_truncated = beyond || pull.changed_files > files.len() as u64;
        let (query, owner, name, n) = (
            format!("query={THREADS_QUERY}"),
            format!("owner={}", remote.owner),
            format!("name={}", remote.repo),
            format!("number={number}"),
        );
        let out = self.call(
            root,
            host,
            &[
                "api",
                "graphql",
                "--hostname",
                host,
                "-f",
                &query,
                "-f",
                &owner,
                "-f",
                &name,
                "-F",
                &n,
            ],
        )?;
        if !out.ok {
            if is_not_found(&out.stderr) {
                return Err(not_found(number));
            }
            return Err(self.failed(root, &out));
        }
        let (threads, threads_truncated) = parse_review_threads(&out.stdout)?;
        Ok(PullDetail {
            pull,
            files,
            files_truncated,
            threads,
            threads_truncated,
        })
    }

    pub(super) fn gh_pull_head(
        &self,
        root: &Path,
        remote: &RemoteRepo,
        number: u64,
    ) -> Result<String, ForgeError> {
        let out = self.pr_view(root, remote, number, "headRefOid")?;
        let v: Value = serde_json::from_slice(&out).map_err(|_| invalid())?;
        v["headRefOid"]
            .as_str()
            .and_then(crate::domain::forge::pulls::normalize_sha)
            .ok_or_else(invalid)
    }

    pub(super) fn gh_pull_diff(
        &self,
        root: &Path,
        remote: &RemoteRepo,
        number: u64,
    ) -> Result<Vec<(String, FileDiff)>, ForgeError> {
        let (n, repo) = (number.to_string(), remote.slug());
        let run = self
            .gh
            .run(&["pr", "diff", &n, "--repo", &repo, "--color=never"]);
        // Diff trop gros (refusé par GitHub, ou plus de 8 Mio) : repli sur les
        // `patch` de l'API REST des fichiers, fichier par fichier.
        let too_large = match &run {
            GhRun::Done(o) if o.truncated => true,
            GhRun::Done(o) if !o.ok => is_diff_too_large(&o.stderr),
            _ => false,
        };
        if too_large {
            return self.rest_patches(root, remote, number);
        }
        let out = self.done(root, &remote.host, run)?;
        if !out.ok {
            if is_not_found(&out.stderr) {
                return Err(not_found(number));
            }
            return Err(self.failed(root, &out));
        }
        Ok(split_unified_diff(&out.stdout))
    }

    /// Repli de [`GithubCli::gh_pull_diff`] : `gh api … pulls/<n>/files
    /// --paginate --jq` [`PATCHES_JQ`].
    fn rest_patches(
        &self,
        root: &Path,
        remote: &RemoteRepo,
        number: u64,
    ) -> Result<Vec<(String, FileDiff)>, ForgeError> {
        let host = remote.host.as_str();
        let path = format!(
            "repos/{}/{}/pulls/{number}/files?per_page=100",
            remote.owner, remote.repo
        );
        let out = self.call(
            root,
            host,
            &[
                "api",
                "--hostname",
                host,
                &path,
                "--paginate",
                "--jq",
                PATCHES_JQ,
            ],
        )?;
        if !out.ok {
            if is_not_found(&out.stderr) {
                return Err(not_found(number));
            }
            return Err(self.failed(root, &out));
        }
        parse_rest_patches(&out.stdout)
    }

    /// Demandes de fusion de `--head=<branche>` dans l'état `state`, dont la
    /// tête est dans le dépôt lui-même (ni fourche, ni autre propriétaire) et
    /// s'appelle exactement `branch`, dans l'ordre de `gh` (les plus récentes
    /// d'abord).
    fn own_pulls_for_branch(
        &self,
        root: &Path,
        remote: &RemoteRepo,
        branch: &str,
        state: &str,
    ) -> Result<Vec<Pull>, ForgeError> {
        let repo = remote.slug();
        let head = format!("--head={branch}");
        let out = self.call(
            root,
            &remote.host,
            &[
                "pr",
                "list",
                "--repo",
                &repo,
                "--json",
                PULL_LIST_FIELDS,
                &head,
                state,
                FOR_BRANCH_LIMIT,
            ],
        )?;
        if !out.ok {
            return Err(self.failed(root, &out));
        }
        // `--head` ne distingue pas les fourches : seule une demande dont la
        // tête est dans le dépôt lui-même (même propriétaire, pas une
        // fourche) est celle de la branche locale.
        Ok(parse_gh_pulls(&out.stdout)?
            .into_iter()
            .filter(|p| {
                !p.cross_repository
                    && p.head_owner
                        .as_deref()
                        .is_some_and(|o| o.eq_ignore_ascii_case(&remote.owner))
                    && p.head_branch == branch
            })
            .collect())
    }

    pub(super) fn gh_pull_for_branch(
        &self,
        root: &Path,
        remote: &RemoteRepo,
        branch: &str,
    ) -> Result<Option<Pull>, ForgeError> {
        Ok(self
            .own_pulls_for_branch(root, remote, branch, "--state=open")?
            .into_iter()
            .next())
    }

    /// Dernière demande de la branche, quel que soit son état (lot 14b) :
    /// l'ouverte s'il y en a une, sinon la plus récente (fusionnée ou fermée).
    pub(super) fn gh_last_pull_for_branch(
        &self,
        root: &Path,
        remote: &RemoteRepo,
        branch: &str,
    ) -> Result<Option<Pull>, ForgeError> {
        let pulls = self.own_pulls_for_branch(root, remote, branch, "--state=all")?;
        let open = pulls
            .iter()
            .position(|p| p.state == crate::domain::forge::pulls::PullState::Open);
        Ok(match open {
            Some(i) => pulls.into_iter().nth(i),
            None => pulls.into_iter().next(),
        })
    }

    pub(super) fn gh_submit_review(
        &self,
        root: &Path,
        remote: &RemoteRepo,
        number: u64,
        review: &ForgeReview,
    ) -> Result<String, ForgeError> {
        let host = remote.host.as_str();
        let path = format!(
            "repos/{}/{}/pulls/{number}/reviews",
            remote.owner, remote.repo
        );
        let payload = serde_json::to_vec(&review_payload(review)).map_err(|_| invalid())?;
        let args = [
            "api",
            "-X",
            "POST",
            &path,
            "--hostname",
            host,
            "--input",
            "-",
        ];
        // Jamais relancé : un délai dépassé peut cacher une revue publiée.
        let out = match self.gh.run_input(&args, &payload) {
            GhRun::TimedOut => {
                return Err(ForgeError::Failed(format!(
                    "gh n'a pas répondu à temps (délai de {} s) : la revue a peut-être été \
                     publiée, vérifiez sur la forge avant de la renvoyer",
                    self.gh.timeout.as_secs().max(1)
                )));
            }
            other => self.done(root, host, other)?,
        };
        if !out.ok {
            if is_not_found(&out.stderr) {
                return Err(not_found(number));
            }
            let mut msg = self.clean(root, &out.stderr);
            // Détail de l'API (champ `message`, `errors`) quand gh l'a écrit
            // sur sa sortie standard (erreur 422…).
            if let Ok(v) = serde_json::from_slice::<Value>(&out.stdout) {
                let details: Vec<String> = v["errors"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter_map(|e| e.as_str().or_else(|| e["message"].as_str()))
                            .map(str::to_owned)
                            .collect()
                    })
                    .unwrap_or_default();
                if !details.is_empty() {
                    msg = format!(
                        "{msg} ; {}",
                        self.clean(root, details.join(" ; ").as_bytes())
                    );
                }
            }
            return Err(ForgeError::Failed(format!("gh : {msg}")));
        }
        parse_review_url(&out.stdout)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::forge::pulls::{ChecksState, ForgeReviewComment, summarize_checks};

    const LIST: &[u8] = include_bytes!("../../../tests/fixtures/forge/gh-pr-list.json");
    const VIEW: &[u8] = include_bytes!("../../../tests/fixtures/forge/gh-pr-view.json");
    const FILES: &[u8] = include_bytes!("../../../tests/fixtures/forge/rest-pull-files.ndjson");
    const THREADS: &[u8] =
        include_bytes!("../../../tests/fixtures/forge/graphql-review-threads.json");
    const DIFF: &[u8] = include_bytes!("../../../tests/fixtures/forge/gh-pr-diff.txt");
    const PATCHES: &[u8] = include_bytes!("../../../tests/fixtures/forge/rest-pull-patches.ndjson");
    const CREATED: &[u8] = include_bytes!("../../../tests/fixtures/forge/rest-review-created.json");

    #[test]
    fn recorded_pull_list_is_parsed() {
        let pulls = parse_gh_pulls(LIST).unwrap();
        assert_eq!(pulls.len(), 2);
        let p = &pulls[0];
        assert_eq!(p.number, 21);
        assert_eq!(p.state, PullState::Open);
        assert!(!p.draft);
        assert_eq!(p.url, "https://github.com/BadRom1/DevMaestro/pull/21");
        assert_eq!(p.author.as_deref(), Some("BadRom1"));
        assert_eq!(p.head_branch, "13b-forge-revue");
        assert_eq!(p.head_sha, "04b392947395d0fc415e8fc028b358707f4df18c");
        assert_eq!(p.base_branch, "main");
        assert_eq!((p.additions, p.deletions, p.changed_files), (55, 7, 6));
        assert_eq!(p.head_owner.as_deref(), Some("BadRom1"));
        assert_eq!(p.review_decision, Some(ReviewDecision::ReviewRequired));
        assert_eq!(p.labels[0].name, "forge");
        assert!(p.body.is_none());
        // 4 vérifications, dont une relance en double ramenée à la plus récente.
        assert_eq!(p.checks.len(), 4);
        let s = summarize_checks(&p.checks);
        assert_eq!(s.state, ChecksState::Failure);
        assert_eq!((s.total, s.passed, s.failed, s.pending), (4, 2, 1, 1));
        let lint = p.checks.iter().find(|c| c.name == "lint").unwrap();
        assert_eq!(lint.state, CheckState::Success, "la relance l'emporte");
        assert_eq!(lint.workflow.as_deref(), Some("Lint"));
        let status = p.checks.iter().find(|c| c.name == "ci/externe").unwrap();
        assert_eq!(status.workflow, None);
        assert_eq!(status.state, CheckState::Pending);
        assert_eq!(status.url, None, "URL non web écartée");
        let q = &pulls[1];
        assert_eq!(q.state, PullState::Merged);
        assert!(q.draft);
        assert_eq!(q.author.as_deref(), Some("app/dependabot"));
        assert_eq!(q.review_decision, None);
        assert!(q.checks.is_empty());
        assert!(q.cross_repository);
        assert_eq!(q.head_owner.as_deref(), Some("fourche"));
        assert!(matches!(parse_gh_pulls(b"{}"), Err(ForgeError::Failed(_))));
    }

    #[test]
    fn recorded_pull_view_files_and_threads_are_parsed() {
        let p = parse_gh_pull(VIEW).unwrap();
        assert_eq!(p.number, 21);
        assert_eq!(
            p.body.as_deref(),
            Some("## Contexte\n\nLot 13b : revue des demandes de fusion.\n")
        );
        assert!(!p.body_truncated);
        let c = p.checks.iter().find(|c| c.name == "build").unwrap();
        assert_eq!(
            c.url.as_deref(),
            Some("https://github.com/BadRom1/DevMaestro/actions/runs/1/job/2")
        );
        assert_eq!(c.started_at.as_deref(), Some("2026-10-20T16:40:48Z"));
        assert_eq!(c.completed_at.as_deref(), Some("2026-10-20T16:46:24Z"));

        let (files, truncated) = parse_rest_pull_files(FILES).unwrap();
        assert!(!truncated);
        let summary: Vec<_> = files
            .iter()
            .map(|f| (f.path.as_str(), f.status.as_str(), f.old_path.as_deref()))
            .collect();
        assert_eq!(
            summary,
            vec![
                ("crates/core/src/domain/forge.rs", "M", None),
                ("crates/core/src/domain/forge/pulls.rs", "A", None),
                ("docs/ancien.md", "D", None),
                ("docs/nouveau nom.md", "R", Some("docs/vieux nom.md")),
                ("app/icone.png", "M", None),
                ("docs/été.md", "M", None),
            ]
        );
        assert_eq!((files[0].additions, files[0].deletions), (3, 1));

        let (threads, truncated) = parse_review_threads(THREADS).unwrap();
        assert!(!truncated);
        assert_eq!(threads.len(), 2);
        let t = &threads[0];
        assert_eq!(t.path, "crates/core/src/domain/forge.rs");
        assert_eq!(
            (t.line, t.side, t.resolved, t.outdated),
            (Some(12), Side::New, false, false)
        );
        assert_eq!(t.comments.len(), 2);
        assert_eq!(t.comments[0].author.as_deref(), Some("relecteur"));
        assert_eq!(t.comments[0].body, "Pourquoi ce délai ?");
        assert_eq!(t.comments[1].author, None, "compte supprimé");
        assert!(!t.comments_truncated);
        let t = &threads[1];
        assert_eq!(
            (t.line, t.side, t.resolved, t.outdated),
            (None, Side::Old, true, true)
        );
        assert!(t.comments_truncated);
        assert!(parse_review_threads(b"{\"data\":null}").is_err());
    }

    #[test]
    fn recorded_pull_diff_is_split_by_file() {
        let files = split_unified_diff(DIFF);
        let names: Vec<&str> = files.iter().map(|(p, _)| p.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "crates/core/src/domain/forge.rs",
                "crates/core/src/domain/forge/pulls.rs",
                "docs/ancien.md",
                "docs/nouveau nom.md",
                "app/icone.png",
                "docs/été.md",
            ]
        );
        let (_, forge) = &files[0];
        assert_eq!(forge.hunks.len(), 1);
        assert_eq!(forge.hunks[0].new_start, 10);
        assert!(
            forge.hunks[0]
                .lines
                .iter()
                .any(|l| l.new_no == Some(12) && l.kind == '+')
        );
        assert!(
            forge.hunks[0]
                .lines
                .iter()
                .any(|l| l.old_no == Some(12) && l.kind == '-')
        );
        assert_eq!(files[1].1.hunks[0].lines.len(), 3);
        assert!(files[2].1.hunks[0].lines.iter().all(|l| l.kind == '-'));
        assert!(files[3].1.hunks.is_empty(), "renommage sans changement");
        assert!(files[4].1.binary);
        assert_eq!(files[5].1.hunks[0].lines[1].text, "Été");
    }

    #[test]
    fn rest_patches_replace_a_diff_too_large_for_gh() {
        let files = parse_rest_patches(PATCHES).unwrap();
        let names: Vec<&str> = files.iter().map(|(p, _)| p.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "crates/core/src/domain/forge.rs",
                "crates/core/src/domain/forge/pulls.rs",
                "docs/ancien.md",
                "docs/nouveau nom.md",
                "app/icone.png",
                "données/énorme.json",
            ]
        );
        // Mêmes hunks que par `gh pr diff`.
        let from_diff = split_unified_diff(DIFF);
        for i in 0..3 {
            assert_eq!(files[i], from_diff[i], "{}", files[i].0);
        }
        assert_eq!(files[3].1, FileDiff::default(), "renommage pur");
        assert!(files[4].1.binary);
        assert!(files[5].1.too_large);
        let big = json!({"filename": "g", "status": "modified", "additions": 1, "deletions": 0,
                         "patch": format!("@@ -1 +1 @@\n+{}", "x".repeat(MAX_FILE_BYTES as usize))});
        let big = parse_rest_patches(big.to_string().as_bytes()).unwrap();
        assert!(big[0].1.too_large);
        assert!(parse_rest_patches(b"pas du json").is_err());
        assert!(is_diff_too_large(
            b"could not find pull request diff: HTTP 406: Sorry, the diff exceeded the maximum number of files (300)."
        ));
        assert!(!is_diff_too_large(b"HTTP 404"));
    }

    #[test]
    fn review_payload_and_response() {
        let review = ForgeReview::new(
            "04b392947395d0fc415e8fc028b358707f4df18c",
            ReviewEvent::RequestChanges,
            "Quelques remarques",
            vec![
                ForgeReviewComment {
                    path: "a.rs".into(),
                    line: 12,
                    side: Side::New,
                    body: "ici".into(),
                },
                ForgeReviewComment {
                    path: "b.rs".into(),
                    line: 3,
                    side: Side::Old,
                    body: "là".into(),
                },
            ],
        )
        .unwrap();
        assert_eq!(
            review_payload(&review),
            json!({
                "commit_id": "04b392947395d0fc415e8fc028b358707f4df18c",
                "event": "REQUEST_CHANGES",
                "body": "Quelques remarques",
                "comments": [
                    {"path": "a.rs", "line": 12, "side": "RIGHT", "body": "ici"},
                    {"path": "b.rs", "line": 3, "side": "LEFT", "body": "là"},
                ],
            })
        );
        for (event, want) in [
            (ReviewEvent::Comment, "COMMENT"),
            (ReviewEvent::Approve, "APPROVE"),
        ] {
            let r = ForgeReview::new(&"a".repeat(40), event, "x", vec![]).unwrap();
            assert_eq!(review_payload(&r)["event"], want);
            assert_eq!(review_payload(&r)["comments"], json!([]));
        }
        assert_eq!(
            parse_review_url(CREATED).unwrap(),
            "https://github.com/BadRom1/DevMaestro/pull/21#pullrequestreview-80"
        );
        assert!(parse_review_url(br#"{"html_url":"javascript:x"}"#).is_err());
    }

    #[test]
    fn pull_texts_are_cleaned() {
        let mut v: Value = serde_json::from_slice(VIEW).unwrap();
        v["title"] = "Titre\u{202E} caché\nici".into();
        v["body"] = "a\r\nb\u{200B}\u{E0041}\u{1b}".into();
        let p = parse_gh_pull(&serde_json::to_vec(&v).unwrap()).unwrap();
        assert_eq!(p.title, "Titre caché ici");
        assert_eq!(p.body.as_deref(), Some("a\nb"));
        v["body"] = Value::String("é".repeat(40_000));
        let p = parse_gh_pull(&serde_json::to_vec(&v).unwrap()).unwrap();
        assert!(p.body_truncated);
    }
}
