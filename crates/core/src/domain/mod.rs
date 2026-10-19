//! Modèle de domaine (architecture § 5) et règles pures.

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
    Pending, PermissionMode, PermissionPending, Question, QuestionOption, QuestionPending, Session,
    SessionStatus, WaitKind,
};
pub use state::{Effect, PendingRequest, RequestId, Resolution, SessionState, apply};
pub use statusline::{Statusline, StatuslineParseError};
pub use transcript::PastSession;
