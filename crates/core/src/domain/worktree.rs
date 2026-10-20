//! Worktrees d'un projet (v0.2, lot 6) : emplacement d'un nouveau worktree,
//! nom de dossier tiré de la branche, lecture des sorties de `git worktree
//! list --porcelain -z` et `git status --porcelain=v2 -z`, choix de la
//! branche de référence et état « intégré ».
//!
//! Ce module est pur : les appels à `git` sont dans l'adaptateur
//! `adapters::git_worktrees`.

use std::ffi::OsStr;
use std::os::unix::ffi::OsStrExt;
use std::path::{Component, Path, PathBuf};

/// Longueur maximale du nom de dossier tiré d'une branche (caractères ASCII).
pub const MAX_SLUG_CHARS: usize = 80;
/// Fichiers au plus listés dans l'erreur « worktree modifié » (`-32020`).
pub const MAX_DIRTY_FILES: usize = 20;
/// Longueur maximale d'un message de `git` rendu au client.
pub const MAX_GIT_MESSAGE_CHARS: usize = 500;
/// Dossier des worktrees `in_repo`, sous la racine du projet.
pub const IN_REPO_DIR: &str = ".worktrees";
/// Dossier des worktrees créés par Claude Desktop, sous la racine du projet.
pub const CLAUDE_DESKTOP_DIR: &str = ".claude/worktrees";

/// Emplacement d'un nouveau worktree.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Location {
    /// `<dossier parent du dépôt>/<nom du dépôt>-<slug>` (défaut).
    Sibling,
    /// `<racine>/.worktrees/<slug>`.
    InRepo,
    /// `<données de l'app>/worktrees/<nom du dépôt>-<hash8>/<slug>`.
    Managed,
    /// Chemin donné par le client.
    Custom,
}

impl Location {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "sibling" => Self::Sibling,
            "in_repo" => Self::InRepo,
            "managed" => Self::Managed,
            "custom" => Self::Custom,
            _ => return None,
        })
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Sibling => "sibling",
            Self::InRepo => "in_repo",
            Self::Managed => "managed",
            Self::Custom => "custom",
        }
    }
}

/// Nom de dossier tiré d'une branche : `/` → `-`, tout caractère hors de
/// `[A-Za-z0-9._-]` → `-`, coupé à [`MAX_SLUG_CHARS`] caractères.
pub fn branch_slug(branch: &str) -> String {
    branch
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '-'
            }
        })
        .take(MAX_SLUG_CHARS)
        .collect()
}

/// FNV-1a sur 64 bits : empreinte stable (d'une version à l'autre, d'une
/// machine à l'autre) d'un chemin, pour nommer un dossier.
pub fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// 8 premiers caractères hexadécimaux de l'empreinte du dossier commun.
pub fn common_dir_hash8(common_dir: &Path) -> String {
    format!("{:016x}", fnv1a64(common_dir.as_os_str().as_bytes()))[..8].to_owned()
}

/// Emplacement refusé (message en français).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct PathError(pub String);

/// Ce qu'il faut pour calculer le chemin d'un nouveau worktree.
#[derive(Debug, Clone)]
pub struct PathRequest<'a> {
    pub location: Location,
    /// Worktree principal du projet.
    pub project_root: &'a Path,
    /// Dossier commun du dépôt (identité du projet).
    pub common_dir: &'a Path,
    /// `$XDG_DATA_HOME/devmaestro/worktrees`.
    pub managed_base: &'a Path,
    pub branch: &'a str,
    /// Chemin demandé, seulement pour [`Location::Custom`].
    pub custom: Option<&'a Path>,
}

