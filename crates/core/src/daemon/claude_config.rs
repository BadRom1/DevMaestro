//! Plugin Claude Code et réglages générés par le démon (ADR 0002).
//!
//! - `claude-plugin/` : plugin passé par `--plugin-dir`, dont chaque hook
//!   appelle `orchd hook <événement>` en forme « exec » (`command` + `args`,
//!   sans shell) ;
//! - `settings/<profil>.json` : réglages passés par `--settings`, dont la
//!   statusline appelle `orchd statusline --config-dir <dossier du profil>`
//!   (forme shell : `statusLine.command` est une chaîne).
//!
//! Les fichiers sont réécrits au démarrage du démon et avant chaque lancement,
//! par écriture dans un fichier temporaire puis renommage : un `claude` qui
//! les lit au même moment ne voit jamais un fichier à moitié écrit.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use crate::domain::{PermissionMode, Profile};

/// Nom du plugin généré.
pub const PLUGIN_NAME: &str = "devmaestro";

/// Événements relayés au démon.
pub const HOOK_EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "PermissionRequest",
    "PermissionDenied",
    "Notification",
    "Stop",
    "StopFailure",
    "SessionEnd",
    "SubagentStart",
    "SubagentStop",
];

/// Événements dont le matcher porte sur le nom de l'outil : `*` = tous.
const TOOL_EVENTS: &[&str] = &[
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "PermissionRequest",
    "PermissionDenied",
];

/// `.claude-plugin/plugin.json`.
pub fn plugin_manifest() -> Value {
    json!({
        "name": PLUGIN_NAME,
        "version": env!("CARGO_PKG_VERSION"),
        "description": "DevMaestro : relaie les événements des hooks au démon orchd.",
        "author": {"name": "DevMaestro"},
    })
}

/// Délai par défaut du hook `PermissionRequest` (celui de Claude Code).
pub const DEFAULT_PERMISSION_TIMEOUT_SECS: u64 = 600;

/// Attente du relais `PermissionRequest` pour un délai de hook de `timeout`
/// secondes : le relais rend la main avant que Claude Code ne le tue, avec
/// une marge de 5 s (moins pour un délai court : un quart, au moins 1 s).
pub fn permission_wait_secs(timeout: u64) -> u64 {
    let timeout = timeout.max(2);
    let margin = (timeout / 4).clamp(1, 5);
    timeout - margin
}

/// `hooks/hooks.json` : chaque événement appelle `<orchd> hook <événement>`.
///
/// Pas de `timeout` explicite pour les relais non bloquants : le délai par
/// défaut de Claude Code s'applique (le relais rend la main en moins d'une
/// seconde). `PermissionRequest` reçoit `"timeout": <permission_timeout>` et
/// `--wait <attente>` (voir [`permission_wait_secs`]) : son relais attend la
/// décision de l'app.
pub fn hooks_json(orchd: &Path, permission_timeout: u64) -> Value {
    let permission_timeout = permission_timeout.max(2);
    let mut hooks = serde_json::Map::new();
    for event in HOOK_EVENTS {
        let mut hook = json!({
            "type": "command",
            "command": orchd,
            "args": ["hook", event],
        });
        if *event == "PermissionRequest" {
            hook["args"] = json!([
                "hook",
                event,
                "--wait",
                permission_wait_secs(permission_timeout).to_string()
            ]);
            hook["timeout"] = json!(permission_timeout);
        }
        let mut group = json!({"hooks": [hook]});
        if TOOL_EVENTS.contains(event) {
            group["matcher"] = json!("*");
        }
        hooks.insert((*event).to_owned(), json!([group]));
    }
    json!({
        "description": "DevMaestro : relais des hooks vers orchd",
        "hooks": hooks,
    })
}

