//! Adaptateurs : implémentations concrètes des ports.

pub mod clock;
pub mod fs_files;
pub mod git_cli;
pub mod git_diff;
pub mod profiles;
pub mod pty;
pub mod sqlite;
pub mod transcripts;
pub mod usage_api;

pub use clock::SystemClock;
pub use fs_files::FsFiles;
pub use git_cli::GitCli;
pub use git_diff::GitDiff;
pub use profiles::{FsProfileSource, discover_profiles};
pub use pty::NativePty;
pub use sqlite::SqliteStore;
pub use transcripts::{FsTranscriptSource, list_past_sessions};
pub use usage_api::UsageApi;
