//! Plugins (v0.3, lot 22a, ADR 0007) côté démon : `plugins.list`,
//! `plugins.accept`, `plugins.revoke`, `plugins.panel`, `plugins.action`,
//! notification `plugins.changed`.
//!
//! - Le dossier des plugins ([`super::Config::plugins_dir`]) est **relu à
//!   chaque appel** (manifeste et fichiers hachés, empreinte) : rien n'est
//!   gardé en cache, et un plugin modifié depuis l'accord est arrêté dès que
//!   le démon le voit.
//! - Un processus par plugin, lancé **à la première demande** d'un plugin
//!   accepté, partagé par les sessions ; requêtes une à la fois (file par
//!   plugin) ; arrêté après [`super::Config::plugin_idle_timeout`] sans
//!   requête, à la révocation, au changement d'empreinte, à l'arrêt du
//!   démon. Après une défaillance, état `failed` avec sa raison ; relancé
//!   seulement à la demande suivante.
//! - Le contexte de session ne part qu'avec les permissions acceptées :
//!   `session {id}` toujours, `{cwd, worktree_root, branch}` avec
//!   `worktree.read`, `diff` avec `diff.read`.
//!
//! Verrous : la table des plugins est prise brièvement (jamais pendant une
//! requête) ; la file d'un plugin (`queue`) est tenue pendant toute une
//! requête, et peut être tenue en prenant le registre des sessions (jamais
//! l'inverse) ; l'état d'un plugin (`inner`) est un verrou feuille, jamais
//! tenu pendant un appel au processus.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use time::format_description::well_known::Rfc3339;
use uuid::Uuid;

use super::{Daemon, Event, RpcError, opt_str};
use crate::daemon::launch;
use crate::daemon::log::{info, warning};
use crate::daemon::peer::{self, SupervisedProc};
use crate::domain::plugins::document::{
    ResultError, valid_initialize, validate_action_result, validate_args, validate_document,
};
use crate::domain::plugins::manifest::cap_errors;
use crate::domain::plugins::manifest::{Manifest, Program, parse_manifest};
use crate::domain::plugins::{
    self, Acceptance, AcceptanceState, MAX_FILE_BYTES, MAX_MANIFEST_BYTES, MAX_PLUGINS,
    MAX_TOTAL_FILE_BYTES, Permission, ProcessState, clean_error_message, is_action_id,
    is_fingerprint, is_plugin_name, permission_names,
};
use crate::ports::{
    FileStamp, PluginError, PluginFileError, PluginLaunch, PluginProcess, PluginScope,
};

/// Même processus (comparaison des adresses, sans la table virtuelle) ?
fn same_proc(a: &Arc<dyn PluginProcess>, b: &Arc<dyn PluginProcess>) -> bool {
    std::ptr::eq(Arc::as_ptr(a).cast::<()>(), Arc::as_ptr(b).cast::<()>())
}
use crate::protocol::error_code;

/// Délai d'`initialize`.
pub const INIT_TIMEOUT: Duration = Duration::from_secs(10);
/// Délai de `panel.render` et `action.run`.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// Arrêt d'un plugin après ce temps sans requête.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// Un plugin tel que relu sur le disque.
struct Loaded {
    name: String,
    /// Dossier résolu ; `None` : plugin inconnu.
    dir: Option<PathBuf>,
    manifest: Result<Manifest, Vec<String>>,
    fingerprint: Option<String>,
}

/// Échec d'un processus de plugin, montré par `plugins.list`.
#[derive(Debug, Clone)]
struct Failure {
    reason: &'static str,
    message: String,
    stderr_tail: String,
}

/// Empreinte gardée d'un plugin : valable tant que le manifeste (octets
/// exacts) et l'état de chaque fichier haché ([`FileStamp`]) sont les mêmes.
pub(super) struct FingerprintCache {
    manifest: Vec<u8>,
    stamps: Vec<(String, FileStamp)>,
    fingerprint: String,
}

#[derive(Default)]
struct SlotInner {
    proc: Option<Arc<dyn PluginProcess>>,
    /// Incrémenté à chaque révocation : un lancement commencé avant n'installe
    /// pas son processus.
    epoch: u64,
    /// Minuterie d'inactivité en cours (une seule par plugin).
    idle_timer: Option<tokio::task::AbortHandle>,
    /// Empreinte du processus en cours.
    fingerprint: Option<String>,
    /// Numéro du lancement en cours (une fin de processus d'un lancement
    /// précédent est ignorée).
    generation: u64,
    failure: Option<Failure>,
    last_used: Option<Instant>,
}

/// Un plugin connu du démon (au moins une fois demandé).
#[derive(Default)]
pub(super) struct PluginSlot {
    /// Une requête à la fois.
    queue: Mutex<()>,
    inner: Mutex<SlotInner>,
}

