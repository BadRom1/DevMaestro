/**
 * Types du protocole du démon `orchd` (docs/protocole.md, version 1),
 * partagés par le processus principal, le preload et la page.
 *
 * Principe : tout champ peut être `null` quand la donnée est inconnue.
 */

import type { WorktreeLocation } from './worktrees'

export const PROTOCOL_VERSION = 1

export type SessionState = 'starting' | 'running' | 'waiting' | 'idle' | 'error' | 'stopped'
export type WaitKind = 'permission' | 'question'

export interface SessionStatus {
  state: SessionState
  wait?: WaitKind | null
  reason?: string | null
}

export interface QuestionOption {
  label: string
  description?: string | null
}

export interface Question {
  question: string
  header?: string | null
  multi_select?: boolean | null
  options: QuestionOption[]
}

/** Règle proposée par Claude Code pour « Toujours » (forme libre, affichée telle quelle). */
export type PermissionSuggestion = unknown

export interface PermissionDemand {
  kind: 'permission'
  tool_name: string
  tool_input: unknown
  /** Suggestions de Claude Code (`permission_suggestions` du hook). */
  suggestions?: PermissionSuggestion[] | null
  /**
   * Règles que « Toujours » ajouterait réellement (sous-ensemble des
   * suggestions : `addRules`, `allow`, réglages du projet ou de
   * l'utilisateur). Vide : « Toujours » est refusé par le démon.
   */
  always_rules?: PermissionSuggestion[] | null
  detailed?: true
}

export interface QuestionDemand {
  kind: 'question'
  tool_name: string
  tool_input: unknown
  questions: Question[]
  detailed?: true
}

/** Demande connue seulement par une notification : pas de détail. */
export interface UndetailedDemand {
  kind: WaitKind
  detailed: false
}

export type Demand = PermissionDemand | QuestionDemand | UndetailedDemand

export interface PendingRequest {
  request_id: number
  /** Un relais `PermissionRequest` attend la décision : l'app peut répondre (absent = inconnu). */
  answerable?: boolean | null
  pending: Demand
  tool_use_id?: string | null
  agent_id?: string | null
  since?: string | null
  /** Certaines versions du démon portent les suggestions au niveau de la demande. */
  suggestions?: PermissionSuggestion[] | null
}

export interface RateLimitWindow {
  used_pct: number | null
  resets_at: string | null
}

export interface RateLimits {
  five_hour: RateLimitWindow | null
  seven_day: RateLimitWindow | null
}

export interface Metrics {
  model?: { id: string | null; display_name: string | null } | null
  cost_usd?: number | null
  context_used_pct?: number | null
  context_window_size?: number | null
  total_tokens?: number | null
  rate_limits?: RateLimits | null
  session_name?: string | null
}

export interface Session {
  id: string
  claude_session_id: string | null
  profile: string
  cwd: string
  project_root: string | null
  branch: string | null
  model: string | null
  mode: string | null
  status: SessionStatus
  pending: PendingRequest[]
  possibly_stale: boolean
  metrics: Metrics | null
  last_activity: string | null
  created_at: string | null
  updated_at: string | null
  alive: boolean
  pid: number | null
  last_exit: { code: number } | { signal: string } | null
  size: { cols: number; rows: number } | null
  /** Titre choisi par l'utilisateur (`sessions.update`) ; absent avec un démon plus ancien. */
  title?: string | null
  /** Premier prompt connu de la conversation (`null` : aucun encore) ; absent avec un démon plus ancien. */
  first_prompt?: string | null
  /** Couleur décorative choisie par l'utilisateur. */
  color?: SessionColor | null
  /**
   * Nom à afficher, calculé par le démon : titre, sinon `session_name` de
   * Claude Code, sinon premier prompt, sinon identifiant court. Absent avec
   * un démon plus ancien (voir `sessionDisplayName`).
   */
  display_name?: string
  /**
   * Arrêtée et reprenable : Claude Code a un transcript pour elle. Absent
   * avec un démon plus ancien (inconnu : la reprise reste proposée).
   */
  resumable?: boolean
  /** Raison pour laquelle la reprise est impossible (absent : démon plus ancien). */
  resume_blocker?: ResumeBlocker | null
  /** Sous-agents en cours (v0.2, lot 5) ; absent avec un démon plus ancien (0). */
  subagents_running?: number | null
  /** Sous-agents connus de la session (au plus les 100 derniers gardés). */
  subagents_total?: number | null
  /**
   * Identité du projet (dossier commun git) enregistrée au lancement (v0.2,
   * lot 6) : la session reste sous son projet même si son worktree a été
   * supprimé. Absent avec un démon plus ancien, `null` hors dépôt.
   */
  project_common_dir?: string | null
  /**
   * Activité dérivée des hooks (v0.3, lot 10) : « Claude écrit », outil,
   * sous-agents, compaction. Absent avec un démon plus ancien.
   */
  activity?: SessionActivity | null
  /** Issue liée au lancement (v0.3, lot 13a) ; absent avec un démon plus ancien. */
  issue?: IssueRef | null
  /** Runners vivants de la session (v0.3, lot 14a) ; absent avec un démon plus ancien. */
  runners_running?: number
  /**
   * Livraison et CI suivies par le démon (v0.3, lot 14b) : `null` tant que
   * `forge.sessionCi` ne l'a pas calculée ; absent avec un démon plus ancien.
   */
  delivery?: SessionDelivery | null
}

/* ---------- Livraison et CI (v0.3, lot 14b) ---------- */

/** Mode de livraison d'un projet : demande de fusion par l'agent, ou fusion directe (trunk-based). */
export type DeliveryMode = 'pr' | 'trunk'
export const DELIVERY_MODES: readonly DeliveryMode[] = ['pr', 'trunk']

/** `none` → `pr_open` → `merged`. */
export type DeliveryState = 'none' | 'pr_open' | 'merged'

/** Résumé gardé avec la session (`Session.delivery`). */
export interface SessionDelivery {
  mode: DeliveryMode
  state: DeliveryState
  pull: { number: number; url: string } | null
  ci: ChecksState
}

export type RunStatus = 'queued' | 'in_progress' | 'completed'

/** Exécution d'un workflow de CI (`forge.runs`). */
export interface Run {
  id: number
  name: string
  workflow: string | null
  status: RunStatus
  conclusion: string | null
  state: CheckRunState
  /** Page de l'exécution (non fiable : ouverte par la confirmation des liens). */
  url: string | null
  head_sha: string
  branch: string | null
  event: string | null
  created_at: string | null
  updated_at: string | null
}

/** Livraison et CI d'une session (`forge.sessionCi`). */
export interface SessionCi {
  mode: DeliveryMode
  delivery: DeliveryState
  pull: Pull | null
  /** Branche par défaut (« main »), si connue. */
  base_branch: string | null
  ci: ChecksSummary & { sha: string | null; runs: Run[]; truncated: boolean }
}

/** Job en échec d'une exécution. */
export interface RunFailedJob {
  name: string
  state: CheckRunState
  conclusion: string | null
  url: string | null
  failed_steps: string[]
}

