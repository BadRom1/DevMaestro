//! Historique des commits d'une session (v0.3, lot 9) : lecture de la sortie
//! de `git log`, pure.
//!
//! Format lu (voir [`LOG_FORMAT`]) : `git log -z` avec sept champs séparés
//! par un octet nul (`%H %P %an %aI %s %b %ae`), chaque commit terminé
//! par un octet nul. Avec `--numstat`, les compteurs suivent l'en-tête :
//! `\n` puis, par fichier, `<ajouts>\t<suppressions>\t<chemin>\0` (renommage :
//! `<a>\t<s>\t\0<ancien>\0<nouveau>\0`), `-` pour un binaire. Constaté avec
//! git 2.53 (voir les tests). Un message de commit ne peut pas contenir
//! d'octet nul : le découpage par champ est sûr. Une entrée illisible (sha
//! mal formé : sortie coupée ou inattendue) arrête la lecture.

use super::diff::DiffBase;

/// Commits listés par défaut.
pub const DEFAULT_COMMITS: usize = 200;
/// Commits listés au plus.
pub const MAX_COMMITS: usize = 500;
/// Taille maximale du corps d'un message (octets UTF-8, coupé sur un caractère).
pub const MAX_BODY_BYTES: usize = 4096;
/// Taille maximale du sujet (octets UTF-8, coupé sur un caractère).
pub const MAX_SUBJECT_BYTES: usize = 1024;
/// Taille maximale du nom de l'auteur (octets UTF-8, coupé sur un caractère).
pub const MAX_AUTHOR_BYTES: usize = 256;
/// Taille estimée au plus de la liste rendue par `sessions.commits` (JSON) :
/// au-delà, la liste est coupée (`truncated`), loin sous la taille maximale
/// d'une trame.
pub const MAX_LOG_JSON_BYTES: usize = 4 * 1024 * 1024;
/// Caractères du sha court (en-tête des commentaires de commit).
pub const SHORT_SHA: usize = 7;

/// `--format` de `git log` lu par [`parse_log`].
pub const LOG_FORMAT: &str = "--format=%H%x00%P%x00%an%x00%aI%x00%s%x00%b%x00%ae";
/// Champs par commit dans [`LOG_FORMAT`].
const FIELDS: usize = 7;

/// Un commit de l'historique.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Commit {
    pub sha: String,
    /// Parents, le premier d'abord (vide pour un commit racine).
    pub parents: Vec<String>,
    /// Nom de l'auteur, sans adresse électronique.
    pub author: String,
    /// Adresse électronique de l'auteur (`%ae`, lot 14b : reconnaître les
    /// commits de l'utilisateur) ; jamais renvoyée au client.
    pub author_email: String,
    /// Date de l'auteur, ISO 8601 strict (`%aI`).
    pub date: String,
    /// Sujet (premier paragraphe du message, sur une ligne).
    pub subject: String,
    /// Reste du message, sans blancs finaux, coupé à [`MAX_BODY_BYTES`].
    pub body: String,
    /// Fichiers changés, ajouts, suppressions : contre le premier parent
    /// (contre l'arbre vide pour un commit racine). Zéro sans compteurs
    /// (voir [`CommitLog::stats`]).
    pub files: u64,
    pub additions: u64,
    pub deletions: u64,
}

impl Commit {
    /// Parent comparé : le premier (`None` pour un commit racine).
    pub fn first_parent(&self) -> Option<&str> {
        self.parents.first().map(String::as_str)
    }

    pub fn short(&self) -> &str {
        short_sha(&self.sha)
    }
}

/// [`SHORT_SHA`] premiers caractères d'un sha.
pub fn short_sha(sha: &str) -> &str {
    sha.get(..SHORT_SHA).unwrap_or(sha)
}

/// Plage listée.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommitRange {
    /// Commits de la branche depuis la base du diff (`<base>..HEAD`).
    Branch,
    /// Derniers commits de `HEAD` (travail direct sur la branche par
    /// défaut, tout poussé : la plage de la branche est vide).
    Recent,
}