impl PluginSlot {
    fn inner(&self) -> MutexGuard<'_, SlotInner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn process_json(&self) -> Value {
        let i = self.inner();
        if i.proc.as_ref().is_some_and(|p| p.alive()) {
            return json!({"state": ProcessState::Running.as_str()});
        }
        match &i.failure {
            Some(f) => {
                let mut v = json!({
                    "state": ProcessState::Failed.as_str(),
                    "reason": f.reason,
                    "message": f.message,
                });
                if !f.stderr_tail.is_empty() {
                    v["stderr_tail"] = json!(f.stderr_tail);
                }
                v
            }
            None => json!({"state": ProcessState::Stopped.as_str()}),
        }
    }
}

/// Table des plugins.
pub(super) type PluginTable = HashMap<String, Arc<PluginSlot>>;

/// Ce que demande l'app.
enum Call {
    Panel,
    Action { id: String, args: Value },
}

fn unknown_plugin(name: &str, errors: Option<&[String]>) -> RpcError {
    let mut e = RpcError::new(
        error_code::UNKNOWN_PLUGIN,
        match errors {
            None => format!("plugin inconnu : « {name} »"),
            Some(_) => format!("manifeste du plugin « {name} » invalide"),
        },
    );
    if let Some(errs) = errors {
        e = e.with_data(json!({"errors": errs}));
    }
    e
}

fn not_accepted(name: &str, state: AcceptanceState, fingerprint: Option<&str>) -> RpcError {
    RpcError::new(
        error_code::PLUGIN_NOT_ACCEPTED,
        match state {
            AcceptanceState::Changed => format!("le plugin « {name} » a changé depuis ton accord"),
            _ => format!("le plugin « {name} » n'est pas accepté"),
        },
    )
    .with_data(json!({"acceptance": state.as_str(), "fingerprint": fingerprint}))
}

fn failed(e: &PluginError, stderr_tail: &str) -> RpcError {
    let message = match e {
        PluginError::Error { message, .. } => {
            format!(
                "le plugin a répondu une erreur : {}",
                clean_error_message(message)
            )
        }
        other => other.message(),
    };
    let mut data = json!({"reason": e.reason()});
    if !stderr_tail.is_empty() {
        data["stderr_tail"] = json!(stderr_tail);
    }
    RpcError::new(error_code::PLUGIN_FAILED, message).with_data(data)
}

fn invalid_result(problem: &str) -> RpcError {
    RpcError::new(
        error_code::PLUGIN_INVALID_RESULT,
        format!("résultat du plugin refusé : {problem}"),
    )
    .with_data(json!({"problem": problem}))
}

/// `name` des paramètres (nom de plugin valide).
fn name_param(params: &Value) -> Result<String, RpcError> {
    let name = opt_str(params, "name")?.ok_or_else(|| RpcError::params("« name » manquant"))?;
    if !is_plugin_name(&name) {
        return Err(RpcError::params("« name » : nom de plugin invalide"));
    }
    Ok(name)
}

fn fingerprint_param(params: &Value) -> Result<String, RpcError> {
    let fp = opt_str(params, "expected_fingerprint")?
        .ok_or_else(|| RpcError::params("« expected_fingerprint » manquant"))?;
    if !is_fingerprint(&fp) {
        return Err(RpcError::params(
            "« expected_fingerprint » : 64 caractères hexadécimaux attendus",
        ));
    }
    Ok(fp)
}

fn locale_param(params: &Value) -> Result<String, RpcError> {
    match opt_str(params, "locale")?.as_deref() {
        Some("fr") => Ok("fr".into()),
        Some("en") => Ok("en".into()),
        _ => Err(RpcError::params("« locale » : « fr » ou « en » attendu")),
    }
}

/// `diff` envoyé au plugin : `{base, files, truncated}`.
fn plugin_diff_json(c: &crate::domain::diff::ChangeSet) -> Value {
    let mut v = super::changeset_json(c);
    if let Some(o) = v.as_object_mut() {
        o.remove("skipped_non_utf8");
    }
    v
}

impl Daemon {
    fn plugin_table(&self) -> MutexGuard<'_, PluginTable> {
        self.plugins.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn plugin_slot(&self, name: &str) -> Arc<PluginSlot> {
        self.plugin_table()
            .entry(name.to_owned())
            .or_default()
            .clone()
    }

    fn existing_slot(&self, name: &str) -> Option<Arc<PluginSlot>> {
        self.plugin_table().get(name).cloned()
    }

    fn plugins_changed(&self) {
        let _ = self.events.send(Event::PluginsChanged);
    }

    fn acceptance_of(&self, name: &str) -> Option<Acceptance> {
        match self.deps.store.plugin_acceptances() {
            Ok(all) => all.into_iter().find(|a| a.name == name),
            Err(e) => {
                warning!("lecture des accords des plugins : {e}");
                None
            }
        }
    }

