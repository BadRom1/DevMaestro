//! Modèle de domaine (architecture § 5) et règles pures.

pub mod decision;
pub mod hooks;
pub mod metrics;
pub mod profile;
pub mod project;
pub mod session;
pub mod state;
pub mod statusline;
pub mod transcript;

pub use hooks::{HookCommon, HookEvent, HookKind, HookParseError, ToolCall};
pub use metrics::{Metrics, ModelInfo, RateLimitWindow, RateLimits};
pub use profile::Profile;
pub use project::Project;
pub use session::{
    Pending, PermissionMode, PermissionPending, Question, QuestionOption, QuestionPending,
    SHIFT_TAB_CYCLE, Session, SessionStatus, WaitKind, shift_tab_steps,
};
pub use state::{
    Applied, Effect, PendingRequest, ProcessExit, REASON_DAEMON_RESTART, REASON_PROCESS_EXIT,
    REASON_STOPPED_BY_APP, RequestId, Resolution, SessionState, apply, apply_tracked,
};
pub use statusline::{Statusline, StatuslineParseError};
pub use transcript::PastSession;
