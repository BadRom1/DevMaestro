//! Ports : interfaces implémentées par les adaptateurs.
//!
//! Lot 1 : l'horloge et la découverte des profils et des anciennes sessions.
//! Les autres ports de l'architecture (§ 16 : `Pty`, `Vcs`, `Forge`,
//! `QuotaSource`, `Store`, `Notifier`) arrivent avec les lots qui en ont besoin.

use std::io;

use time::OffsetDateTime;

use crate::domain::{PastSession, Profile};

/// Source de l'heure courante (remplaçable dans les tests).
pub trait Clock {
    fn now(&self) -> OffsetDateTime;
}

/// Découverte des profils Claude Code installés.
pub trait ProfileSource {
    fn profiles(&self) -> io::Result<Vec<Profile>>;
}

/// Découverte des anciennes sessions d'un profil, de la plus récente à la
/// plus ancienne, au plus `limit` si elle est donnée.
pub trait TranscriptSource {
    fn past_sessions(
        &self,
        profile: &Profile,
        limit: Option<usize>,
    ) -> io::Result<Vec<PastSession>>;
}
