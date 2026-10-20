//! Vue conversation (ADR 0005, contrat du lot 10) : normalisation pure des
//! transcripts JSONL de Claude Code en **entrées stables**.
//!
//! Le format est interne à Claude Code (constaté avec 2.1.304, prototype
//! n° 5) : lecture tolérante, ligne à ligne, chaque champ facultatif. Le
//! démon lit les fichiers (adaptateur) et donne chaque ligne complète à
//! [`Conversation::feed`] ; ce module ne lit rien lui-même.
//!
//! # Règles
//!
//! - Une ligne = une entrée du transcript ; une ligne `assistant` porte en
//!   général un seul bloc, et un message d'API s'étale sur plusieurs lignes de
//!   même `message.id`. Les blocs `text` successifs d'un même message (sans
//!   autre entrée entre eux) forment **une** entrée `text`, complétée (et
//!   renvoyée, même `uid`) quand un bloc arrive plus tard. Une seule entrée
//!   `thinking` par message (repère seul : le contenu n'est jamais gardé).
//! - `tool_use` ↔ `tool_result` : appariés par identifiant ; le résultat
//!   complète l'entrée de l'outil (même `uid`). Un résultat arrivé avant son
//!   appel est gardé (au plus [`MAX_PENDING_RESULTS`]).
//! - `AskUserQuestion` → `question` (réponses lues dans `toolUseResult`),
//!   `Agent` / `Task` → `subagent` (`agentId` du résultat, ou rattachement
//!   par le `toolUseId` du `.meta.json` : [`Conversation::link_agent`]).
//! - Prompts : `promptSource` (`typed`, `queued`, `suggestion_accepted` →
//!   `suggestion`, `system`, `sdk`), `typed` s'il est absent ; collages
//!   `<pasted_content id="…">…</pasted_content id="…">` extraits dans
//!   `pasted` et remplacés dans le texte par `[collage <id>]`. Le premier
//!   message d'un sous-agent (sans `promptSource`) est `system`.
//! - `<task-notification>` → une entrée `notification` par notification
//!   (pas un prompt) ; elle met aussi à jour le statut de l'entrée
//!   `subagent` de même `tool-use-id`.
//! - `system/compact_boundary` → `compaction`, complétée par le résumé
//!   (`isCompactSummary`).
//! - `<command-name>` → `command`, complétée par sa sortie
//!   (`<local-command-stdout>`, `system/local_command`), codes ANSI retirés.
//!   Mode bash (`<bash-input>`, `<bash-stdout>`) : commande `!`. La ligne
//!   nue `/compact` (sans `promptSource`) qui précède `<command-name>` est
//!   ignorée.
//! - `system/api_error`, `isApiErrorMessage`, `[Request interrupted by
//!   user…]` → `error`.
//! - Intendance ignorée ([`HOUSEKEEPING`], pièces jointes, `isMeta`,
//!   `<system-reminder>`, `<local-command-caveat>`, sous-types de `system`
//!   de [`SYSTEM_IGNORED`]) ; tout autre type, sous-type de `system` ou bloc
//!   inconnu → `unknown` ; ligne illisible → ignorée et comptée.
//!
//! Bornes ([`Limits::display`]) : texte d'une entrée [`MAX_TEXT_BYTES`]
//! (`truncated: true`), entrée et résultat d'un outil [`MAX_TOOL_BYTES`]
//! chacun ; le contenu entier (au plus [`MAX_FULL_BYTES`]) se relit en
//! rejouant les lignes de l'entrée ([`Entry::lines`]) avec
//! [`Limits::full`] ([`full_text`]).
//!
//! Mémoire : les entrées sont bornées comme ci-dessus ; l'index des `uid`
//! et l'ensemble des `uuid` déjà lus (une centaine d'octets par ligne,
//! moins de 1 Mio pour le plus gros transcript mesuré, 5 635 lignes) croissent
//! avec le fichier ; l'état de regroupement par message est borné
//! ([`MAX_MESSAGE_STATES`]), comme les résultats et liens en attente. Le démon
//! ne garde en mémoire que les conversations suivies et quelques autres.
//!
//! Révisions : chaque création ou modification d'entrée lui donne une
//! révision croissante ([`Entry::rev`]) ; [`Conversation::changed_since`]
//! sert les notifications d'ajout ou de mise à jour.

use std::collections::{HashMap, HashSet};

use serde_json::{Value, json};

use super::subagents::clip;

/// Texte d'une entrée, au plus (256 Kio).
pub const MAX_TEXT_BYTES: usize = 256 * 1024;
/// Entrée ou résultat d'un outil, au plus (64 Kio chacun).
pub const MAX_TOOL_BYTES: usize = 64 * 1024;
/// Contenu entier servi par `conversation.full`, au plus (4 Mio).
pub const MAX_FULL_BYTES: usize = 4 * 1024 * 1024;
/// Ligne de transcript lue au plus (8 Mio) : au-delà, ignorée et comptée.
pub const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;
/// Résumé d'un outil, en caractères.
pub const SUMMARY_CHARS: usize = 200;
/// Résultats en attente de leur appel, au plus.
pub const MAX_PENDING_RESULTS: usize = 256;
/// Messages d'API dont l'état de regroupement est gardé, par source.
pub const MAX_MESSAGE_STATES: usize = 64;
/// Liens `toolUseId` → sous-agent en attente de leur appel, au plus.
pub const MAX_PENDING_LINKS: usize = 256;

/// Types de premier niveau d'intendance, ignorés sans bruit.
pub const HOUSEKEEPING: &[&str] = &[
    "attachment",
    "last-prompt",
    "mode",
    "permission-mode",
    "atis-latch",
    "ai-title",
    "custom-title",
    "agent-name",
    "tag",
    "summary",
    "file-history-snapshot",
    "file-history-delta",
    "api-request",
    "api-request-blob",
    "api-request-shape",
    "cost-state",
    "queue-operation",
    "progress",
    "pr-link",
    "worktree-state",
    "content-replacement",
    "agent-setting",
    "speculation-accept",
];

/// Sous-types de `system` ignorés (intendance ou déjà montrés autrement).
pub const SYSTEM_IGNORED: &[&str] = &[
    "stop_hook_summary",
    "turn_duration",
    "informational",
    "away_summary",
    "bridge_status",
    "memory_saved",
    "agents_killed",
    "permission_retry",
    "scheduled_task_fire",
];

/// Bornes appliquées aux contenus.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub text: usize,
    pub tool: usize,
}

