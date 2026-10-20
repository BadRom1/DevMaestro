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

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
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
/// `limit` **après** avoir écarté celles de `exclude` (nom du fichier ou
/// `session_id` lu). Un dossier `projects` absent donne une liste vide.
pub fn list_past_sessions(
    config_dir: &Path,
    limit: Option<usize>,
    exclude: &HashSet<String>,
) -> io::Result<Vec<PastSession>> {
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
    let stem_excluded = |p: &Path| {
        p.file_stem()
            .and_then(|s| s.to_str())
            .is_some_and(|s| exclude.contains(s))
    };
    Ok(files
        .into_iter()
        .filter(|(_, path)| !stem_excluded(path))
        .filter_map(|(_, path)| read_transcript(&path).ok())
        .filter(|s| !exclude.contains(&s.session_id))
        .take(limit.unwrap_or(usize::MAX))
        .collect())
}

/// Signature d'un dossier `projects` : sa date de modification et celle de
/// chacun de ses sous-dossiers. Créer, renommer ou supprimer un transcript
/// change la date de son dossier : même signature, même liste.
type Signature = Vec<(PathBuf, Option<SystemTime>)>;

fn signature(projects: &Path) -> Signature {
    let mtime = |p: &Path| fs::metadata(p).and_then(|m| m.modified()).ok();
    let mut sig = vec![(projects.to_path_buf(), mtime(projects))];
    if let Ok(entries) = fs::read_dir(projects) {
        let mut dirs: Signature = entries
            .flatten()
            .map(|d| d.path())
            .filter(|p| p.is_dir())
            .map(|p| {
                let t = mtime(&p);
                (p, t)
            })
            .collect();
        dirs.sort();
        sig.extend(dirs);
    }
    sig
}

/// Noms (sans `.jsonl`) des transcripts de `<config_dir>/projects/*/`.
pub fn scan_transcript_ids(config_dir: &Path) -> HashSet<String> {
    let mut ids = HashSet::new();
    let Ok(entries) = fs::read_dir(config_dir.join("projects")) else {
        return ids;
    };
    for dir in entries.flatten() {
        let Ok(files) = fs::read_dir(dir.path()) else {
            continue;
        };
        for f in files.flatten() {
            let path = f.path();
            if path.extension().is_some_and(|e| e == "jsonl")
                && f.file_type().is_ok_and(|t| t.is_file() || t.is_symlink())
                && path.is_file()
                && let Some(stem) = path.file_stem().and_then(|s| s.to_str())
            {
                ids.insert(stem.to_owned());
            }
        }
    }
    ids
}

/// Fichier `<config_dir>/projects/<un dossier>/<session_id>.jsonl`, s'il
/// existe : une recherche par nom de fichier (un `stat` par dossier de
/// projet), sans rien lire. Un identifiant qui n'est pas un simple nom de
/// fichier (`/`, `..`) ne correspond à rien.
pub fn find_transcript(config_dir: &Path, session_id: &str) -> Option<PathBuf> {
    if session_id.is_empty()
        || session_id.contains(['/', '\\', '\0'])
        || session_id.starts_with('.')
    {
        return None;
    }
    let name = format!("{session_id}.jsonl");
    fs::read_dir(config_dir.join("projects"))
        .ok()?
        .flatten()
        .map(|d| d.path().join(&name))
        .find(|p| fs::metadata(p).is_ok_and(|m| m.is_file()))
}

/// Résume un transcript. Les octets non UTF-8 sont remplacés plutôt que de
/// faire échouer la lecture.
pub fn read_transcript(path: &Path) -> io::Result<PastSession> {
    let mut s = read_transcript_lines(path)?;
    s.modified = fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .map(time::OffsetDateTime::from);
    Ok(s)
}

