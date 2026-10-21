//! Documents déclaratifs d'un plugin et résultat d'`action.run` :
//! validation et normalisation (contrat du lot 22a, `docs/v0.3.md`).
//!
//! Seuls les champs connus sont recopiés (un champ inconnu est **retiré**) ;
//! un type de bloc inconnu, un mauvais type de valeur ou une borne dépassée
//! rendent le document **invalide**. Tout texte est du texte tiers, nettoyé
//! par [`clean_third_party`] avant de compter ses caractères. L'app
//! revalide avec le même schéma et les mêmes bornes avant tout rendu.

use serde_json::{Map, Value, json};

use super::{TextMode, char_len, clean_third_party};

/// Longueur maximale (caractères) d'un titre (document, bloc) ou d'une légende.
pub const MAX_TITLE_CHARS: usize = 200;
/// Bornes de `refresh_ms`.
pub const REFRESH_MS: std::ops::RangeInclusive<u64> = 1_000..=60_000;
/// Blocs par document.
pub const MAX_BLOCKS: usize = 50;
/// Texte d'un `notice`, valeur d'un `kv`, texte et détail d'un `list`, cellule.
pub const MAX_TEXT_CHARS: usize = 2_000;
/// Texte d'un bloc `markdown`.
pub const MAX_MARKDOWN_CHARS: usize = 20_000;
/// Éléments d'un `kv`.
pub const MAX_KV_ITEMS: usize = 100;
/// Éléments d'un `list`.
pub const MAX_LIST_ITEMS: usize = 500;
/// Colonnes d'un `table`.
pub const MAX_COLUMNS: usize = 12;
/// Lignes d'un `table`.
pub const MAX_ROWS: usize = 1_000;
/// Libellé d'un nœud de `tree`.
pub const MAX_NODE_LABEL_CHARS: usize = 500;
/// Profondeur d'un `tree`.
pub const MAX_TREE_DEPTH: usize = 8;
/// Nœuds d'un `tree`, en tout.
pub const MAX_TREE_NODES: usize = 2_000;
/// Boutons d'un bloc `actions`.
pub const MAX_ACTION_ITEMS: usize = 10;
/// Libellé d'un bouton d'action.
pub const MAX_ACTION_LABEL_CHARS: usize = 100;
/// Clés de `args`.
pub const MAX_ARGS_KEYS: usize = 16;
/// Valeur texte de `args`.
pub const MAX_ARG_CHARS: usize = 200;
/// Contenu proposé à Claude (`propose.content`).
pub const MAX_PROPOSE_CHARS: usize = 100_000;

type Res<T> = Result<T, String>;

fn obj<'a>(v: &'a Value, at: &str) -> Res<&'a Map<String, Value>> {
    v.as_object().ok_or_else(|| format!("{at} : objet attendu"))
}

fn arr<'a>(v: Option<&'a Value>, at: &str, min: usize, max: usize) -> Res<&'a Vec<Value>> {
    let a = v
        .ok_or_else(|| format!("{at} manquant"))?
        .as_array()
        .ok_or_else(|| format!("{at} : liste attendue"))?;
    if a.len() < min || a.len() > max {
        return Err(format!("{at} : {min} à {max} éléments attendus"));
    }
    Ok(a)
}

/// Texte nettoyé, `max` caractères au plus après nettoyage.
fn text(v: Option<&Value>, at: &str, max: usize, mode: TextMode) -> Res<String> {
    let s = v
        .ok_or_else(|| format!("{at} manquant"))?
        .as_str()
        .ok_or_else(|| format!("{at} : texte attendu"))?;
    let s = clean_third_party(s, mode);
    if char_len(&s) > max {
        return Err(format!("{at} : plus de {max} caractères"));
    }
    Ok(s)
}

/// Texte facultatif (absent ou `null` : absent).
fn opt_text(v: Option<&Value>, at: &str, max: usize, mode: TextMode) -> Res<Option<String>> {
    match v {
        None | Some(Value::Null) => Ok(None),
        some => text(some, at, max, mode).map(Some),
    }
}

