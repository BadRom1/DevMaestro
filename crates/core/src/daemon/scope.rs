//! Libération du scope systemd d'une session ou d'un runner après la
//! récolte de son processus.
//!
//! Défaut de systemd (relevé avec systemd 259) : si `systemd-run --scope`
//! est tué dans les quelques millisecondes qui suivent son lancement,
//! pendant qu'il enregistre le scope auprès du gestionnaire, systemd garde
//! une unité **vide** « active (running) » que `--collect` ne ramasse
//! jamais ; seul `systemctl --user stop` la retire. systemd peut aussi
//! créer l'unité quelques millisecondes **après** que le démon a récolté le
//! pid de `systemd-run`.
//!
//! Après la récolte, le fil d'attente (jamais le runtime tokio, et après
//! avoir transmis la sortie : le statut n'attend pas) appelle
//! [`ScopeRelease::run`] :
//!
//! - **seulement si le scope est vide** : `systemctl --user show` (état et
//!   cgroup), puis `cgroup.events` du cgroup. Un scope encore peuplé
//!   (serveur lancé avec `nohup` ou `setsid` par la session) n'est jamais
//!   touché : ces processus doivent continuer de vivre, et le scope se
//!   retire seul quand ils sortent. Un cgroup vide ne peut plus gagner de
//!   membre (systemd n'y range que le pid donné par `systemd-run`, déjà
//!   mort) : pas de course entre la vérification et l'arrêt ;
//! - puis `systemctl --user stop <unité>`, sur l'unité exacte de cette
//!   exécution, jamais un motif. Sur un scope vide, l'arrêt est immédiat
//!   (rien à signaler ni à attendre, contrairement à un scope peuplé) ;
//! - **deux essais** : un aussitôt, un second après [`RELEASE_RETRY`],
//!   parce que systemd peut créer l'unité après la récolte. Le nom d'unité
//!   est unique par exécution (jeton de lancement, identifiant du processus
//!   de runner) : le second essai ne peut pas viser l'exécution suivante de
//!   la même session ;
//! - au mieux : toute erreur est ignorée.
//!
//! Limite : les fils d'attente ne sont pas attendus à l'arrêt du démon. Si
//! le démon s'arrête (tué, ou arrêt normal avant la fin des deux essais),
//! rien n'est libéré pour les exécutions en cours. Suivi possible, non
//! fait : un balayage au démarrage à partir des unités (`scope_unit`)
//! gardées en base.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::log::info;
use super::supervisor::Config;
use crate::adapters::systemctl::{
    CGROUP_ROOT, cgroup_populated, should_stop_empty_scope, show_unit, systemctl_bounded,
};

/// Délai avant le second essai de libération.
pub const RELEASE_RETRY: Duration = Duration::from_millis(1500);

/// Libération du scope d'une exécution, préparée avant le fil d'attente
/// (sans garder le démon en vie pendant [`RELEASE_RETRY`]).
#[derive(Debug, Clone)]
pub struct ScopeRelease {
    systemctl: PathBuf,
    runtime_dir: Option<OsString>,
    unit: String,
}

impl ScopeRelease {
    /// `None` sans scope ou sans `systemctl` : rien à libérer.
    pub fn new(config: &Config, unit: Option<&str>) -> Option<Self> {
        Some(Self {
            systemctl: config.systemctl.clone()?,
            runtime_dir: config.systemd_runtime_dir.clone(),
            unit: unit?.to_owned(),
        })
    }

    /// Deux essais, séparés de [`RELEASE_RETRY`] (bloquant : fil d'attente
    /// seulement).
    ///
    /// Seul un arrêt au second essai est journalisé : juste après une sortie
    /// normale, systemd peut encore montrer l'unité active et vide le temps
    /// de la retirer lui-même, et l'arrêt du premier essai n'indique donc
    /// pas un scope resté actif.
    pub fn run(self) {
        self.attempt();
        std::thread::sleep(RELEASE_RETRY);
        if self.attempt() {
            info!("scope systemd vide resté actif, arrêté : {}", self.unit);
        }
    }

    /// Un essai : arrête l'unité si elle est chargée, active et vide ;
    /// `true` si elle a été arrêtée.
    fn attempt(&self) -> bool {
        release_if_empty(
            &self.systemctl,
            self.runtime_dir.as_deref(),
            &self.unit,
            Path::new(CGROUP_ROOT),
        )
    }
}

/// Arrête `unit` si elle est chargée, active et que son cgroup (sous
/// `cgroup_root`) est vide ; `true` si l'arrêt a réussi.
fn release_if_empty(
    systemctl: &Path,
    runtime_dir: Option<&std::ffi::OsStr>,
    unit: &str,
    cgroup_root: &Path,
) -> bool {
    let Some(state) = show_unit(systemctl, runtime_dir, unit) else {
        return false;
    };
    if !should_stop_empty_scope(&state, |cg| cgroup_populated(cgroup_root, cg)) {
        return false;
    }
    systemctl_bounded(systemctl, runtime_dir, &["stop", unit]).is_some()
}
