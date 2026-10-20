//! Quotas par l'API d'usage de Claude Code (`GET /api/oauth/usage`, non
//! documentée ; la même que la statusline et le garde-fou de quota de
//! l'utilisateur).
//!
//! Le jeton OAuth du profil est lu (lecture seule) dans
//! `<dossier du profil>/.credentials.json` (`claudeAiOauth.accessToken`) à
//! chaque appel, et n'est envoyé qu'à [`USAGE_API_URL`] en HTTPS. Il n'est
//! jamais écrit, journalisé ni renvoyé aux clients. Un jeton expiré n'est pas
//! renouvelé par DevMaestro (« jeton expiré ») : c'est à Claude Code de le
//! faire, à sa prochaine requête. Ni redirection ni mandataire : le jeton va
//! directement à l'hôte de l'API.

use std::path::Path;
use std::time::Duration;

use serde_json::Value;
use time::OffsetDateTime;

use crate::domain::{Profile, QuotaReading, parse_usage_response};
use crate::ports::QuotaSource;

/// Point d'accès de l'API d'usage.
pub const USAGE_API_URL: &str = "https://api.anthropic.com/api/oauth/usage";
/// En-tête bêta exigé par l'API (relevé dans les scripts de l'utilisateur).
const OAUTH_BETA: &str = "oauth-2025-04-20";
/// Délai maximal d'un appel.
const TIMEOUT: Duration = Duration::from_secs(10);
/// Taille maximale de la réponse lue.
const MAX_BODY: u64 = 1024 * 1024;

/// [`QuotaSource`] par l'API d'usage.
pub struct UsageApi {
    url: String,
    agent: ureq::Agent,
}

impl UsageApi {
    /// Client vers `url` (tests : un serveur local en HTTP).
    pub fn new(url: impl Into<String>) -> Self {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(TIMEOUT))
            // Jamais de redirection : le jeton ne part que vers `url`.
            .max_redirects(0)
            // Jamais de mandataire (`HTTPS_PROXY`…) : le jeton va directement
            // à l'API, sans passer par un tiers.
            .proxy(None)
            .http_status_as_error(false)
            .user_agent(concat!("devmaestro-orchd/", env!("CARGO_PKG_VERSION")))
            .build()
            .into();
        Self {
            url: url.into(),
            agent,
        }
    }

    /// Client du démon : [`USAGE_API_URL`]. Seul un binaire construit avec
    /// la fonctionnalité `test-support` (tests) lit `DEVMAESTRO_USAGE_API_URL`
    /// pour viser un serveur de test local.
    pub fn from_env() -> Self {
        #[cfg(feature = "test-support")]
        if let Some(url) = std::env::var("DEVMAESTRO_USAGE_API_URL")
            .ok()
            .filter(|u| !u.is_empty())
        {
            return Self::new(url);
        }
        Self::new(USAGE_API_URL)
    }
}

/// Jeton OAuth du profil, s'il est valable à `now`.
pub fn read_token(config_dir: &Path, now: OffsetDateTime) -> Result<String, String> {
    let path = config_dir.join(".credentials.json");
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err("aucun jeton OAuth : Claude Code n'est pas connecté avec ce profil".into());
        }
        Err(e) => return Err(format!("identifiants de Claude Code illisibles : {e}")),
    };
    let v: Value = serde_json::from_str(&text)
        .map_err(|_| "identifiants de Claude Code illisibles (JSON invalide)".to_owned())?;
    let oauth = &v["claudeAiOauth"];
    let token = oauth["accessToken"]
        .as_str()
        .filter(|t| !t.is_empty())
        .ok_or("aucun jeton OAuth : Claude Code n'est pas connecté avec ce profil")?;
    if let Some(ms) = oauth["expiresAt"].as_i64() {
        let now_ms = (now.unix_timestamp_nanos() / 1_000_000) as i64;
        if ms <= now_ms {
            return Err("jeton expiré : Claude Code le renouvellera à sa prochaine requête".into());
        }
    }
    Ok(token.to_owned())
}

