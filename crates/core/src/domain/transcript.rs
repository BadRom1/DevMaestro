//! Résumé d'une ancienne session à partir de son transcript JSONL.
//!
//! Le format des transcripts est interne à Claude Code et peut changer :
//! lecture ligne à ligne, chaque ligne illisible est ignorée, chaque champ est
//! facultatif. Les champs utilisés (constatés avec Claude Code 2.1.303) :
//! `sessionId`, `cwd`, `gitBranch`, `timestamp` (RFC 3339), `type`
//! (`user`, `assistant`, `ai-title`, `summary`…), `isMeta`, `isSidechain`,
//! `message.content` (chaîne ou liste de blocs), `aiTitle`, `summary`.
//!
//! Pour les gros transcripts, l'adaptateur ne lit que le début et la fin du
//! fichier ([`PastSession::from_head_and_tail`]) : premier prompt et `cwd`
//! viennent du début, dernière date, branche et titre de la fin. Le nombre de
//! messages n'est alors pas connu.

use std::path::PathBuf;

use serde_json::Value;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use uuid::Uuid;

/// Longueur maximale du premier prompt gardé, en caractères.
pub const PROMPT_PREVIEW_CHARS: usize = 200;

/// Balises dont Claude Code entoure des messages `user` qui ne sont pas un
/// prompt tapé (commandes, sorties de commandes locales, rappels système,
/// mode bash). Un prompt qui commence par une autre balise est gardé.
const NON_PROMPT_WRAPPERS: &[&str] = &[
    "<command-name>",
    "<command-message>",
    "<command-args>",
    "<command-stdout>",
    "<local-command-stdout>",
    "<local-command-stderr>",
    "<local-command-caveat>",
    "<system-reminder>",
    "<bash-input>",
    "<bash-stdout>",
    "<bash-stderr>",
    "<user-memory-input>",
    "<task-notification>",
];

/// Une session trouvée dans les transcripts d'un profil.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PastSession {
    /// Nom du fichier quand c'est un UUID (cas normal), sinon `sessionId` lu
    /// dans le transcript, à défaut le nom du fichier.
    pub session_id: String,
    /// Fichier du transcript.
    pub transcript_path: PathBuf,
    /// `cwd` de la première ligne qui en porte un. Le nom du dossier parent
    /// (cwd encodé, parfois tronqué) n'est jamais décodé.
    pub cwd: Option<PathBuf>,
    /// Branche git de la dernière ligne lue qui en porte une.
    pub git_branch: Option<String>,
    /// Premier prompt tapé par l'utilisateur, tronqué à [`PROMPT_PREVIEW_CHARS`].
    pub first_prompt: Option<String>,
    /// Titre donné par Claude Code (dernier `aiTitle` ou `summary` lu).
    pub title: Option<String>,
    pub first_timestamp: Option<OffsetDateTime>,
    pub last_timestamp: Option<OffsetDateTime>,
    /// Nombre de lignes `user` et `assistant` (hors sous-agents), y compris
    /// les résultats d'outils : un ordre de grandeur, pas un nombre de tours.
    /// Inconnu (`None`) quand seuls le début et la fin du fichier ont été lus.
    pub message_count: Option<usize>,
}

impl PastSession {
    /// Résume toutes les lignes d'un transcript.
    pub fn from_lines(
        transcript_path: PathBuf,
        file_stem: &str,
        lines: impl IntoIterator<Item = impl AsRef<str>>,
    ) -> Self {
        let mut acc = Accumulator::default();
        lines.into_iter().for_each(|l| acc.feed(l.as_ref()));
        acc.finish(transcript_path, file_stem, true)
    }

    /// Résume un transcript dont on n'a lu que le début et la fin (lignes
    /// dans l'ordre du fichier, sans doublon). Le nombre de messages reste inconnu.
    pub fn from_head_and_tail(
        transcript_path: PathBuf,
        file_stem: &str,
        head: impl IntoIterator<Item = impl AsRef<str>>,
        tail: impl IntoIterator<Item = impl AsRef<str>>,
    ) -> Self {
        let mut acc = Accumulator::default();
        head.into_iter().for_each(|l| acc.feed(l.as_ref()));
        tail.into_iter().for_each(|l| acc.feed(l.as_ref()));
        acc.finish(transcript_path, file_stem, false)
    }
}

