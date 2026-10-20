//! Onglet Fichiers (v0.2, lot 3) : chemins relatifs à la racine d'une
//! session, contenu d'un dossier dérivé de la liste des fichiers d'un dépôt,
//! tri naturel. Pur : l'accès au disque est dans les adaptateurs.

use std::cmp::Ordering;

/// Entrées au plus par dossier listé.
pub const MAX_DIR_ENTRIES: usize = 2000;
/// Taille maximale d'un fichier lu (au-delà : `too_large`, rien n'est lu).
pub const MAX_READ_BYTES: u64 = 2 * 1024 * 1024;
/// Fichiers au plus dans la liste d'un dépôt (`git ls-files`).
pub const MAX_REPO_FILES: usize = 200_000;

/// Genre d'une entrée.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryKind {
    Dir,
    File,
    Symlink,
}

impl EntryKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Dir => "dir",
            Self::File => "file",
            Self::Symlink => "symlink",
        }
    }
}

/// Une entrée d'un dossier listé.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub name: String,
    /// Chemin relatif à la racine, séparé par `/`.
    pub path: String,
    pub kind: EntryKind,
    /// Taille d'un fichier (absente pour un dossier, un lien, un fichier supprimé).
    pub size: Option<u64>,
    /// Marque du diff (`A`, `M`, `D`, `R`, `?`), si le fichier ou un fichier
    /// du dossier a changé.
    pub changed: Option<&'static str>,
}

/// Chemin demandé ramené à une forme sûre : relatif, composants séparés par
/// `/`, sans `.` ni vide. Refusés : chemin absolu, `..`, octet nul,
/// composant `.git` (jamais listé ni lu). `""` désigne la racine.
pub fn normalize_rel(path: &str) -> Result<String, &'static str> {
    if path.contains('\0') {
        return Err("chemin invalide");
    }
    if path.starts_with('/') {
        return Err("chemin absolu refusé : chemin relatif à la racine de la session attendu");
    }
    let mut parts = Vec::new();
    for c in path.split('/') {
        match c {
            "" | "." => {}
            ".." => return Err("« .. » refusé : le chemin doit rester dans la racine"),
            c if is_git_dir(c) => return Err("le dossier .git n'est pas accessible"),
            c => parts.push(c),
        }
    }
    Ok(parts.join("/"))
}

/// Joint un dossier relatif et un nom.
pub fn join_rel(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_owned()
    } else {
        format!("{dir}/{name}")
    }
}

/// Enfants immédiats de `dir` dans une liste de fichiers (chemins relatifs
/// à la racine) : `(nom, est un dossier)`, sans doublon, sans `.git`.
pub fn children<'a>(files: impl IntoIterator<Item = &'a str>, dir: &str) -> Vec<(String, bool)> {
    let prefix = if dir.is_empty() {
        String::new()
    } else {
        format!("{dir}/")
    };
    let mut seen: std::collections::BTreeMap<String, bool> = std::collections::BTreeMap::new();
    for f in files {
        let Some(rest) = f.strip_prefix(prefix.as_str()) else {
            continue;
        };
        if rest.is_empty() {
            continue;
        }
        let (name, is_dir) = match rest.split_once('/') {
            Some((n, _)) => (n, true),
            None => (rest, false),
        };
        if is_git_dir(name) {
            continue;
        }
        let e = seen.entry(name.to_owned()).or_insert(is_dir);
        *e |= is_dir;
    }
    seen.into_iter().collect()
}

/// Morceau d'une clé de tri naturel : nombre (sans zéros de tête, comparé
/// par longueur puis chiffres) ou texte (en minuscules). Les nombres passent
/// avant le texte.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum KeyPart {
    Num(usize, String),
    Text(String),
}

/// Clé de tri naturel d'un nom, à calculer une fois par entrée.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct NaturalKey(Vec<KeyPart>, String);

/// Clé de tri naturel, sans casse : `a2` avant `a10` ; à égalité, l'ordre
/// des octets départage (`01` avant `1`, `B2` avant `b2`).
pub fn natural_key(s: &str) -> NaturalKey {
    let mut parts: Vec<(bool, String)> = Vec::new();
    for c in s.chars() {
        let digit = c.is_ascii_digit();
        match parts.last_mut() {
            Some((d, buf)) if *d == digit => buf.push(c),
            _ => parts.push((digit, c.to_string())),
        }
    }
    NaturalKey(
        parts
            .into_iter()
            .map(|(digit, buf)| {
                if digit {
                    let t = buf.trim_start_matches('0').to_owned();
                    KeyPart::Num(t.len(), t)
                } else {
                    KeyPart::Text(buf.to_lowercase())
                }
            })
            .collect(),
        s.to_owned(),
    )
}

/// Ordre naturel (voir [`natural_key`]).
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    natural_key(a).cmp(&natural_key(b))
}

/// Dossiers d'abord, puis ordre naturel (clés calculées une fois).
pub fn sort_entries(entries: &mut [Entry]) {
    entries.sort_by_cached_key(|e| (e.kind != EntryKind::Dir, natural_key(&e.name)));
}

/// Composant `.git`, quelle que soit la casse (systèmes de fichiers
/// insensibles à la casse).
pub fn is_git_dir(component: &str) -> bool {
    component.eq_ignore_ascii_case(".git")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_relative_paths() {
        assert_eq!(normalize_rel("").unwrap(), "");
        assert_eq!(normalize_rel("./src//a.rs/").unwrap(), "src/a.rs");
        for bad in [
            "/etc/passwd",
            "../x",
            "a/../../b",
            "a/.git/config",
            ".git",
            ".GIT/config",
            "a/.Git",
            "a\0b",
        ] {
            assert!(normalize_rel(bad).is_err(), "{bad}");
        }
        // Un nom qui commence par des points n'est pas `..`.
        assert_eq!(normalize_rel("...x/.gitignore").unwrap(), "...x/.gitignore");
    }

    #[test]
    fn children_of_a_directory() {
        let files = [
            "a.rs",
            "src/b.rs",
            "src/sous/c.rs",
            "src2/d",
            ".git/HEAD",
            "src/.git/x",
        ];
        assert_eq!(
            children(files, ""),
            [
                ("a.rs".to_owned(), false),
                ("src".to_owned(), true),
                ("src2".to_owned(), true)
            ]
        );
        assert_eq!(
            children(files, "src"),
            [("b.rs".to_owned(), false), ("sous".to_owned(), true)]
        );
        assert!(children(files, "rien").is_empty());
    }

    #[test]
    fn natural_order_with_directories_first() {
        let mut names = vec!["b10", "B2", "a", "b2", "img", "01", "1"];
        names.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(names, ["01", "1", "a", "B2", "b2", "b10", "img"]);
        let e = |name: &str, kind| Entry {
            name: name.into(),
            path: name.into(),
            kind,
            size: None,
            changed: None,
        };
        let mut v = vec![
            e("z.txt", EntryKind::File),
            e("src", EntryKind::Dir),
            e("a", EntryKind::Symlink),
        ];
        sort_entries(&mut v);
        let order: Vec<_> = v.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(order, ["src", "a", "z.txt"]);
    }
}
