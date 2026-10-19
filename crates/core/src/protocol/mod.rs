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
