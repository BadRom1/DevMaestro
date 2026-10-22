//! Libération du scope systemd d'une session et d'un runner après la
//! récolte de leur processus (`daemon::scope`) : faux `systemd-run` et faux
//! `systemctl` qui journalisent leurs arguments puis passent la main aux
//! vrais binaires. Sautés sans gestionnaire systemd utilisateur.

mod common;

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use common::plugin::{no_systemd, skip};
use common::*;
use serde_json::{Value, json};
use uuid::Uuid;

/// Faux `npm` (voir `runners.rs`) : `npm run <nom>` lance `scripts/<nom>.sh`.
const FAKE_NPM: &str = "#!/bin/sh\n[ -n \"$DEVMAESTRO_PROBE\" ] && exit 0\n[ \"$1\" = run ] || exit 64\nexec sh \"./scripts/$2.sh\"\n";

/// Faux binaires systemd d'un test et leurs journaux.
struct Fakes {
    /// Une ligne par appel de `systemd-run` : ses arguments.
    systemd_run_log: PathBuf,
    /// Une ligne par appel de `systemctl` : ses arguments.
    systemctl_log: PathBuf,
    /// S'il existe, `systemctl … show …` rend son contenu au lieu
    /// d'interroger systemd.
    canned_show: PathBuf,
}

impl Fakes {
    fn systemd_run_lines(&self) -> Vec<String> {
        read_lines(&self.systemd_run_log)
    }

    fn systemctl_lines(&self) -> Vec<String> {
        read_lines(&self.systemctl_log)
    }

    /// Unités passées en `--unit=` au faux `systemd-run` (la sonde du
    /// démarrage n'en a pas).
    fn launched_units(&self) -> Vec<String> {
        self.systemd_run_lines()
            .iter()
            .flat_map(|l| l.split_whitespace())
            .filter_map(|w| w.strip_prefix("--unit="))
            .map(str::to_owned)
            .collect()
    }

    /// Appels `systemctl --user show … <unit>` (unité exacte, en dernier).
    fn shows_of(&self, unit: &str) -> usize {
        self.systemctl_lines()
            .iter()
            .filter(|l| {
                l.starts_with("--user show -p LoadState -p ActiveState -p ControlGroup ")
                    && l.split_whitespace().last() == Some(unit)
            })
            .count()
    }

    /// Appels `systemctl --user stop <unit>` (unité exacte, seule).
    fn stops_of(&self, unit: &str) -> usize {
        let want = format!("--user stop {unit}");
        self.systemctl_lines()
            .iter()
            .filter(|l| l.as_str() == want)
            .count()
    }

    /// Aucun appel à `systemctl` ne vise une unité `devmaestro-*` que ce
    /// test n'a pas lancée.
    fn assert_no_foreign_unit(&self) {
        let units = self.launched_units();
        for line in self.systemctl_lines() {
            for w in line.split_whitespace() {
                if w.contains("devmaestro-") {
                    assert!(
                        units.iter().any(|u| u == w),
                        "systemctl appelé sur une unité étrangère au test : {line:?} (lancées : {units:?})"
                    );
                }
            }
        }
    }
}

fn read_lines(p: &Path) -> Vec<String> {
    std::fs::read_to_string(p)
        .unwrap_or_default()
        .lines()
        .map(str::to_owned)
        .collect()
}

/// Premier `name` exécutable du `PATH` du test, chemin réel.
fn real_bin(name: &str) -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|d| d.join(name))
        .find(|p| p.is_file())
        .and_then(|p| p.canonicalize().ok())
}

