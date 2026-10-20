//! Worktrees des projets (v0.2, lot 6) côté démon : création avec une
//! session (`sessions.launch` + `worktree`), `worktrees.list`,
//! `worktrees.remove`, identité du projet des sessions, et notification
//! `project.worktrees_changed`.
//!
//! Les règles (chemins, lecture des sorties de `git`, état « intégré ») sont
//! dans le domaine ([`crate::domain::worktree`]) ; les appels à `git` dans
//! l'adaptateur. Tout ce qui appelle `git` est bloquant : hors du runtime, et
//! jamais sous le verrou du registre.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use uuid::Uuid;

use super::{Daemon, Event, RpcError, error, info, opt_str, warning};
use crate::domain::worktree::{
    Integrated, Location, MAX_DIRTY_FILES, PathRequest, Reference, is_empty_branch, managed_by,
    owning_worktree, worktree_path,
};
use crate::ports::{DiffError, RepoInfo, WorktreeRecord, WorktreeStart};
use crate::protocol::error_code;

/// Anti-rebond du recalcul des worktrees d'un projet.
pub const WORKTREE_DEBOUNCE: Duration = Duration::from_secs(2);
/// Recalcul des worktrees des projets qui ont des sessions vivantes ou des
/// worktrees non principaux.
pub const WORKTREE_POLL_INTERVAL: Duration = Duration::from_secs(60);

/// État des worktrees d'un projet tel que comparé d'un calcul à l'autre :
/// chemin, branche, `dirty`, `integrated`.
type Fingerprint = Vec<(PathBuf, Option<String>, Option<bool>, Option<Integrated>)>;

/// Suivi des worktrees d'un projet (clé : dossier commun).
#[derive(Debug, Default)]
pub(super) struct WorktreeWatch {
    /// Racine du projet (worktree principal) : paramètre de la notification.
    root: PathBuf,
    /// Dernier état notifié (ou premier calcul, qui ne notifie pas).
    notified: Option<Fingerprint>,
    /// Le projet avait des worktrees non principaux au dernier calcul.
    linked: bool,
    pending: bool,
    in_flight: bool,
    /// Un recalcul a été demandé pendant le calcul : le refaire ensuite.
    again: bool,
}

/// Paramètre `worktree` de `sessions.launch`.
#[derive(Debug, Clone)]
pub(super) struct WorktreeParam {
    branch: String,
    base: Option<String>,
    location: Location,
    path: Option<PathBuf>,
}

impl WorktreeParam {
    /// `worktree: {branch, base?, location?, path?}` (absent ou `null` : pas
    /// de worktree). `location` vaut `sibling` par défaut.
    pub(super) fn parse(params: &Value) -> Result<Option<Self>, RpcError> {
        let w = match params.get("worktree") {
            None | Some(Value::Null) => return Ok(None),
            Some(w @ Value::Object(_)) => w,
            Some(_) => return Err(RpcError::params("« worktree » doit être un objet")),
        };
        let field = |key: &str| {
            opt_str(w, key)
                .map_err(|_| RpcError::params(format!("« worktree.{key} » doit être une chaîne")))
        };
        let branch = field("branch")?
            .filter(|b| !b.is_empty())
            .ok_or_else(|| RpcError::params("« worktree.branch » manquant"))?;
        let location = match field("location")? {
            None => Location::Sibling,
            Some(l) => Location::parse(&l).ok_or_else(|| {
                RpcError::params(format!(
                    "emplacement inconnu : {l} (attendu : sibling, in_repo, managed, custom)"
                ))
            })?,
        };
        Ok(Some(Self {
            branch,
            base: field("base")?.filter(|b| !b.is_empty()),
            location,
            path: field("path")?.map(PathBuf::from),
        }))
    }
}

/// Worktree créé pour une session.
#[derive(Debug, Clone)]
pub(super) struct CreatedWorktree {
    pub(super) path: PathBuf,
    branch: String,
    /// Base demandée ou référence par défaut ; `None` pour une branche existante.
    base: Option<String>,
    pub(super) common_dir: PathBuf,
    pub(super) project_root: PathBuf,
    /// Dossier d'où lancer `git` (le principal s'il existe).
    git_root: PathBuf,
    created_branch: bool,
    /// Commit de départ d'une nouvelle branche.
    start_sha: Option<String>,
}

