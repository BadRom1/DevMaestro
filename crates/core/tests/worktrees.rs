//! v0.2, lot 6 : session lancée dans un nouveau worktree, liste et
//! suppression des worktrees, rattachement au projet d'une session dont le
//! worktree a disparu (vrais dépôts git temporaires, tests sautés sans git).

mod common;

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use common::*;
use serde_json::{Value, json};
use uuid::Uuid;

fn git(dir: &Path, args: &[&str]) -> bool {
    Command::new("git")
        .arg("-C")
        .arg(dir)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .args([
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

fn init_repo(repo: &Path) {
    assert!(git(repo, &["init", "-q", "-b", "main"]));
    std::fs::write(repo.join("a.txt"), "a\n").unwrap();
    assert!(git(repo, &["add", "."]));
    assert!(git(repo, &["commit", "-q", "-m", "base"]));
}

fn worktrees_changed(c: &Client, root: &Path) -> usize {
    c.notifications
        .iter()
        .filter(|n| {
            n["method"] == "project.worktrees_changed" && n["params"] == json!({"root": root})
        })
        .count()
}

fn launch_in_worktree(c: &mut Client, env: &Env, worktree: Value) -> Value {
    c.call_raw(
        "sessions.launch",
        json!({"cwd": env.proj, "cols": 80, "rows": 24, "mode": "default", "worktree": worktree}),
    )
}

fn stop(c: &mut Client, id: Uuid) {
    c.call("sessions.stop", json!({"id": id}));
    c.wait_until("session arrêtée", |c| {
        c.last_session(id).is_some_and(|s| s["alive"] == false)
    });
}

fn find<'a>(list: &'a Value, path: &Path) -> &'a Value {
    list["worktrees"]
        .as_array()
        .unwrap()
        .iter()
        .find(|w| w["path"] == json!(path))
        .unwrap_or_else(|| panic!("{} absent de {list}", path.display()))
}

#[test]
fn session_in_a_new_worktree_then_cleanup() {
    if !git_available() {
        eprintln!("git absent : test sauté");
        return;
    }
    let env = Env::new();
    let repo = env.proj.clone();
    init_repo(&repo);
    let _daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    c.call("hello", json!({}));

    // Lancement dans un nouveau worktree à côté du dépôt.
    let r = launch_in_worktree(
        &mut c,
        &env,
        json!({"branch": "feat/x", "location": "sibling"}),
    );
    assert!(r.get("error").is_none(), "{r}");
    let r = &r["result"];
    let wt: PathBuf = repo.parent().unwrap().join("projet-feat-x");
    assert_eq!(
        r["worktree"],
        json!({"path": wt, "branch": "feat/x", "base": "main"})
    );
    let s = &r["session"];
    assert_eq!(s["cwd"], json!(wt));
    assert_eq!(s["project_root"], json!(repo));
    assert_eq!(s["project_common_dir"], json!(repo.join(".git")));
    assert_eq!(s["branch"], "feat/x");
    assert!(wt.join("a.txt").exists());
    let id: Uuid = s["id"].as_str().unwrap().parse().unwrap();
    c.wait_until("notification de création", |c| {
        worktrees_changed(c, &repo) >= 1
    });
    c.wait_until("session inactive", |c| {
        c.last_session(id)
            .is_some_and(|s| status_label(&s) == "idle")
    });

    // Même branche, même dossier : refusés, rien n'est créé.
    let r = launch_in_worktree(&mut c, &env, json!({"branch": "feat/x"}));
    assert_eq!(r["error"]["code"], -32602, "{r}");
    assert!(
        r["error"]["message"]
            .as_str()
            .unwrap()
            .contains("existe déjà"),
        "{r}"
    );
    std::fs::create_dir(repo.parent().unwrap().join("projet-occupe")).unwrap();
    let r = launch_in_worktree(&mut c, &env, json!({"branch": "occupe"}));
    assert_eq!(r["error"]["code"], -32602, "{r}");
    assert!(git(&repo, &["branch", "ailleurs"]));
    assert!(git(&repo, &["checkout", "-q", "ailleurs"]));
    let r = launch_in_worktree(
        &mut c,
        &env,
        json!({"branch": "ailleurs", "location": "in_repo"}),
    );
    assert!(
        r["error"]["message"]
            .as_str()
            .unwrap()
            .contains("déjà extraite"),
        "{r}"
    );
    assert!(git(&repo, &["checkout", "-q", "main"]));
    for bad in [
        json!({"branch": "a..b"}),
        json!({"branch": "-D"}),
        json!({"branch": "x", "location": "ailleurs"}),
        json!({"branch": "x", "path": "/tmp/x"}),
        json!({"branch": "x", "location": "custom", "path": "relatif"}),
        json!({"branch": "x", "location": "custom", "path": "/tmp/."}),
        json!({"branch": "x", "location": "custom", "path": "/tmp/a/.."}),
        json!({"branch": "x", "base": "inconnue"}),
        json!({"location": "sibling"}),
    ] {
        let r = launch_in_worktree(&mut c, &env, bad.clone());
        assert_eq!(r["error"]["code"], -32602, "{bad} : {r}");
    }

    // Liste : le principal d'abord, le nouveau worktree géré par le démon.
    let l = c.call("worktrees.list", json!({"root": repo}));
    assert_eq!(l["root"], json!(repo));
    assert_eq!(l["default_branch"], "main");
    assert_eq!(l["reference"], "main");
    assert_eq!(l["worktrees"].as_array().unwrap().len(), 2);
    let main = &l["worktrees"][0];
    assert_eq!(main["main"], true);
    assert_eq!(main["integrated"], Value::Null);
    assert_eq!(main["sessions_running"], 0);
    assert_eq!(main["dirty"], false);
    let w = find(&l, &wt);
    assert_eq!(w["branch"], "feat/x");
    assert_eq!(w["managed_by"], "devmaestro");
    assert_eq!(w["sessions_running"], 1);
    assert_eq!(w["exists"], true);
    assert_eq!(w["ahead"], 0);
    // Aucun commit à elle : « empty », pas « intégrée ».
    assert_eq!(w["integrated"], "empty");

    // Suppression : refusée pour le principal, un chemin étranger, une session vivante.
    let remove = |c: &mut Client, path: &Path, extra: Value| {
        let mut p = json!({"root": repo, "path": path});
        for (k, v) in extra.as_object().unwrap() {
            p[k] = v.clone();
        }
        c.call_raw("worktrees.remove", p)
    };
    assert_eq!(remove(&mut c, &repo, json!({}))["error"]["code"], -32602);
    assert_eq!(
        remove(&mut c, Path::new("/nulle/part"), json!({}))["error"]["code"],
        -32602
    );
    let r = remove(&mut c, &wt, json!({}));
    assert_eq!(r["error"]["code"], -32019, "{r}");

    // Travail commité dans le worktree, puis fichiers non commités.
    std::fs::write(wt.join("b.txt"), "b\n").unwrap();
    assert!(git(&wt, &["add", "."]));
    assert!(git(&wt, &["commit", "-q", "-m", "travail"]));
    std::fs::write(wt.join("brouillon.txt"), "x\n").unwrap();
    stop(&mut c, id);
    let n = worktrees_changed(&c, &repo);
    let l = c.call("worktrees.list", json!({"root": wt}));
    let w = find(&l, &wt);
    assert_eq!(
        (w["dirty"].clone(), w["ahead"].clone()),
        (json!(true), json!(1))
    );
    assert_eq!(w["integrated"], "no");
    assert_eq!(w["sessions_running"], 0);
    let r = remove(&mut c, &wt, json!({"delete_branch": true}));
    assert_eq!(r["error"]["code"], -32020, "{r}");
    assert_eq!(
        r["error"]["data"],
        json!({"files": ["brouillon.txt"], "total": 1})
    );
    assert!(wt.exists());

    // Intégration dans main : « merged » (recalcul en fin de session ou au
    // sondage ; ici relu par worktrees.list).
    assert!(git(&repo, &["merge", "-q", "--ff-only", "feat/x"]));
    let l = c.call("worktrees.list", json!({"root": repo}));
    assert_eq!(find(&l, &wt)["integrated"], "merged");

    // Sans force, une fois le brouillon retiré : worktree et branche
    // supprimés (`-D`, la branche est intégrée selon notre référence).
    std::fs::remove_file(wt.join("brouillon.txt")).unwrap();
    let r = remove(&mut c, &wt, json!({"delete_branch": true}));
    assert!(r.get("error").is_none(), "{r}");
    assert_eq!(r["result"]["removed"], true);
    assert_eq!(r["result"]["branch_deleted"], true);
    assert!(!wt.exists());
    assert!(!git(
        &repo,
        &["rev-parse", "--verify", "-q", "refs/heads/feat/x"]
    ));
    c.wait_until("notification de suppression", |c| {
        worktrees_changed(c, &repo) > n
    });
    let l = c.call("worktrees.list", json!({"root": repo}));
    assert_eq!(l["worktrees"].as_array().unwrap().len(), 1);

    // La session arrêtée reste dans l'historique, rattachée à son projet.
    c.wait_until("dossier disparu", |c| {
        c.last_session(id)
            .is_some_and(|s| s["resume_blocker"] == "cwd_missing")
    });
    let s = c.call("sessions.get", json!({"id": id}));
    assert_eq!(s["session"]["project_common_dir"], json!(repo.join(".git")));
    let p = c.call("projects.resolve", json!({"path": wt}));
    assert_eq!(p["exists"], false);
    assert_eq!(p["inferred"], true);
    assert_eq!(p["root"], json!(repo));
    assert_eq!(p["common_dir"], json!(repo.join(".git")));
    let p = c.call("projects.resolve", json!({"path": wt.join("sous/dossier")}));
    assert_eq!(p["root"], json!(repo));

    // `in_repo` : dossier exclu localement, principal toujours propre ;
    // suppression sans force d'un worktree propre, branche gardée.
    let r = launch_in_worktree(
        &mut c,
        &env,
        json!({"branch": "dedans", "location": "in_repo"}),
    );
    assert!(r.get("error").is_none(), "{r}");
    let inside = repo.join(".worktrees/dedans");
    assert_eq!(r["result"]["worktree"]["path"], json!(inside));
    let id2: Uuid = r["result"]["session"]["id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let exclude = std::fs::read_to_string(repo.join(".git/info/exclude")).unwrap();
    assert!(exclude.lines().any(|l| l == ".worktrees/"), "{exclude}");
    let l = c.call("worktrees.list", json!({"root": repo}));
    assert_eq!(l["worktrees"][0]["dirty"], false);
    assert_eq!(l["worktrees"][0]["sessions_running"], 0);
    assert_eq!(find(&l, &inside)["sessions_running"], 1);
    // Fin de tour (Stop) : `dirty` relu, notification (après le calcul de
    // référence qui suit la création).
    c.call("sessions.subscribe", json!({"id": id2}));
    c.wait_until("session inactive", |c| {
        c.last_session(id2)
            .is_some_and(|s| status_label(&s) == "idle")
    });
    // Référence de la notification posée par une première mesure.
    c.call("worktrees.list", json!({"root": repo}));
    let before = worktrees_changed(&c, &repo);
    std::fs::write(inside.join("tmp.txt"), "t\n").unwrap();
    turn(&mut c, id2);
    c.wait_until("notification de changement (dirty)", |c| {
        worktrees_changed(c, &repo) > before
    });
    std::fs::remove_file(inside.join("tmp.txt")).unwrap();
    stop(&mut c, id2);
    let r = remove(&mut c, &inside, json!({}));
    assert!(r.get("error").is_none(), "{r}");
    assert_eq!(r["result"]["branch_deleted"], Value::Null);
    assert!(git(
        &repo,
        &["rev-parse", "--verify", "-q", "refs/heads/dedans"]
    ));

    // Branche existante : worktree créé sur elle, base ignorée (avertissement).
    let r = launch_in_worktree(
        &mut c,
        &env,
        json!({"branch": "dedans", "base": "main", "location": "managed"}),
    );
    assert!(r.get("error").is_none(), "{r}");
    let r = &r["result"];
    assert_eq!(r["worktree"]["base"], Value::Null);
    assert!(
        r["warnings"][0].as_str().unwrap().contains("existe déjà"),
        "{r}"
    );
    let managed = PathBuf::from(r["worktree"]["path"].as_str().unwrap());
    assert!(managed.starts_with(env.data.join("devmaestro/worktrees")));
    assert!(managed.ends_with("dedans"));
    let id3: Uuid = r["session"]["id"].as_str().unwrap().parse().unwrap();
    stop(&mut c, id3);

    // Squash : suppression de la branche sans force (`-D`, que `-d` refuserait).
    let r = launch_in_worktree(&mut c, &env, json!({"branch": "sq"}));
    assert!(r.get("error").is_none(), "{r}");
    let sq = PathBuf::from(r["result"]["worktree"]["path"].as_str().unwrap());
    let id4: Uuid = r["result"]["session"]["id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    std::fs::write(sq.join("s.txt"), "s\n").unwrap();
    assert!(git(&sq, &["add", "."]));
    assert!(git(&sq, &["commit", "-q", "-m", "s1"]));
    std::fs::write(sq.join("s.txt"), "s\ns\n").unwrap();
    assert!(git(&sq, &["commit", "-q", "-am", "s2"]));
    stop(&mut c, id4);
    assert!(git(&repo, &["merge", "-q", "--squash", "sq"]));
    assert!(git(&repo, &["commit", "-q", "-m", "squash"]));
    let l = c.call("worktrees.list", json!({"root": repo}));
    assert_eq!(find(&l, &sq)["integrated"], "squashed");
    let r = remove(&mut c, &sq, json!({"delete_branch": true}));
    assert!(r.get("error").is_none(), "{r}");
    assert_eq!(r["result"]["branch_deleted"], true, "{r}");
    assert!(!git(
        &repo,
        &["rev-parse", "--verify", "-q", "refs/heads/sq"]
    ));

    // La branche par défaut n'est jamais supprimée, quel que soit le worktree.
    assert!(git(&repo, &["checkout", "-q", "ailleurs"]));
    let r = launch_in_worktree(&mut c, &env, json!({"branch": "main"}));
    assert!(r.get("error").is_none(), "{r}");
    let on_main = PathBuf::from(r["result"]["worktree"]["path"].as_str().unwrap());
    let id5: Uuid = r["result"]["session"]["id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    stop(&mut c, id5);
    let r = remove(
        &mut c,
        &on_main,
        json!({"delete_branch": true, "force": true}),
    );
    assert_eq!(r["error"]["code"], -32602, "{r}");
    assert!(on_main.exists());
}

#[test]
fn failed_launch_removes_the_new_worktree_and_branch() {
    if !git_available() {
        eprintln!("git absent : test sauté");
        return;
    }
    if nix::unistd::geteuid().is_root() {
        eprintln!("root : les droits 0500 n'empêchent rien, test sauté");
        return;
    }
    let env = Env::new();
    init_repo(&env.proj);
    assert!(git(&env.proj, &["branch", "garde"]));
    let _daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    c.call("hello", json!({}));
    // Réglages du profil impossibles à réécrire : le lancement échoue une
    // fois le worktree créé (tout est validé avant).
    use std::os::unix::fs::PermissionsExt;
    let settings = env.data.join("devmaestro/settings");
    assert!(settings.is_dir());
    std::fs::set_permissions(&settings, std::fs::Permissions::from_mode(0o500)).unwrap();
    let r = launch_in_worktree(&mut c, &env, json!({"branch": "rate"}));
    assert_eq!(r["error"]["code"], -32004, "{r}");
    let wt = env.proj.parent().unwrap().join("projet-rate");
    assert!(!wt.exists());
    assert!(!git(
        &env.proj,
        &["rev-parse", "--verify", "-q", "refs/heads/rate"]
    ));
    // Branche existante : le worktree est retiré, la branche survit.
    let r = launch_in_worktree(&mut c, &env, json!({"branch": "garde"}));
    assert_eq!(r["error"]["code"], -32004, "{r}");
    assert!(!env.proj.parent().unwrap().join("projet-garde").exists());
    assert!(git(
        &env.proj,
        &["rev-parse", "--verify", "-q", "refs/heads/garde"]
    ));
    let l = c.call("worktrees.list", json!({"root": env.proj}));
    assert_eq!(l["worktrees"].as_array().unwrap().len(), 1);
    assert_eq!(c.call("sessions.list", json!({}))["sessions"], json!([]));
    std::fs::set_permissions(&settings, std::fs::Permissions::from_mode(0o700)).unwrap();
    // Hors dépôt : refusé.
    let outside = env.home.clone();
    let r = c.call_raw(
        "sessions.launch",
        json!({"cwd": outside, "worktree": {"branch": "x"}}),
    );
    assert_eq!(r["error"]["code"], -32017, "{r}");
    assert_eq!(
        c.call_err("worktrees.list", json!({"root": outside})),
        -32017
    );
}

#[test]
fn existing_sessions_get_their_project_identity_at_startup() {
    if !git_available() {
        eprintln!("git absent : test sauté");
        return;
    }
    let env = Env::new();
    init_repo(&env.proj);
    let mut daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    c.call("hello", json!({}));
    let id = launch_idle(&mut c, &env, json!({"mode": "default"}));
    stop(&mut c, id);
    drop(c);
    daemon.signal(nix::sys::signal::Signal::SIGTERM);
    daemon.wait();
    // Base d'avant le schéma v6 : identité absente.
    {
        let db = rusqlite::Connection::open(env.data.join("devmaestro/state.db")).unwrap();
        db.execute("UPDATE sessions SET project_common_dir = NULL", [])
            .unwrap();
    }
    let _daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    c.call("hello", json!({}));
    let s = c.call("sessions.get", json!({"id": id}));
    assert_eq!(
        s["session"]["project_common_dir"],
        json!(env.proj.join(".git"))
    );
}