impl Limits {
    /// Bornes de la vue (`conversation.get`, notifications).
    pub const fn display() -> Self {
        Self {
            text: MAX_TEXT_BYTES,
            tool: MAX_TOOL_BYTES,
        }
    }
    /// Bornes de `conversation.full`.
    pub const fn full() -> Self {
        Self {
            text: MAX_FULL_BYTES,
            tool: MAX_FULL_BYTES,
        }
    }
}

/// Position d'une ligne dans un fichier suivi : de quoi la relire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct LineRef {
    /// Source (fichier) de la conversation, voir [`Conversation::add_source`].
    pub source: u32,
    pub offset: u64,
    pub len: u64,
}

/// Un collage extrait d'un prompt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pasted {
    pub id: String,
    pub text: String,
}

/// Résultat d'un outil.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolResult {
    /// `ok`, `error` ou `interrupted`.
    pub status: &'static str,
    pub text: String,
    pub truncated: bool,
    /// Hunks d'un `Edit` / `Write`, tirés de `structuredPatch` et mis à la
    /// forme de `sessions.diffFile` ([`patch_hunks`]).
    pub patch: Option<Value>,
}

/// Contenu d'une entrée, selon son genre.
#[derive(Debug, Clone, PartialEq)]
pub enum Body {
    Prompt {
        text: String,
        /// `typed`, `queued`, `suggestion`, `system` ou `sdk`.
        source: String,
        pasted: Vec<Pasted>,
        /// `promptId` du transcript (le même que celui de `UserPromptSubmit`).
        prompt_id: Option<String>,
    },
    Text {
        markdown: String,
    },
    Thinking,
    Tool {
        tool_use_id: String,
        name: String,
        summary: String,
        input: Value,
        input_truncated: bool,
        result: Option<ToolResult>,
    },
    Question {
        tool_use_id: String,
        questions: Value,
        answers: Option<Value>,
    },
    Subagent {
        tool_use_id: String,
        agent_id: Option<String>,
        agent_type: Option<String>,
        description: Option<String>,
        /// `running`, `done`, `failed` ou `interrupted`.
        status: &'static str,
    },
    Notification {
        task_id: Option<String>,
        status: Option<String>,
        summary: Option<String>,
    },
    Compaction {
        trigger: Option<String>,
        pre_tokens: Option<u64>,
        post_tokens: Option<u64>,
        summary: Option<String>,
    },
    Command {
        name: String,
        args: String,
        output: String,
    },
    Error {
        message: String,
    },
    Unknown {
        kind: String,
        subtype: Option<String>,
    },
}

impl Body {
    /// Nom du genre dans le protocole.
    pub fn kind(&self) -> &'static str {
        match self {
            Body::Prompt { .. } => "prompt",
            Body::Text { .. } => "text",
            Body::Thinking => "thinking",
            Body::Tool { .. } => "tool",
            Body::Question { .. } => "question",
            Body::Subagent { .. } => "subagent",
            Body::Notification { .. } => "notification",
            Body::Compaction { .. } => "compaction",
            Body::Command { .. } => "command",
            Body::Error { .. } => "error",
            Body::Unknown { .. } => "unknown",
        }
    }
}

/// Une entrée normalisée.
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    /// `uuid` de la première ligne qui l'a créée (suffixe `#n` pour le n-ième
    /// bloc d'une même ligne), stable.
    pub uid: String,
    /// `timestamp` de cette ligne, tel quel (RFC 3339).
    pub ts: Option<String>,
    pub segment: u32,
    /// Sous-agent dont le fichier porte l'entrée (`None` : conversation principale).
    pub agent_id: Option<String>,
    pub body: Body,
    /// Le texte de l'entrée (prompt, texte, sortie, résumé, message) a été coupé.
    pub truncated: bool,
    /// Révision de la dernière création ou modification.
    pub rev: u64,
    /// Lignes qui ont contribué à l'entrée, dans l'ordre.
    pub lines: Vec<LineRef>,
}

/// Un segment : un fichier de transcript de la conversation (nouveau à
/// chaque `/clear`, ou `/resume` d'une autre conversation).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Segment {
    pub segment: u32,
    pub claude_session_id: String,
    /// `start`, `clear` ou `resume`.
    pub reason: String,
    /// Date de début (RFC 3339), si connue.
    pub started_at: Option<String>,
    /// Révision de sa création.
    pub rev: u64,
}

/// État de lecture d'un fichier (source).
#[derive(Debug, Default, Clone)]
struct Source {
    agent: Option<String>,
    segment: u32,
    invalid: u64,
    /// Par `message.id` : entrée `text` en cours et repère de réflexion posé.
    messages: HashMap<String, MessageState>,
    /// Dernière entrée créée ou complétée par cette source.
    last_uid: Option<String>,
    last_command: Option<String>,
    last_compaction: Option<String>,
}

#[derive(Debug, Default, Clone)]
struct MessageState {
    text_uid: Option<String>,
    thinking: bool,
}

/// Emplacement d'une entrée : liste (principale ou d'un sous-agent) et rang.
type Loc = (Option<String>, usize);

/// Résultat arrivé avant son appel.
#[derive(Debug, Clone)]
struct PendingResult {
    block: Value,
    tur: Value,
    line: LineRef,
}

/// Une conversation : segments, entrées principales et entrées des
/// sous-agents suivis.
#[derive(Debug, Clone)]
pub struct Conversation {
    limits: Limits,
    segments: Vec<Segment>,
    main: Vec<Entry>,
    subs: HashMap<String, Vec<Entry>>,
    index: HashMap<String, Loc>,
    tools: HashMap<String, Loc>,
    sources: Vec<Source>,
    seen: HashSet<String>,
    pending_results: Vec<(String, PendingResult)>,
    pending_links: Vec<(String, String)>,
    rev: u64,
}

impl Default for Conversation {
    fn default() -> Self {
        Self::new(Limits::display())
    }
}

impl Conversation {
    pub fn new(limits: Limits) -> Self {
        Self {
            limits,
            segments: Vec::new(),
            main: Vec::new(),
            subs: HashMap::new(),
            index: HashMap::new(),
            tools: HashMap::new(),
            sources: Vec::new(),
            seen: HashSet::new(),
            pending_results: Vec::new(),
            pending_links: Vec::new(),
            rev: 0,
        }
    }

    /// Les révisions suivantes partent au moins de `base` (conversation
    /// recréée : les révisions déjà vues par un client restent plus petites).
    pub fn set_rev_base(&mut self, base: u64) {
        self.rev = self.rev.max(base);
    }

    /// Révision courante.
    pub fn rev(&self) -> u64 {
        self.rev
    }

    fn bump(&mut self) -> u64 {
        self.rev += 1;
        self.rev
    }