/** Échec d'une exécution (`forge.runFailure`) : journaux nettoyés et bornés par le démon. */
export interface RunFailure {
  run: Run
  failed_jobs: RunFailedJob[]
  logs: { job: string; text: string; truncated: boolean }[]
  truncated: boolean
  in_progress: boolean
  /** Consigne tapée devant l'extrait (fixée par le démon). */
  instruction: string
  /** Texte collé à Claude, comme donnée ; `null` tant que l'exécution tourne. */
  excerpt: string | null
}

/* ---------- Forge (v0.3, lot 13a, ADR 0006) ---------- */

export type ForgeKind = 'github'

/** Premier message d'une session lancée depuis une issue : consigne tapée, contenu collé. */
export interface InitialMessage {
  instruction: string
  pasted?: string
}

/** Lien session ↔ issue, enregistré par le démon (`sessions.launch`, `Session.issue`). */
export interface IssueRef {
  number: number
  title: string
  url: string
}

/** État de la forge d'un projet (`forge.status`). */
export interface ForgeStatus {
  available: boolean
  kind: ForgeKind | null
  host: string | null
  /** « propriétaire/dépôt ». */
  repo: string | null
  /** Pourquoi la forge est indisponible, en français. */
  reason: string | null
  /** Capacités de la forge et du démon ; absentes avec un démon plus ancien. */
  capabilities?: ForgeCapabilities | null
}

export interface ForgeCapabilities {
  sub_issues?: boolean
  epics?: boolean
  review_comments?: boolean
  checks?: boolean
  /** Le démon sait taper une consigne puis coller un contenu au lancement (`sessions.launch` avec `initial`). */
  initial_prompt?: boolean
}

export type IssueState = 'open' | 'closed'
export const ISSUE_STATES: readonly IssueState[] = ['open', 'closed']
/** Filtre d'état de `forge.issues`. */
export type IssueStateFilter = IssueState | 'all'
export const ISSUE_STATE_FILTERS: readonly IssueStateFilter[] = ['open', 'closed', 'all']

export interface IssueLabel {
  name: string
  /** Couleur de la forge (« d73a4a », sans « # ») : non fiable, validée avant usage. */
  color: string | null
}

/** Étiquette du dépôt (`forge.labels`, lot 15) : contenu **non fiable** (nom nettoyé, couleur validée). */
export interface RepoLabel {
  name: string
  /** « d73a4a », sans « # » ; validée avant usage. */
  color: string | null
  description: string | null
}

export interface SubIssue {
  number: number
  title: string
  state: IssueState
}

/** Issue telle que la forge la donne : contenu **non fiable** (Markdown rendu sûr, liens par confirmation). */
export interface Issue {
  number: number
  title: string
  state: IssueState
  url: string
  author: string | null
  labels: IssueLabel[]
  assignees: string[]
  updated_at: string | null
  /** Markdown, 64 Kio au plus ; absent dans `forge.issues`. */
  body?: string | null
  /** Corps coupé par le démon. */
  truncated?: boolean | null
  /** Epic parent. */
  parent?: number | null
  sub_issues?: SubIssue[] | null
  sub_issues_summary?: { total: number; completed: number } | null
}

/* ---------- Forge : demandes de fusion, CI et revue (v0.3, lot 13b) ---------- */

export type PullState = 'open' | 'closed' | 'merged'
/** Filtre d'état de `forge.pulls`. */
export type PullStateFilter = PullState | 'all'
export const PULL_STATE_FILTERS: readonly PullStateFilter[] = ['open', 'merged', 'closed', 'all']

export type ReviewDecision = 'approved' | 'changes_requested' | 'review_required'

/** État résumé de la CI d'une demande de fusion. */
export type ChecksState = 'success' | 'failure' | 'pending' | 'none'
export const CHECKS_STATES: readonly ChecksState[] = ['success', 'failure', 'pending', 'none']

export function isChecksState(v: unknown): v is ChecksState {
  return (CHECKS_STATES as readonly unknown[]).includes(v)
}

export interface ChecksSummary {
  state: ChecksState
  total: number
  passed: number
  failed: number
  pending: number
}

export type CheckRunState = 'success' | 'failure' | 'pending' | 'skipped' | 'cancelled'

export interface CheckRun {
  name: string
  /** Workflow du job ; `null` : statut de commit (absent : démon plus ancien). */
  workflow?: string | null
  state: CheckRunState
  /** Page de la vérification sur la forge (non fiable : ouverte par la confirmation des liens). */
  url: string | null
  started_at: string | null
  completed_at: string | null
}

/** Demande de fusion (PR, MR) : contenu **non fiable**, comme une issue. */
export interface Pull {
  number: number
  title: string
  state: PullState
  draft: boolean
  url: string
  author: string | null
  head: { branch: string; sha: string }
  /** Propriétaire du dépôt de la tête (une fourche peut avoir le même nom de branche) ; absent : démon plus ancien. */
  head_owner?: string | null
  base: { branch: string }
  updated_at: string | null
  additions: number | null
  deletions: number | null
  changed_files: number | null
  review_decision: ReviewDecision | null
  checks: ChecksSummary | null
  labels: IssueLabel[]
  /** `forge.pull` seulement : Markdown, 64 Kio au plus. */
  body?: string | null
  truncated?: boolean | null
}

/** Fichier d'une demande de fusion ; `status` tel que donné par le démon (lettre de git ou mot de la forge). */
export interface PullFile {
  path: string
  old_path?: string | null
  status: string
  additions: number | null
  deletions: number | null
}

export interface ReviewThreadComment {
  author: string | null
  body: string
  created_at: string | null
}

/** Fil de revue existant (lecture seule). `line` absent : commentaire sur une version dépassée du diff. */
export interface ReviewThread {
  path: string
  line: number | null
  side: ReviewSide | null
  resolved: boolean
  /** Fil sur une version dépassée du diff. */
  outdated?: boolean
  comments: ReviewThreadComment[]
  /** Plus de 50 commentaires : les suivants sont sur la forge. */
  comments_truncated?: boolean
}

/** `forge.pull` : la demande complète. */
export interface PullDetail extends Pull {
  files: PullFile[]
  /** Liste des fichiers coupée (3 000 au plus, limite de l'API). */
  files_truncated?: boolean
  check_runs: CheckRun[]
  review_threads: ReviewThread[]
  /** Plus de 100 fils de revue : les suivants sont sur la forge. */
  review_threads_truncated?: boolean
}

/** Filtres de `forge.pulls`. */
export interface PullFilter {
  state?: PullStateFilter
  search?: string
  author?: '@me' | null
  limit?: number
}

export type ForgeReviewEvent = 'comment' | 'approve' | 'request_changes'
export const FORGE_REVIEW_EVENTS: readonly ForgeReviewEvent[] = ['comment', 'approve', 'request_changes']

/** Commentaire ligne à ligne d'une revue publiée sur la forge. */
export interface ForgeReviewComment {
  path: string
  line: number
  side: ReviewSide
  body: string
}

