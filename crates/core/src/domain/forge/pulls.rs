//! Demandes de fusion (PR de GitHub, MR de GitLab…), état de la CI et revue
//! publiée sur la forge (v0.3, lot 13b, ADR 0006) : vocabulaire neutre et
//! règles pures (résumé de la CI, validation d'une revue, lignes commentées
//! vérifiées contre le diff).
//!
//! Comme les issues, le contenu des demandes de fusion n'est ni journalisé
//! ni enregistré en base.

use super::Label;
#[cfg(doc)]
use super::clean_text;
use crate::domain::diff::{FileDiff, FileStatus, Side};

/// Demandes de fusion listées par défaut (`forge.pulls`).
pub const DEFAULT_PULLS_LIMIT: usize = 50;
/// Demandes de fusion listées au plus (`forge.pulls`).
pub const MAX_PULLS_LIMIT: usize = 200;
/// Fichiers d'une demande de fusion gardés au plus (l'API REST de GitHub
/// n'en donne pas plus de 3 000).
pub const MAX_PULL_FILES: usize = 3000;
/// Fils de revue lus au plus (une page de l'API GraphQL).
pub const MAX_REVIEW_THREADS: usize = 100;
/// Commentaires lus au plus par fil de revue.
pub const MAX_THREAD_COMMENTS: usize = 50;
/// Commentaires d'une revue publiée, au plus.
pub const MAX_FORGE_REVIEW_COMMENTS: usize = 100;
/// Longueur d'un corps de revue ou de commentaire, en caractères.
pub const MAX_FORGE_REVIEW_BODY_CHARS: usize = 65_536;
/// Taille totale des textes d'une revue, en octets UTF-8.
pub const MAX_FORGE_REVIEW_BYTES: usize = 4 * 1024 * 1024;
/// Nom de branche accepté au plus, en octets.
pub const MAX_BRANCH_BYTES: usize = 255;

/// État d'une demande de fusion.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PullState {
    Open,
    Closed,
    Merged,
}

impl PullState {
    /// `OPEN` / `open`, `CLOSED`, `MERGED` ; autre chose : `None`.
    pub fn parse(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "open" => Some(Self::Open),
            "closed" => Some(Self::Closed),
            "merged" => Some(Self::Merged),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Closed => "closed",
            Self::Merged => "merged",
        }
    }
}

/// Filtre d'état de `forge.pulls`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PullStateFilter {
    Open,
    Closed,
    Merged,
    All,
}

impl PullStateFilter {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "open" => Some(Self::Open),
            "closed" => Some(Self::Closed),
            "merged" => Some(Self::Merged),
            "all" => Some(Self::All),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Closed => "closed",
            Self::Merged => "merged",
            Self::All => "all",
        }
    }
}

/// Filtre de `forge.pulls`, déjà validé.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullFilter {
    pub state: PullStateFilter,
    /// Recherche dans la syntaxe de la forge.
    pub search: Option<String>,
    /// Seulement celles de l'utilisateur connecté.
    pub mine: bool,
    /// 1 à [`MAX_PULLS_LIMIT`].
    pub limit: usize,
}

impl Default for PullFilter {
    fn default() -> Self {
        Self {
            state: PullStateFilter::Open,
            search: None,
            mine: false,
            limit: DEFAULT_PULLS_LIMIT,
        }
    }
}

/// Décision de revue d'une demande de fusion.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReviewDecision {
    Approved,
    ChangesRequested,
    ReviewRequired,
}

impl ReviewDecision {
    /// `APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED` (sans casse) ;
    /// vide ou autre : `None` (pas de revue exigée, ou inconnue).
    pub fn parse(s: &str) -> Option<Self> {
        match s.to_ascii_uppercase().as_str() {
            "APPROVED" => Some(Self::Approved),
            "CHANGES_REQUESTED" => Some(Self::ChangesRequested),
            "REVIEW_REQUIRED" => Some(Self::ReviewRequired),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Approved => "approved",
            Self::ChangesRequested => "changes_requested",
            Self::ReviewRequired => "review_required",
        }
    }
}

