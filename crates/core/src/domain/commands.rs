//! Slash commands proposées dans le champ de saisie de la conversation
//! (v0.3, lot 17) : commandes intégrées de Claude Code (liste statique de
//! référence), commandes et skills de l'utilisateur, du projet et des
//! plugins activés.
//!
//! Domaine pur : noms, lecture du frontmatter, résolution des plugins activés
//! (sur le JSON déjà lu) et fusion des sources. La lecture des fichiers
//! (bornée, sans suivre de lien hors de la racine) est derrière le port
//! [`crate::ports::CommandFiles`].
//!
//! Le frontmatter est lu par l'analyseur **par événements** de `yaml-rust2` :
//! un alias n'est jamais développé (pas d'explosion d'un petit en-tête), et
//! seules les clés scalaires du premier niveau sont gardées.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde_json::Value;
use yaml_rust2::parser::{Event, MarkedEventReceiver, Parser};
use yaml_rust2::scanner::{Marker, TScalarStyle};

/// Octets lus au plus en tête de chaque fichier `.md` (frontmatter seulement).
pub const MAX_HEAD_BYTES: usize = 8 * 1024;
/// Fichiers retenus au plus par racine parcourue.
pub const MAX_FILES_PER_ROOT: usize = 300;
/// Dossiers traversés au plus sous `commands/` (un fichier à la racine est
/// à la profondeur 0).
pub const MAX_DEPTH: usize = 4;
/// Entrées de dossier parcourues au plus par racine.
pub const MAX_DIR_ENTRIES_PER_ROOT: usize = 2_000;
/// Plugins activés lus au plus.
pub const MAX_PLUGINS: usize = 50;
/// Taille au plus d'un fichier JSON lu (réglages, plugins installés, manifeste).
pub const MAX_JSON_BYTES: u64 = 1024 * 1024;
/// Commandes renvoyées au plus (`truncated` au-delà).
pub const MAX_COMMANDS: usize = 1_000;
/// Longueur au plus d'une description, en caractères.
pub const MAX_DESCRIPTION: usize = 512;
/// Longueur au plus d'une indication d'arguments, en caractères.
pub const MAX_ARGUMENT_HINT: usize = 128;
/// Longueur au plus d'un segment de nom.
pub const MAX_SEGMENT: usize = 64;

/// Origine d'une commande.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum CommandSource {
    Builtin,
    Project,
    User,
    Plugin,
}

impl CommandSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Builtin => "builtin",
            Self::Project => "project",
            Self::User => "user",
            Self::Plugin => "plugin",
        }
    }
}

/// Commande (`.md` de `commands/`) ou skill (`SKILL.md`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandKind {
    Command,
    Skill,
}

impl CommandKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Command => "command",
            Self::Skill => "skill",
        }
    }
}

/// Une slash command proposée.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SlashCommand {
    /// Nom sans le `/` (`compact`, `frontend:test`, `forge:forge-grill`).
    pub name: String,
    pub description: Option<String>,
    pub argument_hint: Option<String>,
    /// Autres noms reconnus (intégrées seulement).
    pub aliases: Vec<String>,
    pub source: CommandSource,
    pub kind: CommandKind,
    /// Ouvre une interface dans la TUI (à utiliser dans le terminal).
    pub interactive: bool,
    /// Plugin d'origine.
    pub plugin: Option<String>,
    /// Reprend le nom (ou un alias) d'une intégrée, ou le nom d'une commande
    /// de plugin : gardée **à côté** de l'originale, jamais à sa place.
    pub conflict: Option<CommandConflict>,
}

/// Nom repris d'une autre source (lot 17) : signalé dans l'interface.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandConflict {
    /// Même nom qu'une commande intégrée (ou qu'un de ses alias).
    Builtin,
    /// Même nom qu'une commande ou un skill d'un plugin activé.
    Plugin,
}

impl CommandConflict {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Builtin => "builtin",
            Self::Plugin => "plugin",
        }
    }
}

// ------------------------------------------------------------------ noms