/** Paramètres de `forge.submitReview` (hors `root`) : exactement ce qui est publié. */
export interface ForgeReviewPayload {
  number: number
  expected_head_sha: string
  event: ForgeReviewEvent
  body: string
  comments: ForgeReviewComment[]
}

/** Filtres de `forge.issues`. */
export interface IssueFilter {
  state?: IssueStateFilter
  search?: string
  assignee?: '@me' | null
  /** Une étiquette (compatibilité avec un démon d'avant le lot 15). */
  label?: string
  /** Plusieurs étiquettes, toutes requises (lot 15). */
  labels?: string[]
  limit?: number
}

export type ActivityKind = 'idle' | 'prompt' | 'tool' | 'subagents' | 'compacting' | 'waiting'

export interface SessionActivity {
  kind: ActivityKind
  /** Nom de l'outil en cours (`kind: "tool"`). */
  tool?: string | null
  /** Début de l'activité (ISO 8601). */
  since?: string | null
}

/* ---------- Worktrees (v0.2, lot 6) ---------- */

/** Demande de worktree à la création d'une session (`sessions.launch`). */
export interface WorktreeRequest {
  branch: string
  /** Point de départ d'une branche nouvelle (défaut : branche de référence). */
  base?: string
  location: WorktreeLocation
  /** Chemin explicite, seulement pour `location: "custom"`. */
  path?: string
}

/** Worktree créé avec la session. */
export interface CreatedWorktree {
  path: string
  branch: string
  base: string | null
}

/**
 * `merged` : tête ancêtre de la référence ; `squashed` : contenu déjà intégré ;
 * `empty` : branche créée par l'app sans commit à elle (pas intégrée) ; `no` sinon.
 */
export type Integration = 'merged' | 'squashed' | 'empty' | 'no'

export interface WorktreeInfo {
  path: string
  branch: string | null
  head: string | null
  /** Worktree principal (jamais supprimé). */
  main: boolean
  locked: boolean
  prunable: boolean
  exists: boolean
  /** Modifications ou fichiers non suivis ; `null` si le dossier manque. */
  dirty: boolean | null
  /** Commits de la branche absents de la référence. */
  ahead: number | null
  /** `null` pour le principal ou sans branche. */
  integrated: Integration | null
  /** Sessions vivantes du démon dans ce worktree. */
  sessions_running: number
  /** `claude_desktop` : sous `<racine>/.claude/worktrees/` ; `devmaestro` : créé par le démon. */
  managed_by?: 'claude_desktop' | 'devmaestro' | null
}

export interface WorktreesList {
  /** Branche par défaut du dépôt. */
  default_branch: string | null
  /** Branche de référence retenue (« origin/main », « main »), base par défaut d'une nouvelle branche. */
  reference?: string | null
  root?: string
  common_dir?: string | null
  worktrees: WorktreeInfo[]
}

/** Réponse de `worktrees.remove`. */
export interface WorktreeRemoved {
  removed: boolean
  path: string
  branch: string | null
  /** `null` : suppression de la branche pas demandée ; `false` : refusée (voir `branch_error`). */
  branch_deleted: boolean | null
  branch_error: string | null
}

export type ResumeBlocker = 'transcript_missing' | 'cwd_missing'

export type Effect =
  | { type: 'notify_waiting'; request_id: number; pending: Demand }
  | {
      type: 'request_resolved'
      request_id: number
      how: 'answered' | 'answered_by_app' | 'failed' | 'denied' | 'superseded' | 'cleared'
    }
  | { type: 'clear_waiting' }
  | { type: 'possibly_stale'; request_ids: number[] }
  /** Premier message en deux temps (`initial`) tapé puis collé (lot 13a). */
  | { type: 'initial_prompt_sent' }
  /** Échec de l'envoi du premier message : la session tourne sans lui. */
  | { type: 'initial_prompt_failed'; reason?: string | null }

export interface Snapshot {
  cols: number
  rows: number
  cursor: { row: number; col: number; visible: boolean }
  ansi: string
  text: string
}

export interface Profile {
  name: string
  config_dir: string
  sets_config_dir_env: boolean
}

export interface ProjectInfo {
  path: string
  is_git: boolean
  /** Racine (dépôt ou dossier) ; `null` possible pour un dossier disparu sans ancêtre retenu. */
  root: string | null
  worktree_root: string | null
  common_dir: string | null
  branch: string | null
  name: string | null
  /** Le dossier existe (absent : démon plus ancien, supposé existant). */
  exists?: boolean
  /**
   * Dépôt déduit pour un dossier disparu (ancêtre existant le plus proche, ou
   * dépôt voisin `<dépôt>--<suffixe>` d'un worktree supprimé).
   */
  inferred?: boolean
}

export interface PastSession {
  claude_session_id: string
  transcript_path: string | null
  cwd: string | null
  git_branch: string | null
  first_prompt: string | null
  title: string | null
  first_timestamp: string | null
  last_timestamp: string | null
  message_count: number | null
  /** Nom à afficher, calculé par le démon (absent avec un démon plus ancien). */
  display_name?: string | null
  /** Le dossier de la session existe encore (absent : inconnu). */
  cwd_exists?: boolean | null
  /** Masquée par l'utilisateur (seulement avec `include_hidden`). */
  hidden?: boolean | null
  /** Dernière activité, si le démon la donne sous ce nom (sinon `last_timestamp`). */
  last_activity?: string | null
}

/** Fenêtre de quota telle que le démon la donne (`quotas.get`). */
export type QuotaSource = 'usage_api' | 'statusline'

export interface DaemonQuotaWindow {
  used_percentage: number | null
  resets_at: string | null
  /** Origine et date de cette fenêtre (le démon fusionne fenêtre par fenêtre). */
  source?: QuotaSource | null
  fetched_at?: string | null
}

export interface DaemonProfileQuota {
  five_hour: DaemonQuotaWindow | null
  seven_day: DaemonQuotaWindow | null
  /** Origine : API d'usage de Claude Code, ou dernière statusline reçue. */
  source: QuotaSource | null
  fetched_at: string | null
  /** Pourquoi la mesure manque (message du démon). */
  error: string | null
}

export interface QuotasReport {
  profiles: Record<string, DaemonProfileQuota>
}

/* ---------- Diff et relecture (v0.2, lot 1) ---------- */

export interface DiffBase {
  ref: string
  sha: string
  /** `merge_base` : départ de la branche ; `head` : pas de branche par défaut trouvée. */
  kind: 'merge_base' | 'head'
}

export type DiffStatus = 'A' | 'M' | 'D' | 'R' | '?'

export interface DiffFile {
  path: string
  old_path?: string | null
  status: DiffStatus
  /** `null` : non compté (fichiers non suivis au-delà des 200 premiers). */
  additions: number | null
  deletions: number | null
  binary: boolean
}

export interface DiffSummary {
  base: DiffBase | null
  files: DiffFile[]
  /** Liste coupée par le démon (trop de fichiers). */
  truncated?: boolean
  /** Fichiers ignorés parce que leur contenu n'est pas de l'UTF-8 (liste ou nombre). */
  skipped_non_utf8?: string[] | number | null
}

