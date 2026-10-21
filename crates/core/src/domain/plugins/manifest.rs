//! Manifeste d'un plugin (`plugin.json`) : validation stricte et empreinte.
//!
//! Tout champ inconnu, toute borne dépassée, toute permission inconnue rend
//! le manifeste **invalide** (rien n'est corrigé ni ignoré) ; les erreurs
//! sont des textes en français, toutes relevées d'un coup.

use serde_json::{Map, Value};

use super::{
    API_VERSION, MAX_MANIFEST_BYTES, Permission, TextMode, char_len, clean_third_party, invisible,
    is_action_id, is_clean_line, is_plugin_name,
};

/// Longueur maximale (caractères) d'un libellé.
pub const MAX_LABEL_CHARS: usize = 64;
/// Longueur maximale (caractères) d'une description.
pub const MAX_DESCRIPTION_CHARS: usize = 400;
/// Éléments de `command` au plus.
pub const MAX_COMMAND_ARGS: usize = 32;
/// Longueur maximale (caractères) d'un élément de `command`.
pub const MAX_COMMAND_ARG_CHARS: usize = 4096;
/// Fichiers hachés au plus.
pub const MAX_FILES: usize = 64;
/// Longueur maximale (caractères) d'un chemin de `files`.
pub const MAX_FILE_PATH_CHARS: usize = 256;
/// Actions au plus.
pub const MAX_ACTIONS: usize = 16;
/// Taille maximale de `config` (JSON compact).
pub const MAX_CONFIG_BYTES: usize = 16 * 1024;
/// Préfixe haché en tête de l'empreinte.
pub const FINGERPRINT_PREFIX: &[u8] = b"devmaestro-plugin-v1\0";

/// Texte en français et en anglais.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Localized {
    pub fr: String,
    pub en: String,
}

impl Localized {
    pub fn json(&self) -> Value {
        serde_json::json!({"fr": self.fr, "en": self.en})
    }

    /// Texte dans la langue demandée (`fr` par défaut).
    pub fn get(&self, locale: &str) -> &str {
        if locale == "en" { &self.en } else { &self.fr }
    }
}

/// Programme d'un plugin (premier élément de `command`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Program {
    /// Nom simple, cherché dans le `PATH` du démon au lancement.
    Named(String),
    /// Chemin absolu.
    Absolute(String),
    /// `./…` : chemin relatif au dossier du plugin (sans `./`), dans `files`.
    Local(String),
}

/// Action déclarée (`contributes.actions`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActionDecl {
    pub id: String,
    pub label: Localized,
    pub propose: bool,
}

/// Manifeste validé.
#[derive(Debug, Clone, PartialEq)]
pub struct Manifest {
    pub name: String,
    pub version: String,
    pub label: Localized,
    pub description: Option<Localized>,
    pub command: Vec<String>,
    pub program: Program,
    pub files: Vec<String>,
    pub permissions: Vec<Permission>,
    /// `contributes.session_tab.label`.
    pub session_tab: Option<Localized>,
    pub actions: Vec<ActionDecl>,
    /// `config`, transmis tel quel par `initialize` (`{}` s'il est absent).
    pub config: Value,
    /// `config` figure dans le manifeste (montré à l'acceptation).
    pub config_declared: bool,
}

impl Manifest {
    pub fn has(&self, p: Permission) -> bool {
        self.permissions.contains(&p)
    }

    pub fn action(&self, id: &str) -> Option<&ActionDecl> {
        self.actions.iter().find(|a| a.id == id)
    }
}

/// Erreurs gardées au plus pour un manifeste (puis « … et N autres »).
pub const MAX_ERRORS: usize = 20;
/// Longueur maximale (caractères) d'un message d'erreur.
pub const MAX_ERROR_CHARS: usize = 200;
/// Longueur maximale (caractères) d'un texte du plugin cité dans une erreur.
const MAX_ECHO_CHARS: usize = 40;

/// Texte du plugin cité dans une erreur : nettoyé (texte tiers), d'une
/// ligne, [`MAX_ECHO_CHARS`] caractères au plus.
fn echo(s: &str) -> String {
    let clean = clean_third_party(s, TextMode::OneLine);
    if char_len(&clean) <= MAX_ECHO_CHARS {
        return clean;
    }
    let mut out: String = clean.chars().take(MAX_ECHO_CHARS).collect();
    out.push('…');
    out
}

