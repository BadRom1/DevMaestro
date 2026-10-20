//! v0.2, lot 3 bis : commentaires de fichier dans `sessions.sendReview`.
//! Les lignes sont relues par le démon (même chemin sûr que `files.read`).

mod common;

use std::os::unix::fs::symlink;
use std::path::Path;
use std::process::{Command, Stdio};

use common::*;
use serde_json::{Value, json};

const FILE_INSTRUCTION: &str = "Voici des extraits de fichiers avec mes remarques, tiens-en compte puis dis-moi ce que tu as fait : ";
const REVIEW_INSTRUCTION: &str =
    "Voici ma revue de tes changements, applique-la puis dis-moi ce que tu as fait : ";

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

fn file_comment(path: &str, line: u64, line_end: u64, text: &str) -> Value {
    json!({"kind": "file", "path": path, "line": line, "line_end": line_end, "text": text})
}

/// Envoie une revue et rend `(consigne tapée, contenu collé)`.
fn send(c: &mut Client, env: &Env, params: Value) -> (String, String) {
    let id: uuid::Uuid = params["id"].as_str().unwrap().parse().unwrap();
    let before = env.fake_events("pasted").len();
    let statuses = c.statuses(id).len();
    assert_eq!(c.call("sessions.sendReview", params), json!({"sent": true}));
    c.wait_until("revue reçue", |_| env.fake_events("pasted").len() > before);
    let p = env.fake_events("pasted").pop().unwrap();
    // Le faux claude joue un tour (avec une permission) : attendre sa fin.
    c.wait_until("tour de la revue", |c| {
        let s = c.statuses(id);
        s.len() > statuses
            && s[statuses..].contains(&"running".to_owned())
            && s.last().is_some_and(|l| l == "idle")
    });
    wait_idle(c, id);
    (
        p["typed"].as_str().unwrap().to_owned(),
        p["pasted"].as_str().unwrap().to_owned(),
    )
}