fn opt_bool(v: Option<&Value>, at: &str) -> Res<Option<bool>> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(b)) => Ok(Some(*b)),
        Some(_) => Err(format!("{at} : booléen attendu")),
    }
}

/// `^[a-z0-9_-]{1,32}$` (colonnes, clés de `args`).
pub fn is_key(s: &str) -> bool {
    (1..=32).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

/// `args` d'un bouton ou d'un appel `plugins.action` : objet de
/// [`MAX_ARGS_KEYS`] clés au plus, valeurs texte ([`MAX_ARG_CHARS`]),
/// nombre fini ou booléen. Recopié tel quel (ces valeurs repartent au
/// plugin, elles ne sont pas affichées).
pub fn validate_args(v: &Value, at: &str) -> Res<Value> {
    let o = obj(v, at)?;
    if o.len() > MAX_ARGS_KEYS {
        return Err(format!("{at} : plus de {MAX_ARGS_KEYS} clés"));
    }
    for (k, val) in o {
        if !is_key(k) {
            return Err(format!(
                "{at} : clé « {k} » invalide (^[a-z0-9_-]{{1,32}}$)"
            ));
        }
        match val {
            Value::String(s) if char_len(s) > MAX_ARG_CHARS => {
                return Err(format!("{at}.{k} : plus de {MAX_ARG_CHARS} caractères"));
            }
            Value::String(_) | Value::Bool(_) => {}
            Value::Number(n) if n.as_f64().is_some_and(f64::is_finite) => {}
            _ => return Err(format!("{at}.{k} : texte, nombre ou booléen attendu")),
        }
    }
    Ok(v.clone())
}

fn block_title(b: &Map<String, Value>, at: &str, out: &mut Map<String, Value>) -> Res<()> {
    if let Some(t) = opt_text(
        b.get("title"),
        &format!("{at}.title"),
        MAX_TITLE_CHARS,
        TextMode::OneLine,
    )? {
        out.insert("title".into(), json!(t));
    }
    Ok(())
}

fn tree_nodes(v: Option<&Value>, at: &str, depth: usize, count: &mut usize) -> Res<Vec<Value>> {
    if depth > MAX_TREE_DEPTH {
        return Err(format!("{at} : profondeur supérieure à {MAX_TREE_DEPTH}"));
    }
    let nodes = arr(v, at, 0, MAX_TREE_NODES)?;
    let mut out = Vec::with_capacity(nodes.len());
    for (i, n) in nodes.iter().enumerate() {
        let at = format!("{at}[{i}]");
        *count += 1;
        if *count > MAX_TREE_NODES {
            return Err(format!("tree : plus de {MAX_TREE_NODES} nœuds"));
        }
        let n = obj(n, &at)?;
        let mut node = Map::new();
        node.insert(
            "label".into(),
            json!(text(
                n.get("label"),
                &format!("{at}.label"),
                MAX_NODE_LABEL_CHARS,
                TextMode::OneLine
            )?),
        );
        if let Some(d) = opt_text(
            n.get("detail"),
            &format!("{at}.detail"),
            MAX_TEXT_CHARS,
            TextMode::Multiline,
        )? {
            node.insert("detail".into(), json!(d));
        }
        match n.get("children") {
            None | Some(Value::Null) => {}
            children => {
                let c = tree_nodes(children, &format!("{at}.children"), depth + 1, count)?;
                node.insert("children".into(), Value::Array(c));
            }
        }
        out.push(Value::Object(node));
    }
    Ok(out)
}

fn block(v: &Value, at: &str, actions: &[String]) -> Res<Value> {
    let b = obj(v, at)?;
    let kind = b
        .get("type")
        .ok_or_else(|| format!("{at}.type manquant"))?
        .as_str()
        .ok_or_else(|| format!("{at}.type : texte attendu"))?;
    let mut out = Map::new();
    out.insert("type".into(), json!(kind));
    block_title(b, at, &mut out)?;
    match kind {
        "notice" => {
            let level = b
                .get("level")
                .and_then(Value::as_str)
                .filter(|l| matches!(*l, "info" | "warning" | "error"))
                .ok_or_else(|| format!("{at}.level : info, warning ou error attendu"))?;
            out.insert("level".into(), json!(level));
            out.insert(
                "text".into(),
                json!(text(
                    b.get("text"),
                    &format!("{at}.text"),
                    MAX_TEXT_CHARS,
                    TextMode::Multiline
                )?),
            );
        }
        "markdown" => {
            out.insert(
                "text".into(),
                json!(text(
                    b.get("text"),
                    &format!("{at}.text"),
                    MAX_MARKDOWN_CHARS,
                    TextMode::Multiline
                )?),
            );
        }
        "kv" => {
            let items = arr(b.get("items"), &format!("{at}.items"), 1, MAX_KV_ITEMS)?;
            let mut v = Vec::with_capacity(items.len());
            for (i, it) in items.iter().enumerate() {
                let at = format!("{at}.items[{i}]");
                let it = obj(it, &at)?;
                v.push(json!({
                    "key": text(it.get("key"), &format!("{at}.key"), MAX_TITLE_CHARS, TextMode::OneLine)?,
                    "value": text(it.get("value"), &format!("{at}.value"), MAX_TEXT_CHARS, TextMode::Plain)?,
                }));
            }
            out.insert("items".into(), Value::Array(v));
        }
        "list" => {
            if let Some(o) = opt_bool(b.get("ordered"), &format!("{at}.ordered"))? {
                out.insert("ordered".into(), json!(o));
            }
            let items = arr(b.get("items"), &format!("{at}.items"), 0, MAX_LIST_ITEMS)?;
            let mut v = Vec::with_capacity(items.len());
            for (i, it) in items.iter().enumerate() {
                let at = format!("{at}.items[{i}]");
                let it = obj(it, &at)?;
                let mut item = Map::new();
                item.insert(
                    "text".into(),
                    json!(text(
                        it.get("text"),
                        &format!("{at}.text"),
                        MAX_TEXT_CHARS,
                        TextMode::Plain
                    )?),
                );
                if let Some(d) = opt_text(
                    it.get("detail"),
                    &format!("{at}.detail"),
                    MAX_TEXT_CHARS,
                    TextMode::Multiline,
                )? {
                    item.insert("detail".into(), json!(d));
                }
                v.push(Value::Object(item));
            }
            out.insert("items".into(), Value::Array(v));
        }
        "table" => {
            if let Some(c) = opt_text(
                b.get("caption"),
                &format!("{at}.caption"),
                MAX_TITLE_CHARS,
                TextMode::OneLine,
            )? {
                out.insert("caption".into(), json!(c));
            }
            let cols = arr(b.get("columns"), &format!("{at}.columns"), 1, MAX_COLUMNS)?;
            let mut ids: Vec<String> = Vec::new();
            let mut columns = Vec::with_capacity(cols.len());
            for (i, c) in cols.iter().enumerate() {
                let at = format!("{at}.columns[{i}]");
                let c = obj(c, &at)?;
                let id = c
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| is_key(id))
                    .ok_or_else(|| format!("{at}.id : ^[a-z0-9_-]{{1,32}}$ attendu"))?;
                if ids.iter().any(|x| x == id) {
                    return Err(format!("{at}.id : « {id} » en double"));
                }
                ids.push(id.to_owned());
                let mut col = Map::new();
                col.insert("id".into(), json!(id));
                col.insert(
                    "label".into(),
                    json!(text(
                        c.get("label"),
                        &format!("{at}.label"),
                        MAX_TITLE_CHARS,
                        TextMode::OneLine
                    )?),
                );
                match c.get("align") {
                    None | Some(Value::Null) => {}
                    Some(Value::String(a)) if a == "start" || a == "end" => {
                        col.insert("align".into(), json!(a));
                    }
                    Some(_) => return Err(format!("{at}.align : start ou end attendu")),
                }
                columns.push(Value::Object(col));
            }
            out.insert("columns".into(), Value::Array(columns));
            let rows = arr(b.get("rows"), &format!("{at}.rows"), 0, MAX_ROWS)?;
            let mut v = Vec::with_capacity(rows.len());
            for (i, r) in rows.iter().enumerate() {
                let at = format!("{at}.rows[{i}]");
                let r = obj(r, &at)?;
                let mut row = Map::new();
                for id in &ids {
                    match r.get(id) {
                        None => {}
                        Some(Value::Null) => {
                            row.insert(id.clone(), Value::Null);
                        }
                        Some(Value::Number(n)) if n.as_f64().is_some_and(f64::is_finite) => {
                            row.insert(id.clone(), Value::Number(n.clone()));
                        }
                        s @ Some(Value::String(_)) => {
                            row.insert(
                                id.clone(),
                                json!(text(
                                    s,
                                    &format!("{at}.{id}"),
                                    MAX_TEXT_CHARS,
                                    TextMode::Plain
                                )?),
                            );
                        }
                        Some(_) => {
                            return Err(format!("{at}.{id} : texte, nombre ou null attendu"));
                        }
                    }
                }
                v.push(Value::Object(row));
            }
            out.insert("rows".into(), Value::Array(v));
        }
        "tree" => {
            let mut count = 0;
            let nodes = tree_nodes(b.get("nodes"), &format!("{at}.nodes"), 1, &mut count)?;
            out.insert("nodes".into(), Value::Array(nodes));
        }
        "actions" => {
            let items = arr(b.get("items"), &format!("{at}.items"), 1, MAX_ACTION_ITEMS)?;
            let mut v = Vec::with_capacity(items.len());
            for (i, it) in items.iter().enumerate() {
                let at = format!("{at}.items[{i}]");
                let it = obj(it, &at)?;
                let id = it
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| format!("{at}.id : texte attendu"))?;
                if !actions.iter().any(|a| a == id) {
                    return Err(format!(
                        "{at}.id : action « {} » non déclarée dans le manifeste",
                        clean_third_party(id, TextMode::OneLine)
                            .chars()
                            .take(40)
                            .collect::<String>()
                    ));
                }
                let mut item = Map::new();
                item.insert("id".into(), json!(id));
                item.insert(
                    "label".into(),
                    json!(text(
                        it.get("label"),
                        &format!("{at}.label"),
                        MAX_ACTION_LABEL_CHARS,
                        TextMode::OneLine
                    )?),
                );
                match it.get("args") {
                    None | Some(Value::Null) => {}
                    Some(a) => {
                        item.insert("args".into(), validate_args(a, &format!("{at}.args"))?);
                    }
                }
                if let Some(p) = opt_bool(it.get("primary"), &format!("{at}.primary"))? {
                    item.insert("primary".into(), json!(p));
                }
                v.push(Value::Object(item));
            }
            out.insert("items".into(), Value::Array(v));
        }
        other => {
            return Err(format!(
                "{at}.type : type de bloc inconnu « {} »",
                clean_third_party(other, TextMode::OneLine)
                    .chars()
                    .take(40)
                    .collect::<String>()
            ));
        }
    }
    Ok(Value::Object(out))
}