impl CreatedWorktree {
    pub(super) fn json(&self) -> Value {
        json!({"path": self.path, "branch": self.branch, "base": self.base})
    }
}

/// Un worktree tel que montré par `worktrees.list`.
struct WorktreeView {
    path: PathBuf,
    branch: Option<String>,
    head: Option<String>,
    main: bool,
    locked: bool,
    prunable: bool,
    exists: bool,
    dirty: Option<bool>,
    ahead: Option<u64>,
    integrated: Option<Integrated>,
    sessions_running: usize,
    managed_by: Option<crate::domain::worktree::ManagedBy>,
}

/// Échec de `git` → erreur du protocole (`-32603` avec le message de git).
fn git_error(e: DiffError) -> RpcError {
    match e {
        DiffError::NotARepo => RpcError::new(
            error_code::NOT_A_REPO,
            "le dossier n'est pas dans un dépôt git",
        ),
        DiffError::Failed(m) => RpcError::new(error_code::INTERNAL_ERROR, format!("git : {m}")),
    }
}

fn fingerprint(views: &[WorktreeView]) -> Fingerprint {
    views
        .iter()
        .map(|v| (v.path.clone(), v.branch.clone(), v.dirty, v.integrated))
        .collect()
}

/// Chemin marqué « suppression en cours » tant que la garde vit.
struct RemovingGuard<'a> {
    daemon: &'a Daemon,
    path: PathBuf,
}

impl<'a> RemovingGuard<'a> {
    fn new(daemon: &'a Daemon, path: &Path) -> Self {
        daemon
            .removing
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(path.to_path_buf());
        Self {
            daemon,
            path: path.to_path_buf(),
        }
    }
}

impl Drop for RemovingGuard<'_> {
    fn drop(&mut self) {
        self.daemon
            .removing
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.path);
    }
}

/// État « intégré » d'une branche, `empty` compris pour un worktree créé par
/// le démon dont la tête est encore le commit de départ.
fn integrated_with_start(
    g: &dyn crate::ports::WorktreeGit,
    root: &Path,
    reference: &Reference,
    branch: &str,
    head: Option<&str>,
    start_sha: Option<&str>,
) -> Option<Integrated> {
    if is_empty_branch(head, start_sha) {
        return Some(Integrated::Empty);
    }
    g.integrated(root, &reference.full, branch)
}

/// Message d'une erreur de `git` pour le journal ou un avertissement.
fn git_message(e: &DiffError) -> String {
    match e {
        DiffError::NotARepo => "pas un dépôt git".into(),
        DiffError::Failed(m) => m.clone(),
    }
}

fn bool_param(params: &Value, key: &str) -> Result<bool, RpcError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(false),
        Some(Value::Bool(b)) => Ok(*b),
        Some(_) => Err(RpcError::params(format!("« {key} » doit être un booléen"))),
    }
}

/// Dossier d'où lancer `git` pour un dépôt : le worktree principal s'il
/// existe, sinon celui du dossier résolu.
fn git_root(repo: &RepoInfo) -> PathBuf {
    if repo.project_root.is_dir() {
        repo.project_root.clone()
    } else {
        repo.worktree_root.clone()
    }
}

impl Daemon {
    // ------------------------------------------------------------ création

