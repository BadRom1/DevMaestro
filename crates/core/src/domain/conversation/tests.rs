//! Normalisation rejouée sur les transcripts réels du prototype n° 5
//! (`spikes/05-vue-conversation/fixtures/transcripts/`, Claude Code 2.1.304).

use super::*;

const FIXTURES: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../spikes/05-vue-conversation/fixtures/transcripts"
);
/// Session A (puis B, reprise par `--resume`, à la suite du même fichier).
const MAIN_A: &str = "f413d189-39c7-41ff-aeb1-4df75e059737";
/// Après le `/clear` de A.
const CLEARED: &str = "f80a65b3-d635-4c00-9c9f-ef2601369397";
/// Sous-agent Explore de A.
const AGENT: &str = "a413854c8aebbc6cf";
const AGENT_TOOL_USE: &str = "toolu_01R9pD6ezpLoj1Vi2Gj8vsP3";

fn lines(rel: &str) -> Vec<String> {
    std::fs::read_to_string(format!("{FIXTURES}/{rel}"))
        .unwrap()
        .lines()
        .map(str::to_owned)
        .collect()
}

/// Donne toutes les lignes d'un fichier à une nouvelle source.
fn feed_all(c: &mut Conversation, source: u32, lines: &[String]) {
    let mut offset = 0u64;
    for l in lines {
        c.feed(source, offset, l);
        offset += l.len() as u64 + 1;
    }
}

fn main_a() -> Conversation {
    let mut c = Conversation::default();
    let seg = c.start_segment(MAIN_A, "start", None);
    let src = c.add_source(None, seg);
    feed_all(&mut c, src, &lines(&format!("{MAIN_A}.jsonl")));
    c
}

fn kinds(c: &Conversation, agent: Option<&str>) -> Vec<&'static str> {
    c.entries(agent).iter().map(|e| e.body.kind()).collect()
}

fn find(c: &Conversation, pred: impl Fn(&Body) -> bool) -> &Entry {
    c.entries(None)
        .iter()
        .find(|e| pred(&e.body))
        .expect("entrée attendue")
}

fn tool<'a>(c: &'a Conversation, name: &str) -> &'a Entry {
    find(c, |b| matches!(b, Body::Tool { name: n, .. } if n == name))
}

#[test]
fn replays_the_main_transcript_in_order() {
    let c = main_a();
    assert_eq!(
        kinds(&c, None),
        [
            // Texte long, Read, résumé.
            "prompt",
            "thinking",
            "text",
            "tool",
            "thinking",
            "text",
            // Read + Edit + Bash.
            "prompt",
            "tool",
            "tool",
            "tool",
            "text",
            // Question.
            "prompt",
            "thinking",
            "tool",
            "question",
            "text",
            // Collage court (en ligne), collage long (extrait).
            "prompt",
            "text",
            "prompt",
            "text",
            // Sous-agent en arrière-plan, puis sa notification de fin.
            "prompt",
            "thinking",
            "tool",
            "subagent",
            "thinking",
            "text",
            "notification",
            "thinking",
            "text",
            // `/compact` : séparateur, commande (la ligne nue est ignorée).
            "compaction",
            "command",
            "prompt",
            "thinking",
            "text",
            // Session B (`--resume`), à la suite du même fichier.
            "prompt",
            "thinking",
            "text",
            "tool",
            "text",
        ]
    );
    assert_eq!(c.invalid_lines(None), 0);
    // Une seule entrée par `uid`, segment et agent posés.
    let mut uids: Vec<&str> = c.entries(None).iter().map(|e| e.uid.as_str()).collect();
    uids.sort();
    uids.dedup();
    assert_eq!(uids.len(), c.entries(None).len());
    assert!(
        c.entries(None)
            .iter()
            .all(|e| e.segment == 0 && e.agent_id.is_none())
    );
    assert!(c.entries(None).iter().all(|e| e.ts.is_some()));
}

