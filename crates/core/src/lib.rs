//! Cœur de DevMaestro : domaine, ports et adaptateurs.
//!
//! - [`domain`] : modèle (profil, projet, session), lecture des hooks et de la
//!   statusline, machine à états des sessions. Code pur, sans entrée-sortie.
//! - [`ports`] : interfaces dont le domaine et le démon ont besoin.
//! - [`adapters`] : implémentations concrètes (horloge système, détection des
//!   profils, lecture des transcripts).
//!
//! Le domaine ne dépend d'aucun adaptateur.

pub mod adapters;
pub mod domain;
pub mod ports;
