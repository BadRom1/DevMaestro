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

use crate::domain::transcript::{
    MAX_DISTINCT_CWDS, choose_resume_cwd, cwd_matches_project_dir, note_cwd,
};
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
    if !valid_session_file_name(session_id) {
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
/// faire échouer la lecture. `cwd` est le dossier de reprise (voir
/// [`resolve_resume_cwd`]).
pub fn read_transcript(path: &Path) -> io::Result<PastSession> {
    let mut s = read_transcript_lines(path)?;
    s.modified = fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .map(time::OffsetDateTime::from);
    resolve_resume_cwd(path, &mut s);
    Ok(s)
}

/// Dossier de reprise : le premier `cwd` lu dont l'encodage de Claude Code
/// est le nom du dossier qui contient le transcript, et qui existe
/// (`resume_cwd_inferred: true`). Un gros fichier lu par le début et la fin
/// (ou dont la liste des `cwd` est pleine) est parcouru en entier (voir
/// [`matching_cwds`]) si aucun `cwd` lu n'a le bon encodage. À défaut, `cwd` reste le premier lu
/// (`resume_cwd_inferred: false`).
pub fn resolve_resume_cwd(path: &Path, s: &mut PastSession) {
    let Some(dir_name) = path
        .parent()
        .and_then(Path::file_name)
        .and_then(|n| n.to_str())
    else {
        return;
    };
    let exists = |p: &Path| p.is_dir();
    let mut found = choose_resume_cwd(dir_name, &s.cwds, exists).map(Path::to_path_buf);
    // Parcours seulement si aucun `cwd` lu n'a le bon encodage : un `cwd`
    // qui l'a mais n'existe plus (worktree supprimé) n'y gagnerait rien.
    // Aussi pour un fichier lu en entier dont la liste des `cwd` a atteint
    // son plafond (le bon a pu être écarté).
    let partial = s.message_count.is_none() || s.cwds.len() >= MAX_DISTINCT_CWDS;
    if found.is_none() && partial && !s.cwds.iter().any(|c| cwd_matches_project_dir(c, dir_name)) {
        let candidates = matching_cwds(path, dir_name);
        found = choose_resume_cwd(dir_name, &candidates, exists).map(Path::to_path_buf);
        for c in candidates.iter().filter_map(|c| c.to_str()) {
            note_cwd(&mut s.cwds, c);
        }
    }
    if let Some(c) = found {
        s.cwd = Some(c);
        s.resume_cwd_inferred = true;
    }
}

/// Octets lus au plus par le parcours d'un transcript à la recherche de ses `cwd`.
pub const SCAN_MAX_BYTES: u64 = 256 * 1024 * 1024;
/// Taille du bloc lu par le parcours.
const SCAN_CHUNK: usize = 256 * 1024;
/// Longueur maximale d'une valeur `"cwd"` (chaîne JSON, guillemets compris).
const CWD_MAX_LEN: usize = 8 * 1024;
/// Résultats de parcours gardés au plus (au-delà, le cache est vidé).
const SCAN_CACHE_MAX: usize = 256;

type ScanKey = (PathBuf, Option<SystemTime>, u64);

fn scan_cache() -> &'static Mutex<HashMap<ScanKey, Arc<Vec<PathBuf>>>> {
    static CACHE: std::sync::OnceLock<Mutex<HashMap<ScanKey, Arc<Vec<PathBuf>>>>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(Mutex::default)
}

/// `cwd` distincts d'un transcript dont l'encodage est `dir_name`, dans
/// l'ordre du fichier, existants ou non (l'existence est vérifiée à chaque
/// appel). Résultat gardé par (chemin, date de modification, taille).
fn matching_cwds(path: &Path, dir_name: &str) -> Arc<Vec<PathBuf>> {
    let Ok(meta) = fs::metadata(path) else {
        return Arc::default();
    };
    let key = (path.to_path_buf(), meta.modified().ok(), meta.len());
    if let Some(hit) = scan_cache()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&key)
    {
        return hit.clone();
    }
    let found = Arc::new(
        fs::File::open(path)
            .map(|f| scan_cwds(f.take(SCAN_MAX_BYTES), dir_name))
            .unwrap_or_default(),
    );
    let mut cache = scan_cache().lock().unwrap_or_else(|e| e.into_inner());
    if cache.len() >= SCAN_CACHE_MAX {
        cache.clear();
    }
    cache.insert(key, found.clone());
    found
}

