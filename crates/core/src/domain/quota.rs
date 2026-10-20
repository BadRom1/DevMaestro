//! Quotas du compte Claude (fenêtres de 5 h et de 7 jours), par profil
//! (architecture § 11). Deux sources : la statusline (`rate_limits`, souvent
//! absente des versions récentes de Claude Code) et l'API d'usage de Claude
//! Code (`/api/oauth/usage`, non documentée), interrogée par le démon. La
//! lecture la plus récente l'emporte.

use serde_json::Value;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use super::metrics::{RateLimitWindow, RateLimits};

/// Une fenêtre de quota.
#[derive(Debug, Clone, PartialEq)]
pub struct QuotaWindow {
    /// Part utilisée, en %.
    pub used_percentage: f64,
    /// Remise à zéro, si connue.
    pub resets_at: Option<OffsetDateTime>,
}

/// Une lecture des quotas.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct QuotaReading {
    pub five_hour: Option<QuotaWindow>,
    pub seven_day: Option<QuotaWindow>,
}

/// D'où vient une lecture.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuotaOrigin {
    UsageApi,
    Statusline,
}

impl QuotaOrigin {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UsageApi => "usage_api",
            Self::Statusline => "statusline",
        }
    }
}

/// Date de remise à zéro : texte RFC 3339 (ISO 8601), ou nombre de secondes
/// (ou de millisecondes) depuis 1970.
fn parse_reset(v: &Value) -> Option<OffsetDateTime> {
    match v {
        Value::String(s) => OffsetDateTime::parse(s, &Rfc3339).ok(),
        Value::Number(n) => {
            // Secondes, ou millisecondes au-delà de 1e11 (an 5138 en secondes).
            let v = n.as_f64()?;
            let secs = if v.abs() > 1e11 { v / 1000.0 } else { v };
            OffsetDateTime::from_unix_timestamp(secs as i64).ok()
        }
        _ => None,
    }
}

/// Une fenêtre de la réponse : `utilization` (ou `used_percentage` selon les
/// versions) et `resets_at`. Absente, `null` ou sans pourcentage : `None`.
fn parse_window(v: &Value) -> Option<QuotaWindow> {
    let pct = v
        .get("utilization")
        .filter(|u| !u.is_null())
        .or_else(|| v.get("used_percentage"))?
        .as_f64()?;
    Some(QuotaWindow {
        used_percentage: pct,
        resets_at: v.get("resets_at").and_then(parse_reset),
    })
}

/// Lit la réponse de `GET /api/oauth/usage` :
/// `{"five_hour": {"utilization": 12.0, "resets_at": "…"}, "seven_day": {…}, …}`
/// (les autres champs sont ignorés).
pub fn parse_usage_response(text: &str) -> Result<QuotaReading, String> {
    let v: Value = serde_json::from_str(text)
        .map_err(|e| format!("réponse de l'API d'usage illisible : {e}"))?;
    if !v.is_object() {
        return Err("réponse de l'API d'usage inattendue (objet JSON attendu)".into());
    }
    Ok(QuotaReading {
        five_hour: v.get("five_hour").and_then(parse_window),
        seven_day: v.get("seven_day").and_then(parse_window),
    })
}

fn from_rate_window(w: &Option<RateLimitWindow>) -> Option<QuotaWindow> {
    let w = w.as_ref()?;
    Some(QuotaWindow {
        used_percentage: w.used_pct?,
        resets_at: w.resets_at,
    })
}

/// Lecture tirée des `rate_limits` d'une statusline, s'il y en a une.
pub fn reading_from_rate_limits(r: &RateLimits) -> Option<QuotaReading> {
    let reading = QuotaReading {
        five_hour: from_rate_window(&r.five_hour),
        seven_day: from_rate_window(&r.seven_day),
    };
    (reading.five_hour.is_some() || reading.seven_day.is_some()).then_some(reading)
}

