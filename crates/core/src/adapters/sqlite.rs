//! Persistance des sessions dans SQLite (`$XDG_DATA_HOME/devmaestro/state.db`).

use std::collections::HashSet;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{Connection, ErrorCode, Row, params};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use uuid::Uuid;

use crate::ports::{SessionRecord, SessionStore};

/// Migrations, de la version `i` à `i + 1` (`PRAGMA user_version`).
const MIGRATIONS: &[&str] = &[
    // v0 → v1 : table des sessions.
    "
    CREATE TABLE sessions (
        id                TEXT PRIMARY KEY,
        claude_session_id TEXT NOT NULL,
        profile           TEXT NOT NULL,
        cwd               TEXT NOT NULL,
        project_root      TEXT NOT NULL,
        branch            TEXT,
        model             TEXT,
        mode              TEXT,
        status            TEXT NOT NULL,
        status_reason     TEXT,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL,
        last_activity     TEXT,
        pid               INTEGER
    );
    CREATE INDEX sessions_claude_id ON sessions (claude_session_id);
    ",
    // v1 → v2 : identité du processus claude (date de démarrage, scope
    // systemd), pour refuser au socket de contrôle les processus restés
    // d'une session après un plantage du démon.
    "
    ALTER TABLE sessions ADD COLUMN pid_start INTEGER;
    ALTER TABLE sessions ADD COLUMN scope_unit TEXT;
    ",
    "
    ALTER TABLE sessions ADD COLUMN title TEXT;
    ALTER TABLE sessions ADD COLUMN color TEXT;
    ALTER TABLE sessions ADD COLUMN first_prompt TEXT;
    ALTER TABLE sessions ADD COLUMN session_name TEXT;
    ",
    "
    CREATE TABLE hidden_transcripts (
        profile           TEXT NOT NULL,
        claude_session_id TEXT NOT NULL,
        hidden_at         TEXT NOT NULL,
        PRIMARY KEY (profile, claude_session_id)
    );
    ",
];

/// Version du schéma gérée par ce binaire.
pub const SCHEMA_VERSION: i64 = MIGRATIONS.len() as i64;

/// [`SessionStore`] SQLite.
pub struct SqliteStore {
    conn: Mutex<Connection>,
    set_aside: Option<PathBuf>,
}

fn other(e: impl std::fmt::Display) -> io::Error {
    io::Error::other(e.to_string())
}

fn fmt_time(t: OffsetDateTime) -> String {
    t.format(&Rfc3339).unwrap_or_default()
}

fn parse_time(s: Option<String>) -> Option<OffsetDateTime> {
    OffsetDateTime::parse(&s?, &Rfc3339).ok()
}

enum OpenError {
    /// Base écrite par une version plus récente de DevMaestro.
    TooNew(i64),
    /// Fichier illisible ou corrompu.
    Corrupt(String),
    Other(io::Error),
}

fn classify(e: rusqlite::Error) -> OpenError {
    match e.sqlite_error_code() {
        Some(ErrorCode::NotADatabase | ErrorCode::DatabaseCorrupt) => {
            OpenError::Corrupt(e.to_string())
        }
        _ => OpenError::Other(other(e)),
    }
}

