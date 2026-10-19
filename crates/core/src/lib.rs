//! Cœur de DevMaestro : domaine, ports et adaptateurs.
//!
//! - [`domain`] : modèle (profil, projet, session), lecture des hooks et de la
//!   statusline, machine à états des sessions. Code pur, sans entrée-sortie.
//! - [`ports`] : interfaces dont le domaine et le démon ont besoin.
//! - [`adapters`] : implémentations concrètes (horloge système, détection des
//!   profils, lecture des transcripts).
//!
//! - [`protocol`] : trames et messages du socket du démon (`docs/protocole.md`).
//! - [`daemon`] : le démon `orchd` (sessions dans des PTY, socket, base).
//! - [`relay`] : relais `orchd hook <événement>` et `orchd statusline`.
//! - [`ctl`] : petit client de mise au point (`orchd ctl`).
//!
//! Le domaine ne dépend d'aucun adaptateur.

pub mod adapters;
pub mod ctl;
pub mod daemon;
pub mod domain;
pub mod paths;
pub mod ports;
pub mod protocol;
pub mod relay;
