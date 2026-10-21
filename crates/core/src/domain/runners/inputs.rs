//! Fichiers pris en compte par un runner (lot 15) : **tous** les fichiers
//! qui influencent ce que l'outil exécutera (source entière, verrou,
//! inclusions, imports, `.env`, Dockerfile…), chacun haché en entier. Leur
//! liste fait l'empreinte ([`super::Runner::fingerprint`]) : toute
//! modification de l'un d'eux redemande la confirmation.

use std::collections::HashSet;

/// Fichier haché au plus (et lu au plus pour suivre ses inclusions).
pub const MAX_HASH_BYTES: u64 = 16 * 1024 * 1024;
/// Fichier plus gros que [`MAX_HASH_BYTES`] haché quand même, par blocs,
/// au plus ; au-delà, seule sa taille compte.
pub const MAX_STREAM_HASH_BYTES: u64 = 256 * 1024 * 1024;
/// Fichiers pris en compte au plus par source.
pub const MAX_RUNNER_FILES: usize = 64;

/// Fichier tel que lu sous la racine pour l'empreinte.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Loaded {
    /// Contenu brut, [`MAX_HASH_BYTES`] au plus.
    Bytes(Vec<u8>),
    /// Absent (ou pas un fichier ordinaire, ou illisible : `note`).
    Absent(Option<String>),
    /// Le chemin sort de la racine (lien, `.git`…).
    Outside,
    /// Plus gros que [`MAX_HASH_BYTES`] (taille connue).
    TooLarge(u64),
}

/// État d'un fichier pris en compte.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FileState {
    /// Lu et haché en entier.
    Ok,
    /// Absent (ou illisible) : son apparition change l'empreinte.
    Absent,
    /// Hors de la racine du worktree : jamais lu.
    Outside,
    /// Trop gros pour être haché : seule sa taille compte.
    TooLarge,
    /// Chemin non résolu (variable, motif, forme non lue, distant).
    Unresolved,
}

impl FileState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Absent => "absent",
            Self::Outside => "outside",
            Self::TooLarge => "too_large",
            Self::Unresolved => "unresolved",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Ok => "lu",
            Self::Absent => "absent",
            Self::Outside => "hors de la racine",
            Self::TooLarge => "trop gros pour être montré",
            Self::Unresolved => "non résolu",
        }
    }
}

/// Un fichier pris en compte (`Runner.files` du protocole).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunnerFile {
    /// Chemin relatif à la racine ; tel qu'écrit s'il n'a pas pu être résolu.
    pub path: String,
    /// Taille en octets, si elle est connue.
    pub size: Option<u64>,
    pub state: FileState,
    /// Rôle du fichier (« source », « verrou », « inclus »…) et, s'il n'a
    /// pas pu être lu, pourquoi.
    pub note: String,
    /// SHA-256 du contenu brut ; sinon d'un marqueur `<état>:<chemin>[:taille]`.
    pub digest: String,
}

fn sha(bytes: &[u8]) -> String {
    super::super::files::sha256_hex(bytes)
}

/// Chemin `written` (relatif à `base`, dossier relatif à la racine) ramené
/// à un chemin relatif à la racine, sans `.` ni `..` ; refusé s'il est
/// absolu, sort de la racine, est distant, ou dépend d'une variable ou d'un
/// motif.
pub fn resolve_ref(base: &str, written: &str) -> Result<String, (FileState, String)> {
    let w = written.trim();
    if w.is_empty()
        || w.contains(['$', '*', '?', '[', '{', '`', '%'])
        || w.chars().any(char::is_control)
    {
        return Err((FileState::Unresolved, "variable ou motif".into()));
    }
    if w.contains("://") {
        return Err((
            FileState::Unresolved,
            "distant, contenu non vérifiable".into(),
        ));
    }
    if w.starts_with('/') || w.starts_with('~') {
        return Err((FileState::Outside, "chemin absolu".into()));
    }
    let mut parts: Vec<&str> = base.split('/').filter(|c| !c.is_empty()).collect();
    for c in w.split('/') {
        match c {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return Err((FileState::Outside, "sort de la racine".into()));
                }
            }
            c => parts.push(c),
        }
    }
    if parts.is_empty() {
        return Err((FileState::Outside, "sort de la racine".into()));
    }
    Ok(parts.join("/"))
}

/// Comme [`resolve_ref`], pour un dossier : la racine elle-même (`""`) est
/// acceptée (`.`, `app/..`).
pub fn resolve_dir(base: &str, written: &str) -> Result<String, (FileState, String)> {
    match resolve_ref(base, &format!("{}/x", written.trim().trim_end_matches('/'))) {
        Ok(p) => Ok(parent_dir(&p).to_owned()),
        Err(e) => Err(e),
    }
}

/// Dossier d'un chemin relatif (`a/b/c.mk` → `a/b`, `c.mk` → `""`).
pub fn parent_dir(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(d, _)| d)
}

/// Fichiers pris en compte pour une source, au fur et à mesure de sa lecture.
pub struct Inputs<'a> {
    view: &'a dyn super::RepoView,
    files: Vec<RunnerFile>,
    seen: HashSet<String>,
    full: bool,
}

impl<'a> Inputs<'a> {
    pub fn new(view: &'a dyn super::RepoView) -> Self {
        Self {
            view,
            files: Vec::new(),
            seen: HashSet::new(),
            full: false,
        }
    }