#[test]
fn prompts_keep_their_source_and_extract_pastes() {
    let c = main_a();
    let prompts: Vec<&Entry> = c
        .entries(None)
        .iter()
        .filter(|e| matches!(e.body, Body::Prompt { .. }))
        .collect();
    let Body::Prompt {
        text,
        source,
        pasted,
        prompt_id,
    } = &prompts[0].body
    else {
        unreachable!()
    };
    assert_eq!(
        prompt_id.as_deref(),
        Some("bc0e07b7-2b07-46a1-ae87-8eb16d92d476")
    );
    assert!(text.starts_with("Sans utiliser d'outil d'abord"));
    assert_eq!(source, "typed");
    assert!(pasted.is_empty());
    // Collage court : en ligne dans le prompt.
    let Body::Prompt { text, pasted, .. } = &prompts[3].body else {
        unreachable!()
    };
    assert!(text.contains("pomme\npoire\nprune"));
    assert!(pasted.is_empty());
    // Collage long : extrait, remplacé par un repère.
    let Body::Prompt { text, pasted, .. } = &prompts[4].body else {
        unreachable!()
    };
    assert_eq!(
        text,
        "Même consigne pour ce long texte collé : \n\n[collage d880]\n"
    );
    assert_eq!(pasted.len(), 1);
    assert_eq!(pasted[0].id, "d880");
    assert_eq!(pasted[0].text.lines().count(), 15);
    assert!(pasted[0].text.starts_with("ligne numéro 1 du collage long"));
    assert!(pasted[0].text.ends_with("ligne numéro 15 du collage long"));
}

#[test]
fn tools_are_paired_with_their_results() {
    let c = main_a();
    let read = tool(&c, "Read");
    let Body::Tool {
        tool_use_id,
        summary,
        input,
        result: Some(r),
        ..
    } = &read.body
    else {
        panic!("Read sans résultat")
    };
    assert_eq!(tool_use_id, "toolu_01VenuCZRa3NzUpmAvQq9LV3");
    assert_eq!(summary, "/tmp/scratchpad/p5test/calcul.py");
    assert_eq!(input["file_path"], "/tmp/scratchpad/p5test/calcul.py");
    assert_eq!(r.status, "ok");
    assert!(r.text.contains("def addition(a, b):"));
    assert!(r.patch.is_none());
    // L'outil et son résultat : deux lignes pour une entrée.
    assert_eq!(read.lines.len(), 2);

    let Body::Tool {
        result: Some(r), ..
    } = &tool(&c, "Edit").body
    else {
        panic!("Edit sans résultat")
    };
    let patch = r.patch.as_ref().expect("structuredPatch");
    assert_eq!(patch[0]["header"], "@@ -4,3 +4,7 @@");
    assert_eq!(patch[0]["new_start"], 4);
    assert_eq!(
        patch[0]["lines"][0],
        json!({"kind": " ", "old_no": 4, "new_no": 4, "text": ""})
    );
    assert_eq!(
        patch[0]["lines"][6],
        json!({"kind": "+", "old_no": null, "new_no": 10, "text": "    return a * b"})
    );

    let Body::Tool {
        summary,
        result: Some(r),
        ..
    } = &tool(&c, "Bash").body
    else {
        panic!("Bash sans résultat")
    };
    assert_eq!(
        summary,
        "python3 -c 'import calcul; print(calcul.multiplication(6, 7))'"
    );
    assert_eq!((r.status, r.text.as_str()), ("ok", "42"));
    // `tool_reference` : le nom de l'outil trouvé.
    let Body::Tool {
        result: Some(r), ..
    } = &tool(&c, "ToolSearch").body
    else {
        panic!("ToolSearch sans résultat")
    };
    assert_eq!(r.text, "AskUserQuestion");
}

#[test]
fn question_carries_the_chosen_answer() {
    let c = main_a();
    let q = find(&c, |b| matches!(b, Body::Question { .. }));
    let Body::Question {
        tool_use_id,
        questions,
        answers,
    } = &q.body
    else {
        unreachable!()
    };
    assert_eq!(tool_use_id, "toolu_011NCYfJe8SyGn8gnfaA6WXx");
    assert_eq!(questions[0]["header"], "Boisson");
    assert_eq!(
        answers.as_ref().unwrap()["Préfères-tu le thé ou le café ?"],
        "Café"
    );
}