/// Chemin d'un nouveau worktree. Ne regarde pas le disque : l'appelant
/// vérifie que le dossier n'existe pas (et, pour `custom`, que le parent
/// existe).
pub fn worktree_path(r: &PathRequest<'_>) -> Result<PathBuf, PathError> {
    if r.location == Location::Custom {
        let Some(p) = r.custom else {
            return Err(PathError(
                "« worktree.path » est requis pour l'emplacement « custom »".into(),
            ));
        };
        if !p.is_absolute() {
            return Err(PathError(format!(
                "« worktree.path » doit être absolu : {}",
                p.display()
            )));
        }
        // Les composants `.` et `..` sont refusés tels qu'écrits (`Path`
        // efface un `.` final : `/a/.` se lirait `/a`).
        if p.as_os_str()
            .as_bytes()
            .split(|b| *b == b'/')
            .any(|c| c == b"." || c == b"..")
            || p.components().any(|c| matches!(c, Component::ParentDir))
            || p.parent().is_none()
        {
            return Err(PathError(format!(
                "« worktree.path » invalide : {}",
                p.display()
            )));
        }
        return Ok(p.to_path_buf());
    }
    if r.custom.is_some() {
        return Err(PathError(
            "« worktree.path » n'est accepté qu'avec l'emplacement « custom »".into(),
        ));
    }
    let slug = branch_slug(r.branch);
    if slug.is_empty() || slug.chars().all(|c| c == '.') {
        return Err(PathError(format!(
            "nom de branche inutilisable comme nom de dossier : {}",
            r.branch
        )));
    }
    let name = r
        .project_root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| PathError("racine du projet sans nom".into()))?;
    Ok(match r.location {
        Location::Sibling => {
            let parent = r
                .project_root
                .parent()
                .ok_or_else(|| PathError("la racine du projet n'a pas de parent".into()))?;
            parent.join(format!("{name}-{slug}"))
        }
        Location::InRepo => r.project_root.join(IN_REPO_DIR).join(slug),
        Location::Managed => r
            .managed_base
            .join(format!("{name}-{}", common_dir_hash8(r.common_dir)))
            .join(slug),
        Location::Custom => unreachable!("traité plus haut"),
    })
}

/// Un worktree tel que listé par `git worktree list --porcelain -z`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeEntry {
    pub path: PathBuf,
    /// Commit extrait (absent pour un dépôt nu).
    pub head: Option<String>,
    /// Branche extraite, en nom court (`refs/heads/` retiré) ; absente en
    /// HEAD détachée.
    pub branch: Option<String>,
    pub bare: bool,
    pub locked: bool,
    pub prunable: bool,
}

/// Lit la sortie de `git worktree list --porcelain -z` : chaque attribut
/// finit par un octet nul, chaque worktree par un octet nul de plus. Le
/// premier est le worktree principal.
pub fn parse_worktree_list(out: &[u8]) -> Vec<WorktreeEntry> {
    let mut list = Vec::new();
    let mut current: Option<WorktreeEntry> = None;
    for field in out.split(|b| *b == 0) {
        if field.is_empty() {
            list.extend(current.take());
            continue;
        }
        let (key, value) = match field.iter().position(|b| *b == b' ') {
            Some(i) => (&field[..i], &field[i + 1..]),
            None => (field, &[][..]),
        };
        if key == b"worktree" {
            list.extend(current.take());
            current = Some(WorktreeEntry {
                path: PathBuf::from(OsStr::from_bytes(value)),
                head: None,
                branch: None,
                bare: false,
                locked: false,
                prunable: false,
            });
            continue;
        }
        let Some(w) = current.as_mut() else {
            continue;
        };
        match key {
            b"HEAD" => w.head = std::str::from_utf8(value).ok().map(str::to_owned),
            b"branch" => {
                w.branch = std::str::from_utf8(value)
                    .ok()
                    .map(|b| b.strip_prefix("refs/heads/").unwrap_or(b).to_owned());
            }
            b"bare" => w.bare = true,
            b"locked" => w.locked = true,
            b"prunable" => w.prunable = true,
            _ => {}
        }
    }
    list.extend(current);
    list
}

