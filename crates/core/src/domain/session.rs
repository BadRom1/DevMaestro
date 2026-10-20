//! Sessions Claude Code suivies par l'app.

use std::path::PathBuf;

use serde_json::Value;
use time::OffsetDateTime;
use uuid::Uuid;

use super::hooks::{HookEvent, HookKind};
use super::metrics::{Metrics, ModelInfo};
use super::state::{Applied, Effect, SessionState, apply_tracked};
use super::statusline::Statusline;
use super::transcript::{PROMPT_PREVIEW_CHARS, display_label, short_id, truncate_chars};

/// Une session : un processus `claude` lancé ou repris par l'app.
///
/// Deux identifiants coexistent :
/// - [`Session::id`] : identifiant interne, stable, choisi au lancement ;
/// - [`Session::claude_session_id`] : le `session_id` de Claude Code. Il vaut
///   d'abord l'UUID passé à `--session-id`, mais **change** sur `/clear` ou
///   `/resume` (un `SessionStart` de source `clear` ou `resume` en apporte un
///   nouveau).
///
/// Le démon rattache donc un hook à sa session par le processus et le jeton
/// (`ORCH_TOKEN`), jamais par le `session_id` de Claude Code, qui sert
/// seulement à retrouver le transcript et à reprendre la session.
#[derive(Debug, Clone, PartialEq)]
pub struct Session {
    /// Identifiant interne, stable.
    pub id: Uuid,
    /// `session_id` courant de Claude Code.
    pub claude_session_id: String,
    /// Racine du projet auquel la session appartient.
    pub project_root: PathBuf,
    /// Dossier de travail (le worktree).
    pub cwd: PathBuf,
    /// Branche git du worktree, si connue.
    pub branch: Option<String>,
    /// Nom du profil utilisé.
    pub profile: String,
    /// État piloté par les hooks (voir [`crate::domain::state::apply`]).
    pub state: SessionState,
    /// Mesures, dont le modèle (identifiant et nom affiché), issues de la
    /// statusline et de `SessionStart`.
    pub metrics: Metrics,
    /// Titre donné par l'utilisateur (`sessions.update`), au plus
    /// [`MAX_TITLE_CHARS`] caractères.
    pub title: Option<String>,
    /// Couleur choisie par l'utilisateur, un nom de [`SESSION_COLORS`].
    pub color: Option<String>,
    /// Premier prompt tapé (`UserPromptSubmit`), tronqué à
    /// [`PROMPT_PREVIEW_CHARS`] ; les commandes (`/…`) ne comptent pas.
    pub first_prompt: Option<String>,
}

/// Palette des couleurs de session (noms de jetons, l'app choisit le rendu).
pub const SESSION_COLORS: &[&str] = &[
    "gris", "bleu", "vert", "jaune", "orange", "rouge", "violet", "rose",
];

/// Longueur maximale d'un titre de session, en caractères (points de code).
pub const MAX_TITLE_CHARS: usize = 80;

/// Titre refusé par [`normalize_title`].
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TitleError {
    #[error("titre trop long : {0} caractères, {MAX_TITLE_CHARS} au plus")]
    TooLong(usize),
    #[error("le titre ne doit pas contenir de caractère de contrôle (saut de ligne, tabulation…)")]
    Control,
    #[error(
        "le titre ne doit pas contenir de caractère invisible de mise en forme \
         (U+{0:04X} : sens d'écriture forcé, espace sans chasse, séparateur de ligne…)"
    )]
    Format(u32),
}

/// Caractères Unicode de mise en forme (catégorie Cf), et séparateurs de
/// ligne et de paragraphe (Zl, Zp) : invisibles, ils peuvent maquiller un
/// titre (inversion du sens d'écriture, U+202E…). L'antiliant sans chasse
/// (U+200D) est admis : il compose les émojis (👩‍💻).
fn is_format_char(c: char) -> bool {
    matches!(c as u32,
        0x00AD | 0x0600..=0x0605 | 0x061C | 0x06DD | 0x070F | 0x0890..=0x0891 | 0x08E2
        | 0x180E | 0x200B | 0x200C | 0x200E | 0x200F | 0x2028..=0x202E | 0x2060..=0x2064
        | 0x2066..=0x206F | 0xFEFF | 0xFFF9..=0xFFFB | 0x110BD | 0x110CD | 0x13430..=0x1343F
        | 0x1BCA0..=0x1BCA3 | 0x1D173..=0x1D17A | 0xE0001 | 0xE0020..=0xE007F)
}

