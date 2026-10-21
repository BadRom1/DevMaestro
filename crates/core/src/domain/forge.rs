//! Forges (GitHub, GitLab…) : vocabulaire neutre du port [`crate::ports::Forge`]
//! (ADR 0006, v0.3 lot 13a) et règles pures : lecture de l'URL d'un remote,
//! bornes des issues, nettoyage des messages d'erreur.
//!
//! Le contenu des issues n'est jamais enregistré en base ni journalisé : seul
//! le lien session ↔ issue ([`SessionIssue`]) l'est.
//!
//! Demandes de fusion, CI et revue publiée (lot 13b) : [`pulls`] ; livraison
//! et suivi de CI (lot 14b) : [`runs`].

use std::path::Path;

pub mod pulls;
pub mod runs;

/// Corps d'une issue gardé au plus (64 Kio, coupé sur un caractère entier).
pub const MAX_BODY_BYTES: usize = 64 * 1024;
/// Issues listées par défaut (`forge.issues`).
pub const DEFAULT_ISSUES_LIMIT: usize = 50;
/// Issues listées au plus (`forge.issues`).
pub const MAX_ISSUES_LIMIT: usize = 200;
/// Longueur maximale d'un texte de recherche, en caractères.
pub const MAX_SEARCH_CHARS: usize = 256;
/// Longueur maximale d'un nom d'étiquette demandé, en caractères.
pub const MAX_LABEL_CHARS: usize = 100;
/// Étiquettes demandées au plus dans `labels` (`forge.issues`).
pub const MAX_LABEL_FILTERS: usize = 20;
/// Étiquettes du dépôt lues au plus (`forge.labels`).
pub const MAX_REPO_LABELS: usize = 500;
/// Description d'étiquette gardée au plus, en caractères.
pub const MAX_LABEL_DESCRIPTION_CHARS: usize = 500;
/// Titre d'issue gardé avec une session, en caractères.
pub const MAX_ISSUE_TITLE_CHARS: usize = 256;
/// URL d'issue gardée avec une session, en octets.
pub const MAX_ISSUE_URL_BYTES: usize = 2048;
/// Message d'erreur montré au plus, en caractères.
pub const MAX_MESSAGE_CHARS: usize = 500;

/// Genre de forge reconnu.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ForgeKind {
    Github,
}

impl ForgeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Github => "github",
        }
    }
}

/// Dépôt distant déduit de l'URL d'un remote.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct RemoteRepo {
    /// Hôte, en minuscules, sans port ni utilisateur.
    pub host: String,
    pub owner: String,
    pub repo: String,
}

impl RemoteRepo {
    /// `propriétaire/dépôt`.
    pub fn full_name(&self) -> String {
        format!("{}/{}", self.owner, self.repo)
    }

    /// `hôte/propriétaire/dépôt` (forme `[HOST/]OWNER/REPO` de `gh --repo`).
    pub fn slug(&self) -> String {
        format!("{}/{}/{}", self.host, self.owner, self.repo)
    }
}

