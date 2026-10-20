/**
 * Types du protocole du démon `orchd` (docs/protocole.md, version 1),
 * partagés par le processus principal, le preload et la page.
 *
 * Principe : tout champ peut être `null` quand la donnée est inconnue.
 */

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

export type AnyReviewComment = ReviewComment | FileReviewComment

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

export interface FileContent {
  path: string
  size: number | null
  binary: boolean
  too_large: boolean
  content: string | null
}

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
    }
    /** `warnings` : messages du démon en français (mode dangereux remplacé…). */
    result: { session: Session; warnings?: string[] }
  }
  'sessions.resume': {
    params:
      | { id: string; mode?: string; model?: string; prompt?: string; cols?: number; rows?: number }
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
    params: { profile?: string; limit?: number; include_hidden?: boolean }
    result: { profile: string; sessions: PastSession[] }
  }
  'sessions.diff': { params: { id: string }; result: DiffSummary }
  'sessions.diffFile': { params: { id: string; path: string }; result: FileDiff }
  'sessions.sendReview': { params: { id: string; comments: AnyReviewComment[]; general?: string }; result: unknown }
  /** Texte tapé dans la session (sans Entrée), ex. « @chemin » pour mentionner un fichier. */
  'sessions.input': { params: { id: string; data: string }; result: unknown }
  'files.list': { params: { id: string; path?: string }; result: FilesList }
  'files.read': { params: { id: string; path: string }; result: FileContent }
  /** Sous-agents de la session, par ordre de lancement, sans `report`. */
  'sessions.subagents': { params: { id: string }; result: { agents: Subagent[] } }
  /** Un sous-agent avec son `report`. */
  'sessions.subagent': { params: { id: string; agent_id: string }; result: Subagent }
  'quotas.get': { params: { refresh?: boolean }; result: QuotasReport }
  'transcripts.hide': { params: { profile: string; claude_session_id: string }; result: { hidden: boolean } }
  'transcripts.unhide': { params: { profile: string; claude_session_id: string }; result: { hidden: boolean } }
}

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
  'files.list',
  'files.read',
  'sessions.input',
  'sessions.subagents',
  'sessions.subagent',
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