#[derive(Default)]
struct Accumulator {
    s: PastSession,
    inner_session_id: Option<String>,
    message_count: usize,
}

impl Accumulator {
    fn feed(&mut self, line: &str) {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            return;
        };
        if !v.is_object() {
            return;
        }
        let s = &mut self.s;
        if self.inner_session_id.is_none() {
            self.inner_session_id = v["sessionId"].as_str().map(str::to_owned);
        }
        if s.cwd.is_none() {
            s.cwd = v["cwd"].as_str().map(PathBuf::from);
        }
        if let Some(b) = v["gitBranch"].as_str().filter(|b| !b.is_empty()) {
            s.git_branch = Some(b.to_owned());
        }
        if let Some(ts) = v["timestamp"]
            .as_str()
            .and_then(|t| OffsetDateTime::parse(t, &Rfc3339).ok())
        {
            s.first_timestamp = Some(s.first_timestamp.map_or(ts, |f| f.min(ts)));
            s.last_timestamp = Some(s.last_timestamp.map_or(ts, |l| l.max(ts)));
        }
        let sidechain = v["isSidechain"].as_bool().unwrap_or(false);
        match v["type"].as_str() {
            Some("user") if !sidechain => {
                self.message_count += 1;
                if s.first_prompt.is_none() && !v["isMeta"].as_bool().unwrap_or(false) {
                    s.first_prompt = typed_prompt(&v["message"]["content"]).map(preview);
                }
            }
            Some("assistant") if !sidechain => self.message_count += 1,
            Some("ai-title") => {
                if let Some(t) = v["aiTitle"].as_str() {
                    s.title = Some(t.to_owned());
                }
            }
            Some("summary") => {
                if let Some(t) = v["summary"].as_str() {
                    s.title = Some(t.to_owned());
                }
            }
            _ => {}
        }
    }

    fn finish(self, transcript_path: PathBuf, file_stem: &str, complete: bool) -> PastSession {
        let session_id = if Uuid::parse_str(file_stem).is_ok() {
            file_stem.to_owned()
        } else {
            self.inner_session_id
                .unwrap_or_else(|| file_stem.to_owned())
        };
        PastSession {
            session_id,
            transcript_path,
            message_count: complete.then_some(self.message_count),
            ..self.s
        }
    }
}

/// Texte tapé par l'utilisateur, ou `None` pour un résultat d'outil ou un
/// message enveloppé par Claude Code (voir [`NON_PROMPT_WRAPPERS`]).
fn typed_prompt(content: &Value) -> Option<&str> {
    let typed = |text: &str| {
        let text = text.trim();
        !text.is_empty() && !NON_PROMPT_WRAPPERS.iter().any(|w| text.starts_with(w))
    };
    match content {
        Value::String(s) => typed(s).then_some(s.trim()),
        Value::Array(blocks) => blocks
            .iter()
            .filter(|b| b["type"] == "text")
            .filter_map(|b| b["text"].as_str())
            .find(|t| typed(t))
            .map(str::trim),
        _ => None,
    }
}

