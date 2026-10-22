//! Appels bornés à `systemctl --user` et lecture de l'état d'un scope.
//!
//! Partagé par l'hôte des plugins (`systemctl --user kill` d'un scope de
//! plugin) et par le démon (libération du scope d'une session ou d'un runner
//! après la récolte de son processus, voir `daemon::scope`). Tout appel est
//! borné à [`SYSTEMCTL_TIMEOUT`] : un gestionnaire systemd qui ne répond pas
//! ne bloque jamais l'appelant au-delà.

use std::ffi::OsStr;
use std::io::{ErrorKind, Read};
use std::os::fd::AsFd;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Délai d'un appel à `systemctl`.
pub const SYSTEMCTL_TIMEOUT: Duration = Duration::from_secs(3);
/// Racine de la hiérarchie unifiée des cgroups (v2).
pub const CGROUP_ROOT: &str = "/sys/fs/cgroup";

/// `systemctl --user <args>`, borné à [`SYSTEMCTL_TIMEOUT`] (tué au-delà) :
/// sa sortie standard, ou `None` si le lancement échoue, si le délai est
/// dépassé ou si `systemctl` sort en erreur.
/// `XDG_RUNTIME_DIR` vaut `runtime_dir` s'il est donné (gestionnaire
/// utilisateur à joindre, tests seulement).
///
/// Lecture de la sortie sans blocage possible : la sortie est un tube lu
/// **après** la fin du processus. Les sorties attendues ici font quelques
/// dizaines d'octets, bien moins que la capacité d'un tube (64 Kio au
/// moins sous Linux) ; si une sortie le remplissait quand même, `systemctl`
/// resterait bloqué en écriture et le délai l'interromprait (`None`), sans
/// jamais bloquer l'appelant : la taille lue est donc bornée par la
/// capacité du tube, sans autre limite. Le tube est ensuite lu en mode non
/// bloquant : un descendant qui aurait gardé son extrémité d'écriture
/// ouverte ne peut pas faire attendre la lecture. Ni dépendance (fichier
/// temporaire), ni fil de lecture.
pub fn systemctl_bounded(
    systemctl: &Path,
    runtime_dir: Option<&OsStr>,
    args: &[&str],
) -> Option<String> {
    let mut cmd = Command::new(systemctl);
    cmd.arg("--user")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(dir) = runtime_dir {
        cmd.env("XDG_RUNTIME_DIR", dir);
    }
    let mut child = cmd.spawn().ok()?;
    let mut out = child.stdout.take()?;
    let deadline = Instant::now() + SYSTEMCTL_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    nix::fcntl::fcntl(
        out.as_fd(),
        nix::fcntl::FcntlArg::F_SETFL(nix::fcntl::OFlag::O_NONBLOCK),
    )
    .ok()?;
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match out.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            // `WouldBlock` : tout ce que `systemctl` a écrit est lu.
            Err(_) => break,
        }
    }
    if !status.success() {
        return None;
    }
    String::from_utf8(buf).ok()
}

/// État d'une unité, d'après `systemctl show -p LoadState -p ActiveState
/// -p ControlGroup`.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct UnitState {
    /// `loaded`, `not-found`…
    pub load_state: String,
    /// `active`, `inactive`, `failed`…
    pub active_state: String,
    /// Chemin du cgroup sous la racine (`/user.slice/…`), vide s'il n'y en
    /// a pas.
    pub control_group: String,
}

/// Lit les lignes `Clé=Valeur` de `systemctl show` (pas `--value` : avec
/// plusieurs `-p`, `systemctl` écrit les propriétés dans son propre ordre,
/// pas dans celui des options).
pub fn parse_show(text: &str) -> UnitState {
    let mut s = UnitState::default();
    for line in text.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        match key {
            "LoadState" => s.load_state = value.to_owned(),
            "ActiveState" => s.active_state = value.to_owned(),
            "ControlGroup" => s.control_group = value.to_owned(),
            _ => {}
        }
    }
    s
}

/// État de l'unité `unit` ; `None` si `systemctl` ne répond pas. Une unité
/// inconnue n'est pas une erreur : `systemctl show` sort sans erreur avec
/// `LoadState=not-found`.
pub fn show_unit(systemctl: &Path, runtime_dir: Option<&OsStr>, unit: &str) -> Option<UnitState> {
    let text = systemctl_bounded(
        systemctl,
        runtime_dir,
        &[
            "show",
            "-p",
            "LoadState",
            "-p",
            "ActiveState",
            "-p",
            "ControlGroup",
            unit,
        ],
    )?;
    Some(parse_show(&text))
}