/// Erreurs montrables : chacune nettoyée et coupée à [`MAX_ERROR_CHARS`]
/// caractères, [`MAX_ERRORS`] au plus suivies de « … et N autres ».
pub fn cap_errors(errors: Vec<String>) -> Vec<String> {
    let total = errors.len();
    let mut out: Vec<String> = errors
        .into_iter()
        .take(MAX_ERRORS)
        .map(|e| {
            let e = clean_third_party(&e, TextMode::OneLine);
            if char_len(&e) <= MAX_ERROR_CHARS {
                e
            } else {
                let mut t: String = e.chars().take(MAX_ERROR_CHARS).collect();
                t.push('…');
                t
            }
        })
        .collect();
    if total > MAX_ERRORS {
        out.push(format!("… et {} autres erreurs", total - MAX_ERRORS));
    }
    out
}

/// Texte de `config` (clés et valeurs) sans invisible ni contrôle autre que
/// saut de ligne et tabulation ?
fn clean_config(v: &Value) -> bool {
    let ok = |s: &str| {
        !s.chars()
            .any(|c| invisible(c) || (c.is_control() && c != '\n' && c != '\t'))
    };
    match v {
        Value::String(s) => ok(s),
        Value::Array(a) => a.iter().all(clean_config),
        Value::Object(o) => o.iter().all(|(k, v)| ok(k) && clean_config(v)),
        _ => true,
    }
}

struct Errors(Vec<String>);

impl Errors {
    fn push(&mut self, e: impl Into<String>) {
        self.0.push(e.into());
    }
}

/// Champs inconnus d'un objet → erreurs.
fn unknown_fields(obj: &Map<String, Value>, known: &[&str], at: &str, errs: &mut Errors) {
    for k in obj.keys() {
        if !known.contains(&k.as_str()) {
            errs.push(format!("{at} : champ inconnu « {} »", echo(k)));
        }
    }
}

/// Texte d'une ligne non vide, sans contrôle ni invisible, `max` caractères.
fn line(v: Option<&Value>, at: &str, max: usize, errs: &mut Errors) -> Option<String> {
    match v {
        None => {
            errs.push(format!("{at} manquant"));
            None
        }
        Some(Value::String(s)) => {
            if s.trim().is_empty() {
                errs.push(format!("{at} : texte vide"));
                None
            } else if char_len(s) > max {
                errs.push(format!("{at} : plus de {max} caractères"));
                None
            } else if !is_clean_line(s) {
                errs.push(format!(
                    "{at} : saut de ligne, caractère de contrôle ou invisible interdit"
                ));
                None
            } else {
                Some(s.clone())
            }
        }
        Some(_) => {
            errs.push(format!("{at} : texte attendu"));
            None
        }
    }
}

/// `{fr, en}`, chacun d'une ligne et de `max` caractères au plus.
fn localized(v: Option<&Value>, at: &str, max: usize, errs: &mut Errors) -> Option<Localized> {
    match v {
        None => {
            errs.push(format!("{at} manquant"));
            None
        }
        Some(Value::Object(o)) => {
            unknown_fields(o, &["fr", "en"], at, errs);
            let fr = line(o.get("fr"), &format!("{at}.fr"), max, errs);
            let en = line(o.get("en"), &format!("{at}.en"), max, errs);
            Some(Localized { fr: fr?, en: en? })
        }
        Some(_) => {
            errs.push(format!("{at} : objet {{fr, en}} attendu"));
            None
        }
    }
}

/// Chemin relatif valide pour `files` : sans `..`, sans composant caché ni
/// vide, sans `/` initial, sans octet nul, [`MAX_FILE_PATH_CHARS`] au plus.
pub fn valid_rel_path(p: &str) -> Result<(), String> {
    if p.is_empty() {
        return Err("chemin vide".into());
    }
    if char_len(p) > MAX_FILE_PATH_CHARS {
        return Err(format!("plus de {MAX_FILE_PATH_CHARS} caractères"));
    }
    if p.starts_with('/') {
        return Err("chemin absolu interdit".into());
    }
    if p.chars()
        .any(|c| c == '\0' || c == '\\' || c.is_control() || invisible(c))
    {
        return Err("caractère de contrôle, invisible ou « \\ » interdit".into());
    }
    for comp in p.split('/') {
        if comp.is_empty() {
            return Err("composant vide".into());
        }
        if comp == ".." || comp == "." {
            return Err("« . » et « .. » interdits".into());
        }
        if comp.starts_with('.') {
            return Err("composant caché interdit".into());
        }
    }
    Ok(())
}

