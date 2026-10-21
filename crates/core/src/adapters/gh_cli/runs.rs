//! Exécutions de workflows de GitHub Actions par `gh` (v0.3, lot 14b) :
//! `gh run list --json`, `gh run view --json` (jobs et étapes) et `gh run
//! view --log-failed` (journaux des étapes en échec, nettoyés et bornés par
//! le domaine).

use std::path::Path;

use serde_json::Value;

use super::{GhRun, GithubCli, invalid};
use crate::domain::forge::RemoteRepo;
use crate::domain::forge::pulls::{CheckState, normalize_sha};
use crate::domain::forge::runs::{
    MAX_FAILURE_LOGS_BYTES, MAX_JOB_LOG_BYTES, MAX_RUN_JOBS, Run, RunFailure, RunFilter, RunJob,
    RunStatus, bound_job_logs, clean_name, normalize_conclusion, parse_failed_log, run_state,
};
use crate::ports::ForgeError;

/// Champs demandés à `gh run list --json` (vérifiés avec gh 2.87.2 : `gh run
/// list --json` sans valeur liste les champs disponibles).
pub const RUN_FIELDS: &str = "databaseId,name,workflowName,status,conclusion,url,headSha,headBranch,event,createdAt,updatedAt";
/// Champs demandés à `gh run view --json` : ceux de la liste et les jobs
/// (avec leurs étapes ; vérifiés avec gh 2.87.2).
pub const RUN_VIEW_FIELDS: &str = "databaseId,name,workflowName,status,conclusion,url,headSha,\
headBranch,event,createdAt,updatedAt,jobs";

/// URL `https://` sans blanc ni caractère de contrôle ; autre chose : `None`.
fn https_url(v: &Value) -> Option<String> {
    v.as_str()
        .filter(|u| {
            u.starts_with("https://") && !u.chars().any(|c| c.is_control() || c.is_whitespace())
        })
        .map(str::to_owned)
}

fn opt_text(v: &Value) -> Option<String> {
    v.as_str().map(clean_name).filter(|s| !s.is_empty())
}

/// Une exécution de `gh run list/view --json` ; `None` si illisible.
fn run_of(v: &Value) -> Option<Run> {
    let status = RunStatus::parse(v["status"].as_str()?)?;
    let conclusion = v["conclusion"].as_str().and_then(normalize_conclusion);
    Some(Run {
        id: v["databaseId"].as_u64().filter(|n| *n > 0)?,
        name: clean_name(v["name"].as_str().unwrap_or("")),
        workflow: opt_text(&v["workflowName"]),
        status,
        state: run_state(status, conclusion.as_deref()),
        conclusion,
        url: https_url(&v["url"]),
        head_sha: normalize_sha(v["headSha"].as_str()?)?,
        branch: opt_text(&v["headBranch"]),
        event: opt_text(&v["event"]),
        created_at: v["createdAt"].as_str().map(clean_name),
        updated_at: v["updatedAt"].as_str().map(clean_name),
    })
}

/// `gh run list --json` [`RUN_FIELDS`] : les entrées illisibles sont écartées.
pub fn parse_gh_runs(stdout: &[u8]) -> Result<Vec<Run>, ForgeError> {
    let v: Value = serde_json::from_slice(stdout).map_err(|_| invalid())?;
    Ok(v.as_array()
        .ok_or_else(invalid)?
        .iter()
        .filter_map(run_of)
        .collect())
}

/// Étape en échec : conclusion autre que `success`, `skipped`, `neutral`,
/// `cancelled` (une étape annulée suit un échec ou une annulation).
fn step_failed(conclusion: Option<&str>) -> bool {
    conclusion.is_some_and(|c| {
        !matches!(
            c.to_ascii_lowercase().as_str(),
            "success" | "skipped" | "neutral" | "cancelled" | ""
        )
    })
}