/// Réglages passés par `--settings` pour un profil : la statusline chaînée,
/// et, si `disable_bypass` (modes dangereux non autorisés par le démon),
/// `permissions.disableBypassPermissionsMode: "disable"` : Claude Code refuse
/// alors d'entrer en `bypassPermissions` (verrou : la valeur la plus stricte
/// de toutes les sources s'applique).
pub fn settings_json(orchd: &Path, profile: &Profile, disable_bypass: bool) -> Value {
    let command = format!(
        "{} statusline --config-dir {}",
        shell_quote(&orchd.to_string_lossy()),
        shell_quote(&profile.config_dir.to_string_lossy()),
    );
    let mut settings = json!({
        "statusLine": {"type": "command", "command": command},
    });
    if disable_bypass {
        settings["permissions"] = json!({"disableBypassPermissionsMode": "disable"});
    }
    settings
}

/// `permissions.defaultMode` effectif quand l'appelant ne donne pas de mode,
/// lu (sans jamais écrire) dans, par ordre de priorité :
/// `<cwd>/.claude/settings.local.json`, `<cwd>/.claude/settings.json`,
/// `<dossier du profil>/settings.json`. Renvoie le mode et le fichier qui le
/// fixe ; un fichier absent, illisible ou sans la clé est sauté.
///
/// Les réglages gérés (`managed-settings.json`) ne sont pas lus. Claude Code
/// ignore `auto` et `bypassPermissions` venus du projet : le démon, lui, les
/// prend en compte, ce qui ne peut que rendre le lancement plus prudent.
pub fn default_mode(cwd: &Path, profile_dir: &Path) -> Option<(PermissionMode, PathBuf)> {
    let candidates = [
        cwd.join(".claude").join("settings.local.json"),
        cwd.join(".claude").join("settings.json"),
        profile_dir.join("settings.json"),
    ];
    candidates.into_iter().find_map(|path| {
        let text = fs::read_to_string(&path).ok()?;
        let v: Value = serde_json::from_str(&text).ok()?;
        let mode = v.get("permissions")?.get("defaultMode")?.as_str()?;
        Some((PermissionMode::parse(mode), path))
    })
}

