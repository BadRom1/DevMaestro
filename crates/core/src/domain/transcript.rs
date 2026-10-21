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

use std::path::{Path, PathBuf};

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
    /// Dossier de reprise : posé par l'adaptateur, le premier des [`Self::cwds`]
    /// dont l'encodage de Claude Code ([`project_dir_name`]) est le nom du
    /// dossier qui contient le transcript (voir [`choose_resume_cwd`]) ; à
    /// défaut, `cwd` de la première ligne qui en porte un. Le nom du dossier
    /// n'est jamais décodé (l'encodage perd de l'information).
    pub cwd: Option<PathBuf>,
    /// `cwd` distincts lus, dans l'ordre de leur première apparition (au plus
    /// [`MAX_DISTINCT_CWDS`]).
    pub cwds: Vec<PathBuf>,
    /// `cwd` est le dossier de reprise retrouvé par l'encodage (`false` :
    /// règle de repli, premier `cwd` lu).
    pub resume_cwd_inferred: bool,
    /// Branche git de la dernière ligne lue qui en porte une.
    pub git_branch: Option<String>,
    /// Premier prompt tapé par l'utilisateur, tronqué à [`PROMPT_PREVIEW_CHARS`].
    pub first_prompt: Option<String>,
    /// Titre donné par Claude Code (dernier `aiTitle` ou `summary` lu).
    pub title: Option<String>,
    pub first_timestamp: Option<OffsetDateTime>,
    pub last_timestamp: Option<OffsetDateTime>,
    /// Date de modification du fichier (posée par l'adaptateur).
    pub modified: Option<OffsetDateTime>,
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
        if let Some(c) = v["cwd"].as_str() {
            if s.cwd.is_none() {
                s.cwd = Some(PathBuf::from(c));
            }
            note_cwd(&mut s.cwds, c);
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

/// Nombre maximal de `cwd` distincts gardés pour un transcript.
pub const MAX_DISTINCT_CWDS: usize = 64;

/// Ajoute `cwd` à la liste des dossiers distincts s'il n'y est pas encore.
pub fn note_cwd(cwds: &mut Vec<PathBuf>, cwd: &str) {
    if cwds.len() < MAX_DISTINCT_CWDS && !cwds.iter().any(|c| c.as_os_str() == cwd) {
        cwds.push(PathBuf::from(cwd));
    }
}

/// Longueur au-delà de laquelle Claude Code coupe le nom encodé et lui
/// ajoute une empreinte.
pub const PROJECT_DIR_MAX_LEN: usize = 200;

/// Nom du dossier de projet de Claude Code pour un dossier de travail
/// (`<config>/projects/<nom>/`), règle de Claude Code 2.1.306 : chaque unité
/// UTF-16 du chemin qui n'est pas une lettre ou un chiffre ASCII devient `-`
/// (`/`, `.`, `_`, espace, `é`… ; un caractère hors du plan de base, comme
/// un émoji, en donne deux) ; au-delà de 200 unités, les 200 premières
/// suivies de `-` et de la valeur absolue, en base 36, de l'empreinte
/// `h = h * 31 + unité` (entier signé de 32 bits) du chemin d'origine.
pub fn project_dir_name(cwd: &Path) -> String {
    let path = cwd.to_string_lossy();
    let units: Vec<u16> = path.encode_utf16().collect();
    let encoded: String = units
        .iter()
        .map(|&u| match u8::try_from(u) {
            Ok(b) if b.is_ascii_alphanumeric() => char::from(b),
            _ => '-',
        })
        .collect();
    if encoded.len() <= PROJECT_DIR_MAX_LEN {
        return encoded;
    }
    let hash = units.iter().fold(0i32, |h, &u| {
        h.wrapping_shl(5).wrapping_sub(h).wrapping_add(i32::from(u))
    });
    format!(
        "{}-{}",
        &encoded[..PROJECT_DIR_MAX_LEN],
        base36(i64::from(hash).unsigned_abs())
    )
}

fn base36(mut n: u64) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    loop {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
        if n == 0 {
            break;
        }
    }
    out.reverse();
    String::from_utf8(out).expect("chiffres ASCII")
}