export interface DiffLine {
  kind: ' ' | '+' | '-'
  old_no: number | null
  new_no: number | null
  text: string
}

export interface DiffHunk {
  header: string
  old_start: number
  old_lines: number
  new_start: number
  new_lines: number
  lines: DiffLine[]
}

export interface FileDiff {
  hunks: DiffHunk[]
  binary: boolean
  too_large: boolean
}

export type ReviewSide = 'new' | 'old'

/** Commentaire sur une ligne du diff (sans `kind`, comme avant le lot 3 bis). */
export interface ReviewComment {
  path: string
  line: number
  side: ReviewSide
  text: string
}

/**
 * Commentaire sur des lignes d'un fichier (onglet Fichiers, lot 3 bis) : le
 * démon relit lui-même les lignes `line` à `line_end` (400 au plus) ; `text`
 * peut être vide (extrait sans remarque).
 */
export interface FileReviewComment {
  kind: 'file'
  path: string
  line: number
  line_end: number
  text: string
}

/** Commentaire sur une ligne du diff d'un commit (onglet Commits, v0.3 lot 9) : `sha` complet. */
export interface CommitReviewComment {
  kind: 'commit'
  sha: string
  path: string
  line: number
  side: ReviewSide
  text: string
}

export type AnyReviewComment = ReviewComment | FileReviewComment | CommitReviewComment

/* ---------- Historique des commits (v0.3, lot 9) ---------- */

/** `branch` : commits de la branche depuis la base du diff ; `recent` : derniers commits de `HEAD`. */
export type CommitRange = 'branch' | 'recent'
export const COMMIT_RANGES: readonly CommitRange[] = ['branch', 'recent']

export interface CommitInfo {
  /** Complet : 40 caractères (64 pour un dépôt SHA-256). */
  sha: string
  /** Premier parent d'abord ; vide pour un commit racine. */
  parents: string[]
  /** Nom de l'auteur seul. */
  author: string
  /** Date de l'auteur, ISO 8601 avec fuseau. */
  date: string
  subject: string
  /** Reste du message (coupé à 4 Kio par le démon). */
  body: string
  /**
   * Fichiers et lignes changés contre le premier parent ; `null` quand le
   * démon n'a pas calculé les compteurs (`stats: false`, dépôt volumineux).
   */
  files: number | null
  additions: number | null
  deletions: number | null
}

export interface CommitsList {
  range: CommitRange
  base: DiffBase | null
  /** `null` avant le premier commit. */
  head: string | null
  /** Du plus récent au plus ancien. */
  commits: CommitInfo[]
  /** Liste coupée : d'autres commits existent au-delà, ou réponse trop grosse. */
  truncated: boolean
  /** Compteurs calculés ; `false` : dépôt trop lent, compteurs `null`. Absent (ancien démon) : `true`. */
  stats?: boolean
}

export interface CommitDiffBase {
  ref: string
  sha: string
  /** `parent` : premier parent ; `root` : commit racine, contre l'arbre vide. */
  kind: 'parent' | 'root'
}

/** Même forme que `sessions.diff`, plus `sha` (base : le premier parent du commit). */
export interface CommitDiff extends Omit<DiffSummary, 'base'> {
  sha: string
  base: CommitDiffBase | null
}

/* ---------- Onglet Fichiers (v0.2, lot 3) ---------- */

export interface FileEntry {
  name: string
  /** Relatif à la racine de la session. */
  path: string
  kind: 'dir' | 'file' | 'symlink'
  size: number | null
  /** Marque « modifié » (même source que le diff), ou `null`. */
  changed: DiffStatus | null
}

export interface FilesList {
  root: string
  path: string
  entries: FileEntry[]
  truncated: boolean
}

/** Empreinte d'un fichier lu ou écrit (lot 7) : `sha256` du contenu, en hexadécimal minuscule. */
export interface FileVersion {
  size: number
  mtime_ns: number | string
  sha256: string
}

export interface FileContent {
  path: string
  size: number | null
  binary: boolean
  too_large: boolean
  content: string | null
  /** Empreinte du contenu lu (lot 7) : `null` si trop gros ; absente avec un démon plus ancien (pas d'édition). */
  version?: FileVersion | null
  /** Modifiable dans l'app (lot 7) ; absent avec un démon d'avant (déduit du reste). */
  editable?: boolean
  /** Raison, en français, quand `editable` est faux. */
  not_editable_reason?: string | null
}

/** Taille maximale d'un fichier écrit par `files.write` (octets UTF-8). */
export const MAX_FILE_WRITE_BYTES = 2 * 1024 * 1024

/* ---------- Sous-agents (v0.2, lot 5) ---------- */

export type SubagentStatus = 'running' | 'done' | 'failed' | 'interrupted'

/** Sous-agent lancé par la session (outil `Agent`). Champs inconnus à `null`. */
export interface Subagent {
  agent_id: string
  agent_type: string | null
  description: string | null
  model: string | null
  tool_use_id: string | null
  status: SubagentStatus
  started_at: string | null
  ended_at: string | null
  tool_count: number | null
  current_tool: string | null
  last_tool: string | null
  /** Dernier message de l'agent (`sessions.subagent` seulement), coupé à 64 Kio. */
  report?: string | null
  report_truncated?: boolean | null
  transcript_path: string | null
}

/* ---------- Vue conversation (v0.3, lots 10 à 12, ADR 0005) ---------- */

/** Champs communs à toutes les entrées normalisées par le démon. */
export interface EntryBase {
  /** Identifiant stable : un `upsert` du même `uid` remplace l'entrée. */
  uid: string
  ts: string | null
  /** Numéro du segment (`/clear` en ouvre un nouveau). */
  segment: number
  /** Entrée d'un sous-agent (lue par `conversation.subagent`). */
  agent_id?: string | null
}

export type PromptSource = 'typed' | 'queued' | 'suggestion' | 'system' | 'sdk'

export interface PromptEntry extends EntryBase {
  kind: 'prompt'
  text: string
  source: PromptSource | string
  /** Collages extraits ; `text` les remplace par le repère `[collage <id>]`. */
  pasted?: { id: string; text: string }[] | null
  /**
   * `promptId` du transcript (celui du `UserPromptSubmit`). Limite : le front
   * ne connaît pas encore celui du prompt qu'il envoie (`sessions.sendPrompt`
   * ne le rend pas) ; il rapproche son envoi par le texte.
   */
  prompt_id?: string | null
  truncated?: boolean | null
}

export interface TextEntry extends EntryBase {
  kind: 'text'
  markdown: string
  truncated?: boolean | null
}

/** Repère seul : le contenu des réflexions n'est jamais conservé. */
export interface ThinkingEntry extends EntryBase {
  kind: 'thinking'
}

export type ToolResultStatus = 'ok' | 'error' | 'interrupted'