fn preview(text: &str) -> String {
    let mut chars = text.chars();
    let head: String = chars.by_ref().take(PROMPT_PREVIEW_CHARS).collect();
    if chars.next().is_some() {
        format!("{head}…")
    } else {
        head
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summarises_and_skips_bad_lines() {
        let lines = [
            r#"{"type":"last-prompt","sessionId":"abc"}"#,
            "pas du json",
            "",
            "[]",
            r#"{"type":"user","sessionId":"abc","cwd":"/home/u/p","gitBranch":"main","timestamp":"2026-10-19T12:15:34.085Z","isMeta":true,"message":{"role":"user","content":"méta"}}"#,
            r#"{"type":"user","cwd":"/ailleurs","timestamp":"2026-10-19T12:15:35Z","message":{"role":"user","content":"<command-name>/clear</command-name>"}}"#,
            r#"{"type":"user","timestamp":"2026-10-19T12:15:36Z","message":{"role":"user","content":[{"type":"text","text":"Lis l'architecture"}]}}"#,
            r#"{"type":"assistant","gitBranch":"v0.1","timestamp":"2026-10-19T12:16:00Z","message":{"content":[{"type":"tool_use"}]}}"#,
            r#"{"type":"user","isSidechain":true,"timestamp":"2026-10-19T12:17:00Z","message":{"content":"sous-agent"}}"#,
            r#"{"type":"ai-title","aiTitle":"Lecture de l'architecture"}"#,
        ];
        let s = PastSession::from_lines("/t/abc.jsonl".into(), "fichier", lines);
        assert_eq!(s.session_id, "abc");
        assert_eq!(s.cwd.as_deref(), Some(std::path::Path::new("/home/u/p")));
        assert_eq!(s.git_branch.as_deref(), Some("v0.1"));
        assert_eq!(s.first_prompt.as_deref(), Some("Lis l'architecture"));
        assert_eq!(s.title.as_deref(), Some("Lecture de l'architecture"));
        assert_eq!(s.message_count, Some(4));
        assert_eq!(
            s.first_timestamp.unwrap(),
            OffsetDateTime::parse("2026-10-19T12:15:34.085Z", &Rfc3339).unwrap()
        );
        assert_eq!(
            s.last_timestamp.unwrap(),
            OffsetDateTime::parse("2026-10-19T12:17:00Z", &Rfc3339).unwrap()
        );
    }

    #[test]
    fn uuid_file_stem_wins_over_inner_session_id() {
        let stem = "714c80f0-b828-461a-b198-ec128c923746";
        let s = PastSession::from_lines(
            format!("/t/{stem}.jsonl").into(),
            stem,
            [r#"{"type":"user","sessionId":"autre"}"#],
        );
        assert_eq!(s.session_id, stem);
    }

    #[test]
    fn only_known_wrappers_are_skipped() {
        let first = |content: &str| {
            let line = format!(r#"{{"type":"user","message":{{"content":{content}}}}}"#);
            PastSession::from_lines("/t/x.jsonl".into(), "x", [line.as_str()]).first_prompt
        };
        assert_eq!(first(r#""<system-reminder>x</system-reminder>""#), None);
        assert_eq!(
            first(r#""<local-command-stdout>ok</local-command-stdout>""#),
            None
        );
        assert_eq!(first(r#""<bash-input>ls</bash-input>""#), None);
        assert_eq!(
            first(r#""<div> est-il bien fermé ?""#).as_deref(),
            Some("<div> est-il bien fermé ?")
        );
        assert_eq!(
            first(r#"[{"type":"text","text":"<system-reminder>r</system-reminder>"},{"type":"text","text":"Le vrai prompt"}]"#)
                .as_deref(),
            Some("Le vrai prompt")
        );
        assert_eq!(first(r#"[{"type":"tool_result","content":"x"}]"#), None);
    }

    #[test]
    fn head_and_tail_summary_has_no_message_count() {
        let s = PastSession::from_head_and_tail(
            "/t/x.jsonl".into(),
            "x",
            [
                r#"{"type":"user","cwd":"/p","timestamp":"2026-10-19T10:00:00Z","message":{"content":"début"}}"#,
            ],
            [r#"{"type":"assistant","gitBranch":"main","timestamp":"2026-10-19T12:00:00Z"}"#],
        );
        assert_eq!(s.first_prompt.as_deref(), Some("début"));
        assert_eq!(s.git_branch.as_deref(), Some("main"));
        assert_eq!(s.message_count, None);
        assert!(s.last_timestamp > s.first_timestamp);
    }

    #[test]
    fn falls_back_to_file_name_and_truncates() {
        let long = "é".repeat(PROMPT_PREVIEW_CHARS + 10);
        let line = format!(r#"{{"type":"user","message":{{"content":"{long}"}}}}"#);
        let s = PastSession::from_lines("/t/x.jsonl".into(), "x", [line.as_str()]);
        assert_eq!(s.session_id, "x");
        let p = s.first_prompt.unwrap();
        assert_eq!(p.chars().count(), PROMPT_PREVIEW_CHARS + 1);
        assert!(p.ends_with('…'));
    }

    #[test]
    fn empty_transcript_gives_empty_summary() {
        let s = PastSession::from_lines("/t/y.jsonl".into(), "y", std::iter::empty::<&str>());
        assert_eq!(s.session_id, "y");
        assert_eq!(s.message_count, Some(0));
        assert_eq!(s.first_prompt, None);
    }
}