impl QuotaSource for UsageApi {
    fn fetch(&self, profile: &Profile, now: OffsetDateTime) -> Result<QuotaReading, String> {
        let token = read_token(&profile.config_dir, now)?;
        let response = self
            .agent
            .get(&self.url)
            .header("Authorization", &format!("Bearer {token}"))
            .header("anthropic-beta", OAUTH_BETA)
            .header("Accept", "application/json")
            .call();
        drop(token);
        let mut response = response.map_err(|e| format!("API d'usage injoignable : {e}"))?;
        let status = response.status().as_u16();
        match status {
            200 => {}
            401 | 403 => {
                return Err(format!(
                    "jeton refusé par l'API d'usage (HTTP {status}) : Claude Code le renouvellera"
                ));
            }
            _ => {
                return Err(format!(
                    "réponse inattendue de l'API d'usage (HTTP {status})"
                ));
            }
        }
        let body = response
            .body_mut()
            .with_config()
            .limit(MAX_BODY)
            .read_to_string()
            .map_err(|e| format!("réponse de l'API d'usage illisible : {e}"))?;
        parse_usage_response(&body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;

    const TOKEN: &str = "sk-ant-oat01-jeton-de-test-secret";

    fn credentials(dir: &Path, expires_ms: i64) {
        std::fs::write(
            dir.join(".credentials.json"),
            format!(
                r#"{{"claudeAiOauth":{{"accessToken":"{TOKEN}","refreshToken":"r","expiresAt":{expires_ms},"scopes":[]}}}}"#
            ),
        )
        .unwrap();
    }

    /// Serveur HTTP d'une requête : renvoie `status` et `body`, et les lignes
    /// d'en-tête reçues.
    fn stub(status: u16, body: &'static str) -> (String, std::thread::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/api/oauth/usage", listener.local_addr().unwrap());
        let h = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut lines = Vec::new();
            let mut r = BufReader::new(s.try_clone().unwrap());
            loop {
                let mut l = String::new();
                r.read_line(&mut l).unwrap();
                if l.trim().is_empty() {
                    break;
                }
                lines.push(l.trim().to_owned());
            }
            write!(
                s,
                "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
            lines
        });
        (url, h)
    }

    fn now() -> OffsetDateTime {
        OffsetDateTime::from_unix_timestamp(1_800_000_000).unwrap()
    }

    #[test]
    fn fetches_with_the_token_and_beta_header() {
        let dir = tempfile::tempdir().unwrap();
        credentials(dir.path(), 1_800_000_000_000 + 3_600_000);
        let (url, h) = stub(
            200,
            r#"{"five_hour":{"utilization":12.0,"resets_at":"2026-10-20T13:00:00+00:00"},"seven_day":{"utilization":35.0,"resets_at":null}}"#,
        );
        let profile = Profile::named("p", dir.path());
        let r = UsageApi::new(url).fetch(&profile, now()).unwrap();
        assert_eq!(r.five_hour.unwrap().used_percentage, 12.0);
        assert_eq!(r.seven_day.unwrap().resets_at, None);
        let headers = h.join().unwrap();
        assert!(
            headers[0].starts_with("GET /api/oauth/usage "),
            "{headers:?}"
        );
        let has = |h: &str| headers.iter().any(|l| l.eq_ignore_ascii_case(h));
        assert!(
            has(&format!("authorization: Bearer {TOKEN}")),
            "{headers:?}"
        );
        assert!(has("anthropic-beta: oauth-2025-04-20"), "{headers:?}");
    }

    #[test]
    fn errors_never_contain_the_token() {
        let dir = tempfile::tempdir().unwrap();
        let profile = Profile::named("p", dir.path());
        let api = UsageApi::new("http://127.0.0.1:1/api/oauth/usage");
        let e = api.fetch(&profile, now()).unwrap_err();
        assert!(e.contains("aucun jeton OAuth"), "{e}");

        credentials(dir.path(), 1_800_000_000_000 - 1);
        let e = api.fetch(&profile, now()).unwrap_err();
        assert!(e.contains("jeton expiré"), "{e}");

        credentials(dir.path(), 1_800_000_000_000 + 3_600_000);
        let e = api.fetch(&profile, now()).unwrap_err();
        assert!(e.contains("injoignable"), "{e}");
        assert!(!e.contains(TOKEN));

        let (url, h) = stub(401, r#"{"error":"x"}"#);
        let e = UsageApi::new(url).fetch(&profile, now()).unwrap_err();
        assert!(e.contains("HTTP 401") && !e.contains(TOKEN), "{e}");
        h.join().unwrap();

        let (url, h) = stub(200, "<html>pas du json</html>");
        let e = UsageApi::new(url).fetch(&profile, now()).unwrap_err();
        assert!(e.contains("illisible") && !e.contains(TOKEN), "{e}");
        h.join().unwrap();

        std::fs::write(dir.path().join(".credentials.json"), "{").unwrap();
        let e = api.fetch(&profile, now()).unwrap_err();
        assert!(e.contains("illisibles"), "{e}");
    }
}