/// `Env` dont le démon trouve en tête de `PATH` un faux `systemd-run` et un
/// faux `systemctl` voisins (le démon prend le `systemctl` voisin de
/// `systemd-run`), plus un faux `npm` ; `None` (test sauté) sans systemd
/// utilisateur.
fn env_with_fakes(case: &str) -> Option<(Env, Fakes)> {
    if no_systemd(case) {
        return None;
    }
    let (Some(real_run), Some(real_ctl)) = (real_bin("systemd-run"), real_bin("systemctl")) else {
        skip(&format!("{case} : systemd-run ou systemctl absent du PATH"));
        return None;
    };
    let mut env = Env::new();
    let bin = env.root.join("faux-bin");
    std::fs::create_dir_all(&bin).unwrap();
    let fakes = Fakes {
        systemd_run_log: env.root.join("systemd-run.log"),
        systemctl_log: env.root.join("systemctl.log"),
        canned_show: env.root.join("show-impose"),
    };
    write_executable(
        &bin.join("systemd-run"),
        &format!(
            "#!/bin/sh\n[ -n \"$DEVMAESTRO_PROBE\" ] && exit 0\nprintf '%s\\n' \"$*\" >> '{}'\nexec '{}' \"$@\"\n",
            fakes.systemd_run_log.display(),
            real_run.display()
        ),
    );
    write_executable(
        &bin.join("systemctl"),
        &format!(
            "#!/bin/sh\n[ -n \"$DEVMAESTRO_PROBE\" ] && exit 0\nprintf '%s\\n' \"$*\" >> '{log}'\n\
             if [ \"$2\" = show ] && [ -f '{canned}' ]; then cat '{canned}'; exit 0; fi\n\
             exec '{real}' \"$@\"\n",
            log = fakes.systemctl_log.display(),
            canned = fakes.canned_show.display(),
            real = real_ctl.display()
        ),
    );
    write_executable(&bin.join("npm"), FAKE_NPM);
    let path = format!(
        "{}:{}",
        bin.display(),
        std::env::var("PATH").unwrap_or_default()
    );
    env.extra_env.push(("PATH".into(), path));
    Some((env, fakes))
}