/// État d'une vérification de CI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckState {
    Success,
    Failure,
    Pending,
    Skipped,
    Cancelled,
}

impl CheckState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Success => "success",
            Self::Failure => "failure",
            Self::Pending => "pending",
            Self::Skipped => "skipped",
            Self::Cancelled => "cancelled",
        }
    }

    /// État d'un *check run* de GitHub (`status`, `conclusion`, sans
    /// casse) : pas encore `COMPLETED` → `pending` ; `SUCCESS` et `NEUTRAL`
    /// → `success` ; `SKIPPED` → `skipped` ; `CANCELLED` et `STALE` →
    /// `cancelled` ; toute autre conclusion (`FAILURE`, `TIMED_OUT`,
    /// `ACTION_REQUIRED`, `STARTUP_FAILURE`, inconnue) → `failure`.
    pub fn of_check_run(status: Option<&str>, conclusion: Option<&str>) -> Self {
        let completed = status.is_some_and(|s| s.eq_ignore_ascii_case("COMPLETED"));
        let conclusion = conclusion.filter(|c| !c.is_empty());
        let Some(c) = conclusion.filter(|_| completed) else {
            return Self::Pending;
        };
        match c.to_ascii_uppercase().as_str() {
            "SUCCESS" | "NEUTRAL" => Self::Success,
            "SKIPPED" => Self::Skipped,
            "CANCELLED" | "STALE" => Self::Cancelled,
            _ => Self::Failure,
        }
    }

    /// État d'un statut de commit (`StatusContext.state`) : `SUCCESS` →
    /// `success`, `PENDING` et `EXPECTED` → `pending`, autre (`FAILURE`,
    /// `ERROR`) → `failure`.
    pub fn of_status_context(state: &str) -> Self {
        match state.to_ascii_uppercase().as_str() {
            "SUCCESS" => Self::Success,
            "PENDING" | "EXPECTED" => Self::Pending,
            _ => Self::Failure,
        }
    }
}

/// Une vérification de CI (job d'un workflow, ou statut de commit).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckRun {
    pub name: String,
    /// Workflow du job (`None` pour un statut de commit).
    pub workflow: Option<String>,
    pub state: CheckState,
    /// Page de la vérification sur la forge (ou chez le service de CI).
    pub url: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
}

/// Les vérifications en double (même workflow et même nom : relances) sont
/// ramenées à la plus récente (`started_at`, dates RFC 3339 comparables
/// comme textes) ; l'ordre de la première apparition est gardé.
pub fn dedupe_checks(checks: Vec<CheckRun>) -> Vec<CheckRun> {
    let mut out: Vec<CheckRun> = Vec::with_capacity(checks.len());
    for c in checks {
        match out
            .iter_mut()
            .find(|o| o.name == c.name && o.workflow == c.workflow)
        {
            Some(o) if c.started_at > o.started_at => *o = c,
            Some(_) => {}
            None => out.push(c),
        }
    }
    out
}

/// État d'ensemble de la CI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChecksState {
    Success,
    Failure,
    Pending,
    /// Aucune vérification.
    None,
}

impl ChecksState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Success => "success",
            Self::Failure => "failure",
            Self::Pending => "pending",
            Self::None => "none",
        }
    }
}

/// Résumé de la CI d'une demande de fusion.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChecksSummary {
    pub state: ChecksState,
    pub total: u64,
    /// `success` et `skipped`.
    pub passed: u64,
    /// `failure` et `cancelled`.
    pub failed: u64,
    pub pending: u64,
}

/// Résumé : `failure` dès qu'une vérification a échoué (ou a été annulée),
/// sinon `pending` s'il en reste en cours, sinon `success` ; `none` sans
/// vérification. `total` = `passed` + `failed` + `pending`.
pub fn summarize_checks(checks: &[CheckRun]) -> ChecksSummary {
    let (mut passed, mut failed, mut pending) = (0, 0, 0);
    for c in checks {
        match c.state {
            CheckState::Success | CheckState::Skipped => passed += 1,
            CheckState::Failure | CheckState::Cancelled => failed += 1,
            CheckState::Pending => pending += 1,
        }
    }
    let state = if checks.is_empty() {
        ChecksState::None
    } else if failed > 0 {
        ChecksState::Failure
    } else if pending > 0 {
        ChecksState::Pending
    } else {
        ChecksState::Success
    };
    ChecksSummary {
        state,
        total: passed + failed + pending,
        passed,
        failed,
        pending,
    }
}

