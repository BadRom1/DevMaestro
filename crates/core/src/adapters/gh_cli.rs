//! Forge GitHub par la CLI `gh` de l'utilisateur (ADR 0006, v0.3 lots 13a
//! et 13b ; demandes de fusion et revue : [`pulls`]).
//!
//! Le démon ne tient aucun jeton et n'ouvre aucune connexion lui-même : il
//! lance `gh` (arguments séparés, jamais de shell, délai, sortie bornée,
//! environnement maîtrisé) dans le dossier du dépôt ; l'authentification,
//! le mandataire et l'hôte (github.com ou GitHub Enterprise) sont ceux de
//! l'utilisateur.
//!
//! **Environnement** : celui du démon, moins les variables qui changeraient
//! en silence le compte ou l'hôte visé (`GH_TOKEN`, `GITHUB_TOKEN`,
//! `GH_ENTERPRISE_TOKEN`, `GH_HOST`, `GH_REPO`…, toutes les `GH_*` et
//! `GITHUB_*` sauf `GH_CONFIG_DIR`) ou qui feraient écrire des secrets sur la
//! sortie d'erreur (`GH_DEBUG`, `DEBUG`) : `gh` se sert donc de la connexion
//! enregistrée par `gh auth login` (trousseau ou `hosts.yml`). Les variables
//! du trousseau (`DBUS_SESSION_BUS_ADDRESS`, `XDG_RUNTIME_DIR`) et du
//! mandataire (`HTTPS_PROXY`…) sont gardées.

use std::io::Read;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use nix::sys::wait::{Id, WaitPidFlag, WaitStatus, waitid};
use serde_json::Value;

use super::git_exec::GitExec;
use crate::domain::forge::{
    Capabilities, ForgeKind, ForgeStatus, Issue, IssueFilter, IssueRef, IssueState, Label,
    MAX_REPO_LABELS, RemoteRepo, RepoLabel, SubIssuesSummary, clean_message, clean_text, one_line,
    parse_remote_url, truncate_body,
};
use crate::ports::{Forge, ForgeError};

pub mod pulls;

/// Délai maximal d'un appel à `gh`.
pub const GH_TIMEOUT: Duration = Duration::from_secs(15);
/// Sortie maximale lue d'un appel à `gh` (au-delà : réponse refusée).
pub const MAX_GH_OUTPUT: usize = 8 * 1024 * 1024;
/// Entrée standard écrite au plus (`gh api --input -`).
pub const MAX_GH_INPUT: usize = 8 * 1024 * 1024;
/// Sortie d'erreur gardée au plus.
const MAX_STDERR: u64 = 64 * 1024;
/// Sous-issues lues au plus : GitHub en permet 100 par issue parente, en une
/// page (`per_page` va jusqu'à 100).
pub const MAX_SUB_ISSUES: usize = 100;
/// Hôte public de GitHub.
pub const GITHUB_HOST: &str = "github.com";

/// Champs demandés à `gh issue list --json` (vérifiés avec gh 2.87.2 :
/// `gh issue list --json` sans valeur liste les champs disponibles).
pub const LIST_FIELDS: &str = "number,title,state,url,author,labels,assignees,updatedAt";

/// Champs demandés à `gh label list --json` (vérifiés avec gh 2.87.2).
pub const LABEL_FIELDS: &str = "name,color,description";

/// Valeur d'une option « liste » de `gh` (`--label strings` : lue comme une
/// ligne CSV par pflag) qui reste **une** valeur : entre guillemets, `"`
/// doublés, si elle contient `,` ou `"` (un nom `a,b` ne devient pas deux
/// étiquettes). Les contrôles (dont les fins de ligne) sont refusés en amont.
pub fn csv_value(s: &str) -> String {
    if s.contains([',', '"']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_owned()
    }
}

/// Variables posées pour chaque appel.
const FIXED_ENV: &[(&str, &str)] = &[
    ("GH_PROMPT_DISABLED", "1"),
    ("GH_NO_UPDATE_NOTIFIER", "1"),
    ("GH_NO_EXTENSION_UPDATE_NOTIFIER", "1"),
    ("GH_SPINNER_DISABLED", "1"),
    ("GH_PAGER", "cat"),
    ("NO_COLOR", "1"),
    ("CLICOLOR", "0"),
    ("GIT_TERMINAL_PROMPT", "0"),
];

/// Variable héritée retirée de l'environnement de `gh` (voir le module).
pub fn is_removed_env(name: &str) -> bool {
    (name.starts_with("GH_") && name != "GH_CONFIG_DIR")
        || name.starts_with("GITHUB_")
        || name == "DEBUG"
        || name == "CLICOLOR_FORCE"
        || name.starts_with("ORCH_")
        || name.starts_with("DEVMAESTRO_")
}

/// Résultat d'un appel à `gh` terminé.
#[derive(Debug)]
pub struct GhOut {
    pub ok: bool,
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    /// Sortie coupée à [`MAX_GH_OUTPUT`].
    pub truncated: bool,
}

/// Issue d'un lancement de `gh`.
#[derive(Debug)]
pub enum GhRun {
    Done(GhOut),
    /// Binaire introuvable.
    Missing,
    /// Tué au bout du délai.
    TimedOut,
    /// Lancement impossible pour une autre raison.
    SpawnFailed(String),
}

/// Dossier neutre d'où `gh` est lancé : `--repo` et `--hostname` sont
/// toujours donnés, `gh` n'a pas à lire le dépôt (ni sa configuration git).
pub const NEUTRAL_DIR: &str = "/";

/// Programme `name` cherché dans les dossiers **absolus** de `path` (un
/// composant relatif, vide compris, est ignoré : il dépendrait du dossier
/// courant) ; fichier ordinaire exécutable. Un `name` qui contient un `/`
/// n'est pris que s'il est absolu (et exécutable).
pub fn resolve_program(name: &std::ffi::OsStr, path: Option<&std::ffi::OsStr>) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    let executable = |p: &Path| {
        std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
    };
    let as_path = Path::new(name);
    if as_path.components().count() > 1 || as_path.is_absolute() {
        return (as_path.is_absolute() && executable(as_path)).then(|| as_path.to_path_buf());
    }
    std::env::split_paths(path?)
        .filter(|d| d.is_absolute())
        .map(|d| d.join(name))
        .find(|p| executable(p))
}