    /// Ouvre un segment ; renvoie son numéro (à partir de 0).
    pub fn start_segment(
        &mut self,
        claude_session_id: &str,
        reason: &str,
        started_at: Option<String>,
    ) -> u32 {
        let segment = self.segments.len() as u32;
        let rev = self.bump();
        self.segments.push(Segment {
            segment,
            claude_session_id: claude_session_id.to_owned(),
            reason: reason.to_owned(),
            started_at,
            rev,
        });
        segment
    }

    pub fn segments(&self) -> &[Segment] {
        &self.segments
    }

    /// Segments ouverts après la révision `rev`.
    pub fn segments_since(&self, rev: u64) -> impl Iterator<Item = &Segment> {
        self.segments.iter().filter(move |s| s.rev > rev)
    }

    /// Nouvelle source (fichier) : principale du segment `segment`, ou d'un
    /// sous-agent. Renvoie son numéro, à repasser à [`Conversation::feed`].
    pub fn add_source(&mut self, agent: Option<String>, segment: u32) -> u32 {
        if let Some(a) = &agent {
            self.subs.entry(a.clone()).or_default();
        }
        self.sources.push(Source {
            agent,
            segment,
            ..Source::default()
        });
        (self.sources.len() - 1) as u32
    }

    /// La source `source` (rouverte par une reprise) appartient désormais au
    /// segment `segment` : ses lignes suivantes y sont rangées.
    pub fn set_source_segment(&mut self, source: u32, segment: u32) {
        if let Some(s) = self.sources.get_mut(source as usize) {
            s.segment = segment;
        }
    }

    /// Lignes illisibles (ou trop longues) comptées : de la conversation
    /// principale (`None`) ou d'un sous-agent.
    pub fn invalid_lines(&self, agent: Option<&str>) -> u64 {
        self.sources
            .iter()
            .filter(|s| s.agent.as_deref() == agent)
            .map(|s| s.invalid)
            .sum()
    }

    /// Compte une ligne ignorée (trop longue, non UTF-8…).
    pub fn count_invalid(&mut self, source: u32) {
        if let Some(s) = self.sources.get_mut(source as usize) {
            s.invalid += 1;
        }
    }

    /// Entrées d'une liste (`None` : conversation principale).
    pub fn entries(&self, agent: Option<&str>) -> &[Entry] {
        match agent {
            None => &self.main,
            Some(a) => self.subs.get(a).map(Vec::as_slice).unwrap_or(&[]),
        }
    }

    /// Une entrée par son `uid`.
    pub fn entry(&self, uid: &str) -> Option<&Entry> {
        let (list, i) = self.index.get(uid)?;
        self.entries(list.as_deref()).get(*i)
    }

    /// Les `limit` entrées les plus récentes avant `before` (exclu), dans
    /// l'ordre chronologique, et s'il en reste avant. `None` si `before`
    /// n'est pas une entrée de cette liste.
    pub fn page(
        &self,
        agent: Option<&str>,
        before: Option<&str>,
        limit: usize,
    ) -> Option<(&[Entry], bool)> {
        let list = self.entries(agent);
        let end = match before {
            None => list.len(),
            Some(uid) => {
                let (l, i) = self.index.get(uid)?;
                if l.as_deref() != agent {
                    return None;
                }
                *i
            }
        };
        let start = end.saturating_sub(limit);
        Some((&list[start..end], start > 0))
    }

    /// Entrées créées ou modifiées après la révision `rev` : la conversation
    /// principale d'abord, puis les sous-agents, chaque liste dans l'ordre.
    pub fn changed_since(&self, rev: u64) -> Vec<&Entry> {
        let mut out: Vec<&Entry> = self.main.iter().filter(|e| e.rev > rev).collect();
        let mut agents: Vec<&String> = self.subs.keys().collect();
        agents.sort();
        for a in agents {
            out.extend(self.subs[a].iter().filter(|e| e.rev > rev));
        }
        out
    }

    /// Le sous-agent `agent_id` est lancé par l'appel `tool_use_id` (`.meta.json`).
    pub fn link_agent(&mut self, tool_use_id: &str, agent_id: &str) {
        if self.tools.contains_key(tool_use_id) {
            self.set_agent_id(tool_use_id, agent_id);
        } else if !self.pending_links.iter().any(|(t, _)| t == tool_use_id) {
            if self.pending_links.len() >= MAX_PENDING_LINKS {
                self.pending_links.remove(0);
            }
            self.pending_links
                .push((tool_use_id.to_owned(), agent_id.to_owned()));
        }
    }

    fn set_agent_id(&mut self, tool_use_id: &str, agent_id: &str) {
        let rev = self.rev + 1;
        let mut changed = false;
        if let Some(e) = self.tool_entry_mut(tool_use_id)
            && let Body::Subagent { agent_id: a, .. } = &mut e.body
            && a.as_deref() != Some(agent_id)
        {
            *a = Some(agent_id.to_owned());
            e.rev = rev;
            changed = true;
        }
        if changed {
            self.rev = rev;
        }
    }

    fn loc_mut(&mut self, loc: &Loc) -> Option<&mut Entry> {
        match &loc.0 {
            None => self.main.get_mut(loc.1),
            Some(a) => self.subs.get_mut(a)?.get_mut(loc.1),
        }
    }

    fn tool_entry_mut(&mut self, tool_use_id: &str) -> Option<&mut Entry> {
        let loc = self.tools.get(tool_use_id)?.clone();
        self.loc_mut(&loc)
    }

    fn uid_entry_mut(&mut self, uid: &str) -> Option<&mut Entry> {
        let loc = self.index.get(uid)?.clone();
        self.loc_mut(&loc)
    }

    /// Ajoute une entrée à la liste de la source ; renvoie son `uid`.
    fn push(&mut self, source: u32, mut entry: Entry) -> String {
        let src = &self.sources[source as usize];
        entry.segment = src.segment;
        entry.agent_id = src.agent.clone();
        let agent = src.agent.clone();
        let uid = entry.uid.clone();
        entry.rev = self.bump();
        let list = match &agent {
            None => &mut self.main,
            Some(a) => self.subs.entry(a.clone()).or_default(),
        };
        list.push(entry);
        let i = list.len() - 1;
        self.index.insert(uid.clone(), (agent, i));
        self.sources[source as usize].last_uid = Some(uid.clone());
        uid
    }