/// Segment de nom accepté : `[A-Za-z0-9_-]{1,64}`.
pub fn valid_segment(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= MAX_SEGMENT
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Nom d'une commande d'après son chemin relatif à `commands/`
/// (`frontend/test.md` → `frontend:test`) ; `None` si un segment est
/// invalide, caché, ou si ce n'est pas un `.md`.
pub fn command_name(rel: &str) -> Option<String> {
    let stem = rel.strip_suffix(".md")?;
    let segments: Vec<&str> = stem.split('/').collect();
    if segments.len() > MAX_DEPTH + 1 || !segments.iter().all(|s| valid_segment(s)) {
        return None;
    }
    Some(segments.join(":"))
}

/// Préfixe le nom par celui du plugin (`<plugin>:<nom>`).
fn with_plugin(name: String, plugin: Option<&str>) -> String {
    match plugin {
        Some(p) => format!("{p}:{name}"),
        None => name,
    }
}

// ------------------------------------------------------------ frontmatter

/// Ce qui compte dans le frontmatter d'un fichier.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Frontmatter {
    pub description: Option<String>,
    pub argument_hint: Option<String>,
    /// `user-invocable: false` (skill réservé au modèle).
    pub not_user_invocable: bool,
}

/// Caractère de mise en forme invisible (catégorie Cf) qui pourrait
/// maquiller un texte affiché : espaces de largeur nulle et marques de
/// direction, contrôles bidirectionnels (enchâssements, isolats), joncteurs,
/// indicateur d'ordre des octets, étiquettes Unicode.
fn hidden_format(c: char) -> bool {
    matches!(c,
        '\u{00AD}' | '\u{061C}' | '\u{180E}'
        | '\u{200B}'..='\u{200F}'
        | '\u{202A}'..='\u{202E}'
        | '\u{2060}'..='\u{2064}'
        | '\u{2066}'..='\u{2069}'
        | '\u{FEFF}'
        | '\u{E0000}'..='\u{E007F}')
}

/// Texte d'une seule ligne, sans caractère de contrôle ni de mise en forme
/// invisible, coupé à `max` caractères ; `None` s'il est vide.
fn clean_line(s: &str, max: usize) -> Option<String> {
    let mut out = String::new();
    let mut space = false;
    for c in s.chars() {
        if hidden_format(c) {
            continue;
        }
        if c.is_whitespace() || c.is_control() {
            space = !out.is_empty();
            continue;
        }
        if space {
            out.push(' ');
            space = false;
        }
        out.push(c);
    }
    if out.is_empty() {
        return None;
    }
    if out.chars().count() > max {
        out = out.chars().take(max.saturating_sub(1)).collect();
        out.push('…');
    }
    Some(out)
}

/// Collecte les scalaires du premier niveau d'un mapping racine.
#[derive(Default)]
struct TopLevel {
    depth: usize,
    root_is_map: bool,
    /// Clé en attente de sa valeur (premier niveau).
    key: Option<String>,
    pairs: Vec<(String, String)>,
    /// Clés du premier niveau dont la valeur n'est pas un scalaire
    /// (`argument-hint: [message]` est une séquence YAML) : relues ligne à ligne.
    complex: Vec<String>,
}

impl TopLevel {
    /// Une valeur non scalaire (ou un alias) au premier niveau : la clé est
    /// consommée sans valeur gardée.
    fn skip_value(&mut self) {
        if self.depth == 1
            && let Some(k) = self.key.take()
            && !k.is_empty()
        {
            self.complex.push(k);
        }
    }
}

impl MarkedEventReceiver for TopLevel {
    fn on_event(&mut self, ev: Event, _mark: Marker) {
        match ev {
            Event::MappingStart(..) => {
                if self.depth == 0 {
                    self.root_is_map = true;
                } else if self.depth == 1 && self.key.is_none() {
                    // Clé complexe : la valeur qui suit sera ignorée.
                    self.key = Some(String::new());
                } else {
                    self.skip_value();
                }
                self.depth += 1;
            }
            Event::SequenceStart(..) => {
                if self.depth == 1 && self.key.is_none() {
                    self.key = Some(String::new());
                } else {
                    self.skip_value();
                }
                self.depth += 1;
            }
            Event::MappingEnd | Event::SequenceEnd => {
                self.depth = self.depth.saturating_sub(1);
            }
            Event::Scalar(v, style, ..) if self.depth == 1 && self.root_is_map => {
                match self.key.take() {
                    None => self.key = Some(v),
                    // `~`, `null`, vide : valeur absente.
                    Some(k) => {
                        if !k.is_empty() && !(style == TScalarStyle::Plain && yaml_null(&v)) {
                            self.pairs.push((k, v));
                        }
                    }
                }
            }
            // Alias en clé : la valeur qui suit est ignorée ; en valeur : la
            // clé est consommée sans rien garder (jamais développé).
            Event::Alias(_) if self.depth == 1 => {
                self.key = if self.key.is_none() {
                    Some(String::new())
                } else {
                    None
                };
            }
            _ => {}
        }
    }
}

