//! Slash commands d'une session (v0.3, lot 17) : méthode `commands.list`.
//!
//! Les règles (noms, frontmatter, plugins activés, fusion) sont dans le
//! domaine ([`crate::domain::commands`]) ; la lecture des fichiers, en
//! lecture seule et bornée, derrière [`crate::ports::CommandFiles`]. Pas de
//! cache : le front n'appelle la méthode qu'à l'ouverture de sa liste. Rien
//! n'est journalisé du contenu lu.

use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use super::{Daemon, RpcError, session_id_param};
use crate::domain::Profile;
use crate::domain::commands::{
    CommandSource, SlashCommand, builtin_commands, command_from_file, enabled_plugins, merge,
    plugin_installs, plugin_name, skill_from_file, valid_segment,
};
use crate::ports::{CommandFiles, CommandLayout};

fn command_json(c: &SlashCommand) -> Value {
    let mut v = json!({
        "name": c.name,
        "source": c.source.as_str(),
        "kind": c.kind.as_str(),
    });
    let o = v.as_object_mut().expect("objet");
    if let Some(d) = &c.description {
        o.insert("description".into(), json!(d));
    }
    if let Some(h) = &c.argument_hint {
        o.insert("argument_hint".into(), json!(h));
    }
    if !c.aliases.is_empty() {
        o.insert("aliases".into(), json!(c.aliases));
    }
    if c.interactive {
        o.insert("interactive".into(), json!(true));
    }
    if let Some(p) = &c.plugin {
        o.insert("plugin".into(), json!(p));
    }
    if let Some(k) = c.conflict {
        o.insert("conflict".into(), json!(k.as_str()));
    }
    v
}

/// Coupes et fichiers ignorés, toutes racines confondues.
#[derive(Debug, Default)]
struct Tally {
    truncated: bool,
    /// Fichiers candidats ignorés pour leur nom (non ASCII, espaces, trop
    /// long, trop profond, pas de l'UTF-8).
    ignored: usize,
}

impl Tally {
    fn note(&mut self, scan: &crate::ports::CommandScan) {
        self.truncated |= scan.truncated;
        self.ignored += scan.ignored;
    }
}

/// Commandes et skills d'une racine (`<base>/commands`, `<base>/skills`).
/// `confine` : ces dossiers, une fois résolus, doivent rester dessous (un
/// projet ou un plugin ne fait pas lire ailleurs par un lien) ; `None` pour
/// le dossier du profil, qui peut être lié à celui d'un autre profil.
fn read_root(
    files: &dyn CommandFiles,
    base: &Path,
    confine: Option<&Path>,
    source: CommandSource,
    plugin: Option<&str>,
    tally: &mut Tally,
) -> Vec<SlashCommand> {
    let root = |name: &str| -> Option<PathBuf> {
        let p = base.join(name);
        match confine {
            Some(c) => files.dir_within(&p, c),
            None => Some(p),
        }
    };
    let mut out = Vec::new();
    if let Some(dir) = root("commands") {
        let scan = files.scan(&dir, CommandLayout::Commands);
        tally.note(&scan);
        for f in &scan.files {
            match command_from_file(&f.rel, &f.head, source, plugin) {
                Some(c) => out.push(c),
                None => tally.ignored += 1,
            }
        }
    }
    if let Some(dir) = root("skills") {
        let scan = files.scan(&dir, CommandLayout::Skills);
        tally.note(&scan);
        for f in &scan.files {
            match skill_from_file(&f.rel, &f.head, source, plugin) {
                Some(c) => out.push(c),
                // Nom invalide ; un skill `user-invocable: false` n'est pas compté.
                None if !valid_segment(&f.rel) => tally.ignored += 1,
                None => {}
            }
        }
    }
    out
}

/// Commandes des plugins activés pour ce profil et ce projet.
fn read_plugins(
    files: &dyn CommandFiles,
    profile: &Profile,
    cwd: &Path,
    project_root: &Path,
    tally: &mut Tally,
) -> Vec<SlashCommand> {
    let project = cwd.join(".claude");
    let enabled = enabled_plugins(&[
        files.read_json(&profile.config_dir.join("settings.json")),
        files.read_json(&project.join("settings.json")),
        files.read_json(&project.join("settings.local.json")),
    ]);
    if enabled.is_empty() {
        return Vec::new();
    }
    let plugins_dir = profile.config_dir.join("plugins");
    let Some(installed) = files.read_json(&plugins_dir.join("installed_plugins.json")) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for install in plugin_installs(&installed, &enabled, &[cwd, project_root]) {
        // Le dossier d'installation doit rester sous `plugins/` du profil
        // (résolu : les profils liés entre eux restent acceptés).
        let Some(dir) = files.dir_within(&install.install_path, &plugins_dir) else {
            continue;
        };
        let manifest = files.read_json(&dir.join(".claude-plugin/plugin.json"));
        let Some(name) = plugin_name(manifest.as_ref(), &install.key) else {
            continue;
        };
        out.extend(read_root(
            files,
            &dir,
            Some(&dir),
            CommandSource::Plugin,
            Some(&name),
            tally,
        ));
    }
    out
}

impl Daemon {
    /// `commands.list {id}` → `{commands, claude_code_version, truncated,
    /// ignored}`.
    /// Session inconnue : `-32001` ; le reste (profil inconnu, dossier
    /// disparu, fichier illisible) fait seulement manquer la source.
    /// Bloquant (lecture de fichiers).
    pub fn commands_list(&self, params: &Value) -> Result<Value, RpcError> {
        let id = session_id_param(params)?;
        let (profile_name, cwd, project_root) = {
            let reg = self.lock();
            let e = reg
                .sessions
                .get(&id)
                .ok_or_else(|| RpcError::unknown_session(&id))?;
            (
                e.session.profile.clone(),
                e.session.cwd.clone(),
                e.session.project_root.clone(),
            )
        };
        let files = self.deps.commands.as_ref();
        let (version, builtins) = builtin_commands();
        let mut tally = Tally::default();
        let profile = self
            .known_profiles()
            .into_iter()
            .find(|p| p.name == profile_name);
        let project = read_root(
            files,
            &cwd.join(".claude"),
            Some(&cwd),
            CommandSource::Project,
            None,
            &mut tally,
        );
        let (user, plugins) = match &profile {
            Some(p) => (
                read_root(
                    files,
                    &p.config_dir,
                    None,
                    CommandSource::User,
                    None,
                    &mut tally,
                ),
                read_plugins(files, p, &cwd, &project_root, &mut tally),
            ),
            None => (Vec::new(), Vec::new()),
        };
        let (list, cut) = merge(vec![project, user, builtins.clone(), plugins]);
        Ok(json!({
            "commands": list.iter().map(command_json).collect::<Vec<_>>(),
            "claude_code_version": version,
            "truncated": tally.truncated || cut,
            "ignored": tally.ignored,
        }))
    }
}