#[test]
fn subagent_is_linked_and_finished_by_its_notification() {
    let c = main_a();
    let a = find(&c, |b| matches!(b, Body::Subagent { .. }));
    assert_eq!(
        a.body,
        Body::Subagent {
            tool_use_id: AGENT_TOOL_USE.into(),
            agent_id: Some(AGENT.into()),
            agent_type: Some("Explore".into()),
            description: Some("Count .txt files in docs".into()),
            // `async_launched`, puis la `task-notification` `completed`.
            status: "done",
        }
    );
    let n = find(&c, |b| matches!(b, Body::Notification { .. }));
    assert_eq!(
        n.body,
        Body::Notification {
            task_id: Some(AGENT.into()),
            status: Some("completed".into()),
            summary: Some("Agent \"Count .txt files in docs\" finished".into()),
        }
    );
}

#[test]
fn subagent_status_follows_the_tool_result_then_the_notification() {
    let all = lines(&format!("{MAIN_A}.jsonl"));
    let mut c = Conversation::default();
    let seg = c.start_segment(MAIN_A, "start", None);
    let src = c.add_source(None, seg);
    // Jusqu'au résultat `async_launched` (ligne 118) : le sous-agent tourne.
    feed_all(&mut c, src, &all[..119]);
    let status = |c: &Conversation| match &find(c, |b| matches!(b, Body::Subagent { .. })).body {
        Body::Subagent { status, .. } => *status,
        _ => unreachable!(),
    };
    assert_eq!(status(&c), "running");
    let before = c.rev();
    for (i, l) in all[119..].iter().enumerate() {
        c.feed(src, 1_000_000 + i as u64, l);
    }
    assert_eq!(status(&c), "done");
    assert!(
        c.changed_since(before)
            .iter()
            .any(|e| matches!(e.body, Body::Subagent { .. }))
    );
}

#[test]
fn meta_json_links_the_agent_before_its_result() {
    let all = lines(&format!("{MAIN_A}.jsonl"));
    let mut c = Conversation::default();
    let seg = c.start_segment(MAIN_A, "start", None);
    let src = c.add_source(None, seg);
    // Le `.meta.json` lu avant même l'appel : gardé, puis appliqué.
    c.link_agent(AGENT_TOOL_USE, AGENT);
    feed_all(&mut c, src, &all[..118]);
    let a = find(&c, |b| matches!(b, Body::Subagent { .. }));
    assert!(
        matches!(&a.body, Body::Subagent { agent_id: Some(id), status: "running", .. } if id == AGENT)
    );
    // Après l'appel : le lien met l'entrée à jour.
    let mut c = Conversation::default();
    let seg = c.start_segment(MAIN_A, "start", None);
    let src = c.add_source(None, seg);
    feed_all(&mut c, src, &all[..118]);
    let rev = c.rev();
    c.link_agent(AGENT_TOOL_USE, AGENT);
    let changed = c.changed_since(rev);
    assert_eq!(changed.len(), 1);
    assert!(matches!(&changed[0].body, Body::Subagent { agent_id: Some(id), .. } if id == AGENT));
}

#[test]
fn subagent_file_is_read_apart_with_its_agent_id() {
    let mut c = main_a();
    let seg = 0;
    let src = c.add_source(Some(AGENT.into()), seg);
    feed_all(
        &mut c,
        src,
        &lines(&format!("{MAIN_A}/subagents/agent-{AGENT}.jsonl")),
    );
    assert_eq!(
        kinds(&c, Some(AGENT)),
        [
            "prompt", "tool", "thinking", "text", "tool", "thinking", "text"
        ]
    );
    let entries = c.entries(Some(AGENT));
    assert!(entries.iter().all(|e| e.agent_id.as_deref() == Some(AGENT)));
    let Body::Prompt { source, text, .. } = &entries[0].body else {
        unreachable!()
    };
    assert_eq!(source, "system");
    assert!(text.starts_with("Using the Glob tool"));
    assert!(
        matches!(&entries[1].body, Body::Tool { name, summary, result: Some(r), .. }
        if name == "Glob" && summary == "**/*.txt (/tmp/scratchpad/p5test/docs)" && r.text == "docs/b.txt\ndocs/a.txt")
    );
    // La liste principale n'a pas bougé.
    assert_eq!(c.invalid_lines(Some(AGENT)), 0);
    assert!(c.page(Some(AGENT), None, 2).unwrap().1);
}