/// Paires clé → valeur scalaire du premier niveau, ou `None` si le YAML est
/// illisible ; une valeur non scalaire (séquence, mapping) d'une clé est
/// reprise telle qu'écrite sur sa ligne (`argument-hint: [message]`).
fn yaml_pairs(text: &str) -> Option<Vec<(String, String)>> {
    let mut rx = TopLevel::default();
    Parser::new_from_str(text).load(&mut rx, false).ok()?;
    if !rx.complex.is_empty() {
        let lines = line_pairs(text);
        for k in &rx.complex {
            if let Some((_, v)) = lines.iter().find(|(lk, v)| lk == k && !v.is_empty()) {
                rx.pairs.push((k.clone(), v.clone()));
            }
        }
    }
    Some(rx.pairs)
}

/// Valeur YAML nulle écrite sans guillemets.
fn yaml_null(v: &str) -> bool {
    matches!(v.trim(), "" | "~" | "null" | "Null" | "NULL")
}

/// Repli ligne à ligne quand le YAML est illisible (`description: a: b`).
fn line_pairs(text: &str) -> Vec<(String, String)> {
    text.lines()
        .filter(|l| !l.starts_with([' ', '\t', '#']))
        .filter_map(|l| {
            let (k, v) = l.split_once(':')?;
            let v = v.trim();
            if yaml_null(v) {
                return None;
            }
            let v = v
                .strip_prefix('"')
                .and_then(|x| x.strip_suffix('"'))
                .or_else(|| v.strip_prefix('\'').and_then(|x| x.strip_suffix('\'')))
                .unwrap_or(v);
            Some((k.trim().to_owned(), v.to_owned()))
        })
        .collect()
}

/// Lit le frontmatter et la première ligne utile du texte d'un fichier
/// (tête de [`MAX_HEAD_BYTES`] octets au plus). Sans en-tête, ou sans
/// description dans l'en-tête, la description est la première ligne non
/// vide du texte (titre `#` vidé de ses dièses) ; en-tête non fermé dans la
/// tête lue : pas de description.
pub fn parse_frontmatter(head: &[u8]) -> Frontmatter {
    let text = String::from_utf8_lossy(head);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    let mut lines = text.split_inclusive('\n');
    let first = lines.next().unwrap_or("");
    let mut fm = Frontmatter::default();
    let body: &str = if first.trim_end() == "---" {
        let start = first.len();
        let mut end = None;
        let mut pos = start;
        for l in lines {
            let t = l.trim_end();
            if t == "---" || t == "..." {
                end = Some((pos, pos + l.len()));
                break;
            }
            pos += l.len();
        }
        let Some((yaml_end, body_start)) = end else {
            return fm;
        };
        let yaml = &text[start..yaml_end];
        let pairs = yaml_pairs(yaml).unwrap_or_else(|| line_pairs(yaml));
        for (k, v) in pairs {
            match k.as_str() {
                "description" => fm.description = clean_line(&v, MAX_DESCRIPTION),
                "argument-hint" => fm.argument_hint = clean_line(&v, MAX_ARGUMENT_HINT),
                "user-invocable" => fm.not_user_invocable = v.trim().eq_ignore_ascii_case("false"),
                _ => {}
            }
        }
        &text[body_start..]
    } else {
        text
    };
    if fm.description.is_none() {
        fm.description = body
            .lines()
            .map(|l| l.trim().trim_start_matches('#'))
            .find_map(|l| clean_line(l, MAX_DESCRIPTION));
    }
    fm
}

/// Commande lue dans `commands/` (`rel` : chemin relatif, `/` comme
/// séparateur ; `head` : tête du fichier).
pub fn command_from_file(
    rel: &str,
    head: &[u8],
    source: CommandSource,
    plugin: Option<&str>,
) -> Option<SlashCommand> {
    let name = command_name(rel)?;
    let fm = parse_frontmatter(head);
    Some(SlashCommand {
        name: with_plugin(name, plugin),
        description: fm.description,
        argument_hint: fm.argument_hint,
        aliases: Vec::new(),
        source,
        kind: CommandKind::Command,
        interactive: false,
        plugin: plugin.map(str::to_owned),
        conflict: None,
    })
}