export interface ToolResult {
  status: ToolResultStatus | string
  text: string
  truncated?: boolean | null
  /**
   * Hunks d'un `Edit` / `Write` (depuis `structuredPatch`) : forme `DiffHunk`
   * du protocole, ou forme brute de Claude Code (`oldStart`, `lines: ["+…"]`),
   * lue avec tolérance (`patchHunks`).
   */
  patch?: unknown
}

export interface ToolEntry extends EntryBase {
  kind: 'tool'
  tool_use_id: string
  name: string
  summary: string
  input: unknown
  /** Entrée coupée par le démon (64 Kio) : `conversation.full` avec `part: "input"`. */
  input_truncated?: boolean | null
  /** Absent tant que l'outil n'a pas rendu son résultat. */
  result?: ToolResult | null
}

export interface QuestionEntry extends EntryBase {
  kind: 'question'
  tool_use_id: string
  /** Questions d'`AskUserQuestion` (forme de Claude Code : `question`, `header`, `options`, `multiSelect`). */
  questions: unknown
  /** Réponses choisies (question → libellé ou texte libre) ; absent tant que la question est ouverte. */
  answers?: unknown
}

export interface SubagentEntry extends EntryBase {
  kind: 'subagent'
  tool_use_id: string
  /**
   * Agent **lancé** par cet appel (`null` tant qu'il n'est pas connu) : pas le
   * fil qui porte l'entrée, contrairement aux autres genres.
   */
  agent_id: string | null
  /** Sous-agent lancé par un sous-agent : l'agent dont le fichier porte l'entrée. */
  parent_agent_id?: string | null
  agent_type: string | null
  description: string | null
  status: SubagentStatus | string | null
}

export interface NotificationEntry extends EntryBase {
  kind: 'notification'
  task_id: string | null
  status: string | null
  summary: string | null
  truncated?: boolean | null
}

export interface CompactionEntry extends EntryBase {
  kind: 'compaction'
  trigger: string | null
  pre_tokens: number | null
  post_tokens: number | null
  summary: string | null
  truncated?: boolean | null
}

export interface CommandEntry extends EntryBase {
  kind: 'command'
  /** `/compact`, `/model`… ; mode bash de la TUI : `!`. */
  name: string
  args: string | null
  output: string | null
  truncated?: boolean | null
  /** `/clear` qui ouvre un segment : le séparateur le remplace, l'entrée n'est pas affichée. */
  hidden_by_segment?: boolean | null
}

export interface ErrorEntry extends EntryBase {
  kind: 'error'
  message: string
  truncated?: boolean | null
}

export interface UnknownEntry extends EntryBase {
  kind: 'unknown'
  type: string | null
  subtype: string | null
}

export type ConversationEntry =
  | PromptEntry
  | TextEntry
  | ThinkingEntry
  | ToolEntry
  | QuestionEntry
  | SubagentEntry
  | NotificationEntry
  | CompactionEntry
  | CommandEntry
  | ErrorEntry
  | UnknownEntry

export type EntryKind = ConversationEntry['kind']

export interface ConversationSegment {
  segment: number
  claude_session_id: string | null
  reason: 'start' | 'clear' | 'resume' | string
  started_at: string | null
}

export interface ConversationPage {
  segments: ConversationSegment[]
  /** Ordre chronologique ; les `limit` plus récentes avant `before`. */
  entries: ConversationEntry[]
  has_more: boolean
  invalid_lines?: number | null
}

export type FullPart = 'input' | 'result' | 'text'
export const FULL_PARTS: readonly FullPart[] = ['input', 'result', 'text']

export type PermissionDecision = 'allow' | 'allow_always' | 'deny'
/** Modes que l'app sait demander (`sessions.setMode`). */
export type SettableMode = 'default' | 'acceptEdits' | 'plan' | 'auto'
export const SETTABLE_MODES: readonly SettableMode[] = ['default', 'acceptEdits', 'plan', 'auto']

/** Couleurs proposées pour une session (palette décorative, protocole § 4). */
export type SessionColor = 'gris' | 'bleu' | 'vert' | 'jaune' | 'orange' | 'rouge' | 'violet' | 'rose'
export const SESSION_COLORS: readonly SessionColor[] = ['gris', 'bleu', 'vert', 'jaune', 'orange', 'rouge', 'violet', 'rose']
/** Longueur maximale d'un titre de session (en caractères). */
export const MAX_TITLE = 80

/** Réponses à une question : libellé, liste de libellés (choix multiple) ou texte libre. */
export type QuestionAnswers = Record<string, string | string[]>

/* ---------- Runners (v0.3, lot 14a) ---------- */

/** Type d'un runner, déduit du nom du script par le démon. */
export type RunnerKind = 'dev' | 'test' | 'build' | 'lint' | 'other'
export const RUNNER_KINDS: readonly RunnerKind[] = ['dev', 'test', 'build', 'lint', 'other']

/**
 * Commande détectée dans le worktree d'une session (`package.json`,
 * `Makefile`, `justfile`, `Cargo.toml`…). Jamais une commande libre : seule
 * une commande détectée par le démon peut être lancée.
 */
export interface Runner {
  id: string
  label: string
  kind: RunnerKind
  /** Arguments tels qu'exécutés (affichés à l'utilisateur avant le lancement). */
  command: string[]
  /** Dossier relatif au worktree (`""` ou `"."` : la racine). */
  cwd: string
  /** Origine : `fichier:clé` (ex. `package.json:scripts.dev`). */
  source: string
  /**
   * Contenu réellement exécuté (corps du script, de la cible, de la recette),
   * 4 Kio au plus ; texte du dépôt, non fiable : affiché tel quel, en code.
   */
  body?: string | null
  /** Extrait `body` coupé (la suite n'est pas montrée). */
  body_truncated?: boolean
  /**
   * Fichiers lus en entier pour l'empreinte : toute modification de l'un
   * d'eux redemande la confirmation ; absent d'un démon plus ancien.
   */
  files?: RunnerFile[]
  /**
   * Empreinte du démon (SHA-256 de la commande, du dossier, de la source, du
   * corps et du verrou) : la confirmation porte sur elle ; absente d'un démon
   * plus ancien (lancement refusé).
   */
  fingerprint?: string
}

export type RunnerFileState = 'ok' | 'absent' | 'outside' | 'too_large' | 'unresolved'

/** Fichier pris en compte par l'empreinte d'un runner (chemin relatif au worktree ; texte du dépôt, non fiable). */
export interface RunnerFile {
  path: string
  size: number | null
  state: RunnerFileState
  note: string | null
}

export type RunnerState = 'running' | 'exited'

/** Exécution d'un runner (protocole § 4, « Runners et aperçu web »). */
export interface RunnerProcess {
  process_id: string
  runner_id: string
  session_id: string
  port: number | null
  started_at: string
  state: RunnerState
  exit_code: number | null
  /** Adresses locales repérées dans la sortie (http://localhost:…, 127.0.0.1, [::1]). */
  urls: string[]
}

export interface RunnersList {
  runners: Runner[]
  running: RunnerProcess[]
}

