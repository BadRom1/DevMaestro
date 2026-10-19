//! Trames du socket du démon (voir `docs/protocole.md`).
//!
//! Une trame : longueur `u32` gros-boutiste (octets qui suivent, octet de
//! type compris), un octet de type, puis la charge utile.

use std::io::{self, Read, Write};

use thiserror::Error;
use tokio::io::{AsyncRead, AsyncReadExt};
use uuid::Uuid;

/// Taille maximale d'une trame (octet de type compris).
pub const MAX_FRAME_LEN: u32 = 16 * 1024 * 1024;

/// Octets de type.
pub mod kind {
    /// Message JSON-RPC 2.0 (UTF-8), dans les deux sens.
    pub const RPC: u8 = 0x01;
    /// Sortie d'un PTY, démon → client : UUID de session (16 octets) + octets.
    pub const PTY_OUTPUT: u8 = 0x02;
    /// Entrée d'un PTY, client → démon : UUID de session (16 octets) + octets.
    pub const PTY_INPUT: u8 = 0x03;
    /// Événement de hook, relais → démon : jeton, nom d'événement, JSON brut.
    pub const HOOK: u8 = 0x10;
    /// Statusline, relais → démon : jeton, JSON brut.
    pub const STATUSLINE: u8 = 0x11;
    /// Accusé de réception d'un hook, démon → relais, sans charge utile.
    pub const ACK: u8 = 0x12;
}

/// Une trame décodée.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    Rpc(Vec<u8>),
    PtyOutput {
        session: Uuid,
        data: Vec<u8>,
    },
    PtyInput {
        session: Uuid,
        data: Vec<u8>,
    },
    Hook {
        token: String,
        event: String,
        json: Vec<u8>,
    },
    Statusline {
        token: String,
        json: Vec<u8>,
    },
    Ack,
    /// Type inconnu : ignoré par le destinataire.
    Unknown {
        kind: u8,
    },
}