#[test]
fn compaction_gets_its_summary_and_command_its_output() {
    let c = main_a();
    let comp = find(&c, |b| matches!(b, Body::Compaction { .. }));
    assert_eq!(
        comp.body,
        Body::Compaction {
            trigger: Some("manual".into()),
            pre_tokens: Some(49233),
            post_tokens: Some(18235),
            summary: Some("<résumé de compaction retiré>".into()),
        }
    );
    let cmd = find(&c, |b| matches!(b, Body::Command { .. }));
    let Body::Command { name, args, output } = &cmd.body else {
        unreachable!()
    };
    assert_eq!((name.as_str(), args.as_str()), ("/compact", ""));
    // Codes ANSI retirés.
    assert!(output.starts_with("Compacted (ctrl+o to see full summary)\nPreCompact"));
    assert!(!output.contains('\x1b'));
}

#[test]
fn clear_opens_a_new_segment() {
    let mut c = main_a();
    let rev = c.rev();
    let seg = c.start_segment(CLEARED, "clear", Some("2026-10-20T15:46:20Z".into()));
    assert_eq!(seg, 1);
    let src = c.add_source(None, seg);
    feed_all(&mut c, src, &lines(&format!("{CLEARED}.jsonl")));
    let new: Vec<&Entry> = c.entries(None).iter().filter(|e| e.segment == 1).collect();
    assert_eq!(
        new.iter().map(|e| e.body.kind()).collect::<Vec<_>>(),
        ["command", "prompt", "text"]
    );
    // `/clear` : commande complétée par `system/local_command`.
    assert!(
        matches!(&new[0].body, Body::Command { name, output, .. } if name == "/clear" && output.is_empty())
    );
    assert_eq!(new[0].lines.len(), 2);
    assert!(matches!(&new[2].body, Body::Text { markdown } if markdown == "Bonjour !"));
    let segs: Vec<&Segment> = c.segments_since(rev).collect();
    assert_eq!(segs.len(), 1);
    assert_eq!(segs[0].claude_session_id, CLEARED);
    assert_eq!(segs[0].reason, "clear");
}

#[test]
fn text_blocks_of_one_message_are_grouped_and_upserted() {
    let mut c = Conversation::default();
    let seg = c.start_segment("s", "start", None);
    let src = c.add_source(None, seg);
    let text = |uuid: &str, msg: &str, t: &str| {
        json!({"type": "assistant", "uuid": uuid, "timestamp": "2026-10-20T10:00:00Z",
               "message": {"id": msg, "content": [{"type": "text", "text": t}]}})
        .to_string()
    };
    let think = |uuid: &str, msg: &str| {
        json!({"type": "assistant", "uuid": uuid,
               "message": {"id": msg, "content": [{"type": "thinking", "thinking": "", "signature": "x"}]}})
        .to_string()
    };
    let tool_use = |uuid: &str, msg: &str, id: &str| {
        json!({"type": "assistant", "uuid": uuid,
               "message": {"id": msg, "content": [{"type": "tool_use", "id": id, "name": "Bash", "input": {"command": "ls\n-la"}}]}})
        .to_string()
    };
    c.feed(src, 0, &think("u0", "m1"));
    c.feed(src, 10, &think("u1", "m1")); // Second repère du même message : ignoré.
    c.feed(src, 20, &text("u2", "m1", "Début"));
    let rev = c.rev();
    // Un bloc du même message arrive plus tard : même entrée, nouvelle révision.
    c.feed(src, 30, &text("u3", "m1", "suite"));
    assert_eq!(kinds(&c, None), ["thinking", "text"]);
    let changed = c.changed_since(rev);
    assert_eq!(changed.len(), 1);
    assert_eq!(changed[0].uid, "u2");
    assert_eq!(
        changed[0].body,
        Body::Text {
            markdown: "Début\n\nsuite".into()
        }
    );
    assert_eq!(changed[0].lines.len(), 2);
    // Un outil s'intercale : le texte suivant du même message est une autre entrée.
    c.feed(src, 40, &tool_use("u4", "m1", "t1"));
    c.feed(src, 50, &text("u5", "m1", "après l'outil"));
    c.feed(src, 60, &text("u6", "m2", "autre message"));
    assert_eq!(
        kinds(&c, None),
        ["thinking", "text", "tool", "text", "text"]
    );
    assert!(
        matches!(&c.entries(None)[2].body, Body::Tool { summary, result: None, .. } if summary == "ls -la")
    );
    // La même ligne relue ne crée rien.
    c.feed(src, 60, &text("u6", "m2", "autre message"));
    assert_eq!(c.entries(None).len(), 5);
    // Résultat d'outil : mise à jour de l'entrée de l'outil.
    let rev = c.rev();
    let result = json!({"type": "user", "uuid": "u7", "message": {"content": [
        {"type": "tool_result", "tool_use_id": "t1", "content": "Exit code 2", "is_error": true}]}});
    c.feed(src, 70, &result.to_string());
    let changed = c.changed_since(rev);
    assert_eq!(changed.len(), 1);
    assert!(
        matches!(&changed[0].body, Body::Tool { result: Some(r), .. } if r.status == "error" && r.text == "Exit code 2")
    );
}