/// Lanceur durci de `gh`.
#[derive(Debug, Clone)]
pub struct GhExec {
    /// Chemin absolu de `gh`, résolu une fois (`None` : introuvable).
    program: Option<PathBuf>,
    timeout: Duration,
    max_output: usize,
}

impl GhExec {
    /// `program` : chemin absolu déjà résolu, ou `None` (introuvable).
    pub fn new(program: Option<PathBuf>, timeout: Duration) -> Self {
        Self {
            program,
            timeout,
            max_output: MAX_GH_OUTPUT,
        }
    }

    /// Lance `gh <args>` depuis [`NEUTRAL_DIR`], dans son propre groupe de
    /// processus (tué en entier au bout du délai, et après sa fin : aucun
    /// descendant ne survit), entrée fermée.
    pub fn run(&self, args: &[&str]) -> GhRun {
        self.run_with(args, None)
    }

    /// Comme [`GhExec::run`], avec `input` écrit sur l'entrée standard (puis
    /// fermée) : de quoi passer un document (`gh api --input -`) sans jamais
    /// le mettre dans les arguments, visibles de tout processus. Au plus
    /// [`MAX_GH_INPUT`] octets (au-delà : rien n'est lancé).
    pub fn run_input(&self, args: &[&str], input: &[u8]) -> GhRun {
        if input.len() > MAX_GH_INPUT {
            return GhRun::SpawnFailed(format!(
                "entrée trop volumineuse ({} Mio au plus)",
                MAX_GH_INPUT / (1024 * 1024)
            ));
        }
        self.run_with(args, Some(input.to_vec()))
    }

    fn run_with(&self, args: &[&str], input: Option<Vec<u8>>) -> GhRun {
        let Some(program) = &self.program else {
            return GhRun::Missing;
        };
        let mut command = Command::new(program);
        command
            .args(args)
            .current_dir(NEUTRAL_DIR)
            .stdin(if input.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0);
        for (name, _) in std::env::vars_os() {
            if name.to_str().is_none_or(is_removed_env) {
                command.env_remove(&name);
            }
        }
        command.envs(FIXED_ENV.iter().copied());
        let mut child = match command.spawn() {
            Ok(c) => c,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return GhRun::Missing,
            Err(e) => return GhRun::SpawnFailed(e.to_string()),
        };
        let pgid = child.id() as i32;
        // Écriture dans un fil à part : si `gh` ne lit pas son entrée, le fil
        // reste bloqué jusqu'à la fin (ou la mort) du groupe, qui ferme le
        // tube (erreur d'écriture, SIGPIPE ignoré par Rust).
        let writer = match (input, child.stdin.take()) {
            (Some(bytes), Some(mut stdin)) => Some(std::thread::spawn(move || {
                use std::io::Write;
                let _ = stdin.write_all(&bytes);
            })),
            _ => None,
        };
        let mut stdout = child.stdout.take().expect("piped");
        let mut stderr = child.stderr.take().expect("piped");
        let max = self.max_output as u64;
        let reader = std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = (&mut stdout).take(max + 1).read_to_end(&mut buf);
            let _ = std::io::copy(&mut stdout, &mut std::io::sink());
            buf
        });
        let err_reader = std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = (&mut stderr).take(MAX_STDERR).read_to_end(&mut buf);
            let _ = std::io::copy(&mut stderr, &mut std::io::sink());
            buf
        });
        let deadline = Instant::now() + self.timeout;
        // Fin constatée sans récolter le processus (`WNOWAIT`) : tant qu'il
        // reste un zombie, son numéro de groupe ne peut pas être réattribué,
        // et le groupe peut être tué sans risque (un descendant resté en vie
        // garderait les tubes ouverts).
        let pid = nix::unistd::Pid::from_raw(pgid);
        let flags = WaitPidFlag::WEXITED | WaitPidFlag::WNOHANG | WaitPidFlag::WNOWAIT;
        loop {
            match waitid(Id::Pid(pid), flags) {
                Ok(WaitStatus::StillAlive) | Err(nix::errno::Errno::EINTR)
                    if Instant::now() < deadline =>
                {
                    std::thread::sleep(Duration::from_millis(5));
                }
                Ok(WaitStatus::StillAlive) | Err(nix::errno::Errno::EINTR) => {
                    kill_group(pgid);
                    let _ = child.wait();
                    return GhRun::TimedOut;
                }
                Ok(_) => break,
                Err(e) => {
                    kill_group(pgid);
                    let _ = child.wait();
                    return GhRun::SpawnFailed(e.to_string());
                }
            }
        }
        kill_group(pgid);
        let status = match child.wait() {
            Ok(s) => s,
            Err(e) => return GhRun::SpawnFailed(e.to_string()),
        };
        let mut stdout = reader.join().unwrap_or_default();
        let stderr = err_reader.join().unwrap_or_default();
        if let Some(w) = writer {
            let _ = w.join();
        }
        let truncated = stdout.len() > self.max_output;
        stdout.truncate(self.max_output);
        GhRun::Done(GhOut {
            ok: status.success(),
            code: status.code(),
            stdout,
            stderr,
            truncated,
        })
    }
}

fn kill_group(pgid: i32) {
    let _ = nix::sys::signal::killpg(
        nix::unistd::Pid::from_raw(pgid),
        nix::sys::signal::Signal::SIGKILL,
    );
}

/// Connexion de `gh` à un hôte.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Auth {
    Ok,
    /// `gh` introuvable.
    Missing,
    /// Aucun compte pour cet hôte (hôte inconnu de `gh`).
    NotLoggedIn,
    /// Compte connu mais connexion en échec (jeton refusé, hôte injoignable…).
    Failed(String),
}

/// [`Forge`] GitHub par `gh`.
#[derive(Debug, Clone)]
pub struct GithubCli {
    gh: GhExec,
    git: GitExec,
}