/** Origine d'une slash command (lot 17). */
export const COMMAND_SOURCES = ['builtin', 'project', 'user', 'plugin'] as const
export type CommandSource = (typeof COMMAND_SOURCES)[number]

/** Une slash command proposée (`commands.list`, ou liste intégrée de l'app). */
export interface SlashCommand {
  /** Nom sans le `/` (`compact`, `front:test`, `forge:forge-grill`). */
  name: string
  description?: string
  argument_hint?: string
  /** Autres noms reconnus (intégrées). */
  aliases?: string[]
  source: CommandSource
  kind: 'command' | 'skill'
  /** Ouvre une interface dans la TUI : à utiliser dans le terminal. */
  interactive?: boolean
  /** Plugin d'origine. */
  plugin?: string
  /**
   * Reprend le nom (ou un alias) d'une intégrée, ou le nom d'une commande de
   * plugin : gardée à côté de l'originale, jamais à sa place.
   */
  conflict?: 'builtin' | 'plugin'
}

export interface CommandsList {
  commands: SlashCommand[]
  /** Version de Claude Code de référence de la liste intégrée. */
  claude_code_version: string
  /** Un fichier qui pouvait donner une commande a été écarté (bornes). */
  truncated: boolean
  /** Fichiers ignorés pour leur nom (non ASCII, espaces, trop profond…). */
  ignored?: number
}


/* ---------- Plugins (v0.3, lot 22a, ADR 0007) ---------- */

/** Permissions qu'un manifeste peut demander (liste fermée). */
export const PLUGIN_PERMISSIONS = ['diff.read', 'worktree.read', 'worktree.write', 'sessions.read', 'claude.propose', 'network'] as const
export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number]

/** Texte d'un manifeste dans les deux langues. */
export interface LocalizedText {
  fr: string
  en: string
}

export type PluginAcceptance = 'none' | 'accepted' | 'changed'
export type PluginProcessState = 'stopped' | 'running' | 'failed'
/** Raisons de défaillance d'un processus de plugin (`-32033`). */
export type PluginFailureReason = 'launch' | 'timeout' | 'closed' | 'line_too_long' | 'not_json' | 'protocol' | 'flood' | 'error'

export interface PluginActionInfo {
  id: string
  label: LocalizedText
  propose: boolean
}

/** Plugin tel que `plugins.list` le décrit (manifeste relu à chaque appel). */
export interface PluginInfo {
  name: string
  valid: boolean
  /** Erreurs du manifeste (en français, texte du démon). */
  errors: string[]
  version?: string
  label?: LocalizedText
  description?: LocalizedText
  command?: string[]
  files?: string[]
  permissions: string[]
  tab?: { label: LocalizedText }
  actions: PluginActionInfo[]
  /** `config` du manifeste (fait partie de l'empreinte) ; absent d'un démon qui ne le donne pas. */
  config?: unknown
  /** Empreinte sha256 (hex 64) ; `null` : manifeste invalide. */
  fingerprint: string | null
  acceptance: PluginAcceptance
  accepted_fingerprint?: string
  accepted_permissions?: string[]
  process: { state: PluginProcessState; reason?: string; message?: string; stderr_tail?: string }
}

export interface PluginsList {
  dir: string
  plugins: PluginInfo[]
}

/** Valeur d'un argument d'action (document ou appel). */
export type PluginArgValue = string | number | boolean
export type PluginArgs = Record<string, PluginArgValue>

/** Document déclaratif (forme reçue ; l'app le revalide avant tout rendu, voir `pluginDocument.ts`). */
export type PluginDocumentRaw = unknown

/** Résultat de `plugins.action` : au moins l'un des deux. */
export interface PluginActionResult {
  document?: PluginDocumentRaw
  propose?: { content: string }
}