/// `^[0-9A-Za-z.+-]{1,32}$`.
fn valid_version(v: &str) -> bool {
    (1..=32).contains(&v.len())
        && v.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'+' | b'-'))
}

/// Analyse et valide un manifeste (`bytes` : contenu exact de `plugin.json`,
/// `dir_name` : nom du dossier du plugin). `Err` : les erreurs relevées, en
/// français, bornées par [`cap_errors`].
pub fn parse_manifest(bytes: &[u8], dir_name: &str) -> Result<Manifest, Vec<String>> {
    if bytes.len() > MAX_MANIFEST_BYTES {
        return Err(vec![format!(
            "plugin.json : plus de {} Kio",
            MAX_MANIFEST_BYTES / 1024
        )]);
    }
    let root: Value = match serde_json::from_slice(bytes) {
        Ok(v) => v,
        Err(e) => return Err(vec![format!("plugin.json : JSON invalide ({e})")]),
    };
    let Value::Object(root) = root else {
        return Err(vec!["plugin.json : objet JSON attendu".into()]);
    };
    let mut errs = Errors(Vec::new());
    unknown_fields(
        &root,
        &[
            "api_version",
            "name",
            "version",
            "label",
            "description",
            "command",
            "files",
            "permissions",
            "contributes",
            "config",
        ],
        "plugin.json",
        &mut errs,
    );

    match root.get("api_version") {
        Some(Value::Number(n)) if n.as_u64() == Some(API_VERSION) => {}
        None => errs.push("api_version manquant"),
        Some(_) => errs.push(format!("api_version : {API_VERSION} attendu")),
    }

    let name = match root.get("name") {
        Some(Value::String(n)) if is_plugin_name(n) => {
            if n != dir_name {
                errs.push(format!(
                    "name : « {n} » diffère du nom du dossier « {dir_name} »"
                ));
            }
            Some(n.clone())
        }
        Some(Value::String(_)) => {
            errs.push("name : ^[a-z0-9][a-z0-9-]{0,39}$ attendu");
            None
        }
        None => {
            errs.push("name manquant");
            None
        }
        Some(_) => {
            errs.push("name : texte attendu");
            None
        }
    };

    let version = match root.get("version") {
        Some(Value::String(v)) if valid_version(v) => Some(v.clone()),
        None => {
            errs.push("version manquante");
            None
        }
        Some(_) => {
            errs.push("version : ^[0-9A-Za-z.+-]{1,32}$ attendu");
            None
        }
    };

    let label = localized(root.get("label"), "label", MAX_LABEL_CHARS, &mut errs);
    let description = match root.get("description") {
        None => None,
        v => localized(v, "description", MAX_DESCRIPTION_CHARS, &mut errs),
    };

    // files (avant command : un programme `./…` doit y figurer).
    let mut files: Vec<String> = Vec::new();
    match root.get("files") {
        None => {}
        Some(Value::Array(a)) => {
            if a.len() > MAX_FILES {
                errs.push(format!("files : plus de {MAX_FILES} fichiers"));
            }
            for (i, f) in a.iter().enumerate() {
                match f {
                    Value::String(p) => match valid_rel_path(p) {
                        Ok(()) if files.contains(p) => {
                            errs.push(format!("files[{i}] : « {p} » en double"));
                        }
                        Ok(()) => files.push(p.clone()),
                        Err(why) => errs.push(format!("files[{i}] : {why}")),
                    },
                    _ => errs.push(format!("files[{i}] : texte attendu")),
                }
            }
        }
        Some(_) => errs.push("files : liste attendue"),
    }

    let mut command: Vec<String> = Vec::new();
    let mut program = None;
    match root.get("command") {
        None => errs.push("command manquante"),
        Some(Value::Array(a)) => {
            if a.is_empty() || a.len() > MAX_COMMAND_ARGS {
                errs.push(format!("command : 1 à {MAX_COMMAND_ARGS} éléments"));
            }
            for (i, c) in a.iter().enumerate() {
                match c {
                    Value::String(s) if s.is_empty() => {
                        errs.push(format!("command[{i}] : texte vide"));
                    }
                    Value::String(s) if char_len(s) > MAX_COMMAND_ARG_CHARS => {
                        errs.push(format!(
                            "command[{i}] : plus de {MAX_COMMAND_ARG_CHARS} caractères"
                        ));
                    }
                    Value::String(s) if !is_clean_line(s) => {
                        errs.push(format!(
                            "command[{i}] : octet nul, caractère de contrôle ou invisible interdit"
                        ));
                    }
                    Value::String(s) => command.push(s.clone()),
                    _ => errs.push(format!("command[{i}] : texte attendu")),
                }
            }
            if command.len() == a.len()
                && let Some(first) = command.first()
            {
                if let Some(rel) = first.strip_prefix("./") {
                    match valid_rel_path(rel) {
                        Ok(()) if files.iter().any(|f| f == rel) => {
                            program = Some(Program::Local(rel.to_owned()));
                        }
                        Ok(()) => errs.push(format!(
                            "command[0] : « {} » doit figurer dans files",
                            echo(first)
                        )),
                        Err(why) => errs.push(format!("command[0] : {why}")),
                    }
                } else if first.starts_with('/') {
                    program = Some(Program::Absolute(first.clone()));
                } else if first.contains('/') {
                    errs.push("command[0] : nom simple, chemin absolu ou chemin « ./… » attendu");
                } else {
                    program = Some(Program::Named(first.clone()));
                }
            }
        }
        Some(_) => errs.push("command : liste attendue"),
    }

    let mut permissions: Vec<Permission> = Vec::new();
    match root.get("permissions") {
        None => {}
        Some(Value::Array(a)) => {
            for (i, p) in a.iter().enumerate() {
                match p.as_str().map(|s| (s, Permission::parse(s))) {
                    Some((_, Some(perm))) if permissions.contains(&perm) => {
                        errs.push(format!(
                            "permissions[{i}] : « {} » en double",
                            perm.as_str()
                        ));
                    }
                    Some((_, Some(perm))) => permissions.push(perm),
                    Some((s, None)) => {
                        errs.push(format!(
                            "permissions[{i}] : permission inconnue « {} »",
                            echo(s)
                        ));
                    }
                    None => errs.push(format!("permissions[{i}] : texte attendu")),
                }
            }
        }
        Some(_) => errs.push("permissions : liste attendue"),
    }

    let mut session_tab = None;
    let mut actions: Vec<ActionDecl> = Vec::new();
    match root.get("contributes") {
        None => {}
        Some(Value::Object(c)) => {
            unknown_fields(c, &["session_tab", "actions"], "contributes", &mut errs);
            match c.get("session_tab") {
                None => {}
                Some(Value::Object(t)) => {
                    unknown_fields(t, &["label"], "contributes.session_tab", &mut errs);
                    session_tab = localized(
                        t.get("label"),
                        "contributes.session_tab.label",
                        MAX_LABEL_CHARS,
                        &mut errs,
                    );
                }
                Some(_) => errs.push("contributes.session_tab : objet attendu"),
            }
            match c.get("actions") {
                None => {}
                Some(Value::Array(a)) => {
                    if a.len() > MAX_ACTIONS {
                        errs.push(format!(
                            "contributes.actions : plus de {MAX_ACTIONS} actions"
                        ));
                    }
                    for (i, act) in a.iter().enumerate() {
                        let at = format!("contributes.actions[{i}]");
                        let Value::Object(o) = act else {
                            errs.push(format!("{at} : objet attendu"));
                            continue;
                        };
                        unknown_fields(o, &["id", "label", "propose"], &at, &mut errs);
                        let id = match o.get("id") {
                            Some(Value::String(id)) if is_action_id(id) => {
                                if actions.iter().any(|x| &x.id == id) {
                                    errs.push(format!("{at}.id : « {id} » en double"));
                                    None
                                } else {
                                    Some(id.clone())
                                }
                            }
                            None => {
                                errs.push(format!("{at}.id manquant"));
                                None
                            }
                            Some(_) => {
                                errs.push(format!("{at}.id : ^[a-z0-9][a-z0-9-]{{0,31}}$ attendu"));
                                None
                            }
                        };
                        let label = localized(
                            o.get("label"),
                            &format!("{at}.label"),
                            MAX_LABEL_CHARS,
                            &mut errs,
                        );
                        let propose = match o.get("propose") {
                            None => false,
                            Some(Value::Bool(b)) => *b,
                            Some(_) => {
                                errs.push(format!("{at}.propose : booléen attendu"));
                                false
                            }
                        };
                        if propose && !permissions.contains(&Permission::ClaudePropose) {
                            errs.push(format!(
                                "{at} : « propose » exige la permission claude.propose"
                            ));
                        }
                        if let (Some(id), Some(label)) = (id, label) {
                            actions.push(ActionDecl { id, label, propose });
                        }
                    }
                }
                Some(_) => errs.push("contributes.actions : liste attendue"),
            }
        }
        Some(_) => errs.push("contributes : objet attendu"),
    }

    let config = match root.get("config") {
        None => Value::Object(Map::new()),
        Some(v @ Value::Object(_)) => {
            if serde_json::to_vec(v).map_or(usize::MAX, |b| b.len()) > MAX_CONFIG_BYTES {
                errs.push(format!("config : plus de {} Kio", MAX_CONFIG_BYTES / 1024));
            }
            if !clean_config(v) {
                errs.push("config : caractère invisible ou de contrôle interdit (clé ou texte)");
            }
            v.clone()
        }
        Some(_) => {
            errs.push("config : objet attendu");
            Value::Null
        }
    };

    if !errs.0.is_empty() {
        return Err(cap_errors(errs.0));
    }
    match (name, version, label, program) {
        (Some(name), Some(version), Some(label), Some(program)) => Ok(Manifest {
            name,
            version,
            label,
            description,
            command,
            program,
            files,
            permissions,
            session_tab,
            actions,
            config,
            config_declared: root.contains_key("config"),
        }),
        _ => Err(vec!["plugin.json : manifeste incomplet".into()]),
    }
}

