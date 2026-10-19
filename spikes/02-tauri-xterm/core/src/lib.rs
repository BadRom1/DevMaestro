//! Cœur du banc d'essai : tout ce qui ne dépend ni de Tauri ni du moteur web
//! (générateur, rejeu, configuration, moteur de sessions, statistiques, /proc, rapport).

pub mod config;
pub mod display;
pub mod engine;
pub mod generator;
pub mod replay;
pub mod report;
pub mod ring;
pub mod sampler;
pub mod stats;