/// Skill lu dans `skills/<dossier>/SKILL.md` ; `None` si le nom du dossier
/// est invalide ou si le skill n'est pas invocable par l'utilisateur.
pub fn skill_from_file(
    dir: &str,
    head: &[u8],
    source: CommandSource,
    plugin: Option<&str>,
) -> Option<SlashCommand> {
    if !valid_segment(dir) {
        return None;
    }
    let fm = parse_frontmatter(head);
    if fm.not_user_invocable {
        return None;
    }
    Some(SlashCommand {
        name: with_plugin(dir.to_owned(), plugin),
        description: fm.description,
        argument_hint: fm.argument_hint,
        aliases: Vec::new(),
        source,
        kind: CommandKind::Skill,
        interactive: false,
        plugin: plugin.map(str::to_owned),
        conflict: None,
    })
}

// ---------------------------------------------------------------- plugins

/// Clé de plugin acceptée : `<nom>@<marketplace>`.
fn valid_plugin_key(k: &str) -> bool {
    let Some((name, market)) = k.split_once('@') else {
        return false;
    };
    valid_segment(name)
        && !market.is_empty()
        && market.len() <= 128
        && market
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
}

/// Plugins activés d'après les couches de réglages, de la plus générale à la
/// plus précise (utilisateur, projet, projet local) : la dernière qui cite
/// un plugin l'emporte, `false` le désactive. Triés, [`MAX_PLUGINS`] au plus.
pub fn enabled_plugins(layers: &[Option<Value>]) -> Vec<String> {
    let mut state: Vec<(String, bool)> = Vec::new();
    for layer in layers.iter().flatten() {
        let Some(map) = layer.get("enabledPlugins").and_then(Value::as_object) else {
            continue;
        };
        for (k, v) in map {
            let Some(on) = v.as_bool() else { continue };
            if !valid_plugin_key(k) {
                continue;
            }
            match state.iter_mut().find(|(n, _)| n == k) {
                Some(e) => e.1 = on,
                None => state.push((k.clone(), on)),
            }
        }
    }
    let mut on: Vec<String> = state
        .into_iter()
        .filter_map(|(k, v)| v.then_some(k))
        .collect();
    on.sort();
    on.truncate(MAX_PLUGINS);
    on
}

/// Un plugin activé et son dossier d'installation (pas encore vérifié).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginInstall {
    /// `<nom>@<marketplace>`.
    pub key: String,
    pub install_path: PathBuf,
}

/// Dossiers d'installation des plugins activés d'après
/// `installed_plugins.json` (version 2 : liste d'entrées par plugin, de
/// portée `user`, ou `project` / `local` liée à un dossier de projet ;
/// version 1 : un objet par plugin). Une entrée de projet n'est retenue que
/// si son `projectPath` est l'un de `project_dirs` ; elle passe alors avant
/// l'entrée `user`.
pub fn plugin_installs(
    installed: &Value,
    enabled: &[String],
    project_dirs: &[&Path],
) -> Vec<PluginInstall> {
    let Some(plugins) = installed.get("plugins").and_then(Value::as_object) else {
        return Vec::new();
    };
    let path_of = |e: &Value| -> Option<PathBuf> {
        let p = PathBuf::from(e.get("installPath")?.as_str()?);
        p.is_absolute().then_some(p)
    };
    let mut out = Vec::new();
    for key in enabled.iter().take(MAX_PLUGINS) {
        let Some(v) = plugins.get(key) else { continue };
        let entries: Vec<&Value> = match v {
            Value::Array(a) => a.iter().collect(),
            Value::Object(_) => vec![v],
            _ => continue,
        };
        let project = entries.iter().find(|e| {
            matches!(install_scope(e), "project" | "local")
                && e.get("projectPath")
                    .and_then(Value::as_str)
                    .is_some_and(|p| project_dirs.iter().any(|d| Path::new(p) == *d))
        });
        let chosen = project.or_else(|| entries.iter().find(|e| install_scope(e) == "user"));
        if let Some(path) = chosen.and_then(|e| path_of(e)) {
            out.push(PluginInstall {
                key: key.clone(),
                install_path: path,
            });
        }
    }
    out
}