/// Chemins des entrées de `git status --porcelain=v2 -z` (modifications et
/// fichiers non suivis ; les en-têtes `#` et les ignorés `!` ne comptent pas).
/// Un renommage (`2`) est suivi de l'ancien chemin, sauté.
pub fn parse_status_paths(out: &[u8]) -> Vec<String> {
    let mut paths = Vec::new();
    let mut fields = out.split(|b| *b == 0);
    while let Some(entry) = fields.next() {
        // Nombre d'espaces avant le chemin selon le genre d'entrée.
        let skip = match entry.first() {
            Some(b'1') => 8,
            Some(b'2') => 9,
            Some(b'u') => 10,
            Some(b'?') => 1,
            _ => continue,
        };
        let mut rest = entry;
        for _ in 0..skip {
            match rest.iter().position(|b| *b == b' ') {
                Some(i) => rest = &rest[i + 1..],
                None => {
                    rest = &[];
                    break;
                }
            }
        }
        if entry[0] == b'2' {
            let _ = fields.next(); // ancien chemin
        }
        if !rest.is_empty() {
            paths.push(String::from_utf8_lossy(rest).into_owned());
        }
    }
    paths
}

/// Branche de la référence d'intégration retenue.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefSide {
    /// `refs/remotes/origin/<défaut>`.
    Remote,
    /// `refs/heads/<défaut>`.
    Local,
}

/// Choix entre `origin/<défaut>` et `<défaut>` local quand les deux peuvent
/// servir : celle qui descend de l'autre (un merge local pas encore poussé
/// compte). Égales : la distante. Divergentes (aucune ne descend de l'autre) :
/// la distante, telle que l'utilisateur l'a récupérée (c'est là qu'arrivent
/// les merges de PR).
pub fn pick_reference(
    remote: bool,
    local: bool,
    local_is_ancestor_of_remote: bool,
    remote_is_ancestor_of_local: bool,
) -> Option<RefSide> {
    match (remote, local) {
        (false, false) => None,
        (true, false) => Some(RefSide::Remote),
        (false, true) => Some(RefSide::Local),
        (true, true) => {
            if remote_is_ancestor_of_local && !local_is_ancestor_of_remote {
                Some(RefSide::Local)
            } else {
                Some(RefSide::Remote)
            }
        }
    }
}

/// Branche de référence d'un dépôt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reference {
    /// Référence complète (`refs/remotes/origin/main`, `refs/heads/main`).
    pub full: String,
    /// Nom court (`origin/main`, `main`).
    pub short: String,
    /// Nom de la branche par défaut (`main`).
    pub default_branch: String,
}

/// Contenu d'une branche déjà dans la référence ?
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Integrated {
    /// La tête de la branche est un ancêtre de la référence.
    Merged,
    /// Fusionner la branche dans la référence ne changerait rien (squash,
    /// rebase).
    Squashed,
    /// Branche créée par le démon sans aucun commit à elle (sa tête est
    /// encore le commit de départ) : rien à perdre côté commits, mais ce
    /// n'est pas une intégration.
    Empty,
    No,
}

impl Integrated {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Merged => "merged",
            Self::Squashed => "squashed",
            Self::Empty => "empty",
            Self::No => "no",
        }
    }
}

/// Résultat de `git merge-tree --write-tree <référence> <branche>`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MergeTree {
    /// Fusion sans conflit : arbre obtenu.
    Clean(String),
    /// Conflit (code de sortie 1).
    Conflict,
    /// `git` en échec (autre code, délai…).
    Failed,
    /// `git merge-tree --write-tree` indisponible (git < 2.38) : le squash
    /// n'est pas évalué.
    Unsupported,
}

/// La tête d'un worktree créé par le démon est encore son commit de départ :
/// [`Integrated::Empty`]. Un worktree non enregistré (`start` absent) suit les
/// règles ordinaires.
pub fn is_empty_branch(head: Option<&str>, start: Option<&str>) -> bool {
    matches!((head, start), (Some(h), Some(s)) if h == s)
}

/// État « intégré » à partir de l'ancêtre commun et de `merge-tree`.
/// `None` : inconnu (`git` en échec). `merge-tree` absent (git < 2.38) :
/// `MergeTree::Unsupported`, la branche est `No` si elle n'est pas un ancêtre.
pub fn integration(
    head_is_ancestor: bool,
    merge_tree: impl FnOnce() -> MergeTree,
    reference_tree: impl FnOnce() -> Option<String>,
) -> Option<Integrated> {
    if head_is_ancestor {
        return Some(Integrated::Merged);
    }
    match merge_tree() {
        MergeTree::Clean(tree) => {
            let reference = reference_tree()?;
            Some(if tree == reference {
                Integrated::Squashed
            } else {
                Integrated::No
            })
        }
        MergeTree::Conflict | MergeTree::Unsupported => Some(Integrated::No),
        MergeTree::Failed => None,
    }
}