/// Valide et normalise un document (`actions` : identifiants des actions
/// déclarées dans le manifeste). `Err` : le problème, en français.
pub fn validate_document(v: &Value, actions: &[String]) -> Res<Value> {
    let d = obj(v, "document")?;
    let mut out = Map::new();
    if let Some(t) = opt_text(d.get("title"), "title", MAX_TITLE_CHARS, TextMode::OneLine)? {
        out.insert("title".into(), json!(t));
    }
    match d.get("refresh_ms") {
        None | Some(Value::Null) => {}
        Some(Value::Number(n)) if n.as_u64().is_some_and(|ms| REFRESH_MS.contains(&ms)) => {
            out.insert("refresh_ms".into(), json!(n.as_u64()));
        }
        Some(_) => {
            return Err(format!(
                "refresh_ms : entier de {} à {} attendu",
                REFRESH_MS.start(),
                REFRESH_MS.end()
            ));
        }
    }
    let blocks = arr(d.get("blocks"), "blocks", 1, MAX_BLOCKS)?;
    let mut v = Vec::with_capacity(blocks.len());
    for (i, b) in blocks.iter().enumerate() {
        v.push(block(b, &format!("blocks[{i}]"), actions)?);
    }
    out.insert("blocks".into(), Value::Array(v));
    Ok(Value::Object(out))
}

