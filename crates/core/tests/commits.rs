//! v0.3, lot 9 : historique des commits d'une session, diff d'un commit et
//! commentaire de commit dans la revue, sur de vrais dépôts git temporaires
//! (tests sautés sans git).

mod common;

use std::path::Path;
use std::process::{Command, Stdio};

use common::*;
use serde_json::{Value, json};

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

fn rev(dir: &Path, rev: &str) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["rev-parse", rev])
        .output()
        .unwrap();
    String::from_utf8(out.stdout).unwrap().trim().to_owned()
}

#[test]
fn session_commits_diff_and_review() {
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
    let base = rev(&repo, "HEAD");
    assert!(git(&repo, &["checkout", "-q", "-b", "fonction"]));
    std::fs::write(repo.join("a.txt"), "un\nDEUX\ntrois\nquatre\ncinq\nsix\n").unwrap();
    assert!(git(&repo, &["add", "."]));
    assert!(git(
        &repo,
        &[
            "commit",
            "-q",
            "--author=Zoé Ä <zoe@exemple.fr>",
            "-m",
            "Majuscules\n\nPourquoi : « lisibilité ».\nDeuxième ligne\t!\n"
        ]
    ));
    let first = rev(&repo, "HEAD");
    // Historique sans lien fusionné : sa racine entre dans la liste.
    assert!(git(&repo, &["checkout", "-q", "--orphan", "autre"]));
    assert!(git(&repo, &["rm", "-q", "-rf", "."]));
    std::fs::write(repo.join("o.txt"), "x\ny\n").unwrap();
    assert!(git(&repo, &["add", "."]));
    assert!(git(&repo, &["commit", "-q", "-m", "racine"]));
    let orphan = rev(&repo, "HEAD");
    assert!(git(&repo, &["checkout", "-q", "fonction"]));
    assert!(git(
        &repo,
        &[
            "merge",
            "-q",
            "--no-edit",
            "--allow-unrelated-histories",
            "autre"
        ]
    ));
    let merge = rev(&repo, "HEAD");

    let _daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    c.call("hello", json!({}));
    let id = session(&mut c, &env, json!({"mode": "default"}));

    // Liste : du plus récent au plus ancien, depuis la base du diff.
    let l = c.call("sessions.commits", json!({"id": id}));
    assert_eq!(l["base"]["ref"], "main", "{l}");
    assert_eq!(l["base"]["sha"], base);
    assert_eq!(l["head"], merge);
    assert_eq!(l["truncated"], false);
    assert_eq!(l["range"], "branch");
    assert_eq!(l["stats"], true);
    let commits = l["commits"].as_array().unwrap();
    let shas: Vec<&str> = commits.iter().map(|c| c["sha"].as_str().unwrap()).collect();
    assert_eq!(shas.len(), 3, "{l}");
    assert_eq!(shas[0], merge);
    assert!(shas.contains(&first.as_str()) && shas.contains(&orphan.as_str()));
    assert!(!shas.contains(&base.as_str()));
    let by = |sha: &str| commits.iter().find(|c| c["sha"] == sha).unwrap().clone();
    let f = by(&first);
    let keys: Vec<&str> = f.as_object().unwrap().keys().map(String::as_str).collect();
    let mut keys = keys;
    keys.sort();
    assert_eq!(
        keys,
        [
            "additions",
            "author",
            "body",
            "date",
            "deletions",
            "files",
            "parents",
            "sha",
            "subject"
        ]
    );
    assert_eq!(f["author"], "Zoé Ä", "pas d'adresse électronique");
    assert_eq!(f["subject"], "Majuscules");
    assert_eq!(f["body"], "Pourquoi : « lisibilité ».\nDeuxième ligne\t!");
    assert_eq!(f["parents"], json!([base]));
    assert_eq!(
        (&f["files"], &f["additions"], &f["deletions"]),
        (&json!(1), &json!(2), &json!(1))
    );
    let m = by(&merge);
    assert_eq!(m["parents"].as_array().unwrap().len(), 2);
    assert_eq!(
        (&m["files"], &m["additions"]),
        (&json!(1), &json!(2)),
        "{m}"
    );
    assert_eq!(by(&orphan)["parents"], json!([]));
    // Limite.
    let l = c.call("sessions.commits", json!({"id": id, "limit": 1}));
    assert_eq!(l["commits"].as_array().unwrap().len(), 1);
    assert_eq!(l["truncated"], true);
    for limit in [json!(0), json!(501), json!("2"), json!(-1)] {
        assert_eq!(
            c.call_err("sessions.commits", json!({"id": id, "limit": limit})),
            -32602,
            "{limit}"
        );
    }

    // Diff d'un commit : même forme que `sessions.diff`.
    let d = c.call("sessions.commitDiff", json!({"id": id, "sha": first}));
    assert_eq!(d["sha"], first);
    assert_eq!(
        d["base"],
        json!({"ref": &base[..7], "sha": base, "kind": "parent"})
    );
    assert_eq!(
        d["files"],
        json!([{"path": "a.txt", "status": "M", "additions": 2, "deletions": 1, "binary": false}])
    );
    assert_eq!(d["truncated"], false);
    assert_eq!(d["skipped_non_utf8"], 0);
    let r = c.call("sessions.commitDiff", json!({"id": id, "sha": orphan}));
    assert_eq!(r["base"]["kind"], "root", "{r}");
    assert_eq!(r["files"][0]["status"], "A");
    let r = c.call("sessions.commitDiff", json!({"id": id, "sha": merge}));
    assert_eq!(
        r["files"][0]["path"], "o.txt",
        "fusion contre le premier parent"
    );

    // Fichier d'un commit, indépendant de l'arbre de travail.
    std::fs::write(repo.join("a.txt"), "rien à voir\n").unwrap();
    let fd = c.call(
        "sessions.commitDiffFile",
        json!({"id": id, "sha": first, "path": "a.txt"}),
    );
    let lines: Vec<(String, Value, Value, String)> = fd["hunks"][0]["lines"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| {
            (
                l["kind"].as_str().unwrap().to_owned(),
                l["old_no"].clone(),
                l["new_no"].clone(),
                l["text"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    assert_eq!(lines[1], ("-".into(), json!(2), Value::Null, "deux".into()));
    assert_eq!(lines[2], ("+".into(), Value::Null, json!(2), "DEUX".into()));
    assert_eq!(fd["binary"], false);
    assert_eq!(fd["too_large"], false);

    // Refus : sha hors de l'historique (la base existe dans le dépôt),
    // abrégé, révision, chemin hors du commit.
    let short = &first[..7];
    for sha in [
        json!(base),
        json!(short),
        json!("HEAD"),
        json!(first.to_uppercase()),
        json!("0".repeat(40)),
        json!(null),
        json!(3),
    ] {
        assert_eq!(
            c.call_err("sessions.commitDiff", json!({"id": id, "sha": sha})),
            -32602,
            "{sha}"
        );
    }
    let r = c.call_raw("sessions.commitDiff", json!({"id": id, "sha": base}));
    assert_eq!(
        r["error"]["message"],
        format!(
            "le commit « {} » ne fait pas partie de l'historique de la session",
            &base[..7]
        )
    );
    for (sha, path) in [(&first, "o.txt"), (&first, "../a.txt"), (&base, "a.txt")] {
        assert_eq!(
            c.call_err(
                "sessions.commitDiffFile",
                json!({"id": id, "sha": sha, "path": path})
            ),
            -32602,
            "{path}"
        );
    }

    // Revue avec un commentaire de commit, un de diff et un refusé.
    let commit_comment = |sha: &str, path: &str, line: u64, side: &str, text: &str| json!({"kind": "commit", "sha": sha, "path": path, "line": line, "side": side, "text": text});
    for bad in [
        commit_comment(&base, "a.txt", 2, "new", "x"),
        commit_comment(short, "a.txt", 2, "new", "x"),
        commit_comment(&first, "o.txt", 1, "new", "x"),
        commit_comment(&first, "a.txt", 0, "new", "x"),
        commit_comment(&first, "a.txt", 2, "gauche", "x"),
        commit_comment(&first, "a.txt", 2, "new", " "),
    ] {
        assert_eq!(
            c.call_err("sessions.sendReview", json!({"id": id, "comments": [bad]})),
            -32602,
            "{bad}"
        );
    }
    let r = c.call_raw(
        "sessions.sendReview",
        json!({"id": id, "comments": [commit_comment(&base, "a.txt", 2, "new", "x")]}),
    );
    assert_eq!(
        r["error"]["message"],
        format!(
            "commentaire 1 : le commit « {} » ne fait pas partie de l'historique de la session",
            &base[..7]
        )
    );
    assert!(env.fake_events("pasted").is_empty(), "rien n'a été envoyé");
    let r = c.call(
        "sessions.sendReview",
        json!({"id": id, "comments": [
            commit_comment(&first, "a.txt", 2, "new", "Pourquoi en majuscules ?"),
            commit_comment(&first, "a.txt", 2, "old", "L'ancien était mieux"),
            {"path": "a.txt", "line": 1, "side": "new", "text": "Fichier réécrit"}
        ]}),
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
        pasted.contains(&format!("### {short} a.txt:2\n")),
        "{pasted}"
    );
    assert!(pasted.contains("+    2 | DEUX\n"), "{pasted}");
    assert!(pasted.contains("Pourquoi en majuscules ?"), "{pasted}");
    assert!(
        pasted.contains(&format!("### {short} a.txt:2 (ancienne version)\n")),
        "{pasted}"
    );
    assert!(pasted.contains("-    2 | deux\n"), "{pasted}");
    assert!(pasted.contains("\n### a.txt:1\n"), "{pasted}");
    wait_idle(&mut c, id);

    // Hors dépôt : -32017.
    let outside = tempfile::tempdir().unwrap();
    let other = launch_idle(&mut c, &env, json!({"cwd": outside.path()}));
    assert_eq!(c.call_err("sessions.commits", json!({"id": other})), -32017);
    assert_eq!(
        c.call_err("sessions.commitDiff", json!({"id": other, "sha": first})),
        -32017
    );
}

#[test]
fn trunk_based_session_sees_recent_commits() {
    if !git_available() {
        eprintln!("git absent : test sauté");
        return;
    }
    let env = Env::new();
    let repo = env.proj.clone();
    assert!(git(&repo, &["init", "-q", "-b", "main"]));
    let _daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    c.call("hello", json!({}));
    let id = launch_idle(&mut c, &env, json!({}));
    // Avant le premier commit : rien.
    let l = c.call("sessions.commits", json!({"id": id}));
    assert_eq!(l["head"], Value::Null, "{l}");
    assert_eq!(l["commits"], json!([]));
    assert_eq!(l["truncated"], false);
    assert_eq!(l["range"], "recent");
    // Commits directs sur main, tous poussés (origin/main = HEAD).
    for (i, text) in ["a\n", "a\nb\n", "a\nb\nc\n"].iter().enumerate() {
        std::fs::write(repo.join("a.txt"), text).unwrap();
        assert!(git(&repo, &["add", "."]));
        assert!(git(&repo, &["commit", "-q", "-m", &format!("c{i}")]));
    }
    let pushed = |repo: &Path| {
        assert!(git(
            repo,
            &["update-ref", "refs/remotes/origin/main", "HEAD"]
        ));
        assert!(git(
            repo,
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/main"
            ]
        ));
    };
    pushed(&repo);
    let head = rev(&repo, "HEAD");
    let l = c.call("sessions.commits", json!({"id": id}));
    assert_eq!(l["range"], "recent", "{l}");
    assert_eq!(l["base"]["ref"], "origin/main");
    assert_eq!(l["base"]["sha"], head);
    let subjects: Vec<&str> = l["commits"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["subject"].as_str().unwrap())
        .collect();
    assert_eq!(subjects, ["c2", "c1", "c0"]);
    assert_eq!(l["commits"][0]["additions"], 1);
    assert_eq!(l["commits"][2]["parents"], json!([]));
    let l = c.call("sessions.commits", json!({"id": id, "limit": 2}));
    assert_eq!(
        (l["commits"].as_array().unwrap().len(), &l["truncated"]),
        (2, &json!(true))
    );
    // Un commit récent (ici la racine) est accepté, même après 2 s.
    let root = rev(&repo, "HEAD~2");
    std::thread::sleep(std::time::Duration::from_millis(2100));
    let d = c.call("sessions.commitDiff", json!({"id": id, "sha": root}));
    assert_eq!(d["base"]["kind"], "root", "{d}");
    let f = c.call(
        "sessions.commitDiffFile",
        json!({"id": id, "sha": head, "path": "a.txt"}),
    );
    assert_eq!(f["hunks"][0]["lines"][2]["text"], "c", "{f}");
    let r = c.call(
        "sessions.sendReview",
        json!({"id": id, "comments": [{"kind": "commit", "sha": head, "path": "a.txt",
                                       "line": 3, "side": "new", "text": "Et d ?"}]}),
    );
    assert_eq!(r, json!({"sent": true}));
    c.wait_until("prompt reçu", |_| !env.fake_events("pasted").is_empty());
    let pasted = env.fake_events("pasted").pop().unwrap()["pasted"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(
        pasted.contains(&format!("### {} a.txt:3\n", &head[..7])),
        "{pasted}"
    );
    wait_idle(&mut c, id);

    // Forcé sur la branche : rien, et un sha récent n'est plus accepté
    // (la validation reprend la plage demandée).
    let l = c.call("sessions.commits", json!({"id": id, "range": "branch"}));
    assert_eq!(
        (l["range"].as_str(), &l["commits"]),
        (Some("branch"), &json!([]))
    );
    std::thread::sleep(std::time::Duration::from_millis(2100));
    assert_eq!(
        c.call_err("sessions.commitDiff", json!({"id": id, "sha": head})),
        -32602
    );
    for bad in [json!("tout"), json!(1)] {
        assert_eq!(
            c.call_err("sessions.commits", json!({"id": id, "range": bad})),
            -32602
        );
    }

    // Un commit local pas encore poussé : mode branche, lui seul.
    std::fs::write(repo.join("a.txt"), "a\nb\nc\nd\n").unwrap();
    assert!(git(&repo, &["commit", "-q", "-am", "local"]));
    let l = c.call("sessions.commits", json!({"id": id}));
    assert_eq!(l["range"], "branch", "{l}");
    assert_eq!(l["commits"].as_array().unwrap().len(), 1);
    assert_eq!(l["commits"][0]["subject"], "local");
    // Forcé en récent : toute l'histoire.
    let l = c.call("sessions.commits", json!({"id": id, "range": "recent"}));
    assert_eq!(l["commits"].as_array().unwrap().len(), 4);
    // Poussé : de nouveau les récents.
    pushed(&repo);
    let l = c.call("sessions.commits", json!({"id": id}));
    assert_eq!(l["range"], "recent");
    assert_eq!(l["commits"][0]["subject"], "local");
}
