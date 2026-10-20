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

/// Lignes au plus d'un commentaire de fichier (v0.2, lot 3 bis).
pub const MAX_FILE_EXCERPT_LINES: u32 = 400;

/// Consigne tapée quand la revue ne contient que des extraits de fichiers.
pub const FILE_EXCERPT_INSTRUCTION: &str = "Voici des extraits de fichiers avec mes remarques, tiens-en compte puis dis-moi ce que tu as fait : ";

/// Un commentaire sur des lignes d'un fichier (onglet Fichiers).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileComment {
    /// Chemin relatif à la racine, normalisé.
    pub path: String,
    pub line: u32,
    pub line_end: u32,
    /// Commentaire, éventuellement vide (il est facultatif).
    pub text: String,
}

/// Plage de lignes d'un commentaire de fichier : `line ≥ 1`,
/// `line_end ≥ line`, au plus [`MAX_FILE_EXCERPT_LINES`] lignes.
pub fn validate_file_range(line: u64, line_end: u64) -> Result<(), String> {
    if line == 0 || line > u64::from(u32::MAX) {
        return Err("« line » : entier positif attendu".into());
    }
    if line_end < line || line_end > u64::from(u32::MAX) {
        return Err("« line_end » : entier supérieur ou égal à « line » attendu".into());
    }
    let n = line_end - line + 1;
    if n > u64::from(MAX_FILE_EXCERPT_LINES) {
        return Err(format!(
            "{n} lignes sélectionnées, {MAX_FILE_EXCERPT_LINES} au plus"
        ));
    }
    Ok(())
}

/// Nombre de lignes d'un texte, compté comme dans le diff (un `\n` final
/// ne crée pas de ligne vide de plus).
pub fn line_count(content: &str) -> usize {
    let n = content.split('\n').count();
    if content.is_empty() {
        0
    } else if content.ends_with('\n') {
        n - 1
    } else {
        n
    }
}

/// Lignes `line..=line_end` (numérotées à partir de 1, sans `\r` final) d'un
/// texte ; `None` si la plage dépasse la fin du texte.
pub fn file_excerpt(content: &str, line: u32, line_end: u32) -> Option<Vec<(u32, String)>> {
    if line == 0 || line_end < line || line_end as usize > line_count(content) {
        return None;
    }
    Some(
        content
            .split('\n')
            .enumerate()
            .skip(line as usize - 1)
            .take((line_end - line + 1) as usize)
            .map(|(i, l)| (i as u32 + 1, l.trim_end_matches('\r').to_owned()))
            .collect(),
    )
}

/// Étiquette de langage du bloc de code, d'après l'extension du fichier.
pub fn language_for(path: &str) -> Option<&'static str> {
    let name = path.rsplit('/').next().unwrap_or(path);
    let (stem, ext) = name.rsplit_once('.')?;
    if stem.is_empty() {
        return None; // `.bashrc` : pas d'extension
    }
    Some(match ext.to_ascii_lowercase().as_str() {
        "rs" => "rust",
        "ts" | "tsx" => "typescript",
        "js" | "jsx" | "mjs" => "javascript",
        "json" => "json",
        "toml" => "toml",
        "yaml" | "yml" => "yaml",
        "sh" | "bash" => "bash",
        "py" => "python",
        "go" => "go",
        "sql" => "sql",
        "css" => "css",
        "html" => "html",
        "md" => "markdown",
        _ => return None,
    })
}

/// Un élément de la revue collée, dans l'ordre reçu.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReviewEntry {
    /// Commentaire de diff et son extrait (absent si la ligne n'est pas
    /// dans le diff).
    Diff(ReviewComment, Option<Vec<DiffLine>>),
    /// Commentaire de fichier et ses lignes `(numéro, texte)`, relues par
    /// le démon.
    File(FileComment, Vec<(u32, String)>),
}

/// Consigne tapée avant la revue : celle des extraits de fichiers si la
/// revue n'a que des commentaires de fichier, sinon celle de la revue (au
/// moins un commentaire de diff, ou seulement la remarque générale).
pub fn review_instruction(any_diff: bool, any_file: bool) -> &'static str {
    if any_file && !any_diff {
        FILE_EXCERPT_INSTRUCTION
    } else {
        REVIEW_INSTRUCTION
    }
}