fn read_transcript_lines(path: &Path) -> io::Result<PastSession> {
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

/// [`TranscriptSource`] sur le système de fichiers. Garde, par dossier de
/// profil, la liste des transcripts et la [`Signature`] qui l'a produite :
/// tant qu'elle ne change pas (un `read_dir` de `projects` et un `stat` par
/// sous-dossier), la liste est resservie sans relire les sous-dossiers,
/// pendant au plus [`IDS_CACHE_TTL`] (les dates de modification ont une
/// granularité grossière : deux créations rapprochées peuvent garder la
/// même date).
#[derive(Debug, Default)]
pub struct FsTranscriptSource {
    cache: Mutex<HashMap<PathBuf, CachedIds>>,
}

type CachedIds = (Signature, std::time::Instant, Arc<HashSet<String>>);

/// Durée de vie maximale de la liste des transcripts d'un profil.
pub const IDS_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(2);

impl TranscriptSource for FsTranscriptSource {
    fn past_sessions(
        &self,
        profile: &Profile,
        limit: Option<usize>,
        exclude: &HashSet<String>,
    ) -> io::Result<Vec<PastSession>> {
        list_past_sessions(&profile.config_dir, limit, exclude)
    }

    fn transcript_ids(&self, profile: &Profile) -> Arc<HashSet<String>> {
        let projects = profile.config_dir.join("projects");
        let sig = signature(&projects);
        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((cached, at, ids)) = cache.get(&profile.config_dir)
            && *cached == sig
            && at.elapsed() < IDS_CACHE_TTL
        {
            return ids.clone();
        }
        let ids = Arc::new(scan_transcript_ids(&profile.config_dir));
        cache.insert(
            profile.config_dir.clone(),
            (sig, std::time::Instant::now(), ids.clone()),
        );
        ids
    }

    fn past_session(&self, profile: &Profile, session_id: &str) -> Option<PastSession> {
        read_transcript(&find_transcript(&profile.config_dir, session_id)?).ok()
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
    fn finds_a_transcript_by_file_name_in_any_project() {
        let cfg = tempfile::tempdir().unwrap();
        assert_eq!(find_transcript(cfg.path(), "abc"), None);
        let dir = cfg.path().join("projects/-home-u-p");
        fs::create_dir_all(&dir).unwrap();
        fs::create_dir_all(cfg.path().join("projects/-autre")).unwrap();
        fs::create_dir_all(dir.join("dossier.jsonl")).unwrap();
        assert_eq!(find_transcript(cfg.path(), "dossier"), None);
        fs::write(
            dir.join("abc.jsonl"),
            user_line("abc", "2026-10-18T10:00:00Z", "p"),
        )
        .unwrap();
        assert_eq!(
            find_transcript(cfg.path(), "abc"),
            Some(dir.join("abc.jsonl"))
        );
        for bad in ["", "../abc", "a/b", ".abc"] {
            assert_eq!(find_transcript(cfg.path(), bad), None, "{bad}");
        }
        let src = FsTranscriptSource::default();
        let profile = Profile::named("p", cfg.path());
        assert!(src.has_transcript(&profile, "abc"));
        assert!(!src.has_transcript(&profile, "absent"));
        assert!(!src.has_transcript(&profile, "dossier"));
        let past = src.past_session(&profile, "abc").unwrap();
        assert_eq!(past.first_prompt.as_deref(), Some("p"));
        assert!(past.modified.is_some());
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
        let src = FsTranscriptSource::default();
        let none = HashSet::new();
        let sessions = src.past_sessions(&profile, None, &none).unwrap();
        let ids: Vec<_> = sessions.iter().map(|s| s.session_id.as_str()).collect();
        // Ordre de la date de modification, pas des dates internes.
        assert_eq!(ids, ["abc", "def", "ghi"]);
        assert_eq!(sessions[1].first_prompt.as_deref(), Some("récente"));
        assert_eq!(sessions[1].message_count, Some(1));

        let limited = src.past_sessions(&profile, Some(2), &none).unwrap();
        assert_eq!(limited.len(), 2);
        // La limite s'applique après l'exclusion.
        let skip: HashSet<String> = ["abc".to_owned()].into();
        let ids: Vec<_> = src
            .past_sessions(&profile, Some(2), &skip)
            .unwrap()
            .into_iter()
            .map(|s| s.session_id)
            .collect();
        assert_eq!(ids, ["def", "ghi"]);
    }

    #[test]
    fn transcript_ids_are_cached_until_a_directory_changes() {
        let cfg = tempfile::tempdir().unwrap();
        let src = FsTranscriptSource::default();
        let profile = Profile::named("p", cfg.path());
        assert!(src.transcript_ids(&profile).is_empty());
        let dir = cfg.path().join("projects/-p");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("a.jsonl"), "{}").unwrap();
        let first = src.transcript_ids(&profile);
        assert!(first.contains("a"));
        // Rien n'a changé : la même liste est resservie.
        assert!(Arc::ptr_eq(&first, &src.transcript_ids(&profile)));
        // Un fichier ajouté (dossier dont la date change) est vu.
        std::thread::sleep(Duration::from_millis(20));
        fs::write(dir.join("b.jsonl"), "{}").unwrap();
        assert!(src.transcript_ids(&profile).contains("b"));
        std::thread::sleep(Duration::from_millis(20));
        fs::remove_file(dir.join("a.jsonl")).unwrap();
        assert!(!src.has_transcript(&profile, "a"));
        // Nouveau dossier de projet.
        std::thread::sleep(Duration::from_millis(20));
        fs::create_dir_all(cfg.path().join("projects/-q")).unwrap();
        fs::write(cfg.path().join("projects/-q/c.jsonl"), "{}").unwrap();
        assert!(src.has_transcript(&profile, "c"));
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
        assert!(
            list_past_sessions(cfg.path(), None, &HashSet::new())
                .unwrap()
                .is_empty()
        );
    }
}