/// Une fenêtre retenue : sa valeur, sa source et la date de la lecture.
#[derive(Debug, Clone, PartialEq)]
pub struct WindowReading {
    pub window: QuotaWindow,
    pub origin: QuotaOrigin,
    pub at: OffsetDateTime,
}

/// Une lecture de statusline sans date de remise à zéro n'est plus montrée
/// au-delà de ce délai (6 h).
pub const STATUSLINE_UNDATED_TTL: time::Duration = time::Duration::hours(6);

/// Quotas connus d'un profil : chaque fenêtre garde sa propre lecture la
/// plus récente (non nulle), quelle qu'en soit la source.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ProfileQuotas {
    pub five_hour: Option<WindowReading>,
    pub seven_day: Option<WindowReading>,
    /// Erreur du dernier appel à l'API (texte en français), s'il a échoué.
    pub api_error: Option<String>,
}

impl ProfileQuotas {
    /// Fusionne une lecture : une fenêtre connue remplace l'ancienne si elle
    /// n'est pas plus ancienne ; une fenêtre absente garde l'ancienne.
    pub fn merge(&mut self, reading: QuotaReading, origin: QuotaOrigin, at: OffsetDateTime) {
        fn keep(
            slot: &mut Option<WindowReading>,
            w: Option<QuotaWindow>,
            origin: QuotaOrigin,
            at: OffsetDateTime,
        ) {
            if let Some(window) = w
                && slot.as_ref().is_none_or(|old| old.at <= at)
            {
                *slot = Some(WindowReading { window, origin, at });
            }
        }
        keep(&mut self.five_hour, reading.five_hour, origin, at);
        keep(&mut self.seven_day, reading.seven_day, origin, at);
    }

    /// Une fenêtre telle qu'à montrer à `now` : `None` si sa remise à zéro
    /// est passée, ou pour une lecture de statusline non datée de plus de
    /// [`STATUSLINE_UNDATED_TTL`].
    pub fn visible(slot: &Option<WindowReading>, now: OffsetDateTime) -> Option<&WindowReading> {
        let r = slot.as_ref()?;
        match r.window.resets_at {
            Some(reset) if reset <= now => None,
            None if r.origin == QuotaOrigin::Statusline && now - r.at > STATUSLINE_UNDATED_TTL => {
                None
            }
            _ => Some(r),
        }
    }

