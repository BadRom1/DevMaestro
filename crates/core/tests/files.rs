//! v0.2, lot 3 : onglet Fichiers (`files.list`, `files.read`), confiné à la
//! racine de la session, dans un vrai dépôt git temporaire et hors dépôt.

mod common;

use std::os::unix::fs::symlink;
use std::path::Path;
use std::process::{Command, Stdio};

use common::*;
use devmaestro_core::domain::files::sha256_hex;
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
    let mtime = r["version"]["mtime_ns"].clone();
    assert!(mtime.as_i64().is_some_and(|t| t > 0), "{r}");
    assert_eq!(
        r,
        json!({"path": "README.md", "size": 9, "binary": false, "too_large": false, "content": "# Projet\n",
               "version": {"size": 9, "mtime_ns": mtime, "sha256": sha256_hex(b"# Projet\n")},
               "editable": true, "not_editable_reason": null})
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
    assert_eq!(r["version"], Value::Null);
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

/// Fichiers temporaires d'écriture restés dans un dossier.
fn temps(dir: &Path) -> Vec<String> {
    std::fs::read_dir(dir)
        .unwrap()
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter(|n| n.starts_with(".devmaestro-"))
        .collect()
}

fn mode(path: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).unwrap().permissions().mode() & 0o7777
}