/// Claude Code retrouve-t-il, depuis `cwd`, une conversation rangée dans le
/// dossier de projet `dir_name` ? (`cwd` absolu dont l'encodage est ce nom.)
pub fn cwd_matches_project_dir(cwd: &Path, dir_name: &str) -> bool {
    cwd.is_absolute() && project_dir_name(cwd) == dir_name
}

/// Dossier de reprise d'un transcript rangé dans `dir_name` : le premier des
/// `cwds` (ordre du fichier) qui est absolu, dont l'encodage est `dir_name`
/// et qui existe (`exists`). `None` si aucun ne convient (encodage ambigu
/// sans candidat, dossier disparu).
pub fn choose_resume_cwd<'a>(
    dir_name: &str,
    cwds: &'a [PathBuf],
    exists: impl Fn(&Path) -> bool,
) -> Option<&'a Path> {
    cwds.iter()
        .map(PathBuf::as_path)
        .find(|c| cwd_matches_project_dir(c, dir_name) && exists(c))
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
    truncate_chars(text, PROMPT_PREVIEW_CHARS)
}

/// Les `max` premiers caractères de `text`, suivis de `…` s'il en reste.
pub fn truncate_chars(text: &str, max: usize) -> String {
    let mut chars = text.chars();
    let head: String = chars.by_ref().take(max).collect();
    if chars.next().is_some() {
        format!("{head}…")
    } else {
        head
    }
}

/// Longueur maximale d'un nom affiché tiré d'un prompt ou d'un nom donné par
/// Claude Code, en caractères (`…` en plus s'il est coupé).
pub const DISPLAY_NAME_CHARS: usize = 60;

/// Texte ramené à un nom affichable : blancs (dont les sauts de ligne)
/// réduits à une espace, coupé à [`DISPLAY_NAME_CHARS`]. `None` s'il est vide.
pub fn display_label(text: &str) -> Option<String> {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    (!flat.is_empty()).then(|| truncate_chars(&flat, DISPLAY_NAME_CHARS))
}

/// Les 8 premiers caractères d'un identifiant, nom de dernier recours.
pub fn short_id(id: &str) -> String {
    id.chars().take(8).collect()
}