/// Trame illisible.
#[derive(Debug, Error)]
pub enum FrameError {
    #[error("entrée-sortie : {0}")]
    Io(#[from] io::Error),
    #[error("trame trop longue ({0} octets)")]
    TooLong(u32),
    #[error("trame vide (sans octet de type)")]
    Empty,
    #[error("trame mal formée : {0}")]
    Malformed(&'static str),
}

impl Frame {
    /// Octet de type de la trame.
    pub fn kind(&self) -> u8 {
        match self {
            Frame::Rpc(_) => kind::RPC,
            Frame::PtyOutput { .. } => kind::PTY_OUTPUT,
            Frame::PtyInput { .. } => kind::PTY_INPUT,
            Frame::Hook { .. } => kind::HOOK,
            Frame::Statusline { .. } => kind::STATUSLINE,
            Frame::Ack => kind::ACK,
            Frame::Unknown { kind } => *kind,
        }
    }

    /// Trame JSON-RPC depuis une valeur JSON.
    pub fn rpc(value: &serde_json::Value) -> Self {
        Frame::Rpc(serde_json::to_vec(value).unwrap_or_default())
    }

    /// Encode la trame complète (longueur, type, charge utile).
    pub fn encode(&self) -> Vec<u8> {
        let mut payload = Vec::new();
        match self {
            Frame::Rpc(json) => payload.extend_from_slice(json),
            Frame::PtyOutput { session, data } | Frame::PtyInput { session, data } => {
                payload.extend_from_slice(session.as_bytes());
                payload.extend_from_slice(data);
            }
            Frame::Hook { token, event, json } => {
                put_str16(&mut payload, token);
                put_str16(&mut payload, event);
                payload.extend_from_slice(json);
            }
            Frame::Statusline { token, json } => {
                put_str16(&mut payload, token);
                payload.extend_from_slice(json);
            }
            Frame::Ack | Frame::Unknown { .. } => {}
        }
        let len = (payload.len() + 1) as u32;
        let mut out = Vec::with_capacity(payload.len() + 5);
        out.extend_from_slice(&len.to_be_bytes());
        out.push(self.kind());
        out.extend_from_slice(&payload);
        out
    }

    /// Décode une charge utile d'après son octet de type.
    pub fn decode(kind: u8, payload: Vec<u8>) -> Result<Self, FrameError> {
        Ok(match kind {
            kind::RPC => Frame::Rpc(payload),
            kind::PTY_OUTPUT | kind::PTY_INPUT => {
                if payload.len() < 16 {
                    return Err(FrameError::Malformed("identifiant de session tronqué"));
                }
                let session = Uuid::from_slice(&payload[..16])
                    .map_err(|_| FrameError::Malformed("identifiant de session"))?;
                let data = payload[16..].to_vec();
                if kind == kind::PTY_OUTPUT {
                    Frame::PtyOutput { session, data }
                } else {
                    Frame::PtyInput { session, data }
                }
            }
            kind::HOOK => {
                let mut rest = payload.as_slice();
                let token = take_str16(&mut rest)?;
                let event = take_str16(&mut rest)?;
                Frame::Hook {
                    token,
                    event,
                    json: rest.to_vec(),
                }
            }
            kind::STATUSLINE => {
                let mut rest = payload.as_slice();
                let token = take_str16(&mut rest)?;
                Frame::Statusline {
                    token,
                    json: rest.to_vec(),
                }
            }
            kind::ACK => Frame::Ack,
            other => Frame::Unknown { kind: other },
        })
    }
}

fn put_str16(out: &mut Vec<u8>, s: &str) {
    let bytes = &s.as_bytes()[..s.len().min(u16::MAX as usize)];
    out.extend_from_slice(&(bytes.len() as u16).to_be_bytes());
    out.extend_from_slice(bytes);
}

fn take_str16(rest: &mut &[u8]) -> Result<String, FrameError> {
    if rest.len() < 2 {
        return Err(FrameError::Malformed("longueur de chaîne tronquée"));
    }
    let len = u16::from_be_bytes([rest[0], rest[1]]) as usize;
    if rest.len() < 2 + len {
        return Err(FrameError::Malformed("chaîne tronquée"));
    }
    let s = std::str::from_utf8(&rest[2..2 + len])
        .map_err(|_| FrameError::Malformed("chaîne non UTF-8"))?
        .to_owned();
    *rest = &rest[2 + len..];
    Ok(s)
}

fn check_len(len: u32) -> Result<(), FrameError> {
    if len == 0 {
        return Err(FrameError::Empty);
    }
    if len > MAX_FRAME_LEN {
        return Err(FrameError::TooLong(len));
    }
    Ok(())
}

/// Lit une trame (bloquant). `Ok(None)` en fin de flux propre (entre deux trames).
pub fn read_frame<R: Read>(r: &mut R) -> Result<Option<Frame>, FrameError> {
    let mut len = [0u8; 4];
    match r.read_exact(&mut len) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e.into()),
    }
    let len = u32::from_be_bytes(len);
    check_len(len)?;
    let mut buf = vec![0u8; len as usize];
    r.read_exact(&mut buf)?;
    let kind = buf.remove(0);
    Frame::decode(kind, buf).map(Some)
}

/// Écrit une trame (bloquant).
pub fn write_frame<W: Write>(w: &mut W, frame: &Frame) -> io::Result<()> {
    w.write_all(&frame.encode())?;
    w.flush()
}