    /// Modifie l'entrée `uid` (nouvelle révision, ligne ajoutée).
    fn touch(&mut self, uid: &str, line: Option<LineRef>, f: impl FnOnce(&mut Entry)) -> bool {
        let rev = self.rev + 1;
        let Some(e) = self.uid_entry_mut(uid) else {
            return false;
        };
        f(e);
        e.rev = rev;
        if let Some(l) = line
            && !e.lines.contains(&l)
        {
            e.lines.push(l);
        }
        self.rev = rev;
        true
    }

    /// Donne une ligne complète (sans le saut de ligne) lue à `offset` dans
    /// la source `source`, sa longueur sur le disque étant celle du texte.
    pub fn feed(&mut self, source: u32, offset: u64, line: &str) {
        self.feed_at(source, offset, line.len() as u64, line);
    }

    /// Comme [`Conversation::feed`], avec la longueur de la ligne **sur le
    /// disque** (`len`, avant le remplacement des octets non UTF-8) : de quoi
    /// la relire telle quelle.
    pub fn feed_at(&mut self, source: u32, offset: u64, len: u64, line: &str) {
        if source as usize >= self.sources.len() {
            return;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return;
        }
        let r = LineRef {
            source,
            offset,
            len,
        };
        let v: Value = match serde_json::from_str(trimmed) {
            Ok(v @ Value::Object(_)) => v,
            _ => {
                self.count_invalid(source);
                return;
            }
        };
        let uid = match v["uuid"].as_str() {
            Some(u) if !u.is_empty() => u.to_owned(),
            _ => format!("l{source}-{offset}"),
        };
        if !self.seen.insert(uid.clone()) {
            return; // Même ligne relue (fichier relu depuis le début…).
        }
        let ctx = Ctx {
            source,
            line: r,
            uid,
            ts: v["timestamp"].as_str().map(str::to_owned),
        };
        let is_sub = self.sources[source as usize].agent.is_some();
        // Anciennes versions : les lignes des sous-agents dans le fichier principal.
        if !is_sub && v["isSidechain"].as_bool() == Some(true) {
            return;
        }
        match v["type"].as_str() {
            Some("user") => self.user(&ctx, &v, is_sub),
            Some("assistant") => self.assistant(&ctx, &v),
            Some("system") => self.system(&ctx, &v),
            Some(t) if HOUSEKEEPING.contains(&t) => {}
            Some(t) => {
                let body = Body::Unknown {
                    kind: t.to_owned(),
                    subtype: v["subtype"].as_str().map(str::to_owned),
                };
                self.new_entry(&ctx, None, body, false);
            }
            None => {}
        }
    }

    fn new_entry(
        &mut self,
        ctx: &Ctx,
        suffix: Option<usize>,
        body: Body,
        truncated: bool,
    ) -> String {
        let uid = match suffix {
            Some(n) if n > 0 => format!("{}#{n}", ctx.uid),
            _ => ctx.uid.clone(),
        };
        let entry = Entry {
            uid,
            ts: ctx.ts.clone(),
            segment: 0,
            agent_id: None,
            body,
            truncated,
            rev: 0,
            lines: vec![ctx.line],
        };
        self.push(ctx.source, entry)
    }

    // ------------------------------------------------------------- user

    fn user(&mut self, ctx: &Ctx, v: &Value, is_sub: bool) {
        if v["isMeta"].as_bool() == Some(true) {
            return;
        }
        let content = &v["message"]["content"];
        if v["isCompactSummary"].as_bool() == Some(true) {
            let text = content_text(content);
            self.compaction_summary(ctx, v, &text);
            return;
        }
        match content {
            Value::String(s) => self.user_text(ctx, v, s, is_sub),
            Value::Array(blocks) => {
                let mut texts = Vec::new();
                for block in blocks {
                    match block["type"].as_str() {
                        Some("tool_result") => {
                            self.tool_result(block, &v["toolUseResult"], ctx.line);
                        }
                        Some("text") => {
                            if let Some(t) = block["text"].as_str() {
                                texts.push(t.to_owned());
                            }
                        }
                        _ => {}
                    }
                }
                let text = texts.join("\n\n");
                if !text.trim().is_empty() {
                    self.user_text(ctx, v, &text, is_sub);
                }
            }
            _ => {}
        }
    }

    fn user_text(&mut self, ctx: &Ctx, v: &Value, text: &str, is_sub: bool) {
        let t = text.trim_start();
        let origin = v["origin"]["kind"].as_str();
        if t.starts_with("<task-notification>") || origin == Some("task-notification") {
            self.notifications(ctx, t);
            return;
        }
        if t.starts_with("<command-name>")
            || t.starts_with("<command-message>")
            || t.starts_with("<command-args>")
        {
            let name = tag(t, "command-name").unwrap_or_default();
            let args = tag(t, "command-args").unwrap_or_default();
            let uid = self.new_entry(
                ctx,
                None,
                Body::Command {
                    name,
                    args,
                    output: String::new(),
                },
                false,
            );
            self.sources[ctx.source as usize].last_command = Some(uid);
            return;
        }
        if t.starts_with("<bash-input>") {
            let args = tag(t, "bash-input").unwrap_or_default();
            let uid = self.new_entry(
                ctx,
                None,
                Body::Command {
                    name: "!".into(),
                    args,
                    output: String::new(),
                },
                false,
            );
            self.sources[ctx.source as usize].last_command = Some(uid);
            return;
        }
        if t.starts_with("<local-command-stdout>")
            || t.starts_with("<local-command-stderr>")
            || t.starts_with("<bash-stdout>")
            || t.starts_with("<bash-stderr>")
        {
            let output = command_output(t);
            self.command_output(ctx, v, &output, None);
            return;
        }
        if t.starts_with("<local-command-caveat>") || t.starts_with("<system-reminder>") {
            return;
        }
        if t.starts_with("[Request interrupted by user") {
            let (message, truncated) = cut(t.trim(), self.limits.tool);
            self.new_entry(ctx, None, Body::Error { message }, truncated);
            return;
        }
        let prompt_source = v["promptSource"].as_str();
        if prompt_source.is_none() && origin.is_none() && !is_sub && is_bare_command(t) {
            // `/compact` nu : la ligne `<command-name>` qui suit le montre.
            return;
        }
        let source = match prompt_source {
            Some("suggestion_accepted") => "suggestion".to_owned(),
            Some(s @ ("typed" | "queued" | "system" | "sdk")) => s.to_owned(),
            _ if is_sub => "system".to_owned(),
            _ => "typed".to_owned(),
        };
        let (text, pasted, truncated) = extract_pasted(text, self.limits.text);
        self.new_entry(
            ctx,
            None,
            Body::Prompt {
                text,
                source,
                pasted,
                prompt_id: v["promptId"].as_str().map(str::to_owned),
            },
            truncated,
        );
    }