    /// Crée le worktree demandé pour une session lancée depuis `cwd` (un
    /// dossier du dépôt). Rien n'est créé en cas d'erreur de validation.
    pub(super) fn create_worktree(
        &self,
        cwd: &Path,
        w: &WorktreeParam,
        warnings: &mut Vec<String>,
    ) -> Result<CreatedWorktree, RpcError> {
        let repo = self.deps.vcs.resolve(cwd).ok_or_else(|| {
            RpcError::new(
                error_code::NOT_A_REPO,
                "« worktree » : le dossier n'est pas dans un dépôt git",
            )
        })?;
        let root = git_root(&repo);
        let g = &self.deps.worktrees;
        g.check_branch_name(&root, &w.branch)
            .map_err(RpcError::params)?;
        // Un seul changement de worktrees à la fois par dépôt : contrôles,
        // `git worktree add` et enregistrement ne s'entremêlent jamais.
        let lock = self.repo_lock(&repo.common_dir);
        let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        let managed_base = self.config.paths.data_dir.join("worktrees");
        let mut path = worktree_path(&PathRequest {
            location: w.location,
            project_root: &repo.project_root,
            common_dir: &repo.common_dir,
            managed_base: &managed_base,
            branch: &w.branch,
            custom: w.path.as_deref(),
        })
        .map_err(|e| RpcError::params(e.0))?;
        if w.location == Location::Custom {
            let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
                return Err(RpcError::params("« worktree.path » invalide"));
            };
            let parent = parent
                .canonicalize()
                .ok()
                .filter(|p| p.is_dir())
                .ok_or_else(|| {
                    RpcError::params(format!(
                        "le dossier parent de « worktree.path » n'existe pas : {}",
                        parent.display()
                    ))
                })?;
            path = parent.join(name);
        }
        if std::fs::symlink_metadata(&path).is_ok() {
            return Err(RpcError::params(format!(
                "le dossier existe déjà : {}",
                path.display()
            )));
        }
        let list = g.list(&root).map_err(git_error)?;
        if list.iter().any(|e| e.path == path) {
            return Err(RpcError::params(format!(
                "le dossier existe déjà : {} (worktree enregistré par git)",
                path.display()
            )));
        }
        if let Some(other) = list
            .iter()
            .find(|e| e.branch.as_deref() == Some(w.branch.as_str()))
        {
            return Err(RpcError::params(format!(
                "la branche « {} » est déjà extraite dans {}",
                w.branch,
                other.path.display()
            )));
        }
        let existing = g.branch_exists(&root, &w.branch);
        let (start_sha, base) = if existing {
            if let Some(b) = &w.base {
                warnings.push(format!(
                    "la branche « {} » existe déjà : worktree créé sur elle, base « {b} » ignorée",
                    w.branch
                ));
            }
            (None, None)
        } else {
            let reference = g.reference(&root);
            let (rev, label) = match (&w.base, &reference) {
                (Some(b), _) => (b.clone(), b.clone()),
                (None, Some(r)) => (r.full.clone(), r.short.clone()),
                (None, None) => ("HEAD".to_owned(), "HEAD".to_owned()),
            };
            let sha = g
                .resolve_commit(&root, &rev)
                .ok_or_else(|| RpcError::params(format!("base inconnue : « {label} »")))?;
            (Some(sha), Some(label))
        };
        if w.location == Location::InRepo
            && let Err(e) = g.exclude_in_repo_dir(&root, &repo.common_dir)
        {
            let w = format!(
                "« .worktrees/ » non ajouté à info/exclude : {}",
                git_message(&e)
            );
            warning!("{w}");
            warnings.push(w);
        }
        let start = match &start_sha {
            Some(sha) => WorktreeStart::NewBranch { base: sha },
            None => WorktreeStart::Existing,
        };
        if let Err(e) = g.add(&root, &path, &w.branch, start) {
            // Création interrompue (délai…) : seul ce que cet appel a créé est
            // défait (le chemin n'était pas dans la liste avant, la branche
            // n'existait pas et pointe encore sur le commit de départ).
            if g.list(&root)
                .is_ok_and(|l| l.iter().any(|x| x.path == path))
                && let Err(e) = g.remove(&root, &path, true, false)
            {
                error!(
                    "worktree {} à moitié créé, non retiré : {}",
                    path.display(),
                    git_message(&e)
                );
            }
            if let Some(sha) = &start_sha {
                self.delete_branch_if_untouched(&root, &w.branch, sha);
            }
            return Err(git_error(e));
        }
        let path = path.canonicalize().unwrap_or(path);
        let created = CreatedWorktree {
            path,
            branch: w.branch.clone(),
            base,
            common_dir: repo.common_dir.clone(),
            project_root: repo.project_root.clone(),
            git_root: root,
            created_branch: !existing,
            start_sha: start_sha.clone(),
        };
        if let Err(e) = self.deps.store.record_worktree(&WorktreeRecord {
            path: created.path.clone(),
            common_dir: created.common_dir.clone(),
            project_root: created.project_root.clone(),
            branch: created.branch.clone(),
            base: created.base.clone(),
            created_branch: created.created_branch,
            start_sha: created.start_sha.clone(),
            created_at: self.now(),
        }) {
            error!(
                "worktree {} : écriture en base : {e}",
                created.path.display()
            );
        }
        info!(
            "worktree {} créé ({} {}, emplacement {})",
            created.path.display(),
            if existing {
                "branche existante"
            } else {
                "nouvelle branche"
            },
            created.branch,
            w.location.as_str()
        );
        Ok(created)
    }

    /// Lancement échoué : retire le worktree que cet appel a créé, et sa
    /// branche si elle est neuve et pointe encore sur le commit de départ.
    pub(super) fn rollback_worktree(&self, c: &CreatedWorktree) {
        let lock = self.repo_lock(&c.common_dir);
        let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        let g = &self.deps.worktrees;
        if let Err(e) = g.remove(&c.git_root, &c.path, true, false) {
            error!(
                "lancement échoué : worktree {} non retiré : {}",
                c.path.display(),
                git_message(&e)
            );
        }
        if c.created_branch
            && let Some(sha) = &c.start_sha
        {
            self.delete_branch_if_untouched(&c.git_root, &c.branch, sha);
        }
        if let Err(e) = self.deps.store.delete_worktree(&c.path) {
            error!("worktree {} : suppression en base : {e}", c.path.display());
        }
        info!("lancement échoué : worktree {} retiré", c.path.display());
    }

    /// Supprime (`-D` : aucun commit à elle) une branche que le démon vient
    /// de créer, seulement si elle pointe encore sur `start_sha`.
    fn delete_branch_if_untouched(&self, root: &Path, branch: &str, start_sha: &str) {
        let g = &self.deps.worktrees;
        if g.resolve_commit(root, &format!("refs/heads/{branch}"))
            .as_deref()
            != Some(start_sha)
        {
            return;
        }
        if let Err(e) = g.delete_branch(root, branch, true) {
            error!("branche {branch} non supprimée : {}", git_message(&e));
        }
    }

    /// Verrou des changements de worktrees d'un dépôt (création, suppression).
    fn repo_lock(&self, common_dir: &Path) -> Arc<std::sync::Mutex<()>> {
        self.repo_locks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(common_dir.to_path_buf())
            .or_default()
            .clone()
    }

    /// `cwd` est-il dans un worktree en cours de suppression ? Consulté sous
    /// le verrou du registre par le lancement et la reprise.
    pub(super) fn being_removed(&self, cwd: &Path) -> bool {
        self.removing
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .any(|p| cwd.starts_with(p))
    }

    // ------------------------------------------------------------- lecture

    /// Dépôt désigné par `root` (un dossier existant du dépôt).
    fn repo_param(&self, params: &Value) -> Result<RepoInfo, RpcError> {
        let root = opt_str(params, "root")?.ok_or_else(|| RpcError::params("« root » manquant"))?;
        let p = PathBuf::from(&root);
        if !p.is_absolute() {
            return Err(RpcError::params(format!(
                "« root » doit être absolu : {root}"
            )));
        }
        let p = p
            .canonicalize()
            .map_err(|e| RpcError::params(format!("dossier introuvable : {root} ({e})")))?;
        self.deps.vcs.resolve(&p).ok_or_else(|| {
            RpcError::new(
                error_code::NOT_A_REPO,
                format!("« root » n'est pas dans un dépôt git : {root}"),
            )
        })
    }

    /// Dossiers des sessions vivantes.
    fn live_cwds(&self) -> Vec<PathBuf> {
        self.lock()
            .sessions
            .values()
            .filter(|e| e.run.is_some())
            .map(|e| e.session.cwd.clone())
            .collect()
    }

    /// Worktrees d'un dépôt avec leur état. Bloquant (`git`).
    fn worktree_views(
        &self,
        repo: &RepoInfo,
    ) -> Result<(Option<Reference>, Vec<WorktreeView>), RpcError> {
        let g = &self.deps.worktrees;
        let root = git_root(repo);
        let list = g.list(&root).map_err(git_error)?;
        let reference = g.reference(&root);
        let paths: Vec<PathBuf> = list.iter().map(|e| e.path.clone()).collect();
        // Worktrees créés par le démon (et commit de départ d'une branche
        // neuve) ; ceux que git ne connaît plus sont oubliés.
        let mut recorded: HashMap<PathBuf, Option<String>> = HashMap::new();
        for r in self.deps.store.load_worktrees().unwrap_or_default() {
            if r.common_dir != repo.common_dir {
                continue;
            }
            if !paths.contains(&r.path) {
                if let Err(e) = self.deps.store.delete_worktree(&r.path) {
                    error!("worktree {} : suppression en base : {e}", r.path.display());
                }
                continue;
            }
            let start = if r.created_branch { r.start_sha } else { None };
            recorded.insert(r.path, start);
        }
        let mut running = vec![0usize; list.len()];
        for cwd in self.live_cwds() {
            if let Some(i) = owning_worktree(&paths, &cwd) {
                running[i] += 1;
            }
        }
        let views = list
            .into_iter()
            .enumerate()
            .map(|(i, e)| {
                let main = i == 0;
                let exists = e.path.is_dir();
                let dirty = (exists && !e.bare)
                    .then(|| g.status_paths(&e.path).ok().map(|p| !p.is_empty()))
                    .flatten();
                let (ahead, integrated) = match (&reference, &e.branch) {
                    (Some(r), Some(b)) => (
                        g.ahead(&root, &r.full, b),
                        (!main)
                            .then(|| {
                                integrated_with_start(
                                    g.as_ref(),
                                    &root,
                                    r,
                                    b,
                                    e.head.as_deref(),
                                    recorded.get(&e.path).cloned().flatten().as_deref(),
                                )
                            })
                            .flatten(),
                    ),
                    _ => (None, None),
                };
                WorktreeView {
                    managed_by: managed_by(
                        &e.path,
                        &repo.project_root,
                        recorded.contains_key(&e.path),
                    ),
                    path: e.path,
                    branch: e.branch,
                    head: e.head,
                    main,
                    locked: e.locked,
                    prunable: e.prunable,
                    exists,
                    dirty,
                    ahead,
                    integrated,
                    sessions_running: running[i],
                }
            })
            .collect();
        Ok((reference, views))
    }

    /// `worktrees.list {root}`. Bloquant (`git`).
    pub fn worktrees_list(&self, params: &Value) -> Result<Value, RpcError> {
        let repo = self.repo_param(params)?;
        let (reference, views) = self.worktree_views(&repo)?;
        self.watch_repo(&repo, &views);
        Ok(json!({
            "root": repo.project_root,
            "common_dir": repo.common_dir,
            "default_branch": reference.as_ref().map(|r| r.default_branch.clone()),
            "reference": reference.as_ref().map(|r| r.short.clone()),
            "worktrees": views.iter().map(|v| json!({
                "path": v.path,
                "branch": v.branch,
                "head": v.head,
                "main": v.main,
                "locked": v.locked,
                "prunable": v.prunable,
                "exists": v.exists,
                "dirty": v.dirty,
                "ahead": v.ahead,
                "integrated": v.integrated.map(Integrated::as_str),
                "sessions_running": v.sessions_running,
                "managed_by": v.managed_by.map(|m| m.as_str()),
            })).collect::<Vec<_>>(),
        }))
    }

    // ----------------------------------------------------------- suppression

    /// `worktrees.remove {root, path, delete_branch?, force?}`. Bloquant (`git`).
    pub fn worktrees_remove(&self, params: &Value) -> Result<Value, RpcError> {
        let repo = self.repo_param(params)?;
        let path = opt_str(params, "path")?
            .filter(|p| !p.is_empty())
            .ok_or_else(|| RpcError::params("« path » manquant"))?;
        let path = PathBuf::from(path);
        if !path.is_absolute() {
            return Err(RpcError::params(format!(
                "« path » doit être absolu : {}",
                path.display()
            )));
        }
        let delete_branch = bool_param(params, "delete_branch")?;
        let force = bool_param(params, "force")?;
        let g = &self.deps.worktrees;
        let root = git_root(&repo);
        // Même verrou que la création : la liste, les contrôles et la
        // suppression ne s'entremêlent pas avec un autre changement du dépôt.
        let lock = self.repo_lock(&repo.common_dir);
        let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        let list = g.list(&root).map_err(git_error)?;
        let canonical = path.canonicalize().ok();
        let idx = list
            .iter()
            .position(|e| e.path == path || Some(&e.path) == canonical.as_ref())
            .ok_or_else(|| {
                RpcError::params(format!(
                    "« {} » n'est pas un worktree de ce dépôt",
                    path.display()
                ))
            })?;
        if idx == 0 {
            return Err(RpcError::params(
                "le worktree principal ne peut pas être supprimé",
            ));
        }
        let target = list[idx].clone();
        let reference = g.reference(&root);
        if delete_branch
            && let (Some(b), Some(r)) = (&target.branch, &reference)
            && (*b == r.default_branch || *b == r.short)
        {
            return Err(RpcError::params(format!(
                "la branche « {b} » est la branche par défaut (ou de référence) : elle n'est jamais supprimée"
            )));
        }
        let paths: Vec<PathBuf> = list.iter().map(|e| e.path.clone()).collect();
        let in_use = |d: &Self| {
            d.live_cwds()
                .iter()
                .any(|cwd| owning_worktree(&paths, cwd) == Some(idx))
        };
        if in_use(self) {
            return Err(RpcError::new(
                error_code::WORKTREE_IN_USE,
                "une session tourne dans ce worktree",
            ));
        }
        if !force && target.path.is_dir() {
            let files = g.status_paths(&target.path).map_err(git_error)?;
            if !files.is_empty() {
                let total = files.len();
                return Err(RpcError::new(
                    error_code::WORKTREE_DIRTY,
                    format!(
                        "le worktree a des modifications non commitées ou des fichiers non suivis \
                         ({total} fichier(s)) : forcer la suppression pour les perdre"
                    ),
                )
                .with_data(json!({
                    "files": files.into_iter().take(MAX_DIRTY_FILES).collect::<Vec<_>>(),
                    "total": total,
                })));
            }
        }
        let start_sha = self
            .deps
            .store
            .load_worktrees()
            .unwrap_or_default()
            .into_iter()
            .find(|r| r.path == target.path && r.created_branch)
            .and_then(|r| r.start_sha);
        let integrated = match (&reference, &target.branch) {
            (Some(r), Some(b)) => integrated_with_start(
                g.as_ref(),
                &root,
                r,
                b,
                target.head.as_deref(),
                start_sha.as_deref(),
            ),
            _ => None,
        };
        // Plus aucun lancement ni reprise dans ce worktree, puis second
        // contrôle des sessions vivantes juste avant de supprimer.
        let _removing = RemovingGuard::new(self, &target.path);
        if in_use(self) {
            return Err(RpcError::new(
                error_code::WORKTREE_IN_USE,
                "une session tourne dans ce worktree",
            ));
        }
        g.remove(&root, &target.path, force, target.locked)
            .map_err(git_error)?;
        info!(
            "worktree {} supprimé{}",
            target.path.display(),
            if force { " (forcé)" } else { "" }
        );
        if let Err(e) = self.deps.store.delete_worktree(&target.path) {
            error!(
                "worktree {} : suppression en base : {e}",
                target.path.display()
            );
        }
        let (branch_deleted, branch_error) = match (&target.branch, delete_branch) {
            (Some(b), true) => {
                // `-D` quand notre propre référence dit que rien n'est perdu
                // (intégrée, squash, ou aucun commit à elle), ou sur demande ;
                // `-d` sinon, qui laisse git vérifier.
                let hard = force
                    || matches!(
                        integrated,
                        Some(Integrated::Merged | Integrated::Squashed | Integrated::Empty)
                    );
                match g.delete_branch(&root, b, hard) {
                    Ok(()) => {
                        info!("branche {b} supprimée");
                        (Some(true), None)
                    }
                    Err(e) => (Some(false), Some(git_message(&e))),
                }
            }
            (None, true) => (Some(false), Some("worktree sans branche".to_owned())),
            (_, false) => (None, None),
        };
        drop(_removing);
        // Les sessions arrêtées de ce worktree : `resume_blocker: "cwd_missing"`.
        self.refresh_resumable(None);
        self.worktrees_touched(&repo.common_dir, &repo.project_root);
        Ok(json!({
            "removed": true,
            "path": target.path,
            "branch": target.branch,
            "branch_deleted": branch_deleted,
            "branch_error": branch_error,
        }))
    }

    // ------------------------------------------------------ identité du projet

    /// Projet enregistré d'un dossier qui n'existe plus : celui d'une session
    /// dont le dossier contient `path`, sinon celui d'un worktree créé par le
    /// démon qui le contient. `(racine, dossier commun)`.
    pub(super) fn known_project_of(&self, path: &Path) -> Option<(PathBuf, PathBuf)> {
        let from_session = {
            let reg = self.lock();
            reg.sessions
                .values()
                .filter(|e| path.starts_with(&e.session.cwd))
                .filter_map(|e| {
                    e.session.project_common_dir.clone().map(|c| {
                        (
                            e.session.cwd.components().count(),
                            e.session.project_root.clone(),
                            c,
                        )
                    })
                })
                .max_by_key(|(depth, _, _)| *depth)
                .map(|(_, root, c)| (root, c))
        };
        from_session.or_else(|| {
            self.deps
                .store
                .load_worktrees()
                .unwrap_or_default()
                .into_iter()
                .find(|r| path.starts_with(&r.path))
                .map(|r| (r.project_root, r.common_dir))
        })
    }

    /// Au démarrage : identité du projet des sessions qui n'en ont pas encore
    /// (bases d'avant le schéma v6), relue par `git` quand leur dossier
    /// existe, sinon prise d'un worktree créé par le démon qui le contient.
    /// Bloquant, hors du verrou du registre.
    pub(super) fn backfill_common_dirs(&self) {
        {
            let records = self.deps.store.load_worktrees().unwrap_or_default();
            let mut watch = self
                .worktree_watch
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            for r in records {
                let w = watch.entry(r.common_dir).or_default();
                w.root = r.project_root;
                w.linked = true;
            }
        }
        let todo: Vec<(Uuid, PathBuf)> = self
            .lock()
            .sessions
            .values()
            .filter(|e| e.session.project_common_dir.is_none())
            .map(|e| (e.session.id, e.session.cwd.clone()))
            .collect();
        if todo.is_empty() {
            return;
        }
        let records = self.deps.store.load_worktrees().unwrap_or_default();
        let mut by_cwd: HashMap<PathBuf, Option<PathBuf>> = HashMap::new();
        for (_, cwd) in &todo {
            if by_cwd.contains_key(cwd) {
                continue;
            }
            let found = if cwd.is_dir() {
                self.deps.vcs.resolve(cwd).map(|r| r.common_dir)
            } else {
                records
                    .iter()
                    .find(|r| cwd.starts_with(&r.path))
                    .map(|r| r.common_dir.clone())
            };
            by_cwd.insert(cwd.clone(), found);
        }
        let mut reg = self.lock();
        let mut filled = 0;
        for (id, cwd) in todo {
            let Some(Some(common)) = by_cwd.get(&cwd) else {
                continue;
            };
            if let Some(e) = reg.sessions.get_mut(&id)
                && e.session.cwd == cwd
                && e.session.project_common_dir.is_none()
            {
                e.session.project_common_dir = Some(common.clone());
                self.commit(e);
                filled += 1;
            }
        }
        if filled > 0 {
            info!("identité du projet relevée pour {filled} session(s)");
        }
    }

    // ------------------------------------------------------- notification

    /// Projet suivi pour `project.worktrees_changed` ; sans référence encore,
    /// cette mesure en sert (le changement suivant sera notifié).
    fn watch_repo(&self, repo: &RepoInfo, views: &[WorktreeView]) {
        let mut watch = self
            .worktree_watch
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let w = watch.entry(repo.common_dir.clone()).or_default();
        w.root = repo.project_root.clone();
        w.linked = views.len() > 1;
        if w.notified.is_none() && !w.in_flight {
            w.notified = Some(fingerprint(views));
        }
    }

    /// Worktree créé ou supprimé par le démon : notification immédiate, puis
    /// recalcul qui sert de nouvelle référence (sans seconde notification).
    pub(super) fn worktrees_touched(&self, common_dir: &Path, root: &Path) {
        {
            let mut watch = self
                .worktree_watch
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let w = watch.entry(common_dir.to_path_buf()).or_default();
            w.root = root.to_path_buf();
            w.notified = None;
        }
        let _ = self
            .events
            .send(Event::WorktreesChanged(root.to_path_buf()));
        self.schedule_worktrees_check(common_dir.to_path_buf(), root.to_path_buf(), false);
    }

    /// Racines des projets suivis (rattrapage d'un client en retard).
    pub fn worktree_roots(&self) -> Vec<PathBuf> {
        self.worktree_watch
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .map(|w| w.root.clone())
            .filter(|r| !r.as_os_str().is_empty())
            .collect()
    }

    /// Recalcule les worktrees d'un projet dans [`WORKTREE_DEBOUNCE`] (un seul
    /// recalcul en attente, jamais deux en même temps) et diffuse
    /// `project.worktrees_changed` si `dirty` ou `integrated` d'un worktree a
    /// changé (ou la liste). Ne prend jamais le verrou du registre.
    pub(super) fn schedule_worktrees_check(
        &self,
        common_dir: PathBuf,
        root: PathBuf,
        from_poll: bool,
    ) {
        {
            let mut watch = self
                .worktree_watch
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let w = watch.entry(common_dir.clone()).or_default();
            if w.root.as_os_str().is_empty() {
                w.root = root;
            }
            if w.pending {
                return;
            }
            if w.in_flight {
                if !from_poll {
                    w.again = true;
                }
                return;
            }
            w.pending = true;
        }
        let Some(daemon) = self.me.upgrade() else {
            return;
        };
        self.runtime.spawn(async move {
            tokio::time::sleep(WORKTREE_DEBOUNCE).await;
            let root = {
                let mut watch = daemon
                    .worktree_watch
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                let Some(w) = watch.get_mut(&common_dir) else {
                    return;
                };
                w.pending = false;
                w.in_flight = true;
                w.root.clone()
            };
            let d = daemon.clone();
            let c = common_dir.clone();
            let _ = tokio::task::spawn_blocking(move || d.check_worktrees(&c, &root)).await;
            let again = {
                let mut watch = daemon
                    .worktree_watch
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                match watch.get_mut(&common_dir) {
                    Some(w) => {
                        w.in_flight = false;
                        std::mem::take(&mut w.again).then(|| w.root.clone())
                    }
                    None => None,
                }
            };
            if let Some(root) = again {
                daemon.schedule_worktrees_check(common_dir, root, false);
            }
        });
    }

    /// Compare l'état des worktrees d'un projet au dernier notifié. Bloquant.
    fn check_worktrees(&self, common_dir: &Path, root: &Path) {
        let Some(repo) = self
            .deps
            .vcs
            .resolve(root)
            .filter(|r| r.common_dir == common_dir)
        else {
            return; // projet disparu ou dossier réutilisé : rien à signaler
        };
        let Ok((_, views)) = self.worktree_views(&repo) else {
            return;
        };
        let fp = fingerprint(&views);
        let changed = {
            let mut watch = self
                .worktree_watch
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let w = watch.entry(common_dir.to_path_buf()).or_default();
            w.linked = views.len() > 1;
            let changed = w.notified.as_ref().is_some_and(|old| *old != fp);
            w.notified = Some(fp);
            changed
        };
        if changed {
            let _ = self.events.send(Event::WorktreesChanged(repo.project_root));
        }
    }

    /// Projets à recalculer au sondage : ceux des sessions vivantes et ceux
    /// qui avaient des worktrees non principaux au dernier calcul (au
    /// démarrage : ceux où le démon a créé un worktree, voir
    /// [`Daemon::backfill_common_dirs`]).
    fn worktree_poll_targets(&self) -> Vec<(PathBuf, PathBuf)> {
        let mut targets: HashMap<PathBuf, PathBuf> = HashMap::new();
        for (c, w) in self
            .worktree_watch
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
        {
            if w.linked && !w.root.as_os_str().is_empty() {
                targets.insert(c.clone(), w.root.clone());
            }
        }
        for e in self.lock().sessions.values().filter(|e| e.run.is_some()) {
            if let Some(c) = &e.session.project_common_dir {
                targets.insert(c.clone(), e.session.project_root.clone());
            }
        }
        targets.into_iter().collect()
    }

    /// Recalcul des worktrees toutes les [`WORKTREE_POLL_INTERVAL`].
    pub fn start_worktree_polling(self: &Arc<Self>) {
        let daemon = Arc::clone(self);
        self.runtime.spawn(async move {
            // Version de git relevée une fois : sans `merge-tree --write-tree`
            // (git < 2.38), le squash n'est jamais évalué.
            let d = daemon.clone();
            if let Ok(false) =
                tokio::task::spawn_blocking(move || d.deps.worktrees.merge_tree_supported()).await
            {
                warning!(
                    "git < 2.38 : « git merge-tree --write-tree » indisponible, \
                     les branches intégrées par squash ne seront pas reconnues"
                );
            }
            loop {
                tokio::time::sleep(WORKTREE_POLL_INTERVAL).await;
                let d = daemon.clone();
                let Ok(targets) =
                    tokio::task::spawn_blocking(move || d.worktree_poll_targets()).await
                else {
                    continue;
                };
                for (common, root) in targets {
                    daemon.schedule_worktrees_check(common, root, true);
                }
            }
        });
    }
}