/// Titre tel qu'il sera gardé : blancs de début et de fin retirés ; vide =
/// pas de titre (`None`).
pub fn normalize_title(title: &str) -> Result<Option<String>, TitleError> {
    let t = title.trim();
    if t.chars().any(char::is_control) {
        return Err(TitleError::Control);
    }
    if let Some(c) = t.chars().find(|c| is_format_char(*c)) {
        return Err(TitleError::Format(c as u32));
    }
    let n = t.chars().count();
    if n > MAX_TITLE_CHARS {
        return Err(TitleError::TooLong(n));
    }
    // Au moins un caractère visible (pas seulement des blancs ou U+200D).
    let visible = t.chars().any(|c| !c.is_whitespace() && c != '\u{200D}');
    Ok(visible.then(|| t.to_owned()))
}

/// Couleur de la palette ? (`None` : pas de couleur, toujours valable.)
pub fn is_session_color(color: &str) -> bool {
    SESSION_COLORS.contains(&color)
}

impl Session {
    /// Nouvelle session à l'état « démarrage ».
    pub fn new(
        id: Uuid,
        claude_session_id: impl Into<String>,
        project_root: impl Into<PathBuf>,
        cwd: impl Into<PathBuf>,
        profile: impl Into<String>,
    ) -> Self {
        Self {
            id,
            claude_session_id: claude_session_id.into(),
            project_root: project_root.into(),
            cwd: cwd.into(),
            branch: None,
            profile: profile.into(),
            state: SessionState::default(),
            metrics: Metrics::default(),
            title: None,
            color: None,
            first_prompt: None,
        }
    }

    /// Nom à afficher : titre de l'utilisateur, sinon `session_name` de la
    /// statusline, sinon premier prompt, sinon les 8 premiers caractères de
    /// l'identifiant. Le nom de Claude Code et le prompt sont ramenés à une
    /// ligne et coupés à [`super::transcript::DISPLAY_NAME_CHARS`].
    pub fn display_name(&self) -> String {
        self.title
            .clone()
            .or_else(|| self.metrics.session_name.as_deref().and_then(display_label))
            .or_else(|| self.first_prompt.as_deref().and_then(display_label))
            .unwrap_or_else(|| short_id(&self.id.to_string()))
    }

    /// Retient le premier prompt tapé, s'il n'y en a pas encore. Les
    /// commandes (texte qui commence par `/`) et les textes vides sont ignorés.
    pub fn note_prompt(&mut self, prompt: &str) {
        let p = prompt.trim();
        if self.first_prompt.is_none() && !p.is_empty() && !p.starts_with('/') {
            self.first_prompt = Some(truncate_chars(p, PROMPT_PREVIEW_CHARS));
        }
    }

    /// Applique un événement de hook : met à jour le `session_id` de Claude
    /// Code et le modèle sur `SessionStart`, puis la machine à états.
    pub fn apply_hook(&mut self, event: &HookEvent, now: OffsetDateTime) -> Vec<Effect> {
        self.apply_hook_tracked(event, now).effects
    }

    /// Comme [`Session::apply_hook`], en indiquant la demande à laquelle
    /// l'événement se rattache (voir [`crate::domain::state::apply_tracked`]).
    pub fn apply_hook_tracked(&mut self, event: &HookEvent, now: OffsetDateTime) -> Applied {
        if let HookKind::UserPromptSubmit {
            prompt: Some(prompt),
        } = &event.kind
        {
            self.note_prompt(prompt);
        }
        if let HookKind::SessionStart { model, .. } = &event.kind {
            self.claude_session_id = event.common.session_id.clone();
            if let Some(id) = model {
                let same = self
                    .metrics
                    .model
                    .as_ref()
                    .is_some_and(|m| m.id.as_deref() == Some(id.as_str()));
                if !same {
                    self.metrics.model = Some(ModelInfo {
                        id: Some(id.clone()),
                        display_name: None,
                    });
                }
            }
        }
        apply_tracked(&mut self.state, event, now)
    }

