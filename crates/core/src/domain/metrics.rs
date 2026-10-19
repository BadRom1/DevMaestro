//! Mesures d'une session, issues de la statusline (architecture § 6, § 11).

use time::OffsetDateTime;

/// Mesures d'une session. Chaque champ peut être inconnu (principe 4 :
/// se dégrader proprement).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Metrics {
    /// Modèle : identifiant et nom affiché (`model.id`, `model.display_name`).
    pub model: Option<ModelInfo>,
    /// Coût cumulé en dollars (`cost.total_cost_usd`).
    pub cost_usd: Option<f64>,
    /// Part du contexte utilisée, en % (`context_window.used_percentage`).
    pub context_used_pct: Option<f64>,
    /// Taille de la fenêtre de contexte en tokens (`context_window.context_window_size`).
    pub context_window_size: Option<u64>,
    /// Tokens d'entrée + de sortie cumulés (`context_window.total_input_tokens`
    /// + `total_output_tokens`).
    pub total_tokens: Option<u64>,
    /// Quotas du compte, souvent absents (abonnements Pro/Max seulement).
    pub rate_limits: RateLimits,
    /// Nom de session donné par Claude Code (`session_name`).
    pub session_name: Option<String>,
}

/// Modèle d'une session.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ModelInfo {
    /// Identifiant (`claude-opus-5-5`).
    pub id: Option<String>,
    /// Nom affiché (`Opus 5.5`).
    pub display_name: Option<String>,
}

/// Quotas 5 h et 7 jours, chacun pouvant être inconnu.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RateLimits {
    pub five_hour: Option<RateLimitWindow>,
    pub seven_day: Option<RateLimitWindow>,
}

/// Une fenêtre de quota.
#[derive(Debug, Clone, PartialEq)]
pub struct RateLimitWindow {
    /// Part utilisée, en %.
    pub used_pct: Option<f64>,
    /// Date de remise à zéro.
    pub resets_at: Option<OffsetDateTime>,
}

impl Metrics {
    /// Fusionne des mesures plus récentes : un champ connu remplace l'ancien,
    /// un champ inconnu garde l'ancienne valeur (les quotas, notamment,
    /// manquent dans certaines statuslines).
    pub fn merge(&mut self, newer: Metrics) {
        fn keep<T>(old: &mut Option<T>, new: Option<T>) {
            if new.is_some() {
                *old = new;
            }
        }
        keep(&mut self.model, newer.model);
        keep(&mut self.cost_usd, newer.cost_usd);
        keep(&mut self.context_used_pct, newer.context_used_pct);
        keep(&mut self.context_window_size, newer.context_window_size);
        keep(&mut self.total_tokens, newer.total_tokens);
        keep(&mut self.rate_limits.five_hour, newer.rate_limits.five_hour);
        keep(&mut self.rate_limits.seven_day, newer.rate_limits.seven_day);
        keep(&mut self.session_name, newer.session_name);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_keeps_known_values() {
        let mut m = Metrics {
            cost_usd: Some(1.0),
            rate_limits: RateLimits {
                five_hour: Some(RateLimitWindow {
                    used_pct: Some(2.0),
                    resets_at: None,
                }),
                seven_day: None,
            },
            ..Metrics::default()
        };
        m.merge(Metrics {
            cost_usd: Some(1.5),
            ..Metrics::default()
        });
        assert_eq!(m.cost_usd, Some(1.5));
        assert!(m.rate_limits.five_hour.is_some());
    }
}
