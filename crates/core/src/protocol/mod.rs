//! Protocole du socket du démon : trames, messages JSON-RPC 2.0 et format
//! JSON des objets. Contrat décrit dans `docs/protocole.md`, partagé par le
//! démon, les relais, le client `orchd ctl` et, au lot 4, le front.

pub mod frame;
pub mod json;

use serde_json::{Value, json};

pub use frame::{
    Frame, FrameError, MAX_FRAME_LEN, kind, read_frame, read_frame_async, write_frame,
};

/// Version du protocole, renvoyée par `hello`.
pub const PROTOCOL_VERSION: u32 = 1;

/// Variables d'environnement passées au processus `claude` (et donc aux hooks).
/// `ORCH_SOCKET` est le socket des **relais** (`relay.sock`), jamais celui de
/// contrôle.
pub const ENV_SOCKET: &str = "ORCH_SOCKET";
pub const ENV_TOKEN: &str = "ORCH_TOKEN";
pub const ENV_SESSION: &str = "ORCH_SESSION";

/// Codes d'erreur JSON-RPC.
pub mod error_code {
    pub const PARSE_ERROR: i64 = -32700;
    pub const INVALID_REQUEST: i64 = -32600;
    pub const METHOD_NOT_FOUND: i64 = -32601;
    pub const INVALID_PARAMS: i64 = -32602;
    pub const INTERNAL_ERROR: i64 = -32603;
    /// Session inconnue.
    pub const UNKNOWN_SESSION: i64 = -32001;
    /// La session n'est pas dans un état qui permet l'action.
    pub const INVALID_STATE: i64 = -32002;
    /// Profil inconnu.
    pub const UNKNOWN_PROFILE: i64 = -32003;
    /// Lancement impossible (binaire `claude` absent, dossier invalide…).
    pub const LAUNCH_FAILED: i64 = -32004;
    /// Mode refusé : `bypassPermissions` ou `dontAsk` sans `allow_dangerous_modes`.
    pub const DANGEROUS_MODE: i64 = -32005;
    /// Demande inconnue ou déjà close (réponse venue d'ailleurs, fin de tour…).
    pub const UNKNOWN_REQUEST: i64 = -32010;
    /// Mauvais genre : répondre à une question comme à une permission, ou l'inverse.
    pub const WRONG_REQUEST_KIND: i64 = -32011;
    /// Aucun relais n'attend la décision (demande sans détails, délai du relais
    /// dépassé, relais pas encore rattaché) : répondre dans le terminal.
    pub const NOT_ANSWERABLE: i64 = -32012;
    /// « Toujours » sans règle proposée par Claude Code.
    pub const NO_SUGGESTIONS: i64 = -32013;
    /// `sessions.setMode` impossible : mode courant inconnu ou hors du cycle
    /// de Shift+Tab, ou mode visé hors du cycle.
    pub const MODE_UNREACHABLE: i64 = -32014;
    /// `sessions.resume` impossible : Claude Code n'a pas de transcript pour
    /// cette session (par exemple lancée avec un marqueur de session enfant
    /// hérité, qui coupe l'enregistrement).
    pub const NO_TRANSCRIPT: i64 = -32015;
    /// `sessions.resume` impossible : le dossier de travail de la session
    /// n'existe plus (worktree supprimé…).
    pub const CWD_MISSING: i64 = -32016;
    /// Diff impossible : la session n'est pas dans un dépôt git.
    pub const NOT_A_REPO: i64 = -32017;
    /// Sous-agent inconnu dans cette session (`sessions.subagent`).
    pub const UNKNOWN_SUBAGENT: i64 = -32018;
    /// `worktrees.remove` refusé : une session vivante du démon tourne dans
    /// ce worktree.
    pub const WORKTREE_IN_USE: i64 = -32019;
    /// `worktrees.remove` refusé sans `force` : le worktree a des
    /// modifications non commitées ou des fichiers non suivis (liste dans
    /// `data.files`).
    pub const WORKTREE_DIRTY: i64 = -32020;
    /// `files.write` refusé : le fichier a changé depuis sa lecture (version
    /// actuelle dans `data.version`, `null` s'il n'existe plus).
    pub const FILE_CONFLICT: i64 = -32021;
    /// Forge indisponible (`forge.issues`, `forge.issue`) : accès désactivé,
    /// dépôt hors GitHub, `gh` absent ou non connecté (raison dans `data.reason`).
    pub const FORGE_UNAVAILABLE: i64 = -32022;
}

pub fn request(id: u64, method: &str, params: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})
}

pub fn notification(method: &str, params: Value) -> Value {
    json!({"jsonrpc": "2.0", "method": method, "params": params})
}

pub fn response(id: Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

pub fn error_response(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message.into()}})
}

/// Erreur avec un champ `data` facultatif (détails structurés).
pub fn error_response_data(
    id: Value,
    code: i64,
    message: impl Into<String>,
    data: Option<Value>,
) -> Value {
    let mut v = error_response(id, code, message);
    if let Some(data) = data {
        v["error"]["data"] = data;
    }
    v
}