#[test]
fn early_results_wait_for_their_call() {
    let mut c = Conversation::default();
    let seg = c.start_segment("s", "start", None);
    let src = c.add_source(None, seg);
    let result = json!({"type": "user", "uuid": "r", "toolUseResult": {"interrupted": true},
        "message": {"content": [{"type": "tool_result", "tool_use_id": "t9", "content": "x"}]}});
    c.feed(src, 0, &result.to_string());
    assert!(c.entries(None).is_empty());
    let call = json!({"type": "assistant", "uuid": "c", "message": {"id": "m",
        "content": [{"type": "tool_use", "id": "t9", "name": "Bash", "input": {}}]}});
    c.feed(src, 10, &call.to_string());
    assert!(
        matches!(&c.entries(None)[0].body, Body::Tool { result: Some(r), .. } if r.status == "interrupted")
    );
}

#[test]
fn housekeeping_is_ignored_and_unknowns_fall_back() {
    let mut c = Conversation::default();
    let seg = c.start_segment("s", "start", None);
    let src = c.add_source(None, seg);
    for (i, l) in [
        r#"{"type":"mode","mode":"normal"}"#,
        r#"{"type":"attachment","uuid":"a1","attachment":{"type":"skill_listing"}}"#,
        r#"{"type":"system","subtype":"turn_duration","uuid":"s1","durationMs":3}"#,
        r#"{"type":"user","uuid":"m1","isMeta":true,"message":{"content":"<local-command-caveat>x</local-command-caveat>"}}"#,
        r#"{"type":"user","uuid":"m2","message":{"content":"<system-reminder>r</system-reminder>"}}"#,
        r#"{"type":"user","uuid":"m3","isSidechain":true,"message":{"content":"ancien sous-agent"}}"#,
        r#"{"type":"queue-operation","operation":"enqueue","content":"<task-notification>"}"#,
        "pas du json",
        "[1, 2]",
        "",
        r#"{"type":"nouveau-type","uuid":"n1","subtype":"x"}"#,
        r#"{"type":"system","subtype":"nouveau_sous_type","uuid":"n2"}"#,
        r#"{"type":"assistant","uuid":"n3","message":{"id":"m","content":[{"type":"bloc_inconnu"}]}}"#,
        r#"{"type":"system","subtype":"api_error","uuid":"e1","content":"Overloaded"}"#,
        r#"{"type":"assistant","uuid":"e2","isApiErrorMessage":true,"message":{"content":[{"type":"text","text":"API Error: 500"}]}}"#,
        r#"{"type":"user","uuid":"i1","message":{"content":[{"type":"text","text":"[Request interrupted by user]"}]}}"#,
    ]
    .iter()
    .enumerate()
    {
        c.feed(src, i as u64, l);
    }
    assert_eq!(c.invalid_lines(None), 2);
    let bodies: Vec<&Body> = c.entries(None).iter().map(|e| &e.body).collect();
    assert_eq!(
        bodies,
        [
            &Body::Unknown {
                kind: "nouveau-type".into(),
                subtype: Some("x".into())
            },
            &Body::Unknown {
                kind: "system".into(),
                subtype: Some("nouveau_sous_type".into())
            },
            &Body::Unknown {
                kind: "assistant".into(),
                subtype: Some("bloc_inconnu".into())
            },
            &Body::Error {
                message: "Overloaded".into()
            },
            &Body::Error {
                message: "API Error: 500".into()
            },
            &Body::Error {
                message: "[Request interrupted by user]".into()
            },
        ]
    );
    // Ligne trop longue (lue par l'adaptateur) : comptée.
    c.count_invalid(src);
    assert_eq!(c.invalid_lines(None), 3);
}

