//! Diff d'une session (v0.2, lot 1) : fichiers changés depuis la base de la
//! branche, diff ligne à ligne, et revue envoyée à Claude.
//!
//! Ce module est pur : il lit les sorties de `git` (`--name-status -z`,
//! `--numstat -z`, diff unifié) et met en forme la revue. L'appel à `git` est
//! dans l'adaptateur `adapters::git_diff`.

/// Taille maximale d'un fichier (de chaque côté) dont le diff est montré.
pub const MAX_FILE_BYTES: u64 = 1024 * 1024;
/// Nombre maximal de lignes d'un diff de fichier montré.
pub const MAX_DIFF_LINES: usize = 20_000;
/// Octets lus au début d'un fichier pour décider s'il est binaire (comme
/// git : un octet nul dans les 8 000 premiers).
pub const BINARY_SNIFF_BYTES: usize = 8000;

/// Comment la base a été choisie.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BaseKind {
    /// Point de départ de la branche par rapport à la branche par défaut.
    MergeBase,
    /// `HEAD` (pas de branche par défaut trouvée, ou pas d'ancêtre commun).
    Head,
}

impl BaseKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::MergeBase => "merge_base",
            Self::Head => "head",
        }
    }
}

/// Base du diff.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffBase {
    /// Référence comparée (`origin/main`, `main`, `HEAD`).
    pub reference: String,
    /// Commit de base (ou arbre vide pour un dépôt sans commit).
    pub sha: String,
    pub kind: BaseKind,
}

/// Statut d'un fichier changé.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Untracked,
}

impl FileStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Added => "A",
            Self::Modified => "M",
            Self::Deleted => "D",
            Self::Renamed => "R",
            Self::Untracked => "?",
        }
    }
}

/// Un fichier changé.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangedFile {
    /// Chemin relatif à la racine du worktree (nouveau nom pour un renommage).
    pub path: String,
    /// Ancien nom, pour un renommage.
    pub old_path: Option<String>,
    pub status: FileStatus,
    /// Lignes ajoutées ; `None` pour un fichier non suivi dont les lignes
    /// n'ont pas été comptées (au-delà des [`MAX_COUNTED_UNTRACKED`] plus
    /// récents, ou plus de 1 Mio).
    pub additions: Option<u64>,
    pub deletions: u64,
    pub binary: bool,
    /// Taille et date de modification (ns) du fichier de l'arbre de
    /// travail, s'il existe : pour l'empreinte (un contenu change sans que
    /// les compteurs changent).
    pub stamp: Option<(u64, i128)>,
}

/// Fichiers non suivis dont les lignes sont comptées (les plus récents).
pub const MAX_COUNTED_UNTRACKED: usize = 200;

/// Fichiers changés depuis une base.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangeSet {
    /// Racine du worktree.
    pub root: std::path::PathBuf,
    pub base: DiffBase,
    /// `HEAD` (absent avant le premier commit).
    pub head: Option<String>,
    pub files: Vec<ChangedFile>,
    /// Liste incomplète : sortie de `git` trop longue ou trop de fichiers
    /// non suivis.
    pub truncated: bool,
    /// Fichiers écartés parce que leur chemin n'est pas de l'UTF-8.
    pub skipped_non_utf8: usize,
}

impl ChangeSet {
    /// Empreinte bon marché pour `session.diff_changed` : base, `HEAD`,
    /// statuts, chemins, compteurs, et taille et date de modification de
    /// chaque fichier (un contenu peut changer à compteurs égaux).
    pub fn fingerprint(&self) -> String {
        let mut s = format!(
            "{}\t{}\t{}\n",
            self.base.sha,
            self.head.as_deref().unwrap_or(""),
            self.truncated
        );
        for f in &self.files {
            s.push_str(&format!(
                "{}\t{}\t{}\t{:?}\t{}\t{}\t{:?}\n",
                f.status.as_str(),
                f.path,
                f.old_path.as_deref().unwrap_or(""),
                f.additions,
                f.deletions,
                f.binary,
                f.stamp
            ));
        }
        s
    }

    pub fn file(&self, path: &str) -> Option<&ChangedFile> {
        self.files.iter().find(|f| f.path == path)
    }
}