/// Un nom de propriétaire ou de dépôt utilisable tel quel dans un chemin
/// d'API : lettres et chiffres ASCII, `-`, `_`, `.` ; ni vide, ni `.`/`..`.
fn valid_name(s: &str) -> bool {
    !s.is_empty()
        && s != "."
        && s != ".."
        && s.len() <= 100
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

/// Hôte acceptable : lettres, chiffres, `-` et `.` (pas d'IPv6 entre crochets).
fn valid_host(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 253
        && !s.starts_with(['.', '-'])
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.'))
}

/// Dépôt désigné par l'URL d'un remote git :
///
/// - `https://[user@]hôte[:port]/propriétaire/dépôt[.git][/]` (et `http://`) ;
/// - `ssh://[user@]hôte[:port]/propriétaire/dépôt[.git]` (et `git+ssh://`) ;
/// - `[user@]hôte:propriétaire/dépôt[.git]` (forme courte de scp).
///
/// Exactement deux composants de chemin (les sous-groupes de GitLab ne sont
/// pas reconnus), noms limités à `[A-Za-z0-9._-]`. `None` sinon (chemin
/// local, `file://`, URL inattendue).
pub fn parse_remote_url(url: &str) -> Option<RemoteRepo> {
    let url = url.trim();
    if url.is_empty() || url.chars().any(char::is_control) {
        return None;
    }
    let (authority, path) = if let Some((scheme, rest)) = url.split_once("://") {
        if !matches!(
            scheme.to_ascii_lowercase().as_str(),
            "https" | "http" | "ssh" | "git+ssh" | "ssh+git"
        ) {
            return None;
        }
        let (authority, path) = rest.split_once('/')?;
        let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
        // Port éventuel.
        let host = match host.split_once(':') {
            Some((h, port)) if port.bytes().all(|b| b.is_ascii_digit()) => h,
            Some(_) => return None,
            None => host,
        };
        (host.to_owned(), path.to_owned())
    } else {
        // Forme scp : `[user@]hôte:chemin`, sans `/` avant le `:`.
        let (before, path) = url.split_once(':')?;
        if before.contains('/') || path.starts_with("//") {
            return None;
        }
        let host = before.rsplit_once('@').map_or(before, |(_, h)| h);
        (host.to_owned(), path.trim_start_matches('/').to_owned())
    };
    let host = authority.to_ascii_lowercase();
    if !valid_host(&host) {
        return None;
    }
    let path = path.trim_end_matches('/');
    let mut parts = path.split('/');
    let owner = parts.next()?;
    let repo = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    let repo = repo.strip_suffix(".git").unwrap_or(repo);
    if !valid_name(owner) || !valid_name(repo) {
        return None;
    }
    Some(RemoteRepo {
        host,
        owner: owner.to_owned(),
        repo: repo.to_owned(),
    })
}

/// Fonctions d'une forge prises en charge par l'adaptateur.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Capabilities {
    pub sub_issues: bool,
    pub epics: bool,
    pub review_comments: bool,
    pub checks: bool,
}

/// État de l'accès à la forge d'un dossier.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForgeStatus {
    pub available: bool,
    /// Forge reconnue (même indisponible : GitHub sans `gh`, par exemple).
    pub kind: Option<ForgeKind>,
    /// Dépôt distant déduit du remote, s'il a pu l'être.
    pub remote: Option<RemoteRepo>,
    /// Pourquoi la forge est indisponible (texte en français).
    pub reason: Option<String>,
}

impl ForgeStatus {
    pub fn unavailable(
        kind: Option<ForgeKind>,
        remote: Option<RemoteRepo>,
        reason: impl Into<String>,
    ) -> Self {
        Self {
            available: false,
            kind,
            remote,
            reason: Some(reason.into()),
        }
    }
}

/// État d'une issue.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IssueState {
    Open,
    Closed,
}

impl IssueState {
    /// `OPEN` / `open` / `CLOSED` / `closed` ; autre chose : `None`.
    pub fn parse(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "open" => Some(Self::Open),
            "closed" => Some(Self::Closed),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Closed => "closed",
        }
    }
}

/// Étiquette d'une issue (couleur hexadécimale sans `#`, telle que donnée).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Label {
    pub name: String,
    pub color: Option<String>,
}

/// Étiquette du dépôt (`forge.labels`) : nom et description ramenés à une
/// ligne ([`one_line`]) ; couleur [`clean_color`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoLabel {
    pub name: String,
    pub color: Option<String>,
    pub description: Option<String>,
}

impl RepoLabel {
    /// Étiquette nettoyée ; `None` si le nom est vide une fois nettoyé.
    /// Description vide : `None` ; coupée à [`MAX_LABEL_DESCRIPTION_CHARS`].
    pub fn new(name: &str, color: Option<&str>, description: Option<&str>) -> Option<Self> {
        let name = one_line(name);
        if name.is_empty() {
            return None;
        }
        let description = description
            .map(one_line)
            .filter(|d| !d.is_empty())
            .map(|d| d.chars().take(MAX_LABEL_DESCRIPTION_CHARS).collect());
        Some(Self {
            name,
            color: color.and_then(clean_color),
            description,
        })
    }
}

/// Couleur d'étiquette sûre à poser telle quelle dans un style : six
/// chiffres hexadécimaux (un `#` de tête est retiré), en minuscules ;
/// autre chose : `None`.
pub fn clean_color(color: &str) -> Option<String> {
    let c = color.trim();
    let c = c.strip_prefix('#').unwrap_or(c);
    (c.len() == 6 && c.bytes().all(|b| b.is_ascii_hexdigit())).then(|| c.to_ascii_lowercase())
}

