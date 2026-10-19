//! Découverte des anciennes sessions dans les transcripts d'un profil :
//! `<config>/projects/<cwd encodé>/<session_id>.jsonl`.
//!
//! Le nom du dossier encode le `cwd` (chaque caractère non alphanumérique
//! devient `-`, et les chemins longs peuvent être tronqués puis hachés) : il
//! n'est jamais décodé, le `cwd` est lu dans les lignes du transcript.
//! Seuls les fichiers `*.jsonl` directement dans ces dossiers sont lus (les
//! sous-dossiers, comme ceux des sous-agents, sont ignorés).
//!
//! Performance : les fichiers sont triés par date de modification (le plus
//! récent d'abord) avant toute lecture, et seuls les `limit` premiers sont
//! résumés. Un petit fichier est lu en entier ; un gros, seulement ses
//! [`HEAD_MAX_BYTES`] premiers octets (au plus [`HEAD_MAX_LINES`] lignes) et
//! ses [`TAIL_BYTES`] derniers (voir [`PastSession::from_head_and_tail`]).
//!
//! Une erreur sur un dossier ou un fichier n'interrompt jamais la liste : il
//! est ignoré.

use std::fs;
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use crate::domain::{PastSession, Profile};
use crate::ports::TranscriptSource;

/// Octets lus au début d'un gros transcript.
pub const HEAD_MAX_BYTES: u64 = 1024 * 1024;
/// Lignes gardées au plus au début d'un gros transcript.
pub const HEAD_MAX_LINES: usize = 200;
/// Octets lus à la fin d'un gros transcript.
pub const TAIL_BYTES: u64 = 64 * 1024;

/// Anciennes sessions trouvées sous `<config_dir>/projects`, de la plus
/// récente à la plus ancienne (date de modification du fichier), au plus
/// `limit`. Un dossier `projects` absent donne une liste vide.
pub fn list_past_sessions(config_dir: &Path, limit: Option<usize>) -> io::Result<Vec<PastSession>> {
    let projects = config_dir.join("projects");
    let entries = match fs::read_dir(&projects) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let mut files: Vec<(SystemTime, PathBuf)> = Vec::new();
    for project_dir in entries.flatten() {
        let Ok(dir_files) = fs::read_dir(project_dir.path()) else {
            continue;
        };
        for file in dir_files.flatten() {
            let path = file.path();
            if path.extension().is_none_or(|e| e != "jsonl") {
                continue;
            }
            let Ok(meta) = fs::metadata(&path) else {
                continue;
            };
            if meta.is_file() {
                files.push((meta.modified().unwrap_or(SystemTime::UNIX_EPOCH), path));
            }
        }
    }
    files.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    Ok(files
        .into_iter()
        .take(limit.unwrap_or(usize::MAX))
        .filter_map(|(_, path)| read_transcript(&path).ok())
        .collect())
}

/// Résume un transcript. Les octets non UTF-8 sont remplacés plutôt que de
/// faire échouer la lecture.
pub fn read_transcript(path: &Path) -> io::Result<PastSession> {
    let mut file = fs::File::open(path)?;
    let len = file.metadata()?.len();
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();

    if len <= HEAD_MAX_BYTES + TAIL_BYTES {
        // Lecture en flux ; une erreur en cours de fichier garde ce qui a été lu.
        let lines = BufReader::new(file)
            .split(b'\n')
            .map_while(Result::ok)
            .map(|raw| String::from_utf8_lossy(&raw).into_owned());
        return Ok(PastSession::from_lines(path.to_path_buf(), &stem, lines));
    }

    let mut head = Vec::new();
    (&mut file).take(HEAD_MAX_BYTES).read_to_end(&mut head)?;
    let mut head_lines = split_lines(&head);
    head_lines.pop(); // Dernière ligne probablement coupée.
    head_lines.truncate(HEAD_MAX_LINES);

    file.seek(SeekFrom::Start(len - TAIL_BYTES))?;
    let mut tail = Vec::new();
    file.read_to_end(&mut tail)?;
    let mut tail_lines = split_lines(&tail);
    if !tail_lines.is_empty() {
        tail_lines.remove(0); // Première ligne probablement coupée.
    }

    Ok(PastSession::from_head_and_tail(
        path.to_path_buf(),
        &stem,
        head_lines,
        tail_lines,
    ))
}

fn split_lines(bytes: &[u8]) -> Vec<String> {
    bytes
        .split(|b| *b == b'\n')
        .map(|l| String::from_utf8_lossy(l).into_owned())
        .collect()
}

/// [`TranscriptSource`] sur le système de fichiers.
#[derive(Debug, Clone, Copy, Default)]
pub struct FsTranscriptSource;