impl CommitRange {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Branch => "branch",
            Self::Recent => "recent",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "branch" => Some(Self::Branch),
            "recent" => Some(Self::Recent),
            _ => None,
        }
    }

    /// Plage retenue : celle demandée, sinon automatique (`Recent` si la
    /// base vaut `HEAD`, c'est-à-dire si la plage de la branche est vide :
    /// sur la branche par défaut tout poussé, sans branche par défaut ou
    /// sans ancêtre commun).
    pub fn resolve(requested: Option<Self>, base: &str, head: &str) -> Self {
        requested.unwrap_or(if base == head {
            Self::Recent
        } else {
            Self::Branch
        })
    }
}

/// Commits de la branche d'une session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitLog {
    /// Racine du worktree.
    pub root: std::path::PathBuf,
    /// Base du diff (même résolution que `sessions.diff`).
    pub base: DiffBase,
    /// `HEAD` (absent avant le premier commit).
    pub head: Option<String>,
    /// Plage listée.
    pub range: CommitRange,
    /// Du plus récent au plus ancien.
    pub commits: Vec<Commit>,
    /// D'autres commits existent au-delà de la limite, ou la sortie de `git`
    /// (ou la réponse, voir [`MAX_LOG_JSON_BYTES`]) a été coupée.
    pub truncated: bool,
    /// Compteurs par commit calculés (sinon : non demandés, ou abandonnés
    /// parce que trop lents).
    pub stats: bool,
}

impl CommitLog {
    pub fn commit(&self, sha: &str) -> Option<&Commit> {
        self.commits.iter().find(|c| c.sha == sha)
    }
}

/// Identifiant d'objet git complet : 40 (SHA-1) ou 64 (SHA-256) chiffres
/// hexadécimaux en minuscules.
pub fn is_object_id(s: &str) -> bool {
    matches!(s.len(), 40 | 64) && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Coupe un texte à `max` octets au plus, sur une limite de caractère.
pub fn cut_bytes(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut at = max;
    while !s.is_char_boundary(at) {
        at -= 1;
    }
    &s[..at]
}

/// Longueur d'un texte une fois échappé en chaîne JSON (guillemets compris).
fn json_str_len(s: &str) -> usize {
    2 + s
        .chars()
        .map(|c| match c {
            '"' | '\\' | '\n' | '\r' | '\t' | '\u{8}' | '\u{c}' => 2,
            c if (c as u32) < 0x20 => 6,
            c => c.len_utf8(),
        })
        .sum::<usize>()
}

/// Taille estimée (par excès) d'un commit rendu en JSON.
pub fn commit_json_len(c: &Commit) -> usize {
    // Clés, ponctuation et trois compteurs.
    const OVERHEAD: usize = 200;
    OVERHEAD
        + json_str_len(&c.sha)
        + c.parents.iter().map(|p| json_str_len(p) + 1).sum::<usize>()
        + json_str_len(&c.author)
        + json_str_len(&c.date)
        + json_str_len(&c.subject)
        + json_str_len(&c.body)
}

/// Garde les premiers commits tant que leur taille JSON estimée ne dépasse
/// pas `max` ; `true` si la liste a été coupée.
pub fn fit_commits(commits: &mut Vec<Commit>, max: usize) -> bool {
    let mut total = 0;
    let keep = commits
        .iter()
        .take_while(|c| {
            total += commit_json_len(c);
            total <= max
        })
        .count();
    let cut = keep < commits.len();
    commits.truncate(keep);
    cut
}

/// Compteurs d'une entrée `--numstat` (`a\td\t…`) : `(ajouts, suppressions,
/// reste)`, `None` si le jeton n'en est pas une. `-` (binaire) vaut 0.
fn numstat_entry(token: &str) -> Option<(u64, u64, &str)> {
    let token = token.strip_prefix('\n').unwrap_or(token);
    let mut parts = token.splitn(3, '\t');
    let (a, d, rest) = (parts.next()?, parts.next()?, parts.next()?);
    let count = |s: &str| match s {
        "-" => Some(0),
        s if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) => s.parse().ok(),
        _ => None,
    };
    Some((count(a)?, count(d)?, rest))
}