/// Lit une trame (asynchrone). `Ok(None)` en fin de flux propre.
pub async fn read_frame_async<R: AsyncRead + Unpin>(
    r: &mut R,
) -> Result<Option<Frame>, FrameError> {
    let mut len = [0u8; 4];
    match r.read_exact(&mut len).await {
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e.into()),
    }
    let len = u32::from_be_bytes(len);
    check_len(len)?;
    let mut buf = vec![0u8; len as usize];
    r.read_exact(&mut buf).await?;
    let kind = buf.remove(0);
    Frame::decode(kind, buf).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roundtrip(f: Frame) {
        let bytes = f.encode();
        let len = u32::from_be_bytes(bytes[..4].try_into().unwrap()) as usize;
        assert_eq!(len, bytes.len() - 4, "la longueur compte l'octet de type");
        let back = read_frame(&mut bytes.as_slice()).unwrap().unwrap();
        assert_eq!(back, f);
    }

    #[test]
    fn frames_roundtrip() {
        let id = Uuid::from_u128(0x0123_4567_89ab_cdef_0123_4567_89ab_cdef);
        roundtrip(Frame::Rpc(
            br#"{"jsonrpc":"2.0","method":"hello","id":1}"#.to_vec(),
        ));
        roundtrip(Frame::PtyOutput {
            session: id,
            data: b"\x1b[31mrouge\x1b[0m".to_vec(),
        });
        roundtrip(Frame::PtyInput {
            session: id,
            data: Vec::new(),
        });
        roundtrip(Frame::Hook {
            token: "abc123".into(),
            event: "PermissionRequest".into(),
            json: br#"{"session_id":"s"}"#.to_vec(),
        });
        roundtrip(Frame::Statusline {
            token: "jeton".into(),
            json: b"{}".to_vec(),
        });
        roundtrip(Frame::Ack);
    }

    #[test]
    fn exact_wire_layout() {
        let f = Frame::Hook {
            token: "t".into(),
            event: "Stop".into(),
            json: b"{}".to_vec(),
        };
        assert_eq!(
            f.encode(),
            [
                0,
                0,
                0,
                12,
                kind::HOOK,
                0,
                1,
                b't',
                0,
                4,
                b'S',
                b't',
                b'o',
                b'p',
                b'{',
                b'}'
            ]
        );
        assert_eq!(Frame::Ack.encode(), [0, 0, 0, 1, kind::ACK]);
    }

    #[test]
    fn rejects_bad_frames() {
        assert!(matches!(
            read_frame(&mut [0u8, 0, 0, 0].as_slice()),
            Err(FrameError::Empty)
        ));
        assert!(matches!(
            read_frame(&mut [0xffu8, 0, 0, 0].as_slice()),
            Err(FrameError::TooLong(_))
        ));
        // PTY sans UUID complet.
        assert!(matches!(
            read_frame(&mut [0u8, 0, 0, 3, kind::PTY_INPUT, 1, 2].as_slice()),
            Err(FrameError::Malformed(_))
        ));
        // Chaîne de hook annoncée plus longue que la trame.
        assert!(matches!(
            read_frame(&mut [0u8, 0, 0, 4, kind::HOOK, 0, 9, b'x'].as_slice()),
            Err(FrameError::Malformed(_))
        ));
        // Trame coupée au milieu.
        assert!(matches!(
            read_frame(&mut [0u8, 0, 0, 9, kind::RPC, b'{'].as_slice()),
            Err(FrameError::Io(_))
        ));
        // Fin de flux propre.
        assert!(read_frame(&mut [].as_slice()).unwrap().is_none());
    }

    #[test]
    fn unknown_type_is_kept_not_an_error() {
        let f = read_frame(&mut [0u8, 0, 0, 2, 0x7f, 9].as_slice())
            .unwrap()
            .unwrap();
        assert_eq!(f, Frame::Unknown { kind: 0x7f });
    }

    #[tokio::test]
    async fn async_reader_matches_sync() {
        let mut bytes = Frame::Statusline {
            token: "t".into(),
            json: b"{\"a\":1}".to_vec(),
        }
        .encode();
        bytes.extend(Frame::Ack.encode());
        let mut r = bytes.as_slice();
        assert!(matches!(
            read_frame_async(&mut r).await.unwrap(),
            Some(Frame::Statusline { .. })
        ));
        assert_eq!(read_frame_async(&mut r).await.unwrap(), Some(Frame::Ack));
        assert_eq!(read_frame_async(&mut r).await.unwrap(), None);
    }
}