    fn push(&mut self, f: RunnerFile) -> bool {
        if self.files.len() >= MAX_RUNNER_FILES {
            if !self.full {
                self.full = true;
                self.files.push(RunnerFile {
                    path: "…".into(),
                    size: None,
                    state: FileState::Unresolved,
                    note: format!(
                        "plus de {MAX_RUNNER_FILES} fichiers : suite non suivie, non couverte"
                    ),
                    digest: sha(b"unresolved:trop-de-fichiers"),
                });
            }
            return false;
        }
        self.files.push(f);
        true
    }

    /// Prend en compte le fichier `path` (relatif à la racine) ; rend son
    /// texte (UTF-8) pour en suivre les inclusions, `None` s'il n'a pas pu
    /// être lu ou l'avait déjà été.
    pub fn file(&mut self, path: &str, role: &str) -> Option<String> {
        if self.seen.contains(path) {
            return None;
        }
        let loaded = self.view.load(path);
        self.record(path, role, loaded)
    }

    fn record(&mut self, path: &str, role: &str, loaded: Loaded) -> Option<String> {
        if !self.seen.insert(path.to_owned()) {
            return None;
        }
        let (state, size, digest, text, why) = match loaded {
            Loaded::Bytes(b) => {
                let digest = sha(&b);
                let size = b.len() as u64;
                (
                    FileState::Ok,
                    Some(size),
                    digest,
                    String::from_utf8(b).ok(),
                    None,
                )
            }
            Loaded::Absent(why) => (
                FileState::Absent,
                None,
                sha(format!("absent:{path}").as_bytes()),
                None,
                why,
            ),
            Loaded::Outside => (
                FileState::Outside,
                None,
                sha(format!("outside:{path}").as_bytes()),
                None,
                Some("lien ou chemin qui sort de la racine".into()),
            ),
            Loaded::TooLarge(n) => match self.view.hash_large(path) {
                // Haché en continu : toute modification compte ; ni montré
                // ni lu pour suivre ses inclusions.
                Some((size, Some(d))) => (
                    FileState::TooLarge,
                    Some(size),
                    d,
                    None,
                    Some(format!(
                        "plus de {} Mio : haché en entier, inclusions non suivies",
                        MAX_HASH_BYTES / (1024 * 1024)
                    )),
                ),
                Some((size, None)) => (
                    FileState::TooLarge,
                    Some(size),
                    sha(format!("too_large:{path}:{size}").as_bytes()),
                    None,
                    Some(format!(
                        "plus de {} Mio : seule la taille compte",
                        MAX_STREAM_HASH_BYTES / (1024 * 1024)
                    )),
                ),
                None => (
                    FileState::TooLarge,
                    Some(n),
                    sha(format!("too_large:{path}:{n}:illisible").as_bytes()),
                    None,
                    Some("trop gros et illisible : seule la taille compte".into()),
                ),
            },
        };
        let note = match why {
            Some(w) => format!("{role} ; {w}"),
            None => role.to_owned(),
        };
        let pushed = self.push(RunnerFile {
            path: path.to_owned(),
            size,
            state,
            note,
            digest,
        });
        if pushed { text } else { None }
    }

    /// Prend en compte le fichier `path` s'il existe (un `.npmrc`…) : son
    /// absence ne figure pas dans la liste.
    pub fn file_if_present(&mut self, path: &str, role: &str) -> Option<String> {
        if self.seen.contains(path) {
            return None;
        }
        match self.view.load(path) {
            Loaded::Absent(_) => None,
            loaded => self.record(path, role, loaded),
        }
    }

    /// Prend en compte un chemin écrit dans une source (relatif à `base`).
    pub fn reference(&mut self, base: &str, written: &str, role: &str) -> Option<String> {
        match resolve_ref(base, written) {
            Ok(path) => self.file(&path, role),
            Err((state, why)) => {
                self.marker(written.trim(), state, &format!("{role} ; {why}"));
                None
            }
        }
    }

    /// Entrée sans contenu lisible : référence non résolue, forme non lue.
    pub fn marker(&mut self, written: &str, state: FileState, note: &str) {
        let key = format!("\0{}:{written}:{note}", state.as_str());
        if !self.seen.insert(key) {
            return;
        }
        self.push(RunnerFile {
            path: written.to_owned(),
            size: None,
            state,
            note: note.to_owned(),
            digest: sha(format!("{}:{written}:{note}", state.as_str()).as_bytes()),
        });
    }

    pub fn into_files(self) -> Vec<RunnerFile> {
        self.files
    }
}

/// En-tête du corps montré : la liste des fichiers pris en compte.
pub fn files_header(files: &[RunnerFile]) -> String {
    let mut out =
        String::from("Fichiers pris en compte (toute modification redemande la confirmation) :");
    for f in files {
        out.push_str("\n- ");
        out.push_str(&f.path);
        match (f.state, f.size) {
            (FileState::Ok, Some(n)) => out.push_str(&format!(" — {n} octets")),
            (FileState::TooLarge, Some(n)) => {
                out.push_str(&format!(" — {} ({n} octets)", f.state.label()))
            }
            (s, _) => out.push_str(&format!(" — {}", s.label())),
        }
        out.push_str(&format!(" ({})", f.note));
    }
    out
}