impl SqliteStore {
    /// Ouvre (ou crée, en 0600) la base et la met à jour.
    ///
    /// - base d'une version plus récente : refusée, rien n'est modifié ;
    /// - base illisible ou corrompue : mise de côté sous
    ///   `<nom>.corrupt-<horodatage>` et remplacée par une base neuve (voir
    ///   [`SqliteStore::set_aside`]).
    pub fn open(path: &Path) -> io::Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        create_private(path)?;
        match Self::open_checked(path) {
            Ok(store) => Ok(store),
            Err(OpenError::TooNew(v)) => Err(io::Error::other(format!(
                "la base {} est au format {v}, plus récent que celui de cet orchd ({SCHEMA_VERSION}) : \
                 mettez DevMaestro à jour",
                path.display()
            ))),
            Err(OpenError::Other(e)) => Err(e),
            Err(OpenError::Corrupt(why)) => {
                let stamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or_default();
                let mut aside = path.as_os_str().to_owned();
                aside.push(format!(".corrupt-{stamp}"));
                let aside = PathBuf::from(aside);
                std::fs::rename(path, &aside)?;
                for suffix in ["-wal", "-shm"] {
                    let mut side = path.as_os_str().to_owned();
                    side.push(suffix);
                    let _ = std::fs::remove_file(PathBuf::from(side));
                }
                create_private(path)?;
                let mut store = Self::open_checked(path).map_err(|e| match e {
                    OpenError::TooNew(_) | OpenError::Corrupt(_) => {
                        io::Error::other(format!("base neuve illisible après {why}"))
                    }
                    OpenError::Other(e) => e,
                })?;
                store.set_aside = Some(aside);
                Ok(store)
            }
        }
    }

    /// Base en mémoire, pour les tests.
    pub fn in_memory() -> io::Result<Self> {
        let conn = Connection::open_in_memory().map_err(other)?;
        Self::init(conn).map_err(|e| match e {
            OpenError::Other(e) => e,
            _ => io::Error::other("base en mémoire"),
        })
    }

    /// Fichier corrompu mis de côté à l'ouverture, s'il y en a eu un.
    pub fn set_aside(&self) -> Option<&Path> {
        self.set_aside.as_deref()
    }

    fn open_checked(path: &Path) -> Result<Self, OpenError> {
        let conn = Connection::open(path).map_err(classify)?;
        Self::init(conn)
    }

    fn init(mut conn: Connection) -> Result<Self, OpenError> {
        conn.busy_timeout(std::time::Duration::from_secs(2))
            .map_err(classify)?;
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .map_err(classify)?;
        if version > SCHEMA_VERSION {
            return Err(OpenError::TooNew(version));
        }
        let check: String = conn
            .pragma_query_value(None, "quick_check", |r| r.get(0))
            .map_err(classify)?;
        if check != "ok" {
            return Err(OpenError::Corrupt(check));
        }
        // WAL : les lectures ne bloquent pas les écritures ; NORMAL : pas de
        // fsync à chaque transaction (sûr en WAL, au pire la dernière est perdue).
        let _: String = conn
            .pragma_update_and_check(None, "journal_mode", "WAL", |r| r.get(0))
            .map_err(classify)?;
        conn.pragma_update(None, "synchronous", "NORMAL")
            .map_err(classify)?;
        let tx = conn.transaction().map_err(classify)?;
        for (step, sql) in MIGRATIONS.iter().enumerate().skip(version as usize) {
            tx.execute_batch(sql).map_err(classify)?;
            tx.pragma_update(None, "user_version", step as i64 + 1)
                .map_err(classify)?;
        }
        tx.commit().map_err(classify)?;
        Ok(Self {
            conn: Mutex::new(conn),
            set_aside: None,
        })
    }
}

/// Crée le fichier en 0600 s'il n'existe pas (SQLite donne les mêmes droits
/// à ses fichiers `-wal` et `-shm`).
fn create_private(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(path)
        .map(drop)
}

fn from_row(row: &Row<'_>) -> rusqlite::Result<Option<SessionRecord>> {
    let id: String = row.get("id")?;
    let Ok(id) = Uuid::parse_str(&id) else {
        return Ok(None);
    };
    let created: String = row.get("created_at")?;
    let updated: String = row.get("updated_at")?;
    let now = OffsetDateTime::now_utc();
    Ok(Some(SessionRecord {
        id,
        claude_session_id: row.get("claude_session_id")?,
        profile: row.get("profile")?,
        cwd: PathBuf::from(row.get::<_, String>("cwd")?),
        project_root: PathBuf::from(row.get::<_, String>("project_root")?),
        branch: row.get("branch")?,
        model: row.get("model")?,
        mode: row.get("mode")?,
        status: row.get("status")?,
        status_reason: row.get("status_reason")?,
        created_at: parse_time(Some(created)).unwrap_or(now),
        updated_at: parse_time(Some(updated)).unwrap_or(now),
        last_activity: parse_time(row.get("last_activity")?),
        pid: row.get::<_, Option<i64>>("pid")?.map(|p| p as u32),
        pid_start: row.get::<_, Option<i64>>("pid_start")?.map(|p| p as u64),
        scope_unit: row.get("scope_unit")?,
        title: row.get("title")?,
        color: row.get("color")?,
        first_prompt: row.get("first_prompt")?,
        session_name: row.get("session_name")?,
    }))
}