    /// Lecture visible la plus récente, toutes fenêtres confondues.
    pub fn latest(&self, now: OffsetDateTime) -> Option<&WindowReading> {
        [
            Self::visible(&self.five_hour, now),
            Self::visible(&self.seven_day, now),
        ]
        .into_iter()
        .flatten()
        .max_by_key(|r| r.at)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Forme réelle de la réponse (relevée par les scripts de l'utilisateur).
    const RESPONSE: &str = r#"{
        "five_hour": {"utilization": 12.0, "resets_at": "2026-10-20T13:00:00.123456+00:00"},
        "seven_day": {"utilization": 35.5, "resets_at": "2026-10-24T08:00:00+00:00"},
        "seven_day_oauth_apps": null,
        "seven_day_opus": {"utilization": 0.0, "resets_at": null},
        "extra_usage": {"is_enabled": false},
        "limits": [{"kind": "weekly_scoped", "percent": 3,
                    "scope": {"model": {"display_name": "Fable"}}}]
    }"#;

    #[test]
    fn parses_the_usage_response() {
        let r = parse_usage_response(RESPONSE).unwrap();
        let five = r.five_hour.unwrap();
        assert_eq!(five.used_percentage, 12.0);
        assert_eq!(
            five.resets_at.unwrap(),
            OffsetDateTime::parse("2026-10-20T13:00:00.123456Z", &Rfc3339).unwrap()
        );
        assert_eq!(r.seven_day.unwrap().used_percentage, 35.5);

        let r = parse_usage_response(
            r#"{"five_hour": {"used_percentage": 4, "resets_at": 1792400000}, "seven_day": null}"#,
        )
        .unwrap();
        assert_eq!(r.five_hour.as_ref().unwrap().used_percentage, 4.0);
        let ms = parse_usage_response(
            r#"{"five_hour": {"utilization": 1, "resets_at": 1792400000000}}"#,
        )
        .unwrap();
        assert_eq!(
            ms.five_hour.unwrap().resets_at,
            OffsetDateTime::from_unix_timestamp(1_792_400_000).ok()
        );
        assert!(r.five_hour.unwrap().resets_at.is_some());
        assert_eq!(r.seven_day, None);
        assert_eq!(
            parse_usage_response(r#"{"five_hour": {"resets_at": null}}"#)
                .unwrap()
                .five_hour,
            None
        );
        assert!(parse_usage_response("<html>").is_err());
        assert!(parse_usage_response("[]").is_err());
    }

    #[test]
    fn each_window_keeps_its_most_recent_reading() {
        let t = |s: i64| OffsetDateTime::from_unix_timestamp(s).unwrap();
        let w = |pct: f64, reset: Option<i64>| QuotaWindow {
            used_percentage: pct,
            resets_at: reset.map(t),
        };
        let far = Some(10_000_000);
        let mut q = ProfileQuotas::default();
        assert!(q.latest(t(0)).is_none());
        q.merge(
            QuotaReading {
                five_hour: Some(w(10.0, far)),
                seven_day: Some(w(30.0, far)),
            },
            QuotaOrigin::UsageApi,
            t(100),
        );
        // Statusline plus récente, sans fenêtre de 7 jours : seule la 5 h change.
        q.merge(
            QuotaReading {
                five_hour: Some(w(20.0, far)),
                seven_day: None,
            },
            QuotaOrigin::Statusline,
            t(200),
        );
        let now = t(300);
        let five = ProfileQuotas::visible(&q.five_hour, now).unwrap();
        assert_eq!(
            (five.window.used_percentage, five.origin, five.at),
            (20.0, QuotaOrigin::Statusline, t(200))
        );
        let seven = ProfileQuotas::visible(&q.seven_day, now).unwrap();
        assert_eq!((seven.origin, seven.at), (QuotaOrigin::UsageApi, t(100)));
        assert_eq!(q.latest(now).unwrap().at, t(200));
        // Une lecture plus ancienne ne remplace rien.
        q.merge(
            QuotaReading {
                five_hour: Some(w(1.0, far)),
                seven_day: None,
            },
            QuotaOrigin::UsageApi,
            t(150),
        );
        assert_eq!(q.five_hour.as_ref().unwrap().window.used_percentage, 20.0);
        // Remise à zéro passée : fenêtre masquée.
        q.merge(
            QuotaReading {
                five_hour: Some(w(50.0, Some(400))),
                seven_day: None,
            },
            QuotaOrigin::UsageApi,
            t(350),
        );
        assert!(ProfileQuotas::visible(&q.five_hour, t(399)).is_some());
        assert!(ProfileQuotas::visible(&q.five_hour, t(400)).is_none());
        // Statusline non datée : visible 6 h.
        q.merge(
            QuotaReading {
                five_hour: Some(w(5.0, None)),
                seven_day: None,
            },
            QuotaOrigin::Statusline,
            t(1000),
        );
        assert!(ProfileQuotas::visible(&q.five_hour, t(1000 + 6 * 3600)).is_some());
        assert!(ProfileQuotas::visible(&q.five_hour, t(1001 + 6 * 3600)).is_none());

        let rl = RateLimits {
            five_hour: Some(RateLimitWindow {
                used_pct: Some(2.0),
                resets_at: None,
            }),
            seven_day: Some(RateLimitWindow {
                used_pct: None,
                resets_at: None,
            }),
        };
        let r = reading_from_rate_limits(&rl).unwrap();
        assert_eq!(r.five_hour.unwrap().used_percentage, 2.0);
        assert_eq!(r.seven_day, None);
        assert_eq!(reading_from_rate_limits(&RateLimits::default()), None);
    }
}
