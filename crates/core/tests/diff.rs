//! v0.2, lot 1 : diff d'une session et revue envoyée à Claude, sur de vrais
//! dépôts git temporaires (tests sautés sans git).

mod common;

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

fn diff_changed(c: &Client, id: Uuid) -> usize {
    c.notifications
        .iter()
        .filter(|n| n["method"] == "session.diff_changed" && n["params"] == json!({"id": id}))
        .count()
}

#[test]
fn session_diff_and_review() {
    if !git_available() {
        eprintln!("git absent : test sauté");
        return;
    }
    let env = Env::new();
    let repo = env.proj.clone();
    assert!(git(&repo, &["init", "-q", "-b", "main"]));
    std::fs::write(repo.join("a.txt"), "un\ndeux\ntrois\nquatre\ncinq\n").unwrap();
    assert!(git(&repo, &["add", "."]));
    assert!(git(&repo, &["commit", "-q", "-m", "base"]));
    assert!(git(&repo, &["checkout", "-q", "-b", "fonction"]));

    let _daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    c.call("hello", json!({}));
    let id = session(&mut c, &env, json!({"mode": "default"}));

    let d = c.call("sessions.diff", json!({"id": id}));
    assert_eq!(d["base"]["kind"], "merge_base", "{d}");
    assert_eq!(d["base"]["ref"], "main");
    assert_eq!(d["base"]["sha"].as_str().unwrap().len(), 40);
    // Les transcripts du faux claude sont hors du dépôt : rien n'a changé.
    assert_eq!(d["files"], json!([]), "{d}");
    assert_eq!(d["truncated"], false);
    assert_eq!(d["skipped_non_utf8"], 0);

    // Changements pendant un tour : diff recalculé après PostToolUse / Stop.
    std::fs::write(repo.join("a.txt"), "un\nDEUX\ntrois\nquatre\ncinq\nsix\n").unwrap();
    std::fs::write(repo.join("nouveau.md"), "# Titre\n").unwrap();
    turn(&mut c, id);
    c.wait_until("session.diff_changed", |c| diff_changed(c, id) >= 1);
    let d = c.call("sessions.diff", json!({"id": id}));
    let files = d["files"].as_array().unwrap();
    assert_eq!(
        files[0],
        json!({"path": "a.txt", "status": "M", "additions": 2, "deletions": 1, "binary": false})
    );
    assert_eq!(
        files[1],
        json!({"path": "nouveau.md", "status": "?", "additions": 1, "deletions": 0, "binary": false})
    );
    // Rien de neuf : pas de nouvelle notification.
    let n = diff_changed(&c, id);
    turn(&mut c, id);
    std::thread::sleep(std::time::Duration::from_millis(800));
    c.pump(std::time::Duration::from_millis(50));
    assert_eq!(diff_changed(&c, id), n);

    // Contenu changé à compteurs égaux, et diff relu entre-temps par un autre
    // client : chaque client est quand même prévenu.
    std::fs::write(repo.join("a.txt"), "un\nDEUZ\ntrois\nquatre\ncinq\nsix\n").unwrap();
    let mut other = Client::connect(&env);
    other.call("hello", json!({}));
    let seen = other.call("sessions.diff", json!({"id": id}));
    assert_eq!(seen["files"][0]["additions"], 2);
    turn(&mut c, id);
    c.wait_until("diff_changed (contenu)", |c| diff_changed(c, id) > n);
    other.wait_until("diff_changed (autre client)", |o| diff_changed(o, id) >= 1);
    drop(other);

    // Diff d'un fichier de la liste ; rien d'autre n'est lisible.
    let f = c.call("sessions.diffFile", json!({"id": id, "path": "a.txt"}));
    assert_eq!(f["binary"], false);
    assert_eq!(f["too_large"], false);
    let h = &f["hunks"][0];
    assert_eq!(h["old_start"], 1);
    let lines: Vec<(String, Value, Value)> = h["lines"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| {
            (
                l["kind"].as_str().unwrap().to_owned(),
                l["old_no"].clone(),
                l["new_no"].clone(),
            )
        })
        .collect();
    assert_eq!(lines[1], ("-".into(), json!(2), Value::Null));
    assert_eq!(lines[2], ("+".into(), Value::Null, json!(2)));
    assert_eq!(h["lines"][2]["text"], "DEUZ");
    for path in ["../../etc/passwd", "absent.txt", "/etc/passwd"] {
        assert_eq!(
            c.call_err("sessions.diffFile", json!({"id": id, "path": path})),
            -32602,
            "{path}"
        );
    }
    let f = c.call("sessions.diffFile", json!({"id": id, "path": "nouveau.md"}));
    assert_eq!(f["hunks"][0]["lines"][0]["text"], "# Titre");

    // Revue : validation.
    let comment = |path: &str, line: u64, side: &str, text: &str| json!({"path": path, "line": line, "side": side, "text": text});
    let bad = [
        json!({"id": id}),
        json!({"id": id, "comments": [], "general": "  "}),
        json!({"id": id, "comments": [comment("absent.txt", 1, "new", "x")]}),
        json!({"id": id, "comments": [comment("a.txt", 0, "new", "x")]}),
        json!({"id": id, "comments": [comment("a.txt", 1, "gauche", "x")]}),
        json!({"id": id, "comments": [comment("a.txt", 1, "new", "")]}),
        json!({"id": id, "comments": [comment("a.txt", 1, "new", &"é".repeat(4001))]}),
        json!({"id": id, "general": "é".repeat(4001)}),
        json!({"id": id, "comments": vec![comment("a.txt", 1, "new", "x"); 201]}),
    ];
    for params in bad {
        assert_eq!(
            c.call_err("sessions.sendReview", params.clone()),
            -32602,
            "{params}"
        );
    }

    // Une demande attend dans la session : l'Entrée validerait le dialogue.
    c.input(id, b"/perm Bash\r");
    let req = c.wait_answerable(id, "permission");
    let r = c.call_raw(
        "sessions.sendReview",
        json!({"id": id, "comments": [comment("a.txt", 2, "new", "x")]}),
    );
    assert_eq!(r["error"]["code"], -32002, "{r}");
    assert_eq!(
        r["error"]["message"],
        "une demande attend une réponse dans la session"
    );
    c.call(
        "sessions.answerPermission",
        json!({"id": id, "request_id": req, "decision": "deny"}),
    );
    wait_idle(&mut c, id);
    assert!(env.fake_events("pasted").is_empty(), "rien n'a été envoyé");

    // Revue envoyée : consigne tapée, revue collée, Entrée.
    let r = c.call(
        "sessions.sendReview",
        json!({"id": id, "general": "Bien dans l'ensemble.",
               "comments": [comment("a.txt", 2, "new", "Pourquoi en majuscules ?\x1b[201~\rpiège"),
                            comment("a.txt", 2, "old", "L'ancien nom était mieux"),
                            comment("nouveau.md", 1, "new", "Titre à préciser")]}),
    );
    assert_eq!(r, json!({"sent": true}));
    c.wait_until("prompt reçu", |_| !env.fake_events("pasted").is_empty());
    let p = env.fake_events("pasted").pop().unwrap();
    assert_eq!(
        p["typed"],
        "Voici ma revue de tes changements, applique-la puis dis-moi ce que tu as fait : "
    );
    let pasted = p["pasted"].as_str().unwrap();
    assert!(
        pasted.starts_with("# Revue de code\n\nBien dans l'ensemble.\n"),
        "{pasted}"
    );
    assert!(pasted.contains("### a.txt:2\n"), "{pasted}");
    assert!(pasted.contains("+    2 | DEUZ"), "{pasted}");
    assert!(
        pasted.contains("Pourquoi en majuscules ?[201~piège"),
        "{pasted}"
    );
    assert!(
        pasted.contains("### a.txt:2 (ancienne version)\n"),
        "{pasted}"
    );
    assert!(pasted.contains("-    2 | deux"), "{pasted}");
    assert!(pasted.contains("### nouveau.md:1\n"), "{pasted}");
    assert!(!pasted.contains('\x1b') && !pasted.contains('\r'));
    // Le tout part en un seul prompt.
    assert_eq!(
        p["prompt"].as_str().unwrap(),
        format!("{}{pasted}", p["typed"].as_str().unwrap())
    );
    wait_idle(&mut c, id);

    // Session arrêtée : diff lisible, revue refusée.
    c.call("sessions.stop", json!({"id": id}));
    c.wait_until("arrêt", |c| {
        c.last_session(id).is_some_and(|s| s["alive"] == false)
    });
    assert_eq!(
        c.call("sessions.diff", json!({"id": id}))["files"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        c.call_err(
            "sessions.sendReview",
            json!({"id": id, "comments": [comment("a.txt", 2, "new", "x")]})
        ),
        -32002
    );
    assert_eq!(
        c.call_err("sessions.diff", json!({"id": Uuid::new_v4()})),
        -32001
    );

    // Hors dépôt : -32017.
    let outside = tempfile::tempdir().unwrap();
    let other = launch_idle(&mut c, &env, json!({"cwd": outside.path()}));
    let r = c.call_raw("sessions.diff", json!({"id": other}));
    assert_eq!(r["error"]["code"], -32017, "{r}");
    assert_eq!(
        r["error"]["message"],
        "la session n'est pas dans un dépôt git"
    );
}