/// Lit `git diff --name-status -z -M` : `(statut, ancien chemin, chemin)`.
/// Les copies et changements de type comptent comme ajout et modification.
///
/// Un chemin qui n'est pas de l'UTF-8 écarte son entrée (comptée dans le
/// second élément) plutôt que de produire un chemin faux.
pub fn parse_name_status(out: &[u8]) -> (Vec<(FileStatus, Option<String>, String)>, usize) {
    let mut fields = out
        .split(|b| *b == 0)
        .map(|f| String::from_utf8(f.to_vec()).ok());
    let mut v = Vec::new();
    let mut skipped = 0;
    while let Some(code) = fields.next() {
        let Some(code) = code.filter(|c| !c.is_empty()) else {
            continue;
        };
        let status = match code.chars().next() {
            Some('A') | Some('C') => FileStatus::Added,
            Some('D') => FileStatus::Deleted,
            Some('R') => FileStatus::Renamed,
            _ => FileStatus::Modified,
        };
        if matches!(code.chars().next(), Some('R') | Some('C')) {
            let (Some(old), Some(new)) = (fields.next(), fields.next()) else {
                break;
            };
            let (Some(old), Some(new)) = (old, new) else {
                skipped += 1;
                continue;
            };
            let old = (status == FileStatus::Renamed).then_some(old);
            v.push((status, old, new));
        } else {
            let Some(path) = fields.next() else { break };
            match path {
                Some(path) => v.push((status, None, path)),
                None => skipped += 1,
            }
        }
    }
    (v, skipped)
}

/// Lit `git diff --numstat -z -M` : `(chemin, ajouts, suppressions)`,
/// `None` pour un fichier binaire.
pub fn parse_numstat(out: &[u8]) -> Vec<(String, Option<(u64, u64)>)> {
    let mut fields = out.split(|b| *b == 0);
    let mut v = Vec::new();
    while let Some(head) = fields.next() {
        if head.is_empty() {
            continue;
        }
        // Chemin non UTF-8 : écarté (déjà compté par `parse_name_status`).
        let Ok(head) = std::str::from_utf8(head) else {
            continue;
        };
        let mut parts = head.splitn(3, '\t');
        let (Some(a), Some(d), Some(path)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        let counts = a.parse().ok().zip(d.parse().ok());
        let path = if path.is_empty() {
            // Renommage : `a\td\t\0ancien\0nouveau\0`.
            let _old = fields.next();
            match fields.next() {
                Some(new) => match std::str::from_utf8(new) {
                    Ok(p) => p.to_owned(),
                    Err(_) => continue,
                },
                None => break,
            }
        } else {
            path.to_owned()
        };
        v.push((path, counts));
    }
    v
}

/// Assemble les fichiers suivis (statuts + compteurs) ; second élément :
/// entrées écartées (chemin non UTF-8).
pub fn tracked_files(name_status: &[u8], numstat: &[u8]) -> (Vec<ChangedFile>, usize) {
    let counts: std::collections::HashMap<String, Option<(u64, u64)>> =
        parse_numstat(numstat).into_iter().collect();
    let (entries, skipped) = parse_name_status(name_status);
    let files = entries
        .into_iter()
        .map(|(status, old_path, path)| {
            let c = counts.get(&path).copied().flatten();
            ChangedFile {
                binary: counts.get(&path).is_some_and(Option::is_none),
                additions: Some(c.map_or(0, |c| c.0)),
                deletions: c.map_or(0, |c| c.1),
                path,
                old_path,
                status,
                stamp: None,
            }
        })
        .collect();
    (files, skipped)
}

/// Contenu binaire ? (octet nul au début, comme git.)
pub fn looks_binary(bytes: &[u8]) -> bool {
    bytes[..bytes.len().min(BINARY_SNIFF_BYTES)].contains(&0)
}

/// Une ligne de diff.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffLine {
    /// `' '`, `'+'` ou `'-'`.
    pub kind: char,
    pub old_no: Option<u32>,
    pub new_no: Option<u32>,
    pub text: String,
}

/// Un bloc de diff.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hunk {
    pub header: String,
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub lines: Vec<DiffLine>,
}

/// Diff d'un fichier.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FileDiff {
    pub hunks: Vec<Hunk>,
    pub binary: bool,
    pub too_large: bool,
}

impl FileDiff {
    pub fn binary() -> Self {
        Self {
            binary: true,
            ..Self::default()
        }
    }
    pub fn too_large() -> Self {
        Self {
            too_large: true,
            ..Self::default()
        }
    }
}

/// `-12,3` ou `+5` d'un en-tête de bloc.
fn range(s: &str) -> Option<(u32, u32)> {
    let s = &s[1..];
    match s.split_once(',') {
        Some((a, b)) => Some((a.parse().ok()?, b.parse().ok()?)),
        None => Some((s.parse().ok()?, 1)),
    }
}