#[test]
fn bounds_truncate_and_full_text_replays_the_lines() {
    let mut c = Conversation::default();
    let seg = c.start_segment("s", "start", None);
    let src = c.add_source(None, seg);
    let long = "é".repeat(MAX_TEXT_BYTES); // 2 octets par caractère.
    let text_line = json!({"type": "assistant", "uuid": "t", "message": {"id": "m",
        "content": [{"type": "text", "text": long}]}})
    .to_string();
    let big_input = "x".repeat(MAX_TOOL_BYTES + 10);
    let call = json!({"type": "assistant", "uuid": "c", "message": {"id": "m2",
        "content": [{"type": "tool_use", "id": "t1", "name": "Write",
                     "input": {"file_path": "/a", "content": big_input}}]}})
    .to_string();
    let big_result = "r".repeat(MAX_TOOL_BYTES * 2);
    let result = json!({"type": "user", "uuid": "r", "message": {"content": [
        {"type": "tool_result", "tool_use_id": "t1", "content": big_result}]}})
    .to_string();
    let pasted = format!(
        "voir :\n<pasted_content id=\"p1\">\n{}\n</pasted_content id=\"p1\">",
        "z".repeat(MAX_TEXT_BYTES)
    );
    let prompt = json!({"type": "user", "uuid": "p", "promptSource": "queued",
        "message": {"content": pasted}})
    .to_string();
    let all = [text_line, call, result, prompt];
    for (i, l) in all.iter().enumerate() {
        c.feed(src, i as u64, l);
    }
    let text = c.entry("t").unwrap();
    assert!(text.truncated);
    assert!(
        matches!(&text.body, Body::Text { markdown } if markdown.len() <= MAX_TEXT_BYTES && markdown.len() >= MAX_TEXT_BYTES - 1)
    );
    let t = c.entry("c").unwrap();
    let Body::Tool {
        summary,
        input,
        input_truncated,
        result: Some(r),
        ..
    } = &t.body
    else {
        panic!("Write attendu")
    };
    assert_eq!(summary, "/a");
    assert!(*input_truncated);
    assert!(input.as_str().unwrap().len() <= MAX_TOOL_BYTES);
    assert!(r.truncated);
    assert_eq!(r.text.len(), MAX_TOOL_BYTES);
    let p = c.entry("p").unwrap();
    assert!(p.truncated);
    assert!(
        matches!(&p.body, Body::Prompt { source, pasted, .. } if source == "queued" && pasted[0].text.len() < MAX_TEXT_BYTES)
    );

    // Lecture entière : on rejoue les lignes de l'entrée.
    let replay = |e: &Entry| -> Vec<String> {
        e.lines
            .iter()
            .map(|l| all[l.offset as usize].clone())
            .collect()
    };
    let (full, truncated) = full_text("t", None, &replay(text), Part::Text).unwrap();
    assert_eq!((full, truncated), (long.clone(), false));
    let (full, _) = full_text("c", None, &replay(t), Part::Result).unwrap();
    assert_eq!(full.len(), MAX_TOOL_BYTES * 2);
    let (full, _) = full_text("c", None, &replay(t), Part::Input).unwrap();
    assert!(full.contains(&big_input));
    let (full, _) = full_text("p", None, &replay(p), Part::Text).unwrap();
    assert!(full.starts_with("voir :\nzzz"));
    assert_eq!(full.len(), "voir :\n".len() + MAX_TEXT_BYTES);
    assert!(full_text("t", None, &replay(text), Part::Result).is_none());
    assert!(full_text("absent", None, &replay(text), Part::Text).is_none());
}