/** Paramètres et résultats des méthodes appelables depuis la page. */
export interface Methods {
  'profiles.list': { params: Record<string, never>; result: { profiles: Profile[] } }
  'projects.resolve': { params: { path: string }; result: ProjectInfo }
  'sessions.list': { params: Record<string, never>; result: { sessions: Session[] } }
  'sessions.get': { params: { id: string }; result: { session: Session } }
  'sessions.launch': {
    params: {
      cwd: string
      profile?: string
      model?: string
      mode?: string
      prompt?: string
      cols?: number
      rows?: number
      /** Créer un worktree puis lancer la session dedans (lot 6 ; ignoré par un démon plus ancien). */
      worktree?: WorktreeRequest
      /** Issue d'origine (lot 13a ; ignorée par un démon plus ancien). */
      issue?: IssueRef
      /**
       * Premier message en deux temps (lot 13a), exclusif avec `prompt` : le
       * démon lance claude sans prompt puis, la TUI prête, **tape**
       * `instruction` et **colle** `pasted` en *bracketed paste* (architecture § 9).
       */
      initial?: InitialMessage
    }
    /** `warnings` : messages du démon en français (mode dangereux remplacé…). */
    result: { session: Session; warnings?: string[]; worktree?: CreatedWorktree | null }
  }
  'sessions.resume': {
    params:
      | { id: string; profile?: string; mode?: string; model?: string; prompt?: string; cols?: number; rows?: number }
      | {
          claude_session_id: string
          cwd?: string
          profile?: string
          mode?: string
          model?: string
          prompt?: string
          cols?: number
          rows?: number
        }
    result: { session: Session; warnings?: string[] }
  }
  'sessions.resize': { params: { id: string; cols: number; rows: number }; result: { cols: number; rows: number } }
  'sessions.stop': { params: { id: string }; result: { stopping: boolean; alive: boolean } }
  'sessions.update': {
    params: { id: string; title?: string | null; color?: SessionColor | null }
    result: { session: Session }
  }
  'sessions.forget': { params: { id: string }; result: { forgotten: boolean } }
  'sessions.setMode': { params: { id: string; mode: SettableMode }; result: { sent: unknown } }
  'sessions.answerPermission': {
    params: { id: string; request_id: number; decision: PermissionDecision; message?: string }
    result: unknown
  }
  'sessions.answerQuestion': {
    params: { id: string; request_id: number; answers: QuestionAnswers }
    result: unknown
  }
  'transcripts.list': {
    /** `exclude_known` (`true` par défaut) : `false` garde les conversations des sessions du démon (lot 15 ter). */
    params: { profile?: string; limit?: number; include_hidden?: boolean; exclude_known?: boolean }
    result: { profile: string; sessions: PastSession[] }
  }
  'sessions.diff': { params: { id: string }; result: DiffSummary }
  'sessions.diffFile': { params: { id: string; path: string }; result: FileDiff }
  'sessions.sendReview': {
    /** `instruction` (lot 18) : consigne tapée personnalisée ; absente, celle du démon. */
    params: { id: string; comments: AnyReviewComment[]; general?: string; instruction?: string }
    result: unknown
  }
  /** Commits de la session (`range` absent : choix automatique du démon). */
  'sessions.commits': { params: { id: string; limit?: number; range?: CommitRange }; result: CommitsList }
  'sessions.commitDiff': { params: { id: string; sha: string }; result: CommitDiff }
  'sessions.commitDiffFile': { params: { id: string; sha: string; path: string }; result: FileDiff }
  /** Texte tapé dans la session (sans Entrée), ex. « @chemin » pour mentionner un fichier. */
  'sessions.input': { params: { id: string; data: string }; result: unknown }
  'files.list': { params: { id: string; path?: string }; result: FilesList }
  'files.read': { params: { id: string; path: string }; result: FileContent }
  /**
   * Écriture d'un fichier texte (lot 7) : `expected` est l'empreinte de la
   * version ouverte (`null` : création d'un fichier qui n'existe pas).
   * Conflit : `-32021`, `data: {version}` (version actuelle).
   */
  'files.write': {
    params: { id: string; path: string; content: string; expected: { sha256: string } | null }
    result: { version: FileVersion }
  }
  /** Sous-agents de la session, par ordre de lancement, sans `report`. */
  'sessions.subagents': { params: { id: string }; result: { agents: Subagent[] } }
  /** Un sous-agent avec son `report`. */
  'sessions.subagent': { params: { id: string; agent_id: string }; result: Subagent }
  'quotas.get': { params: { refresh?: boolean }; result: QuotasReport }
  'transcripts.hide': { params: { profile: string; claude_session_id: string }; result: { hidden: boolean } }
  'transcripts.unhide': { params: { profile: string; claude_session_id: string }; result: { hidden: boolean } }
  /** Worktrees d'un dépôt connu (`root` : racine donnée par `projects.resolve`). */
  'worktrees.list': { params: { root: string }; result: WorktreesList }
  /** Conversation de la session (lot 10) : les `limit` entrées les plus récentes avant `before`. */
  'conversation.get': { params: { id: string; before?: string; limit?: number }; result: ConversationPage }
  /** Même forme, pour le fichier d'un sous-agent. */
  'conversation.subagent': {
    params: { id: string; agent_id: string; before?: string; limit?: number }
    result: ConversationPage
  }
  /** Contenu entier d'une entrée tronquée (4 Mio au plus). */
  'conversation.full': { params: { id: string; uid: string; part: FullPart }; result: { text: string; truncated?: boolean } }
  /**
   * Prompt envoyé à la session (lot 12) : tapé ou collé, puis Entrée. Ou, en
   * deux temps (lot 14b) : `instruction` tapée, `pasted` collé comme donnée.
   */
  'sessions.sendPrompt': {
    params: { id: string; text: string } | { id: string; instruction: string; pasted?: string }
    result: unknown
  }
  'worktrees.remove': {
    params: { root: string; path: string; delete_branch: boolean; force: boolean }
    result: WorktreeRemoved
  }
  /**
   * Forge du projet (lot 13a). `enabled` (réglage « Accès aux forges ») est
   * ajouté par le processus principal, jamais pris de la page.
   */
  'forge.status': { params: { root: string; refresh?: boolean }; result: ForgeStatus }
  /** Issues du projet, sans corps ; `limit` 50 par défaut, 200 au plus. */
  'forge.issues': { params: { root: string; refresh?: boolean } & IssueFilter; result: { issues: Issue[]; truncated: boolean } }
  /** Étiquettes du dépôt (lot 15), pour le filtre ; cache de 5 min côté démon. */
  'forge.labels': { params: { root: string; refresh?: boolean }; result: { labels: RepoLabel[] } }
  /** Une issue complète, sous-issues comprises. */
  'forge.issue': { params: { root: string; number: number; refresh?: boolean }; result: Issue }
  /** Demandes de fusion du projet, sans corps (lot 13b). */
  'forge.pulls': { params: { root: string; refresh?: boolean } & PullFilter; result: { pulls: Pull[]; truncated: boolean } }
  /** Une demande complète : fichiers, vérifications de CI, fils de revue existants. */
  'forge.pull': { params: { root: string; number: number; refresh?: boolean }; result: PullDetail }
  /** Hunks du diff de la demande pour un fichier de `files`. */
  'forge.pullFile': { params: { root: string; number: number; path: string; refresh?: boolean }; result: FileDiff }
  /** Demande ouverte dont la tête est cette branche, ou `null`. */
  'forge.pullForBranch': { params: { root: string; branch: string; refresh?: boolean }; result: Pull | null }
  /** Exécutions de CI du dépôt (lot 14b) ; `limit` 20 par défaut, 100 au plus. */
  'forge.runs': {
    params: { root: string; branch?: string; sha?: string; limit?: number; refresh?: boolean }
    result: { runs: Run[]; truncated: boolean }
  }
  /** Jobs en échec d'une exécution et extrait borné de leurs journaux (lecture seule). */
  'forge.runFailure': { params: { root: string; run_id: number; refresh?: boolean }; result: RunFailure }
  /**
   * Réglage « Accès aux forges » transmis par le processus principal (jamais
   * par la page) : coupé, le démon arrête le sondage de la CI.
   */
  'forge.configure': { params: { enabled: boolean }; result: unknown }
  /** Livraison et CI d'une session ; démarre son suivi (`forge.ci_changed`). */
  'forge.sessionCi': { params: { id: string; mode?: DeliveryMode; refresh?: boolean }; result: SessionCi }
  /**
   * Publie une revue sur la forge (seule écriture). Appelée **uniquement**
   * depuis le bouton « Publier » du dialogue de confirmation (ADR 0006, point 5).
   */
  'forge.submitReview': { params: { root: string } & ForgeReviewPayload; result: { url: string | null } }
  /**
   * Slash commands proposées dans le champ de saisie (lot 17) : intégrées,
   * utilisateur, projet, plugins activés. Démon sans la capacité
   * `slash_commands` : `-32601`.
   */
  'commands.list': { params: { id: string }; result: CommandsList }
  /** Runners détectés dans le worktree de la session, et ceux qui tournent (lot 14a). */
  'runners.list': { params: { id: string }; result: RunnersList }
  /** Lance un runner détecté (jamais une commande libre). */
  /**
   * `expected_fingerprint` : ajouté par le processus principal (empreinte
   * acceptée par l'utilisateur), jamais pris de la page ; détection fraîche
   * différente → `-32024`.
   */
  'runners.start': { params: { id: string; runner_id: string; expected_fingerprint?: string }; result: RunnerProcess }
  /** Arrête une exécution (SIGTERM au groupe, SIGKILL après 3 s). */
  'runners.stop': { params: { id: string; process_id: string }; result: unknown }
  /** Plugins installés (lot 22a) : manifestes relus, empreintes, accords, état des processus. */
  'plugins.list': { params: Record<string, never>; result: PluginsList }
  /**
   * Accord (processus principal seulement, canal `acceptPlugin`) : jamais
   * appelable depuis la page. Empreinte différente : `-32032`.
   */
  'plugins.accept': { params: { name: string; expected_fingerprint: string }; result: { plugin: PluginInfo } }
  /** Révocation (processus principal seulement, canal `revokePlugin`). */
  'plugins.revoke': { params: { name: string }; result: { plugin: PluginInfo | null } }
  /**
   * Panneau d'un plugin pour une session. `expected_fingerprint` : ajouté par
   * le processus principal (empreinte acceptée), jamais pris de la page.
   */
  'plugins.panel': {
    params: { name: string; session_id: string; locale: 'fr' | 'en'; expected_fingerprint?: string }
    result: { document: PluginDocumentRaw }
  }
  /** Action d'un plugin ; même règle pour `expected_fingerprint`. */
  'plugins.action': {
    params: { name: string; action: string; session_id: string; locale: 'fr' | 'en'; args?: PluginArgs; expected_fingerprint?: string }
    result: PluginActionResult
  }
}