/// Sous-issue (ou issue parente) en bref.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssueRef {
    pub number: u64,
    pub title: String,
    pub state: IssueState,
    pub url: Option<String>,
}

/// Avancement des sous-issues.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SubIssuesSummary {
    pub total: u64,
    pub completed: u64,
}

/// Une issue.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Issue {
    pub number: u64,
    pub title: String,
    pub state: IssueState,
    pub url: String,
    pub author: Option<String>,
    pub labels: Vec<Label>,
    pub assignees: Vec<String>,
    /// Date de dernière mise à jour, telle que donnée par la forge (RFC 3339).
    pub updated_at: Option<String>,
    /// Corps en Markdown, au plus [`MAX_BODY_BYTES`] (`None` : pas lu, en liste).
    pub body: Option<String>,
    /// Le corps a été coupé.
    pub body_truncated: bool,
    /// Issue parente (même dépôt), si elle est connue.
    pub parent: Option<u64>,
    pub sub_issues: Vec<IssueRef>,
    /// `None` : inconnu (liste, ou forge sans sous-issues).
    pub sub_issues_summary: Option<SubIssuesSummary>,
}

/// Filtre d'état de `forge.issues`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StateFilter {
    Open,
    Closed,
    All,
}

impl StateFilter {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "open" => Some(Self::Open),
            "closed" => Some(Self::Closed),
            "all" => Some(Self::All),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Closed => "closed",
            Self::All => "all",
        }
    }
}

/// Filtre de `forge.issues`, déjà validé.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssueFilter {
    pub state: StateFilter,
    /// Recherche dans la syntaxe de la forge.
    pub search: Option<String>,
    /// Seulement les issues assignées à l'utilisateur connecté.
    pub assigned_to_me: bool,
    /// Étiquettes exigées toutes (ET logique), sans doublon, dans l'ordre
    /// donné (`label` d'abord, puis `labels`).
    pub labels: Vec<String>,
    /// 1 à [`MAX_ISSUES_LIMIT`].
    pub limit: usize,
}

impl Default for IssueFilter {
    fn default() -> Self {
        Self {
            state: StateFilter::Open,
            search: None,
            assigned_to_me: false,
            labels: Vec::new(),
            limit: DEFAULT_ISSUES_LIMIT,
        }
    }
}

/// Issue liée à une session (`sessions.launch`), enregistrée en base.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionIssue {
    pub number: u64,
    pub title: String,
    pub url: String,
}

/// Lien session ↔ issue refusé.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionIssueError(pub &'static str);

impl SessionIssue {
    /// Lien validé : numéro de 1 à 2³¹, titre ramené à une ligne (caractères
    /// de contrôle et de mise en forme invisibles retirés, blancs réduits),
    /// non vide, coupé à [`MAX_ISSUE_TITLE_CHARS`] ; URL `https://` sans
    /// caractère de contrôle ni blanc, au plus [`MAX_ISSUE_URL_BYTES`].
    pub fn new(number: u64, title: &str, url: &str) -> Result<Self, SessionIssueError> {
        if number == 0 || number > i32::MAX as u64 {
            return Err(SessionIssueError("numéro d'issue invalide"));
        }
        let title = one_line(title);
        if title.is_empty() {
            return Err(SessionIssueError("titre d'issue vide"));
        }
        let title: String = title.chars().take(MAX_ISSUE_TITLE_CHARS).collect();
        let url = url.trim();
        let scheme_ok = url
            .get(..8)
            .is_some_and(|s| s.eq_ignore_ascii_case("https://"));
        if !scheme_ok
            || url.len() <= 8
            || url.len() > MAX_ISSUE_URL_BYTES
            || url.chars().any(|c| c.is_control() || c.is_whitespace())
        {
            return Err(SessionIssueError("URL d'issue invalide (https:// attendu)"));
        }
        Ok(Self {
            number,
            title,
            url: url.to_owned(),
        })
    }
}