    /// Relit un plugin : dossier résolu, manifeste, fichiers hachés,
    /// empreinte. Bloquant (disque).
    fn load_plugin(&self, name: &str) -> Loaded {
        let files = self.deps.plugin_files.as_ref();
        let dir = files.resolve(&self.config.plugins_dir, name);
        let mut loaded = Loaded {
            name: name.to_owned(),
            dir: dir.clone(),
            manifest: Err(Vec::new()),
            fingerprint: None,
        };
        let Some(dir) = dir else {
            return loaded;
        };
        let bytes = match files.read(&dir, "plugin.json", MAX_MANIFEST_BYTES as u64) {
            Ok(b) => b,
            Err(e) => {
                loaded.manifest = Err(vec![match e {
                    PluginFileError::NotFound => "plugin.json absent".to_owned(),
                    PluginFileError::TooLarge(_) => {
                        format!("plugin.json : plus de {} Kio", MAX_MANIFEST_BYTES / 1024)
                    }
                    PluginFileError::Refused(why) => format!("plugin.json : {why}"),
                }]);
                return loaded;
            }
        };
        let manifest = match parse_manifest(&bytes, name) {
            Ok(m) => m,
            Err(errs) => {
                loaded.manifest = Err(errs);
                return loaded;
            }
        };
        // Empreinte gardée si rien n'a changé (état relevé **avant** toute
        // lecture : un fichier modifié pendant le calcul change d'état, et
        // l'empreinte est recalculée à l'appel suivant).
        let stamps: Option<Vec<(String, FileStamp)>> = manifest
            .files
            .iter()
            .map(|rel| Some((rel.clone(), files.stamp(&dir, rel)?)))
            .collect();
        if let Some(stamps) = &stamps {
            let cache = self
                .plugin_fp_cache
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if let Some(c) = cache.get(name)
                && c.manifest == bytes
                && &c.stamps == stamps
            {
                loaded.fingerprint = Some(c.fingerprint.clone());
                loaded.manifest = Ok(manifest);
                return loaded;
            }
        }
        let mut contents: Vec<(String, Vec<u8>)> = Vec::with_capacity(manifest.files.len());
        let mut errors = Vec::new();
        let mut total: u64 = 0;
        for rel in &manifest.files {
            match files.read(&dir, rel, MAX_FILE_BYTES) {
                Ok(b) => {
                    total += b.len() as u64;
                    contents.push((rel.clone(), b));
                }
                Err(PluginFileError::NotFound) => errors.push(format!("« {rel} » absent")),
                Err(PluginFileError::TooLarge(_)) => errors.push(format!(
                    "« {rel} » : plus de {} Mio",
                    MAX_FILE_BYTES / 1024 / 1024
                )),
                Err(PluginFileError::Refused(why)) => errors.push(format!("« {rel} » : {why}")),
            }
        }
        if total > MAX_TOTAL_FILE_BYTES {
            errors.push(format!(
                "fichiers hachés : plus de {} Mio en tout",
                MAX_TOTAL_FILE_BYTES / 1024 / 1024
            ));
        }
        if !errors.is_empty() {
            self.plugin_fp_cache
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(name);
            loaded.manifest = Err(cap_errors(errors));
            return loaded;
        }
        let fingerprint = plugins::manifest::fingerprint(&bytes, &contents);
        if let Some(stamps) = stamps {
            self.plugin_fp_cache
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(
                    name.to_owned(),
                    FingerprintCache {
                        manifest: bytes,
                        stamps,
                        fingerprint: fingerprint.clone(),
                    },
                );
        }
        loaded.fingerprint = Some(fingerprint);
        loaded.manifest = Ok(manifest);
        loaded
    }

    /// Objet `Plugin` de `plugins.list`.
    fn plugin_json(&self, l: &Loaded, accepted: Option<&Acceptance>) -> Value {
        let perms: &[Permission] = l
            .manifest
            .as_ref()
            .map(|m| m.permissions.as_slice())
            .unwrap_or_default();
        let acceptance = AcceptanceState::of(accepted, l.fingerprint.as_deref(), perms);
        let mut v = json!({
            "name": l.name,
            "valid": l.manifest.is_ok(),
            "errors": l.manifest.as_ref().err().cloned().unwrap_or_default(),
            "permissions": permission_names(perms),
            "actions": [],
            "fingerprint": l.fingerprint,
            "acceptance": acceptance.as_str(),
            "process": self
                .existing_slot(&l.name)
                .map_or_else(|| json!({"state": "stopped"}), |s| s.process_json()),
        });
        if let Ok(m) = &l.manifest {
            v["version"] = json!(m.version);
            v["label"] = m.label.json();
            if let Some(d) = &m.description {
                v["description"] = d.json();
            }
            // `config` tel que haché (déjà borné à 16 Kio et sans invisible
            // ni contrôle par la validation) : montré à l'acceptation.
            if m.config_declared {
                v["config"] = m.config.clone();
            }
            v["command"] = json!(m.command);
            v["files"] = json!(m.files);
            if let Some(t) = &m.session_tab {
                v["tab"] = json!({"label": t.json()});
            }
            v["actions"] = Value::Array(
                m.actions
                    .iter()
                    .map(|a| json!({"id": a.id, "label": a.label.json(), "propose": a.propose}))
                    .collect(),
            );
        }
        if let Some(a) = accepted {
            v["accepted_fingerprint"] = json!(a.fingerprint);
            v["accepted_permissions"] = json!(a.permissions);
        }
        v
    }