impl TranscriptSource for FsTranscriptSource {
    fn past_sessions(
        &self,
        profile: &Profile,
        limit: Option<usize>,
    ) -> io::Result<Vec<PastSession>> {
        list_past_sessions(&profile.config_dir, limit)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn set_mtime(path: &Path, secs: u64) {
        let f = fs::OpenOptions::new().write(true).open(path).unwrap();
        f.set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(secs))
            .unwrap();
    }

    fn user_line(id: &str, ts: &str, prompt: &str) -> String {
        format!(
            r#"{{"type":"user","sessionId":"{id}","cwd":"/home/u/p","timestamp":"{ts}","message":{{"content":"{prompt}"}}}}"#
        )
    }

    #[test]
    fn lists_by_mtime_with_limit_and_skips_bad_entries() {
        let cfg = tempfile::tempdir().unwrap();
        let dir = cfg.path().join("projects/-home-u-p");
        fs::create_dir_all(dir.join("abc/subagents")).unwrap();
        fs::create_dir_all(cfg.path().join("projects/-autre")).unwrap();

        fs::write(
            dir.join("abc.jsonl"),
            user_line("abc", "2026-10-18T10:00:00Z", "ancienne") + "\n",
        )
        .unwrap();
        let mut recent = (user_line("def", "2026-10-19T10:00:00Z", "récente") + "\n").into_bytes();
        recent.extend_from_slice(b"\xff\xfe pas de l'UTF-8\n{tronqu");
        fs::write(dir.join("def.jsonl"), recent).unwrap();
        fs::write(
            cfg.path().join("projects/-autre/ghi.jsonl"),
            user_line("ghi", "2026-10-17T10:00:00Z", "plus vieille"),
        )
        .unwrap();
        set_mtime(&dir.join("abc.jsonl"), 3_000);
        set_mtime(&dir.join("def.jsonl"), 2_000);
        set_mtime(&cfg.path().join("projects/-autre/ghi.jsonl"), 1_000);
        // Ignorés : sous-agent, autre extension, fichier à la racine de projects,
        // dossier nommé en .jsonl.
        fs::write(dir.join("abc/subagents/agent-1.jsonl"), "{}").unwrap();
        fs::write(dir.join("notes.txt"), "x").unwrap();
        fs::write(cfg.path().join("projects/racine.jsonl"), "{}").unwrap();
        fs::create_dir_all(dir.join("dossier.jsonl")).unwrap();

        let profile = Profile::named("t", cfg.path());
        let sessions = FsTranscriptSource.past_sessions(&profile, None).unwrap();
        let ids: Vec<_> = sessions.iter().map(|s| s.session_id.as_str()).collect();
        // Ordre de la date de modification, pas des dates internes.
        assert_eq!(ids, ["abc", "def", "ghi"]);
        assert_eq!(sessions[1].first_prompt.as_deref(), Some("récente"));
        assert_eq!(sessions[1].message_count, Some(1));

        let limited = FsTranscriptSource.past_sessions(&profile, Some(2)).unwrap();
        assert_eq!(limited.len(), 2);
    }

    #[test]
    fn big_transcript_reads_head_and_tail_only() {
        let cfg = tempfile::tempdir().unwrap();
        let dir = cfg.path().join("projects/-p");
        fs::create_dir_all(&dir).unwrap();
        let stem = "714c80f0-b828-461a-b198-ec128c923746";
        let mut content = user_line("autre", "2026-10-19T10:00:00Z", "premier prompt") + "\n";
        let filler = format!(
            r#"{{"type":"assistant","timestamp":"2026-10-19T11:00:00Z","message":{{"content":"{}"}}}}"#,
            "x".repeat(10_000)
        ) + "\n";
        while (content.len() as u64) < HEAD_MAX_BYTES + 2 * TAIL_BYTES {
            content.push_str(&filler);
        }
        content.push_str(
            r#"{"type":"assistant","gitBranch":"v0.1","timestamp":"2026-10-19T12:00:00Z"}"#,
        );
        content.push('\n');
        let path = dir.join(format!("{stem}.jsonl"));
        fs::write(&path, content).unwrap();

        let s = read_transcript(&path).unwrap();
        assert_eq!(s.session_id, stem);
        assert_eq!(s.first_prompt.as_deref(), Some("premier prompt"));
        assert_eq!(s.git_branch.as_deref(), Some("v0.1"));
        assert_eq!(s.message_count, None);
        let expected = time::OffsetDateTime::parse(
            "2026-10-19T12:00:00Z",
            &time::format_description::well_known::Rfc3339,
        )
        .unwrap();
        assert_eq!(s.last_timestamp, Some(expected));
    }

    #[test]
    fn missing_projects_dir_is_empty() {
        let cfg = tempfile::tempdir().unwrap();
        assert!(list_past_sessions(cfg.path(), None).unwrap().is_empty());
    }
}
