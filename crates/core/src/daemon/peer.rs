//! Contrôle des pairs des deux sockets du démon.
//!
//! # Socket de contrôle (`orchd.sock`)
//!
//! Le socket de contrôle permet tout (lancer une session, taper dans un
//! terminal, répondre à une permission). Un processus `claude` supervisé, et
//! tout ce qu'il lance (une commande Bash détournée par une injection de
//! prompt, par exemple), tourne sous le même utilisateur que le démon : les
//! droits du socket (0600) ne l'arrêtent pas. Le démon refuse donc une
//! connexion (voir [`check_control`]) dont le pair, par couches :
//!
//! 1. n'a pas le même uid, ou ne peut pas être identifié ;
//! 2. appartient à un *scope* systemd `devmaestro-session-…` (sessions
//!    lancées par `systemd-run --user --scope`, voir
//!    [`crate::daemon::launch`]), `devmaestro-runner-…` (runners, lot 14a)
//!    ou `devmaestro-plugin-…` (plugins, lot 22a, ADR 0007 : un plugin n'a
//!    que son stdio). L'appartenance à un cgroup survit à
//!    `setsid`, aux doubles forks et au rattachement à `init` : en sortir
//!    demande un appel délibéré à `systemd-run` (ou l'écriture dans un autre
//!    cgroup de l'utilisateur) ;
//! 3. porte `ORCH_TOKEN=` ou `ORCH_SESSION=` dans son environnement
//!    (`/proc/<pid>/environ`) : un descendant qui n'a pas nettoyé son
//!    environnement. Un environnement illisible ne fait pas refuser ;
//! 4. est un processus `claude` supervisé (actuel, passé, ou relu en base
//!    après un plantage du démon) ou l'un de ses descendants : la chaîne des
//!    parents est remontée, et à chaque étape le groupe et la session sont
//!    comparés aux processus supervisés (lancés par `setsid` : pid = groupe
//!    = session).
//!
//! Le pair est épinglé par `SO_PEERPIDFD` (noyau 6.5 et plus) : après les
//! lectures de `/proc`, le démon vérifie que ce processus vit toujours, donc
//! que son pid n'a pas été réattribué entre-temps. À défaut, la date de
//! démarrage du pid est relue et comparée.
//!
//! **C'est une atténuation, pas un bac à sable** : sans scope systemd, un
//! processus qui se détache avec `setsid` et nettoie son environnement n'est
//! plus reconnu ; même avec un scope, un processus de l'utilisateur peut en
//! sortir délibérément, lire ses fichiers et, selon `ptrace_scope`, la
//! mémoire de ses autres processus. Voir « Modèle de menace » dans
//! `docs/protocole.md`.
//!
//! # Socket des relais (`relay.sock`)
//!
//! Une trame de hook ou de statusline n'est acceptée que si le pair descend
//! du processus `claude` de la session désignée par le jeton, ou partage son
//! scope systemd ([`check_relay`]). Un processus de la session peut donc
//! toujours forger des événements pour **sa propre** session (il connaît le
//! jeton), jamais pour une autre.

use std::collections::HashMap;
use std::os::fd::{AsFd, OwnedFd};

/// Préfixe des scopes systemd des sessions (`devmaestro-session-<id>.scope`).
pub const SCOPE_PREFIX: &str = "devmaestro-session-";

/// Préfixe des scopes systemd des runners (`devmaestro-runner-<…>.scope`,
/// v0.3, lot 14a) : du code du dépôt, aussi peu sûr qu'une commande Bash
/// d'une session ; refusé au socket de contrôle de la même façon.
pub const RUNNER_SCOPE_PREFIX: &str = "devmaestro-runner-";

/// Préfixe des scopes systemd des plugins (`devmaestro-plugin-<nom>-<n>.scope`,
/// v0.3, lot 22a, ADR 0007) : du code tiers, qui n'a que son stdio ; refusé
/// au socket de contrôle de la même façon.
pub const PLUGIN_SCOPE_PREFIX: &str = "devmaestro-plugin-";

/// Profondeur maximale de la chaîne des parents remontée.
const MAX_DEPTH: usize = 4096;

