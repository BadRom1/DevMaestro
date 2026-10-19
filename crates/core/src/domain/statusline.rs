//! Lecture tolérante du JSON que Claude Code envoie à la statusline
//! (prototype n° 1, Q4). Tous les champs sont facultatifs ; un champ absent,
//! nul ou mal typé est lu comme inconnu.

use serde_json::Value;
use thiserror::Error;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use super::metrics::{Metrics, ModelInfo, RateLimitWindow, RateLimits};

/// Une statusline lue : les mesures, et de quoi la rattacher à une session.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Statusline {
    pub session_id: Option<String>,
    /// `workspace.current_dir`, à défaut `cwd`.
    pub current_dir: Option<String>,
    /// `workspace.project_dir`.
    pub project_dir: Option<String>,
    /// `workspace.git_worktree`, présent quand la session tourne dans un worktree.
    pub git_worktree: Option<String>,
    pub metrics: Metrics,
}

/// Statusline inexploitable.
#[derive(Debug, Error)]
pub enum StatuslineParseError {
    #[error("JSON de statusline invalide : {0}")]
    InvalidJson(#[from] serde_json::Error),
    #[error("le JSON de statusline n'est pas un objet")]
    NotAnObject,
}

impl Statusline {
    /// Lit le JSON reçu sur stdin par `orchd statusline`.
    pub fn parse(input: &str) -> Result<Self, StatuslineParseError> {
        let value: Value = serde_json::from_str(input)?;
        Self::from_value(&value)
    }

    /// Comme [`Statusline::parse`], depuis un JSON déjà décodé.
    pub fn from_value(v: &Value) -> Result<Self, StatuslineParseError> {
        if !v.is_object() {
            return Err(StatuslineParseError::NotAnObject);
        }
        let ctx = &v["context_window"];
        let input_tokens = ctx["total_input_tokens"].as_u64();
        let output_tokens = ctx["total_output_tokens"].as_u64();
        let total_tokens = match (input_tokens, output_tokens) {
            (None, None) => None,
            (i, o) => Some(i.unwrap_or(0).saturating_add(o.unwrap_or(0))),
        };
        let metrics = Metrics {
            model: Some(ModelInfo {
                id: string(&v["model"]["id"]),
                display_name: string(&v["model"]["display_name"]),
            })
            .filter(|m| m.id.is_some() || m.display_name.is_some()),
            cost_usd: v["cost"]["total_cost_usd"].as_f64(),
            context_used_pct: ctx["used_percentage"].as_f64(),
            context_window_size: ctx["context_window_size"].as_u64(),
            total_tokens,
            rate_limits: RateLimits {
                five_hour: window(&v["rate_limits"]["five_hour"]),
                seven_day: window(&v["rate_limits"]["seven_day"]),
            },
            session_name: string(&v["session_name"]),
        };
        let ws = &v["workspace"];
        Ok(Self {
            session_id: string(&v["session_id"]),
            current_dir: string(&ws["current_dir"]).or_else(|| string(&v["cwd"])),
            project_dir: string(&ws["project_dir"]),
            git_worktree: string(&ws["git_worktree"]),
            metrics,
        })
    }
}

fn string(v: &Value) -> Option<String> {
    v.as_str().map(str::to_owned)
}

fn window(v: &Value) -> Option<RateLimitWindow> {
    if !v.is_object() {
        return None;
    }
    Some(RateLimitWindow {
        used_pct: v["used_percentage"].as_f64(),
        resets_at: timestamp(&v["resets_at"]),
    })
}

/// Date en secondes Unix (forme constatée) ou en RFC 3339 (au cas où).
fn timestamp(v: &Value) -> Option<OffsetDateTime> {
    match v {
        Value::Number(n) => {
            let secs = n.as_i64().or_else(|| n.as_f64().map(|f| f as i64))?;
            OffsetDateTime::from_unix_timestamp(secs).ok()
        }
        Value::String(s) => OffsetDateTime::parse(s, &Rfc3339).ok(),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_full_statusline() {
        let s = Statusline::parse(
            r#"{"session_id":"abc","cwd":"~/x","session_name":"Salutation",
            "model":{"id":"claude-opus-5-5","display_name":"Opus 5.5"},
            "workspace":{"current_dir":"~/x/wt","project_dir":"~/x","git_worktree":"wt"},
            "cost":{"total_cost_usd":0.220423},
            "context_window":{"total_input_tokens":26670,"total_output_tokens":50,
              "context_window_size":1000000,"used_percentage":3},
            "rate_limits":{"five_hour":{"used_percentage":2,"resets_at":1792405800},
              "seven_day":{"used_percentage":1.5,"resets_at":"2026-10-24T08:00:00Z"}}}"#,
        )
        .unwrap();
        assert_eq!(s.session_id.as_deref(), Some("abc"));
        assert_eq!(s.current_dir.as_deref(), Some("~/x/wt"));
        assert_eq!(s.git_worktree.as_deref(), Some("wt"));
        let m = &s.metrics;
        let model = m.model.as_ref().unwrap();
        assert_eq!(model.id.as_deref(), Some("claude-opus-5-5"));
        assert_eq!(model.display_name.as_deref(), Some("Opus 5.5"));
        assert_eq!(m.cost_usd, Some(0.220423));
        assert_eq!(m.context_used_pct, Some(3.0));
        assert_eq!(m.context_window_size, Some(1_000_000));
        assert_eq!(m.total_tokens, Some(26_720));
        assert_eq!(m.session_name.as_deref(), Some("Salutation"));
        let five = m.rate_limits.five_hour.as_ref().unwrap();
        assert_eq!(five.used_pct, Some(2.0));
        assert_eq!(five.resets_at.unwrap().unix_timestamp(), 1_792_405_800);
        assert!(
            m.rate_limits
                .seven_day
                .as_ref()
                .unwrap()
                .resets_at
                .is_some()
        );
    }

    #[test]
    fn missing_and_null_fields_are_unknown() {
        let s = Statusline::parse(
            r#"{"model":{"id":"m"},"context_window":{"used_percentage":null},"rate_limits":"?"}"#,
        )
        .unwrap();
        assert_eq!(s.metrics.model.as_ref().unwrap().id.as_deref(), Some("m"));
        assert_eq!(s.metrics.context_used_pct, None);
        assert_eq!(s.metrics.total_tokens, None);
        assert_eq!(s.metrics.rate_limits, RateLimits::default());
        assert_eq!(s.current_dir, None);
    }

    #[test]
    fn bad_input_is_an_error() {
        assert!(Statusline::parse("nope").is_err());
        assert!(matches!(
            Statusline::parse("42"),
            Err(StatuslineParseError::NotAnObject)
        ));
    }
}
