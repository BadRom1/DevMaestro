//! Horloge système.

use time::OffsetDateTime;

use crate::ports::Clock;

/// Heure système, en UTC.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> OffsetDateTime {
        OffsetDateTime::now_utc()
    }
}