/// Lit la sortie de `git log -z` au format [`LOG_FORMAT`], avec ou sans
/// `--numstat`. Second élément : la lecture s'est arrêtée sur une entrée
/// illisible (le reste est ignoré).
pub fn parse_log(out: &[u8]) -> (Vec<Commit>, bool) {
    let mut tokens = out.split(|b| *b == 0).peekable();
    let mut commits = Vec::new();
    while let Some(first) = tokens.next() {
        if first.is_empty() && tokens.peek().is_none() {
            break; // octet nul final
        }
        let mut fields: Vec<&[u8]> = Vec::with_capacity(FIELDS);
        fields.push(first);
        for _ in 1..FIELDS {
            match tokens.next() {
                Some(f) => fields.push(f),
                None => return (commits, true),
            }
        }
        let ascii = |b: &[u8]| std::str::from_utf8(b).ok().map(str::to_owned);
        let (Some(sha), Some(parents), Some(date)) =
            (ascii(fields[0]), ascii(fields[1]), ascii(fields[3]))
        else {
            return (commits, true);
        };
        let parents: Vec<String> = parents.split_whitespace().map(str::to_owned).collect();
        if !is_object_id(&sha) || !parents.iter().all(|p| is_object_id(p)) {
            return (commits, true);
        }
        let text = |b: &[u8]| String::from_utf8_lossy(b).into_owned();
        let body = text(fields[5]);
        let mut commit = Commit {
            sha,
            parents,
            author: cut_bytes(&text(fields[2]), MAX_AUTHOR_BYTES).to_owned(),
            author_email: cut_bytes(&text(fields[6]), MAX_AUTHOR_BYTES).to_owned(),
            date,
            subject: cut_bytes(&text(fields[4]), MAX_SUBJECT_BYTES).to_owned(),
            body: cut_bytes(body.trim_end(), MAX_BODY_BYTES).to_owned(),
            files: 0,
            additions: 0,
            deletions: 0,
        };
        // Compteurs : entrées `--numstat` jusqu'au commit suivant (un sha
        // n'a jamais de tabulation).
        while let Some(next) = tokens.peek() {
            let Some((a, d, rest)) = std::str::from_utf8(next).ok().and_then(numstat_entry) else {
                break;
            };
            tokens.next();
            if rest.is_empty() {
                // Renommage : ancien et nouveau chemin suivent.
                tokens.next();
                tokens.next();
            }
            commit.files += 1;
            commit.additions += a;
            commit.deletions += d;
        }
        commits.push(commit);
    }
    (commits, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sha(c: char) -> String {
        c.to_string().repeat(40)
    }

    /// Un en-tête au format [`LOG_FORMAT`].
    fn header(sha: &str, parents: &[&str], author: &str, subject: &str, body: &str) -> Vec<u8> {
        format!(
            "{sha}\0{}\0{author}\x002026-10-20T15:15:38+02:00\0{subject}\0{body}\0a@exemple.fr\0",
            parents.join(" ")
        )
        .into_bytes()
    }

    #[test]
    fn parses_real_git_output_with_merge_root_rename_binary_and_empty_commit() {
        // Sortie réelle de git 2.53 (`git log -z <LOG_FORMAT> --numstat
        // --diff-merges=first-parent -M --root`), shas raccourcis en lettres.
        let (m, s, v, r, n, j) = (sha('a'), sha('b'), sha('c'), sha('d'), sha('e'), sha('f'));
        let mut out = Vec::new();
        out.extend(header(&m, &[&s, &v], "Élodie", "Merge branch 'f'", ""));
        out.extend_from_slice(b"\n1\t1\t\0a.txt\0b.txt\0-\t-\tbin.dat\0");
        out.extend(header(&s, &[&r], "Élodie", "surmain", ""));
        out.extend_from_slice(b"\n1\t0\tm.txt\0");
        // Commit vide : aucun compteur.
        out.extend(header(&v, &[&n], "Élodie", "vide", ""));
        out.extend(header(&n, &[&j], "Élodie", "renommage", ""));
        out.extend_from_slice(b"\n0\t0\t\0a.txt\0b.txt\0");
        // Corps multiligne avec une ligne qui ressemble à des compteurs, des
        // tabulations et des caractères spéciaux.
        out.extend(header(
            &j,
            &[&r],
            "O'Brien <pas une adresse>",
            "Sujet un suite du sujet",
            "Corps ligne 1\n 3 files changed, 1 insertion(+)\n1\t2\tfaux.txt\n\n`fin` « é » \x1b[0m\n",
        ));
        out.extend_from_slice(b"\n1\t1\ta.txt\0-\t-\tbin.dat\0");
        // Commit racine : pas de parent.
        out.extend(header(&r, &[], "Élodie", "racine", ""));
        out.extend_from_slice(b"\n8\t0\ta.txt\0");
        let (commits, stopped) = parse_log(&out);
        assert!(!stopped);
        assert_eq!(commits.len(), 6);
        let merge = &commits[0];
        assert_eq!(merge.parents, [s.clone(), v.clone()]);
        assert_eq!(merge.first_parent(), Some(s.as_str()));
        assert_eq!(
            (merge.files, merge.additions, merge.deletions),
            (2, 1, 1),
            "fusion : contre le premier parent"
        );
        assert_eq!(merge.subject, "Merge branch 'f'");
        assert_eq!(merge.body, "");
        assert_eq!(merge.author, "Élodie");
        assert_eq!(merge.date, "2026-10-20T15:15:38+02:00");
        assert_eq!((commits[2].files, commits[2].additions), (0, 0));
        assert_eq!((commits[3].files, commits[3].additions), (1, 0));
        let multi = &commits[4];
        assert_eq!(
            multi.body,
            "Corps ligne 1\n 3 files changed, 1 insertion(+)\n1\t2\tfaux.txt\n\n`fin` « é » \x1b[0m"
        );
        assert_eq!(multi.author, "O'Brien <pas une adresse>");
        assert_eq!((multi.files, multi.additions, multi.deletions), (2, 1, 1));
        let root = &commits[5];
        assert!(root.parents.is_empty() && root.first_parent().is_none());
        assert_eq!((root.files, root.additions), (1, 8));
        assert_eq!(root.short(), "ddddddd");
    }

    #[test]
    fn parses_without_stats_and_stops_on_garbage() {
        let (a, b) = (sha('1'), sha('2'));
        let mut out = header(&a, &[&b], "x", "un", "corps");
        out.extend(header(&b, &[], "y", "deux", ""));
        let (commits, stopped) = parse_log(&out);
        assert!(!stopped);
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].body, "corps");
        assert_eq!(commits[0].author_email, "a@exemple.fr");
        assert!(parse_log(b"").0.is_empty());
        // Sortie coupée au milieu d'un en-tête.
        let cut = &out[..out.len() - 20];
        let (commits, stopped) = parse_log(cut);
        assert_eq!((commits.len(), stopped), (1, true));
        // Sha mal formé.
        let (commits, stopped) = parse_log(b"zz\0z\0\0x\0d\0s\0b\0");
        assert!(commits.is_empty() && stopped);
        // SHA-256 accepté.
        let long = "a".repeat(64);
        assert_eq!(parse_log(&header(&long, &[], "x", "s", "")).0.len(), 1);
        // Message non UTF-8 : remplacé, jamais d'erreur.
        let mut bad = header(&a, &[], "x", "s", "");
        // Avant l'octet nul qui suit le corps (l'adresse vient ensuite).
        let at = bad.len() - "\0a@exemple.fr\0".len();
        bad.splice(at..at, b"\xff".iter().copied());
        assert_eq!(parse_log(&bad).0[0].body, "\u{fffd}");
    }

    #[test]
    fn body_is_cut_on_a_character() {
        let body = "é".repeat(MAX_BODY_BYTES); // 2 octets chacun
        let out = header(&sha('3'), &[], "x", "s", &body);
        let c = &parse_log(&out).0[0];
        assert_eq!(c.body.len(), MAX_BODY_BYTES);
        assert_eq!(cut_bytes("aé", 2), "a");
        assert_eq!(cut_bytes("abc", 10), "abc");
    }

    #[test]
    fn subject_and_author_are_bounded() {
        let out = header(
            &sha('4'),
            &[],
            &"é".repeat(MAX_AUTHOR_BYTES),
            &"ü".repeat(MAX_SUBJECT_BYTES),
            "",
        );
        let c = &parse_log(&out).0[0];
        assert_eq!(c.author.len(), MAX_AUTHOR_BYTES);
        assert_eq!(c.subject.len(), MAX_SUBJECT_BYTES);
        assert!(c.subject.chars().all(|ch| ch == 'ü'));
    }

    #[test]
    fn response_size_is_bounded() {
        let one = |c: char| Commit {
            sha: sha(c),
            parents: vec![sha('0')],
            author: "a".into(),
            author_email: "a@exemple.fr".into(),
            date: "2026-10-20T15:15:38+02:00".into(),
            subject: "s".into(),
            // Caractères de contrôle : 6 octets chacun une fois échappés.
            body: "\x1b".repeat(1000),
            files: 1,
            additions: 2,
            deletions: 3,
        };
        let c = one('1');
        // Estimation par excès de la sérialisation réelle.
        let real = serde_json::to_string(&serde_json::json!({
            "sha": c.sha, "parents": c.parents, "author": c.author, "date": c.date,
            "subject": c.subject, "body": c.body, "files": c.files,
            "additions": c.additions, "deletions": c.deletions,
        }))
        .unwrap()
        .len();
        let est = commit_json_len(&c);
        assert!(est >= real && est < real + 300, "{est} / {real}");
        let mut v = vec![one('1'), one('2'), one('3')];
        assert!(!fit_commits(&mut v, 3 * est));
        assert_eq!(v.len(), 3);
        assert!(fit_commits(&mut v, 2 * est + 10));
        assert_eq!(v.len(), 2);
        assert!(fit_commits(&mut v, 1));
        assert!(v.is_empty());
        assert_eq!(json_str_len("a\"\n\x01é"), 2 + 1 + 2 + 2 + 6 + 2);
    }

    #[test]
    fn automatic_range() {
        let (a, b) = (sha('a'), sha('b'));
        assert_eq!(CommitRange::resolve(None, &a, &a), CommitRange::Recent);
        assert_eq!(CommitRange::resolve(None, &a, &b), CommitRange::Branch);
        let forced = Some(CommitRange::Branch);
        assert_eq!(CommitRange::resolve(forced, &a, &a), CommitRange::Branch);
        let forced = Some(CommitRange::Recent);
        assert_eq!(CommitRange::resolve(forced, &a, &b), CommitRange::Recent);
        assert_eq!(CommitRange::parse("recent"), Some(CommitRange::Recent));
        assert_eq!(CommitRange::parse("branch"), Some(CommitRange::Branch));
        assert_eq!(CommitRange::parse("tout"), None);
    }

    #[test]
    fn object_ids() {
        assert!(is_object_id(&sha('a')));
        assert!(is_object_id(&"0".repeat(64)));
        assert!(!is_object_id(&"A".repeat(40)));
        assert!(!is_object_id("HEAD"));
        assert!(!is_object_id(&"a".repeat(39)));
        assert!(!is_object_id(&format!("{}^", "a".repeat(39))));
        assert_eq!(short_sha("abc"), "abc");
    }
}