/// Une demande de fusion.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pull {
    pub number: u64,
    pub title: String,
    pub state: PullState,
    pub draft: bool,
    pub url: String,
    pub author: Option<String>,
    pub head_branch: String,
    pub head_sha: String,
    pub base_branch: String,
    /// La branche de tête est dans un autre dépôt (fourche).
    pub cross_repository: bool,
    /// Propriétaire du dépôt de la branche de tête.
    pub head_owner: Option<String>,
    pub updated_at: Option<String>,
    pub additions: u64,
    pub deletions: u64,
    pub changed_files: u64,
    pub review_decision: Option<ReviewDecision>,
    /// Vérifications de la tête, sans doublons ([`dedupe_checks`]).
    pub checks: Vec<CheckRun>,
    pub labels: Vec<Label>,
    /// Corps nettoyé, au plus [`super::MAX_BODY_BYTES`] (`None` : pas lu, en liste).
    pub body: Option<String>,
    pub body_truncated: bool,
}

/// Un fichier changé par une demande de fusion.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullFile {
    pub path: String,
    /// Ancien chemin d'un renommage.
    pub old_path: Option<String>,
    /// `A`, `M`, `D` ou `R` (une copie compte comme un ajout).
    pub status: FileStatus,
    pub additions: u64,
    pub deletions: u64,
}

/// Commentaire d'un fil de revue.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadComment {
    pub author: Option<String>,
    /// Nettoyé, au plus [`super::MAX_BODY_BYTES`].
    pub body: String,
    pub created_at: Option<String>,
}

/// Fil de revue existant (lecture seule).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewThread {
    pub path: String,
    /// Ligne dans la version de son côté ; `None` pour un fil périmé (la
    /// ligne a disparu du diff).
    pub line: Option<u32>,
    pub side: Side,
    pub resolved: bool,
    pub outdated: bool,
    /// Au plus [`MAX_THREAD_COMMENTS`].
    pub comments: Vec<ThreadComment>,
    /// Il y en avait plus.
    pub comments_truncated: bool,
}

/// Une demande de fusion complète (`forge.pull`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullDetail {
    pub pull: Pull,
    /// Au plus [`MAX_PULL_FILES`].
    pub files: Vec<PullFile>,
    pub files_truncated: bool,
    /// Au plus [`MAX_REVIEW_THREADS`].
    pub threads: Vec<ReviewThread>,
    pub threads_truncated: bool,
}

/// Nom de branche acceptable pour `forge.pullForBranch` : non vide, au
/// plus [`MAX_BRANCH_BYTES`] octets, sans blanc ni caractère de contrôle,
/// ne commence pas par `-` (jamais lu comme une option), sans `..`.
pub fn valid_branch(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= MAX_BRANCH_BYTES
        && !s.starts_with('-')
        && !s.contains("..")
        && !s.chars().any(|c| c.is_control() || c.is_whitespace())
}

/// Empreinte de commit : 40 (SHA-1) ou 64 (SHA-256) chiffres hexadécimaux,
/// rendue en minuscules.
pub fn normalize_sha(s: &str) -> Option<String> {
    ((s.len() == 40 || s.len() == 64) && s.bytes().all(|b| b.is_ascii_hexdigit()))
        .then(|| s.to_ascii_lowercase())
}

/// Genre de revue publiée.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReviewEvent {
    Comment,
    Approve,
    RequestChanges,
}

impl ReviewEvent {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "comment" => Some(Self::Comment),
            "approve" => Some(Self::Approve),
            "request_changes" => Some(Self::RequestChanges),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Comment => "comment",
            Self::Approve => "approve",
            Self::RequestChanges => "request_changes",
        }
    }
}