impl SessionStore for SqliteStore {
    fn upsert(&self, r: &SessionRecord) -> io::Result<()> {
        let conn = self.conn.lock().map_err(other)?;
        conn.execute(
            "INSERT INTO sessions (id, claude_session_id, profile, cwd, project_root, branch,
                model, mode, status, status_reason, created_at, updated_at, last_activity, pid,
                pid_start, scope_unit, title, color, first_prompt, session_name)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16,
                ?17, ?18, ?19, ?20)
             ON CONFLICT(id) DO UPDATE SET
                claude_session_id = excluded.claude_session_id,
                profile = excluded.profile, cwd = excluded.cwd,
                project_root = excluded.project_root, branch = excluded.branch,
                model = excluded.model, mode = excluded.mode, status = excluded.status,
                status_reason = excluded.status_reason, updated_at = excluded.updated_at,
                last_activity = excluded.last_activity, pid = excluded.pid,
                pid_start = excluded.pid_start, scope_unit = excluded.scope_unit,
                title = excluded.title, color = excluded.color,
                first_prompt = excluded.first_prompt, session_name = excluded.session_name",
            params![
                r.id.to_string(),
                r.claude_session_id,
                r.profile,
                r.cwd.to_string_lossy(),
                r.project_root.to_string_lossy(),
                r.branch,
                r.model,
                r.mode,
                r.status,
                r.status_reason,
                fmt_time(r.created_at),
                fmt_time(r.updated_at),
                r.last_activity.map(fmt_time),
                r.pid.map(i64::from),
                r.pid_start.map(|s| s as i64),
                r.scope_unit,
                r.title,
                r.color,
                r.first_prompt,
                r.session_name,
            ],
        )
        .map_err(other)?;
        Ok(())
    }

    fn delete(&self, id: &Uuid) -> io::Result<()> {
        let conn = self.conn.lock().map_err(other)?;
        conn.execute(
            "DELETE FROM sessions WHERE id = ?1",
            params![id.to_string()],
        )
        .map_err(other)?;
        Ok(())
    }

    fn hide_transcript(
        &self,
        profile: &str,
        claude_session_id: &str,
        at: OffsetDateTime,
    ) -> io::Result<()> {
        let conn = self.conn.lock().map_err(other)?;
        conn.execute(
            "INSERT OR IGNORE INTO hidden_transcripts (profile, claude_session_id, hidden_at)
             VALUES (?1, ?2, ?3)",
            params![profile, claude_session_id, fmt_time(at)],
        )
        .map_err(other)?;
        Ok(())
    }

    fn unhide_transcript(&self, profile: &str, claude_session_id: &str) -> io::Result<bool> {
        let conn = self.conn.lock().map_err(other)?;
        let n = conn
            .execute(
                "DELETE FROM hidden_transcripts WHERE profile = ?1 AND claude_session_id = ?2",
                params![profile, claude_session_id],
            )
            .map_err(other)?;
        Ok(n > 0)
    }

    fn hidden_transcripts(&self, profile: &str) -> io::Result<HashSet<String>> {
        let conn = self.conn.lock().map_err(other)?;
        let mut stmt = conn
            .prepare("SELECT claude_session_id FROM hidden_transcripts WHERE profile = ?1")
            .map_err(other)?;
        let rows = stmt
            .query_map(params![profile], |r| r.get::<_, String>(0))
            .map_err(other)?;
        Ok(rows.flatten().collect())
    }

    fn load_all(&self) -> io::Result<Vec<SessionRecord>> {
        let conn = self.conn.lock().map_err(other)?;
        let mut stmt = conn
            .prepare("SELECT * FROM sessions ORDER BY updated_at DESC")
            .map_err(other)?;
        let rows = stmt.query_map([], from_row).map_err(other)?;
        let mut out = Vec::new();
        for row in rows {
            // Une ligne illisible est ignorée, pas fatale.
            if let Ok(Some(r)) = row {
                out.push(r);
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(id: u128, status: &str, updated: i64) -> SessionRecord {
        SessionRecord {
            id: Uuid::from_u128(id),
            claude_session_id: format!("c{id}"),
            profile: "default".into(),
            cwd: "/p".into(),
            project_root: "/p".into(),
            branch: Some("main".into()),
            model: None,
            mode: Some("default".into()),
            status: status.into(),
            status_reason: None,
            created_at: OffsetDateTime::from_unix_timestamp(0).unwrap(),
            updated_at: OffsetDateTime::from_unix_timestamp(updated).unwrap(),
            last_activity: None,
            pid: Some(42),
            pid_start: Some(1234),
            scope_unit: Some("devmaestro-session-1.scope".into()),
            title: Some("Mon titre".into()),
            color: Some("bleu".into()),
            first_prompt: Some("Corrige le test".into()),
            session_name: Some("Correction".into()),
        }
    }

    #[test]
    fn upsert_and_load() {
        let store = SqliteStore::in_memory().unwrap();
        store.upsert(&record(1, "running", 10)).unwrap();
        store.upsert(&record(2, "idle", 20)).unwrap();
        let mut r = record(1, "stopped", 30);
        r.status_reason = Some("prompt_input_exit".into());
        r.pid = None;
        store.upsert(&r).unwrap();
        let all = store.load_all().unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0], r);
        assert_eq!(all[1].status, "idle");
        assert_eq!(all[1].pid, Some(42));
    }

    #[test]
    fn delete_removes_only_that_session() {
        let store = SqliteStore::in_memory().unwrap();
        store.upsert(&record(1, "stopped", 10)).unwrap();
        store.upsert(&record(2, "idle", 20)).unwrap();
        store.delete(&Uuid::from_u128(1)).unwrap();
        store.delete(&Uuid::from_u128(99)).unwrap();
        let all = store.load_all().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, Uuid::from_u128(2));
    }

    #[test]
    fn hidden_transcripts_per_profile() {
        let store = SqliteStore::in_memory().unwrap();
        let t = OffsetDateTime::UNIX_EPOCH;
        assert!(store.hidden_transcripts("default").unwrap().is_empty());
        store.hide_transcript("default", "a", t).unwrap();
        store.hide_transcript("default", "a", t).unwrap();
        store.hide_transcript("work", "b", t).unwrap();
        assert_eq!(
            store.hidden_transcripts("default").unwrap(),
            ["a".to_owned()].into()
        );
        assert!(store.unhide_transcript("default", "a").unwrap());
        assert!(!store.unhide_transcript("default", "a").unwrap());
        assert!(store.hidden_transcripts("default").unwrap().is_empty());
        assert_eq!(store.hidden_transcripts("work").unwrap().len(), 1);
    }

    #[test]
    fn refuses_a_newer_database() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.db");
        drop(SqliteStore::open(&path).unwrap());
        Connection::open(&path)
            .unwrap()
            .pragma_update(None, "user_version", SCHEMA_VERSION + 1)
            .unwrap();
        let err = SqliteStore::open(&path).err().unwrap().to_string();
        assert!(err.contains("plus récent"), "{err}");
        // Rien n'a été déplacé ni modifié.
        let v: i64 = Connection::open(&path)
            .unwrap()
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(v, SCHEMA_VERSION + 1);
    }

    #[test]
    fn corrupt_file_is_set_aside() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.db");
        std::fs::write(&path, vec![0x5au8; 8192]).unwrap();
        let store = SqliteStore::open(&path).unwrap();
        let aside = store.set_aside().unwrap().to_path_buf();
        assert!(
            aside
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("state.db.corrupt-")
        );
        assert_eq!(std::fs::read(&aside).unwrap(), vec![0x5au8; 8192]);
        store.upsert(&record(3, "idle", 1)).unwrap();
        assert_eq!(store.load_all().unwrap().len(), 1);
    }

    #[test]
    fn migrates_from_v0_and_sets_private_mode() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.db");
        let store = SqliteStore::open(&path).unwrap();
        let conn = store.conn.lock().unwrap();
        let v: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(v, SCHEMA_VERSION);
        let mode: String = conn
            .pragma_query_value(None, "journal_mode", |r| r.get(0))
            .unwrap();
        assert_eq!(mode, "wal");
        let sync: i64 = conn
            .pragma_query_value(None, "synchronous", |r| r.get(0))
            .unwrap();
        assert_eq!(sync, 1, "NORMAL");
        drop(conn);
        let perms = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(perms & 0o777, 0o600);
        // Réouverture : pas de migration rejouée.
        drop(store);
        SqliteStore::open(&path).unwrap();
    }

    #[test]
    fn migrates_a_v1_database_keeping_its_rows() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(MIGRATIONS[0]).unwrap();
            conn.pragma_update(None, "user_version", 1).unwrap();
            conn.execute(
                "INSERT INTO sessions (id, claude_session_id, profile, cwd, project_root,
                    status, created_at, updated_at, pid)
                 VALUES (?1, 'c', 'default', '/p', '/p', 'idle', ?2, ?2, 42)",
                params![
                    Uuid::from_u128(9).to_string(),
                    fmt_time(OffsetDateTime::UNIX_EPOCH)
                ],
            )
            .unwrap();
        }
        let store = SqliteStore::open(&path).unwrap();
        let all = store.load_all().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].pid, Some(42));
        assert_eq!(all[0].pid_start, None);
        assert_eq!(all[0].scope_unit, None);
        assert_eq!(all[0].title, None);
        let mut r = all[0].clone();
        r.pid_start = Some(77);
        store.upsert(&r).unwrap();
        assert_eq!(store.load_all().unwrap()[0].pid_start, Some(77));
    }

    #[test]
    fn migrates_a_v2_database_keeping_its_rows() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(MIGRATIONS[0]).unwrap();
            conn.execute_batch(MIGRATIONS[1]).unwrap();
            conn.pragma_update(None, "user_version", 2).unwrap();
            conn.execute(
                "INSERT INTO sessions (id, claude_session_id, profile, cwd, project_root,
                    status, created_at, updated_at, pid, pid_start, scope_unit)
                 VALUES (?1, 'c', 'default', '/p', '/p', 'stopped', ?2, ?2, 42, 7, 'u.scope')",
                params![
                    Uuid::from_u128(5).to_string(),
                    fmt_time(OffsetDateTime::UNIX_EPOCH)
                ],
            )
            .unwrap();
        }
        let store = SqliteStore::open(&path).unwrap();
        let all = store.load_all().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].scope_unit.as_deref(), Some("u.scope"));
        assert_eq!(
            (
                &all[0].title,
                &all[0].color,
                &all[0].first_prompt,
                &all[0].session_name
            ),
            (&None, &None, &None, &None)
        );
        let mut r = all[0].clone();
        r.title = Some("Titre".into());
        r.color = Some("rose".into());
        r.first_prompt = Some("Bonjour".into());
        r.session_name = Some("Salutation".into());
        store.upsert(&r).unwrap();
        drop(store);
        assert_eq!(SqliteStore::open(&path).unwrap().load_all().unwrap()[0], r);
    }

    #[test]
    fn reopens_file_database() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sous/state.db");
        SqliteStore::open(&path)
            .unwrap()
            .upsert(&record(7, "idle", 1))
            .unwrap();
        let all = SqliteStore::open(&path).unwrap().load_all().unwrap();
        assert_eq!(all[0].id, Uuid::from_u128(7));
    }
}