    /// Le processus d'un plugin qui n'est plus accepté tel qu'il tourne
    /// (empreinte changée, accord retiré, manifeste invalide) est arrêté, en
    /// arrière-plan.
    fn stop_if_stale(self: &Arc<Self>, l: &Loaded, accepted: Option<&Acceptance>) {
        let Some(slot) = self.existing_slot(&l.name) else {
            return;
        };
        let perms: &[Permission] = l
            .manifest
            .as_ref()
            .map(|m| m.permissions.as_slice())
            .unwrap_or_default();
        let ok = AcceptanceState::of(accepted, l.fingerprint.as_deref(), perms)
            == AcceptanceState::Accepted;
        let stale = {
            let i = slot.inner();
            (i.proc.is_some() && (!ok || i.fingerprint != l.fingerprint)).then_some(i.generation)
        };
        if let Some(generation) = stale {
            info!("plugin {} modifié ou plus accepté : arrêt", l.name);
            let daemon = Arc::clone(self);
            let name = l.name.clone();
            super::spawn_thread(
                &format!("plugin-arret-{}", &name[..name.len().min(8)]),
                move || {
                    daemon.stop_plugin_slot(&slot, &name, Some(generation));
                },
            );
        }
    }

    /// Arrête le processus d'un plugin (bloquant), état `stopped`.
    /// `generation` : n'arrêter que ce lancement-là (un processus relancé
    /// depuis est gardé).
    fn stop_plugin_slot(&self, slot: &PluginSlot, name: &str, generation: Option<u64>) {
        let proc = {
            let mut i = slot.inner();
            if generation.is_some_and(|g| g != i.generation) {
                return;
            }
            i.fingerprint = None;
            i.failure = None;
            i.proc.take()
        };
        if let Some(p) = proc {
            p.stop();
            info!("plugin {name} arrêté");
            self.plugins_changed();
        }
    }

    /// Défaillance : le processus est arrêté, l'état passe à `failed`.
    fn fail_plugin(
        &self,
        slot: &PluginSlot,
        name: &str,
        e: &PluginError,
        proc: &Arc<dyn PluginProcess>,
    ) -> RpcError {
        let stderr_tail = proc.stderr_tail();
        // Processus déjà retiré (révocation, arrêt du démon, changement
        // d'empreinte, sortie relevée ailleurs) : l'arrêt était demandé, ce
        // n'est pas une défaillance à montrer.
        let owned = {
            let mut i = slot.inner();
            let owned = i.proc.as_ref().is_some_and(|p| same_proc(p, proc));
            if owned {
                i.proc = None;
            }
            owned
        };
        proc.stop();
        if !owned {
            return failed(e, &stderr_tail);
        }
        warning!(
            "plugin {name} : défaillance ({}) : {}",
            e.reason(),
            e.message()
        );
        {
            let mut i = slot.inner();
            i.fingerprint = None;
            i.failure = Some(Failure {
                reason: e.reason(),
                message: e.message(),
                stderr_tail: stderr_tail.clone(),
            });
        }
        self.plugins_changed();
        failed(e, &stderr_tail)
    }

    /// Fin d'un processus de plugin (fil d'attente de l'adaptateur) : une
    /// sortie seule, hors arrêt demandé, est une défaillance (`closed`).
    fn on_plugin_exit(&self, name: &str, generation: u64) {
        let Some(slot) = self.existing_slot(name) else {
            return;
        };
        let proc = {
            let mut i = slot.inner();
            if i.generation != generation || i.proc.is_none() {
                return;
            }
            i.fingerprint = None;
            i.proc.take()
        };
        let Some(proc) = proc else {
            return;
        };
        let tail = proc.stderr_tail();
        // Le scope est tué même si le processus est sorti seul.
        proc.stop();
        warning!("plugin {name} : sorti de lui-même");
        {
            let mut i = slot.inner();
            // Une défaillance relevée par la requête en cours prime.
            if i.generation == generation && i.failure.is_none() {
                i.failure = Some(Failure {
                    reason: PluginError::Closed.reason(),
                    message: PluginError::Closed.message(),
                    stderr_tail: tail,
                });
            }
        }
        self.plugins_changed();
    }