/// Pourquoi le résultat d'`action.run` est refusé.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResultError {
    /// Résultat ou document invalide.
    Invalid(String),
    /// `propose` sans la permission `claude.propose`, ou pour une action qui
    /// n'est pas déclarée `propose: true`.
    Denied(String),
}

impl ResultError {
    pub fn problem(&self) -> &str {
        match self {
            Self::Invalid(p) | Self::Denied(p) => p,
        }
    }
}

/// Valide le résultat d'`action.run` : `{document?, propose?: {content}}`,
/// au moins l'un des deux. `propose_allowed` : le plugin a `claude.propose`
/// **et** l'action est déclarée `propose: true`.
pub fn validate_action_result(
    v: &Value,
    actions: &[String],
    propose_allowed: bool,
) -> Result<Value, ResultError> {
    let r = obj(v, "résultat").map_err(ResultError::Invalid)?;
    let mut out = Map::new();
    match r.get("document") {
        None | Some(Value::Null) => {}
        Some(d) => {
            let doc = validate_document(d, actions)
                .map_err(|e| ResultError::Invalid(format!("document : {e}")))?;
            out.insert("document".into(), doc);
        }
    }
    match r.get("propose") {
        None | Some(Value::Null) => {}
        Some(p) => {
            if !propose_allowed {
                return Err(ResultError::Denied(
                    "propose refusé : il faut la permission claude.propose et une action déclarée « propose: true »".into(),
                ));
            }
            let p = obj(p, "propose").map_err(ResultError::Invalid)?;
            let content = text(
                p.get("content"),
                "propose.content",
                MAX_PROPOSE_CHARS,
                TextMode::Multiline,
            )
            .map_err(ResultError::Invalid)?;
            if content.trim().is_empty() {
                return Err(ResultError::Invalid("propose.content : texte vide".into()));
            }
            out.insert("propose".into(), json!({"content": content}));
        }
    }
    if out.is_empty() {
        return Err(ResultError::Invalid(
            "résultat : « document » ou « propose » attendu".into(),
        ));
    }
    Ok(Value::Object(out))
}

