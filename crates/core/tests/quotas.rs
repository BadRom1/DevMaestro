//! Quotas des profils : API d'usage de Claude Code (serveur local de test,
//! `DEVMAESTRO_USAGE_API_URL`, lu seulement par un binaire `test-support`),
//! tournées détachées, intervalle minimal, réglage `[quotas] usage_api`.

mod common;

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use common::*;
use serde_json::{Value, json};

const TOKEN: &str = "sk-ant-oat01-jeton-de-test-a-ne-jamais-journaliser";

const RESPONSE: &str = r#"{"five_hour":{"utilization":12.0,"resets_at":"2099-10-20T13:00:00.123456+00:00"},"seven_day":{"utilization":35.5,"resets_at":"2099-10-24T08:00:00+00:00"},"seven_day_opus":null,"limits":[]}"#;

/// Serveur HTTP local : répond `RESPONSE` après `delay` à chaque requête et
/// garde les en-têtes reçus.
fn usage_stub(delay: Duration) -> (String, Arc<Mutex<Vec<Vec<String>>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/api/oauth/usage", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut s) = stream else { continue };
            let log = log.clone();
            std::thread::spawn(move || {
                let mut r = BufReader::new(s.try_clone().unwrap());
                let mut headers = Vec::new();
                loop {
                    let mut l = String::new();
                    if r.read_line(&mut l).unwrap_or(0) == 0 || l.trim().is_empty() {
                        break;
                    }
                    headers.push(l.trim().to_owned());
                }
                log.lock().unwrap().push(headers);
                std::thread::sleep(delay);
                let _ = write!(
                    s,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{RESPONSE}",
                    RESPONSE.len()
                );
            });
        }
    });
    (url, seen)
}