/// Lit un diff unifié (`git diff -U3 … -- <fichier>`). Au-delà de
/// [`MAX_DIFF_LINES`] lignes : `too_large`. `Binary files … differ` :
/// `binary`.
pub fn parse_unified(out: &[u8]) -> FileDiff {
    let text = String::from_utf8_lossy(out);
    let mut diff = FileDiff::default();
    let mut count = 0usize;
    let (mut old_no, mut new_no) = (0u32, 0u32);
    for line in text.split('\n') {
        if let Some(rest) = line.strip_prefix("@@ ") {
            let mut parts = rest.split(' ');
            let (Some(o), Some(n)) = (parts.next(), parts.next()) else {
                continue;
            };
            let (Some((os, ol)), Some((ns, nl))) = (range(o), range(n)) else {
                continue;
            };
            old_no = os;
            new_no = ns;
            diff.hunks.push(Hunk {
                header: line.to_owned(),
                old_start: os,
                old_lines: ol,
                new_start: ns,
                new_lines: nl,
                lines: Vec::new(),
            });
            continue;
        }
        if line.starts_with("Binary files ") || line == "GIT binary patch" {
            return FileDiff::binary();
        }
        let Some(hunk) = diff.hunks.last_mut() else {
            continue; // en-têtes `diff --git`, `index`, `---`, `+++`
        };
        let (kind, body) = match line.chars().next() {
            Some(c @ (' ' | '+' | '-')) => (c, &line[1..]),
            Some('\\') => continue, // « \ No newline at end of file »
            _ => continue,
        };
        count += 1;
        if count > MAX_DIFF_LINES {
            return FileDiff::too_large();
        }
        let (o, n) = match kind {
            '+' => {
                new_no += 1;
                (None, Some(new_no - 1))
            }
            '-' => {
                old_no += 1;
                (Some(old_no - 1), None)
            }
            _ => {
                old_no += 1;
                new_no += 1;
                (Some(old_no - 1), Some(new_no - 1))
            }
        };
        hunk.lines.push(DiffLine {
            kind,
            old_no: o,
            new_no: n,
            text: body.trim_end_matches('\r').to_owned(),
        });
    }
    diff
}

/// Diff d'un fichier non suivi : tout est ajouté.
pub fn untracked_diff(content: &[u8]) -> FileDiff {
    if looks_binary(content) {
        return FileDiff::binary();
    }
    let text = String::from_utf8_lossy(content);
    let mut lines: Vec<&str> = text.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    if lines.len() > MAX_DIFF_LINES {
        return FileDiff::too_large();
    }
    if lines.is_empty() {
        return FileDiff::default();
    }
    let n = lines.len() as u32;
    FileDiff {
        hunks: vec![Hunk {
            header: format!("@@ -0,0 +1,{n} @@"),
            old_start: 0,
            old_lines: 0,
            new_start: 1,
            new_lines: n,
            lines: lines
                .iter()
                .enumerate()
                .map(|(i, l)| DiffLine {
                    kind: '+',
                    old_no: None,
                    new_no: Some(i as u32 + 1),
                    text: l.trim_end_matches('\r').to_owned(),
                })
                .collect(),
        }],
        ..FileDiff::default()
    }
}

/// Nombre de lignes d'un fichier non suivi (ajouts), 0 s'il est binaire.
pub fn count_lines(content: &[u8]) -> u64 {
    if looks_binary(content) {
        return 0;
    }
    let n = content.iter().filter(|b| **b == b'\n').count() as u64;
    n + u64::from(!content.is_empty() && !content.ends_with(b"\n"))
}

// ------------------------------------------------------------------ revue

/// Limites d'une revue.
pub const MAX_REVIEW_COMMENTS: usize = 200;
pub const MAX_REVIEW_TEXT_CHARS: usize = 4000;
/// Lignes de contexte autour de la ligne commentée dans l'extrait.
pub const EXCERPT_CONTEXT: usize = 2;

/// Consigne tapée avant la revue collée (architecture § 9 : seul le contenu
/// est collé, la consigne est tapée).
pub const REVIEW_INSTRUCTION: &str =
    "Voici ma revue de tes changements, applique-la puis dis-moi ce que tu as fait : ";

/// Côté de la ligne commentée.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    New,
    Old,
}

/// Un commentaire de revue.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewComment {
    pub path: String,
    pub line: u32,
    pub side: Side,
    pub text: String,
}