    /// Programme à lancer : nom cherché dans le `PATH` du démon, chemin
    /// absolu, ou `./…` sous le dossier du plugin.
    fn plugin_program(&self, m: &Manifest, dir: &std::path::Path) -> Result<PathBuf, PluginError> {
        let path = match &m.program {
            Program::Named(n) => launch::find_in_path(n, self.config.path_env.as_deref())
                .ok_or_else(|| {
                    PluginError::Launch(format!("« {n} » introuvable dans le PATH du démon"))
                })?,
            Program::Absolute(p) => PathBuf::from(p),
            Program::Local(rel) => dir.join(rel),
        };
        if !launch::is_executable(&path) {
            return Err(PluginError::Launch(format!(
                "« {} » n'est pas un fichier exécutable",
                m.command[0]
            )));
        }
        Ok(path)
    }

    /// Processus du plugin pour cette empreinte : celui qui tourne, sinon un
    /// nouveau, initialisé. File du plugin tenue.
    fn ensure_plugin_process(
        self: &Arc<Self>,
        slot: &PluginSlot,
        l: &Loaded,
        m: &Manifest,
        accepted: &Acceptance,
        locale: &str,
        epoch: u64,
    ) -> Result<Arc<dyn PluginProcess>, RpcError> {
        let old = {
            let mut i = slot.inner();
            match &i.proc {
                Some(p) if p.alive() && i.fingerprint == l.fingerprint => return Ok(p.clone()),
                _ => {}
            }
            i.proc.take()
        };
        if let Some(p) = old {
            p.stop();
        }
        let dir = l.dir.clone().expect("plugin chargé");
        let fail_launch = |e: PluginError| {
            {
                let mut i = slot.inner();
                i.failure = Some(Failure {
                    reason: e.reason(),
                    message: e.message(),
                    stderr_tail: String::new(),
                });
            }
            warning!("plugin {} : {}", l.name, e.message());
            self.plugins_changed();
            failed(&e, "")
        };
        let program = self.plugin_program(m, &dir).map_err(fail_launch)?;
        // Juste avant le lancement : l'accord et l'empreinte sont relus (une
        // révocation ou une modification depuis le début de l'appel refuse
        // le lancement).
        self.refuse_if_shutting_down()?;
        let now = self.load_plugin(&l.name);
        let accepted_now = self.acceptance_of(&l.name);
        let perms_now: &[Permission] = now
            .manifest
            .as_ref()
            .map(|m| m.permissions.as_slice())
            .unwrap_or_default();
        let state_now =
            AcceptanceState::of(accepted_now.as_ref(), now.fingerprint.as_deref(), perms_now);
        if state_now != AcceptanceState::Accepted
            || now.fingerprint != l.fingerprint
            || accepted_now.as_ref().map(|a| &a.fingerprint) != Some(&accepted.fingerprint)
        {
            return Err(not_accepted(&l.name, state_now, now.fingerprint.as_deref()));
        }
        // Numéro du lancement et part aléatoire : deux démons (tests) ou un
        // scope resté d'un démon tué n'entrent jamais en collision.
        let n = format!(
            "{}-{}",
            self.plugin_seq.fetch_add(1, Ordering::SeqCst) + 1,
            &Uuid::new_v4().simple().to_string()[..8]
        );
        let scope = self
            .config
            .systemd_run
            .clone()
            .zip(self.config.systemctl.clone())
            .map(|(systemd_run, systemctl)| PluginScope {
                systemd_run,
                systemctl,
                unit: format!("{}{}-{n}.scope", peer::PLUGIN_SCOPE_PREFIX, l.name),
                runtime_dir: self.config.systemd_runtime_dir.clone(),
            });
        let generation = {
            let mut i = slot.inner();
            i.generation += 1;
            i.generation
        };
        let weak = self.me.clone();
        let name = l.name.clone();
        let on_exit = Box::new(move || {
            if let Some(d) = weak.upgrade() {
                d.on_plugin_exit(&name, generation);
            }
        });
        let launch_spec = PluginLaunch {
            name: l.name.clone(),
            program,
            args: m.command[1..].to_vec(),
            cwd: dir,
            env: plugins::plugin_env(std::env::vars_os()),
            scope: scope.clone(),
        };
        let proc = self
            .deps
            .plugin_host
            .spawn(&launch_spec, on_exit)
            .map_err(fail_launch)?;
        if let Some(pid) = proc.pid() {
            // Ses descendants n'ont pas accès au socket de contrôle, même
            // sans scope systemd.
            self.supervised
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(
                    pid,
                    SupervisedProc {
                        start: peer::start_time(pid),
                        scope: scope.as_ref().map(|s| s.unit.clone()),
                    },
                );
        }
        // Installé seulement si rien n'a changé depuis le début de l'appel,
        // sous le verrou de l'état : une révocation (`epoch`) ou l'arrêt du
        // démon arrivés pendant le lancement l'arrêtent aussitôt, et aucun
        // processus n'échappe à `stop_all_plugins` (qui prend les processus
        // sous ce même verrou après avoir posé `shutting_down`).
        let refused = {
            let mut i = slot.inner();
            let shutting_down = self.shutting_down.load(Ordering::SeqCst);
            if shutting_down || i.epoch != epoch {
                Some(shutting_down)
            } else {
                i.proc = Some(proc.clone());
                i.fingerprint = l.fingerprint.clone();
                i.failure = None;
                None
            }
        };
        if let Some(shutting_down) = refused {
            proc.stop();
            info!(
                "plugin {} : lancement annulé (révocation ou arrêt du démon)",
                l.name
            );
            return Err(if shutting_down {
                RpcError::new(error_code::INVALID_STATE, "le démon s'arrête")
            } else {
                not_accepted(&l.name, AcceptanceState::None, l.fingerprint.as_deref())
            });
        }
        info!(
            "plugin {} lancé (pid {:?}{})",
            l.name,
            proc.pid(),
            scope
                .as_ref()
                .map(|s| format!(", scope {}", s.unit))
                .unwrap_or_default()
        );
        let init = proc.request(
            "initialize",
            Some(json!({
                "api_version": plugins::API_VERSION,
                "locale": locale,
                "config": m.config,
                "permissions": accepted.permissions,
                "host": {"name": "devmaestro", "version": env!("CARGO_PKG_VERSION")},
            })),
            self.config.plugin_init_timeout,
        );
        let err = match init {
            Ok(v) if valid_initialize(&v) => None,
            Ok(_) => Some(PluginError::Protocol(
                "initialize : « api_version: 1 » attendu".into(),
            )),
            Err(PluginError::Error { message, .. }) => Some(PluginError::Protocol(format!(
                "initialize refusé : {}",
                clean_error_message(&message)
            ))),
            Err(e) => Some(e),
        };
        if let Some(e) = err {
            return Err(self.fail_plugin(slot, &l.name, &e, &proc));
        }
        self.plugins_changed();
        Ok(proc)
    }