/// Qui a créé un worktree.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManagedBy {
    DevMaestro,
    ClaudeDesktop,
}

impl ManagedBy {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::DevMaestro => "devmaestro",
            Self::ClaudeDesktop => "claude_desktop",
        }
    }
}

/// `claude_desktop` sous `<racine>/.claude/worktrees/`, sinon `devmaestro`
/// s'il est enregistré par le démon, sinon rien.
pub fn managed_by(path: &Path, project_root: &Path, recorded: bool) -> Option<ManagedBy> {
    if path.starts_with(project_root.join(CLAUDE_DESKTOP_DIR)) {
        Some(ManagedBy::ClaudeDesktop)
    } else if recorded {
        Some(ManagedBy::DevMaestro)
    } else {
        None
    }
}

/// Indice du worktree qui contient `dir` : le chemin le plus long qui le
/// préfixe, composant par composant (un worktree `.worktrees/x` est dans le
/// principal, une session qui y tourne n'appartient qu'à lui).
pub fn owning_worktree(worktrees: &[PathBuf], dir: &Path) -> Option<usize> {
    worktrees
        .iter()
        .enumerate()
        .filter(|(_, w)| dir.starts_with(w))
        .max_by_key(|(_, w)| w.components().count())
        .map(|(i, _)| i)
}

/// Message de `git` montrable : texte lisible, sans caractère de contrôle,
/// lignes jointes par « ; », au plus [`MAX_GIT_MESSAGE_CHARS`] caractères.
pub fn clean_git_message(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let lines: Vec<String> = text
        .lines()
        .map(|l| {
            l.chars()
                .filter(|c| !c.is_control())
                .collect::<String>()
                .trim()
                .to_owned()
        })
        .filter(|l| !l.is_empty())
        .collect();
    let joined = lines.join(" ; ");
    if joined.is_empty() {
        return "échec sans message".into();
    }
    if joined.chars().count() > MAX_GIT_MESSAGE_CHARS {
        let mut cut: String = joined.chars().take(MAX_GIT_MESSAGE_CHARS).collect();
        cut.push('…');
        cut
    } else {
        joined
    }
}

/// Version minimale de git pour `git merge-tree --write-tree` (mode apparu
/// dans git 2.38.0, d'après ses notes de version et sa documentation).
pub const MERGE_TREE_WRITE_TREE_MIN: (u32, u32) = (2, 38);

/// `(majeure, mineure)` de la sortie de `git version` (`git version 2.53.0`,
/// `git version 2.39.5 (Apple Git-154)`).
pub fn parse_git_version(out: &str) -> Option<(u32, u32)> {
    let v = out.trim().strip_prefix("git version ")?;
    let mut parts = v.split(|c: char| !c.is_ascii_digit());
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    Some((major, minor))
}