impl PastSession {
    /// Nom à afficher : titre donné par Claude Code (`aiTitle`, `summary`),
    /// sinon premier prompt, sinon identifiant court.
    pub fn display_name(&self) -> String {
        self.title
            .as_deref()
            .and_then(display_label)
            .or_else(|| self.first_prompt.as_deref().and_then(display_label))
            .unwrap_or_else(|| short_id(&self.session_id))
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
    fn display_name_prefers_title_then_prompt_then_short_id() {
        let mut s = PastSession {
            session_id: "714c80f0-b828-461a-b198-ec128c923746".into(),
            ..PastSession::default()
        };
        assert_eq!(s.display_name(), "714c80f0");
        s.first_prompt = Some(format!("Lis\n  {}", "x".repeat(80)));
        let name = s.display_name();
        assert!(name.starts_with("Lis xxx"), "{name}");
        assert_eq!(name.chars().count(), DISPLAY_NAME_CHARS + 1);
        assert!(name.ends_with('…'));
        s.title = Some("  ".into());
        assert!(s.display_name().starts_with("Lis "));
        s.title = Some("Lecture de l'architecture".into());
        assert_eq!(s.display_name(), "Lecture de l'architecture");
    }

    #[test]
    fn project_dir_name_follows_claude_code() {
        // Valeurs calculées avec la fonction de Claude Code 2.1.306 (Node).
        let cases = [
            (
                "/home/u/workplace/next-level.run",
                "-home-u-workplace-next-level-run",
            ),
            (
                "/home/u/Mes documents/été 2026/my_app",
                "-home-u-Mes-documents--t--2026-my-app",
            ),
            (
                "/home/u/a-b--c/.claude/worktrees/x",
                "-home-u-a-b--c--claude-worktrees-x",
            ),
            // Émoji : deux unités UTF-16, deux tirets.
            ("/tmp/🚀/x", "-tmp----x"),
        ];
        for (cwd, name) in cases {
            assert_eq!(project_dir_name(Path::new(cwd)), name, "{cwd}");
        }
        // Au-delà de 200 unités : coupé, suivi de l'empreinte en base 36.
        let long = format!("/{}fin", "répertoire/".repeat(25));
        let name = project_dir_name(Path::new(&long));
        assert_eq!(name.len(), 200 + 1 + "k8vxye".len());
        assert!(name.starts_with("-r-pertoire-r-pertoire-"), "{name}");
        assert!(name.ends_with("-r-k8vxye"), "{name}");
        assert_eq!(base36(0), "0");
        assert_eq!(base36(2_147_483_648), "zik0zk");
    }

    #[test]
    fn resume_cwd_is_the_first_cwd_matching_the_project_dir() {
        // Cas réel (anonymisé) : conversation rangée sous le dossier de
        // départ, dont les lignes portent surtout le dossier personnel.
        let cwds: Vec<PathBuf> = [
            "/home/u",
            "/home/u/workplace",
            "/home/u/workplace/next-level.run",
            "/home/u/workplace/next-level.run/optimus-mcp",
        ]
        .map(PathBuf::from)
        .to_vec();
        let all = |_: &Path| true;
        assert_eq!(
            choose_resume_cwd("-home-u-workplace-next-level-run", &cwds, all),
            Some(Path::new("/home/u/workplace/next-level.run"))
        );
        assert_eq!(
            choose_resume_cwd("-home-u-workplace-next-level-run-optimus-mcp", &cwds, all),
            Some(Path::new("/home/u/workplace/next-level.run/optimus-mcp"))
        );
        // Encodage ambigu : le premier qui correspond et existe.
        let twins: Vec<PathBuf> = ["relatif/a.b", "/p/a-b", "/p/a.b", "/p/a_b"]
            .map(PathBuf::from)
            .to_vec();
        assert_eq!(
            choose_resume_cwd("-p-a-b", &twins, all),
            Some(Path::new("/p/a-b"))
        );
        assert_eq!(
            choose_resume_cwd("-p-a-b", &twins, |p| p != Path::new("/p/a-b")),
            Some(Path::new("/p/a.b"))
        );
        // Dossier disparu, ou aucun candidat : rien.
        assert_eq!(choose_resume_cwd("-p-a-b", &twins, |_| false), None);
        assert_eq!(choose_resume_cwd("-ailleurs", &cwds, all), None);
        // Espaces et accents.
        let accents = vec![PathBuf::from("/home/u/Mes documents/été")];
        assert_eq!(
            choose_resume_cwd("-home-u-Mes-documents--t-", &accents, all),
            Some(accents[0].as_path())
        );
    }

    #[test]
    fn distinct_cwds_are_kept_in_file_order() {
        let lines = [
            r#"{"type":"user","cwd":"/home/u"}"#,
            r#"{"type":"user","cwd":"/home/u/p"}"#,
            r#"{"type":"user","cwd":"/home/u"}"#,
            r#"{"type":"user","cwd":"/home/u/p/sous"}"#,
        ];
        let s = PastSession::from_lines("/t/x.jsonl".into(), "x", lines);
        assert_eq!(s.cwd.as_deref(), Some(Path::new("/home/u")));
        assert_eq!(
            s.cwds,
            ["/home/u", "/home/u/p", "/home/u/p/sous"].map(PathBuf::from)
        );
        assert!(!s.resume_cwd_inferred);
        let mut many = Vec::new();
        for i in 0..(MAX_DISTINCT_CWDS + 5) {
            note_cwd(&mut many, &format!("/d{i}"));
        }
        assert_eq!(many.len(), MAX_DISTINCT_CWDS);
    }

    #[test]
    fn empty_transcript_gives_empty_summary() {
        let s = PastSession::from_lines("/t/y.jsonl".into(), "y", std::iter::empty::<&str>());
        assert_eq!(s.session_id, "y");
        assert_eq!(s.message_count, Some(0));
        assert_eq!(s.first_prompt, None);
    }
}
