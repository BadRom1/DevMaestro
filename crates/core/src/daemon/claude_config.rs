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
use std::path::Path;

use serde_json::{Value, json};

use crate::domain::Profile;

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

/// `hooks/hooks.json` : chaque événement appelle `<orchd> hook <événement>`.
///
/// Pas de `timeout` explicite : le délai par défaut de Claude Code s'applique
/// (le relais rend la main en moins d'une seconde). Le lot 3 fixera celui de
/// `PermissionRequest`, qui attendra la décision de l'app.
pub fn hooks_json(orchd: &Path) -> Value {
    let mut hooks = serde_json::Map::new();
    for event in HOOK_EVENTS {
        let hook = json!({
            "type": "command",
            "command": orchd,
            "args": ["hook", event],
        });
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

/// Réglages passés par `--settings` pour un profil : la statusline chaînée.
pub fn settings_json(orchd: &Path, profile: &Profile) -> Value {
    let command = format!(
        "{} statusline --config-dir {}",
        shell_quote(&orchd.to_string_lossy()),
        shell_quote(&profile.config_dir.to_string_lossy()),
    );
    json!({
        "statusLine": {"type": "command", "command": command},
    })
}

/// Met une chaîne entre apostrophes pour `sh`.
pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Écrit le plugin dans `dir` (remplace l'existant).
pub fn write_plugin(dir: &Path, orchd: &Path) -> io::Result<()> {
    write_json(
        &dir.join(".claude-plugin").join("plugin.json"),
        &plugin_manifest(),
    )?;
    write_json(&dir.join("hooks").join("hooks.json"), &hooks_json(orchd))
}

/// Écrit les réglages d'un profil dans `path`.
pub fn write_settings(path: &Path, orchd: &Path, profile: &Profile) -> io::Result<()> {
    write_json(path, &settings_json(orchd, profile))
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
        let h = hooks_json(Path::new("/opt/dm/orchd"));
        let hooks = h["hooks"].as_object().unwrap();
        assert_eq!(hooks.len(), HOOK_EVENTS.len());
        for event in HOOK_EVENTS {
            let groups = hooks[*event].as_array().unwrap();
            assert_eq!(groups.len(), 1);
            let hook = &groups[0]["hooks"][0];
            assert_eq!(hook["type"], "command");
            assert_eq!(hook["command"], "/opt/dm/orchd");
            assert_eq!(hook["args"], json!(["hook", event]));
            assert!(hook.get("timeout").is_none());
        }
        assert_eq!(hooks["PreToolUse"][0]["matcher"], "*");
        assert_eq!(hooks["PermissionRequest"][0]["matcher"], "*");
        assert!(hooks["Stop"][0].get("matcher").is_none());
        assert!(hooks["SessionEnd"][0].get("matcher").is_none());
    }

    #[test]
    fn settings_chain_statusline_with_quoting() {
        let p = Profile::named("work", "/home/u/.claude work");
        let s = settings_json(Path::new("/opt/l'app/orchd"), &p);
        assert_eq!(s["statusLine"]["type"], "command");
        assert_eq!(
            s["statusLine"]["command"],
            r"'/opt/l'\''app/orchd' statusline --config-dir '/home/u/.claude work'"
        );
    }

    #[test]
    fn writes_plugin_files() {
        let dir = tempfile::tempdir().unwrap();
        let plugin = dir.path().join("claude-plugin");
        write_plugin(&plugin, &PathBuf::from("/bin/orchd")).unwrap();
        // Deux écritures de suite : le renommage remplace sans erreur.
        write_plugin(&plugin, &PathBuf::from("/bin/orchd")).unwrap();
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