/// Nom de branche ou de base refusé avant tout appel à `git` (une valeur qui
/// commence par `-` serait lue comme une option).
pub fn looks_like_option(s: &str) -> bool {
    s.starts_with('-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs() {
        assert_eq!(branch_slug("feat/login"), "feat-login");
        assert_eq!(branch_slug("fix/été 2026!"), "fix--t--2026-");
        assert_eq!(branch_slug("v1.2_x-y"), "v1.2_x-y");
        assert_eq!(branch_slug(&"a".repeat(200)).len(), MAX_SLUG_CHARS);
        assert_eq!(branch_slug(&"é".repeat(100)), "-".repeat(MAX_SLUG_CHARS));
    }

    #[test]
    fn hash_is_stable() {
        assert_eq!(fnv1a64(b""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(fnv1a64(b"a"), 0xaf63_dc4c_8601_ec8c);
        assert_eq!(common_dir_hash8(Path::new("/p/.git")).len(), 8);
        assert_ne!(
            common_dir_hash8(Path::new("/p/.git")),
            common_dir_hash8(Path::new("/q/.git"))
        );
    }

    fn req<'a>(location: Location, branch: &'a str, custom: Option<&'a Path>) -> PathRequest<'a> {
        PathRequest {
            location,
            project_root: Path::new("/home/u/dev/proj"),
            common_dir: Path::new("/home/u/dev/proj/.git"),
            managed_base: Path::new("/home/u/.local/share/devmaestro/worktrees"),
            branch,
            custom,
        }
    }

    #[test]
    fn paths_by_location() {
        let p = |l, b| worktree_path(&req(l, b, None)).unwrap();
        assert_eq!(
            p(Location::Sibling, "feat/x"),
            Path::new("/home/u/dev/proj-feat-x")
        );
        assert_eq!(
            p(Location::InRepo, "feat/x"),
            Path::new("/home/u/dev/proj/.worktrees/feat-x")
        );
        let hash = common_dir_hash8(Path::new("/home/u/dev/proj/.git"));
        assert_eq!(
            p(Location::Managed, "feat/x"),
            PathBuf::from(format!(
                "/home/u/.local/share/devmaestro/worktrees/proj-{hash}/feat-x"
            ))
        );
        let custom = Path::new("/ailleurs/wt");
        assert_eq!(
            worktree_path(&req(Location::Custom, "b", Some(custom))).unwrap(),
            custom
        );
        for bad in [
            req(Location::Custom, "b", None),
            req(Location::Custom, "b", Some(Path::new("relatif/wt"))),
            req(Location::Custom, "b", Some(Path::new("/a/../b"))),
            req(Location::Custom, "b", Some(Path::new("/"))),
            req(Location::Custom, "b", Some(Path::new("/a/."))),
            req(Location::Custom, "b", Some(Path::new("/a/.."))),
            req(Location::Custom, "b", Some(Path::new("/a/./b"))),
            req(Location::Sibling, "b", Some(custom)),
            req(Location::Sibling, "", None),
            req(Location::InRepo, "..", None),
        ] {
            assert!(worktree_path(&bad).is_err(), "{bad:?}");
        }
        assert_eq!(Location::parse("in_repo"), Some(Location::InRepo));
        assert_eq!(Location::parse("ailleurs"), None);
        assert_eq!(Location::Managed.as_str(), "managed");
    }

    #[test]
    fn worktree_list_porcelain() {
        let out = b"worktree /p\0HEAD aaaa\0branch refs/heads/main\0\0\
worktree /p-x\0HEAD bbbb\0branch refs/heads/feat/x\0locked raison\0\0\
worktree /p det\0HEAD cccc\0detached\0prunable gitdir file points to non-existent location\0\0\
worktree /nu.git\0bare\0\0";
        let l = parse_worktree_list(out);
        assert_eq!(l.len(), 4);
        assert_eq!(l[0].path, Path::new("/p"));
        assert_eq!(l[0].branch.as_deref(), Some("main"));
        assert_eq!(l[0].head.as_deref(), Some("aaaa"));
        assert_eq!(l[1].branch.as_deref(), Some("feat/x"));
        assert!(l[1].locked && !l[1].prunable);
        assert_eq!(l[2].path, Path::new("/p det"));
        assert!(l[2].branch.is_none() && l[2].prunable && !l[2].locked);
        assert!(l[3].bare && l[3].head.is_none());
        // `locked` sans raison, sans double nul final.
        let l = parse_worktree_list(b"worktree /a\0HEAD x\0locked\0");
        assert!(l[0].locked);
        assert!(parse_worktree_list(b"").is_empty());
    }

    #[test]
    fn status_porcelain_v2() {
        let out = b"1 .M N... 100644 100644 100644 aaa aaa src/a b.rs\0\
2 R. N... 100644 100644 100644 aaa aaa R100 neuf.rs\0vieux.rs\0\
u UU N... 100644 100644 100644 100644 a b c conflit.rs\0\
? nouveau.txt\0! ignore.log\0# branch.oid x\0";
        assert_eq!(
            parse_status_paths(out),
            ["src/a b.rs", "neuf.rs", "conflit.rs", "nouveau.txt"]
        );
        assert!(parse_status_paths(b"").is_empty());
    }

    #[test]
    fn reference_choice() {
        use RefSide::*;
        assert_eq!(pick_reference(false, false, false, false), None);
        assert_eq!(pick_reference(true, false, false, false), Some(Remote));
        assert_eq!(pick_reference(false, true, false, false), Some(Local));
        // Local en avance (merge local pas encore poussé).
        assert_eq!(pick_reference(true, true, false, true), Some(Local));
        // Distante en avance (PR mergée puis récupérée).
        assert_eq!(pick_reference(true, true, true, false), Some(Remote));
        // Égales, divergentes : la distante.
        assert_eq!(pick_reference(true, true, true, true), Some(Remote));
        assert_eq!(pick_reference(true, true, false, false), Some(Remote));
    }

    #[test]
    fn integration_rules() {
        let never = || -> MergeTree { panic!("merge-tree inutile") };
        assert_eq!(integration(true, never, || None), Some(Integrated::Merged));
        let t = || Some("t1".to_owned());
        assert_eq!(
            integration(false, || MergeTree::Clean("t1".into()), t),
            Some(Integrated::Squashed)
        );
        assert_eq!(
            integration(false, || MergeTree::Clean("t2".into()), t),
            Some(Integrated::No)
        );
        assert_eq!(
            integration(false, || MergeTree::Conflict, t),
            Some(Integrated::No)
        );
        assert_eq!(integration(false, || MergeTree::Failed, t), None);
        assert_eq!(
            integration(false, || MergeTree::Unsupported, t),
            Some(Integrated::No)
        );
        assert!(is_empty_branch(Some("a"), Some("a")));
        assert!(!is_empty_branch(Some("a"), Some("b")));
        assert!(!is_empty_branch(Some("a"), None));
        assert_eq!(Integrated::Empty.as_str(), "empty");
        assert_eq!(
            integration(false, || MergeTree::Clean("t1".into()), || None),
            None
        );
        assert_eq!(Integrated::Squashed.as_str(), "squashed");
    }

    #[test]
    fn ownership_and_managers() {
        let wts = [
            PathBuf::from("/p"),
            PathBuf::from("/p/.worktrees/x"),
            PathBuf::from("/p-x"),
        ];
        assert_eq!(owning_worktree(&wts, Path::new("/p/src")), Some(0));
        assert_eq!(
            owning_worktree(&wts, Path::new("/p/.worktrees/x/a")),
            Some(1)
        );
        assert_eq!(owning_worktree(&wts, Path::new("/p-x")), Some(2));
        assert_eq!(owning_worktree(&wts, Path::new("/p-xy")), None);
        let root = Path::new("/p");
        assert_eq!(
            managed_by(Path::new("/p/.claude/worktrees/a"), root, true),
            Some(ManagedBy::ClaudeDesktop)
        );
        assert_eq!(
            managed_by(Path::new("/p-x"), root, true),
            Some(ManagedBy::DevMaestro)
        );
        assert_eq!(managed_by(Path::new("/p-x"), root, false), None);
    }

    #[test]
    fn git_messages_are_cleaned() {
        assert_eq!(
            clean_git_message(b"fatal: a\n\x1b[31mhint: b\x07\n\n"),
            "fatal: a ; [31mhint: b"
        );
        assert_eq!(clean_git_message(b"  \n"), "échec sans message");
        let long = clean_git_message("x".repeat(600).as_bytes());
        assert_eq!(long.chars().count(), MAX_GIT_MESSAGE_CHARS + 1);
        assert!(looks_like_option("-D") && !looks_like_option("feat/-x"));
        assert_eq!(parse_git_version("git version 2.53.0\n"), Some((2, 53)));
        assert_eq!(
            parse_git_version("git version 2.39.5 (Apple Git-154)"),
            Some((2, 39))
        );
        assert_eq!(parse_git_version("git version 2.38.0.rc1"), Some((2, 38)));
        assert_eq!(parse_git_version("autre"), None);
        assert!((2, 37) < MERGE_TREE_WRITE_TREE_MIN && (2, 38) >= MERGE_TREE_WRITE_TREE_MIN);
    }
}