    /// Arrêt après [`super::Config::plugin_idle_timeout`] sans requête.
    /// Une seule minuterie par plugin : chaque requête remplace la précédente.
    fn schedule_plugin_idle_stop(self: &Arc<Self>, slot: &PluginSlot, name: &str) {
        let idle = self.config.plugin_idle_timeout;
        let daemon = Arc::clone(self);
        let name = name.to_owned();
        let task = self.runtime.spawn(async move {
            tokio::time::sleep(idle).await;
            let d = daemon.clone();
            let _ = tokio::task::spawn_blocking(move || {
                let Some(slot) = d.existing_slot(&name) else {
                    return;
                };
                // Une requête en cours : elle reprogrammera l'arrêt.
                let Ok(_queue) = slot.queue.try_lock() else {
                    return;
                };
                let idle_enough = {
                    let i = slot.inner();
                    i.proc.is_some() && i.last_used.is_some_and(|t| t.elapsed() >= idle)
                };
                if idle_enough {
                    info!("plugin {name} : {} s sans requête", idle.as_secs());
                    d.stop_plugin_slot(&slot, &name, None);
                }
            })
            .await;
        });
        if let Some(old) = slot.inner().idle_timer.replace(task.abort_handle()) {
            old.abort();
        }
    }

    /// `plugins.list {}` → `{dir, plugins}`. Bloquant (disque).
    pub fn plugins_list(self: &Arc<Self>, _params: &Value) -> Result<Value, RpcError> {
        let names = self.deps.plugin_files.list(&self.config.plugins_dir);
        let acceptances = self.deps.store.plugin_acceptances().unwrap_or_else(|e| {
            warning!("lecture des accords des plugins : {e}");
            Vec::new()
        });
        let mut out = Vec::new();
        for name in names.into_iter().take(MAX_PLUGINS) {
            let l = self.load_plugin(&name);
            let accepted = acceptances.iter().find(|a| a.name == name);
            self.stop_if_stale(&l, accepted);
            out.push(self.plugin_json(&l, accepted));
        }
        Ok(json!({"dir": self.config.plugins_dir, "plugins": out}))
    }