/** Méthodes de la forge : le processus principal y ajoute `enabled` (réglage global). */
export const FORGE_METHODS: readonly MethodName[] = [
  'forge.status',
  'forge.issues',
  'forge.labels',
  'forge.issue',
  'forge.pulls',
  'forge.pull',
  'forge.pullFile',
  'forge.pullForBranch',
  'forge.runs',
  'forge.runFailure',
  'forge.sessionCi',
  'forge.submitReview',
]

export type MethodName = keyof Methods

/** Méthodes que la page a le droit d'appeler (le reste passe par le processus principal). */
export const RENDERER_METHODS: readonly MethodName[] = [
  'profiles.list',
  'projects.resolve',
  'sessions.list',
  'sessions.get',
  'sessions.launch',
  'sessions.resume',
  'sessions.resize',
  'sessions.stop',
  'sessions.setMode',
  'sessions.update',
  'sessions.forget',
  'sessions.answerPermission',
  'sessions.answerQuestion',
  'transcripts.list',
  'transcripts.hide',
  'transcripts.unhide',
  'quotas.get',
  'sessions.diff',
  'sessions.diffFile',
  'sessions.sendReview',
  'sessions.commits',
  'sessions.commitDiff',
  'sessions.commitDiffFile',
  'files.list',
  'files.read',
  'files.write',
  'sessions.input',
  'sessions.subagents',
  'sessions.subagent',
  'worktrees.list',
  'worktrees.remove',
  'conversation.get',
  'conversation.subagent',
  'conversation.full',
  'sessions.sendPrompt',
  'commands.list',
  'forge.status',
  'forge.issues',
  'forge.labels',
  'forge.issue',
  'forge.pulls',
  'forge.pull',
  'forge.pullFile',
  'forge.pullForBranch',
  'forge.runs',
  'forge.runFailure',
  'forge.sessionCi',
  'forge.submitReview',
  'runners.list',
  'runners.start',
  'runners.stop',
  // Plugins (lot 22a) : pas `plugins.accept` ni `plugins.revoke` (canaux dédiés du processus principal).
  'plugins.list',
  'plugins.panel',
  'plugins.action',
]

/** Codes d'erreur JSON-RPC du démon (protocole § 3). */
export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  Internal: -32603,
  UnknownSession: -32001,
  InvalidState: -32002,
  UnknownProfile: -32003,
  LaunchFailed: -32004,
  /** `worktrees.remove` : une session tourne dans ce worktree. */
  WorktreeBusy: -32019,
  /** `worktrees.remove` sans `force` : modifications non commitées (`data` : liste courte des fichiers). */
  WorktreeDirty: -32020,
  /** `files.write` : le fichier a changé depuis son ouverture (`data` : `{version}` actuelle). */
  FileChanged: -32021,
  /** `forge.*` : forge indisponible (`gh` absent ou non connecté, dépôt non GitHub, désactivé) ; `data: {reason}`. */
  ForgeUnavailable: -32022,
  /** `forge.submitReview` : la tête de la demande a changé depuis sa lecture ; `data: {head_sha}`. */
  PullChanged: -32023,
  /** `runners.start` : runner absent de la détection actuelle, ou commande changée depuis sa confirmation. */
  RunnerUnknown: -32024,
  /** `runners.start` : 8 runners vivants pour la session. */
  TooManyRunners: -32025,
  /** `runners.*` : exécution inconnue, ou d'une autre session. */
  RunnerProcessUnknown: -32026,
  /** `plugins.*` : plugin inconnu ou manifeste invalide. */
  PluginUnknown: -32030,
  /** `plugins.panel` / `plugins.action` : pas accepté, ou modifié depuis l'accord ; `data: {acceptance, fingerprint}`. */
  PluginNotAccepted: -32031,
  /** Empreinte différente de `expected_fingerprint` ; `data: {fingerprint}`. */
  PluginFingerprintMismatch: -32032,
  /** Défaillance du processus du plugin ; `data: {reason, stderr_tail?}`. */
  PluginFailed: -32033,
  /** Document ou résultat invalide, ou permission refusée ; `data: {problem}`. */
  PluginInvalidOutput: -32034,
  /**
   * Côté app (hors protocole) : `runners.start` refusé par le processus
   * principal tant que l'utilisateur n'a pas accepté cette commande dans ce
   * worktree ; `data` : `RunnerConfirmation`.
   */
  RunnerConfirmationRequired: -3,
  /** Côté client : délai dépassé, connexion perdue (hors protocole). */
  Timeout: -1,
  Disconnected: -2,
} as const

export type Notification =
  | { method: 'session.updated'; params: { session: Session } }
  | { method: 'session.effect'; params: { id: string; effect: Effect } }
  | { method: 'session.resync'; params: { id: string; snapshot: Snapshot } }
  /** Session retirée de la liste du démon (`sessions.forget`). */
  | { method: 'session.removed'; params: { id: string } }
  /** Quotas mis à jour par le démon (même forme que `quotas.get`). */
  | { method: 'quotas.updated'; params: QuotasReport }
  /** Les fichiers changés d'une session ont changé (liste ou compteurs). */
  | { method: 'session.diff_changed'; params: { id: string } }
  /** Sous-agents de la session : liste complète, sans `report`. */
  | { method: 'session.subagents_changed'; params: { id: string; agents: Subagent[] } }
  /** Les worktrees d'un dépôt ont changé (création, suppression, intégration, modifications). */
  | { method: 'project.worktrees_changed'; params: { root: string } }
  /**
   * Conversation d'une session (lot 10), regroupée toutes les 100 ms : un
   * `upsert` d'un `uid` connu remplace l'entrée ; `segment_started` : `/clear`.
   */
  | {
      method: 'conversation.changed'
      params: { id: string; upserts: ConversationEntry[]; segment_started?: ConversationSegment | null }
    }
  /** Runners d'une session changés (lancement, fin, URL repérée) : `running`, la liste à jour. */
  | { method: 'runners.changed'; params: { id: string; running: RunnerProcess[] } }
  /** L'état de la CI d'une session suivie a changé (lot 14b). */
  | { method: 'forge.ci_changed'; params: { id: string; state: ChecksState } }
  /** Plugins changés (lot 22a) : accord, révocation, état d'un processus ; la liste est à relire. */
  | { method: 'plugins.changed'; params: Record<string, never> }