impl Default for GithubCli {
    /// `gh` cherché dans le `PATH` du démon (dossiers absolus seulement).
    fn default() -> Self {
        let path = std::env::var_os("PATH");
        Self::new(resolve_program("gh".as_ref(), path.as_deref()), GH_TIMEOUT)
    }
}

/// Raison quand `gh` est introuvable.
pub const GH_MISSING: &str = "la CLI gh est introuvable : installez-la (https://cli.github.com) puis lancez « gh auth login »";

fn login_hint(host: &str) -> String {
    if host == GITHUB_HOST {
        "gh auth login".into()
    } else {
        format!("gh auth login --hostname {host}")
    }
}

fn not_logged_in(host: &str) -> String {
    format!(
        "gh n'est pas connecté à {host} : lancez « {} »",
        login_hint(host)
    )
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
}

impl GithubCli {
    /// `program` : chemin absolu de `gh` déjà résolu, ou `None`.
    pub fn new(program: Option<PathBuf>, timeout: Duration) -> Self {
        Self {
            gh: GhExec::new(program, timeout),
            git: GitExec::default(),
        }
    }

    /// `gh` résolu **au démarrage** dans le `PATH` du démon (un `gh` installé
    /// ensuite demande de redémarrer le démon), délai de 15 s. Un binaire de
    /// test (`test-support`) lit `DEVMAESTRO_GH_BIN` (chemin absolu) et
    /// `DEVMAESTRO_GH_TIMEOUT_MS` ; le binaire distribué les ignore.
    pub fn from_env() -> Self {
        #[cfg(feature = "test-support")]
        if let Some(bin) = std::env::var_os("DEVMAESTRO_GH_BIN").filter(|p| !p.is_empty()) {
            let timeout = std::env::var("DEVMAESTRO_GH_TIMEOUT_MS")
                .ok()
                .and_then(|v| v.parse::<u64>().ok())
                .map_or(GH_TIMEOUT, Duration::from_millis);
            return Self::new(resolve_program(&bin, None), timeout);
        }
        Self::default()
    }

    /// Connexion de `gh` à `host` : `gh auth status --json hosts --hostname
    /// <hôte>` (qui sort en 0 même sans compte : `hosts` vide), sinon, pour
    /// un `gh` sans `--json`, le code de sortie de `gh auth status --hostname`.
    fn auth(&self, host: &str) -> Auth {
        let out = match self
            .gh
            .run(&["auth", "status", "--json", "hosts", "--hostname", host])
        {
            GhRun::Done(o) => o,
            GhRun::Missing => return Auth::Missing,
            GhRun::TimedOut => {
                return Auth::Failed(format!(
                    "gh n'a pas répondu à temps en vérifiant la connexion à {host}"
                ));
            }
            GhRun::SpawnFailed(e) => {
                return Auth::Failed(format!("gh : lancement impossible : {e}"));
            }
        };
        if let Some(auth) = auth_from_json(&out.stdout, host).filter(|_| out.ok) {
            return auth;
        }
        match self.gh.run(&["auth", "status", "--hostname", host]) {
            GhRun::Done(o) if o.ok => Auth::Ok,
            GhRun::Done(_) => Auth::NotLoggedIn,
            GhRun::Missing => Auth::Missing,
            GhRun::TimedOut => Auth::Failed(format!(
                "gh n'a pas répondu à temps en vérifiant la connexion à {host}"
            )),
            GhRun::SpawnFailed(e) => Auth::Failed(format!("gh : lancement impossible : {e}")),
        }
    }

    /// Appel de `gh` qui doit réussir : sortie standard, ou l'erreur
    /// (`gh` absent ou non connecté : forge indisponible).
    fn call(&self, root: &Path, host: &str, args: &[&str]) -> Result<GhOut, ForgeError> {
        self.done(root, host, self.gh.run(args))
    }

    /// Issue d'un lancement de `gh` ramenée à sa sortie, ou à l'erreur.
    fn done(&self, root: &Path, host: &str, run: GhRun) -> Result<GhOut, ForgeError> {
        match run {
            GhRun::Missing => Err(ForgeError::Unavailable(GH_MISSING.into())),
            GhRun::TimedOut => Err(ForgeError::Failed(format!(
                "gh n'a pas répondu à temps (délai de {} s)",
                self.gh.timeout.as_secs().max(1)
            ))),
            GhRun::SpawnFailed(e) => Err(ForgeError::Failed(format!(
                "gh : lancement impossible : {}",
                self.clean(root, e.as_bytes())
            ))),
            GhRun::Done(out) if out.truncated => Err(ForgeError::Failed(format!(
                "gh : réponse trop volumineuse (plus de {} Mio)",
                MAX_GH_OUTPUT / (1024 * 1024)
            ))),
            // Code 4 : authentification requise (`gh help exit-codes`).
            GhRun::Done(out) if out.code == Some(4) => {
                Err(ForgeError::Unavailable(not_logged_in(host)))
            }
            GhRun::Done(out) => Ok(out),
        }
    }

    fn clean(&self, root: &Path, stderr: &[u8]) -> String {
        let home = home_dir();
        let mut hidden: Vec<&Path> = vec![root];
        if let Some(h) = &home {
            hidden.push(h);
        }
        clean_message(stderr, &hidden)
    }

    fn failed(&self, root: &Path, out: &GhOut) -> ForgeError {
        ForgeError::Failed(format!("gh : {}", self.clean(root, &out.stderr)))
    }
}

/// Lecture de `gh auth status --json hosts` : `None` si ce n'est pas la
/// forme attendue.
fn auth_from_json(stdout: &[u8], host: &str) -> Option<Auth> {
    let v: Value = serde_json::from_slice(stdout).ok()?;
    let hosts = v.get("hosts")?.as_object()?;
    let accounts = hosts
        .iter()
        .find(|(h, _)| h.eq_ignore_ascii_case(host))
        .and_then(|(_, a)| a.as_array());
    let Some(accounts) = accounts.filter(|a| !a.is_empty()) else {
        return Some(Auth::NotLoggedIn);
    };
    let active = accounts
        .iter()
        .find(|a| a["active"] == true)
        .unwrap_or(&accounts[0]);
    Some(match active["state"].as_str() {
        Some("success") => Auth::Ok,
        Some("timeout") => Auth::Failed(format!("{host} injoignable : réessayez plus tard")),
        _ => Auth::Failed(format!(
            "la connexion de gh à {host} est en échec : lancez « gh auth status » puis « {} »",
            login_hint(host)
        )),
    })
}