    /// `plugins.accept {name, expected_fingerprint}` → `{plugin}`. Bloquant.
    pub fn plugins_accept(self: &Arc<Self>, params: &Value) -> Result<Value, RpcError> {
        let name = name_param(params)?;
        let expected = fingerprint_param(params)?;
        let l = self.load_plugin(&name);
        if l.dir.is_none() {
            return Err(unknown_plugin(&name, None));
        }
        let m = match &l.manifest {
            Ok(m) => m,
            Err(errs) => return Err(unknown_plugin(&name, Some(errs))),
        };
        let fp = l.fingerprint.clone().expect("manifeste valide");
        if fp != expected {
            return Err(RpcError::new(
                error_code::PLUGIN_FINGERPRINT_MISMATCH,
                "le plugin a changé depuis qu'il a été montré",
            )
            .with_data(json!({"fingerprint": fp})));
        }
        let a = Acceptance {
            name: name.clone(),
            fingerprint: fp,
            permissions: permission_names(&m.permissions),
            accepted_at: self.now().format(&Rfc3339).unwrap_or_default(),
        };
        self.deps.store.accept_plugin(&a).map_err(|e| {
            RpcError::new(
                error_code::INTERNAL_ERROR,
                format!("enregistrement de l'accord : {e}"),
            )
        })?;
        info!(
            "plugin {name} accepté (permissions : {})",
            a.permissions.join(", ")
        );
        self.stop_if_stale(&l, Some(&a));
        self.plugins_changed();
        Ok(json!({"plugin": self.plugin_json(&l, Some(&a))}))
    }

    /// `plugins.revoke {name}` → `{plugin}` (`null` pour un nom inconnu).
    /// Bloquant (arrêt du processus).
    pub fn plugins_revoke(self: &Arc<Self>, params: &Value) -> Result<Value, RpcError> {
        let name = name_param(params)?;
        let removed = self.deps.store.revoke_plugin(&name).map_err(|e| {
            RpcError::new(
                error_code::INTERNAL_ERROR,
                format!("retrait de l'accord : {e}"),
            )
        })?;
        if removed {
            info!("plugin {name} : accord retiré");
        }
        if let Some(slot) = self.existing_slot(&name) {
            // Un lancement en cours n'installera pas son processus ; une
            // requête en cours se termine en erreur (processus arrêté).
            slot.inner().epoch += 1;
            self.stop_plugin_slot(&slot, &name, None);
        }
        if removed {
            self.plugins_changed();
        }
        let l = self.load_plugin(&name);
        let plugin = if l.dir.is_some() {
            self.plugin_json(&l, None)
        } else {
            Value::Null
        };
        Ok(json!({"plugin": plugin}))
    }

    /// `plugins.panel {name, session_id, expected_fingerprint, locale}` →
    /// `{document}`. Bloquant.
    pub fn plugins_panel(self: &Arc<Self>, params: &Value) -> Result<Value, RpcError> {
        self.plugin_call(params, Call::Panel)
    }

    /// `plugins.action {name, action, session_id, expected_fingerprint,
    /// locale, args?}` → `{document?, propose?}`. Bloquant.
    pub fn plugins_action(self: &Arc<Self>, params: &Value) -> Result<Value, RpcError> {
        let id =
            opt_str(params, "action")?.ok_or_else(|| RpcError::params("« action » manquant"))?;
        if !is_action_id(&id) {
            return Err(RpcError::params("« action » : identifiant invalide"));
        }
        let args = match params.get("args") {
            None | Some(Value::Null) => json!({}),
            Some(a) => validate_args(a, "args").map_err(RpcError::params)?,
        };
        self.plugin_call(params, Call::Action { id, args })
    }