    fn notifications(&mut self, ctx: &Ctx, text: &str) {
        let blocks: Vec<&str> = if text.contains("<task-notification>") {
            text.split("<task-notification>")
                .skip(1)
                .filter(|b| !b.trim().is_empty())
                .collect()
        } else {
            vec![text]
        };
        for (n, block) in blocks.into_iter().enumerate() {
            let task_id = tag(block, "task-id");
            let status = tag(block, "status");
            let (summary, truncated) = match tag(block, "summary") {
                Some(s) => {
                    let (s, t) = cut(&s, self.limits.tool);
                    (Some(s), t)
                }
                None => (None, false),
            };
            if let Some(tool_use_id) = tag(block, "tool-use-id") {
                let new_status = match status.as_deref() {
                    Some("completed") => "done",
                    Some("failed") => "failed",
                    _ => "interrupted",
                };
                self.update_subagent_status(&tool_use_id, new_status);
            }
            self.new_entry(
                ctx,
                Some(n),
                Body::Notification {
                    task_id,
                    status,
                    summary,
                },
                truncated,
            );
        }
    }

    fn update_subagent_status(&mut self, tool_use_id: &str, status: &'static str) {
        let rev = self.rev + 1;
        let mut changed = false;
        if let Some(e) = self.tool_entry_mut(tool_use_id)
            && let Body::Subagent { status: s, .. } = &mut e.body
            && *s != status
        {
            *s = status;
            e.rev = rev;
            changed = true;
        }
        if changed {
            self.rev = rev;
        }
    }

    /// Sortie d'une commande : rattachée à la commande parente
    /// (`parentUuid`), sinon à la dernière commande si rien ne s'est
    /// intercalé ; sinon nouvelle commande (`fallback` : nom et arguments).
    fn command_output(
        &mut self,
        ctx: &Ctx,
        v: &Value,
        output: &str,
        fallback: Option<(String, String)>,
    ) {
        let limit = self.limits.text;
        let src = &self.sources[ctx.source as usize];
        let parent = v["parentUuid"]
            .as_str()
            .filter(|p| matches!(self.entry(p).map(|e| &e.body), Some(Body::Command { .. })))
            .map(str::to_owned);
        // Sans parent : la dernière commande, si rien ne s'est intercalé et
        // qu'elle porte le même nom que `commandRun` (s'il est connu).
        let same_name = |uid: &String| match (&fallback, self.entry(uid).map(|e| &e.body)) {
            (Some((name, _)), Some(Body::Command { name: n, .. })) => name.is_empty() || n == name,
            _ => true,
        };
        let target = parent.or_else(|| {
            src.last_command
                .clone()
                .filter(|c| src.last_uid.as_ref() == Some(c) && same_name(c))
        });
        match target {
            Some(uid) => {
                let output = output.to_owned();
                self.touch(&uid, Some(ctx.line), |e| {
                    if let Body::Command { output: o, .. } = &mut e.body {
                        let joined = if o.is_empty() {
                            output
                        } else if output.is_empty() {
                            o.clone()
                        } else {
                            format!("{o}\n{output}")
                        };
                        let (text, truncated) = cut(&joined, limit);
                        *o = text;
                        e.truncated |= truncated;
                    }
                });
                self.sources[ctx.source as usize].last_uid = Some(uid);
            }
            None => {
                let (name, args) = fallback.unwrap_or_default();
                let (output, truncated) = cut(output, limit);
                let uid =
                    self.new_entry(ctx, None, Body::Command { name, args, output }, truncated);
                self.sources[ctx.source as usize].last_command = Some(uid);
            }
        }
    }

    fn compaction_summary(&mut self, ctx: &Ctx, v: &Value, text: &str) {
        let limit = self.limits.text;
        let parent = v["parentUuid"]
            .as_str()
            .filter(|p| {
                matches!(
                    self.entry(p).map(|e| &e.body),
                    Some(Body::Compaction { .. })
                )
            })
            .map(str::to_owned);
        let target = parent.or_else(|| self.sources[ctx.source as usize].last_compaction.clone());
        let (summary, truncated) = cut(text, limit);
        match target {
            Some(uid) => {
                self.touch(&uid, Some(ctx.line), |e| {
                    if let Body::Compaction { summary: s, .. } = &mut e.body {
                        *s = Some(summary);
                        e.truncated = truncated;
                    }
                });
            }
            None => {
                let uid = self.new_entry(
                    ctx,
                    None,
                    Body::Compaction {
                        trigger: None,
                        pre_tokens: None,
                        post_tokens: None,
                        summary: Some(summary),
                    },
                    truncated,
                );
                self.sources[ctx.source as usize].last_compaction = Some(uid);
            }
        }
    }

    // -------------------------------------------------------- assistant

    fn assistant(&mut self, ctx: &Ctx, v: &Value) {
        let msg = &v["message"];
        let content = &msg["content"];
        if v["isApiErrorMessage"].as_bool() == Some(true) {
            let text = content_text(content);
            let (message, truncated) = cut(text.trim(), self.limits.tool);
            self.new_entry(ctx, None, Body::Error { message }, truncated);
            return;
        }
        let msg_id = msg["id"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| ctx.uid.clone());
        let blocks: Vec<Value> = match content {
            Value::Array(b) => b.clone(),
            Value::String(s) => vec![json!({"type": "text", "text": s})],
            _ => Vec::new(),
        };
        // Seul le message en cours compte pour le regroupement : la table ne
        // grossit pas avec la conversation.
        let messages = &mut self.sources[ctx.source as usize].messages;
        if messages.len() > MAX_MESSAGE_STATES && !messages.contains_key(&msg_id) {
            messages.clear();
        }
        for (n, block) in blocks.iter().enumerate() {
            let kind = block["type"].as_str().unwrap_or("");
            match kind {
                "text" => self.text_block(ctx, n, &msg_id, block["text"].as_str().unwrap_or("")),
                "thinking" | "redacted_thinking" => {
                    let state = self.sources[ctx.source as usize]
                        .messages
                        .entry(msg_id.clone())
                        .or_default();
                    if !state.thinking {
                        state.thinking = true;
                        self.new_entry(ctx, Some(n), Body::Thinking, false);
                    }
                }
                "tool_use" | "server_tool_use" | "mcp_tool_use" => self.tool_use(ctx, n, block),
                k if k.ends_with("_tool_result") && block["tool_use_id"].is_string() => {
                    self.tool_result(block, &Value::Null, ctx.line);
                }
                other => {
                    self.new_entry(
                        ctx,
                        Some(n),
                        Body::Unknown {
                            kind: "assistant".into(),
                            subtype: Some(other.to_owned()),
                        },
                        false,
                    );
                }
            }
        }
    }