#[test]
fn pages_go_backwards_from_a_cursor() {
    let c = main_a();
    let all = c.entries(None);
    let (page, more) = c.page(None, None, 5).unwrap();
    assert!(more);
    assert_eq!(page, &all[all.len() - 5..]);
    let (older, more) = c.page(None, Some(&page[0].uid), 1000).unwrap();
    assert!(!more);
    assert_eq!(older.len(), all.len() - 5);
    assert!(c.page(None, Some("inconnu"), 5).is_none());
    // Un curseur d'une autre liste est refusé.
    assert!(c.page(Some(AGENT), Some(&page[0].uid), 5).is_none());
}

#[test]
fn bash_mode_and_strays_become_commands() {
    let mut c = Conversation::default();
    let seg = c.start_segment("s", "start", None);
    let src = c.add_source(None, seg);
    c.feed(
        src,
        0,
        r#"{"type":"user","uuid":"b1","message":{"content":"<bash-input>ls</bash-input>"}}"#,
    );
    c.feed(
        src,
        1,
        r#"{"type":"user","uuid":"b2","parentUuid":"b1","message":{"content":"<bash-stdout>a\u001b[31mb\u001b[0m</bash-stdout><bash-stderr></bash-stderr>"}}"#,
    );
    // Sortie sans commande connue : une commande d'après `commandRun`.
    c.feed(
        src,
        2,
        r#"{"type":"system","subtype":"local_command","uuid":"l1","content":"<local-command-stdout>ok</local-command-stdout>","commandRun":{"command":"model","args":"opus"}}"#,
    );
    let bodies: Vec<&Body> = c.entries(None).iter().map(|e| &e.body).collect();
    assert_eq!(
        bodies,
        [
            &Body::Command {
                name: "!".into(),
                args: "ls".into(),
                output: "ab".into()
            },
            &Body::Command {
                name: "/model".into(),
                args: "opus".into(),
                output: "ok".into()
            },
        ]
    );
}

#[test]
fn a_prompt_starting_with_a_path_is_kept() {
    let mut c = Conversation::default();
    let seg = c.start_segment("s", "start", None);
    let src = c.add_source(None, seg);
    c.feed(
        src,
        0,
        r#"{"type":"user","uuid":"p","message":{"content":"/etc/hosts : explique"}}"#,
    );
    c.feed(
        src,
        1,
        r#"{"type":"user","uuid":"q","message":{"content":"/compact"}}"#,
    );
    assert_eq!(kinds(&c, None), ["prompt"]);
}

#[test]
fn disk_length_is_kept_for_rereading() {
    let mut c = Conversation::default();
    let seg = c.start_segment("s", "start", None);
    let src = c.add_source(None, seg);
    // Longueur sur le disque (avant le remplacement d'octets invalides).
    let text = r#"{"type":"user","uuid":"p","message":{"content":"aé"}}"#;
    c.feed_at(src, 5, 99, text);
    assert_eq!(
        c.entry("p").unwrap().lines[0],
        LineRef {
            source: src,
            offset: 5,
            len: 99
        }
    );
}

#[test]
fn ansi_is_stripped() {
    assert_eq!(
        strip_ansi("\x1b[2mA\x1b[22m \x1b]0;titre\x07B\x1b(BC"),
        "A BC"
    );
    assert_eq!(
        strip_ansi("a\x1b]8;;http://x\x1b\\lien\x1b]8;;\x1b\\b"),
        "alienb"
    );
    assert_eq!(
        strip_ansi("\x1bcx\x1b7y\x1b8\x1bPdcs\x1b\\z\u{9b}31mw"),
        "xyzw"
    );
    assert_eq!(strip_ansi("fin\x1b"), "fin");
    // Ligne nue d'une commande connue seulement.
    assert!(is_bare_command("/compact"));
    assert!(is_bare_command(" /model opus "));
    assert!(!is_bare_command(
        "/home/u/projet/a.rs : que fait ce fichier ?"
    ));
    assert!(!is_bare_command("/inconnue"));
    assert!(!is_bare_command("/compact\npuis autre chose"));
    assert!(is_agent_id("a413854c8aebbc6cf"));
    assert!(!is_agent_id("../x"));
    assert!(!is_agent_id(""));
}
