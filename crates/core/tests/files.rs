//! v0.2, lot 3 : onglet Fichiers (`files.list`, `files.read`), confiné à la
//! racine de la session, dans un vrai dépôt git temporaire et hors dépôt.

mod common;

use std::os::unix::fs::symlink;
use std::path::Path;
use std::process::{Command, Stdio};

use common::*;
use serde_json::{Value, json};
use uuid::Uuid;

fn git(dir: &Path, args: &[&str]) -> bool {
    Command::new("git")
        .arg("-C")
        .arg(dir)
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

fn names(list: &Value) -> Vec<String> {
    list["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["name"].as_str().unwrap().to_owned())
        .collect()
}

fn entry<'a>(list: &'a Value, name: &str) -> &'a Value {
    list["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["name"] == name)
        .unwrap_or_else(|| panic!("{name} absent : {list}"))
}

fn big_dir(dir: &Path) {
    std::fs::create_dir_all(dir).unwrap();
    for i in (1..=2050).rev() {
        std::fs::write(dir.join(format!("f{i}")), "").unwrap();
    }
}

fn check_big(list: &Value) {
    let n = names(list);
    assert_eq!(list["truncated"], true);
    assert_eq!(n.len(), 2000);
    assert_eq!(
        (n[0].as_str(), n[1].as_str(), n[9].as_str()),
        ("f1", "f2", "f10")
    );
    assert_eq!(n[1999], "f2000");
    assert_eq!(entry(list, "f7")["size"], 0);
}

#[test]
fn files_of_a_git_session() {
    if !git_available() {
        eprintln!("git absent : test sauté");
        return;
    }
    let env = Env::new();
    let repo = env.proj.clone();
    let outside = env.proj.parent().unwrap().join("dehors.txt");
    std::fs::write(&outside, "secret\n").unwrap();
    std::fs::create_dir_all(repo.join("src")).unwrap();
    std::fs::create_dir_all(repo.join("docs")).unwrap();
    std::fs::write(repo.join("README.md"), "# Projet\n").unwrap();
    std::fs::write(repo.join("src/a.rs"), "fn a() {}\n").unwrap();
    std::fs::write(repo.join("src/b2.rs"), "").unwrap();
    std::fs::write(repo.join("src/b10.rs"), "").unwrap();
    std::fs::write(repo.join("docs/vieux.md"), "x\n").unwrap();
    std::fs::write(repo.join(".gitignore"), "ignoré/\n*.log\n").unwrap();
    symlink("src", repo.join("lien")).unwrap();
    symlink(&outside, repo.join("dehors")).unwrap();
    assert!(git(&repo, &["init", "-q", "-b", "main"]));
    assert!(git(&repo, &["add", "."]));
    assert!(git(&repo, &["commit", "-q", "-m", "base"]));
    std::fs::write(repo.join("src/a.rs"), "fn a() { modifié }\n").unwrap();
    std::fs::remove_dir_all(repo.join("docs")).unwrap();
    std::fs::write(repo.join("nouveau.txt"), "neuf\n").unwrap();
    std::fs::create_dir_all(repo.join("ignoré")).unwrap();
    std::fs::write(repo.join("ignoré/x"), "x").unwrap();
    std::fs::write(repo.join("trace.log"), "x").unwrap();
    std::fs::write(repo.join("binaire.dat"), b"\0\x01\x02").unwrap();
    std::fs::write(repo.join("gros.txt"), "x".repeat(2 * 1024 * 1024 + 1)).unwrap();
    nix::unistd::mkfifo(
        &repo.join("fifo"),
        nix::sys::stat::Mode::from_bits_truncate(0o600),
    )
    .unwrap();

    let _daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    c.call("hello", json!({}));
    // Session dans un sous-dossier : la racine est celle du dépôt.
    let id = launch_idle(&mut c, &env, json!({"cwd": repo.join("src")}));

    let l = c.call("files.list", json!({"id": id}));
    assert_eq!(l["root"], json!(repo.canonicalize().unwrap()));
    assert_eq!(l["path"], "");
    assert_eq!(l["truncated"], false);
    assert_eq!(
        names(&l),
        [
            "docs",
            "src",
            ".gitignore",
            "binaire.dat",
            "dehors",
            "gros.txt",
            "lien",
            "nouveau.txt",
            "README.md"
        ],
        "{l}"
    );
    assert_eq!(entry(&l, "src")["kind"], "dir");
    assert_eq!(entry(&l, "src")["changed"], "M");
    assert_eq!(entry(&l, "src")["size"], Value::Null);
    assert_eq!(entry(&l, "docs")["changed"], "M");
    assert_eq!(entry(&l, "lien")["kind"], "symlink");
    assert_eq!(entry(&l, "dehors")["kind"], "symlink");
    assert_eq!(entry(&l, "nouveau.txt")["changed"], "?");
    assert_eq!(entry(&l, "nouveau.txt")["size"], 5);
    assert_eq!(entry(&l, "README.md")["changed"], Value::Null);
    assert_eq!(entry(&l, "README.md")["path"], "README.md");

    let s = c.call("files.list", json!({"id": id, "path": "src"}));
    assert_eq!(names(&s), ["a.rs", "b2.rs", "b10.rs"]);
    assert_eq!(entry(&s, "a.rs")["changed"], "M");
    assert_eq!(entry(&s, "a.rs")["path"], "src/a.rs");
    // Dossier supprimé : ses fichiers sont listés, marqués « D ».
    let d = c.call("files.list", json!({"id": id, "path": "docs"}));
    assert_eq!(
        d["entries"],
        json!([{"name": "vieux.md", "path": "docs/vieux.md", "kind": "file", "size": null, "changed": "D"}])
    );
    for bad in [
        "lien",
        "../",
        "/etc",
        ".git",
        "README.md",
        "absent",
        "src/../..",
    ] {
        assert_eq!(
            c.call_err("files.list", json!({"id": id, "path": bad})),
            -32602,
            "{bad}"
        );
    }

    let r = c.call("files.read", json!({"id": id, "path": "README.md"}));
    assert_eq!(
        r,
        json!({"path": "README.md", "size": 9, "binary": false, "too_large": false, "content": "# Projet\n"})
    );
    // Lien vers un dossier de la racine : suivi pour lire.
    let r = c.call("files.read", json!({"id": id, "path": "lien/a.rs"}));
    assert_eq!(r["content"], "fn a() { modifié }\n");
    let r = c.call("files.read", json!({"id": id, "path": "binaire.dat"}));
    assert_eq!(
        (r["binary"].clone(), r["content"].clone()),
        (json!(true), Value::Null)
    );
    let r = c.call("files.read", json!({"id": id, "path": "gros.txt"}));
    assert_eq!(r["too_large"], true);
    assert_eq!(r["size"], 2 * 1024 * 1024 + 1);
    assert_eq!(r["content"], Value::Null);
    for bad in [
        "dehors",
        "../dehors.txt",
        "/etc/passwd",
        ".git/config",
        "fifo",
        "src",
        "",
        "absent.txt",
    ] {
        assert_eq!(
            c.call_err("files.read", json!({"id": id, "path": bad})),
            -32602,
            "{bad}"
        );
    }
    // Un lien interne vers .git n'ouvre pas .git.
    symlink(".git/config", repo.join("vers-git")).unwrap();
    assert_eq!(
        c.call_err("files.read", json!({"id": id, "path": "vers-git"})),
        -32602
    );

    // Grand dossier non suivi du dépôt : même règle (une fois la liste du
    // dépôt refaite, 3 s au plus).
    big_dir(&repo.join("beaucoup"));
    let start = std::time::Instant::now();
    let b = loop {
        let b = c.call("files.list", json!({"id": id, "path": "beaucoup"}));
        if b["truncated"] == true {
            break b;
        }
        assert!(start.elapsed() < std::time::Duration::from_secs(5), "{b}");
        std::thread::sleep(std::time::Duration::from_millis(200));
    };
    check_big(&b);

    // Session arrêtée : toujours lisible ; dossier disparu : -32016.
    c.call("sessions.stop", json!({"id": id}));
    c.wait_until("arrêt", |c| {
        c.last_session(id).is_some_and(|s| s["alive"] == false)
    });
    // Le nouveau lien et « beaucoup » apparaissent une fois la liste du dépôt
    // refaite (3 s au plus).
    let start = std::time::Instant::now();
    loop {
        let n = c.call("files.list", json!({"id": id}))["entries"]
            .as_array()
            .unwrap()
            .len();
        if n == 11 {
            break;
        }
        assert!(
            start.elapsed() < std::time::Duration::from_secs(5),
            "{n} entrées"
        );
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    assert_eq!(
        c.call_err("files.list", json!({"id": Uuid::new_v4()})),
        -32001
    );
}

#[test]
fn files_outside_a_repository() {
    let env = Env::new();
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    std::fs::create_dir_all(root.join("sous")).unwrap();
    std::fs::create_dir_all(root.join(".git")).unwrap();
    std::fs::write(root.join("Note 10.md"), "dix").unwrap();
    std::fs::write(root.join("Note 9.md"), "neuf").unwrap();
    symlink("/etc", root.join("etc")).unwrap();
    nix::unistd::mkfifo(
        &root.join("fifo"),
        nix::sys::stat::Mode::from_bits_truncate(0o600),
    )
    .unwrap();
    let _daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    c.call("hello", json!({}));
    let id = launch_idle(&mut c, &env, json!({"cwd": root}));
    let l = c.call("files.list", json!({"id": id}));
    assert_eq!(l["root"], json!(root));
    assert_eq!(names(&l), ["sous", "etc", "Note 9.md", "Note 10.md"], "{l}");
    assert_eq!(entry(&l, "etc")["kind"], "symlink");
    assert_eq!(entry(&l, "Note 9.md")["changed"], Value::Null);
    assert_eq!(entry(&l, "Note 10.md")["size"], 3);
    assert_eq!(
        c.call_err("files.list", json!({"id": id, "path": "etc"})),
        -32602
    );
    assert_eq!(
        c.call_err("files.read", json!({"id": id, "path": "etc/passwd"})),
        -32602
    );
    assert_eq!(
        c.call_err("files.read", json!({"id": id, "path": "fifo"})),
        -32602
    );
    assert_eq!(
        c.call("files.read", json!({"id": id, "path": "Note 9.md"}))["content"],
        "neuf"
    );
    // Grand dossier : tri naturel puis coupe à 2 000, toujours les mêmes.
    big_dir(&root.join("beaucoup"));
    let b = c.call("files.list", json!({"id": id, "path": "beaucoup"}));
    check_big(&b);
    // Dossier de la session disparu.
    c.call("sessions.stop", json!({"id": id}));
    c.wait_until("arrêt", |c| {
        c.last_session(id).is_some_and(|s| s["alive"] == false)
    });
    drop(dir);
    assert_eq!(c.call_err("files.list", json!({"id": id})), -32016);
    assert_eq!(
        c.call_err("files.read", json!({"id": id, "path": "Note 9.md"})),
        -32016
    );
}