    fn plugin_call(self: &Arc<Self>, params: &Value, call: Call) -> Result<Value, RpcError> {
        let name = name_param(params)?;
        let sid: Uuid = opt_str(params, "session_id")?
            .ok_or_else(|| RpcError::params("« session_id » manquant"))?
            .parse()
            .map_err(|_| RpcError::params("« session_id » : UUID invalide"))?;
        let expected = fingerprint_param(params)?;
        let locale = locale_param(params)?;
        self.refuse_if_shutting_down()?;

        let slot = self.plugin_slot(&name);
        let _queue = slot.queue.lock().unwrap_or_else(|e| e.into_inner());
        // Relevé avant l'accord : une révocation postérieure se verra.
        let epoch = slot.inner().epoch;

        // Relu à chaque appel : ce qui tourne est ce qui a été accepté.
        let l = self.load_plugin(&name);
        let accepted = self.acceptance_of(&name);
        self.stop_if_stale(&l, accepted.as_ref());
        if l.dir.is_none() {
            return Err(unknown_plugin(&name, None));
        }
        let m = match &l.manifest {
            Ok(m) => m,
            Err(errs) => return Err(unknown_plugin(&name, Some(errs))),
        };
        let state =
            AcceptanceState::of(accepted.as_ref(), l.fingerprint.as_deref(), &m.permissions);
        let Some(accepted) = accepted.filter(|_| state == AcceptanceState::Accepted) else {
            return Err(not_accepted(&name, state, l.fingerprint.as_deref()));
        };
        let fp = l.fingerprint.clone().expect("manifeste valide");
        if fp != expected {
            return Err(RpcError::new(
                error_code::PLUGIN_FINGERPRINT_MISMATCH,
                "le plugin a changé depuis qu'il a été montré",
            )
            .with_data(json!({"fingerprint": fp})));
        }
        let (method, propose_allowed) = match &call {
            Call::Panel => {
                if m.session_tab.is_none() {
                    return Err(RpcError::params(format!(
                        "le plugin « {name} » n'a pas d'onglet de session"
                    )));
                }
                ("panel.render", false)
            }
            Call::Action { id, .. } => {
                let Some(decl) = m.action(id) else {
                    return Err(RpcError::params(format!(
                        "action « {id} » non déclarée par le plugin « {name} »"
                    )));
                };
                (
                    "action.run",
                    decl.propose && m.has(Permission::ClaudePropose),
                )
            }
        };

        // Contexte de session, selon les permissions acceptées seulement.
        let (cwd, _) = self.session_cwd(&sid)?;
        let mut session = json!({"id": sid});
        let mut req = json!({"locale": locale});
        if (m.has(Permission::WorktreeRead) || m.has(Permission::DiffRead)) && !cwd.is_dir() {
            return Err(super::RpcError::cwd_missing(&cwd));
        }
        if m.has(Permission::WorktreeRead) {
            let repo = self.deps.vcs.resolve(&cwd);
            session["cwd"] = json!(cwd);
            session["worktree_root"] = json!(repo.as_ref().map(|r| r.worktree_root.clone()));
            session["branch"] = json!(repo.and_then(|r| r.branch));
        }
        if m.has(Permission::DiffRead) {
            match self.compute_changes(sid, &cwd) {
                Ok(c) => req["diff"] = plugin_diff_json(&c),
                Err(e) if e.code == error_code::NOT_A_REPO => {}
                Err(e) => return Err(e),
            }
        }
        req["session"] = session;
        let timeout = self.config.plugin_request_timeout;
        if let Call::Action { id, args } = &call {
            req["action"] = json!(id);
            req["args"] = args.clone();
        }

        let proc = self.ensure_plugin_process(&slot, &l, m, &accepted, &locale, epoch)?;
        let result = proc.request(method, Some(req), timeout);
        slot.inner().last_used = Some(Instant::now());
        self.schedule_plugin_idle_stop(&slot, &name);
        let value = match result {
            Ok(v) => v,
            Err(e) if !e.is_fatal() => return Err(failed(&e, &proc.stderr_tail())),
            Err(e) => return Err(self.fail_plugin(&slot, &name, &e, &proc)),
        };
        let actions: Vec<String> = m.actions.iter().map(|a| a.id.clone()).collect();
        match call {
            Call::Panel => validate_document(&value, &actions)
                .map(|d| json!({"document": d}))
                .map_err(|p| invalid_result(&format!("document : {p}"))),
            Call::Action { .. } => validate_action_result(&value, &actions, propose_allowed)
                .map_err(|e| match e {
                    ResultError::Invalid(p) | ResultError::Denied(p) => invalid_result(&p),
                }),
        }
    }

    /// Plugins en cours (arrêt du démon).
    fn running_plugins(&self) -> Vec<(String, Arc<dyn PluginProcess>)> {
        let slots: Vec<(String, Arc<PluginSlot>)> = self
            .plugin_table()
            .iter()
            .map(|(n, s)| (n.clone(), s.clone()))
            .collect();
        slots
            .into_iter()
            .filter_map(|(n, s)| {
                let mut i = s.inner();
                i.fingerprint = None;
                i.proc.take().map(|p| (n, p))
            })
            .collect()
    }

    /// Arrête tous les plugins, en parallèle (arrêt du démon). Bloquant.
    pub fn stop_all_plugins(&self) {
        let procs = self.running_plugins();
        if procs.is_empty() {
            return;
        }
        info!("arrêt de {} plugin(s)", procs.len());
        // Gardés pour un second signal pendant l'arrêt (`kill_all_plugins`).
        self.plugins_stopping
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .extend(procs.iter().map(|(_, p)| p.clone()));
        std::thread::scope(|s| {
            for (_, p) in &procs {
                s.spawn(move || p.stop());
            }
        });
        self.plugins_stopping
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
    }

    /// `SIGKILL` immédiat à tous les plugins (second signal d'arrêt), y
    /// compris ceux dont l'arrêt poli est en cours.
    pub fn kill_all_plugins(&self) {
        let stopping: Vec<Arc<dyn PluginProcess>> = self
            .plugins_stopping
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        for p in stopping {
            p.kill();
        }
        for (_, p) in self.running_plugins() {
            p.kill();
        }
    }
}
