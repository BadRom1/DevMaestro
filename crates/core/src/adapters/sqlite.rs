//! Persistance des sessions dans SQLite (`$XDG_DATA_HOME/devmaestro/state.db`).

use std::collections::HashSet;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{Connection, ErrorCode, Row, params};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use uuid::Uuid;

use crate::domain::forge::SessionIssue;
use crate::domain::subagents::{MAX_SUBAGENTS, Subagent, SubagentStatus};
use crate::ports::{SessionRecord, SessionStore, WorktreeRecord};

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
    // v4 → v5 : sous-agents des sessions (v0.2, lot 5), au plus 100 par
    // session (`seq` : ordre de lancement).
    "
    CREATE TABLE subagents (
        session           TEXT NOT NULL,
        agent_id          TEXT NOT NULL,
        seq               INTEGER NOT NULL,
        agent_type        TEXT,
        description       TEXT,
        model             TEXT,
        tool_use_id       TEXT,
        status            TEXT NOT NULL,
        started_at        TEXT NOT NULL,
        ended_at          TEXT,
        tool_count        INTEGER NOT NULL DEFAULT 0,
        current_tool      TEXT,
        last_tool         TEXT,
        report            TEXT,
        report_truncated  INTEGER NOT NULL DEFAULT 0,
        transcript_path   TEXT,
        PRIMARY KEY (session, agent_id)
    );
    CREATE INDEX subagents_session_seq ON subagents (session, seq);
    ",
    // v5 → v6 (v0.2, lot 6) : identité du projet de chaque session (dossier
    // commun git, rempli au lancement, et au démarrage du démon pour les
    // sessions dont le dossier existe encore) et worktrees créés par le démon.
    "
    ALTER TABLE sessions ADD COLUMN project_common_dir TEXT;
    CREATE TABLE worktrees (
        path              TEXT PRIMARY KEY,
        common_dir        TEXT NOT NULL,
        project_root      TEXT NOT NULL,
        branch            TEXT NOT NULL,
        base              TEXT,
        created_branch    INTEGER NOT NULL DEFAULT 0,
        start_sha         TEXT,
        created_at        TEXT NOT NULL
    );
    ",
    // v6 → v7 (v0.3, lot 13a) : issue de la forge liée au lancement d'une
    // session (lien seulement : jamais le contenu de l'issue).
    "
    ALTER TABLE sessions ADD COLUMN issue_number INTEGER;
    ALTER TABLE sessions ADD COLUMN issue_title TEXT;
    ALTER TABLE sessions ADD COLUMN issue_url TEXT;
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
        project_common_dir: row
            .get::<_, Option<String>>("project_common_dir")?
            .map(PathBuf::from),
        issue: issue_from_row(row)?,
    }))
}

/// Issue liée relue ; une ligne incomplète ou invalide vaut `None`.
fn issue_from_row(row: &Row<'_>) -> rusqlite::Result<Option<SessionIssue>> {
    let number: Option<i64> = row.get("issue_number")?;
    let title: Option<String> = row.get("issue_title")?;
    let url: Option<String> = row.get("issue_url")?;
    Ok(match (number, title, url) {
        (Some(n), Some(t), Some(u)) if n > 0 => SessionIssue::new(n as u64, &t, &u).ok(),
        _ => None,
    })
}