/// `gh run view --json` [`RUN_VIEW_FIELDS`] : l'exécution et ses jobs en
/// échec ou annulés (au plus [`MAX_RUN_JOBS`] lus).
pub fn parse_gh_run_view(stdout: &[u8]) -> Result<(Run, Vec<RunJob>), ForgeError> {
    let v: Value = serde_json::from_slice(stdout).map_err(|_| invalid())?;
    let run = run_of(&v).ok_or_else(invalid)?;
    let jobs = v["jobs"]
        .as_array()
        .map(|a| {
            a.iter()
                .take(MAX_RUN_JOBS)
                .filter_map(|j| {
                    let status = RunStatus::parse(j["status"].as_str()?)?;
                    let conclusion = j["conclusion"].as_str().and_then(normalize_conclusion);
                    let state = run_state(status, conclusion.as_deref());
                    if !matches!(state, CheckState::Failure | CheckState::Cancelled) {
                        return None;
                    }
                    let failed_steps = j["steps"]
                        .as_array()
                        .map(|s| {
                            s.iter()
                                .filter(|s| step_failed(s["conclusion"].as_str()))
                                .filter_map(|s| opt_text(&s["name"]))
                                .take(20)
                                .collect()
                        })
                        .unwrap_or_default();
                    Some(RunJob {
                        name: clean_name(j["name"].as_str()?),
                        state,
                        conclusion,
                        url: https_url(&j["url"]),
                        failed_steps,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok((run, jobs))
}

/// La sortie d'erreur dit-elle que l'exécution n'existe pas ?
fn is_not_found(stderr: &[u8]) -> bool {
    let err = String::from_utf8_lossy(stderr);
    err.contains("HTTP 404") || err.contains("could not find any workflow run")
}

/// La sortie d'erreur dit-elle que l'exécution n'est pas finie ?
fn is_in_progress(stderr: &[u8]) -> bool {
    String::from_utf8_lossy(stderr).contains("still in progress")
}

fn not_found(id: u64) -> ForgeError {
    ForgeError::NotFound(format!("exécution de CI n° {id} introuvable"))
}

impl GithubCli {
    pub(super) fn gh_runs(
        &self,
        root: &Path,
        remote: &RemoteRepo,
        filter: &RunFilter,
    ) -> Result<(Vec<Run>, bool), ForgeError> {
        let repo = remote.slug();
        let limit = format!("--limit={}", filter.limit + 1);
        let mut args = vec!["run", "list", "--repo", &repo, "--json", RUN_FIELDS, &limit];
        // Valeurs validées en amont, toujours `--option=valeur`.
        let branch = filter.branch.as_ref().map(|b| format!("--branch={b}"));
        let commit = filter.sha.as_ref().map(|s| format!("--commit={s}"));
        args.extend(branch.as_deref());
        args.extend(commit.as_deref());
        let out = self.call(root, &remote.host, &args)?;
        if !out.ok {
            return Err(self.failed(root, &out));
        }
        let mut runs = parse_gh_runs(&out.stdout)?;
        let truncated = runs.len() > filter.limit;
        runs.truncate(filter.limit);
        Ok((runs, truncated))
    }

    pub(super) fn gh_run_failure(
        &self,
        root: &Path,
        remote: &RemoteRepo,
        id: u64,
    ) -> Result<RunFailure, ForgeError> {
        let (n, repo) = (id.to_string(), remote.slug());
        let out = self.call(
            root,
            &remote.host,
            &[
                "run",
                "view",
                &n,
                "--repo",
                &repo,
                "--json",
                RUN_VIEW_FIELDS,
            ],
        )?;
        if !out.ok {
            if is_not_found(&out.stderr) {
                return Err(not_found(id));
            }
            return Err(self.failed(root, &out));
        }
        let (run, failed_jobs) = parse_gh_run_view(&out.stdout)?;
        let mut failure = RunFailure {
            run,
            failed_jobs,
            logs: Vec::new(),
            truncated: false,
            in_progress: false,
        };
        if failure.run.status != RunStatus::Completed {
            failure.in_progress = true;
            return Ok(failure);
        }
        if failure.failed_jobs.is_empty() {
            return Ok(failure);
        }
        let run = self
            .gh
            .run_tail(&["run", "view", &n, "--repo", &repo, "--log-failed"]);
        // Journal plus gros que la sortie lue (8 Mio) : sa **fin** est gardée
        // (l'erreur y est), signalé comme coupé.
        let (stdout, cut) = match run {
            GhRun::Done(o) if o.truncated => (o.stdout, true),
            other => {
                let out = self.done(root, &remote.host, other)?;
                if !out.ok {
                    if is_in_progress(&out.stderr) {
                        failure.in_progress = true;
                        return Ok(failure);
                    }
                    if is_not_found(&out.stderr) {
                        return Err(not_found(id));
                    }
                    return Err(self.failed(root, &out));
                }
                (out.stdout, false)
            }
        };
        // Coupé : la première ligne lue est partielle (job et étape perdus).
        let stdout = match (cut, stdout.iter().position(|b| *b == b'\n')) {
            (true, Some(nl)) => &stdout[nl + 1..],
            _ => &stdout[..],
        };
        let (logs, truncated) = bound_job_logs(
            parse_failed_log(stdout),
            MAX_JOB_LOG_BYTES,
            MAX_FAILURE_LOGS_BYTES,
        );
        failure.logs = logs;
        failure.truncated = truncated || cut;
        Ok(failure)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIST: &[u8] = include_bytes!("../../../tests/fixtures/forge/gh-run-list.json");
    const VIEW: &[u8] = include_bytes!("../../../tests/fixtures/forge/gh-run-view.json");

    #[test]
    fn recorded_run_list_is_parsed() {
        let runs = parse_gh_runs(LIST).unwrap();
        assert_eq!(runs.len(), 4);
        assert_eq!(runs[0].status, RunStatus::InProgress);
        assert_eq!(runs[0].state, CheckState::Pending);
        assert_eq!(runs[0].conclusion, None);
        let r = &runs[1];
        assert_eq!(r.id, 39574909280);
        assert_eq!(r.name, "Lint");
        assert_eq!(r.workflow.as_deref(), Some("Lint"));
        assert_eq!(r.conclusion.as_deref(), Some("failure"));
        assert_eq!(r.state, CheckState::Failure);
        assert_eq!(r.head_sha, "07c63c05e44d151560e29ca0f16b4d573057e128");
        assert_eq!(
            r.branch.as_deref(),
            Some("babakks/refresh-token-a-foundation")
        );
        assert_eq!(r.event.as_deref(), Some("pull_request"));
        assert_eq!(
            r.url.as_deref(),
            Some("https://github.com/cli/cli/actions/runs/39574909280")
        );
        // Entrées illisibles écartées, textes nettoyés, lien douteux retiré.
        let odd = br#"[{"databaseId":0,"status":"completed","headSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
            {"databaseId":5,"status":"??","headSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
            {"databaseId":6,"status":"completed","headSha":"court"},
            {"databaseId":7,"status":"completed","conclusion":"success","name":"a\u202eb\nc",
             "url":"javascript:alert(1)","headSha":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}]"#;
        let odd = parse_gh_runs(odd).unwrap();
        assert_eq!(odd.len(), 1);
        assert_eq!(odd[0].name, "ab c");
        assert_eq!(odd[0].url, None);
        assert_eq!(odd[0].head_sha, "a".repeat(40));
        assert!(matches!(parse_gh_runs(b"{}"), Err(ForgeError::Failed(_))));
    }

    #[test]
    fn a_log_larger_than_the_bound_keeps_its_end() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let view = dir.path().join("view.json");
        std::fs::write(&view, VIEW).unwrap();
        let bin = dir.path().join("gh");
        std::fs::write(
            &bin,
            format!(
                "#!/bin/sh\ncase \"$*\" in\n  *--log-failed*)\n    i=0; while [ $i -lt 2000 ]; do printf 'lint\\tTest\\t2026-10-21T09:10:50.1Z remplissage %s\\n' $i; i=$((i+1)); done\n    printf 'lint\\tTest\\t2026-10-21T09:10:59.1Z ERREUR FINALE\\n' ;;\n  *) cat '{}' ;;\nesac\n",
                view.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut cli = GithubCli::new(Some(bin), std::time::Duration::from_secs(10));
        cli.gh.max_output = 8 * 1024;
        let remote = crate::domain::forge::parse_remote_url("git@github.com:o/r.git").unwrap();
        // Script tout juste écrit : un autre test peut le tenir ouvert (ETXTBSY).
        let mut f = None;
        for _ in 0..50 {
            match cli.gh_run_failure(Path::new("/"), &remote, 39574909280) {
                Err(ForgeError::Failed(m)) if m.contains("os error 26") => {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                other => {
                    f = Some(other.unwrap());
                    break;
                }
            }
        }
        let f = f.expect("lancement impossible");
        assert!(f.truncated);
        let text = &f.logs[0].text;
        assert!(text.trim_end().ends_with("ERREUR FINALE"), "{text}");
        assert!(!text.contains("remplissage 0\n"), "le début est coupé");
    }

    #[test]
    fn recorded_run_view_keeps_failed_jobs_and_steps() {
        let (run, jobs) = parse_gh_run_view(VIEW).unwrap();
        assert_eq!(run.id, 39574909280);
        assert_eq!(run.status, RunStatus::Completed);
        assert_eq!(jobs.len(), 1, "le job réussi n'est pas gardé");
        assert_eq!(jobs[0].name, "lint");
        assert_eq!(
            jobs[0].failed_steps,
            vec!["Ensure Go source and modules are up to date".to_owned()]
        );
        assert_eq!(
            jobs[0].url.as_deref(),
            Some("https://github.com/cli/cli/actions/runs/39574909280/job/119137909038")
        );
    }
}
