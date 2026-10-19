//! Journal du démon : sur la sortie d'erreur et dans
//! `$XDG_STATE_HOME/devmaestro/orchd.log` (ajout en fin de fichier).

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;

use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

static FILE: Mutex<Option<File>> = Mutex::new(None);

/// Ouvre le fichier du journal (en plus de la sortie d'erreur).
pub fn init(path: &Path) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    use std::os::unix::fs::OpenOptionsExt;
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(path)?;
    *FILE.lock().unwrap_or_else(|e| e.into_inner()) = Some(file);
    Ok(())
}

/// Écrit une ligne : date, niveau, message.
pub fn write(level: &str, args: std::fmt::Arguments<'_>) {
    let now = OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_default();
    let line = format!("{now} {level} {args}\n");
    let _ = std::io::stderr().write_all(line.as_bytes());
    if let Some(f) = FILE.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
        let _ = f.write_all(line.as_bytes());
    }
}

macro_rules! info {
    ($($t:tt)*) => { $crate::daemon::log::write("INFO", format_args!($($t)*)) };
}
macro_rules! warning {
    ($($t:tt)*) => { $crate::daemon::log::write("ATTENTION", format_args!($($t)*)) };
}
macro_rules! error {
    ($($t:tt)*) => { $crate::daemon::log::write("ERREUR", format_args!($($t)*)) };
}

pub(crate) use {error, info, warning};