/// Caractère invisible (mise en forme de la catégorie Unicode Cf, espaces
/// sans chasse, séparateurs de ligne et de paragraphe, forçage du sens
/// d'écriture, étiquettes U+E0000–E007F, sélecteurs de variation
/// U+FE00–FE0F et U+E0100–E01EF) : de quoi cacher du texte à l'utilisateur
/// dans un contenu venu d'une forge. Retiré de tout texte de la forge
/// (titres, corps) et du contenu collé d'un prompt initial.
pub fn invisible(c: char) -> bool {
    matches!(
        c,
        '\u{00AD}'
            | '\u{061C}'
            | '\u{180E}'
            | '\u{200B}'..='\u{200F}'
            | '\u{2028}'..='\u{202E}'
            | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{206F}'
            | '\u{FE00}'..='\u{FE0F}'
            | '\u{FEFF}'
            | '\u{E0000}'..='\u{E007F}'
            | '\u{E0100}'..='\u{E01EF}'
    )
}

/// Texte de plusieurs lignes nettoyé : fins de ligne `\r\n` / `\r` ramenées
/// à `\n`, caractères de contrôle (sauf `\n` et `\t`) et invisibles
/// ([`invisible`]) retirés. Les blancs ne sont pas touchés.
pub fn clean_text(text: &str) -> String {
    text.replace("\r\n", "\n")
        .replace('\r', "\n")
        .chars()
        .filter(|c| (*c == '\n' || *c == '\t' || !c.is_control()) && !invisible(*c))
        .collect()
}