/// Empreinte d'un plugin : sha256 (hexadécimal minuscule) de
/// `"devmaestro-plugin-v1\0"`, puis de la longueur du manifeste (u64 grand
/// boutiste) et de ses octets exacts, puis, dans l'ordre trié des chemins
/// (octets UTF-8), de chaque fichier : longueur du chemin, chemin, longueur
/// du contenu, contenu (longueurs en u64 grand boutiste).
pub fn fingerprint(manifest: &[u8], files: &[(String, Vec<u8>)]) -> String {
    use ring::digest::{Context, SHA256};
    let mut ctx = Context::new(&SHA256);
    ctx.update(FINGERPRINT_PREFIX);
    let mut put = |b: &[u8]| {
        ctx.update(&(b.len() as u64).to_be_bytes());
        ctx.update(b);
    };
    put(manifest);
    let mut sorted: Vec<&(String, Vec<u8>)> = files.iter().collect();
    sorted.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    for (path, content) in sorted {
        put(path.as_bytes());
        put(content);
    }
    ctx.finish()
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn example() -> Value {
        json!({"api_version": 1, "name": "codegraph-impact", "version": "0.1.0",
         "label": {"fr": "Impact du diff", "en": "Diff impact"},
         "description": {"fr": "Symboles touchés", "en": "Touched symbols"},
         "command": ["python3", "-I", "codegraph_impact.py"],
         "files": ["codegraph_impact.py"],
         "permissions": ["diff.read", "worktree.read", "worktree.write", "claude.propose"],
         "contributes": {
           "session_tab": {"label": {"fr": "Impact", "en": "Impact"}},
           "actions": [{"id": "index", "label": {"fr": "Indexer", "en": "Index"}},
                       {"id": "send-impact", "label": {"fr": "Envoyer l'impact à Claude", "en": "Send the impact to Claude"}, "propose": true}]},
         "config": {"codegraph": null, "depth": 2}})
    }

    fn parse(v: &Value) -> Result<Manifest, Vec<String>> {
        parse_manifest(&serde_json::to_vec(v).unwrap(), "codegraph-impact")
    }

    /// Le manifeste modifié par `f` est refusé avec une erreur contenant `needle`.
    fn refused(f: impl FnOnce(&mut Value), needle: &str) {
        let mut v = example();
        f(&mut v);
        let errs = parse(&v).expect_err(needle);
        assert!(
            errs.iter().any(|e| e.contains(needle)),
            "« {needle} » attendu dans {errs:?}"
        );
    }

    #[test]
    fn contract_example_is_valid() {
        let m = parse(&example()).unwrap();
        assert_eq!(m.name, "codegraph-impact");
        assert_eq!(m.program, Program::Named("python3".into()));
        assert_eq!(m.files, ["codegraph_impact.py"]);
        assert!(m.has(Permission::ClaudePropose));
        assert!(m.action("send-impact").unwrap().propose);
        assert!(!m.action("index").unwrap().propose);
        assert_eq!(m.session_tab.as_ref().unwrap().get("en"), "Impact");
        assert_eq!(m.config, json!({"codegraph": null, "depth": 2}));
        // Minimal : config absente → {}.
        let m = parse_manifest(
            br#"{"api_version":1,"name":"x","version":"1","label":{"fr":"X","en":"X"},"command":["/bin/true"]}"#,
            "x",
        )
        .unwrap();
        assert_eq!(m.config, json!({}));
        assert_eq!(m.program, Program::Absolute("/bin/true".into()));
        assert!(m.permissions.is_empty() && m.actions.is_empty() && m.session_tab.is_none());
    }

    #[test]
    fn every_rule_is_enforced() {
        refused(|v| v["api_version"] = json!(2), "api_version");
        refused(|v| v["extra"] = json!(1), "champ inconnu « extra »");
        refused(|v| v["label"]["de"] = json!("x"), "champ inconnu « de »");
        refused(
            |v| v["contributes"]["badge"] = json!({}),
            "champ inconnu « badge »",
        );
        refused(
            |v| v["contributes"]["actions"][0]["x"] = json!(1),
            "champ inconnu « x »",
        );
        refused(|v| v["name"] = json!("autre"), "nom du dossier");
        refused(|v| v["name"] = json!("Codegraph"), "name");
        refused(|v| v["version"] = json!("1 0"), "version");
        refused(|v| v["version"] = json!("x".repeat(33)), "version");
        refused(|v| v["label"] = json!({"fr": "x"}), "label.en manquant");
        refused(|v| v["label"]["fr"] = json!("x".repeat(65)), "64");
        refused(|v| v["label"]["fr"] = json!("a\nb"), "label.fr");
        refused(|v| v["label"]["fr"] = json!("a\u{202E}b"), "invisible");
        refused(|v| v["description"]["en"] = json!("x".repeat(401)), "400");
        refused(|v| v["command"] = json!([]), "command");
        refused(|v| v["command"] = json!([""]), "vide");
        refused(|v| v["command"] = json!(vec!["a"; 33]), "command");
        refused(|v| v["command"][0] = json!("bin/python"), "command[0]");
        refused(|v| v["command"][0] = json!("./run.sh"), "files");
        refused(|v| v["command"][1] = json!("a\u{0}b"), "nul");
        refused(|v| v["files"] = json!(["../x"]), "files[0]");
        refused(|v| v["files"] = json!(["/etc/passwd"]), "absolu");
        refused(|v| v["files"] = json!([".env"]), "caché");
        refused(|v| v["files"] = json!(["a//b"]), "vide");
        refused(|v| v["files"] = json!(["a", "a"]), "double");
        refused(|v| v["files"] = json!(vec!["a"; 65]), "64");
        refused(|v| v["files"] = json!(["x".repeat(257)]), "256");
        refused(|v| v["permissions"] = json!(["fs.write"]), "inconnue");
        refused(
            |v| v["permissions"] = json!(["network", "network"]),
            "double",
        );
        refused(
            |v| v["permissions"] = json!(["diff.read"]),
            "exige la permission claude.propose",
        );
        refused(
            |v| v["contributes"]["actions"][1]["id"] = json!("index"),
            "double",
        );
        refused(
            |v| v["contributes"]["actions"][0]["id"] = json!("Index"),
            ".id",
        );
        refused(
            |v| {
                let a: Vec<Value> = (0..17)
                    .map(|i| json!({"id": format!("a{i}"), "label": {"fr": "x", "en": "x"}}))
                    .collect();
                v["contributes"]["actions"] = json!(a);
            },
            "16",
        );
        refused(
            |v| v["config"] = json!({"x": "y".repeat(16 * 1024)}),
            "config",
        );
        refused(|v| v["config"] = json!([1]), "config");
        // JSON invalide, taille.
        assert!(parse_manifest(b"{", "x").unwrap_err()[0].contains("JSON invalide"));
        assert!(parse_manifest(&vec![b' '; 64 * 1024 + 1], "x").unwrap_err()[0].contains("64"));
        // `./…` présent dans files : accepté.
        let mut v = example();
        v["command"] = json!(["./codegraph_impact.py"]);
        assert_eq!(
            parse(&v).unwrap().program,
            Program::Local("codegraph_impact.py".into())
        );
    }

    #[test]
    fn invisible_and_direction_characters_are_refused_everywhere() {
        refused(
            |v| v["command"][2] = json!("codegraph\u{202E}yp.py"),
            "invisible",
        );
        refused(|v| v["command"][1] = json!("-I\u{200B}"), "invisible");
        refused(|v| v["command"][1] = json!("a\nb"), "contrôle");
        refused(|v| v["files"] = json!(["a\u{2066}.py"]), "invisible");
        refused(|v| v["description"]["fr"] = json!("x\u{FEFF}"), "invisible");
        refused(
            |v| v["contributes"]["session_tab"]["label"]["en"] = json!("I\u{202D}mpact"),
            "invisible",
        );
        refused(
            |v| v["contributes"]["actions"][0]["label"]["fr"] = json!("\u{2067}Indexer"),
            "invisible",
        );
        refused(|v| v["config"] = json!({"clé\u{200F}": 1}), "config");
        refused(
            |v| v["config"] = json!({"a": ["b", {"c": "d\u{202E}"}]}),
            "config",
        );
        refused(|v| v["config"] = json!({"a": "\u{1b}[31m"}), "config");
        // Sauts de ligne et tabulations permis dans les textes de config.
        let mut v = example();
        v["config"] = json!({"a": "l1\n\tl2"});
        assert!(parse(&v).is_ok());
    }

    #[test]
    fn errors_are_capped_cleaned_and_short() {
        // Manifeste gonflé à près de 64 Kio : des milliers de champs inconnus
        // aux noms longs et piégés.
        let mut v = example();
        let mut i = 0;
        while serde_json::to_vec(&v).unwrap().len() < 63 * 1024 {
            v[format!("x{i}\u{202E}{}", "é".repeat(100))] = json!(1);
            i += 1;
        }
        let errs = parse(&v).unwrap_err();
        assert_eq!(errs.len(), MAX_ERRORS + 1, "{errs:?}");
        assert_eq!(
            errs.last().unwrap(),
            &format!("… et {} autres erreurs", i - MAX_ERRORS)
        );
        for e in &errs {
            assert!(char_len(e) <= MAX_ERROR_CHARS + 1, "{e}");
            assert!(!e.chars().any(|c| invisible(c) || c.is_control()), "{e:?}");
        }
        assert!(errs[0].contains('…'), "{}", errs[0]);
        // Texte cité nettoyé.
        refused(|v| v["permissions"] = json!(["x\u{202E}y"]), "« xy »");
    }

    #[test]
    fn fingerprint_is_stable_and_covers_everything() {
        let m = serde_json::to_vec(&example()).unwrap();
        let files = vec![
            ("b.py".to_owned(), b"b".to_vec()),
            ("a.py".to_owned(), b"a".to_vec()),
        ];
        let fp = fingerprint(&m, &files);
        assert_eq!(fp.len(), 64);
        // Ordre des fichiers indifférent (trié), résultat stable.
        let mut rev = files.clone();
        rev.reverse();
        assert_eq!(fingerprint(&m, &rev), fp);
        // Contenu, chemin, manifeste : chacun change l'empreinte.
        let mut f2 = files.clone();
        f2[0].1 = b"B".to_vec();
        assert_ne!(fingerprint(&m, &f2), fp);
        let mut f3 = files.clone();
        f3[0].0 = "c.py".into();
        assert_ne!(fingerprint(&m, &f3), fp);
        let mut v = example();
        v["permissions"] = json!(["diff.read", "claude.propose"]);
        assert_ne!(fingerprint(&serde_json::to_vec(&v).unwrap(), &files), fp);
        // Longueurs en tête : pas de collision par déplacement d'octets.
        assert_ne!(
            fingerprint(b"m", &[("ab".into(), b"c".to_vec())]),
            fingerprint(b"m", &[("a".into(), b"bc".to_vec())])
        );
        // Valeur de référence (format documenté dans docs/protocole.md).
        let mut expected = FINGERPRINT_PREFIX.to_vec();
        expected.extend_from_slice(&1u64.to_be_bytes());
        expected.extend_from_slice(b"m");
        expected.extend_from_slice(&1u64.to_be_bytes());
        expected.extend_from_slice(b"f");
        expected.extend_from_slice(&2u64.to_be_bytes());
        expected.extend_from_slice(b"xy");
        assert_eq!(
            fingerprint(b"m", &[("f".into(), b"xy".to_vec())]),
            crate::domain::files::sha256_hex(&expected)
        );
    }
}