/// Commentaire de ligne d'une revue publiée.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForgeReviewComment {
    pub path: String,
    pub line: u32,
    pub side: Side,
    pub body: String,
}

/// Revue à publier, validée et nettoyée.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForgeReview {
    /// Tête de la demande de fusion relue par l'utilisateur.
    pub head_sha: String,
    pub event: ReviewEvent,
    /// Peut être vide (approbation sans mot, ou commentaires seuls).
    pub body: String,
    pub comments: Vec<ForgeReviewComment>,
}

/// Revue refusée : message en français ; `index` (à partir de 0) désigne le
/// commentaire fautif.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewRefusal {
    pub index: Option<usize>,
    pub message: String,
}

impl ReviewRefusal {
    fn general(message: impl Into<String>) -> Self {
        Self {
            index: None,
            message: message.into(),
        }
    }

    fn comment(index: usize, message: impl std::fmt::Display) -> Self {
        Self {
            index: Some(index),
            message: format!("commentaire {} : {message}", index + 1),
        }
    }
}

/// Contrôle bidirectionnel : forçages et isolats du sens d'écriture
/// (U+202A–U+202E, U+2066–U+2069) et marques de sens (U+200E, U+200F,
/// U+061C), de quoi faire lire un texte autrement qu'il n'est écrit.
pub fn bidi_control(c: char) -> bool {
    matches!(
        c,
        '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{200E}' | '\u{200F}' | '\u{061C}'
    )
}

/// Texte **écrit par l'utilisateur** (corps et commentaires d'une revue
/// publiée) : fins de ligne `\r\n` / `\r` ramenées à `\n`, caractères de
/// contrôle (sauf `\n` et `\t`) et contrôles bidirectionnels
/// ([`bidi_control`]) retirés ; tout le reste est gardé (antiliant U+200D,
/// sélecteurs de variation, trait d'union conditionnel… : un émoji composé
/// reste entier). Seules les lignes blanches (blancs et caractères
/// invisibles seulement) de début et de fin sont retirées : l'indentation de la première ligne (bloc de code) est
/// gardée. Plus strict, [`clean_text`] reste pour le contenu **venu** de
/// la forge.
pub fn clean_user_text(text: &str) -> String {
    let cleaned: String = text
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .chars()
        .filter(|c| (*c == '\n' || *c == '\t' || !c.is_control()) && !bidi_control(*c))
        .collect();
    let lines: Vec<&str> = cleaned.split('\n').collect();
    // Blanche : rien que des blancs ou des caractères invisibles.
    let blank = |l: &&str| l.chars().all(|c| c.is_whitespace() || super::invisible(c));
    let Some(first) = lines.iter().position(|l| !blank(l)) else {
        return String::new();
    };
    let last = lines.iter().rposition(|l| !blank(l)).unwrap_or(first);
    lines[first..=last].join("\n")
}

fn too_long(s: &str) -> bool {
    s.chars().count() > MAX_FORGE_REVIEW_BODY_CHARS
}