/// Attend (borné) `cond`.
fn wait_for(what: &str, mut cond: impl FnMut() -> bool) {
    let start = Instant::now();
    while !cond() {
        assert!(start.elapsed() < TIMEOUT, "délai dépassé : {what}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// `sessions.stop`, puis attente de la fin du processus.
fn stop_session(c: &mut Client, id: Uuid) {
    c.call("sessions.stop", json!({"id": id}));
    c.wait_until("session arrêtée", |c| {
        c.last_session(id)
            .is_some_and(|s| s["status"]["state"] == "stopped" && s["alive"] == false)
    });
}

/// Unité lancée par le faux `systemd-run` avec ce préfixe, la seule.
fn only_unit(fakes: &Fakes, prefix: &str, known: &[String]) -> String {
    let units: Vec<String> = fakes
        .launched_units()
        .into_iter()
        .filter(|u| u.starts_with(prefix) && !known.contains(u))
        .collect();
    assert_eq!(units.len(), 1, "unités {prefix}* : {units:?}");
    units[0].clone()
}

/// État réel de l'unité (lecture seule).
fn is_active(unit: &str) -> String {
    let out = Command::new("systemctl")
        .args(["--user", "is-active", unit])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

#[test]
fn session_and_runner_scopes_are_checked_twice_after_reap() {
    let Some((env, fakes)) = env_with_fakes("libération des scopes après récolte") else {
        return;
    };
    std::fs::create_dir_all(env.proj.join("scripts")).unwrap();
    std::fs::write(env.proj.join("scripts/test.sh"), "echo ok\nexit 0\n").unwrap();
    std::fs::write(
        env.proj.join("package.json"),
        r#"{"scripts":{"test":"sh scripts/test.sh"}}"#,
    )
    .unwrap();
    std::fs::write(env.proj.join("package-lock.json"), "{}").unwrap();

    let _d = env.start_daemon();
    let mut c = Client::connect(&env);
    let sid = launch_idle(&mut c, &env, json!({}));
    let session_unit = only_unit(&fakes, "devmaestro-session-", &[]);

    // Runner qui sort aussitôt.
    let list = c.call("runners.list", json!({"id": sid}));
    let fp = list["runners"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == "package.json:test")
        .unwrap_or_else(|| panic!("runner test absent : {list}"))["fingerprint"]
        .clone();
    let started = c.call(
        "runners.start",
        json!({"id": sid, "runner_id": "package.json:test", "expected_fingerprint": fp}),
    );
    let process_id = started["process_id"].as_str().unwrap().to_owned();
    c.wait_until("runner terminé", |c| {
        c.notifications.iter().any(|n| {
            n["method"] == "runners.changed"
                && n["params"]["running"].as_array().is_some_and(|ps| {
                    ps.iter()
                        .any(|p: &Value| p["process_id"] == process_id && p["state"] == "exited")
                })
        })
    });
    let runner_unit = only_unit(&fakes, "devmaestro-runner-", &[]);

    stop_session(&mut c, sid);

    // Deux vérifications de l'unité exacte par exécution : aussitôt après
    // la récolte, puis après le délai du second essai.
    for unit in [&session_unit, &runner_unit] {
        wait_for(&format!("deux `show` de {unit}"), || {
            fakes.shows_of(unit) >= 2
        });
        assert_eq!(fakes.shows_of(unit), 2, "{:?}", fakes.systemctl_lines());
    }
    fakes.assert_no_foreign_unit();
    for unit in [&session_unit, &runner_unit] {
        let state = is_active(unit);
        assert!(
            state != "active" && state != "activating",
            "{unit} encore {state}"
        );
    }
}

#[test]
fn only_an_empty_scope_still_active_is_stopped() {
    let Some((env, fakes)) = env_with_fakes("arrêt d'un scope vide resté actif") else {
        return;
    };
    if !Path::new("/sys/fs/cgroup/cgroup.controllers").exists() {
        skip("arrêt d'un scope vide resté actif : hiérarchie cgroup v2 absente");
        return;
    }
    // `show` imposé : unité chargée, active, cgroup inexistant (donc vide).
    std::fs::write(
        &fakes.canned_show,
        "LoadState=loaded\nActiveState=active\nControlGroup=/devmaestro-test-absent/absent.scope\n",
    )
    .unwrap();
    let _d = env.start_daemon();
    let mut c = Client::connect(&env);
    let first = launch_idle(&mut c, &env, json!({}));
    let empty_unit = only_unit(&fakes, "devmaestro-session-", &[]);
    stop_session(&mut c, first);
    // Les deux essais trouvent l'unité « vide » : deux arrêts, sur l'unité
    // exacte (attendus avant de changer la réponse imposée).
    wait_for(&format!("deux stop de {empty_unit}"), || {
        fakes.stops_of(&empty_unit) >= 2
    });

    // Même état, mais le cgroup est celui du test : peuplé, jamais arrêté.
    let own = std::fs::read_to_string("/proc/self/cgroup").unwrap();
    let own = own
        .lines()
        .find_map(|l| l.strip_prefix("0::"))
        .expect("cgroup v2 du test");
    if own == "/" {
        // Conteneur ou espace de noms de cgroup : la racine vue n'a pas de
        // `cgroup.events`, le cgroup du test passerait pour vide.
        skip("scope peuplé jamais arrêté : cgroup du test vu comme la racine");
        return;
    }
    std::fs::write(
        &fakes.canned_show,
        format!("LoadState=loaded\nActiveState=active\nControlGroup={own}\n"),
    )
    .unwrap();
    let second = launch_idle(&mut c, &env, json!({}));
    let populated_unit = only_unit(
        &fakes,
        "devmaestro-session-",
        std::slice::from_ref(&empty_unit),
    );
    stop_session(&mut c, second);
    wait_for(&format!("deux `show` de {populated_unit}"), || {
        fakes.shows_of(&populated_unit) >= 2
    });
    assert_eq!(fakes.stops_of(&populated_unit), 0);
    assert_eq!(fakes.stops_of(&empty_unit), 2);
    std::fs::remove_file(&fakes.canned_show).unwrap();
    fakes.assert_no_foreign_unit();
}