    /// Fusionne les mesures d'une statusline (voir [`Metrics::merge`]).
    pub fn apply_statusline(&mut self, statusline: &Statusline) {
        self.metrics.merge(statusline.metrics.clone());
    }
}

/// Statut d'une session (architecture § 5.1).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum SessionStatus {
    /// PTY lancé, pas encore de `SessionStart`.
    #[default]
    Starting,
    /// Claude travaille.
    Running,
    /// Claude attend une réponse de l'utilisateur.
    Waiting(WaitKind),
    /// Claude a fini son tour et attend un prompt.
    Idle,
    /// Le tour s'est terminé sur une erreur (`StopFailure`).
    Error,
    /// La session est terminée (`SessionEnd`), avec la raison donnée par Claude Code.
    Stopped { reason: Option<String> },
}

impl SessionStatus {
    /// Genre d'attente, si la session attend une réponse.
    pub fn wait_kind(&self) -> Option<WaitKind> {
        match self {
            SessionStatus::Waiting(kind) => Some(*kind),
            _ => None,
        }
    }
}

/// Ce que la session attend.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WaitKind {
    /// Une autorisation d'outil.
    Permission,
    /// Une réponse à une question de Claude (`AskUserQuestion`, élicitation MCP).
    Question,
}

/// Contenu d'une demande en attente.
#[derive(Debug, Clone, PartialEq)]
pub enum Pending {
    Permission(PermissionPending),
    Question(QuestionPending),
    /// Attente connue seulement par une `Notification` (`permission_prompt`,
    /// `elicitation_dialog`) : on sait qu'une demande existe, pas laquelle.
    Undetailed(WaitKind),
}

impl Pending {
    pub fn kind(&self) -> WaitKind {
        match self {
            Pending::Permission(_) => WaitKind::Permission,
            Pending::Question(_) => WaitKind::Question,
            Pending::Undetailed(kind) => *kind,
        }
    }

    /// Vrai si la demande porte un outil et son entrée.
    pub fn is_detailed(&self) -> bool {
        !matches!(self, Pending::Undetailed(_))
    }

    /// Nom de l'outil concerné.
    pub fn tool_name(&self) -> Option<&str> {
        match self {
            Pending::Permission(p) => Some(&p.tool_name),
            Pending::Question(_) => Some(ASK_USER_QUESTION),
            Pending::Undetailed(_) => None,
        }
    }

    /// Entrée de l'outil telle que reçue par le hook.
    pub fn tool_input(&self) -> Option<&Value> {
        match self {
            Pending::Permission(p) => Some(&p.tool_input),
            Pending::Question(q) => Some(&q.tool_input),
            Pending::Undetailed(_) => None,
        }
    }
}

/// Nom de l'outil de Claude Code qui pose une question à l'utilisateur.
pub const ASK_USER_QUESTION: &str = "AskUserQuestion";

/// Demande d'autorisation d'un outil.
#[derive(Debug, Clone, PartialEq)]
pub struct PermissionPending {
    pub tool_name: String,
    pub tool_input: Value,
    /// `permission_suggestions` reçues avec la demande, brutes : la source de
    /// « Toujours » (voir [`crate::domain::decision::always_rules`]).
    pub suggestions: Vec<Value>,
}

/// Question posée par Claude avec `AskUserQuestion`.
#[derive(Debug, Clone, PartialEq)]
pub struct QuestionPending {
    /// Questions lues dans `tool_input.questions` (vide si illisible).
    pub questions: Vec<Question>,
    /// Entrée brute, à renvoyer complétée de `answers` (ADR 0003, point 5).
    pub tool_input: Value,
}

impl QuestionPending {
    /// Lit les questions dans le `tool_input` d'`AskUserQuestion`, sans échouer :
    /// une entrée mal formée donne une liste vide (la carte renvoie alors vers
    /// le terminal).
    pub fn from_tool_input(tool_input: &Value) -> Self {
        let questions = tool_input
            .get("questions")
            .and_then(Value::as_array)
            .map(|qs| qs.iter().filter_map(Question::from_value).collect())
            .unwrap_or_default();
        Self {
            questions,
            tool_input: tool_input.clone(),
        }
    }
}