impl ForgeReview {
    /// Revue validée : `head_sha` ([`normalize_sha`]), corps et
    /// commentaires nettoyés ([`clean_user_text`]), au
    /// plus [`MAX_FORGE_REVIEW_BODY_CHARS`] caractères chacun, au plus
    /// [`MAX_FORGE_REVIEW_COMMENTS`] commentaires, chacun avec un chemin non
    /// vide (sans caractère de contrôle), une ligne ≥ 1 et un corps non
    /// vide ; `comment` et `request_changes` exigent un corps non vide
    /// (règle de l'API de GitHub), `approve` non ; textes au plus [`MAX_FORGE_REVIEW_BYTES`] en tout.
    pub fn new(
        head_sha: &str,
        event: ReviewEvent,
        body: &str,
        comments: Vec<ForgeReviewComment>,
    ) -> Result<Self, ReviewRefusal> {
        let head_sha = normalize_sha(head_sha).ok_or_else(|| {
            ReviewRefusal::general(
                "« expected_head_sha » : empreinte de commit attendue (40 ou 64 chiffres hexadécimaux)",
            )
        })?;
        if comments.len() > MAX_FORGE_REVIEW_COMMENTS {
            return Err(ReviewRefusal::general(format!(
                "{} commentaires : {MAX_FORGE_REVIEW_COMMENTS} au plus",
                comments.len()
            )));
        }
        let body = clean_user_text(body);
        if body.is_empty() && event != ReviewEvent::Approve {
            return Err(ReviewRefusal::general(format!(
                "« body » : un commentaire général est exigé pour « {} » (règle de l'API de GitHub)",
                event.as_str()
            )));
        }
        if too_long(&body) {
            return Err(ReviewRefusal::general(format!(
                "« body » : {MAX_FORGE_REVIEW_BODY_CHARS} caractères au plus"
            )));
        }
        let mut total = body.len();
        let mut cleaned = Vec::with_capacity(comments.len());
        for (i, c) in comments.into_iter().enumerate() {
            if c.path.is_empty() || c.path.chars().any(char::is_control) {
                return Err(ReviewRefusal::comment(i, "chemin invalide"));
            }
            if c.line == 0 {
                return Err(ReviewRefusal::comment(i, "« line » : entier ≥ 1 attendu"));
            }
            let text = clean_user_text(&c.body);
            if text.is_empty() {
                return Err(ReviewRefusal::comment(i, "corps vide"));
            }
            if too_long(&text) {
                return Err(ReviewRefusal::comment(
                    i,
                    format_args!("{MAX_FORGE_REVIEW_BODY_CHARS} caractères au plus"),
                ));
            }
            total += text.len() + c.path.len();
            cleaned.push(ForgeReviewComment { body: text, ..c });
        }
        if total > MAX_FORGE_REVIEW_BYTES {
            return Err(ReviewRefusal::general(format!(
                "revue trop volumineuse : {} Kio sur {} Kio au plus",
                total.div_ceil(1024),
                MAX_FORGE_REVIEW_BYTES / 1024
            )));
        }
        Ok(Self {
            head_sha,
            event,
            body,
            comments: cleaned,
        })
    }