fn invalid() -> ForgeError {
    ForgeError::Failed("gh : réponse illisible".into())
}

fn login_of(v: &Value) -> Option<String> {
    v.get("login")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn labels_of(v: &Value) -> Vec<Label> {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|l| {
                    Some(Label {
                        name: one_line(l.get("name")?.as_str()?),
                        color: l.get("color").and_then(Value::as_str).map(str::to_owned),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn logins_of(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| a.iter().filter_map(login_of).collect())
        .unwrap_or_default()
}

/// `gh issue list --json` (champs de [`LIST_FIELDS`], forme GraphQL :
/// `state: "OPEN"`, `author.login`, `updatedAt`). Les entrées illisibles
/// sont écartées.
pub fn parse_gh_list(stdout: &[u8]) -> Result<Vec<Issue>, ForgeError> {
    let v: Value = serde_json::from_slice(stdout).map_err(|_| invalid())?;
    let items = v.as_array().ok_or_else(invalid)?;
    Ok(items
        .iter()
        .filter_map(|i| {
            Some(Issue {
                number: i.get("number")?.as_u64().filter(|n| *n > 0)?,
                title: one_line(i.get("title")?.as_str()?),
                state: IssueState::parse(i.get("state")?.as_str()?)?,
                url: i.get("url")?.as_str()?.to_owned(),
                author: i.get("author").and_then(login_of),
                labels: labels_of(&i["labels"]),
                assignees: logins_of(&i["assignees"]),
                updated_at: i["updatedAt"].as_str().map(str::to_owned),
                body: None,
                body_truncated: false,
                parent: None,
                sub_issues: Vec::new(),
                sub_issues_summary: None,
            })
        })
        .collect())
}

/// `gh label list --json name,color,description` : étiquettes nettoyées
/// ([`RepoLabel::new`]), les illisibles écartées, au plus [`MAX_REPO_LABELS`].
pub fn parse_gh_labels(stdout: &[u8]) -> Result<Vec<RepoLabel>, ForgeError> {
    let v: Value = serde_json::from_slice(stdout).map_err(|_| invalid())?;
    let items = v.as_array().ok_or_else(invalid)?;
    Ok(items
        .iter()
        .filter_map(|l| {
            RepoLabel::new(
                l.get("name")?.as_str()?,
                l.get("color").and_then(Value::as_str),
                l.get("description").and_then(Value::as_str),
            )
        })
        .take(MAX_REPO_LABELS)
        .collect())
}

/// Numéro de l'issue parente d'après `parent_issue_url`
/// (`…/repos/<propriétaire>/<dépôt>/issues/<n>`), seulement si elle est du
/// même dépôt.
fn parent_number(url: &str, remote: &RemoteRepo) -> Option<u64> {
    let mut parts = url.trim_end_matches('/').rsplit('/');
    let n = parts.next()?.parse::<u64>().ok().filter(|n| *n > 0)?;
    let issues = parts.next()?;
    let repo = parts.next()?;
    let owner = parts.next()?;
    let repos = parts.next()?;
    (issues == "issues"
        && repos == "repos"
        && owner.eq_ignore_ascii_case(&remote.owner)
        && repo.eq_ignore_ascii_case(&remote.repo))
    .then_some(n)
}

/// Issue de l'API REST (`gh api repos/<o>/<r>/issues/<n>` : forme REST,
/// `state: "open"`, `user.login`, `html_url`, `updated_at`,
/// `sub_issues_summary`, `parent_issue_url`). Une demande de fusion (champ
/// `pull_request`) est refusée.
pub fn parse_rest_issue(stdout: &[u8], remote: &RemoteRepo) -> Result<Issue, ForgeError> {
    let v: Value = serde_json::from_slice(stdout).map_err(|_| invalid())?;
    let number = v["number"]
        .as_u64()
        .filter(|n| *n > 0)
        .ok_or_else(invalid)?;
    if v.get("pull_request").is_some_and(|p| !p.is_null()) {
        return Err(ForgeError::NotFound(format!(
            "#{number} est une demande de fusion, pas une issue"
        )));
    }
    let (body, body_truncated) = truncate_body(&clean_text(v["body"].as_str().unwrap_or("")));
    let summary = v.get("sub_issues_summary").and_then(|s| {
        Some(SubIssuesSummary {
            total: s.get("total")?.as_u64()?,
            completed: s.get("completed")?.as_u64()?,
        })
    });
    Ok(Issue {
        number,
        title: one_line(v["title"].as_str().ok_or_else(invalid)?),
        state: v["state"]
            .as_str()
            .and_then(IssueState::parse)
            .ok_or_else(invalid)?,
        url: v["html_url"].as_str().ok_or_else(invalid)?.to_owned(),
        author: v.get("user").and_then(login_of),
        labels: labels_of(&v["labels"]),
        assignees: logins_of(&v["assignees"]),
        updated_at: v["updated_at"].as_str().map(str::to_owned),
        body: Some(body),
        body_truncated,
        parent: v["parent_issue_url"]
            .as_str()
            .and_then(|u| parent_number(u, remote)),
        sub_issues: Vec::new(),
        sub_issues_summary: summary,
    })
}

/// Sous-issues de l'API REST (`…/issues/<n>/sub_issues` : tableau d'issues),
/// au plus [`MAX_SUB_ISSUES`].
pub fn parse_rest_sub_issues(stdout: &[u8]) -> Result<Vec<IssueRef>, ForgeError> {
    let v: Value = serde_json::from_slice(stdout).map_err(|_| invalid())?;
    let items = v.as_array().ok_or_else(invalid)?;
    Ok(items
        .iter()
        .filter_map(|i| {
            Some(IssueRef {
                number: i.get("number")?.as_u64().filter(|n| *n > 0)?,
                title: one_line(i.get("title")?.as_str()?),
                state: IssueState::parse(i.get("state")?.as_str()?)?,
                url: i["html_url"].as_str().map(str::to_owned),
            })
        })
        .take(MAX_SUB_ISSUES)
        .collect())
}

impl Forge for GithubCli {
    fn status(&self, root: &Path) -> ForgeStatus {
        let Some(url) = self.git.line(root, &["remote", "get-url", "origin"]) else {
            let why = if self.git.succeeds(root, &["rev-parse", "--git-dir"]) {
                "le dépôt n'a pas de remote « origin »"
            } else {
                "le dossier n'est pas dans un dépôt git"
            };
            return ForgeStatus::unavailable(None, None, why);
        };
        // L'URL n'est jamais recopiée dans la raison : elle peut porter des
        // identifiants (`https://user:jeton@…`).
        let Some(remote) = parse_remote_url(&url) else {
            return ForgeStatus::unavailable(
                None,
                None,
                "l'URL du remote « origin » n'est pas celle d'un dépôt reconnu \
                 (https://hôte/propriétaire/dépôt ou git@hôte:propriétaire/dépôt)",
            );
        };
        let host = remote.host.clone();
        let public = host == GITHUB_HOST;
        match self.auth(&host) {
            Auth::Ok => ForgeStatus {
                available: true,
                kind: Some(ForgeKind::Github),
                remote: Some(remote),
                reason: None,
            },
            Auth::Missing if public => {
                ForgeStatus::unavailable(Some(ForgeKind::Github), Some(remote), GH_MISSING)
            }
            Auth::Missing => ForgeStatus::unavailable(
                None,
                Some(remote),
                format!(
                    "forge non reconnue pour {host} : seuls GitHub et les GitHub Enterprise \
                     déclarés à gh sont pris en charge, et la CLI gh est introuvable"
                ),
            ),
            Auth::NotLoggedIn if public => ForgeStatus::unavailable(
                Some(ForgeKind::Github),
                Some(remote),
                not_logged_in(&host),
            ),
            Auth::NotLoggedIn => ForgeStatus::unavailable(
                None,
                Some(remote),
                format!(
                    "forge non reconnue pour {host} : seuls GitHub et les GitHub Enterprise \
                     déclarés à gh sont pris en charge (pour GitHub Enterprise : « {} »)",
                    login_hint(&host)
                ),
            ),
            Auth::Failed(why) => {
                ForgeStatus::unavailable(Some(ForgeKind::Github), Some(remote), why)
            }
        }
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            sub_issues: true,
            epics: true,
            review_comments: true,
            checks: true,
        }
    }

    fn issues(
        &self,
        root: &Path,
        remote: &RemoteRepo,
        filter: &IssueFilter,
    ) -> Result<(Vec<Issue>, bool), ForgeError> {
        let repo = remote.slug();
        // Une de plus que demandé : de quoi savoir s'il y en a d'autres.
        let limit = format!("--limit={}", filter.limit + 1);
        let state = format!("--state={}", filter.state.as_str());
        let mut args = vec![
            "issue",
            "list",
            "--repo",
            &repo,
            "--json",
            LIST_FIELDS,
            &limit,
            &state,
        ];
        // Valeurs données par l'utilisateur : toujours `--option=valeur`,
        // jamais lues comme une option.
        let search = filter.search.as_ref().map(|s| format!("--search={s}"));
        // Une option par étiquette (ET logique), valeur protégée pour pflag.
        let labels: Vec<String> = filter
            .labels
            .iter()
            .map(|l| format!("--label={}", csv_value(l)))
            .collect();
        args.extend(search.as_deref());
        if filter.assigned_to_me {
            args.push("--assignee=@me");
        }
        args.extend(labels.iter().map(String::as_str));
        let out = self.call(root, &remote.host, &args)?;
        if !out.ok {
            return Err(self.failed(root, &out));
        }
        let mut issues = parse_gh_list(&out.stdout)?;
        let truncated = issues.len() > filter.limit;
        issues.truncate(filter.limit);
        Ok((issues, truncated))
    }

    fn labels(&self, root: &Path, remote: &RemoteRepo) -> Result<Vec<RepoLabel>, ForgeError> {
        let repo = remote.slug();
        let limit = format!("--limit={MAX_REPO_LABELS}");
        let out = self.call(
            root,
            &remote.host,
            &[
                "label",
                "list",
                "--repo",
                &repo,
                "--json",
                LABEL_FIELDS,
                &limit,
            ],
        )?;
        if !out.ok {
            return Err(self.failed(root, &out));
        }
        parse_gh_labels(&out.stdout)
    }

    fn issue(&self, root: &Path, remote: &RemoteRepo, number: u64) -> Result<Issue, ForgeError> {
        let not_found = || ForgeError::NotFound(format!("issue #{number} introuvable"));
        let path = format!("repos/{}/{}/issues/{number}", remote.owner, remote.repo);
        let out = self.call(
            root,
            &remote.host,
            &["api", "--hostname", &remote.host, &path],
        )?;
        if !out.ok {
            let err = String::from_utf8_lossy(&out.stderr);
            if err.contains("HTTP 404") || err.contains("HTTP 410") {
                return Err(not_found());
            }
            return Err(self.failed(root, &out));
        }
        let mut issue = parse_rest_issue(&out.stdout, remote)?;
        if issue.sub_issues_summary.is_some_and(|s| s.total > 0) {
            let sub = format!("{path}/sub_issues?per_page={MAX_SUB_ISSUES}");
            let out = self.call(
                root,
                &remote.host,
                &["api", "--hostname", &remote.host, &sub],
            )?;
            if !out.ok {
                return Err(self.failed(root, &out));
            }
            issue.sub_issues = parse_rest_sub_issues(&out.stdout)?;
        }
        Ok(issue)
    }

    fn pulls(
        &self,
        root: &Path,
        remote: &RemoteRepo,
        filter: &crate::domain::forge::pulls::PullFilter,
    ) -> Result<(Vec<crate::domain::forge::pulls::Pull>, bool), ForgeError> {
        self.gh_pulls(root, remote, filter)
    }

    fn pull(
        &self,
        root: &Path,
        remote: &RemoteRepo,
        number: u64,
    ) -> Result<crate::domain::forge::pulls::PullDetail, ForgeError> {
        self.gh_pull(root, remote, number)
    }

    fn pull_head(
        &self,
        root: &Path,
        remote: &RemoteRepo,
        number: u64,
    ) -> Result<String, ForgeError> {
        self.gh_pull_head(root, remote, number)
    }

    fn pull_diff(
        &self,
        root: &Path,
        remote: &RemoteRepo,
        number: u64,
    ) -> Result<Vec<(String, crate::domain::diff::FileDiff)>, ForgeError> {
        self.gh_pull_diff(root, remote, number)
    }

    fn pull_for_branch(
        &self,
        root: &Path,
        remote: &RemoteRepo,
        branch: &str,
    ) -> Result<Option<crate::domain::forge::pulls::Pull>, ForgeError> {
        self.gh_pull_for_branch(root, remote, branch)
    }

    fn submit_review(
        &self,
        root: &Path,
        remote: &RemoteRepo,
        number: u64,
        review: &crate::domain::forge::pulls::ForgeReview,
    ) -> Result<String, ForgeError> {
        self.gh_submit_review(root, remote, number, review)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    const LIST: &[u8] = include_bytes!("../../tests/fixtures/forge/gh-issue-list.json");
    const ISSUE: &[u8] = include_bytes!("../../tests/fixtures/forge/rest-issue-epic.json");
    const SUBS: &[u8] = include_bytes!("../../tests/fixtures/forge/rest-sub-issues.json");
    const AUTH: &[u8] = include_bytes!("../../tests/fixtures/forge/gh-auth-status.json");
    const LABELS: &[u8] = include_bytes!("../../tests/fixtures/forge/gh-label-list.json");

    fn remote() -> RemoteRepo {
        parse_remote_url("git@github.com:BadRom1/DevMaestro.git").unwrap()
    }

    #[test]
    fn recorded_issue_list_is_parsed() {
        let list = parse_gh_list(LIST).unwrap();
        assert_eq!(list.len(), 2);
        let first = &list[0];
        assert_eq!(first.number, 14755);
        assert_eq!(first.state, IssueState::Open);
        assert_eq!(first.url, "https://github.com/cli/cli/issues/14755");
        assert_eq!(first.author.as_deref(), Some("contributeur"));
        assert_eq!(
            first.labels[0],
            Label {
                name: "enhancement".into(),
                color: Some("0dd8ac".into())
            }
        );
        assert_eq!(first.updated_at.as_deref(), Some("2026-10-19T22:07:47Z"));
        assert!(first.body.is_none() && first.sub_issues_summary.is_none());
        assert_eq!(list[1].state, IssueState::Closed);
        assert_eq!(list[1].assignees, vec!["octocat".to_owned()]);
        // Entrées illisibles écartées, réponse illisible refusée.
        let odd = br#"[{"number":0,"title":"x","state":"OPEN","url":"u"},{"title":"y"},
            {"number":3,"title":"z","state":"OPEN","url":"https://h/3","author":null}]"#;
        let odd = parse_gh_list(odd).unwrap();
        assert_eq!(odd.len(), 1);
        assert_eq!(odd[0].author, None);
        assert!(matches!(parse_gh_list(b"{"), Err(ForgeError::Failed(_))));
        assert!(matches!(parse_gh_list(b"{}"), Err(ForgeError::Failed(_))));
    }

    #[test]
    fn recorded_rest_issue_and_sub_issues_are_parsed() {
        let issue = parse_rest_issue(ISSUE, &remote()).unwrap();
        assert_eq!(issue.number, 12);
        assert_eq!(issue.url, "https://github.com/BadRom1/DevMaestro/issues/12");
        assert_eq!(issue.state, IssueState::Open);
        assert_eq!(issue.author.as_deref(), Some("BadRom1"));
        assert_eq!(issue.assignees, vec!["BadRom1".to_owned()]);
        assert_eq!(issue.parent, Some(3));
        assert_eq!(
            issue.sub_issues_summary,
            Some(SubIssuesSummary {
                total: 3,
                completed: 1
            })
        );
        assert!(issue.body.as_deref().unwrap().starts_with("## Objectif"));
        assert!(!issue.body_truncated);
        let subs = parse_rest_sub_issues(SUBS).unwrap();
        assert_eq!(subs.len(), 3);
        assert_eq!(subs[0].number, 13);
        assert_eq!(subs[1].state, IssueState::Closed);
        assert_eq!(
            subs[2].url.as_deref(),
            Some("https://github.com/BadRom1/DevMaestro/issues/15")
        );
    }

    #[test]
    fn rest_issue_bounds_and_refusals() {
        let mut v: Value = serde_json::from_slice(ISSUE).unwrap();
        v["body"] = Value::String("é".repeat(40_000));
        v["parent_issue_url"] = "https://api.github.com/repos/autre/depot/issues/3".into();
        v.as_object_mut().unwrap().remove("sub_issues_summary");
        let issue = parse_rest_issue(&serde_json::to_vec(&v).unwrap(), &remote()).unwrap();
        assert!(issue.body_truncated);
        assert_eq!(
            issue.body.unwrap().len(),
            crate::domain::forge::MAX_BODY_BYTES
        );
        assert_eq!(issue.parent, None, "parente d'un autre dépôt");
        assert_eq!(issue.sub_issues_summary, None);
        v["body"] = Value::Null;
        v["pull_request"] = serde_json::json!({"url": "x"});
        assert!(matches!(
            parse_rest_issue(&serde_json::to_vec(&v).unwrap(), &remote()),
            Err(ForgeError::NotFound(_))
        ));
        assert!(parse_rest_issue(b"[]", &remote()).is_err());
    }

    #[test]
    fn recorded_label_list_is_parsed() {
        let list = parse_gh_labels(LABELS).unwrap();
        assert_eq!(list.len(), 3);
        assert_eq!(
            list[0],
            RepoLabel {
                name: "accessibility".into(),
                color: Some("f143ab".into()),
                description: Some("Barrier affecting people with disabilities".into()),
            }
        );
        // Entrées illisibles écartées, textes nettoyés, couleur douteuse retirée.
        let odd = br#"[{"name":"","color":"fff"},{"color":"000000"},
            {"name":"a\u202eb","color":"x\"><script>","description":""}]"#;
        assert_eq!(
            parse_gh_labels(odd).unwrap(),
            vec![RepoLabel {
                name: "ab".into(),
                color: None,
                description: None
            }]
        );
        assert!(matches!(parse_gh_labels(b"{}"), Err(ForgeError::Failed(_))));
        let many: Vec<Value> = (0..MAX_REPO_LABELS + 5)
            .map(|i| serde_json::json!({"name": format!("l{i}")}))
            .collect();
        let many = serde_json::to_vec(&many).unwrap();
        assert_eq!(parse_gh_labels(&many).unwrap().len(), MAX_REPO_LABELS);
    }

    #[test]
    fn list_values_stay_one_value() {
        assert_eq!(csv_value("bug"), "bug");
        assert_eq!(csv_value("help wanted"), "help wanted");
        assert_eq!(csv_value("a,b"), "\"a,b\"");
        assert_eq!(csv_value("dit \"x\""), "\"dit \"\"x\"\"\"");
    }

    #[test]
    fn parent_urls() {
        let r = remote();
        assert_eq!(
            parent_number(
                "https://api.github.com/repos/badrom1/devmaestro/issues/7",
                &r
            ),
            Some(7)
        );
        assert_eq!(
            parent_number(
                "https://ghe.example.org/api/v3/repos/BadRom1/DevMaestro/issues/9",
                &r
            ),
            Some(9)
        );
        assert_eq!(
            parent_number(
                "https://api.github.com/repos/BadRom1/DevMaestro/pulls/7",
                &r
            ),
            None
        );
        assert_eq!(parent_number("n'importe quoi", &r), None);
    }

    #[test]
    fn recorded_auth_status_is_read() {
        assert_eq!(auth_from_json(AUTH, "github.com"), Some(Auth::Ok));
        assert_eq!(auth_from_json(AUTH, "GitHub.com"), Some(Auth::Ok));
        assert_eq!(
            auth_from_json(br#"{"hosts":{}}"#, "github.com"),
            Some(Auth::NotLoggedIn)
        );
        let timeout = br#"{"hosts":{"ghe.example.org":[{"state":"timeout","active":true}]}}"#;
        assert!(matches!(
            auth_from_json(timeout, "ghe.example.org"),
            Some(Auth::Failed(m)) if m.contains("injoignable")
        ));
        let bad = br#"{"hosts":{"github.com":[{"state":"error","active":true}]}}"#;
        assert!(matches!(
            auth_from_json(bad, "github.com"),
            Some(Auth::Failed(m)) if m.contains("gh auth login")
        ));
        assert_eq!(auth_from_json(b"unknown flag: --json", "github.com"), None);
    }

    #[test]
    fn removed_environment() {
        for name in [
            "GH_TOKEN",
            "GITHUB_TOKEN",
            "GH_ENTERPRISE_TOKEN",
            "GITHUB_ENTERPRISE_TOKEN",
            "GH_HOST",
            "GH_REPO",
            "GH_DEBUG",
            "DEBUG",
            "GH_FORCE_TTY",
            "ORCH_TOKEN",
            "DEVMAESTRO_GH_BIN",
        ] {
            assert!(is_removed_env(name), "{name}");
        }
        for name in [
            "GH_CONFIG_DIR",
            "HOME",
            "PATH",
            "HTTPS_PROXY",
            "DBUS_SESSION_BUS_ADDRESS",
            "XDG_RUNTIME_DIR",
        ] {
            assert!(!is_removed_env(name), "{name}");
        }
    }

    fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
        use std::io::Write as _;
        let p = dir.join(name);
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(format!("#!/bin/sh\n{body}\n").as_bytes())
            .unwrap();
        f.sync_all().unwrap();
        drop(f);
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    /// Relance bornée d'un lancement refusé par `ETXTBSY` : un script tout
    /// juste écrit peut être encore ouvert en écriture dans un enfant forké
    /// par un autre test (entre son `fork` et son `exec`), le temps de
    /// quelques millisecondes. Propre aux tests : en production, `gh` n'est
    /// pas écrit par le démon.
    fn unbusy(run: impl Fn() -> GhRun) -> GhRun {
        for _ in 0..50 {
            match run() {
                GhRun::SpawnFailed(e) if e.contains("os error 26") => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                other => return other,
            }
        }
        run()
    }

    /// Le processus `pid` a-t-il disparu (au plus 3 s d'attente : un orphelin
    /// tué est récolté par `init` ou le sous-moissonneur) ?
    fn gone(pid: i32) -> bool {
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(3) {
            if nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None).is_err() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    fn pid_in(file: &Path) -> i32 {
        let start = Instant::now();
        loop {
            if let Some(pid) = std::fs::read_to_string(file)
                .ok()
                .and_then(|s| s.trim().parse().ok())
            {
                return pid;
            }
            assert!(start.elapsed() < Duration::from_secs(3), "pid non écrit");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn launcher_bounds_time_and_output() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        let pid_file = d.join("fils.pid");
        // Délai : le groupe entier est tué, le fils aussi.
        let slow = GhExec::new(
            Some(script(
                d,
                "lent",
                &format!("sleep 30 & echo $! > '{}'; wait", pid_file.display()),
            )),
            // Assez long pour que le script écrive le pid de son fils même
            // sur une machine chargée (le fichier est lu ensuite).
            Duration::from_secs(2),
        );
        let start = Instant::now();
        assert!(matches!(unbusy(|| slow.run(&[])), GhRun::TimedOut));
        assert!(start.elapsed() < Duration::from_secs(6));
        assert!(gone(pid_in(&pid_file)), "le fils a survécu au délai");

        // Sortie normale avec un descendant qui garde les tubes : rendue
        // aussitôt, le descendant est tué.
        let pid_file = d.join("descendant.pid");
        let leaky = GhExec::new(
            Some(script(
                d,
                "fuite",
                &format!("sleep 30 & echo $! > '{}'; echo fini", pid_file.display()),
            )),
            Duration::from_secs(10),
        );
        let start = Instant::now();
        match unbusy(|| leaky.run(&[])) {
            GhRun::Done(o) => {
                assert!(o.ok);
                assert_eq!(o.stdout, b"fini\n");
            }
            other => panic!("{other:?}"),
        }
        assert!(start.elapsed() < Duration::from_secs(5));
        assert!(gone(pid_in(&pid_file)), "le descendant a survécu");

        // Sortie trop grosse : coupée, signalée.
        let mut big = GhExec::new(
            Some(script(d, "gros", "head -c 3000 /dev/zero; echo err >&2")),
            Duration::from_secs(5),
        );
        big.max_output = 1000;
        match unbusy(|| big.run(&[])) {
            GhRun::Done(o) => {
                assert!(o.truncated && o.ok);
                assert_eq!(o.stdout.len(), 1000);
                assert_eq!(o.stderr, b"err\n");
            }
            other => panic!("{other:?}"),
        }
        // Binaire absent.
        assert!(matches!(
            unbusy(|| GhExec::new(None, Duration::from_secs(1)).run(&[])),
            GhRun::Missing
        ));
        // Arguments séparés, sans shell ; code de sortie rendu ; lancé depuis
        // le dossier neutre.
        let echo = GhExec::new(
            Some(script(d, "echo", "printf '%s|' \"$@\" \"$(pwd)\"; exit 3")),
            Duration::from_secs(5),
        );
        match unbusy(|| echo.run(&["a b", "$(id)", "--x=;y"])) {
            GhRun::Done(o) => {
                assert_eq!(o.stdout, b"a b|$(id)|--x=;y|/|");
                assert_eq!(o.code, Some(3));
                assert!(!o.ok);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn launcher_writes_bounded_standard_input() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        // L'entrée est lue en entier (au-delà de la taille d'un tube).
        let cat = GhExec::new(Some(script(d, "cat", "wc -c")), Duration::from_secs(5));
        let doc = vec![b'x'; 300_000];
        match unbusy(|| cat.run_input(&["api"], &doc)) {
            GhRun::Done(o) => assert_eq!(String::from_utf8_lossy(&o.stdout).trim(), "300000"),
            other => panic!("{other:?}"),
        }
        // `run` garde l'entrée fermée.
        match unbusy(|| cat.run(&[])) {
            GhRun::Done(o) => assert_eq!(String::from_utf8_lossy(&o.stdout).trim(), "0"),
            other => panic!("{other:?}"),
        }
        // Un `gh` qui ne lit pas son entrée ne bloque pas : délai, groupe tué.
        let deaf = GhExec::new(
            Some(script(d, "sourd", "sleep 30")),
            Duration::from_millis(300),
        );
        let start = Instant::now();
        assert!(matches!(
            unbusy(|| deaf.run_input(&[], &doc)),
            GhRun::TimedOut
        ));
        assert!(start.elapsed() < Duration::from_secs(3));
        // Un `gh` qui sort sans lire : rendu normalement.
        let quick = GhExec::new(Some(script(d, "vite", "echo ok")), Duration::from_secs(5));
        assert!(matches!(unbusy(|| quick.run_input(&[], &doc)), GhRun::Done(o) if o.ok));
        // Entrée trop grosse : rien n'est lancé.
        let huge = vec![b'x'; MAX_GH_INPUT + 1];
        assert!(matches!(
            unbusy(|| cat.run_input(&[], &huge)),
            GhRun::SpawnFailed(_)
        ));
    }

    #[test]
    fn program_is_resolved_in_absolute_path_entries() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path().canonicalize().unwrap();
        let bin = d.join("bin");
        std::fs::create_dir(&bin).unwrap();
        let gh = script(&bin, "gh", "exit 0");
        let plain = bin.join("pas-executable");
        std::fs::write(&plain, "x").unwrap();
        let path = std::env::join_paths([
            Path::new("relatif"),
            Path::new(""),
            Path::new("/nulle/part"),
            &bin,
        ])
        .unwrap();
        assert_eq!(
            resolve_program("gh".as_ref(), Some(&path)),
            Some(gh.clone())
        );
        assert_eq!(
            resolve_program("pas-executable".as_ref(), Some(&path)),
            None
        );
        assert_eq!(resolve_program("gh".as_ref(), None), None);
        // Seul un composant relatif mène au programme : ignoré.
        let rel_only = std::env::join_paths([Path::new("bin")]).unwrap();
        assert_eq!(resolve_program("gh".as_ref(), Some(&rel_only)), None);
        // Chemin donné : absolu et exécutable seulement.
        assert_eq!(resolve_program(gh.as_os_str(), None), Some(gh));
        assert_eq!(resolve_program("bin/gh".as_ref(), None), None);
        assert_eq!(resolve_program(plain.as_os_str(), None), None);
    }

    #[test]
    fn forge_texts_are_cleaned() {
        let mut v: Value = serde_json::from_slice(ISSUE).unwrap();
        v["title"] = "Titre\u{202E}\u{E0041} caché\nici".into();
        v["body"] = "ligne\r\ndeux\u{200B}\u{E0100}\u{1b}[31m".into();
        v["labels"] = serde_json::json!([{"name": "bug\u{FE0F}", "color": "fff"}]);
        let issue = parse_rest_issue(&serde_json::to_vec(&v).unwrap(), &remote()).unwrap();
        assert_eq!(issue.title, "Titre caché ici");
        assert_eq!(issue.body.as_deref(), Some("ligne\ndeux[31m"));
        assert_eq!(issue.labels[0].name, "bug");
        let list = serde_json::json!([{"number": 1, "title": "a\u{200D}b", "state": "OPEN",
                                       "url": "https://h/1"}]);
        let list = serde_json::to_vec(&list).unwrap();
        assert_eq!(parse_gh_list(&list).unwrap()[0].title, "ab");
    }
}