/// Texte ramené à une ligne : contrôles et invisibles retirés, blancs réduits.
pub fn one_line(text: &str) -> String {
    text.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .filter(|c| !invisible(*c))
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Corps coupé à [`MAX_BODY_BYTES`] sur un caractère entier ; `true` s'il l'a été.
pub fn truncate_body(body: &str) -> (String, bool) {
    if body.len() <= MAX_BODY_BYTES {
        return (body.to_owned(), false);
    }
    let mut end = MAX_BODY_BYTES;
    while !body.is_char_boundary(end) {
        end -= 1;
    }
    (body[..end].to_owned(), true)
}

/// Identifiants d'une URL (`schéma://utilisateur:secret@hôte/…`) masqués :
/// `schéma://…@hôte/…`. `None` si le mot n'en porte pas.
pub(crate) fn mask_url_credentials(word: &str) -> Option<String> {
    let i = word.find("://")?;
    let rest = &word[i + 3..];
    let authority = &rest[..rest.find(['/', '?', '#']).unwrap_or(rest.len())];
    let at = authority.rfind('@')?;
    Some(format!("{}…@{}", &word[..i + 3], &rest[at + 1..]))
}

/// Le mot ressemble-t-il à un jeton GitHub (`ghp_…`, `gho_…`, `ghu_…`,
/// `ghs_…`, `ghr_…`, `github_pat_…`) ?
pub(crate) fn looks_like_token(word: &str) -> bool {
    let w = word.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '_');
    let body = if let Some(rest) = w.strip_prefix("github_pat_") {
        rest
    } else if w.len() > 4
        && w.starts_with("gh")
        && matches!(w.as_bytes()[2], b'p' | b'o' | b'u' | b's' | b'r')
        && w.as_bytes()[3] == b'_'
    {
        &w[4..]
    } else {
        return false;
    };
    body.len() >= 8 && body.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// Message d'un outil de forge montrable : sans caractère de contrôle,
/// lignes jointes par « ; », jetons et identifiants d'URL masqués, chemins absolus (dont `hidden`,
/// la racine du dépôt et le dossier personnel) remplacés par « … »,
/// [`MAX_MESSAGE_CHARS`] caractères au plus.
pub fn clean_message(stderr: &[u8], hidden: &[&Path]) -> String {
    let mut text = String::from_utf8_lossy(stderr).into_owned();
    // Les chemins connus d'abord (ils peuvent contenir des espaces).
    let mut hidden: Vec<String> = hidden
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .filter(|p| p.len() > 1)
        .collect();
    hidden.sort_by_key(|p| std::cmp::Reverse(p.len()));
    for p in &hidden {
        text = text.replace(p.as_str(), "…");
    }
    let lines: Vec<String> = text
        .lines()
        .map(|l| {
            l.chars()
                .filter(|c| !c.is_control() && !invisible(*c))
                .collect::<String>()
                .split_whitespace()
                .map(|w| {
                    if looks_like_token(w) {
                        "<jeton masqué>".to_owned()
                    } else if let Some(masked) = mask_url_credentials(w) {
                        masked
                    } else if w.starts_with('/') || w.starts_with("~/") || w.starts_with("…/") {
                        "…".to_owned()
                    } else {
                        w.to_owned()
                    }
                })
                .collect::<Vec<_>>()
                .join(" ")
        })
        .filter(|l| !l.is_empty())
        .collect();
    let joined = lines.join(" ; ");
    if joined.is_empty() {
        return "échec sans message".into();
    }
    if joined.chars().count() > MAX_MESSAGE_CHARS {
        let mut cut: String = joined.chars().take(MAX_MESSAGE_CHARS).collect();
        cut.push('…');
        cut
    } else {
        joined
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo(host: &str, owner: &str, name: &str) -> Option<RemoteRepo> {
        Some(RemoteRepo {
            host: host.into(),
            owner: owner.into(),
            repo: name.into(),
        })
    }

    #[test]
    fn remote_urls_are_parsed() {
        let gh = repo("github.com", "BadRom1", "DevMaestro");
        for url in [
            "https://github.com/BadRom1/DevMaestro",
            "https://github.com/BadRom1/DevMaestro.git",
            "https://github.com/BadRom1/DevMaestro/",
            "https://user@GitHub.com/BadRom1/DevMaestro.git",
            "https://x-access:secret@github.com:443/BadRom1/DevMaestro.git",
            "http://github.com/BadRom1/DevMaestro",
            "ssh://git@github.com/BadRom1/DevMaestro.git",
            "ssh://git@github.com:22/BadRom1/DevMaestro.git",
            "git+ssh://git@github.com/BadRom1/DevMaestro",
            "git@github.com:BadRom1/DevMaestro.git",
            "git@github.com:/BadRom1/DevMaestro.git",
            "github.com:BadRom1/DevMaestro",
            "  git@github.com:BadRom1/DevMaestro.git\n",
        ] {
            assert_eq!(parse_remote_url(url), gh, "{url}");
        }
        assert_eq!(
            parse_remote_url("git@ghe.example.org:equipe/outil.git"),
            repo("ghe.example.org", "equipe", "outil")
        );
        assert_eq!(
            parse_remote_url("https://gitlab.com/a/b.git"),
            repo("gitlab.com", "a", "b")
        );
    }

    #[test]
    fn unexpected_remote_urls_are_refused() {
        for url in [
            "",
            "/home/u/depot",
            "../depot",
            "file:///home/u/depot",
            "ftp://github.com/a/b",
            "https://github.com/a",
            "https://github.com/a/b/c",
            "https://gitlab.com/groupe/sous-groupe/projet.git",
            "https://github.com/a/b?x=1",
            "https://github.com/{owner}/b",
            "https://github.com/../b",
            "https://github.com/a/%2e%2e",
            "https://github.com:abc/a/b",
            "https://[::1]/a/b",
            "git@github.com:a",
            "git@github.com:a/b\nc",
        ] {
            assert_eq!(parse_remote_url(url), None, "{url}");
        }
    }

    #[test]
    fn slugs() {
        let r = parse_remote_url("git@github.com:o/r.git").unwrap();
        assert_eq!(r.slug(), "github.com/o/r");
        assert_eq!(r.full_name(), "o/r");
    }

    #[test]
    fn bodies_are_truncated_on_a_char_boundary() {
        let (b, t) = truncate_body("court");
        assert_eq!((b.as_str(), t), ("court", false));
        let exact = "a".repeat(MAX_BODY_BYTES);
        assert_eq!(truncate_body(&exact), (exact.clone(), false));
        let long = format!("{}é{}", "a".repeat(MAX_BODY_BYTES - 1), "b".repeat(10));
        let (b, t) = truncate_body(&long);
        assert!(t);
        assert_eq!(b.len(), MAX_BODY_BYTES - 1);
        assert!(b.chars().all(|c| c == 'a'));
    }

    #[test]
    fn session_issue_is_validated() {
        let i = SessionIssue::new(
            42,
            "  Corriger\n le\u{202E} relais ",
            "https://github.com/o/r/issues/42",
        )
        .unwrap();
        assert_eq!(i.title, "Corriger le relais");
        assert_eq!(i.number, 42);
        assert!(SessionIssue::new(0, "t", "https://x/1").is_err());
        assert!(SessionIssue::new(1, " \n ", "https://x/1").is_err());
        assert!(SessionIssue::new(1, "t", "http://x/1").is_err());
        assert!(SessionIssue::new(1, "t", "javascript:alert(1)").is_err());
        assert!(SessionIssue::new(1, "t", "https://x/a b").is_err());
        assert!(SessionIssue::new(1, "t", "https://").is_err());
        let long = SessionIssue::new(1, &"é".repeat(1000), "https://x/1").unwrap();
        assert_eq!(long.title.chars().count(), MAX_ISSUE_TITLE_CHARS);
    }

    #[test]
    fn messages_are_cleaned() {
        let home = Path::new("/home/u");
        let root = Path::new("/home/u/mon dépôt");
        let msg = clean_message(
            b"error: token ghp_ABCDEFGHijklmnop1234 refused\n\x1b[31mopen /home/u/mon d\xc3\xa9p\xc3\xb4t/.git/x: no\x07 such file\n\nalso /etc/gh/hosts.yml and github_pat_11ABCDEFG_xyz123456\n",
            &[home, root],
        );
        assert_eq!(
            msg,
            "error: token <jeton masqué> refused ; [31mopen … no such file ; also … and <jeton masqué>"
        );
        assert!(!msg.contains("/home"));
        assert_eq!(clean_message(b"\n \n", &[]), "échec sans message");
        let long = clean_message("é".repeat(2000).as_bytes(), &[]);
        assert_eq!(long.chars().count(), MAX_MESSAGE_CHARS + 1);
        // Identifiants dans une URL.
        assert_eq!(
            clean_message(
                b"fatal: https://user:s3cr3t@github.com/o/r.git refused; http://tok@h/x ok https://github.com/a@b",
                &[]
            ),
            "fatal: https://…@github.com/o/r.git refused; http://…@h/x ok https://github.com/a@b"
        );
        // Pas un jeton : mot ordinaire.
        assert_eq!(clean_message(b"ghost_town gh_x", &[]), "ghost_town gh_x");
    }

    #[test]
    fn invisible_characters_are_removed() {
        let hidden = "a\u{200B}\u{200C}\u{200D}\u{2028}\u{2029}\u{2060}\u{2064}\u{FEFF}\
                      \u{E0001}\u{E0041}\u{E007F}\u{E0100}\u{E01EF}\u{FE00}\u{FE0F}\u{202E}b";
        assert_eq!(one_line(hidden), "ab");
        assert_eq!(clean_text(hidden), "ab");
        // Voisins visibles gardés.
        assert_eq!(one_line("\u{E01F0}x\u{FE10}"), "\u{E01F0}x\u{FE10}");
        assert_eq!(
            clean_text("l1\r\nl2\rl3\n\tfin\u{1b}[31m\u{7}"),
            "l1\nl2\nl3\n\tfin[31m"
        );
    }

    #[test]
    fn repo_labels_are_cleaned() {
        let l = RepoLabel::new(
            " bug\u{202E}\n critique ",
            Some("#D73A4A"),
            Some("Ne\u{200B} marche\r\npas"),
        )
        .unwrap();
        assert_eq!(l.name, "bug critique");
        assert_eq!(l.color.as_deref(), Some("d73a4a"));
        assert_eq!(l.description.as_deref(), Some("Ne marche pas"));
        let l = RepoLabel::new("x", Some("red;background:url(x)"), Some(" \u{FEFF} ")).unwrap();
        assert_eq!((l.color, l.description), (None, None));
        assert!(RepoLabel::new("\u{200B} \n", None, None).is_none());
        let long = RepoLabel::new("x", None, Some(&"é".repeat(2000))).unwrap();
        assert_eq!(
            long.description.unwrap().chars().count(),
            MAX_LABEL_DESCRIPTION_CHARS
        );
        for bad in ["fff", "ggg000", "1234567", "", "#"] {
            assert_eq!(clean_color(bad), None, "{bad}");
        }
        assert_eq!(clean_color("0dd8ac").as_deref(), Some("0dd8ac"));
    }

    #[test]
    fn states_and_filters() {
        assert_eq!(IssueState::parse("OPEN"), Some(IssueState::Open));
        assert_eq!(IssueState::parse("closed"), Some(IssueState::Closed));
        assert_eq!(IssueState::parse("merged"), None);
        assert_eq!(StateFilter::parse("all"), Some(StateFilter::All));
        assert_eq!(StateFilter::parse("ALL"), None);
    }
}