    fn text_block(&mut self, ctx: &Ctx, n: usize, msg_id: &str, text: &str) {
        if text.trim().is_empty() {
            return;
        }
        let limit = self.limits.text;
        let src = &self.sources[ctx.source as usize];
        let current = src
            .messages
            .get(msg_id)
            .and_then(|m| m.text_uid.clone())
            .filter(|u| src.last_uid.as_ref() == Some(u));
        match current {
            Some(uid) => {
                let add = text.to_owned();
                self.touch(&uid, Some(ctx.line), |e| {
                    if let Body::Text { markdown } = &mut e.body {
                        if e.truncated {
                            return;
                        }
                        let joined = format!("{markdown}\n\n{add}");
                        let (t, truncated) = cut(&joined, limit);
                        *markdown = t;
                        e.truncated = truncated;
                    }
                });
            }
            None => {
                let (markdown, truncated) = cut(text, limit);
                let uid = self.new_entry(ctx, Some(n), Body::Text { markdown }, truncated);
                self.sources[ctx.source as usize]
                    .messages
                    .entry(msg_id.to_owned())
                    .or_default()
                    .text_uid = Some(uid);
            }
        }
    }

    fn tool_use(&mut self, ctx: &Ctx, n: usize, block: &Value) {
        let Some(id) = block["id"].as_str().map(str::to_owned) else {
            return;
        };
        let name = block["name"].as_str().unwrap_or("").to_owned();
        let input = block["input"].clone();
        let body = match name.as_str() {
            super::session::ASK_USER_QUESTION => {
                let (questions, _) = bounded_value(&input["questions"], self.limits.tool);
                Body::Question {
                    tool_use_id: id.clone(),
                    questions,
                    answers: None,
                }
            }
            "Agent" | "Task" => Body::Subagent {
                tool_use_id: id.clone(),
                agent_id: None,
                agent_type: Some(
                    input["subagent_type"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .map(clip)
                        .unwrap_or_else(|| super::subagents::DEFAULT_SUBAGENT_TYPE.to_owned()),
                ),
                description: input["description"].as_str().map(clip),
                status: "running",
            },
            _ => {
                let summary = tool_summary(&name, &input);
                let (input, input_truncated) = bounded_value(&input, self.limits.tool);
                Body::Tool {
                    tool_use_id: id.clone(),
                    name,
                    summary,
                    input,
                    input_truncated,
                    result: None,
                }
            }
        };
        let uid = self.new_entry(ctx, Some(n), body, false);
        let loc = self.index[&uid].clone();
        self.tools.insert(id.clone(), loc);
        if let Some(i) = self.pending_results.iter().position(|(t, _)| *t == id) {
            let (_, p) = self.pending_results.remove(i);
            self.tool_result(&p.block, &p.tur, p.line);
        }
        if let Some(i) = self.pending_links.iter().position(|(t, _)| *t == id) {
            let (_, agent) = self.pending_links.remove(i);
            self.set_agent_id(&id, &agent);
        }
    }

    fn tool_result(&mut self, block: &Value, tur: &Value, line: LineRef) {
        let Some(id) = block["tool_use_id"].as_str().map(str::to_owned) else {
            return;
        };
        let Some(loc) = self.tools.get(&id).cloned() else {
            if self.pending_results.len() >= MAX_PENDING_RESULTS {
                self.pending_results.remove(0);
            }
            self.pending_results.push((
                id,
                PendingResult {
                    block: block.clone(),
                    tur: tur.clone(),
                    line,
                },
            ));
            return;
        };
        let is_error = block["is_error"].as_bool() == Some(true);
        let text = content_text(&block["content"]);
        let interrupted = tur["interrupted"].as_bool() == Some(true)
            || text
                .trim_start()
                .starts_with("[Request interrupted by user");
        let status = if interrupted {
            "interrupted"
        } else if is_error {
            "error"
        } else {
            "ok"
        };
        let limit = self.limits.tool;
        let rev = self.rev + 1;
        let Some(e) = self.loc_mut(&loc) else {
            return;
        };
        match &mut e.body {
            Body::Tool { result, .. } => {
                let (text, truncated) = cut(&text, limit);
                let patch = tur
                    .get("structuredPatch")
                    .and_then(patch_hunks)
                    .filter(|p| p.to_string().len() <= limit);
                *result = Some(ToolResult {
                    status,
                    text,
                    truncated,
                    patch,
                });
            }
            Body::Question { answers, .. } => {
                if let Some(a) = tur.get("answers").filter(|a| a.is_object()) {
                    *answers = Some(bounded_value(a, limit).0);
                }
            }
            Body::Subagent {
                agent_id,
                status: s,
                ..
            } => {
                if let Some(a) = tur["agentId"].as_str().filter(|a| is_agent_id(a)) {
                    *agent_id = Some(a.to_owned());
                }
                *s = match (status, tur["status"].as_str()) {
                    ("interrupted", _) => "interrupted",
                    ("error", _) => "failed",
                    (_, Some("async_launched")) => "running",
                    (_, Some("failed")) => "failed",
                    (_, Some("killed")) => "interrupted",
                    _ => "done",
                };
            }
            _ => return,
        }
        e.rev = rev;
        if !e.lines.contains(&line) {
            e.lines.push(line);
        }
        self.rev = rev;
    }

    // ----------------------------------------------------------- system

    fn system(&mut self, ctx: &Ctx, v: &Value) {
        let subtype = v["subtype"].as_str();
        match subtype {
            Some("compact_boundary") => {
                let meta = &v["compactMetadata"];
                let uid = self.new_entry(
                    ctx,
                    None,
                    Body::Compaction {
                        trigger: meta["trigger"].as_str().map(str::to_owned),
                        pre_tokens: meta["preTokens"].as_u64(),
                        post_tokens: meta["postTokens"].as_u64(),
                        summary: None,
                    },
                    false,
                );
                self.sources[ctx.source as usize].last_compaction = Some(uid);
            }
            Some("api_error") => {
                let message = v["content"]
                    .as_str()
                    .map(str::to_owned)
                    .or_else(|| v["error"]["message"].as_str().map(str::to_owned))
                    .or_else(|| v["error"]["error"]["message"].as_str().map(str::to_owned))
                    .or_else(|| v["error"].as_str().map(str::to_owned))
                    .unwrap_or_else(|| "Erreur de l'API".to_owned());
                let (message, truncated) = cut(&message, self.limits.tool);
                self.new_entry(ctx, None, Body::Error { message }, truncated);
            }
            Some("local_command") => {
                let output = command_output(v["content"].as_str().unwrap_or(""));
                let run = &v["commandRun"];
                let fallback = (
                    run["command"]
                        .as_str()
                        .map(|c| format!("/{}", c.trim_start_matches('/')))
                        .unwrap_or_default(),
                    run["args"].as_str().unwrap_or("").to_owned(),
                );
                self.command_output(ctx, v, &output, Some(fallback));
            }
            Some(s) if SYSTEM_IGNORED.contains(&s) => {}
            _ => {
                self.new_entry(
                    ctx,
                    None,
                    Body::Unknown {
                        kind: "system".into(),
                        subtype: subtype.map(str::to_owned),
                    },
                    false,
                );
            }
        }
    }
}

/// Contexte d'une ligne en cours de lecture.
struct Ctx {
    source: u32,
    line: LineRef,
    uid: String,
    ts: Option<String>,
}

/// Identifiant de sous-agent utilisable comme nom de fichier
/// (`agent-<id>.jsonl`) : lettres, chiffres, `-` et `_`, 1 à 128 caractères.
pub fn is_agent_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Texte d'un contenu : chaîne, ou blocs `text` joints (une image : `[image]`).
fn content_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|b| match b["type"].as_str() {
                Some("text") => b["text"].as_str().map(str::to_owned),
                Some("image") => Some("[image]".to_owned()),
                Some("tool_reference") => b["tool_name"].as_str().map(str::to_owned),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// `text` coupé à `max` octets (sur une limite de caractère), et vrai s'il
/// a été coupé.
pub fn cut(text: &str, max: usize) -> (String, bool) {
    if text.len() <= max {
        return (text.to_owned(), false);
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].to_owned(), true)
}

/// Valeur gardée si son JSON tient en `max` octets ; sinon son JSON coupé,
/// en texte, et vrai.
fn bounded_value(v: &Value, max: usize) -> (Value, bool) {
    let s = v.to_string();
    if s.len() <= max {
        (v.clone(), false)
    } else {
        (Value::String(cut(&s, max).0), true)
    }
}

/// Contenu de la première balise `<name>…</name>` (blancs retirés), s'il
/// n'est pas vide.
fn tag(text: &str, name: &str) -> Option<String> {
    let open = format!("<{name}>");
    let close = format!("</{name}>");
    let start = text.find(&open)? + open.len();
    let len = text[start..].find(&close)?;
    let v = text[start..start + len].trim();
    (!v.is_empty()).then(|| v.to_owned())
}

/// Sortie d'une commande locale ou bash : contenu des balises de sortie,
/// codes ANSI retirés.
fn command_output(text: &str) -> String {
    let mut parts = Vec::new();
    for name in [
        "local-command-stdout",
        "local-command-stderr",
        "bash-stdout",
        "bash-stderr",
    ] {
        if let Some(t) = tag(text, name) {
            parts.push(strip_ansi(&t));
        }
    }
    parts.join("\n")
}

/// Commandes locales de Claude Code dont la ligne nue (`/compact`, sans
/// `promptSource`) précède la ligne `<command-name>` qui les montre.
const BARE_COMMANDS: &[&str] = &[
    "compact",
    "clear",
    "exit",
    "quit",
    "model",
    "resume",
    "help",
    "config",
    "cost",
    "context",
    "memory",
    "init",
    "status",
    "permissions",
    "agents",
    "mcp",
    "hooks",
    "login",
    "logout",
    "plugin",
    "plugins",
    "rewind",
    "export",
    "add-dir",
    "doctor",
    "ide",
    "vim",
    "theme",
    "statusline",
    "usage",
    "output-style",
    "todos",
    "upgrade",
    "release-notes",
    "terminal-setup",
    "feedback",
    "bug",
    "fast",
    "effort",
    "advisor",
    "privacy-settings",
    "bashes",
    "tasks",
];

/// Ligne nue d'une commande connue (`/compact`, `/model opus`) : une seule
/// ligne, nom connu. Un prompt qui commence par un chemin (`/home/…`) n'en
/// est pas une.
fn is_bare_command(text: &str) -> bool {
    let t = text.trim();
    let Some(rest) = t.strip_prefix('/') else {
        return false;
    };
    let name = rest.split(' ').next().unwrap_or("");
    !t.contains('\n') && BARE_COMMANDS.contains(&name)
}

/// Retire les séquences d'échappement (ECMA-48) : CSI (`ESC [` … final
/// `@`–`~`, ou CSI sur 8 bits), OSC (`ESC ]` … BEL ou `ESC \`), chaînes
/// DCS, SOS, PM, APC (`ESC P`, `X`, `^`, `_` … `ESC \`), séquences à
/// intermédiaire (`ESC (` + un caractère…) et séquences à deux caractères
/// (`ESC c`, `ESC 7`…).
pub fn strip_ansi(text: &str) -> String {
    /// Jusqu'à BEL (si `bel`) ou ST (`ESC \`), inclus.
    fn skip_string(chars: &mut std::iter::Peekable<std::str::Chars<'_>>, bel: bool) {
        while let Some(c) = chars.next() {
            if bel && c == '\x07' {
                return;
            }
            if c == '\x1b' {
                if chars.peek() == Some(&'\\') {
                    chars.next();
                }
                return;
            }
        }
    }
    fn skip_csi(chars: &mut std::iter::Peekable<std::str::Chars<'_>>) {
        for c in chars.by_ref() {
            if ('@'..='~').contains(&c) {
                return;
            }
        }
    }
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{9b}' {
            skip_csi(&mut chars);
            continue;
        }
        if c != '\x1b' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('[') => skip_csi(&mut chars),
            Some(']') => skip_string(&mut chars, true),
            Some('P' | 'X' | '^' | '_') => skip_string(&mut chars, false),
            Some('(' | ')' | '*' | '+' | '-' | '.' | '/' | '#' | '%' | ' ') => {
                chars.next();
            }
            _ => {}
        }
    }
    out
}

