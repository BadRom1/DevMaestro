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
}

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
  root: string
  worktree_root: string | null
  common_dir: string | null
  branch: string | null
  name: string | null
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
  /** Masquée par l'utilisateur (seulement avec `include_hidden`). */
  hidden?: boolean | null
  /** Dernière activité, si le démon la donne sous ce nom (sinon `last_timestamp`). */
  last_activity?: string | null
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
    result: { session: Session }
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
    result: { session: Session }
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