/// Parcourt `input` par blocs à la recherche des `"cwd":"…"` (sans analyser
/// le JSON ni découper en lignes : une ligne géante, image en base64 par
/// exemple, n'est jamais gardée en entier) et retient, sans doublon, les
/// valeurs dont l'encodage est `dir_name`. Une valeur de plus de
/// [`CWD_MAX_LEN`] octets est ignorée ; une erreur de lecture arrête le
/// parcours (ce qui est trouvé est gardé).
fn scan_cwds(mut input: impl Read, dir_name: &str) -> Vec<PathBuf> {
    const KEY: &[u8] = b"\"cwd\":";
    let mut found: Vec<PathBuf> = Vec::new();
    let mut window: Vec<u8> = Vec::with_capacity(SCAN_CHUNK + CWD_MAX_LEN);
    let mut chunk = vec![0u8; SCAN_CHUNK];
    loop {
        let n = match input.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        };
        window.extend_from_slice(&chunk[..n]);
        // Début de ce qu'il faut garder pour le bloc suivant : la fin de la
        // fenêtre (motif à cheval), ou une valeur commencée mais pas finie.
        let mut keep = window.len().saturating_sub(KEY.len() - 1);
        let mut from = 0;
        while let Some(at) = find(&window[from..], KEY) {
            let key_at = from + at;
            let value = &window[key_at + KEY.len()..];
            from = key_at + KEY.len();
            match json_string_at(value) {
                Some(text) => {
                    if cwd_matches_project_dir(Path::new(&text), dir_name)
                        && !found.iter().any(|c| c.as_os_str() == text.as_str())
                    {
                        found.push(PathBuf::from(text));
                    }
                }
                // Pas finie dans la fenêtre : reprise au bloc suivant, sauf
                // si elle est déjà trop longue pour être un dossier.
                None if value.len() < CWD_MAX_LEN && !string_is_closed(value) => {
                    keep = keep.min(key_at);
                    break;
                }
                None => {}
            }
        }
        window.drain(..keep);
    }
    found
}

