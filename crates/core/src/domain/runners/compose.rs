//! Fichiers qu'un fichier compose fait lire à `docker compose up` (lot 15) :
//! `include` (toutes formes), `extends.file`, `env_file`, Dockerfile des
//! `build`, `.env` du projet ; de proche en proche.
//!
//! Lecture par l'analyseur **par événements** de `yaml-rust2` : un arbre est
//! construit sans jamais développer un alias (`*ancre` reste une référence),
//! la taille reste celle du texte ; l'imbrication est bornée avant l'analyse
//! (indentation, et 255 niveaux de `[`/`{` au plus côté analyseur).

use std::collections::HashMap;

use yaml_rust2::parser::{Event, MarkedEventReceiver, Parser};
use yaml_rust2::scanner::Marker;

use super::inputs::{FileState, Inputs, parent_dir, resolve_dir, resolve_ref};

/// Indentation au plus (en caractères) d'une ligne analysée : borne la
/// profondeur des blocs, donc la récursion de l'analyseur.
const MAX_INDENT: usize = 512;
/// Nœuds gardés au plus.
const MAX_NODES: usize = 2_000_000;
/// Fusions `<<` suivies au plus en profondeur.
const MAX_MERGE_DEPTH: usize = 8;

#[derive(Debug)]
enum Node {
    Scalar(String),
    Seq(Vec<usize>),
    Map(Vec<(usize, usize)>),
    Alias(usize),
}

#[derive(Default)]
struct Tree {
    nodes: Vec<Node>,
    anchors: HashMap<usize, usize>,
    /// Conteneurs ouverts, et clé en attente d'une valeur (mappings).
    stack: Vec<(usize, Option<usize>)>,
    root: Option<usize>,
    overflow: bool,
    docs: usize,
}

impl Tree {
    fn add(&mut self, node: Node, anchor: usize) -> Option<usize> {
        if self.nodes.len() >= MAX_NODES {
            self.overflow = true;
            return None;
        }
        let i = self.nodes.len();
        self.nodes.push(node);
        if anchor > 0 {
            self.anchors.insert(anchor, i);
        }
        match self.stack.last_mut() {
            None => {
                if self.root.is_none() {
                    self.root = Some(i);
                }
            }
            Some((parent, pending)) => {
                let parent = *parent;
                match pending.take() {
                    Some(k) => {
                        if let Node::Map(m) = &mut self.nodes[parent] {
                            m.push((k, i));
                        }
                    }
                    None => match &mut self.nodes[parent] {
                        Node::Seq(s) => s.push(i),
                        Node::Map(_) => *pending = Some(i),
                        _ => {}
                    },
                }
            }
        }
        Some(i)
    }
}

impl MarkedEventReceiver for Tree {
    fn on_event(&mut self, ev: Event, _mark: Marker) {
        if self.overflow {
            return;
        }
        match ev {
            Event::DocumentStart => self.docs += 1,
            Event::Scalar(v, _, anchor, _) => {
                self.add(Node::Scalar(v), anchor);
            }
            Event::Alias(id) => {
                self.add(Node::Alias(id), 0);
            }
            Event::SequenceStart(anchor, _) => {
                if let Some(i) = self.add(Node::Seq(Vec::new()), anchor) {
                    self.stack.push((i, None));
                }
            }
            Event::MappingStart(anchor, _) => {
                if let Some(i) = self.add(Node::Map(Vec::new()), anchor) {
                    self.stack.push((i, None));
                }
            }
            Event::SequenceEnd | Event::MappingEnd => {
                self.stack.pop();
            }
            _ => {}
        }
    }
}

/// Document compose lu : arbre et racine.
struct Doc {
    tree: Tree,
}

impl Doc {
    fn parse(text: &str) -> Result<Self, String> {
        if text
            .lines()
            .any(|l| l.len() - l.trim_start().len() > MAX_INDENT)
        {
            return Err(format!("indentation de plus de {MAX_INDENT} caractères"));
        }
        let mut tree = Tree::default();
        Parser::new_from_str(text)
            .load(&mut tree, true)
            .map_err(|e| format!("YAML illisible ({e})"))?;
        if tree.overflow {
            return Err("document trop grand".into());
        }
        if tree.docs > 1 {
            return Err("plusieurs documents YAML".into());
        }
        Ok(Self { tree })
    }