    /// Chaque ligne commentée doit être dans le diff de la demande de
    /// fusion (`diff_of(path)` : diff du fichier à la tête relue, `None` si
    /// le fichier n'en fait pas partie) : une ligne d'un bloc, ajoutée,
    /// retirée ou de contexte, du côté demandé. Un fichier binaire ou trop
    /// gros pour être lu est refusé (ligne invérifiable).
    pub fn check_lines<'a>(
        &self,
        diff_of: impl Fn(&str) -> Option<&'a FileDiff>,
    ) -> Result<(), ReviewRefusal> {
        for (i, c) in self.comments.iter().enumerate() {
            let Some(diff) = diff_of(&c.path) else {
                return Err(ReviewRefusal::comment(
                    i,
                    format_args!("« {} » ne fait pas partie de la demande de fusion", c.path),
                ));
            };
            if diff.binary {
                return Err(ReviewRefusal::comment(
                    i,
                    format_args!("« {} » est un fichier binaire", c.path),
                ));
            }
            if diff.too_large {
                return Err(ReviewRefusal::comment(
                    i,
                    format_args!(
                        "le diff de « {} » est trop gros pour vérifier la ligne",
                        c.path
                    ),
                ));
            }
            let found = diff
                .hunks
                .iter()
                .flat_map(|h| &h.lines)
                .any(|l| match c.side {
                    Side::New => l.new_no == Some(c.line),
                    Side::Old => l.old_no == Some(c.line),
                });
            if !found {
                let version = match c.side {
                    Side::New => "nouvelle version",
                    Side::Old => "ancienne version",
                };
                return Err(ReviewRefusal::comment(
                    i,
                    format_args!(
                        "la ligne {} ({version}) de « {} » n'est pas dans le diff",
                        c.line, c.path
                    ),
                ));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::diff::parse_unified;

    fn run(name: &str, workflow: Option<&str>, state: CheckState, started: &str) -> CheckRun {
        CheckRun {
            name: name.into(),
            workflow: workflow.map(Into::into),
            state,
            url: None,
            started_at: Some(started.into()),
            completed_at: None,
        }
    }

    #[test]
    fn check_states_are_mapped() {
        use CheckState::*;
        let cases = [
            (Some("COMPLETED"), Some("SUCCESS"), Success),
            (Some("completed"), Some("neutral"), Success),
            (Some("COMPLETED"), Some("SKIPPED"), Skipped),
            (Some("COMPLETED"), Some("CANCELLED"), Cancelled),
            (Some("COMPLETED"), Some("STALE"), Cancelled),
            (Some("COMPLETED"), Some("FAILURE"), Failure),
            (Some("COMPLETED"), Some("TIMED_OUT"), Failure),
            (Some("COMPLETED"), Some("ACTION_REQUIRED"), Failure),
            (Some("COMPLETED"), Some("STARTUP_FAILURE"), Failure),
            (Some("COMPLETED"), Some("QUELQUE_CHOSE"), Failure),
            (Some("IN_PROGRESS"), None, Pending),
            (Some("QUEUED"), Some(""), Pending),
            (Some("COMPLETED"), None, Pending),
            (None, None, Pending),
        ];
        for (status, conclusion, want) in cases {
            assert_eq!(
                CheckState::of_check_run(status, conclusion),
                want,
                "{status:?} {conclusion:?}"
            );
        }
        assert_eq!(CheckState::of_status_context("SUCCESS"), Success);
        assert_eq!(CheckState::of_status_context("PENDING"), Pending);
        assert_eq!(CheckState::of_status_context("EXPECTED"), Pending);
        assert_eq!(CheckState::of_status_context("ERROR"), Failure);
        assert_eq!(CheckState::of_status_context("FAILURE"), Failure);
    }

    #[test]
    fn checks_are_summarized() {
        use CheckState::*;
        let s = summarize_checks(&[]);
        assert_eq!((s.state, s.total), (ChecksState::None, 0));
        let ok = [run("a", None, Success, "1"), run("b", None, Skipped, "1")];
        let s = summarize_checks(&ok);
        assert_eq!(
            s,
            ChecksSummary {
                state: ChecksState::Success,
                total: 2,
                passed: 2,
                failed: 0,
                pending: 0
            }
        );
        let mixed = [
            run("a", None, Success, "1"),
            run("b", None, Pending, "1"),
            run("c", None, Cancelled, "1"),
        ];
        let s = summarize_checks(&mixed);
        assert_eq!(s.state, ChecksState::Failure, "l'échec l'emporte");
        assert_eq!((s.total, s.passed, s.failed, s.pending), (3, 1, 1, 1));
        let s = summarize_checks(&mixed[..2]);
        assert_eq!(s.state, ChecksState::Pending);
    }

    #[test]
    fn duplicate_checks_keep_the_latest_run() {
        use CheckState::*;
        let out = dedupe_checks(vec![
            run("lint", Some("Lint"), Failure, "2026-10-20T10:00:00Z"),
            run("build", Some("Tests"), Success, "2026-10-20T10:00:00Z"),
            run("lint", Some("Lint"), Success, "2026-10-20T11:00:00Z"),
            run("lint", Some("Autre"), Pending, "2026-10-20T09:00:00Z"),
            run("build", Some("Tests"), Failure, "2026-10-20T09:00:00Z"),
        ]);
        assert_eq!(out.len(), 3);
        assert_eq!((out[0].name.as_str(), out[0].state), ("lint", Success));
        assert_eq!(
            out[1].state, Success,
            "une relance plus ancienne est ignorée"
        );
        assert_eq!(out[2].workflow.as_deref(), Some("Autre"));
    }

    #[test]
    fn states_decisions_and_parameters() {
        assert_eq!(PullState::parse("MERGED"), Some(PullState::Merged));
        assert_eq!(PullState::parse("draft"), None);
        assert_eq!(
            PullStateFilter::parse("merged"),
            Some(PullStateFilter::Merged)
        );
        assert_eq!(PullStateFilter::parse("MERGED"), None);
        assert_eq!(
            ReviewDecision::parse("CHANGES_REQUESTED").map(ReviewDecision::as_str),
            Some("changes_requested")
        );
        assert_eq!(ReviewDecision::parse(""), None);
        assert_eq!(
            ReviewEvent::parse("request_changes"),
            Some(ReviewEvent::RequestChanges)
        );
        assert_eq!(ReviewEvent::parse("APPROVE"), None);
        assert!(valid_branch("feat/13b-forge"));
        for bad in ["", "-x", "a b", "a..b", "a\nb", &"b".repeat(256)] {
            assert!(!valid_branch(bad), "{bad}");
        }
        let sha = "04B392947395D0FC415E8FC028B358707F4DF18C";
        assert_eq!(normalize_sha(sha), Some(sha.to_ascii_lowercase()));
        assert_eq!(normalize_sha(&"a".repeat(64)).map(|s| s.len()), Some(64));
        for bad in ["", "abc", &"g".repeat(40), &"a".repeat(41)] {
            assert_eq!(normalize_sha(bad), None, "{bad}");
        }
    }

    const SHA: &str = "04b392947395d0fc415e8fc028b358707f4df18c";

    fn comment(path: &str, line: u32, side: Side, body: &str) -> ForgeReviewComment {
        ForgeReviewComment {
            path: path.into(),
            line,
            side,
            body: body.into(),
        }
    }

    #[test]
    fn reviews_are_validated_and_cleaned() {
        let r = ForgeReview::new(
            SHA,
            ReviewEvent::Comment,
            "\n  \n  Bien\r\n vu\u{202E}\u{E0041} \u{1b}[31m\n\n",
            vec![comment(
                "src/a.rs",
                3,
                Side::New,
                "    fn x() {}\u{200B}\n 👩\u{200D}💻\n",
            )],
        )
        .unwrap();
        assert_eq!(r.body, "  Bien\n vu\u{E0041} [31m");
        assert_eq!(r.comments[0].body, "    fn x() {}\u{200B}\n 👩\u{200D}💻");
        // Approbation sans un mot : acceptée ; commentaire ou demande de
        // modifications sans corps : refusés, même avec des commentaires.
        assert!(ForgeReview::new(SHA, ReviewEvent::Approve, "", vec![]).is_ok());
        for event in [ReviewEvent::Comment, ReviewEvent::RequestChanges] {
            for comments in [vec![], vec![comment("a", 1, Side::Old, "x")]] {
                let e = ForgeReview::new(SHA, event, " \u{200B}\n", comments).unwrap_err();
                assert_eq!(e.index, None);
                assert!(
                    e.message
                        .starts_with("« body » : un commentaire général est exigé"),
                    "{}",
                    e.message
                );
            }
        }
        // Commentaire fautif désigné.
        let e = ForgeReview::new(
            SHA,
            ReviewEvent::Comment,
            "x",
            vec![
                comment("a", 1, Side::New, "ok"),
                comment("b", 2, Side::New, "\u{200D} "),
            ],
        )
        .unwrap_err();
        assert_eq!(e.index, Some(1));
        assert_eq!(e.message, "commentaire 2 : corps vide");
        let e = ForgeReview::new(
            SHA,
            ReviewEvent::Comment,
            "x",
            vec![comment("a", 0, Side::New, "y")],
        )
        .unwrap_err();
        assert_eq!(e.index, Some(0));
        let e = ForgeReview::new(
            SHA,
            ReviewEvent::Comment,
            "x",
            vec![comment("", 1, Side::New, "y")],
        )
        .unwrap_err();
        assert_eq!(e.index, Some(0));
        // Bornes.
        let long = "é".repeat(MAX_FORGE_REVIEW_BODY_CHARS + 1);
        assert!(ForgeReview::new(SHA, ReviewEvent::Comment, &long, vec![]).is_err());
        let exact = "é".repeat(MAX_FORGE_REVIEW_BODY_CHARS);
        assert!(ForgeReview::new(SHA, ReviewEvent::Comment, &exact, vec![]).is_ok());
        let e = ForgeReview::new(
            SHA,
            ReviewEvent::Comment,
            "x",
            vec![comment("a", 1, Side::New, &long)],
        )
        .unwrap_err();
        assert_eq!(e.index, Some(0));
        let many = (0..=MAX_FORGE_REVIEW_COMMENTS)
            .map(|i| comment("a", i as u32 + 1, Side::New, "x"))
            .collect();
        assert!(ForgeReview::new(SHA, ReviewEvent::Comment, "x", many).is_err());
        let big: Vec<_> = (0..40)
            .map(|i| {
                comment(
                    "a",
                    i + 1,
                    Side::New,
                    &"€".repeat(MAX_FORGE_REVIEW_BODY_CHARS),
                )
            })
            .collect();
        let e = ForgeReview::new(SHA, ReviewEvent::Comment, "x", big).unwrap_err();
        assert!(e.message.contains("trop volumineuse"), "{}", e.message);
        assert!(ForgeReview::new("abc", ReviewEvent::Comment, "x", vec![]).is_err());
    }

    /// Fixture partagée avec le front (parité du nettoyage).
    #[test]
    fn user_text_cleaning_matches_the_shared_fixture() {
        let cases: Vec<serde_json::Value> = serde_json::from_slice(include_bytes!(
            "../../../tests/fixtures/forge/user-text-cleaning.json"
        ))
        .unwrap();
        assert!(cases.len() >= 10);
        for case in cases {
            let input = case["input"].as_str().unwrap();
            assert_eq!(
                clean_user_text(input),
                case["expected"].as_str().unwrap(),
                "{}",
                case["name"]
            );
        }
    }

    #[test]
    fn commented_lines_must_be_in_the_diff() {
        let diff = parse_unified(
            b"@@ -1,3 +1,3 @@\n un\n-deux\n+DEUX\n trois\n@@ -10,2 +10,3 @@\n dix\n+onze\n douze\n",
        );
        let binary = FileDiff::binary();
        let large = FileDiff::too_large();
        let diff_of = |p: &str| match p {
            "a.rs" => Some(&diff),
            "img.png" => Some(&binary),
            "gros.json" => Some(&large),
            _ => None,
        };
        let review = |comments| ForgeReview::new(SHA, ReviewEvent::Comment, "x", comments).unwrap();
        // Lignes ajoutées, retirées et de contexte, des deux côtés.
        let ok = review(vec![
            comment("a.rs", 2, Side::New, "ajoutée"),
            comment("a.rs", 2, Side::Old, "retirée"),
            comment("a.rs", 1, Side::Old, "contexte"),
            comment("a.rs", 3, Side::New, "contexte"),
            comment("a.rs", 11, Side::New, "second bloc"),
        ]);
        assert_eq!(ok.check_lines(diff_of), Ok(()));
        let cases = [
            (
                comment("a.rs", 5, Side::New, "x"),
                "la ligne 5 (nouvelle version) de « a.rs » n'est pas dans le diff",
            ),
            (
                comment("a.rs", 12, Side::Old, "x"),
                "la ligne 12 (ancienne version) de « a.rs » n'est pas dans le diff",
            ),
            (
                comment("b.rs", 1, Side::New, "x"),
                "« b.rs » ne fait pas partie de la demande de fusion",
            ),
            (
                comment("img.png", 1, Side::New, "x"),
                "« img.png » est un fichier binaire",
            ),
            (comment("gros.json", 1, Side::New, "x"), "trop gros"),
        ];
        for (c, want) in cases {
            let r = review(vec![comment("a.rs", 2, Side::New, "ok"), c]);
            let e = r.check_lines(diff_of).unwrap_err();
            assert_eq!(e.index, Some(1));
            assert!(e.message.starts_with("commentaire 2 : "), "{}", e.message);
            assert!(e.message.contains(want), "{} / {want}", e.message);
        }
    }
}