/// Retire les caractères de contrôle (sauf saut de ligne et tabulation) :
/// rien de ce qui est collé ne peut sortir du collage encadré
/// (`ESC [ 201 ~`) ni taper de touches.
pub fn sanitize(text: &str) -> String {
    text.chars()
        .filter(|c| *c == '\n' || *c == '\t' || !c.is_control())
        .collect()
}

/// Extrait de ±[`EXCERPT_CONTEXT`] lignes autour de la ligne commentée, pris
/// dans le diff du fichier (`None` si la ligne n'y est pas).
pub fn excerpt(diff: &FileDiff, line: u32, side: Side) -> Option<Vec<DiffLine>> {
    for h in &diff.hunks {
        let at = h.lines.iter().position(|l| match side {
            Side::New => l.new_no == Some(line),
            Side::Old => l.old_no == Some(line),
        });
        if let Some(i) = at {
            let from = i.saturating_sub(EXCERPT_CONTEXT);
            let to = (i + EXCERPT_CONTEXT + 1).min(h.lines.len());
            return Some(h.lines[from..to].to_vec());
        }
    }
    None
}

/// Clôture de bloc de code plus longue que toute suite de « ` » du contenu.
fn fence(content: &str) -> String {
    let mut longest = 0;
    let mut run = 0;
    for c in content.chars() {
        if c == '`' {
            run += 1;
            longest = longest.max(run);
        } else {
            run = 0;
        }
    }
    "`".repeat((longest + 1).max(3))
}