/// Met une chaîne entre apostrophes pour `sh`.
pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Écrit le plugin dans `dir` (remplace l'existant).
pub fn write_plugin(dir: &Path, orchd: &Path, permission_timeout: u64) -> io::Result<()> {
    write_json(
        &dir.join(".claude-plugin").join("plugin.json"),
        &plugin_manifest(),
    )?;
    write_json(
        &dir.join("hooks").join("hooks.json"),
        &hooks_json(orchd, permission_timeout),
    )
}

/// Écrit les réglages d'un profil dans `path`.
pub fn write_settings(
    path: &Path,
    orchd: &Path,
    profile: &Profile,
    disable_bypass: bool,
) -> io::Result<()> {
    write_json(path, &settings_json(orchd, profile, disable_bypass))
}

fn write_json(path: &Path, value: &Value) -> io::Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| io::Error::other("chemin sans dossier parent"))?;
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)?;
    }
    let tmp = dir.join(format!(
        ".{}.tmp-{}",
        path.file_name().unwrap_or_default().to_string_lossy(),
        std::process::id()
    ));
    let mut text = serde_json::to_string_pretty(value).map_err(io::Error::other)?;
    text.push('\n');
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let _ = fs::remove_file(&tmp);
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)?;
        f.write_all(text.as_bytes())?;
    }
    fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn hooks_use_exec_form_for_every_event() {
        let h = hooks_json(Path::new("/opt/dm/orchd"), DEFAULT_PERMISSION_TIMEOUT_SECS);
        let hooks = h["hooks"].as_object().unwrap();
        assert_eq!(hooks.len(), HOOK_EVENTS.len());
        for event in HOOK_EVENTS {
            let groups = hooks[*event].as_array().unwrap();
            assert_eq!(groups.len(), 1);
            let hook = &groups[0]["hooks"][0];
            assert_eq!(hook["type"], "command");
            assert_eq!(hook["command"], "/opt/dm/orchd");
            if *event == "PermissionRequest" {
                assert_eq!(hook["args"], json!(["hook", event, "--wait", "595"]));
                assert_eq!(hook["timeout"], 600);
            } else {
                assert_eq!(hook["args"], json!(["hook", event]));
                assert!(hook.get("timeout").is_none());
            }
        }
        assert_eq!(permission_wait_secs(600), 595);
        assert_eq!(permission_wait_secs(8), 6);
        assert_eq!(permission_wait_secs(2), 1);
        assert_eq!(permission_wait_secs(0), 1);
        assert_eq!(hooks["PreToolUse"][0]["matcher"], "*");
        assert_eq!(hooks["PermissionRequest"][0]["matcher"], "*");
        assert!(hooks["Stop"][0].get("matcher").is_none());
        assert!(hooks["SessionEnd"][0].get("matcher").is_none());
    }

    #[test]
    fn settings_chain_statusline_with_quoting() {
        let p = Profile::named("work", "/home/u/.claude work");
        let s = settings_json(Path::new("/opt/l'app/orchd"), &p, false);
        assert!(s.get("permissions").is_none());
        let locked = settings_json(Path::new("/opt/orchd"), &p, true);
        assert_eq!(
            locked["permissions"],
            json!({"disableBypassPermissionsMode": "disable"})
        );
        assert_eq!(s["statusLine"]["type"], "command");
        assert_eq!(
            s["statusLine"]["command"],
            r"'/opt/l'\''app/orchd' statusline --config-dir '/home/u/.claude work'"
        );
    }

    #[test]
    fn default_mode_precedence() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().join("p");
        let profile = dir.path().join("profil");
        fs::create_dir_all(cwd.join(".claude")).unwrap();
        fs::create_dir_all(&profile).unwrap();
        assert_eq!(default_mode(&cwd, &profile), None);
        let set = |path: PathBuf, mode: &str| {
            fs::write(
                path,
                format!(r#"{{"permissions": {{"defaultMode": "{mode}"}}}}"#),
            )
            .unwrap()
        };
        set(profile.join("settings.json"), "bypassPermissions");
        assert_eq!(
            default_mode(&cwd, &profile).unwrap().0,
            PermissionMode::BypassPermissions
        );
        set(cwd.join(".claude/settings.json"), "plan");
        assert_eq!(
            default_mode(&cwd, &profile).unwrap().0,
            PermissionMode::Plan
        );
        set(cwd.join(".claude/settings.local.json"), "acceptEdits");
        let (mode, source) = default_mode(&cwd, &profile).unwrap();
        assert_eq!(mode, PermissionMode::AcceptEdits);
        assert!(source.ends_with("settings.local.json"));
        // Fichier illisible : sauté.
        fs::write(cwd.join(".claude/settings.local.json"), "{pas du json").unwrap();
        assert_eq!(
            default_mode(&cwd, &profile).unwrap().0,
            PermissionMode::Plan
        );
    }

    #[test]
    fn writes_plugin_files() {
        let dir = tempfile::tempdir().unwrap();
        let plugin = dir.path().join("claude-plugin");
        write_plugin(&plugin, &PathBuf::from("/bin/orchd"), 600).unwrap();
        // Deux écritures de suite : le renommage remplace sans erreur.
        write_plugin(&plugin, &PathBuf::from("/bin/orchd"), 600).unwrap();
        let manifest: Value = serde_json::from_str(
            &fs::read_to_string(plugin.join(".claude-plugin/plugin.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(manifest["name"], PLUGIN_NAME);
        let hooks: Value =
            serde_json::from_str(&fs::read_to_string(plugin.join("hooks/hooks.json")).unwrap())
                .unwrap();
        assert_eq!(hooks["hooks"]["Stop"][0]["hooks"][0]["args"][1], "Stop");
        let leftovers: Vec<_> = fs::read_dir(plugin.join("hooks"))
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(leftovers, ["hooks.json"]);
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(plugin.join("hooks/hooks.json"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}