/// Champs utiles de `/proc/<pid>/stat`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcStat {
    pub ppid: u32,
    pub pgrp: u32,
    pub session: u32,
    /// Date de démarrage (`starttime`, en tops d'horloge depuis le boot).
    pub start: u64,
}

/// Un processus `claude` supervisé.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SupervisedProc {
    /// Date de démarrage relevée au lancement. Inconnue : le pid ne
    /// correspond à rien (il pourrait désigner n'importe quel processus).
    pub start: Option<u64>,
    /// Unité du scope systemd (`devmaestro-session-….scope`), si la session
    /// a été lancée dans un scope.
    pub scope: Option<String>,
}

/// Processus supervisés, par pid.
pub type Supervised = HashMap<u32, SupervisedProc>;

/// Lit `ppid`, `pgrp`, `session` et `starttime` dans le contenu de
/// `/proc/<pid>/stat`. Le nom du programme (2ᵉ champ, entre parenthèses)
/// peut contenir des espaces et des parenthèses : on lit après la
/// **dernière** `)`.
pub fn parse_stat(text: &str) -> Option<ProcStat> {
    let rest = &text[text.rfind(')')? + 1..];
    let mut fields = rest.split_whitespace();
    let _state = fields.next()?;
    let ppid = fields.next()?.parse().ok()?;
    let pgrp = fields.next()?.parse().ok()?;
    let session = fields.next()?.parse().ok()?;
    // starttime : 22ᵉ champ, soit le 16ᵉ après `session` (6ᵉ).
    let start = fields.nth(15)?.parse().ok()?;
    Some(ProcStat {
        ppid,
        pgrp,
        session,
        start,
    })
}

/// Champs de `/proc/<pid>/stat`, si le processus existe.
pub fn read_stat(pid: u32) -> Option<ProcStat> {
    parse_stat(&std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?)
}

/// Date de démarrage d'un processus, s'il existe.
pub fn start_time(pid: u32) -> Option<u64> {
    read_stat(pid).map(|s| s.start)
}

/// Contenu de `/proc/<pid>/cgroup`.
pub fn cgroup(pid: u32) -> Option<String> {
    std::fs::read_to_string(format!("/proc/{pid}/cgroup")).ok()
}

/// Ce cgroup est-il celui d'un scope de session, de runner ou de plugin ?
pub fn in_session_scope(cgroup: &str) -> bool {
    cgroup.lines().any(|l| {
        [SCOPE_PREFIX, RUNNER_SCOPE_PREFIX, PLUGIN_SCOPE_PREFIX]
            .iter()
            .any(|p| l.contains(&format!("/{p}")))
            && l.trim_end().ends_with(".scope")
    })
}

/// Ce cgroup est-il exactement le scope `unit` ?
pub fn in_scope(cgroup: &str, unit: &str) -> bool {
    cgroup
        .lines()
        .any(|l| l.trim_end().ends_with(&format!("/{unit}")))
}

/// L'environnement contient-il une variable de session (`ORCH_TOKEN`,
/// `ORCH_SESSION`) ?
pub fn environ_has_session_vars(environ: &[u8]) -> bool {
    environ
        .split(|b| *b == 0)
        .any(|v| v.starts_with(b"ORCH_TOKEN=") || v.starts_with(b"ORCH_SESSION="))
}

/// Tous les processus visibles, avec leurs champs.
pub fn scan() -> Vec<(u32, ProcStat)> {
    let Ok(dir) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    dir.filter_map(|e| e.ok()?.file_name().to_str()?.parse::<u32>().ok())
        .filter_map(|pid| Some((pid, read_stat(pid)?)))
        .collect()
}

/// Retire les processus supervisés disparus : le processus n'existe plus
/// (ou son pid porte un autre processus) **et** plus aucun processus ne vit
/// dans son groupe ou sa session. Le noyau ne réattribue pas un pid encore
/// utilisé comme identifiant de groupe ou de session : tant que des
/// descendants y vivent, l'entrée reste.
pub fn prune(supervised: &mut Supervised, live: &[(u32, ProcStat)]) {
    supervised.retain(|pid, proc| {
        let Some(start) = proc.start else {
            return false;
        };
        match live.iter().find(|(p, _)| p == pid) {
            Some((_, st)) => st.start == start,
            None => live
                .iter()
                .any(|(_, st)| st.pgrp == *pid || st.session == *pid),
        }
    });
}