fn subagent_from_row(row: &Row<'_>) -> rusqlite::Result<Option<Subagent>> {
    let Some(status) = SubagentStatus::parse(&row.get::<_, String>("status")?) else {
        return Ok(None);
    };
    let Some(started_at) = parse_time(row.get("started_at")?) else {
        return Ok(None);
    };
    let mut a = Subagent::new(
        row.get::<_, String>("agent_id")?,
        row.get::<_, i64>("seq")?.max(0) as u64,
        started_at,
    );
    a.agent_type = row.get("agent_type")?;
    a.description = row.get("description")?;
    a.model = row.get("model")?;
    a.tool_use_id = row.get("tool_use_id")?;
    a.status = status;
    a.ended_at = parse_time(row.get("ended_at")?);
    a.tool_count = row.get::<_, i64>("tool_count")?.max(0) as u64;
    a.current_tool = row.get("current_tool")?;
    a.last_tool = row.get("last_tool")?;
    a.report = row.get("report")?;
    a.report_truncated = row.get::<_, i64>("report_truncated")? != 0;
    a.transcript_path = row.get("transcript_path")?;
    // Rien n'est plus attendu d'un sous-agent relu.
    a.notified = true;
    Ok(Some(a))
}

impl SessionStore for SqliteStore {
    fn upsert(&self, r: &SessionRecord) -> io::Result<()> {
        let conn = self.conn.lock().map_err(other)?;
        conn.execute(
            "INSERT INTO sessions (id, claude_session_id, profile, cwd, project_root, branch,
                model, mode, status, status_reason, created_at, updated_at, last_activity, pid,
                pid_start, scope_unit, title, color, first_prompt, session_name,
                project_common_dir, issue_number, issue_title, issue_url)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16,
                ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24)
             ON CONFLICT(id) DO UPDATE SET
                claude_session_id = excluded.claude_session_id,
                profile = excluded.profile, cwd = excluded.cwd,
                project_root = excluded.project_root, branch = excluded.branch,
                model = excluded.model, mode = excluded.mode, status = excluded.status,
                status_reason = excluded.status_reason, updated_at = excluded.updated_at,
                last_activity = excluded.last_activity, pid = excluded.pid,
                pid_start = excluded.pid_start, scope_unit = excluded.scope_unit,
                title = excluded.title, color = excluded.color,
                first_prompt = excluded.first_prompt, session_name = excluded.session_name,
                project_common_dir = excluded.project_common_dir,
                issue_number = excluded.issue_number, issue_title = excluded.issue_title,
                issue_url = excluded.issue_url",
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
                r.project_common_dir
                    .as_ref()
                    .map(|p| p.to_string_lossy().into_owned()),
                r.issue.as_ref().map(|i| i.number as i64),
                r.issue.as_ref().map(|i| i.title.as_str()),
                r.issue.as_ref().map(|i| i.url.as_str()),
            ],
        )
        .map_err(other)?;
        Ok(())
    }

    fn record_worktree(&self, w: &WorktreeRecord) -> io::Result<()> {
        let conn = self.conn.lock().map_err(other)?;
        conn.execute(
            "INSERT OR REPLACE INTO worktrees (path, common_dir, project_root, branch, base,
                created_branch, start_sha, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                w.path.to_string_lossy(),
                w.common_dir.to_string_lossy(),
                w.project_root.to_string_lossy(),
                w.branch,
                w.base,
                w.created_branch as i64,
                w.start_sha,
                fmt_time(w.created_at),
            ],
        )
        .map_err(other)?;
        Ok(())
    }

    fn delete_worktree(&self, path: &Path) -> io::Result<()> {
        let conn = self.conn.lock().map_err(other)?;
        conn.execute(
            "DELETE FROM worktrees WHERE path = ?1",
            params![path.to_string_lossy()],
        )
        .map_err(other)?;
        Ok(())
    }

    fn load_worktrees(&self) -> io::Result<Vec<WorktreeRecord>> {
        let conn = self.conn.lock().map_err(other)?;
        let mut stmt = conn
            .prepare("SELECT * FROM worktrees ORDER BY created_at")
            .map_err(other)?;
        let rows = stmt
            .query_map([], |row| {
                Ok(WorktreeRecord {
                    path: PathBuf::from(row.get::<_, String>("path")?),
                    common_dir: PathBuf::from(row.get::<_, String>("common_dir")?),
                    project_root: PathBuf::from(row.get::<_, String>("project_root")?),
                    branch: row.get("branch")?,
                    base: row.get("base")?,
                    created_branch: row.get::<_, i64>("created_branch")? != 0,
                    start_sha: row.get("start_sha")?,
                    created_at: parse_time(row.get("created_at")?)
                        .unwrap_or_else(OffsetDateTime::now_utc),
                })
            })
            .map_err(other)?;
        Ok(rows.flatten().collect())
    }

    fn delete(&self, id: &Uuid) -> io::Result<()> {
        let conn = self.conn.lock().map_err(other)?;
        conn.execute(
            "DELETE FROM sessions WHERE id = ?1",
            params![id.to_string()],
        )
        .map_err(other)?;
        conn.execute(
            "DELETE FROM subagents WHERE session = ?1",
            params![id.to_string()],
        )
        .map_err(other)?;
        Ok(())
    }

    fn upsert_subagents(&self, session: &Uuid, agents: &[Subagent]) -> io::Result<()> {
        let mut conn = self.conn.lock().map_err(other)?;
        let tx = conn.transaction().map_err(other)?;
        let sid = session.to_string();
        for a in agents {
            tx.execute(
                "INSERT INTO subagents (session, agent_id, seq, agent_type, description, model,
                    tool_use_id, status, started_at, ended_at, tool_count, current_tool, last_tool,
                    report, report_truncated, transcript_path)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
                 ON CONFLICT(session, agent_id) DO UPDATE SET
                    seq = excluded.seq, agent_type = excluded.agent_type,
                    description = excluded.description, model = excluded.model,
                    tool_use_id = excluded.tool_use_id, status = excluded.status,
                    started_at = excluded.started_at, ended_at = excluded.ended_at,
                    tool_count = excluded.tool_count, current_tool = excluded.current_tool,
                    last_tool = excluded.last_tool, report = excluded.report,
                    report_truncated = excluded.report_truncated,
                    transcript_path = excluded.transcript_path",
                params![
                    sid,
                    a.agent_id,
                    a.seq as i64,
                    a.agent_type,
                    a.description,
                    a.model,
                    a.tool_use_id,
                    a.status.as_str(),
                    fmt_time(a.started_at),
                    a.ended_at.map(fmt_time),
                    a.tool_count as i64,
                    a.current_tool,
                    a.last_tool,
                    a.report,
                    a.report_truncated as i64,
                    a.transcript_path,
                ],
            )
            .map_err(other)?;
        }
        // Même règle qu'en mémoire : les plus anciens finis partent d'abord,
        // jamais un sous-agent en cours.
        tx.execute(
            "DELETE FROM subagents WHERE session = ?1 AND seq IN
                (SELECT seq FROM subagents WHERE session = ?1 AND status != 'running'
                 ORDER BY seq ASC
                 LIMIT max(0, (SELECT COUNT(*) FROM subagents WHERE session = ?1) - ?2))",
            params![sid, MAX_SUBAGENTS as i64],
        )
        .map_err(other)?;
        tx.commit().map_err(other)
    }

    fn delete_subagents(&self, session: &Uuid, agent_ids: &[String]) -> io::Result<()> {
        let mut conn = self.conn.lock().map_err(other)?;
        let tx = conn.transaction().map_err(other)?;
        for id in agent_ids {
            tx.execute(
                "DELETE FROM subagents WHERE session = ?1 AND agent_id = ?2",
                params![session.to_string(), id],
            )
            .map_err(other)?;
        }
        tx.commit().map_err(other)
    }

    fn load_subagents(&self, session: &Uuid) -> io::Result<Vec<Subagent>> {
        let conn = self.conn.lock().map_err(other)?;
        let mut stmt = conn
            .prepare("SELECT * FROM subagents WHERE session = ?1 ORDER BY seq")
            .map_err(other)?;
        let rows = stmt
            .query_map(params![session.to_string()], subagent_from_row)
            .map_err(other)?;
        // Une ligne illisible est ignorée, pas fatale.
        Ok(rows.flatten().flatten().collect())
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
            project_common_dir: Some("/p/.git".into()),
            issue: Some(
                SessionIssue::new(42, "Corriger le relais", "https://github.com/o/r/issues/42")
                    .unwrap(),
            ),
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

    fn agent(id: &str, seq: u64) -> Subagent {
        let mut a = Subagent::new(id, seq, OffsetDateTime::from_unix_timestamp(100).unwrap());
        a.agent_type = Some("general-purpose".into());
        a.description = Some("Première ligne".into());
        a.model = Some("claude-opus-5-5".into());
        a.tool_use_id = Some(format!("toolu_{id}"));
        a.status = SubagentStatus::Done;
        a.ended_at = Some(OffsetDateTime::from_unix_timestamp(110).unwrap());
        a.tool_count = 3;
        a.last_tool = Some("Read".into());
        a.report = Some("# Rapport\nfini".into());
        a.report_truncated = true;
        a.transcript_path = Some("/t/agent.jsonl".into());
        a.notified = true;
        a
    }

    #[test]
    fn subagents_roundtrip_capped_and_deleted_with_their_session() {
        let store = SqliteStore::in_memory().unwrap();
        let (s1, s2) = (Uuid::from_u128(1), Uuid::from_u128(2));
        store.upsert(&record(1, "running", 10)).unwrap();
        let mut running = agent("a0", 0);
        running.status = SubagentStatus::Running;
        running.ended_at = None;
        running.current_tool = Some("Bash".into());
        store
            .upsert_subagents(&s1, &[running.clone(), agent("a1", 1)])
            .unwrap();
        store.upsert_subagents(&s2, &[agent("b0", 0)]).unwrap();
        assert_eq!(
            store.load_subagents(&s1).unwrap(),
            [running.clone(), agent("a1", 1)]
        );
        // Mise à jour d'un agent existant.
        let mut done = running.clone();
        done.status = SubagentStatus::Interrupted;
        store.upsert_subagents(&s1, &[done.clone()]).unwrap();
        assert_eq!(store.load_subagents(&s1).unwrap()[0], done);
        // Au plus MAX_SUBAGENTS par session : les plus anciens partent.
        let many: Vec<Subagent> = (2..MAX_SUBAGENTS as u64 + 5)
            .map(|i| agent(&format!("a{i}"), i))
            .collect();
        store.upsert_subagents(&s1, &many).unwrap();
        let kept = store.load_subagents(&s1).unwrap();
        assert_eq!(kept.len(), MAX_SUBAGENTS);
        assert_eq!(kept[0].agent_id, "a5");
        // Un agent en cours n'est jamais retiré par le plafond.
        let mut old_running = agent("vieux", 0);
        old_running.status = SubagentStatus::Running;
        store.upsert_subagents(&s1, &[old_running]).unwrap();
        let kept = store.load_subagents(&s1).unwrap();
        assert_eq!(kept.len(), MAX_SUBAGENTS);
        assert_eq!(kept[0].agent_id, "vieux");
        assert_eq!(kept[1].agent_id, "a6");
        store.delete_subagents(&s1, &["vieux".to_owned()]).unwrap();
        assert_eq!(store.load_subagents(&s1).unwrap().len(), MAX_SUBAGENTS - 1);
        assert_eq!(store.load_subagents(&s2).unwrap().len(), 1);
        store.delete(&s1).unwrap();
        assert!(store.load_subagents(&s1).unwrap().is_empty());
        assert_eq!(store.load_subagents(&s2).unwrap().len(), 1);
    }

    #[test]
    fn migrates_a_v5_database_keeping_its_rows_then_records_worktrees() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.db");
        {
            let conn = Connection::open(&path).unwrap();
            for m in &MIGRATIONS[..5] {
                conn.execute_batch(m).unwrap();
            }
            conn.pragma_update(None, "user_version", 5).unwrap();
            conn.execute(
                "INSERT INTO sessions (id, claude_session_id, profile, cwd, project_root,
                    status, created_at, updated_at)
                 VALUES (?1, 'c', 'default', '/p', '/p', 'idle', ?2, ?2)",
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
        assert_eq!(all[0].project_common_dir, None);
        let mut r = all[0].clone();
        r.project_common_dir = Some("/p/.git".into());
        store.upsert(&r).unwrap();
        assert_eq!(store.load_all().unwrap()[0], r);

        let w = WorktreeRecord {
            path: "/p-x".into(),
            common_dir: "/p/.git".into(),
            project_root: "/p".into(),
            branch: "x".into(),
            base: Some("main".into()),
            created_branch: true,
            start_sha: Some("abc".into()),
            created_at: OffsetDateTime::from_unix_timestamp(5).unwrap(),
        };
        store.record_worktree(&w).unwrap();
        store.record_worktree(&w).unwrap();
        assert_eq!(store.load_worktrees().unwrap(), std::slice::from_ref(&w));
        store.delete_worktree(Path::new("/autre")).unwrap();
        store.delete_worktree(&w.path).unwrap();
        assert!(store.load_worktrees().unwrap().is_empty());
    }

    #[test]
    fn migrates_a_v6_database_keeping_its_rows_then_records_the_issue() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.db");
        {
            let conn = Connection::open(&path).unwrap();
            for m in &MIGRATIONS[..6] {
                conn.execute_batch(m).unwrap();
            }
            conn.pragma_update(None, "user_version", 6).unwrap();
            conn.execute(
                "INSERT INTO sessions (id, claude_session_id, profile, cwd, project_root,
                    status, created_at, updated_at, project_common_dir)
                 VALUES (?1, 'c', 'default', '/p', '/p', 'idle', ?2, ?2, '/p/.git')",
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
        assert_eq!(
            all[0].project_common_dir.as_deref(),
            Some(Path::new("/p/.git"))
        );
        assert_eq!(all[0].issue, None);
        let mut r = all[0].clone();
        r.issue = Some(SessionIssue::new(7, "Titre", "https://github.com/o/r/issues/7").unwrap());
        store.upsert(&r).unwrap();
        assert_eq!(store.load_all().unwrap()[0], r);
        r.issue = None;
        store.upsert(&r).unwrap();
        assert_eq!(store.load_all().unwrap()[0].issue, None);
        // Une ligne invalide (écrite à la main) est relue sans issue.
        store
            .conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE sessions SET issue_number = 3, issue_title = 'x', issue_url = 'ftp://x'",
                [],
            )
            .unwrap();
        assert_eq!(store.load_all().unwrap()[0].issue, None);
    }

    #[test]
    fn migrates_a_v4_database_keeping_its_rows() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.db");
        {
            let conn = Connection::open(&path).unwrap();
            for m in &MIGRATIONS[..4] {
                conn.execute_batch(m).unwrap();
            }
            conn.pragma_update(None, "user_version", 4).unwrap();
            conn.execute(
                "INSERT INTO sessions (id, claude_session_id, profile, cwd, project_root,
                    status, created_at, updated_at)
                 VALUES (?1, 'c', 'default', '/p', '/p', 'idle', ?2, ?2)",
                params![
                    Uuid::from_u128(9).to_string(),
                    fmt_time(OffsetDateTime::UNIX_EPOCH)
                ],
            )
            .unwrap();
        }
        let store = SqliteStore::open(&path).unwrap();
        assert_eq!(store.load_all().unwrap().len(), 1);
        let id = Uuid::from_u128(9);
        assert!(store.load_subagents(&id).unwrap().is_empty());
        store.upsert_subagents(&id, &[agent("a", 0)]).unwrap();
        assert_eq!(store.load_subagents(&id).unwrap().len(), 1);
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