/// Taille maximale du texte collé d'une revue (octets UTF-8).
pub const MAX_REVIEW_BYTES: usize = 256 * 1024;
/// Caractères au plus par ligne d'extrait collée (au-delà : coupée, « … »).
pub const MAX_EXCERPT_LINE_CHARS: usize = 2000;

/// [`sanitize`] pour un texte d'une seule ligne (chemin d'un en-tête) : un
/// saut de ligne ou une tabulation d'un nom de fichier devient un symbole
/// visible (« ␤ », « ␉ ») et ne peut pas injecter de Markdown dans la revue.
pub fn sanitize_inline(text: &str) -> String {
    sanitize(text)
        .chars()
        .map(|c| match c {
            '\n' => '␤',
            '\t' => '␉',
            c => c,
        })
        .collect()
}

/// Ligne d'extrait nettoyée et coupée à [`MAX_EXCERPT_LINE_CHARS`]
/// caractères (« … » ajouté).
fn excerpt_line(text: &str) -> String {
    let clean = sanitize(text);
    match clean.char_indices().nth(MAX_EXCERPT_LINE_CHARS) {
        Some((at, _)) => format!("{}…", &clean[..at]),
        None => clean,
    }
}

/// En-tête de la revue collée : titre et remarque générale.
pub fn format_review_head(general: Option<&str>) -> String {
    let mut out = String::from("# Revue de code\n");
    if let Some(g) = general.map(sanitize).filter(|g| !g.trim().is_empty()) {
        out.push_str(&format!("\n{}\n", g.trim()));
    }
    out
}

/// Un élément de la revue collée (voir [`format_review`]).
pub fn format_entry(entry: &ReviewEntry) -> String {
    let mut out = String::new();
    match entry {
        ReviewEntry::Diff(c, excerpt) => {
            let side = match c.side {
                Side::New => "",
                Side::Old => " (ancienne version)",
            };
            out.push_str(&format!(
                "\n### {}:{}{side}\n",
                sanitize_inline(&c.path),
                c.line
            ));
            if let Some(lines) = excerpt {
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
                            excerpt_line(&l.text)
                        )
                    })
                    .collect();
                let f = fence(&body);
                out.push_str(&format!("\n{f}diff\n{body}{f}\n"));
            }
            out.push_str(&format!("\n{}\n", sanitize(c.text.trim())));
        }
        ReviewEntry::File(c, lines) => {
            let range = if c.line_end > c.line {
                format!("{}-{}", c.line, c.line_end)
            } else {
                c.line.to_string()
            };
            out.push_str(&format!("\n### {}:{range}\n", sanitize_inline(&c.path)));
            let body: String = lines
                .iter()
                .map(|(no, text)| format!(" {no:>5} | {}\n", excerpt_line(text)))
                .collect();
            let f = fence(&body);
            let lang = language_for(&c.path).unwrap_or("");
            out.push_str(&format!("\n{f}{lang}\n{body}{f}\n"));
            let text = sanitize(c.text.trim());
            if !text.trim().is_empty() {
                out.push_str(&format!("\n{}\n", text.trim()));
            }
        }
    }
    out
}

/// Revue collée en construction, bornée à [`MAX_REVIEW_BYTES`] : au-delà,
/// les éléments ne sont plus gardés, seulement comptés (taille exacte pour
/// l'erreur, mémoire bornée).
#[derive(Debug, Clone)]
pub struct ReviewBuilder {
    out: String,
    total: usize,
}

impl ReviewBuilder {
    pub fn new(general: Option<&str>) -> Self {
        let out = format_review_head(general);
        Self {
            total: out.len(),
            out,
        }
    }

    pub fn push(&mut self, entry: &ReviewEntry) {
        let piece = format_entry(entry);
        self.total += piece.len();
        if self.total <= MAX_REVIEW_BYTES {
            self.out.push_str(&piece);
        }
    }