    /// Nœud, alias suivi (une fois : une ancre ne désigne pas un alias).
    fn node(&self, i: usize) -> Option<&Node> {
        match self.tree.nodes.get(i)? {
            Node::Alias(id) => match self.tree.nodes.get(*self.tree.anchors.get(id)?)? {
                Node::Alias(_) => None,
                n => Some(n),
            },
            n => Some(n),
        }
    }

    fn scalar(&self, i: usize) -> Option<&str> {
        match self.node(i)? {
            Node::Scalar(s) => Some(s),
            _ => None,
        }
    }

    /// Valeur de `key` dans le mapping `map`, fusions `<<` comprises (la
    /// clé écrite l'emporte sur la fusionnée).
    fn get(&self, map: usize, key: &str) -> Option<usize> {
        self.get_depth(map, key, 0)
    }

    fn get_depth(&self, map: usize, key: &str, depth: usize) -> Option<usize> {
        let Node::Map(entries) = self.node(map)? else {
            return None;
        };
        if let Some((_, v)) = entries.iter().find(|(k, _)| self.scalar(*k) == Some(key)) {
            return Some(*v);
        }
        if depth >= MAX_MERGE_DEPTH {
            return None;
        }
        let (_, merge) = entries
            .iter()
            .find(|(k, _)| self.scalar(*k) == Some("<<"))?;
        match self.node(*merge)? {
            Node::Map(_) => self.get_depth(*merge, key, depth + 1),
            Node::Seq(items) => items
                .iter()
                .find_map(|m| self.get_depth(*m, key, depth + 1)),
            _ => None,
        }
    }

    fn entries(&self, map: usize) -> Vec<(usize, usize)> {
        match self.node(map) {
            Some(Node::Map(e)) => e.clone(),
            _ => Vec::new(),
        }
    }

    fn items(&self, seq: usize) -> Option<Vec<usize>> {
        match self.node(seq)? {
            Node::Seq(s) => Some(s.clone()),
            _ => None,
        }
    }

    fn is_null(&self, i: usize) -> bool {
        matches!(self.scalar(i), Some("" | "~" | "null" | "Null" | "NULL"))
    }
}

/// Texte court d'un nœud pour un marqueur « forme non lue ».
fn shown(doc: &Doc, i: usize) -> String {
    match doc.node(i) {
        Some(Node::Scalar(s)) => s.chars().take(80).collect(),
        Some(Node::Seq(_)) => "[…]".into(),
        Some(Node::Map(_)) => "{…}".into(),
        _ => "*alias".into(),
    }
}