/// Le processus `pid` est-il un processus supervisé ou l'un de ses
/// descendants ? `stat` lit les champs d'un processus (injecté pour les
/// tests). Un pair illisible est traité comme supervisé (refus).
///
/// Un identifiant (pid, groupe, session) correspond à un processus
/// supervisé s'il est dans `supervised` avec une date de démarrage connue,
/// et que le processus qui le porte aujourd'hui, s'il existe encore, a la
/// même date : un pid réattribué depuis ne fait pas refuser un client
/// légitime.
pub fn is_supervised(
    pid: u32,
    supervised: &Supervised,
    stat: impl Fn(u32) -> Option<ProcStat>,
) -> bool {
    let Some(first) = stat(pid) else {
        return true;
    };
    let matches = |id: u32| match supervised.get(&id).and_then(|p| p.start) {
        None => false,
        Some(start) => match stat(id) {
            Some(now) => now.start == start,
            // Le processus d'origine est mort : l'identifiant ne vit plus que
            // par ses descendants (groupe, session).
            None => true,
        },
    };
    let mut current = pid;
    let mut st = first;
    for _ in 0..MAX_DEPTH {
        if matches(current) || matches(st.pgrp) || matches(st.session) {
            return true;
        }
        if st.ppid <= 1 {
            return false;
        }
        current = st.ppid;
        // Parent disparu entre-temps : la chaîne s'arrête là.
        let Some(next) = stat(current) else {
            return false;
        };
        st = next;
    }
    true
}

/// Pair d'une connexion, épinglé.
#[derive(Debug)]
pub struct Peer {
    pub uid: u32,
    pub pid: u32,
    /// Date de démarrage lue à l'acceptation (repli sans pidfd).
    start: Option<u64>,
    /// `SO_PEERPIDFD`, si le noyau le fournit.
    pidfd: Option<OwnedFd>,
}

impl Peer {
    /// Identité du pair d'un socket Unix : `SO_PEERCRED`, plus
    /// `SO_PEERPIDFD` quand il est disponible.
    pub fn of(socket: &impl AsFd) -> Result<Self, String> {
        use nix::sys::socket::{getsockopt, sockopt};
        let cred = getsockopt(socket, sockopt::PeerCredentials)
            .map_err(|e| format!("SO_PEERCRED : {e}"))?;
        let pid = u32::try_from(cred.pid())
            .ok()
            .filter(|p| *p > 0)
            .ok_or("pid du pair inconnu")?;
        let pidfd = getsockopt(socket, sockopt::PeerPidfd).ok();
        Ok(Self {
            uid: cred.uid(),
            pid,
            start: start_time(pid),
            pidfd,
        })
    }

    /// Le processus identifié à l'acceptation est-il toujours là, sous le
    /// même pid ? (pidfd : il ne s'est pas terminé ; sinon : même date de
    /// démarrage.)
    pub fn still_same(&self) -> bool {
        match &self.pidfd {
            Some(fd) => {
                use nix::poll::{PollFd, PollFlags, PollTimeout, poll};
                // Un pidfd devient lisible quand le processus se termine.
                let mut fds = [PollFd::new(fd.as_fd(), PollFlags::POLLIN)];
                matches!(poll(&mut fds, PollTimeout::ZERO), Ok(0))
            }
            None => self.start.is_some() && start_time(self.pid) == self.start,
        }
    }

    /// `SO_PEERPIDFD` était-il disponible ?
    pub fn pinned(&self) -> bool {
        self.pidfd.is_some()
    }
}