/// Ligne `populated` d'un fichier `cgroup.events` : `Some(true)` si le
/// cgroup (ou l'un de ses descendants) contient un processus, `None` si la
/// ligne manque ou est illisible.
pub fn parse_populated(events: &str) -> Option<bool> {
    events
        .lines()
        .find_map(|l| match l.trim().strip_prefix("populated ")? {
            "1" => Some(true),
            "0" => Some(false),
            _ => None,
        })
}

/// Le cgroup `control_group` (chemin sous `root`, en pratique
/// [`CGROUP_ROOT`]) contient-il encore un processus ?
///
/// - chemin vide : pas de cgroup, donc vide ;
/// - chemin suspect (relatif, avec `..`) : tenu pour peuplé (prudence) ;
/// - `cgroup.events` lisible : sa ligne `populated` (illisible : peuplé) ;
/// - `cgroup.events` absent alors que la hiérarchie unifiée est montée
///   (`<root>/cgroup.controllers` existe) : le cgroup a été retiré, donc
///   vide. systemd ≥ 256 n'accepte plus que cette hiérarchie (cgroup v2) ;
///   si elle n'est pas montée à `root` (ancien systemd en cgroup v1),
///   l'absence ne prouve rien et le cgroup est tenu pour peuplé.
pub fn cgroup_populated(root: &Path, control_group: &str) -> bool {
    if control_group.is_empty() {
        return false;
    }
    let rel = Path::new(control_group);
    if !rel.is_absolute()
        || rel
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return true;
    }
    let dir = root.join(control_group.trim_start_matches('/'));
    match std::fs::read_to_string(dir.join("cgroup.events")) {
        Ok(text) => parse_populated(&text).unwrap_or(true),
        Err(e) if e.kind() == ErrorKind::NotFound => !root.join("cgroup.controllers").exists(),
        Err(_) => true,
    }
}