/// Collages `<pasted_content id="X">…</pasted_content id="X">` retirés du
/// texte (remplacés par `[collage X]`), bornés avec lui à `max` octets.
fn extract_pasted(text: &str, max: usize) -> (String, Vec<Pasted>, bool) {
    const OPEN: &str = "<pasted_content id=\"";
    let mut out = String::new();
    let mut pasted = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find(OPEN) {
        let after = &rest[start + OPEN.len()..];
        let Some(q) = after.find("\">") else { break };
        let id = &after[..q];
        let body = &after[q + 2..];
        let close = format!("</pasted_content id=\"{id}\">");
        let Some(end) = body.find(&close) else { break };
        out.push_str(&rest[..start]);
        out.push_str(&format!("[collage {id}]"));
        let content = body[..end].strip_prefix('\n').unwrap_or(&body[..end]);
        let content = content.strip_suffix('\n').unwrap_or(content);
        pasted.push(Pasted {
            id: id.to_owned(),
            text: content.to_owned(),
        });
        rest = &body[end + close.len()..];
    }
    out.push_str(rest);
    // Bornes : le texte d'abord, puis les collages dans l'ordre.
    let (out, mut truncated) = cut(&out, max);
    let mut budget = max - out.len();
    for p in &mut pasted {
        if p.text.len() > budget {
            p.text = cut(&p.text, budget).0;
            truncated = true;
        }
        budget -= p.text.len();
    }
    (out, pasted, truncated)
}