/// Réponse d'`initialize` acceptable : un objet avec `api_version: 1`.
pub fn valid_initialize(v: &Value) -> bool {
    v.get("api_version").and_then(Value::as_u64) == Some(super::API_VERSION)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn actions() -> Vec<String> {
        vec!["index".into(), "send-impact".into()]
    }

    fn full() -> Value {
        json!({"title": "Impact du diff", "refresh_ms": 2000, "extra": 1,
         "blocks": [
          {"type": "notice", "level": "warning", "text": "Rust mal couvert…", "x": true},
          {"type": "markdown", "text": "**12** symboles touchés\nligne 2"},
          {"type": "kv", "items": [{"key": "Profondeur", "value": "2"}]},
          {"type": "list", "ordered": false, "items": [{"text": "app/test/a.test.ts", "detail": "…"}]},
          {"type": "table", "caption": "…", "columns": [{"id": "symbol", "label": "Symbole"}, {"id": "depth", "label": "Profondeur", "align": "end"}],
           "rows": [{"symbol": "reviewSubject", "depth": 0, "autre": 3}, {"symbol": null}]},
          {"type": "tree", "nodes": [{"label": "src/a.rs", "detail": "…", "children": [{"label": "fn x"}]}]},
          {"type": "actions", "items": [{"id": "index", "label": "Mettre à jour", "args": {"full": true}, "primary": true}]}]})
    }

    #[test]
    fn contract_example_is_valid_and_normalized() {
        let d = validate_document(&full(), &actions()).unwrap();
        assert!(d.get("extra").is_none());
        assert!(d["blocks"][0].get("x").is_none());
        assert_eq!(d["blocks"][1]["text"], "**12** symboles touchés\nligne 2");
        assert_eq!(
            d["blocks"][4]["rows"][0],
            json!({"symbol": "reviewSubject", "depth": 0})
        );
        assert_eq!(d["blocks"][4]["rows"][1], json!({"symbol": null}));
        assert_eq!(d["blocks"][5]["nodes"][0]["children"][0]["label"], "fn x");
        assert_eq!(d["blocks"][6]["items"][0]["args"], json!({"full": true}));
        assert_eq!(d["refresh_ms"], 2000);
    }

    #[test]
    fn invisibles_are_removed_and_lines_joined() {
        let d = validate_document(
            &json!({"title": "a\u{202E}b\nc", "blocks": [
                {"type": "kv", "items": [{"key": "k\u{200B}\tx", "value": "v\nw"}]},
                {"type": "notice", "level": "info", "text": "l1\nl2\u{1b}"}]}),
            &[],
        )
        .unwrap();
        assert_eq!(d["title"], "ab c");
        assert_eq!(d["blocks"][0]["items"][0]["key"], "k x");
        assert_eq!(d["blocks"][0]["items"][0]["value"], "vw");
        assert_eq!(d["blocks"][1]["text"], "l1\nl2");
        // Bornes comptées après nettoyage, en caractères.
        let t = format!("{}{}", "é".repeat(200), "\u{200B}".repeat(50));
        assert!(
            validate_document(
                &json!({"title": t, "blocks": [{"type": "markdown", "text": ""}]}),
                &[]
            )
            .is_ok()
        );
    }

    fn rejects(doc: Value) -> String {
        validate_document(&doc, &actions()).unwrap_err()
    }

    #[test]
    fn invalid_documents_are_rejected() {
        let md = json!({"type": "markdown", "text": "x"});
        assert!(rejects(json!({"blocks": []})).contains("blocks"));
        assert!(rejects(json!({"blocks": vec![md.clone(); 51]})).contains("blocks"));
        assert!(rejects(json!({"blocks": [{"type": "html", "text": "<b>"}]})).contains("inconnu"));
        assert!(rejects(json!({"refresh_ms": 999, "blocks": [md]})).contains("refresh_ms"));
        assert!(rejects(json!({"refresh_ms": 60001, "blocks": [md]})).contains("refresh_ms"));
        assert!(rejects(json!({"refresh_ms": 1500.5, "blocks": [md]})).contains("refresh_ms"));
        assert!(rejects(json!({"title": "x".repeat(201), "blocks": [md]})).contains("title"));
        assert!(
            rejects(json!({"blocks": [{"type": "markdown", "text": "x".repeat(20_001)}]}))
                .contains("20000")
        );
        assert!(
            rejects(json!({"blocks": [{"type": "notice", "level": "fatal", "text": "x"}]}))
                .contains("level")
        );
        assert!(rejects(json!({"blocks": [{"type": "kv", "items": []}]})).contains("items"));
        assert!(
            rejects(
                json!({"blocks": [{"type": "list", "items": vec![json!({"text": "a"}); 501]}]})
            )
            .contains("items")
        );
        assert!(rejects(json!({"blocks": [{"type": "table", "columns": [{"id": "A", "label": "a"}], "rows": []}]})).contains("id"));
        assert!(rejects(json!({"blocks": [{"type": "table", "columns": [{"id": "a", "label": "a"}, {"id": "a", "label": "b"}], "rows": []}]})).contains("double"));
        assert!(rejects(json!({"blocks": [{"type": "table", "columns": [{"id": "a", "label": "a"}], "rows": [{"a": [1]}]}]})).contains("rows"));
        assert!(rejects(json!({"blocks": [{"type": "table", "columns": [{"id": "a", "label": "a", "align": "center"}], "rows": []}]})).contains("align"));
        assert!(
            rejects(
                json!({"blocks": [{"type": "actions", "items": [{"id": "rm-rf", "label": "x"}]}]})
            )
            .contains("non déclarée")
        );
        assert!(rejects(json!({"blocks": [{"type": "actions", "items": []}]})).contains("items"));
        let many: Map<String, Value> = (0..17).map(|i| (format!("k{i}"), json!(1))).collect();
        assert!(rejects(json!({"blocks": [{"type": "actions", "items": [{"id": "index", "label": "x", "args": many}]}]})).contains("16"));
        assert!(rejects(json!({"blocks": [{"type": "actions", "items": [{"id": "index", "label": "x", "args": {"a": {"b": 1}}}]}]})).contains("args"));
        assert!(rejects(json!({"blocks": [{"type": "actions", "items": [{"id": "index", "label": "x", "args": {"A": 1}}]}]})).contains("clé"));
        // Arbre : profondeur et nombre de nœuds.
        let mut deep = json!({"label": "x"});
        for _ in 0..8 {
            deep = json!({"label": "x", "children": [deep]});
        }
        assert!(
            rejects(json!({"blocks": [{"type": "tree", "nodes": [deep]}]})).contains("profondeur")
        );
        let wide: Vec<Value> = (0..1001)
            .map(|_| json!({"label": "x", "children": [{"label": "y"}]}))
            .collect();
        assert!(rejects(json!({"blocks": [{"type": "tree", "nodes": wide}]})).contains("nœuds"));
        assert!(rejects(json!("texte")).contains("objet"));
    }

    #[test]
    fn depth_eight_is_accepted() {
        let mut deep = json!({"label": "x"});
        for _ in 0..7 {
            deep = json!({"label": "x", "children": [deep]});
        }
        assert!(
            validate_document(&json!({"blocks": [{"type": "tree", "nodes": [deep]}]}), &[]).is_ok()
        );
    }

    #[test]
    fn action_results() {
        let doc = json!({"blocks": [{"type": "markdown", "text": "ok"}]});
        let r = validate_action_result(&json!({"document": doc}), &[], false).unwrap();
        assert_eq!(r["document"]["blocks"][0]["text"], "ok");
        let p = json!({"propose": {"content": "# Impact\u{202E}\n- a"}});
        assert_eq!(
            validate_action_result(&p, &[], true).unwrap()["propose"]["content"],
            "# Impact\n- a"
        );
        assert!(matches!(
            validate_action_result(&p, &[], false),
            Err(ResultError::Denied(_))
        ));
        assert!(matches!(
            validate_action_result(&json!({}), &[], true),
            Err(ResultError::Invalid(_))
        ));
        assert!(matches!(
            validate_action_result(
                &json!({"propose": {"content": "x".repeat(100_001)}}),
                &[],
                true
            ),
            Err(ResultError::Invalid(_))
        ));
        assert!(matches!(
            validate_action_result(&json!({"document": {"blocks": []}}), &[], true),
            Err(ResultError::Invalid(_))
        ));
    }

    #[test]
    fn initialize_answer() {
        assert!(valid_initialize(&json!({"api_version": 1, "name": "x"})));
        assert!(!valid_initialize(&json!({"api_version": 2})));
        assert!(!valid_initialize(&json!(null)));
    }
}