fn credentials(env: &Env, expires_ms: i64) {
    std::fs::write(
        env.home.join(".claude/.credentials.json"),
        format!(
            r#"{{"claudeAiOauth":{{"accessToken":"{TOKEN}","refreshToken":"r","expiresAt":{expires_ms},"scopes":["user:inference"]}}}}"#
        ),
    )
    .unwrap();
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

/// Attend que `quotas.get` (ou un `quotas.updated` reçu) vérifie `cond`.
fn wait_quotas(c: &mut Client, what: &str, cond: impl Fn(&Value) -> bool) -> Value {
    let start = Instant::now();
    loop {
        if let Some(q) = last_quotas(c).filter(|q| cond(q)) {
            return q;
        }
        let q = c.call("quotas.get", json!({}));
        if cond(&q) {
            return q;
        }
        assert!(start.elapsed() < Duration::from_secs(10), "{what} : {q}");
        c.pump(Duration::from_millis(50));
    }
}

/// Dernier `quotas.updated` reçu.
fn last_quotas(c: &Client) -> Option<Value> {
    c.notifications
        .iter()
        .rev()
        .find(|n| n["method"] == "quotas.updated")
        .map(|n| n["params"].clone())
}

#[test]
fn quotas_from_the_usage_api() {
    let (url, seen) = usage_stub(Duration::ZERO);
    let mut env = Env::new();
    env.usage_api_url = url;
    env.extra_env
        .push(("DEVMAESTRO_QUOTA_MIN_INTERVAL_MS".into(), "3000".into()));
    credentials(&env, now_ms() + 3_600_000);
    let _daemon = env.start_daemon();
    let started = Instant::now();
    let mut c = Client::connect(&env);
    c.call("hello", json!({}));

    // Lecture au démarrage, annoncée par quotas.updated.
    wait_quotas(&mut c, "quotas de l'API", |q| {
        q["profiles"]["default"]["source"] == "usage_api"
    });
    let q = c.call("quotas.get", json!({}));
    let d = &q["profiles"]["default"];
    assert_eq!(d["five_hour"]["used_percentage"], 12.0, "{q}");
    assert_eq!(d["five_hour"]["resets_at"], "2099-10-20T13:00:00.123456Z");
    assert_eq!(d["five_hour"]["source"], "usage_api");
    assert!(d["five_hour"]["fetched_at"].is_string());
    assert_eq!(d["seven_day"]["used_percentage"], 35.5);
    assert_eq!(d["seven_day"]["source"], "usage_api");
    assert_eq!(d["source"], "usage_api");
    assert_eq!(d["fetched_at"], d["five_hour"]["fetched_at"]);
    assert_eq!(d["error"], Value::Null);
    // Profil sans connexion OAuth : erreur lisible, pas de lecture.
    let w = &q["profiles"]["work"];
    assert_eq!(
        (w["five_hour"].clone(), w["source"].clone()),
        (Value::Null, Value::Null)
    );
    assert!(
        w["error"].as_str().unwrap().contains("aucun jeton OAuth"),
        "{q}"
    );
    // Le jeton n'est parti que vers le serveur de l'API, avec l'en-tête bêta.
    let requests = seen.lock().unwrap().clone();
    assert_eq!(requests.len(), 1, "{requests:?}");
    let h = &requests[0];
    assert!(h[0].starts_with("GET /api/oauth/usage"), "{h:?}");
    assert!(
        h.iter()
            .any(|l| l.eq_ignore_ascii_case(&format!("authorization: Bearer {TOKEN}")))
    );
    assert!(
        h.iter()
            .any(|l| l.eq_ignore_ascii_case("anthropic-beta: oauth-2025-04-20"))
    );

    // Dans l'intervalle minimal : `refresh` ne rappelle pas l'API.
    c.call("quotas.get", json!({"refresh": true}));
    std::thread::sleep(Duration::from_millis(300));
    // (Vérifiable seulement si la machine n'a pas trop traîné.)
    if started.elapsed() < Duration::from_millis(2000) {
        assert_eq!(seen.lock().unwrap().len(), 1);
    }
    assert_eq!(c.call_err("quotas.get", json!({"refresh": "oui"})), -32602);

    // Jeton expiré : jamais renouvelé par le démon ; la dernière lecture reste.
    std::thread::sleep(
        Duration::from_millis(3000).saturating_sub(started.elapsed()) + Duration::from_millis(100),
    );
    credentials(&env, now_ms() - 1000);
    c.call("quotas.get", json!({"refresh": true}));
    // Annoncé par quotas.updated (la connexion a déjà parlé au démon).
    c.wait_until("jeton expiré", |c| {
        last_quotas(c).is_some_and(|q| {
            q["profiles"]["default"]["error"]
                .as_str()
                .is_some_and(|e| e.contains("jeton expiré"))
        })
    });
    let q = c.call("quotas.get", json!({}));
    assert_eq!(
        q["profiles"]["default"]["five_hour"]["used_percentage"],
        12.0
    );
    let calls = seen.lock().unwrap().len();
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(
        seen.lock().unwrap().len(),
        calls,
        "jeton expiré : aucune requête"
    );

    // Le jeton n'apparaît jamais au journal ni dans les réponses.
    let log = daemon_log(&env);
    assert!(log.contains("quotas du profil"), "{log}");
    assert!(!log.contains(TOKEN));
    assert!(!q.to_string().contains(TOKEN));
}

#[test]
fn quota_refresh_never_blocks_the_connection() {
    // API lente (1,5 s) : la tournée du démarrage est en cours.
    let (url, seen) = usage_stub(Duration::from_millis(1500));
    let mut env = Env::new();
    env.usage_api_url = url;
    credentials(&env, now_ms() + 3_600_000);
    let _daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    c.call("hello", json!({}));
    let t = Instant::now();
    let q = c.call("quotas.get", json!({"refresh": true}));
    let hello = c.call("hello", json!({}));
    assert!(
        t.elapsed() < Duration::from_millis(800),
        "{:?}",
        t.elapsed()
    );
    assert_eq!(hello["server"], "orchd");
    assert!(q["profiles"]["default"].is_object(), "{q}");
    // Résultat par quotas.updated ; une seule tournée à la fois.
    c.wait_until("quotas.updated", |c| {
        last_quotas(c).is_some_and(|q| q["profiles"]["default"]["source"] == "usage_api")
    });
    assert_eq!(seen.lock().unwrap().len(), 1);
}

#[test]
fn usage_api_can_be_turned_off_and_network_errors_are_reported() {
    // Port fermé : erreur réseau en texte.
    let env = Env::new();
    credentials(&env, now_ms() + 3_600_000);
    let _daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    c.call("hello", json!({}));
    wait_quotas(&mut c, "erreur réseau", |q| {
        q["profiles"]["default"]["error"]
            .as_str()
            .is_some_and(|e| e.contains("injoignable") && !e.contains(TOKEN))
    });
    drop(c);
    drop(_daemon);

    // `[quotas] usage_api = false` : aucune requête, pas d'erreur.
    let (url, seen) = usage_stub(Duration::ZERO);
    let mut env = Env::new();
    env.usage_api_url = url;
    credentials(&env, now_ms() + 3_600_000);
    env.write_config("[quotas]\nusage_api = false\n");
    let _daemon = env.start_daemon();
    let mut c = Client::connect(&env);
    c.call("quotas.get", json!({"refresh": true}));
    std::thread::sleep(Duration::from_millis(300));
    let q = c.call("quotas.get", json!({}));
    assert_eq!(
        q["profiles"]["default"],
        json!({"five_hour": null, "seven_day": null, "source": null,
               "fetched_at": null, "error": null})
    );
    assert!(seen.lock().unwrap().is_empty());
}