    /// Le texte à coller, ou sa taille totale (octets) s'il dépasse
    /// [`MAX_REVIEW_BYTES`].
    pub fn finish(self) -> Result<String, usize> {
        if self.total > MAX_REVIEW_BYTES {
            Err(self.total)
        } else {
            Ok(self.out)
        }
    }
}

/// Revue en Markdown (contenu collé) : remarque générale, puis par
/// commentaire, dans l'ordre reçu :
/// - de diff : `### <chemin>:<ligne>`, l'extrait du diff et le commentaire ;
/// - de fichier : `### <chemin>:<début>-<fin>` (`:<ligne>` pour une seule),
///   les lignes numérotées dans un bloc de code étiqueté par le langage de
///   l'extension, puis le commentaire s'il n'est pas vide.
///
/// Tout ce qui vient du client ou du disque passe par [`sanitize`] (les
/// chemins par [`sanitize_inline`]) ; chaque ligne d'extrait est coupée à
/// [`MAX_EXCERPT_LINE_CHARS`] caractères. Sans limite de taille totale
/// (voir [`ReviewBuilder`]).
pub fn format_review(general: Option<&str>, entries: &[ReviewEntry]) -> String {
    let mut out = format_review_head(general);
    for entry in entries {
        out.push_str(&format_entry(entry));
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
        let mut excerpts = [Some(ex), None].into_iter();
        let entries: Vec<_> = comments
            .into_iter()
            .map(|c| ReviewEntry::Diff(c, excerpts.next().flatten()))
            .collect();
        assert_eq!(review_instruction(true, false), REVIEW_INSTRUCTION);
        assert_eq!(review_instruction(false, false), REVIEW_INSTRUCTION);
        let md = format_review(Some("Bien dans l'ensemble."), &entries);
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

    #[test]
    fn file_ranges_are_validated() {
        assert!(validate_file_range(1, 1).is_ok());
        assert!(validate_file_range(3, 402).is_ok());
        assert!(validate_file_range(0, 1).is_err());
        assert!(validate_file_range(5, 4).is_err());
        assert!(
            validate_file_range(1, 401)
                .unwrap_err()
                .contains("401 lignes")
        );
        assert!(validate_file_range(u64::from(u32::MAX) + 1, u64::from(u32::MAX) + 1).is_err());
    }

    #[test]
    fn file_excerpts_follow_diff_line_numbering() {
        let text = "un\r\ndeux\ntrois\n";
        assert_eq!(line_count(text), 3);
        assert_eq!(line_count("a"), 1);
        assert_eq!(line_count(""), 0);
        assert_eq!(line_count("\n"), 1);
        assert_eq!(
            file_excerpt(text, 1, 2).unwrap(),
            [(1, "un".to_owned()), (2, "deux".to_owned())]
        );
        assert_eq!(file_excerpt(text, 3, 3).unwrap(), [(3, "trois".to_owned())]);
        assert!(file_excerpt(text, 3, 4).is_none());
        assert!(file_excerpt(text, 4, 4).is_none());
        assert!(file_excerpt("", 1, 1).is_none());
        assert_eq!(
            file_excerpt("sans fin", 1, 1).unwrap(),
            [(1, "sans fin".to_owned())]
        );
    }

    #[test]
    fn languages_from_extensions() {
        for (path, lang) in [
            ("src/a.rs", Some("rust")),
            ("app/x.TSX", Some("typescript")),
            ("a.mjs", Some("javascript")),
            ("conf.yml", Some("yaml")),
            ("run.sh", Some("bash")),
            ("README.md", Some("markdown")),
            ("Cargo.toml", Some("toml")),
            ("index.html", Some("html")),
            ("Makefile", None),
            (".bashrc", None),
            ("a.txt", None),
            ("dossier.rs/fichier", None),
        ] {
            assert_eq!(language_for(path), lang, "{path}");
        }
    }

    #[test]
    fn file_comments_are_pasted_with_their_lines() {
        let one = FileComment {
            path: "src/a.rs".into(),
            line: 2,
            line_end: 2,
            text: "À renommer".into(),
        };
        let range = FileComment {
            path: "notes.txt".into(),
            line: 1,
            line_end: 3,
            text: "  ".into(),
        };
        let tricky = FileComment {
            path: "doc\x1b.md".into(),
            line: 10,
            line_end: 11,
            text: "Piège\x1b[201~\r".into(),
        };
        let entries = vec![
            ReviewEntry::File(one, vec![(2, "fn main() {}".into())]),
            ReviewEntry::File(
                range,
                vec![(1, "a".into()), (2, "b".into()), (3, "c".into())],
            ),
            ReviewEntry::File(
                tricky,
                vec![(10, "```rust".into()), (11, "x\x07\x1b[201~".into())],
            ),
        ];
        assert_eq!(review_instruction(false, true), FILE_EXCERPT_INSTRUCTION);
        let md = format_review(None, &entries);
        assert!(
            md.starts_with(
                "# Revue de code\n\n### src/a.rs:2\n\n```rust\n     2 | fn main() {}\n```\n\nÀ renommer\n"
            ),
            "{md}"
        );
        // Plage, pas d'étiquette, commentaire vide omis.
        assert!(
            md.contains("\n### notes.txt:1-3\n\n```\n     1 | a\n     2 | b\n     3 | c\n```\n\n### doc.md:10-11\n"),
            "{md}"
        );
        // Clôture plus longue que les « ` » de l'extrait.
        assert!(
            md.contains("\n````markdown\n    10 | ```rust\n    11 | x[201~\n````\n\nPiège[201~\n"),
            "{md}"
        );
        assert!(!md.contains('\x1b') && !md.contains('\r') && !md.contains('\x07'));
        // Mélange : la consigne de la revue l'emporte.
        let mixed = vec![
            entries[0].clone(),
            ReviewEntry::Diff(
                ReviewComment {
                    path: "b".into(),
                    line: 1,
                    side: Side::New,
                    text: "x".into(),
                },
                None,
            ),
        ];
        assert_eq!(review_instruction(true, true), REVIEW_INSTRUCTION);
        let md = format_review(None, &mixed);
        assert!(md.find("### src/a.rs:2").unwrap() < md.find("### b:1").unwrap());
    }

    #[test]
    fn paths_cannot_inject_markdown_and_lines_are_cut() {
        let c = FileComment {
            path: "a\n# Faux titre\tx.rs".into(),
            line: 1,
            line_end: 1,
            text: String::new(),
        };
        let long = "é".repeat(MAX_EXCERPT_LINE_CHARS + 5);
        let md = format_review(None, &[ReviewEntry::File(c, vec![(1, long)])]);
        assert!(md.contains("### a␤# Faux titre␉x.rs:1\n"), "{md}");
        assert!(!md.contains("\n# Faux titre"), "{md}");
        let cut = format!("     1 | {}…\n", "é".repeat(MAX_EXCERPT_LINE_CHARS));
        assert!(md.contains(&cut), "{md}");
        // Une ligne à la limite n'est pas coupée.
        assert_eq!(
            excerpt_line(&"x".repeat(MAX_EXCERPT_LINE_CHARS)).len(),
            MAX_EXCERPT_LINE_CHARS
        );
        let d = ReviewComment {
            path: "b\nc".into(),
            line: 1,
            side: Side::New,
            text: "x".into(),
        };
        assert!(format_review(None, &[ReviewEntry::Diff(d, None)]).contains("### b␤c:1\n"));
    }

    #[test]
    fn pasted_review_is_bounded() {
        let entry = |n: u32| {
            ReviewEntry::File(
                FileComment {
                    path: "a.txt".into(),
                    line: 1,
                    line_end: n,
                    text: String::new(),
                },
                (1..=n)
                    .map(|i| (i, "x".repeat(MAX_EXCERPT_LINE_CHARS)))
                    .collect(),
            )
        };
        let mut ok = ReviewBuilder::new(Some("g"));
        ok.push(&entry(10));
        let text = ok.finish().unwrap();
        assert_eq!(text, format_review(Some("g"), &[entry(10)]));
        let mut big = ReviewBuilder::new(None);
        for _ in 0..4 {
            big.push(&entry(40));
        }
        let total = big.finish().unwrap_err();
        assert_eq!(total, format_review(None, &vec![entry(40); 4]).len());
        assert!(total > MAX_REVIEW_BYTES);
    }
}