/// Une question et ses options.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Question {
    pub question: String,
    pub header: Option<String>,
    pub options: Vec<QuestionOption>,
    pub multi_select: bool,
}

impl Question {
    fn from_value(v: &Value) -> Option<Self> {
        let question = v.get("question")?.as_str()?.to_owned();
        let options = v
            .get("options")
            .and_then(Value::as_array)
            .map(|os| {
                os.iter()
                    .filter_map(|o| {
                        Some(QuestionOption {
                            label: o.get("label")?.as_str()?.to_owned(),
                            description: o
                                .get("description")
                                .and_then(Value::as_str)
                                .map(str::to_owned),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        Some(Self {
            question,
            header: v.get("header").and_then(Value::as_str).map(str::to_owned),
            options,
            multi_select: v
                .get("multiSelect")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        })
    }
}

/// Une option de réponse.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuestionOption {
    pub label: String,
    pub description: Option<String>,
}

/// Mode de permission de Claude Code, tel que l'écrivent les hooks.
///
/// Le mode lancé avec `--permission-mode manual` apparaît comme `default`
/// dans les hooks (prototype n° 1, Q9) : les deux se lisent [`PermissionMode::Default`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PermissionMode {
    Default,
    AcceptEdits,
    Plan,
    Auto,
    BypassPermissions,
    /// Valeur inconnue, gardée telle quelle (le format peut évoluer).
    Other(String),
}

impl PermissionMode {
    /// Lit une valeur de `permission_mode` ; ne refuse jamais rien.
    pub fn parse(s: &str) -> Self {
        match s {
            "default" | "manual" => Self::Default,
            "acceptEdits" => Self::AcceptEdits,
            "plan" => Self::Plan,
            "auto" => Self::Auto,
            "bypassPermissions" => Self::BypassPermissions,
            other => Self::Other(other.to_owned()),
        }
    }

    /// Valeur telle qu'écrite par les hooks.
    pub fn as_str(&self) -> &str {
        match self {
            Self::Default => "default",
            Self::AcceptEdits => "acceptEdits",
            Self::Plan => "plan",
            Self::Auto => "auto",
            Self::BypassPermissions => "bypassPermissions",
            Self::Other(s) => s,
        }
    }

    /// Modes qui retirent les demandes de permission : jamais proposés sans
    /// réglage explicite du démon (`allow_dangerous_modes`).
    pub fn is_dangerous(&self) -> bool {
        matches!(self, Self::BypassPermissions) || self.as_str() == "dontAsk"
    }
}

/// Cycle de Shift+Tab dans la TUI, relevé avec Claude Code 2.1.303
/// (prototype n° 1, Q9) : `manual` → `accept edits` → `plan` → `auto` →
/// `manual`. Il peut changer d'une version à l'autre (ou selon les modes
/// disponibles) : `sessions.setMode` est un contournement, faute d'API.
pub const SHIFT_TAB_CYCLE: [PermissionMode; 4] = [
    PermissionMode::Default,
    PermissionMode::AcceptEdits,
    PermissionMode::Plan,
    PermissionMode::Auto,
];

/// Nombre de Shift+Tab pour passer du mode `current` au mode `target` le
/// long de [`SHIFT_TAB_CYCLE`] ; `None` si l'un des deux n'est pas sur le cycle.
pub fn shift_tab_steps(current: &PermissionMode, target: &PermissionMode) -> Option<usize> {
    let pos = |m: &PermissionMode| SHIFT_TAB_CYCLE.iter().position(|c| c == m);
    let (from, to) = (pos(current)?, pos(target)?);
    Some((to + SHIFT_TAB_CYCLE.len() - from) % SHIFT_TAB_CYCLE.len())
}

/// Indicateurs de mode du pied de la TUI, relevés avec **Claude Code
/// 2.1.303** : `⏸ manual mode on`, `⏵⏵ accept edits on (shift+tab to
/// cycle)`, `⏸ plan mode on (shift+tab to cycle)`, `⏵⏵ auto mode on
/// (shift+tab to cycle)`. Seuls les mots comptent (symboles et couleurs
/// peuvent changer). Les modes dangereux restent l'affaire des hooks.
const FOOTER_MODES: [(&str, PermissionMode); 4] = [
    ("manual mode on", PermissionMode::Default),
    ("accept edits on", PermissionMode::AcceptEdits),
    ("plan mode on", PermissionMode::Plan),
    ("auto mode on", PermissionMode::Auto),
];

/// Symboles de mode (famille lecture / pause) admis devant les mots du
/// pied : `⏸`, `⏵⏵`, `▶▶`… `⏺` (puce des réponses de Claude), `❯` (invite),
/// `│`, `•`, `-` ou `*` n'en sont pas.
const FOOTER_GLYPHS: &[char] = &['⏵', '⏩', '⏭', '⏯', '⏸', '▶', '▷', '▸', '▹', '►', '❚', '‖'];

/// Ligne de séparation du cadre de saisie de la TUI (`────…`, `╰───╯`).
fn is_separator(row: &str) -> bool {
    let t = row.trim();
    t.chars()
        .filter(|c| matches!(c, '─' | '━' | '═' | '╌' | '┄'))
        .count()
        >= 8
        && t.chars()
            .all(|c| matches!(c, '─' | '━' | '═' | '╌' | '┄' | '╭' | '╮' | '╰' | '╯' | ' '))
}

/// Position de `needle` (ASCII, en minuscules) dans `hay`, sans tenir compte
/// de la casse ASCII et sans allouer.
fn find_ascii_ci(hay: &str, needle: &str) -> Option<usize> {
    let (h, n) = (hay.as_bytes(), needle.as_bytes());
    (0..=h.len().checked_sub(n.len())?)
        .find(|&i| hay.is_char_boundary(i) && h[i..i + n.len()].eq_ignore_ascii_case(n))
}

/// Mode porté par une ligne de pied, ou `None`.
fn footer_line_mode(line: &str) -> Option<PermissionMode> {
    FOOTER_MODES.iter().find_map(|(words, mode)| {
        let at = find_ascii_ci(line, words)?;
        let before = line[..at].trim();
        let after = &line[at + words.len()..];
        // Avant : au moins un symbole de mode, et rien d'autre.
        let clean_before = !before.is_empty()
            && before
                .chars()
                .all(|c| c.is_whitespace() || FOOTER_GLYPHS.contains(&c));
        // Après : rien, ou un blanc suivi d'autre chose que du texte
        // (`(shift+tab to cycle)`, indications alignées à droite), jamais
        // « Plan mode on is now… ».
        let clean_after = after.chars().next().is_none_or(char::is_whitespace)
            && after
                .trim_start()
                .chars()
                .next()
                .is_none_or(|c| !c.is_alphanumeric());
        (clean_before && clean_after).then(|| mode.clone())
    })
}

/// Mode affiché par le pied de la TUI dans ces lignes d'écran (texte sans
/// mise en forme, de haut en bas), ou `None` s'il n'y est pas.
///
/// **Seule exception** au principe « le démon n'analyse pas le PTY »
/// (architecture § 6) : faute de hook quand Claude est inactif, c'est le seul
/// moyen de confirmer un `sessions.setMode`. Les hooks restent la source qui
/// fait foi.
///
/// - un indicateur ne compte que précédé d'un symbole de mode
///   ([`FOOTER_GLYPHS`]) et de rien d'autre sur sa ligne, puis suivi de rien
///   ou d'un blanc et d'autre chose qu'une lettre ou un chiffre ;
/// - s'il y a une ligne de séparation du cadre de saisie (`────…`), seules
///   les lignes en dessous de la dernière sont lues (le pied est sous le
///   cadre ; au-dessus, c'est la conversation) ;
/// - la ligne la plus basse qui porte un indicateur l'emporte.
pub fn mode_from_footer<S: AsRef<str>>(rows: &[S]) -> Option<PermissionMode> {
    let below = rows
        .iter()
        .rposition(|r| is_separator(r.as_ref()))
        .map_or(0, |i| i + 1);
    rows[below..]
        .iter()
        .rev()
        .find_map(|row| footer_line_mode(row.as_ref()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn footer_mode_is_read_from_the_words() {
        use PermissionMode::*;
        let cases = [
            ("⏸ manual mode on", Some(Default)),
            (
                "  ⏵⏵ accept edits on (shift+tab to cycle)",
                Some(AcceptEdits),
            ),
            ("⏸ plan mode on (shift+tab to cycle)", Some(Plan)),
            ("⏵⏵ auto mode on (shift+tab to cycle)", Some(Auto)),
            ("▶▶ Auto Mode On", Some(Auto)),
            ("⏸ plan mode on   · ◐ 3 %", Some(Plan)),
            ("auto mode on", None),
            ("> plan mode on", None),
            ("❯ plan mode on, puis…", None),
            ("│ ❯ auto mode on │", None),
            ("- auto mode on", None),
            ("* auto mode on", None),
            ("• auto mode on", None),
            ("⏺ Plan mode on is now active", None),
            ("⏺ plan mode on", None),
            ("│ > passe en plan mode on", None),
            ("le plan mode on du pied", None),
            ("⏸ plan mode online", None),
            ("⏸ plan mode on(", None),
            ("? for shortcuts", None),
            ("", None),
        ];
        for (line, expected) in cases {
            assert_eq!(mode_from_footer(&[line]), expected, "{line:?}");
        }
        // La ligne la plus basse l'emporte.
        assert_eq!(
            mode_from_footer(&["⏸ manual mode on", "texte", "⏸ plan mode on", ""]),
            Some(Plan)
        );
        assert_eq!(mode_from_footer::<&str>(&[]), None);
        // Sous le cadre de saisie seulement.
        let sep = "─".repeat(40);
        assert_eq!(
            mode_from_footer(&["⏸ plan mode on", sep.as_str(), "> ", sep.as_str(), "? aide"]),
            None
        );
        assert_eq!(
            mode_from_footer(&[
                "⏸ plan mode on",
                sep.as_str(),
                "> ",
                sep.as_str(),
                "  ⏵⏵ auto mode on (shift+tab to cycle)"
            ]),
            Some(Auto)
        );
        assert_eq!(find_ascii_ci("Éé PLAN mode on", "plan mode on"), Some(5));
        assert_eq!(find_ascii_ci("ab", "abc"), None);
    }

    #[test]
    fn title_color_and_display_name() {
        let id = Uuid::parse_str("1a2b3c4d-0000-4000-8000-000000000000").unwrap();
        let mut s = Session::new(id, "c", "/p", "/p", "default");
        assert_eq!(s.display_name(), "1a2b3c4d");
        s.note_prompt("/clear");
        s.note_prompt("   ");
        assert_eq!(s.first_prompt, None);
        let now = OffsetDateTime::UNIX_EPOCH;
        s.apply_hook(
            &hook(r#"{"session_id":"c","hook_event_name":"UserPromptSubmit","prompt":"Corrige\nle test"}"#),
            now,
        );
        s.apply_hook(
            &hook(
                r#"{"session_id":"c","hook_event_name":"UserPromptSubmit","prompt":"Autre chose"}"#,
            ),
            now,
        );
        assert_eq!(s.first_prompt.as_deref(), Some("Corrige\nle test"));
        assert_eq!(s.display_name(), "Corrige le test");
        s.metrics.session_name = Some("Correction du test".into());
        assert_eq!(s.display_name(), "Correction du test");
        s.title = Some("Mon titre".into());
        assert_eq!(s.display_name(), "Mon titre");

        assert_eq!(normalize_title("  Titre  "), Ok(Some("Titre".into())));
        assert_eq!(normalize_title("   "), Ok(None));
        assert_eq!(normalize_title(&"é".repeat(80)), Ok(Some("é".repeat(80))));
        assert_eq!(
            normalize_title(&"é".repeat(81)),
            Err(TitleError::TooLong(81))
        );
        assert_eq!(normalize_title("a\nb"), Err(TitleError::Control));
        for (bad, code) in [
            ("abc\u{202E}txt", 0x202E),
            ("a\u{200B}b", 0x200B),
            ("a\u{2028}b", 0x2028),
            ("a\u{2029}b", 0x2029),
            ("\u{FEFF}titre", 0xFEFF),
            ("a\u{2066}b", 0x2066),
        ] {
            assert_eq!(
                normalize_title(bad),
                Err(TitleError::Format(code)),
                "{bad:?}"
            );
        }
        assert_eq!(normalize_title("\u{200D}"), Ok(None));
        assert_eq!(normalize_title(" \u{3000} "), Ok(None));
        assert_eq!(
            normalize_title("👩\u{200D}💻 Refonte"),
            Ok(Some("👩\u{200D}💻 Refonte".into()))
        );
        assert!(is_session_color("violet"));
        assert!(!is_session_color("purple"));
    }

    fn hook(json: &str) -> HookEvent {
        HookEvent::parse(json, None).unwrap()
    }

    #[test]
    fn session_start_updates_claude_session_id_and_model() {
        let id = Uuid::nil();
        let mut s = Session::new(id, "a", "/p", "/p", "default");
        let now = OffsetDateTime::UNIX_EPOCH;
        s.apply_statusline(
            &Statusline::parse(
                r#"{"model":{"id":"m1","display_name":"M 1"},"cost":{"total_cost_usd":1}}"#,
            )
            .unwrap(),
        );
        // Même modèle : le nom affiché est gardé.
        s.apply_hook(
            &hook(r#"{"session_id":"a","hook_event_name":"SessionStart","source":"startup","model":"m1"}"#),
            now,
        );
        let model = s.metrics.model.clone().unwrap();
        assert_eq!(model.display_name.as_deref(), Some("M 1"));
        // /clear : nouveau session_id de Claude Code, identifiant interne inchangé.
        s.apply_hook(
            &hook(r#"{"session_id":"b","hook_event_name":"SessionStart","source":"clear","model":"m2"}"#),
            now,
        );
        assert_eq!(s.id, id);
        assert_eq!(s.claude_session_id, "b");
        let model = s.metrics.model.clone().unwrap();
        assert_eq!(model.id.as_deref(), Some("m2"));
        assert_eq!(model.display_name, None);
        // Les autres événements ne changent pas le session_id de Claude Code.
        s.apply_hook(
            &hook(r#"{"session_id":"zzz","hook_event_name":"Stop"}"#),
            now,
        );
        assert_eq!(s.claude_session_id, "b");
        assert_eq!(s.state.status(), SessionStatus::Idle);
        assert_eq!(s.metrics.cost_usd, Some(1.0));
    }

    #[test]
    fn manual_reads_as_default() {
        assert_eq!(PermissionMode::parse("manual"), PermissionMode::Default);
        assert_eq!(PermissionMode::parse("auto").as_str(), "auto");
        assert_eq!(
            PermissionMode::parse("nouveau"),
            PermissionMode::Other("nouveau".into())
        );
    }

    #[test]
    fn shift_tab_cycle() {
        use PermissionMode::*;
        assert_eq!(shift_tab_steps(&Default, &Default), Some(0));
        assert_eq!(shift_tab_steps(&Default, &AcceptEdits), Some(1));
        assert_eq!(shift_tab_steps(&Default, &Auto), Some(3));
        assert_eq!(shift_tab_steps(&Auto, &Default), Some(1));
        assert_eq!(shift_tab_steps(&Plan, &AcceptEdits), Some(3));
        assert_eq!(shift_tab_steps(&BypassPermissions, &Default), None);
        assert_eq!(shift_tab_steps(&Default, &BypassPermissions), None);
        assert_eq!(shift_tab_steps(&Other("dontAsk".into()), &Plan), None);
        assert!(BypassPermissions.is_dangerous());
        assert!(PermissionMode::parse("dontAsk").is_dangerous());
        assert!(!Auto.is_dangerous());
    }

    #[test]
    fn question_parsing_is_tolerant() {
        let q = QuestionPending::from_tool_input(&json!({
            "questions": [
                {"question": "A ou B ?", "header": "Choix", "multiSelect": true,
                 "options": [{"label": "A", "description": "a"}, {"label": 3}, {"label": "B"}]},
                {"header": "sans question"}
            ]
        }));
        assert_eq!(q.questions.len(), 1);
        let first = &q.questions[0];
        assert!(first.multi_select);
        assert_eq!(first.options.len(), 2);
        assert_eq!(first.options[1].description, None);

        assert!(
            QuestionPending::from_tool_input(&json!("n'importe quoi"))
                .questions
                .is_empty()
        );
    }
}