/// Portée d'une entrée de `installed_plugins.json` (`user` par défaut).
fn install_scope(e: &Value) -> &str {
    e.get("scope").and_then(Value::as_str).unwrap_or("user")
}

/// Nom d'un plugin : `name` de son manifeste s'il est valide, sinon la clé
/// avant `@`.
pub fn plugin_name(manifest: Option<&Value>, key: &str) -> Option<String> {
    manifest
        .and_then(|m| m.get("name"))
        .and_then(Value::as_str)
        .filter(|n| valid_segment(n))
        .map(str::to_owned)
        .or_else(|| {
            key.split_once('@')
                .map(|(n, _)| n)
                .filter(|n| valid_segment(n))
                .map(str::to_owned)
        })
}

// -------------------------------------------------------------- intégrées

const BUILTIN_JSON: &str = include_str!("builtin_commands.json");

/// Commandes intégrées de Claude Code (liste de référence) et la version de
/// Claude Code relevée.
pub fn builtin_commands() -> &'static (String, Vec<SlashCommand>) {
    static LIST: OnceLock<(String, Vec<SlashCommand>)> = OnceLock::new();
    LIST.get_or_init(|| {
        let v: Value = serde_json::from_str(BUILTIN_JSON).unwrap_or(Value::Null);
        let version = v
            .get("claude_code_version")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let str_of = |c: &Value, k: &str| c.get(k).and_then(Value::as_str).map(str::to_owned);
        let list = v
            .get("commands")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|c| {
                        Some(SlashCommand {
                            name: str_of(c, "name")?,
                            description: str_of(c, "description"),
                            argument_hint: str_of(c, "argument_hint"),
                            aliases: c
                                .get("aliases")
                                .and_then(Value::as_array)
                                .map(|a| {
                                    a.iter()
                                        .filter_map(|x| x.as_str().map(str::to_owned))
                                        .collect()
                                })
                                .unwrap_or_default(),
                            source: CommandSource::Builtin,
                            kind: if c.get("kind").and_then(Value::as_str) == Some("skill") {
                                CommandKind::Skill
                            } else {
                                CommandKind::Command
                            },
                            interactive: c.get("interactive").and_then(Value::as_bool)
                                == Some(true),
                            plugin: None,
                            conflict: None,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        (version, list)
    })
}

// ----------------------------------------------------------------- fusion

/// Classe de doublons : un nom n'est écarté que s'il est déjà pris dans sa
/// propre classe (intégrées ; plugins ; projet et utilisateur ensemble).
fn dedup_class(s: CommandSource) -> u8 {
    match s {
        CommandSource::Builtin => 0,
        CommandSource::Plugin => 1,
        CommandSource::Project | CommandSource::User => 2,
    }
}

/// Fusionne des groupes donnés **par ordre de priorité**, puis range pour
/// l'affichage : intégrées, projet, utilisateur, plugins, chacune par nom ;
/// coupe à [`MAX_COMMANDS`] (`true` si coupé ; les intégrées, en tête, sont
/// toujours gardées).
///
/// Une intégrée n'est **jamais masquée** : une commande du projet, de
/// l'utilisateur ou d'un plugin qui reprend son nom ou l'un de ses alias est
/// gardée à côté, marquée [`CommandConflict::Builtin`] ; de même, une
/// commande du projet ou de l'utilisateur qui reprend le nom d'une commande
/// de plugin est gardée à côté, marquée [`CommandConflict::Plugin`]. Entre
/// projet et utilisateur, le premier groupe l'emporte (un seul gardé).
pub fn merge(groups: Vec<Vec<SlashCommand>>) -> (Vec<SlashCommand>, bool) {
    let mut seen: HashSet<(u8, String)> = HashSet::new();
    let mut out: Vec<SlashCommand> = Vec::new();
    for c in groups.into_iter().flatten() {
        if seen.insert((dedup_class(c.source), c.name.clone())) {
            out.push(c);
        }
    }
    let builtin: HashSet<&str> = out
        .iter()
        .filter(|c| c.source == CommandSource::Builtin)
        .flat_map(|c| std::iter::once(c.name.as_str()).chain(c.aliases.iter().map(String::as_str)))
        .collect();
    let plugin: HashSet<&str> = out
        .iter()
        .filter(|c| c.source == CommandSource::Plugin)
        .map(|c| c.name.as_str())
        .collect();
    let conflicts: Vec<Option<CommandConflict>> = out
        .iter()
        .map(|c| match c.source {
            CommandSource::Builtin => None,
            _ if builtin.contains(c.name.as_str()) => Some(CommandConflict::Builtin),
            CommandSource::Project | CommandSource::User if plugin.contains(c.name.as_str()) => {
                Some(CommandConflict::Plugin)
            }
            _ => None,
        })
        .collect();
    for (c, k) in out.iter_mut().zip(conflicts) {
        c.conflict = k;
    }
    out.sort_by(|a, b| a.source.cmp(&b.source).then_with(|| a.name.cmp(&b.name)));
    let truncated = out.len() > MAX_COMMANDS;
    out.truncate(MAX_COMMANDS);
    (out, truncated)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn names_from_paths() {
        assert_eq!(command_name("review.md").as_deref(), Some("review"));
        assert_eq!(
            command_name("frontend/test.md").as_deref(),
            Some("frontend:test")
        );
        assert_eq!(command_name("a/b/c/d/e.md").as_deref(), Some("a:b:c:d:e"));
        assert_eq!(command_name("a/b/c/d/e/f.md"), None, "trop profond");
        assert_eq!(command_name("notes.txt"), None);
        assert_eq!(command_name(".cache.md"), None);
        assert_eq!(command_name("a b.md"), None);
        assert_eq!(command_name("été.md"), None);
        assert_eq!(command_name(&format!("{}.md", "x".repeat(65))), None);
        assert_eq!(command_name("a//b.md"), None);
    }

    #[test]
    fn frontmatter_fields() {
        let fm = parse_frontmatter(
            b"---\ndescription: Relire la PR\nargument-hint: \"[numero]\"\nallowed-tools: Bash(git:*)\n---\n\n# Titre\nCorps\n",
        );
        assert_eq!(fm.description.as_deref(), Some("Relire la PR"));
        assert_eq!(fm.argument_hint.as_deref(), Some("[numero]"));
        assert!(!fm.not_user_invocable);
    }

    #[test]
    fn frontmatter_falls_back_on_lines_when_yaml_is_invalid() {
        // `a: b: c` n'est pas du YAML valide.
        let fm = parse_frontmatter(b"---\ndescription: Faire: ceci\nargument-hint: [x]: y\n---\n");
        assert_eq!(fm.description.as_deref(), Some("Faire: ceci"));
        assert_eq!(fm.argument_hint.as_deref(), Some("[x]: y"));
    }

    #[test]
    fn unquoted_list_hint_is_kept_as_written() {
        // `[message]` est une séquence YAML valide : reprise telle qu'écrite.
        let fm = parse_frontmatter(
            b"---\nargument-hint: [message] [--force]\ndescription: Committer\n---\n",
        );
        assert_eq!(fm.argument_hint.as_deref(), Some("[message] [--force]"));
        assert_eq!(fm.description.as_deref(), Some("Committer"));
        let fm = parse_frontmatter(b"---\nargument-hint: [message]\n---\n");
        assert_eq!(fm.argument_hint.as_deref(), Some("[message]"));
        // Une valeur sur plusieurs lignes (mapping imbriqué) n'a pas de texte sur sa ligne.
        let fm = parse_frontmatter(b"---\ndescription:\n  a: b\n---\nCorps\n");
        assert_eq!(fm.description.as_deref(), Some("Corps"));
    }

    #[test]
    fn hidden_format_characters_are_removed() {
        let fm = parse_frontmatter(
            "---\ndescription: \"Re\u{200B}lire \u{202E}fdp.exe\u{2066}x\u{2069}\u{FEFF}\u{E0041}\"\nargument-hint: \"[\u{200F}n]\"\n---\n"
                .as_bytes(),
        );
        assert_eq!(fm.description.as_deref(), Some("Relire fdp.exex"));
        assert_eq!(fm.argument_hint.as_deref(), Some("[n]"));
    }

    #[test]
    fn null_values_are_absent() {
        for v in ["~", "null", "Null", "NULL", ""] {
            let fm = parse_frontmatter(
                format!("---\ndescription: {v}\nargument-hint: {v}\n---\nCorps\n").as_bytes(),
            );
            assert_eq!(fm.description.as_deref(), Some("Corps"), "{v:?}");
            assert_eq!(fm.argument_hint, None, "{v:?}");
        }
        // Entre guillemets, c'est un texte.
        let fm = parse_frontmatter(b"---\ndescription: \"null\"\n---\n");
        assert_eq!(fm.description.as_deref(), Some("null"));
    }

    #[test]
    fn description_from_body_when_missing() {
        let fm = parse_frontmatter(b"\n\n# Revue du code\n\nDu texte.\n");
        assert_eq!(fm.description.as_deref(), Some("Revue du code"));
        let fm = parse_frontmatter(b"---\nargument-hint: x\n---\nPremi\xc3\xa8re ligne\n");
        assert_eq!(fm.description.as_deref(), Some("Première ligne"));
        assert_eq!(fm.argument_hint.as_deref(), Some("x"));
    }

    #[test]
    fn unclosed_frontmatter_gives_nothing() {
        let fm = parse_frontmatter(b"---\ndescription: jamais ferm\xc3\xa9\n");
        assert_eq!(fm, Frontmatter::default());
    }

    #[test]
    fn frontmatter_ignores_nested_values_and_aliases() {
        let fm = parse_frontmatter(
            b"---\nmeta:\n  description: imbriquee\nx: &a [1, 2]\ndescription: *a\nargument-hint: ok\n---\n",
        );
        // Ni la valeur imbriquée ni l'alias ne comptent ; pas de texte après l'en-tête.
        assert_eq!(fm.description, None);
        assert_eq!(fm.argument_hint.as_deref(), Some("ok"));
    }

    #[test]
    fn billion_laughs_stays_small() {
        let mut y = String::from("---\na: &a [\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\",\"x\"]\n");
        let names = ["b", "c", "d", "e", "f", "g", "h", "i"];
        let mut prev = "a";
        for n in names {
            y.push_str(&format!(
                "{n}: &{n} [*{prev},*{prev},*{prev},*{prev},*{prev},*{prev},*{prev},*{prev}]\n"
            ));
            prev = n;
        }
        y.push_str("description: ok\n---\n");
        let fm = parse_frontmatter(y.as_bytes());
        assert_eq!(fm.description.as_deref(), Some("ok"));
    }

    #[test]
    fn long_and_multiline_values_are_cleaned() {
        let long = "é".repeat(600);
        let fm = parse_frontmatter(
            format!("---\ndescription: >\n  ligne un\n  {long}\n---\n").as_bytes(),
        );
        let d = fm.description.unwrap();
        assert!(d.starts_with("ligne un é"));
        assert_eq!(d.chars().count(), MAX_DESCRIPTION);
        assert!(d.ends_with('…'));
        assert!(!d.contains('\n'));
    }

    #[test]
    fn skills_not_user_invocable_are_skipped() {
        assert!(
            skill_from_file(
                "interne",
                b"---\nuser-invocable: false\n---\n",
                CommandSource::User,
                None
            )
            .is_none()
        );
        let s = skill_from_file(
            "grill",
            b"---\nname: autre\ndescription: Questionner\n---\n",
            CommandSource::Plugin,
            Some("forge"),
        )
        .unwrap();
        assert_eq!(s.name, "forge:grill");
        assert_eq!(s.kind, CommandKind::Skill);
        assert_eq!(s.plugin.as_deref(), Some("forge"));
        assert!(skill_from_file(".cache", b"", CommandSource::User, None).is_none());
    }

    #[test]
    fn enabled_plugins_layers() {
        let user = json!({"enabledPlugins": {"a@m": true, "b@m": true, "c@m": false, "mauvais": true, "d@m": "oui"}});
        let project = json!({"enabledPlugins": {"b@m": false, "c@m": true}});
        let local = json!({"enabledPlugins": {"e@m.x": true}});
        assert_eq!(
            enabled_plugins(&[Some(user), None, Some(project), Some(local)]),
            ["a@m", "c@m", "e@m.x"]
        );
    }

    #[test]
    fn installs_prefer_matching_project_entry() {
        let installed = json!({"version": 2, "plugins": {
            "a@m": [
                {"scope": "project", "projectPath": "/autre", "installPath": "/c/a/1"},
                {"scope": "user", "installPath": "/c/a/2"},
                {"scope": "local", "projectPath": "/proj", "installPath": "/c/a/3"}
            ],
            "b@m": [{"scope": "project", "projectPath": "/autre", "installPath": "/c/b/1"}],
            "c@m": {"installPath": "/c/c/1"},
            "d@m": [{"scope": "user", "installPath": "relatif"}]
        }});
        let enabled = ["a@m", "b@m", "c@m", "d@m", "absent@m"].map(String::from);
        let got = plugin_installs(
            &installed,
            &enabled,
            &[Path::new("/proj/sous"), Path::new("/proj")],
        );
        assert_eq!(
            got,
            [
                PluginInstall {
                    key: "a@m".into(),
                    install_path: "/c/a/3".into()
                },
                PluginInstall {
                    key: "c@m".into(),
                    install_path: "/c/c/1".into()
                },
            ]
        );
    }

    #[test]
    fn plugin_names() {
        assert_eq!(
            plugin_name(Some(&json!({"name": "forge"})), "x@m").as_deref(),
            Some("forge")
        );
        assert_eq!(
            plugin_name(Some(&json!({"name": "a b"})), "x@m").as_deref(),
            Some("x")
        );
        assert_eq!(plugin_name(None, "y@m").as_deref(), Some("y"));
    }

    #[test]
    fn builtin_list_is_valid() {
        let (version, list) = builtin_commands();
        assert!(!version.is_empty());
        assert!(list.len() > 30);
        let mut names = HashSet::new();
        for c in list {
            assert!(valid_segment(&c.name), "{}", c.name);
            assert!(c.description.is_some(), "{}", c.name);
            assert!(names.insert(c.name.clone()), "doublon {}", c.name);
            for a in &c.aliases {
                assert!(valid_segment(a));
                assert!(names.insert(a.clone()), "alias en double {a}");
            }
        }
        let model = list.iter().find(|c| c.name == "model").unwrap();
        assert!(model.interactive);
        let compact = list.iter().find(|c| c.name == "compact").unwrap();
        assert!(!compact.interactive);
    }

    fn cmd(name: &str, source: CommandSource) -> SlashCommand {
        SlashCommand {
            name: name.into(),
            description: Some(format!("{name} {}", source.as_str())),
            argument_hint: None,
            aliases: Vec::new(),
            source,
            kind: CommandKind::Command,
            interactive: false,
            plugin: None,
            conflict: None,
        }
    }

    #[test]
    fn merge_never_masks_builtins_nor_plugins() {
        use CommandConflict as K;
        use CommandSource::*;
        let mut clear = cmd("clear", Builtin);
        clear.aliases = vec!["reset".into()];
        let (out, truncated) = merge(vec![
            vec![
                cmd("z", Project),
                cmd("review", Project),
                cmd("compact", Project),
                cmd("p:x", Project),
            ],
            vec![cmd("review", User), cmd("a", User), cmd("reset", User)],
            vec![clear, cmd("compact", Builtin), cmd("a", Builtin)],
            vec![cmd("p:x", Plugin)],
        ]);
        assert!(!truncated);
        let got: Vec<(&str, CommandSource, Option<K>)> = out
            .iter()
            .map(|c| (c.name.as_str(), c.source, c.conflict))
            .collect();
        assert_eq!(
            got,
            [
                ("a", Builtin, None),
                ("clear", Builtin, None),
                ("compact", Builtin, None),
                ("compact", Project, Some(K::Builtin)),
                ("p:x", Project, Some(K::Plugin)),
                ("review", Project, None),
                ("z", Project, None),
                ("a", User, Some(K::Builtin)),
                ("reset", User, Some(K::Builtin)),
                ("p:x", Plugin, None),
            ]
        );
        // L'intégrée garde sa description d'origine.
        assert_eq!(out[2].description.as_deref(), Some("compact builtin"));
    }

    #[test]
    fn merge_truncates() {
        let many: Vec<SlashCommand> = (0..MAX_COMMANDS + 5)
            .map(|i| cmd(&format!("c{i}"), CommandSource::User))
            .collect();
        let (out, truncated) = merge(vec![vec![cmd("b", CommandSource::Builtin)], many]);
        assert!(truncated);
        assert_eq!(out.len(), MAX_COMMANDS);
        assert_eq!(out[0].name, "b");
    }
}