/// `structuredPatch` (`[{oldStart, oldLines, newStart, newLines, lines:
/// [" ctx", "-old", "+new"]}]`) mis à la forme des hunks de
/// `sessions.diffFile` : `{header, old_start, old_lines, new_start,
/// new_lines, lines: [{kind, old_no, new_no, text}]}`. `None` si ce n'est
/// pas un tableau ; les hunks illisibles sont sautés.
pub fn patch_hunks(raw: &Value) -> Option<Value> {
    let hunks = raw.as_array()?;
    let out: Vec<Value> = hunks
        .iter()
        .filter_map(|h| {
            let n = |k: &str| h[k].as_u64();
            let (os, ol, ns, nl) = (n("oldStart")?, n("oldLines")?, n("newStart")?, n("newLines")?);
            let (mut old_no, mut new_no) = (os, ns);
            let lines: Vec<Value> = h["lines"]
                .as_array()?
                .iter()
                .filter_map(Value::as_str)
                .filter_map(|l| {
                    let mut chars = l.chars();
                    let kind = chars.next()?;
                    let text = chars.as_str();
                    Some(match kind {
                        '+' => {
                            new_no += 1;
                            json!({"kind": "+", "old_no": null, "new_no": new_no - 1, "text": text})
                        }
                        '-' => {
                            old_no += 1;
                            json!({"kind": "-", "old_no": old_no - 1, "new_no": null, "text": text})
                        }
                        ' ' => {
                            old_no += 1;
                            new_no += 1;
                            json!({"kind": " ", "old_no": old_no - 1, "new_no": new_no - 1, "text": text})
                        }
                        _ => return None, // « \ No newline at end of file »…
                    })
                })
                .collect();
            Some(json!({
                "header": format!("@@ -{os},{ol} +{ns},{nl} @@"),
                "old_start": os,
                "old_lines": ol,
                "new_start": ns,
                "new_lines": nl,
                "lines": lines,
            }))
        })
        .collect();
    Some(Value::Array(out))
}

/// Une ligne lisible qui résume un appel d'outil (chemin, commande, motif…),
/// au plus [`SUMMARY_CHARS`] caractères.
pub fn tool_summary(name: &str, input: &Value) -> String {
    let s = |k: &str| input[k].as_str().filter(|v| !v.is_empty());
    let raw = match name {
        "Read" | "Edit" | "Write" | "MultiEdit" => s("file_path").map(str::to_owned),
        "NotebookEdit" | "NotebookRead" => s("notebook_path").map(str::to_owned),
        "Bash" | "PowerShell" => s("command").map(str::to_owned),
        "Glob" | "Grep" => s("pattern").map(|p| match s("path") {
            Some(path) => format!("{p} ({path})"),
            None => p.to_owned(),
        }),
        "WebFetch" => s("url").map(str::to_owned),
        "WebSearch" | "ToolSearch" => s("query").map(str::to_owned),
        "Skill" => s("skill").or(s("command")).map(str::to_owned),
        "TodoWrite" => input["todos"]
            .as_array()
            .map(|t| format!("{} tâche(s)", t.len())),
        _ => None,
    }
    .or_else(|| {
        // Repli : première valeur texte de l'entrée.
        input
            .as_object()
            .and_then(|o| o.values().find_map(|v| v.as_str().map(str::to_owned)))
    })
    .unwrap_or_default();
    let flat = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    super::transcript::truncate_chars(&flat, SUMMARY_CHARS)
}

/// Partie d'une entrée lisible en entier (`conversation.full`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Part {
    Input,
    Result,
    Text,
}

impl Part {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "input" => Self::Input,
            "result" => Self::Result,
            "text" => Self::Text,
            _ => return None,
        })
    }
}

/// Contenu entier d'une partie de l'entrée `uid`, en rejouant ses lignes
/// (relues dans l'ordre, sans borne de la vue) : au plus [`MAX_FULL_BYTES`],
/// et vrai s'il a été coupé. `None` si l'entrée n'a pas cette partie.
pub fn full_text(
    uid: &str,
    agent: Option<&str>,
    lines: &[String],
    part: Part,
) -> Option<(String, bool)> {
    let mut c = Conversation::new(Limits::full());
    let seg = c.start_segment("", "start", None);
    let src = c.add_source(agent.map(str::to_owned), seg);
    for (i, l) in lines.iter().enumerate() {
        c.feed(src, i as u64, l);
    }
    let e = c.entry(uid)?;
    let text = match (&e.body, part) {
        (Body::Tool { input, .. }, Part::Input)
        | (
            Body::Question {
                questions: input, ..
            },
            Part::Input,
        ) => serde_json::to_string_pretty(input).ok()?,
        (Body::Subagent { .. }, Part::Input) => return None,
        (
            Body::Tool {
                result: Some(r), ..
            },
            Part::Result,
        ) => r.text.clone(),
        (Body::Prompt { text, pasted, .. }, Part::Text) => {
            let mut t = text.clone();
            for p in pasted {
                t = t.replacen(&format!("[collage {}]", p.id), &p.text, 1);
            }
            t
        }
        (Body::Text { markdown }, Part::Text) => markdown.clone(),
        (Body::Command { output, .. }, Part::Text) => output.clone(),
        (
            Body::Compaction {
                summary: Some(s), ..
            },
            Part::Text,
        ) => s.clone(),
        (
            Body::Notification {
                summary: Some(s), ..
            },
            Part::Text,
        ) => s.clone(),
        (Body::Error { message }, Part::Text) => message.clone(),
        _ => return None,
    };
    let (text, truncated) = cut(&text, MAX_FULL_BYTES);
    Some((text, truncated || e.truncated))
}

#[cfg(test)]
mod tests;