#[test]
fn files_write() {
    use std::os::unix::fs::PermissionsExt;
    let env = Env::new();
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("racine");
    std::fs::create_dir_all(root.join("sous")).unwrap();
    std::fs::create_dir_all(root.join(".git")).unwrap();
    std::fs::write(root.join(".git/config"), "secret").unwrap();
    std::fs::write(dir.path().join("dehors.txt"), "secret").unwrap();
    std::fs::write(root.join("a.txt"), "un\r\ndeux\n").unwrap();
    std::fs::set_permissions(root.join("a.txt"), std::fs::Permissions::from_mode(0o640)).unwrap();
    std::fs::write(root.join("script.sh"), "#!/bin/sh\n").unwrap();
    std::fs::set_permissions(
        root.join("script.sh"),
        std::fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    std::fs::write(root.join("binaire.dat"), b"\0\x01").unwrap();
    std::fs::write(root.join("latin1.txt"), b"caf\xe9\n").unwrap();
    std::fs::write(root.join("lecture-seule.txt"), "ro\n").unwrap();
    std::fs::set_permissions(
        root.join("lecture-seule.txt"),
        std::fs::Permissions::from_mode(0o444),
    )
    .unwrap();
    std::fs::write(root.join("gros.txt"), "x".repeat(2 * 1024 * 1024 + 1)).unwrap();
    symlink("a.txt", root.join("lien-final")).unwrap();
    symlink("sous", root.join("lien-dossier")).unwrap();
    symlink("..", root.join("lien-dehors")).unwrap();
    symlink(".git", root.join("vers-git")).unwrap();
    nix::unistd::mkfifo(
        &root.join("fifo"),
        nix::sys::stat::Mode::from_bits_truncate(0o600),
    )
    .unwrap();
    let root = root.canonicalize().unwrap();
    let _daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    c.call("hello", json!({}));
    let id = launch_idle(&mut c, &env, json!({"cwd": root}));

    // En root, les droits ne refusent rien : cas « lecture seule » sautés.
    let root_user = nix::unistd::geteuid().is_root();
    // Modifiable ou non, d'après files.read : tout ce que files.write
    // refuserait d'avance.
    for (path, why) in [
        ("latin1.txt", "UTF-8"),
        ("binaire.dat", "binaire"),
        ("gros.txt", "trop gros"),
        ("lecture-seule.txt", "lecture seule"),
        ("lien-final", "lien symbolique"),
    ] {
        if root_user && why == "lecture seule" {
            continue;
        }
        let r = c.call("files.read", json!({"id": id, "path": path}));
        assert_eq!(r["editable"], false, "{path} : {r}");
        let reason = r["not_editable_reason"].as_str().unwrap_or_default();
        assert!(reason.contains(why), "{path} : {reason}");
    }
    let r = c.call("files.read", json!({"id": id, "path": "latin1.txt"}));
    assert_eq!(r["content"], "caf\u{fffd}\n");
    assert_eq!(
        r["not_editable_reason"],
        "le fichier n'est pas un texte UTF-8 valide"
    );
    // Lien interne vers un dossier sur le chemin : modifiable (seul le
    // dernier composant ne doit pas être un lien).
    std::fs::write(root.join("sous/b.txt"), "b").unwrap();
    let r = c.call(
        "files.read",
        json!({"id": id, "path": "lien-dossier/b.txt"}),
    );
    assert_eq!(
        (r["editable"].clone(), r["not_editable_reason"].clone()),
        (json!(true), Value::Null)
    );

    // Lecture → écriture → nouvelle version, octets conservés tels quels.
    let r = c.call("files.read", json!({"id": id, "path": "a.txt"}));
    assert_eq!(r["editable"], true, "{r}");
    let v0 = r["version"].clone();
    assert_eq!(v0["sha256"], sha256_hex(b"un\r\ndeux\n"));
    assert_eq!(v0["size"], 9);
    let w = c.call(
        "files.write",
        json!({"id": id, "path": "a.txt", "content": "un\r\ndeux\r\ntrois",
               "expected": {"sha256": v0["sha256"]}}),
    );
    let v1 = w["version"].clone();
    assert_eq!(v1["sha256"], sha256_hex(b"un\r\ndeux\r\ntrois"));
    assert_eq!(v1["size"], 15);
    assert_eq!(
        std::fs::read(root.join("a.txt")).unwrap(),
        b"un\r\ndeux\r\ntrois"
    );
    assert_eq!(
        c.call("files.read", json!({"id": id, "path": "a.txt"}))["version"],
        v1,
        "la version rendue est celle que relit files.read"
    );
    // Droits conservés.
    assert_eq!(mode(&root.join("a.txt")), 0o640);
    let s = c.call("files.read", json!({"id": id, "path": "script.sh"}));
    c.call(
        "files.write",
        json!({"id": id, "path": "script.sh", "content": "#!/bin/sh\necho ok\n",
               "expected": {"sha256": s["version"]["sha256"]}}),
    );
    assert_eq!(mode(&root.join("script.sh")), 0o755);

    // Conflit : le fichier a changé entre la lecture et l'écriture.
    std::fs::write(root.join("a.txt"), "changé par Claude\n").unwrap();
    // Un refus n'ouvre jamais le fichier en écriture (surveillants).
    let watch =
        nix::sys::inotify::Inotify::init(nix::sys::inotify::InitFlags::IN_NONBLOCK).unwrap();
    watch
        .add_watch(
            &root.join("a.txt"),
            nix::sys::inotify::AddWatchFlags::IN_CLOSE_WRITE
                | nix::sys::inotify::AddWatchFlags::IN_MODIFY,
        )
        .unwrap();
    let e = c.call_raw(
        "files.write",
        json!({"id": id, "path": "a.txt", "content": "le mien",
               "expected": {"sha256": v1["sha256"]}}),
    );
    assert_eq!(e["error"]["code"], -32021, "{e}");
    assert_eq!(
        e["error"]["message"],
        "le fichier a été modifié depuis son ouverture"
    );
    let cur = e["error"]["data"]["version"].clone();
    match watch.read_events() {
        Err(nix::errno::Errno::EAGAIN) => {}
        other => panic!("ouverture en écriture parasite : {other:?}"),
    }
    assert_eq!(cur["sha256"], sha256_hex("changé par Claude\n".as_bytes()));
    assert_eq!(cur["size"], "changé par Claude\n".len());
    assert_eq!(
        std::fs::read_to_string(root.join("a.txt")).unwrap(),
        "changé par Claude\n",
        "rien n'est écrit"
    );
    // « Écraser quand même » : renvoyé avec l'empreinte actuelle.
    c.call(
        "files.write",
        json!({"id": id, "path": "a.txt", "content": "le mien",
               "expected": {"sha256": cur["sha256"]}}),
    );
    assert_eq!(
        std::fs::read_to_string(root.join("a.txt")).unwrap(),
        "le mien"
    );

    // Création : `expected` null, fichier absent ; parent atteint par un lien
    // interne.
    let w = c.call(
        "files.write",
        json!({"id": id, "path": "lien-dossier/neuf.md", "content": "# Neuf\n", "expected": null}),
    );
    assert_eq!(w["version"]["sha256"], sha256_hex(b"# Neuf\n"));
    assert_eq!(
        std::fs::read_to_string(root.join("sous/neuf.md")).unwrap(),
        "# Neuf\n"
    );
    // Création alors que le fichier existe : conflit, version actuelle.
    let e = c.call_raw(
        "files.write",
        json!({"id": id, "path": "sous/neuf.md", "content": "autre", "expected": null}),
    );
    assert_eq!(e["error"]["code"], -32021, "{e}");
    assert_eq!(
        e["error"]["data"]["version"]["sha256"],
        sha256_hex(b"# Neuf\n")
    );
    // Fichier supprimé depuis la lecture : conflit, version null.
    let e = c.call_raw(
        "files.write",
        json!({"id": id, "path": "sous/disparu.md", "content": "x",
               "expected": {"sha256": "0".repeat(64)}}),
    );
    assert_eq!(e["error"]["code"], -32021, "{e}");
    assert_eq!(e["error"]["data"], json!({"version": null}));

    // Refus (-32602), rien n'est écrit.
    let ro_before = std::fs::read(root.join("lecture-seule.txt")).unwrap();
    let any = json!({"sha256": "a".repeat(64)});
    for (path, content, expected) in [
        (".git/config", "x", any.clone()),
        (".GIT/neuf", "x", Value::Null),
        ("vers-git/config", "x", any.clone()),
        ("vers-git/neuf", "x", Value::Null),
        ("lien-dehors/dehors.txt", "x", any.clone()),
        ("lien-dehors/neuf.txt", "x", Value::Null),
        ("../dehors.txt", "x", any.clone()),
        ("/etc/passwd", "x", any.clone()),
        ("lien-final", "x", any.clone()),
        ("lien-dossier", "x", any.clone()),
        ("sous", "x", any.clone()),
        ("fifo", "x", any.clone()),
        ("binaire.dat", "x", json!({"sha256": sha256_hex(b"\0\x01")})),
        (
            "latin1.txt",
            "x",
            json!({"sha256": sha256_hex(b"caf\xe9\n")}),
        ),
        ("gros.txt", "x", any.clone()),
        (
            "lecture-seule.txt",
            "x",
            json!({"sha256": sha256_hex(b"ro\n")}),
        ),
        ("absent/neuf.txt", "x", Value::Null),
        ("a.txt/neuf.txt", "x", Value::Null),
        ("", "x", Value::Null),
        ("sous/binaire.txt", "a\0b", Value::Null),
        ("a.txt", "x", json!({"sha256": "pas-une-empreinte"})),
        ("a.txt", "x", json!("texte")),
    ] {
        if root_user && path == "lecture-seule.txt" {
            continue;
        }
        assert_eq!(
            c.call_err(
                "files.write",
                json!({"id": id, "path": path, "content": content, "expected": expected})
            ),
            -32602,
            "{path}"
        );
    }
    // La raison du refus est la bonne.
    for (path, expected, why) in [
        ("lien-final", any.clone(), "lien symbolique"),
        ("lien-dehors/dehors.txt", any.clone(), "sort de la racine"),
        ("vers-git/config", any.clone(), ".git"),
        ("sous", any.clone(), "pas un fichier ordinaire"),
        ("fifo", any.clone(), "pas un fichier ordinaire"),
        ("binaire.dat", any.clone(), "binaire"),
        ("latin1.txt", any.clone(), "UTF-8"),
        ("gros.txt", any.clone(), "trop gros"),
        ("lecture-seule.txt", any.clone(), "lecture seule"),
        ("absent/neuf.txt", Value::Null, "dossier parent"),
    ] {
        if root_user && why == "lecture seule" {
            continue;
        }
        let e = c.call_raw(
            "files.write",
            json!({"id": id, "path": path, "content": "x", "expected": expected}),
        );
        let m = e["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        assert!(m.contains(why), "{path} : {m}");
    }
    let big = "x".repeat(2 * 1024 * 1024 + 1);
    assert_eq!(
        c.call_err(
            "files.write",
            json!({"id": id, "path": "sous/gros.txt", "content": big, "expected": null})
        ),
        -32602
    );
    assert_eq!(
        c.call_err(
            "files.write",
            json!({"id": id, "path": "sous/x.txt", "content": "x"})
        ),
        -32602,
        "« expected » obligatoire"
    );
    assert_eq!(
        c.call_err(
            "files.write",
            json!({"id": id, "path": "sous/x.txt", "content": 3, "expected": null})
        ),
        -32602
    );
    assert_eq!(
        std::fs::read_to_string(root.join(".git/config")).unwrap(),
        "secret"
    );
    assert!(!root.join(".git/neuf").exists() && !root.join(".GIT/neuf").exists());
    assert_eq!(
        std::fs::read_to_string(dir.path().join("dehors.txt")).unwrap(),
        "secret"
    );
    assert!(!dir.path().join("neuf.txt").exists());
    assert!(
        std::fs::symlink_metadata(root.join("lien-final"))
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(
        std::fs::read(root.join("lecture-seule.txt")).unwrap(),
        ro_before
    );
    assert!(!root.join("sous/binaire.txt").exists());
    assert!(!root.join("sous/gros.txt").exists());
    // Aucun temporaire laissé, ni après un conflit ni après un refus.
    for d in [&root, &root.join("sous"), &root.join(".git")] {
        assert_eq!(temps(d), Vec::<String>::new(), "{}", d.display());
    }

    // Dossier en lecture seule : le temporaire ne peut pas y être créé.
    if !root_user {
        std::fs::create_dir(root.join("figé")).unwrap();
        std::fs::write(root.join("figé/f.txt"), "f\n").unwrap();
        std::fs::set_permissions(root.join("figé"), std::fs::Permissions::from_mode(0o555))
            .unwrap();
        let r = c.call("files.read", json!({"id": id, "path": "figé/f.txt"}));
        assert_eq!(
            (r["editable"].clone(), r["not_editable_reason"].clone()),
            (json!(false), json!("dossier en lecture seule"))
        );
        let e = c.call_raw(
            "files.write",
            json!({"id": id, "path": "figé/f.txt", "content": "x",
                   "expected": {"sha256": r["version"]["sha256"]}}),
        );
        let restore =
            std::fs::set_permissions(root.join("figé"), std::fs::Permissions::from_mode(0o755));
        assert_eq!(e["error"]["code"], -32602, "{e}");
        assert!(
            e["error"]["message"]
                .as_str()
                .unwrap()
                .contains("dossier en lecture seule"),
            "{e}"
        );
        restore.unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("figé/f.txt")).unwrap(),
            "f\n"
        );
        assert_eq!(temps(&root.join("figé")), Vec::<String>::new());
        // Dossier parent sans droit de traversée : refus, pas d'erreur interne.
        std::fs::set_permissions(root.join("figé"), std::fs::Permissions::from_mode(0o000))
            .unwrap();
        let e = c.call_raw(
            "files.write",
            json!({"id": id, "path": "figé/g.txt", "content": "x", "expected": null}),
        );
        std::fs::set_permissions(root.join("figé"), std::fs::Permissions::from_mode(0o755))
            .unwrap();
        assert_eq!(e["error"]["code"], -32602, "{e}");
        assert!(
            e["error"]["message"]
                .as_str()
                .unwrap()
                .contains("dossier parent inaccessible"),
            "{e}"
        );
    }

    // Session arrêtée : écriture permise tant que le dossier existe.
    c.call("sessions.stop", json!({"id": id}));
    c.wait_until("arrêt", |c| {
        c.last_session(id).is_some_and(|s| s["alive"] == false)
    });
    let r = c.call("files.read", json!({"id": id, "path": "a.txt"}));
    c.call(
        "files.write",
        json!({"id": id, "path": "a.txt", "content": "après l'arrêt",
               "expected": {"sha256": r["version"]["sha256"]}}),
    );
    assert_eq!(
        std::fs::read_to_string(root.join("a.txt")).unwrap(),
        "après l'arrêt"
    );
    assert_eq!(
        c.call_err(
            "files.write",
            json!({"id": Uuid::new_v4(), "path": "a.txt", "content": "x", "expected": null})
        ),
        -32001
    );
    drop(dir);
    assert_eq!(
        c.call_err(
            "files.write",
            json!({"id": id, "path": "a.txt", "content": "x", "expected": null})
        ),
        -32016
    );
}