/// Rappel appliqué à chaque chemin lu d'une clé de chemins (`env_file`, etc.).
type EachPath<'a> = Box<dyn for<'b> FnMut(&mut Inputs<'b>, &str) + 'a>;

/// Prend en compte ce que le fichier compose `path` (déjà pris en compte,
/// texte `text`) fait lire ; `project` : dossier du projet (celui du fichier
/// principal), où compose lit `.env`.
pub fn compose_inputs(inputs: &mut Inputs<'_>, path: &str, text: &str) {
    let doc = match Doc::parse(text) {
        Ok(d) => d,
        Err(why) => {
            inputs.marker(
                path,
                FileState::Unresolved,
                &format!("forme non lue : {why} ; fichiers qu'il fait lire non suivis"),
            );
            return;
        }
    };
    let base = parent_dir(path);
    let Some(root) = doc.tree.root else {
        return; // document vide
    };
    let unread = |inputs: &mut Inputs<'_>, what: &str, doc: &Doc, i: usize| {
        inputs.marker(
            path,
            FileState::Unresolved,
            &format!("forme non lue : {what} = {}", shown(doc, i)),
        );
    };
    // Fichier compose suivi : pris en compte, puis lu à son tour.
    let follow = |inputs: &mut Inputs<'_>, base: &str, written: &str, role: &str| {
        if let Ok(p) = resolve_ref(base, written)
            && let Some(t) = inputs.file(&p, role)
        {
            compose_inputs(inputs, &p, &t);
        } else {
            inputs.reference(base, written, role);
        }
    };
    let paths =
        |inputs: &mut Inputs<'_>, doc: &Doc, i: usize, what: &str, mut each: EachPath<'_>| {
            if let Some(s) = doc.scalar(i) {
                each(inputs, s);
            } else if let Some(items) = doc.items(i) {
                for it in items {
                    match doc.scalar(it) {
                        Some(s) => each(inputs, s),
                        None => match doc.get(it, "path").and_then(|p| doc.scalar(p)) {
                            // `env_file: [{path: x, required: false}]`.
                            Some(s) => each(inputs, s),
                            None => unread(inputs, what, doc, it),
                        },
                    }
                }
            } else {
                unread(inputs, what, doc, i);
            }
        };

    if let Some(inc) = doc.get(root, "include") {
        match doc.items(inc) {
            Some(items) => {
                for it in items {
                    if let Some(s) = doc.scalar(it) {
                        follow(inputs, base, s, "inclus (include)");
                        continue;
                    }
                    let Some(p) = doc.get(it, "path") else {
                        unread(inputs, "include", &doc, it);
                        continue;
                    };
                    paths(
                        inputs,
                        &doc,
                        p,
                        "include.path",
                        Box::new(|inputs, s| follow(inputs, base, s, "inclus (include)")),
                    );
                    if let Some(e) = doc.get(it, "env_file") {
                        paths(
                            inputs,
                            &doc,
                            e,
                            "include.env_file",
                            Box::new(|inputs, s| {
                                inputs.reference(base, s, "env_file d'un include");
                            }),
                        );
                    }
                    if let Some(d) = doc.get(it, "project_directory") {
                        match doc.scalar(d) {
                            Some(dir) => match resolve_dir(base, dir) {
                                Ok(dir) => {
                                    inputs.file(&super::join(&dir, ".env"), ".env d'un include");
                                }
                                Err(_) => {
                                    inputs.reference(base, dir, "project_directory d'un include");
                                }
                            },
                            None => unread(inputs, "include.project_directory", &doc, d),
                        }
                    }
                }
            }
            None if doc.is_null(inc) => {}
            None => unread(inputs, "include", &doc, inc),
        }
    }

    let Some(services) = doc.get(root, "services") else {
        return;
    };
    for (k, svc) in doc.entries(services) {
        let name = doc.scalar(k).unwrap_or("?").to_owned();
        if let Some(ext) = doc.get(svc, "extends") {
            if doc.scalar(ext).is_some() {
                // `extends: autre` : service du même fichier.
            } else if let Some(f) = doc.get(ext, "file") {
                match doc.scalar(f) {
                    Some(s) => follow(inputs, base, s, &format!("extends du service {name}")),
                    None => unread(inputs, "extends.file", &doc, f),
                }
            } else if doc.get(ext, "service").is_none() {
                unread(inputs, "extends", &doc, ext);
            }
        }
        if let Some(e) = doc.get(svc, "env_file") {
            let role = format!("env_file du service {name}");
            paths(
                inputs,
                &doc,
                e,
                "env_file",
                Box::new(move |inputs, s| {
                    inputs.reference(base, s, &role);
                }),
            );
        }
        if let Some(b) = doc.get(svc, "build") {
            let (context, dockerfile) = match doc.node(b) {
                Some(Node::Scalar(c)) => (Some(c.clone()), None),
                Some(Node::Map(_)) => {
                    if doc.get(b, "dockerfile_inline").is_some() {
                        continue; // Dockerfile écrit dans ce fichier
                    }
                    let ctx = match doc.get(b, "context") {
                        None => Some(".".to_owned()),
                        Some(c) => doc.scalar(c).map(str::to_owned),
                    };
                    let df = match doc.get(b, "dockerfile") {
                        None => None,
                        Some(d) => match doc.scalar(d) {
                            Some(d) => Some(d.to_owned()),
                            None => {
                                unread(inputs, "build.dockerfile", &doc, d);
                                continue;
                            }
                        },
                    };
                    (ctx, df)
                }
                _ => (None, None),
            };
            let role = format!("Dockerfile du service {name}");
            let Some(context) = context else {
                unread(inputs, "build", &doc, b);
                continue;
            };
            if context.contains("://") || context.starts_with("git@") {
                inputs.marker(
                    &context,
                    FileState::Unresolved,
                    &format!("{role} ; contexte distant"),
                );
                continue;
            }
            let df = dockerfile.unwrap_or_else(|| "Dockerfile".to_owned());
            match resolve_dir(base, &context) {
                Ok(ctx) => {
                    inputs.reference(&ctx, &df, &role);
                }
                Err((state, why)) => {
                    inputs.marker(context.trim(), state, &format!("{role} ; contexte : {why}"));
                }
            }
        }
    }
}