/// La chaîne JSON qui commence `bytes` (blancs sautés) est-elle fermée, ou
/// `bytes` ne commence-t-il pas par une chaîne ? (Sinon il faut la suite.)
fn string_is_closed(bytes: &[u8]) -> bool {
    match bytes.iter().position(|b| !b.is_ascii_whitespace()) {
        None => false,
        Some(start) if bytes[start] != b'"' => true,
        Some(start) => {
            let mut escaped = false;
            bytes[start + 1..].iter().any(|&b| {
                let stop = b == b'"' && !escaped;
                escaped = b == b'\\' && !escaped;
                stop
            })
        }
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// Chaîne JSON qui commence au début de `bytes` (blancs sautés), décodée.
fn json_string_at(bytes: &[u8]) -> Option<String> {
    let start = bytes.iter().position(|b| !b.is_ascii_whitespace())?;
    if bytes[start] != b'"' {
        return None;
    }
    let mut escaped = false;
    let end = bytes[start + 1..].iter().position(|&b| {
        let stop = b == b'"' && !escaped;
        escaped = b == b'\\' && !escaped;
        stop
    })?;
    serde_json::from_slice(&bytes[start..start + 1 + end + 1]).ok()
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

    fn transcript_path(&self, profile: &Profile, session_id: &str) -> Option<PathBuf> {
        find_transcript(&profile.config_dir, session_id)
    }

    fn found_from(&self, profile: &Profile, session_id: &str, cwd: &Path) -> bool {
        transcript_found_from(&profile.config_dir, session_id, cwd)
    }
}

/// `<config_dir>/projects/<cwd encodé>/<session_id>.jsonl` existe : là où
/// Claude Code, lancé dans `cwd`, cherche la conversation à reprendre.
pub fn transcript_found_from(config_dir: &Path, session_id: &str, cwd: &Path) -> bool {
    if !valid_session_file_name(session_id) || !cwd.is_absolute() {
        return false;
    }
    let dir = crate::domain::transcript::project_dir_name(cwd);
    fs::metadata(
        config_dir
            .join("projects")
            .join(dir)
            .join(format!("{session_id}.jsonl")),
    )
    .is_ok_and(|m| m.is_file())
}

fn valid_session_file_name(session_id: &str) -> bool {
    !(session_id.is_empty()
        || session_id.contains(['/', '\\', '\0'])
        || session_id.starts_with('.'))
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
    fn resume_cwd_is_found_even_in_the_middle_of_a_big_transcript() {
        // Cas réel (anonymisé) : 11,6 Mo, `cwd` du dossier personnel au début
        // et à la fin, le dossier de départ seulement au milieu.
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home/u");
        let start = home.join("workplace/next-level.run");
        let sub = start.join("optimus-mcp");
        fs::create_dir_all(&sub).unwrap();
        let cfg = root.path().join("cfg");
        let dir = cfg
            .join("projects")
            .join(crate::domain::transcript::project_dir_name(&start));
        fs::create_dir_all(&dir).unwrap();
        let filler = "x".repeat(500);
        let mut content = String::new();
        for (cwd, n) in [
            (&home, 972),
            (&home.join("workplace"), 3),
            (&start, 316),
            (&home, 57),
            (&sub, 840),
            (&home, 817),
        ] {
            for _ in 0..n {
                content.push_str(
                    &serde_json::json!({"type": "assistant", "cwd": cwd, "message": {"content": filler}})
                        .to_string(),
                );
                content.push('\n');
            }
        }
        assert!(content.len() as u64 > HEAD_MAX_BYTES + TAIL_BYTES);
        let path = dir.join("36b9efbf-1dfc-49d3-9414-723d97625117.jsonl");
        fs::write(&path, content).unwrap();
        let s = read_transcript(&path).unwrap();
        assert_eq!(s.message_count, None, "lu par le début et la fin");
        assert_eq!(s.cwd.as_deref(), Some(start.as_path()));
        assert!(s.resume_cwd_inferred);
        // Début et fin, plus ceux du parcours qui ont le bon encodage.
        assert_eq!(s.cwds, [home.clone(), start.clone()]);

        // Dossier de départ disparu : règle de repli (premier `cwd` lu).
        fs::remove_dir_all(&start).unwrap();
        let s = read_transcript(&path).unwrap();
        assert_eq!(s.cwd.as_deref(), Some(home.as_path()));
        assert!(!s.resume_cwd_inferred);
    }

    #[test]
    fn resume_cwd_of_a_small_transcript() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("Mes documents");
        let proj = home.join("été_2026/a-b.c");
        fs::create_dir_all(&proj).unwrap();
        let cfg = root.path().join("cfg");
        let dir = cfg
            .join("projects")
            .join(crate::domain::transcript::project_dir_name(&proj));
        fs::create_dir_all(&dir).unwrap();
        let line = |cwd: &Path| {
            serde_json::json!({"type": "user", "cwd": cwd, "message": {"content": "p"}}).to_string()
        };
        let path = dir.join("abc.jsonl");
        fs::write(&path, format!("{}\n{}\n", line(&home), line(&proj))).unwrap();
        let s = read_transcript(&path).unwrap();
        assert_eq!(s.cwd.as_deref(), Some(proj.as_path()));
        assert!(s.resume_cwd_inferred);
        // Rangé ailleurs (aucun `cwd` ne correspond) : premier `cwd` lu.
        let other = cfg.join("projects/-ailleurs");
        fs::create_dir_all(&other).unwrap();
        fs::copy(&path, other.join("def.jsonl")).unwrap();
        let s = read_transcript(&other.join("def.jsonl")).unwrap();
        assert_eq!(s.cwd.as_deref(), Some(home.as_path()));
        assert!(!s.resume_cwd_inferred);
    }

    /// Lecteur qui rend les octets par petits morceaux (motifs et valeurs à
    /// cheval sur deux lectures).
    struct Trickle<'a>(&'a [u8], usize);
    impl Read for Trickle<'_> {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let n = self.1.min(buf.len()).min(self.0.len());
            buf[..n].copy_from_slice(&self.0[..n]);
            self.0 = &self.0[n..];
            Ok(n)
        }
    }

    #[test]
    fn scan_streams_past_giant_lines_and_chunk_boundaries() {
        // Ligne géante sans `cwd` (image en base64), puis une ligne dont le
        // `cwd` vient après un long champ (cas réel : jusqu'à 1,4 Mo).
        let mut data = format!(
            r#"{{"type":"user","message":{{"image":"{}"}}}}"#,
            "A".repeat(3 << 20)
        )
        .into_bytes();
        data.push(b'\n');
        data.extend(
            format!(
                r#"{{"type":"user","toolUseResult":"{}","cwd":"/p/a.b"}}"#,
                "B".repeat(100_000)
            )
            .bytes(),
        );
        data.extend(b"\n{\"cwd\":\"/ailleurs\"}\n{\"cwd\": \"/p/a-b\"}\n{\"cwd\":\"/p/a.b\"}\n");
        let expected = [PathBuf::from("/p/a.b"), PathBuf::from("/p/a-b")];
        assert_eq!(scan_cwds(&data[..], "-p-a-b"), expected);
        for step in [1, 7, 4096] {
            assert_eq!(
                scan_cwds(Trickle(&data, step), "-p-a-b"),
                expected,
                "{step}"
            );
        }
        // Valeur non fermée, trop longue pour être un dossier : ignorée.
        let mut bad = b"{\"cwd\":\"/p/".to_vec();
        bad.extend(std::iter::repeat_n(b'x', CWD_MAX_LEN * 2));
        bad.extend(b"\n{\"cwd\":\"/p/a.b\"}\n");
        assert_eq!(scan_cwds(&bad[..], "-p-a-b"), [PathBuf::from("/p/a.b")]);
        // Plafond d'octets lus.
        assert!(scan_cwds((&data[..]).take(1000), "-p-a-b").is_empty());
    }

    #[test]
    fn resume_cwd_found_after_more_than_64_other_cwds() {
        let root = tempfile::tempdir().unwrap();
        let proj = root.path().join("projet");
        fs::create_dir_all(&proj).unwrap();
        let dir = root
            .path()
            .join("cfg/projects")
            .join(crate::domain::transcript::project_dir_name(&proj));
        fs::create_dir_all(&dir).unwrap();
        let line = |cwd: &Path| serde_json::json!({"type": "user", "cwd": cwd}).to_string() + "\n";
        let mut small = String::new();
        for i in 0..(MAX_DISTINCT_CWDS + 10) {
            small.push_str(&line(&root.path().join(format!("autre-{i}"))));
        }
        small.push_str(&line(&proj));
        // Petit fichier lu en entier, et gros fichier lu par le début et la fin.
        let mut big = small.clone();
        while (big.len() as u64) < HEAD_MAX_BYTES + 2 * TAIL_BYTES {
            big.push_str(&line(&root.path().join("autre-0")));
        }
        for (name, content) in [("petit", &small), ("gros", &big)] {
            let path = dir.join(format!("{name}.jsonl"));
            fs::write(&path, content).unwrap();
            let s = read_transcript(&path).unwrap();
            assert_eq!(s.cwd.as_deref(), Some(proj.as_path()), "{name}");
            assert!(s.resume_cwd_inferred, "{name}");
            // Mémoïsé : même résultat, le fichier n'ayant pas changé.
            assert_eq!(read_transcript(&path).unwrap().cwd, s.cwd);
        }
    }

    #[test]
    fn json_strings_are_decoded_when_scanning() {
        assert_eq!(
            json_string_at(br#" "/a \"b\"\\" , "x""#).as_deref(),
            Some(r#"/a "b"\"#)
        );
        assert_eq!(
            json_string_at(br#""\u00e9t\u00e9""#).as_deref(),
            Some("été")
        );
        assert_eq!(json_string_at(b"null"), None);
        assert_eq!(json_string_at("\"non fermée".as_bytes()), None);
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