/// Vérifie le pair d'une connexion au socket de contrôle (voir le module).
/// `Err` : la raison du refus, pour le journal.
pub fn check_control(peer: &Peer, own_uid: u32, supervised: &Supervised) -> Result<(), String> {
    if peer.uid != own_uid {
        return Err(format!("uid {} différent de celui du démon", peer.uid));
    }
    let pid = peer.pid;
    if cgroup(pid).is_some_and(|c| in_session_scope(&c)) {
        return Err(format!(
            "le processus {pid} appartient au scope systemd d'une session, d'un runner ou d'un plugin"
        ));
    }
    if std::fs::read(format!("/proc/{pid}/environ")).is_ok_and(|e| environ_has_session_vars(&e)) {
        return Err(format!(
            "le processus {pid} porte les variables d'une session (ORCH_TOKEN, ORCH_SESSION)"
        ));
    }
    if is_supervised(pid, supervised, read_stat) {
        return Err(format!(
            "le processus {pid} est une session supervisée ou l'un de ses descendants"
        ));
    }
    if !peer.still_same() {
        return Err(format!(
            "le processus {pid} a disparu pendant la vérification"
        ));
    }
    Ok(())
}

/// Vérifie le pair d'une trame du socket des relais : il doit descendre du
/// processus `claude` (`claude_pid`) de la session du jeton, ou partager
/// son scope systemd.
pub fn check_relay(
    peer: &Peer,
    own_uid: u32,
    claude_pid: u32,
    claude: &SupervisedProc,
) -> Result<(), String> {
    if peer.uid != own_uid {
        return Err(format!("uid {} différent de celui du démon", peer.uid));
    }
    let in_claude_scope = claude
        .scope
        .as_deref()
        .is_some_and(|unit| cgroup(peer.pid).is_some_and(|c| in_scope(&c, unit)));
    let one: Supervised = [(claude_pid, claude.clone())].into();
    // Le processus claude doit vivre (une session terminée n'a plus de relais).
    let claude_alive = claude.start.is_some() && start_time(claude_pid) == claude.start;
    if !in_claude_scope && !(claude_alive && is_supervised(peer.pid, &one, read_stat)) {
        return Err(format!(
            "le processus {} ne descend pas du processus claude {claude_pid} de la session",
            peer.pid
        ));
    }
    if !peer.still_same() {
        return Err(format!(
            "le processus {} a disparu pendant la vérification",
            peer.pid
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn st(ppid: u32, pgrp: u32, session: u32) -> ProcStat {
        ProcStat {
            ppid,
            pgrp,
            session,
            start: 7,
        }
    }

    fn sup(start: Option<u64>) -> SupervisedProc {
        SupervisedProc { start, scope: None }
    }

    #[test]
    fn parses_stat_with_odd_names() {
        let s = parse_stat(
            "1234 (a b) c)) S 1200 1234 1100 34817 1234 4194560 1 0 0 0 5 6 0 0 20 0 1 0 98765 0 0",
        )
        .unwrap();
        assert_eq!(
            s,
            ProcStat {
                ppid: 1200,
                pgrp: 1234,
                session: 1100,
                start: 98765,
            }
        );
        assert!(parse_stat("1234 sans parenthèse").is_none());
        assert!(parse_stat("1 (x) S").is_none());
        // Le processus courant se lit.
        assert!(read_stat(std::process::id()).is_some());
    }

    #[test]
    fn cgroup_and_environ_markers() {
        let c = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/devmaestro-session-1a2b3c4d-5e6f7a8b.scope\n";
        assert!(in_session_scope(c));
        assert!(in_scope(c, "devmaestro-session-1a2b3c4d-5e6f7a8b.scope"));
        assert!(!in_scope(c, "devmaestro-session-autre.scope"));
        assert!(in_session_scope(
            "0::/user.slice/user-1000.slice/user@1000.service/app.slice/devmaestro-runner-1a2b3c4d-5e6f7a8b.scope\n"
        ));
        assert!(in_session_scope(
            "0::/user.slice/user-1000.slice/user@1000.service/app.slice/devmaestro-plugin-codegraph-impact-3.scope\n"
        ));
        assert!(!in_session_scope(
            "0::/user.slice/user-1000.slice/user@1000.service/app.slice/devmaestro-plugin-x.service\n"
        ));
        assert!(!in_session_scope(
            "0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-gnome-x.scope\n"
        ));
        assert!(environ_has_session_vars(b"PATH=/bin\0ORCH_TOKEN=abc\0"));
        assert!(environ_has_session_vars(b"ORCH_SESSION=x"));
        assert!(!environ_has_session_vars(b"PATH=/bin\0XORCH_TOKEN=abc\0"));
    }

    #[test]
    fn descendants_and_detached_children_are_supervised() {
        // 100 : claude supervisé (setsid : pgrp = session = 100).
        // 101 → 100 ; 102 → 101 ; 200 : rattaché à init, mais session 100.
        // 300 → 1, session 300 : sans lien.
        let table: HashMap<u32, ProcStat> = [
            (100, st(50, 100, 100)),
            (101, st(100, 100, 100)),
            (102, st(101, 102, 100)),
            (200, st(1, 200, 100)),
            (300, st(1, 300, 300)),
            (301, st(300, 301, 300)),
            (50, st(1, 50, 50)),
        ]
        .into();
        let stat = |pid: u32| table.get(&pid).copied();
        let supervised: Supervised = [(100, sup(Some(7)))].into();
        for pid in [100, 101, 102, 200] {
            assert!(is_supervised(pid, &supervised, stat), "{pid}");
        }
        for pid in [300, 301, 50] {
            assert!(!is_supervised(pid, &supervised, stat), "{pid}");
        }
        // Pair illisible : refusé.
        assert!(is_supervised(999, &supervised, stat));
        // Pid réattribué (date différente) : pas de refus.
        let recycled: Supervised = [(300, sup(Some(1)))].into();
        assert!(!is_supervised(301, &recycled, stat));
        // Date inconnue : ne correspond à rien.
        let unknown: Supervised = [(300, sup(None))].into();
        assert!(!is_supervised(301, &unknown, stat));
        // Supervisé mort : ses descendants restent refusés.
        let dead: Supervised = [(400, sup(Some(1)))].into();
        let orphan = |pid: u32| (pid == 401).then_some(st(1, 401, 400));
        assert!(is_supervised(401, &dead, orphan));
    }

    #[test]
    fn prune_keeps_live_processes_and_orphan_trees() {
        let mut s: Supervised = [
            (100, sup(Some(7))), // vivant
            (200, sup(Some(7))), // mort, un orphelin dans sa session
            (300, sup(Some(7))), // mort, plus personne
            (400, sup(Some(1))), // pid réattribué
            (500, sup(None)),    // date inconnue
        ]
        .into();
        let live = vec![
            (100, st(1, 100, 100)),
            (201, st(1, 201, 200)),
            (400, st(1, 400, 400)),
            (500, st(1, 500, 500)),
        ];
        prune(&mut s, &live);
        let mut kept: Vec<u32> = s.keys().copied().collect();
        kept.sort_unstable();
        assert_eq!(kept, [100, 200]);
    }

    #[test]
    fn peer_of_a_socket_pair_is_this_process() {
        let (a, _b) = std::os::unix::net::UnixStream::pair().unwrap();
        let peer = Peer::of(&a).unwrap();
        assert_eq!(peer.pid, std::process::id());
        assert_eq!(peer.uid, nix::unistd::getuid().as_raw());
        assert!(peer.still_same());
        let own = peer.uid;
        // Ce processus de test n'est pas supervisé…
        if !std::env::vars().any(|(k, _)| k == "ORCH_TOKEN" || k == "ORCH_SESSION")
            && !cgroup(peer.pid).is_some_and(|c| in_session_scope(&c))
        {
            assert!(check_control(&peer, own, &Supervised::new()).is_ok());
        }
        // … sauf s'il l'est.
        let me: Supervised = [(peer.pid, sup(start_time(peer.pid)))].into();
        assert!(check_control(&peer, own, &me).is_err());
        assert!(check_control(&peer, own + 1, &Supervised::new()).is_err());
        // Relais : descend de lui-même.
        assert!(check_relay(&peer, own, peer.pid, &sup(start_time(peer.pid))).is_ok());
        assert!(check_relay(&peer, own, 1, &sup(start_time(1))).is_err());
    }
}