/// Revue en Markdown (contenu collé) : remarque générale, puis par
/// commentaire `### <chemin>:<ligne>`, l'extrait du diff et le commentaire.
/// `excerpts[i]` : extrait du commentaire `i`, s'il y en a un.
pub fn format_review(
    general: Option<&str>,
    comments: &[ReviewComment],
    excerpts: &[Option<Vec<DiffLine>>],
) -> String {
    let mut out = String::from("# Revue de code\n");
    if let Some(g) = general.map(sanitize).filter(|g| !g.trim().is_empty()) {
        out.push_str(&format!("\n{}\n", g.trim()));
    }
    for (i, c) in comments.iter().enumerate() {
        let side = match c.side {
            Side::New => "",
            Side::Old => " (ancienne version)",
        };
        out.push_str(&format!("\n### {}:{}{side}\n", sanitize(&c.path), c.line));
        if let Some(Some(lines)) = excerpts.get(i) {
            let body: String = lines
                .iter()
                .map(|l| {
                    let no = match c.side {
                        Side::New => l.new_no.or(l.old_no),
                        Side::Old => l.old_no.or(l.new_no),
                    };
                    let mark = if l.kind == ' ' { ' ' } else { l.kind };
                    format!(
                        "{mark}{:>5} | {}\n",
                        no.map(|n| n.to_string()).unwrap_or_default(),
                        sanitize(&l.text)
                    )
                })
                .collect();
            let f = fence(&body);
            out.push_str(&format!("\n{f}diff\n{body}{f}\n"));
        }
        out.push_str(&format!("\n{}\n", sanitize(c.text.trim())));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_name_status_and_numstat_with_renames() {
        let ns = b"M\0src/a.rs\0R087\0vieux.rs\0neuf.rs\0A\0nouveau\0D\0parti\0T\0lien\0";
        let num = b"3\t1\tsrc/a.rs\0" as &[u8];
        let mut num = num.to_vec();
        num.extend_from_slice(b"2\t2\t\0vieux.rs\0neuf.rs\0-\t-\tnouveau\x000\t4\tparti\0");
        let (files, skipped) = tracked_files(ns, &num);
        assert_eq!((files.len(), skipped), (5, 0));
        assert_eq!(
            files[0],
            ChangedFile {
                path: "src/a.rs".into(),
                old_path: None,
                status: FileStatus::Modified,
                additions: Some(3),
                deletions: 1,
                binary: false,
                stamp: None,
            }
        );
        assert_eq!(files[1].status, FileStatus::Renamed);
        assert_eq!(files[1].old_path.as_deref(), Some("vieux.rs"));
        assert_eq!((files[1].additions, files[1].deletions), (Some(2), 2));
        assert!(files[2].binary && files[2].status == FileStatus::Added);
        assert_eq!(files[3].status, FileStatus::Deleted);
        assert_eq!(files[4].status, FileStatus::Modified);
        assert!(parse_name_status(b"").0.is_empty());
        // Chemins non UTF-8 : écartés et comptés, jamais déformés.
        let (files, skipped) = tracked_files(
            b"M\0ok.rs\0M\0mauvais\xff.rs\0R100\0a\xfe\0b\0",
            b"1\t0\tok.rs\x001\t0\tmauvais\xff.rs\0",
        );
        assert_eq!(skipped, 2);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "ok.rs");
    }

    #[test]
    fn parses_unified_diff_with_line_numbers() {
        let out = b"diff --git a/f b/f\nindex 1..2 100644\n--- a/f\n+++ b/f\n@@ -1,3 +1,4 @@ fn x()\n un\n-deux\n+DEUX\n+deux bis\n trois\n\\ No newline at end of file\n@@ -10 +11 @@\n-a\n+b\n";
        let d = parse_unified(out);
        assert!(!d.binary && !d.too_large);
        assert_eq!(d.hunks.len(), 2);
        let h = &d.hunks[0];
        assert_eq!(
            (h.old_start, h.old_lines, h.new_start, h.new_lines),
            (1, 3, 1, 4)
        );
        assert_eq!(h.header, "@@ -1,3 +1,4 @@ fn x()");
        let nos: Vec<_> = h
            .lines
            .iter()
            .map(|l| (l.kind, l.old_no, l.new_no))
            .collect();
        assert_eq!(
            nos,
            [
                (' ', Some(1), Some(1)),
                ('-', Some(2), None),
                ('+', None, Some(2)),
                ('+', None, Some(3)),
                (' ', Some(3), Some(4)),
            ]
        );
        assert_eq!(d.hunks[1].old_lines, 1);
        assert_eq!(d.hunks[1].lines[1].new_no, Some(11));
        assert!(parse_unified(b"diff --git a/x b/x\nBinary files a/x and b/x differ\n").binary);
        let mut big = b"@@ -1,0 +1,30000 @@\n".to_vec();
        for _ in 0..(MAX_DIFF_LINES + 1) {
            big.extend_from_slice(b"+x\n");
        }
        assert!(parse_unified(&big).too_large);
    }

    #[test]
    fn untracked_files() {
        let d = untracked_diff(b"a\nb\n");
        assert_eq!(d.hunks[0].header, "@@ -0,0 +1,2 @@");
        assert_eq!(d.hunks[0].lines[1].new_no, Some(2));
        assert!(untracked_diff(b"\0\x01").binary);
        assert!(untracked_diff(b"").hunks.is_empty());
        assert_eq!(count_lines(b"a\nb"), 2);
        assert_eq!(count_lines(b"a\nb\n"), 2);
        assert_eq!(count_lines(b""), 0);
        assert_eq!(count_lines(b"\0"), 0);
    }

    #[test]
    fn review_is_markdown_and_cannot_escape_the_paste() {
        let d = parse_unified(b"@@ -1,5 +1,6 @@\n a\n b\n c\n+d\n e\n f\n");
        let ex = excerpt(&d, 4, Side::New).unwrap();
        assert_eq!(ex.len(), 5);
        assert_eq!(ex[2].text, "d");
        assert!(excerpt(&d, 99, Side::New).is_none());
        assert_eq!(excerpt(&d, 1, Side::Old).unwrap().len(), 3);
        let comments = vec![
            ReviewComment {
                path: "src/a.rs".into(),
                line: 4,
                side: Side::New,
                text: "Nom peu clair\x1b[201~\rrm -rf /\n".into(),
            },
            ReviewComment {
                path: "b.md".into(),
                line: 2,
                side: Side::Old,
                text: "Pourquoi supprimer ?".into(),
            },
        ];
        let md = format_review(Some("Bien dans l'ensemble."), &comments, &[Some(ex), None]);
        assert!(
            md.starts_with("# Revue de code\n\nBien dans l'ensemble.\n"),
            "{md}"
        );
        assert!(md.contains("### src/a.rs:4\n"), "{md}");
        assert!(md.contains("+    4 | d\n"), "{md}");
        assert!(md.contains("```diff\n"), "{md}");
        assert!(
            md.contains("### b.md:2 (ancienne version)\n\nPourquoi supprimer ?"),
            "{md}"
        );
        assert!(!md.contains('\x1b') && !md.contains('\r'), "{md:?}");
        assert!(md.contains("Nom peu clair[201~rm -rf /"));
        // Clôture plus longue que le contenu.
        assert_eq!(fence("a ``` b"), "````");
        assert_eq!(fence("rien"), "```");
    }
}