#[test]
fn file_selection_sent_to_claude() {
    if !git_available() {
        eprintln!("git absent : test sauté");
        return;
    }
    let env = Env::new();
    let repo = env.proj.clone();
    let outside = env.proj.parent().unwrap().join("dehors.txt");
    std::fs::write(&outside, "secret\n").unwrap();
    std::fs::create_dir_all(repo.join("src")).unwrap();
    std::fs::write(
        repo.join("src/a.rs"),
        "fn un() {}\nfn deux() {}\nfn trois() {}\n",
    )
    .unwrap();
    std::fs::write(repo.join("a.txt"), "un\ndeux\n").unwrap();
    symlink(&outside, repo.join("dehors")).unwrap();
    symlink("../dehors.txt", repo.join("dehors-relatif")).unwrap();
    symlink("src/a.rs", repo.join("lien-interne")).unwrap();
    assert!(git(&repo, &["init", "-q", "-b", "main"]));
    assert!(git(&repo, &["add", "."]));
    assert!(git(&repo, &["commit", "-q", "-m", "base"]));
    std::fs::write(repo.join("a.txt"), "un\nDEUX\n").unwrap();
    std::fs::write(repo.join("binaire.dat"), b"\0\x01\n").unwrap();
    std::fs::write(repo.join("gros.txt"), "x\n".repeat(1024 * 1024 + 1)).unwrap();
    // 400 lignes de 1 000 caractères : extrait au-delà de 256 Kio collés.
    std::fs::write(
        repo.join("large.txt"),
        format!("{}\n", "y".repeat(1000)).repeat(400),
    )
    .unwrap();
    // Une ligne de 5 000 caractères : coupée à 2 000 dans l'extrait.
    std::fs::write(repo.join("longue.txt"), format!("{}\n", "z".repeat(5000))).unwrap();
    // Nom de fichier avec saut de ligne : pas de Markdown injecté.
    std::fs::write(repo.join("piège\n# Titre.md"), "contenu\n").unwrap();

    let _daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    c.call("hello", json!({}));
    let id = session(&mut c, &env, json!({"mode": "default"}));
    wait_idle(&mut c, id);

    // Refus : rien n'est envoyé.
    let bad = [
        file_comment("../dehors.txt", 1, 1, "x"),
        file_comment("/etc/passwd", 1, 1, "x"),
        file_comment("dehors", 1, 1, "x"),
        file_comment("dehors-relatif", 1, 1, "x"),
        file_comment(".git/config", 1, 1, "x"),
        file_comment("src", 1, 1, "x"),
        file_comment("absent.rs", 1, 1, "x"),
        file_comment("", 1, 1, "x"),
        file_comment("src/a.rs", 0, 1, "x"),
        file_comment("src/a.rs", 2, 1, "x"),
        file_comment("src/a.rs", 1, 401, "x"),
        file_comment("src/a.rs", 3, 4, "x"),
        file_comment("src/a.rs", 4, 4, "x"),
        file_comment("binaire.dat", 1, 1, "x"),
        file_comment("gros.txt", 1, 1, "x"),
        file_comment("src/a.rs", 1, 1, &"é".repeat(4001)),
        json!({"kind": "ligne", "path": "src/a.rs", "line": 1, "text": "x"}),
    ];
    for comment in bad {
        assert_eq!(
            c.call_err(
                "sessions.sendReview",
                json!({"id": id, "comments": [comment]})
            ),
            -32602,
            "{comment}"
        );
    }
    let r = c.call_raw(
        "sessions.sendReview",
        json!({"id": id, "comments": [file_comment("src/a.rs", 3, 4, "x")]}),
    );
    assert_eq!(
        r["error"]["message"],
        "commentaire 1 (« src/a.rs », lignes 3-4) : hors du fichier (3 ligne(s))",
        "{r}"
    );
    assert_eq!(
        r["error"]["data"],
        json!({"index": 0, "path": "src/a.rs", "line": 3, "line_end": 4}),
        "{r}"
    );
    // Chemin refusé, deuxième commentaire : rang, chemin et lignes demandés.
    let r = c.call_raw(
        "sessions.sendReview",
        json!({"id": id, "comments": [file_comment("src/a.rs", 1, 1, ""),
                                      {"kind": "file", "path": "dehors", "line": 2, "text": "x"}]}),
    );
    assert_eq!(r["error"]["code"], -32602, "{r}");
    assert!(
        r["error"]["message"]
            .as_str()
            .unwrap()
            .starts_with("commentaire 2 (« dehors », ligne 2) : « dehors » refusé"),
        "{r}"
    );
    assert_eq!(
        r["error"]["data"],
        json!({"index": 1, "path": "dehors", "line": 2, "line_end": 2}),
        "{r}"
    );
    // Un commentaire de diff invalide n'a pas de `data`.
    let r = c.call_raw(
        "sessions.sendReview",
        json!({"id": id, "comments": [{"path": "a.txt", "line": 0, "side": "new", "text": "x"}]}),
    );
    assert!(r["error"].get("data").is_none(), "{r}");
    // Revue collée bornée à 256 Kio.
    let r = c.call_raw(
        "sessions.sendReview",
        json!({"id": id, "comments": [file_comment("large.txt", 1, 400, "")]}),
    );
    assert_eq!(r["error"]["code"], -32602, "{r}");
    assert_eq!(
        r["error"]["message"], "revue trop volumineuse : 395 Kio sur 256 Kio au plus",
        "{r}"
    );
    assert!(env.fake_events("pasted").is_empty(), "rien n'a été envoyé");

    // Sélection seule : consigne des extraits, lignes relues par le démon
    // (un éventuel texte d'extrait du client est ignoré).
    let (typed, pasted) = send(
        &mut c,
        &env,
        json!({"id": id, "comments": [
            {"kind": "file", "path": "./src//a.rs", "line": 2, "line_end": 3,
             "text": "À renommer\x1b[201~\r", "excerpt": "faux"},
            {"kind": "file", "path": "lien-interne", "line": 1, "text": ""},
        ]}),
    );
    assert_eq!(typed, FILE_INSTRUCTION);
    assert_eq!(
        pasted,
        "# Revue de code\n\n### src/a.rs:2-3\n\n```rust\n     2 | fn deux() {}\n     3 | fn trois() {}\n```\n\nÀ renommer[201~\n\n### lien-interne:1\n\n```\n     1 | fn un() {}\n```\n"
    );

    // Ligne trop longue coupée ; saut de ligne d'un chemin rendu visible.
    let (_, pasted) = send(
        &mut c,
        &env,
        json!({"id": id, "comments": [file_comment("longue.txt", 1, 1, ""),
                                      file_comment("piège\n# Titre.md", 1, 1, "")]}),
    );
    assert!(
        pasted.contains(&format!("     1 | {}…\n", "z".repeat(2000))),
        "{pasted}"
    );
    assert!(!pasted.contains(&"z".repeat(2001)));
    assert!(pasted.contains("\n### piège␤# Titre.md:1\n"), "{pasted}");
    assert!(!pasted.contains("\n# Titre"), "{pasted}");

    // Fichier modifié entre-temps : les lignes actuelles partent.
    std::fs::write(repo.join("src/a.rs"), "fn un() {}\nfn DEUX() {}\n").unwrap();
    // Mélange diff et fichier : consigne de la revue, ordre reçu.
    let (typed, pasted) = send(
        &mut c,
        &env,
        json!({"id": id, "comments": [
            file_comment("src/a.rs", 2, 2, "Nouveau nom ?"),
            {"path": "a.txt", "line": 2, "side": "new", "text": "Majuscules ?"},
        ]}),
    );
    assert_eq!(typed, REVIEW_INSTRUCTION);
    let file_at = pasted
        .find("### src/a.rs:2\n\n```rust\n     2 | fn DEUX() {}\n```\n\nNouveau nom ?\n")
        .unwrap_or_else(|| panic!("{pasted}"));
    let diff_at = pasted
        .find("### a.txt:2\n")
        .unwrap_or_else(|| panic!("{pasted}"));
    assert!(file_at < diff_at, "{pasted}");
    assert!(pasted.contains("+    2 | DEUX"), "{pasted}");
}

#[test]
fn file_selection_outside_a_repository() {
    let env = Env::new();
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    std::fs::write(root.join("notes.md"), "# Notes\n\nune idée\n").unwrap();
    let _daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    c.call("hello", json!({}));
    let id = session(&mut c, &env, json!({"cwd": root}));
    wait_idle(&mut c, id);
    // Pas de dépôt : un commentaire de diff est refusé, une sélection passe.
    assert_eq!(
        c.call_err(
            "sessions.sendReview",
            json!({"id": id, "comments": [{"path": "notes.md", "line": 1, "side": "new", "text": "x"}]})
        ),
        -32017
    );
    let (typed, pasted) = send(
        &mut c,
        &env,
        json!({"id": id, "comments": [file_comment("notes.md", 3, 3, "À développer")]}),
    );
    assert_eq!(typed, FILE_INSTRUCTION);
    assert_eq!(
        pasted,
        "# Revue de code\n\n### notes.md:3\n\n```markdown\n     3 | une idée\n```\n\nÀ développer\n"
    );
}