/// Faut-il arrêter (`systemctl stop`) cette unité pour la retirer ?
/// Seulement si elle est chargée, ni inactive ni en échec, et que son
/// cgroup est vide (`populated` dit si un cgroup contient un processus ;
/// appelé seulement pour une unité chargée et active). Un scope peuplé
/// n'est jamais arrêté : `stop` tuerait des processus détachés (serveur
/// lancé avec `nohup` ou `setsid` depuis une session), qui doivent vivre.
pub fn should_stop_empty_scope(state: &UnitState, populated: impl FnOnce(&str) -> bool) -> bool {
    state.load_state == "loaded"
        && !matches!(state.active_state.as_str(), "inactive" | "failed" | "")
        && !populated(&state.control_group)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHOW_STUCK: &str = "LoadState=loaded\nActiveState=active\n\
        ControlGroup=/user.slice/user-1000.slice/user@1000.service/app.slice/devmaestro-session-ab-cd.scope\n";

    #[test]
    fn show_is_parsed_in_any_order() {
        let s = parse_show("ControlGroup=/a/b.scope\nActiveState=active\nLoadState=loaded\n");
        assert_eq!(
            s,
            UnitState {
                load_state: "loaded".into(),
                active_state: "active".into(),
                control_group: "/a/b.scope".into(),
            }
        );
        let gone = parse_show("LoadState=not-found\nActiveState=inactive\nControlGroup=\n");
        assert_eq!(gone.load_state, "not-found");
        assert_eq!(gone.control_group, "");
        assert_eq!(parse_show(""), UnitState::default());
    }

    #[test]
    fn populated_line_of_cgroup_events() {
        assert_eq!(parse_populated("populated 1\nfrozen 0\n"), Some(true));
        assert_eq!(parse_populated("frozen 0\npopulated 0\n"), Some(false));
        assert_eq!(parse_populated("frozen 0\n"), None);
        assert_eq!(parse_populated("populated x\n"), None);
    }

    #[test]
    fn stop_only_a_loaded_active_and_empty_scope() {
        let stuck = parse_show(SHOW_STUCK);
        assert!(should_stop_empty_scope(&stuck, |_| false));
        // Processus détachés encore vivants : jamais arrêté.
        assert!(!should_stop_empty_scope(&stuck, |_| true));
        // Unité déjà retirée (`--collect`) ou jamais créée.
        let gone = parse_show("LoadState=not-found\nActiveState=inactive\nControlGroup=\n");
        assert!(!should_stop_empty_scope(&gone, |_| false));
        let failed = UnitState {
            active_state: "failed".into(),
            ..stuck.clone()
        };
        assert!(!should_stop_empty_scope(&failed, |_| false));
        let inactive = UnitState {
            active_state: "inactive".into(),
            ..stuck.clone()
        };
        assert!(!should_stop_empty_scope(&inactive, |_| false));
        // `show` sans réponse exploitable.
        assert!(!should_stop_empty_scope(&UnitState::default(), |_| false));
        // Le cgroup consulté est bien celui de l'unité.
        let mut seen = String::new();
        should_stop_empty_scope(&stuck, |cg| {
            seen = cg.to_owned();
            false
        });
        assert!(seen.ends_with("/devmaestro-session-ab-cd.scope"), "{seen}");
    }

    #[test]
    fn cgroup_emptiness_from_cgroup_events() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path();
        std::fs::write(root.join("cgroup.controllers"), "cpu memory pids\n").unwrap();
        std::fs::create_dir_all(root.join("a/peuple.scope")).unwrap();
        std::fs::write(
            root.join("a/peuple.scope/cgroup.events"),
            "populated 1\nfrozen 0\n",
        )
        .unwrap();
        std::fs::create_dir_all(root.join("a/vide.scope")).unwrap();
        std::fs::write(
            root.join("a/vide.scope/cgroup.events"),
            "populated 0\nfrozen 0\n",
        )
        .unwrap();
        std::fs::create_dir_all(root.join("a/illisible.scope")).unwrap();
        std::fs::write(root.join("a/illisible.scope/cgroup.events"), "frozen 0\n").unwrap();

        assert!(cgroup_populated(root, "/a/peuple.scope"));
        assert!(!cgroup_populated(root, "/a/vide.scope"));
        assert!(cgroup_populated(root, "/a/illisible.scope"));
        // Cgroup retiré, hiérarchie unifiée montée : vide.
        assert!(!cgroup_populated(root, "/a/retire.scope"));
        // Pas de cgroup du tout : vide.
        assert!(!cgroup_populated(root, ""));
        // Chemins suspects : peuplés par prudence.
        assert!(cgroup_populated(root, "a/vide.scope"));
        assert!(cgroup_populated(root, "/a/../a/vide.scope"));

        // Hiérarchie unifiée absente (cgroup v1) : l'absence ne prouve rien.
        let v1 = tempfile::tempdir().unwrap();
        assert!(cgroup_populated(v1.path(), "/a/retire.scope"));
    }

    #[test]
    fn bounded_call_captures_stdout_and_reports_failures() {
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join("systemctl");
        let script = "#!/bin/sh\n\
            case \"$2\" in\n\
              ok) echo \"argv: $*\"; echo \"rt: $XDG_RUNTIME_DIR\" ;;\n\
              fail) echo partiel; exit 1 ;;\n\
            esac\n";
        std::fs::write(&fake, script).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        // Le fichier vient d'être écrit : un `ETXTBSY` passager est possible
        // si un autre fil du test a hérité du descripteur d'écriture entre
        // son `fork` et son `exec`. Seul le premier appel (`ok`) est répété :
        // une fois qu'il a réussi, plus aucun processus ne tient le fichier
        // ouvert en écriture (un descripteur fermé ne s'hérite plus), donc
        // le `None` du cas `fail` vient bien de l'échec de `systemctl`.
        let call = |args: &[&str]| {
            for _ in 0..50 {
                let r = systemctl_bounded(&fake, Some(OsStr::new("/run/test")), args);
                if r.is_some() || args[0] != "ok" {
                    return r;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            None
        };
        assert_eq!(
            call(&["ok", "unité"]).as_deref(),
            Some("argv: --user ok unité\nrt: /run/test\n")
        );
        assert_eq!(call(&["fail"]), None);
        assert_eq!(
            systemctl_bounded(Path::new("/nonexistent/systemctl"), None, &["ok"]),
            None
        );
    }
}
