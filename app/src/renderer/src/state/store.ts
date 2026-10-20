/**
 * État de la page, mis à jour par les notifications du démon. Réducteur pur,
 * testable sans DOM. Le dernier `session.updated` reçu fait toujours foi ;
 * les effets ne servent qu'à ce que l'état ne porte pas (demandes
 * « peut-être obsolètes », retrait immédiat d'une demande résolue).
 */
import type { ConnectionState } from '../../../shared/bridge'
import type { DaemonProfileQuota, Effect, PastSession, Profile, ProjectInfo, QuotasReport, Session, Subagent } from '../../../shared/protocol'
import { normalizeAgents } from './subagents'

export interface AppState {
  connection: ConnectionState
  sessions: Record<string, Session>
  profiles: Profile[]
  /** Projets résolus, par dossier de session. */
  projects: Record<string, ProjectInfo>
  /** Anciennes sessions trouvées dans les transcripts, par profil. */
  past: Record<string, PastSession[]>
  /**
   * Dossiers dont `projects.resolve` a échoué (repli provisoire dans
   * `projects`) : heure du prochain essai. Remis à 0 à chaque connexion.
   */
  projectRetry: Record<string, number>
  /**
   * Quotas donnés par le démon (`quotas.get`, `quotas.updated`), par profil ;
   * `null` tant qu'ils sont inconnus ou si le démon ne sait pas les donner.
   */
  quotas: Record<string, DaemonProfileQuota> | null
  /** Nombre de `session.diff_changed` reçus par session (rechargement du diff). */
  diffSeq: Record<string, number>
  /** Nombre de `quotas.updated` reçus par profil (fin d'une actualisation). */
  quotasSeq: Record<string, number>
  /** Demandes signalées « peut-être obsolètes » par effet, par session. */
  stale: Record<string, number[]>
  /** Sous-agents connus, par session (liste complète du démon, sans rapport). */
  subagents: Record<string, Subagent[]>
  /**
   * Nombre de `session.subagents_changed` reçus par session : une réponse de
   * `sessions.subagents` partie avant une notification est plus ancienne qu'elle.
   */
  subagentsSeq: Record<string, number>
  selectedId: string | null
}

export const initialState: AppState = {
  connection: { state: 'connecting', attempt: 0 },
  sessions: {},
  profiles: [],
  projects: {},
  past: {},
  projectRetry: {},
  quotas: null,
  quotasSeq: {},
  diffSeq: {},
  stale: {},
  subagents: {},
  subagentsSeq: {},
  selectedId: null,
}

export type Action =
  | { type: 'connection'; state: ConnectionState }
  | { type: 'sessions'; sessions: Session[] }
  | { type: 'session.updated'; session: Session }
  /**
   * Session renvoyée par une méthode (`sessions.update`…) : appliquée sauf si
   * un `session.updated` plus récent est déjà arrivé.
   */
  | { type: 'session.response'; session: Session }
  | { type: 'session.effect'; id: string; effect: Effect }
  /** Session retirée (`session.removed`, ou réponse de `sessions.forget`). */
  | { type: 'session.removed'; id: string }
  | { type: 'profiles'; profiles: Profile[] }
  | { type: 'project'; cwd: string; info: ProjectInfo }
  /** Échec de `projects.resolve` : repli provisoire, nouvel essai à `retryAt`. */
  | { type: 'project.failed'; cwd: string; fallback: ProjectInfo; retryAt: number }
  /** Quotas du démon : remplacent ceux des profils présents dans le rapport. */
  | { type: 'quotas'; report: QuotasReport; notified?: boolean }
  /** Les fichiers changés de la session ont changé. */
  | { type: 'diff.changed'; id: string }
  /** Ancienne session masquée (`transcripts.hide`) : retirée tout de suite. */
  | { type: 'past.hidden'; profile: string; claude_session_id: string }
  | { type: 'past'; profile: string; sessions: PastSession[] }
  | { type: 'select'; id: string | null }
  /** `session.subagents_changed` : la liste reçue remplace la précédente. */
  | { type: 'subagents.changed'; id: string; agents: unknown }
  /**
   * Réponse de `sessions.subagents`, demandée quand `subagentsSeq[id]` valait
   * `seq` : ignorée si une notification est arrivée entre-temps.
   */
  | { type: 'subagents.loaded'; id: string; agents: unknown; seq: number }

function pruneStale(stale: Record<string, number[]>, s: Session): Record<string, number[]> {
  const ids = stale[s.id]
  if (!ids) return stale
  const live = new Set(s.pending.map((p) => p.request_id))
  const kept = ids.filter((r) => live.has(r))
  if (kept.length === ids.length) return stale
  const next = { ...stale }
  if (kept.length) next[s.id] = kept
  else delete next[s.id]
  return next
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'connection': {
      const anyMissing = Object.values(state.projects).some((p) => p.exists === false)
      if (action.state.state !== 'connected' || (Object.keys(state.projectRetry).length === 0 && !anyMissing)) {
        return { ...state, connection: action.state }
      }
      // Nouvelle connexion : résolutions en échec et dossiers disparus redemandés tout de suite.
      const projectRetry = Object.fromEntries(Object.keys(state.projectRetry).map((k) => [k, 0]))
      for (const [cwd, info] of Object.entries(state.projects)) if (info.exists === false) projectRetry[cwd] = 0
      return { ...state, connection: action.state, projectRetry }
    }
    case 'sessions': {
      const sessions: Record<string, Session> = {}
      let stale: Record<string, number[]> = {}
      for (const s of action.sessions) {
        sessions[s.id] = s
        if (state.stale[s.id]) stale[s.id] = state.stale[s.id]!
        stale = pruneStale(stale, s)
      }
      // Sous-agents des sessions absentes de la liste : retirés (notification reçue avant la liste, session oubliée).
      const keep = <T,>(m: Record<string, T>) => Object.fromEntries(Object.entries(m).filter(([id]) => sessions[id]))
      return { ...state, sessions, stale, subagents: keep(state.subagents), subagentsSeq: keep(state.subagentsSeq) }
    }
    case 'session.updated': {
      const s = action.session
      return {
        ...state,
        sessions: { ...state.sessions, [s.id]: s },
        stale: pruneStale(state.stale, s),
      }
    }
    case 'session.response': {
      const s = action.session
      const cur = state.sessions[s.id]
      const curT = Date.parse(cur?.updated_at ?? '')
      const newT = Date.parse(s.updated_at ?? '')
      if (!Number.isNaN(curT) && !Number.isNaN(newT) && curT > newT) return state
      return reducer(state, { type: 'session.updated', session: s })
    }
    case 'session.removed': {
      if (!state.sessions[action.id]) return state
      const gone = state.sessions[action.id]!
      const sessions = { ...state.sessions }
      delete sessions[action.id]
      // Le démon masque aussi son transcript : il ne revient pas dans « Anciennes sessions ».
      let past = state.past
      if (gone.claude_session_id) {
        past = Object.fromEntries(
          Object.entries(state.past).map(([k, v]) => [k, v.filter((p) => p.claude_session_id !== gone.claude_session_id)]),
        )
      }
      const stale = { ...state.stale }
      delete stale[action.id]
      const subagents = { ...state.subagents }
      delete subagents[action.id]
      const subagentsSeq = { ...state.subagentsSeq }
      delete subagentsSeq[action.id]
      return { ...state, sessions, stale, past, subagents, subagentsSeq, selectedId: state.selectedId === action.id ? null : state.selectedId }
    }
    case 'session.effect':
      return applyEffect(state, action.id, action.effect)
    case 'profiles':
      return { ...state, profiles: action.profiles }
    case 'project': {
      const projectRetry = { ...state.projectRetry }
      delete projectRetry[action.cwd]
      return { ...state, projects: { ...state.projects, [action.cwd]: action.info }, projectRetry }
    }
    case 'project.failed': {
      // Un repli ne remplace pas une résolution réussie plus tôt.
      const known = state.projects[action.cwd] && state.projectRetry[action.cwd] === undefined
      return {
        ...state,
        projects: known ? state.projects : { ...state.projects, [action.cwd]: action.fallback },
        projectRetry: { ...state.projectRetry, [action.cwd]: action.retryAt },
      }
    }
    case 'quotas': {
      const profiles = action.report?.profiles
      if (!profiles || typeof profiles !== 'object') return state
      let quotasSeq = state.quotasSeq
      if (action.notified) {
        quotasSeq = { ...quotasSeq }
        for (const name of Object.keys(profiles)) quotasSeq[name] = (quotasSeq[name] ?? 0) + 1
      }
      return { ...state, quotas: { ...(state.quotas ?? {}), ...profiles }, quotasSeq }
    }
    case 'diff.changed':
      return { ...state, diffSeq: { ...state.diffSeq, [action.id]: (state.diffSeq[action.id] ?? 0) + 1 } }
    case 'past.hidden': {
      const list = state.past[action.profile]
      if (!list) return state
      return {
        ...state,
        past: { ...state.past, [action.profile]: list.filter((p) => p.claude_session_id !== action.claude_session_id) },
      }
    }
    case 'past':
      // Les entrées masquées ne sont jamais proposées (même si le démon les envoie).
      return { ...state, past: { ...state.past, [action.profile]: action.sessions.filter((p) => !p.hidden) } }
    case 'select':
      return { ...state, selectedId: action.id }
    case 'subagents.changed':
      // Session inconnue (retirée, ou pas encore listée) : rien à garder ; la liste sera demandée avec elle.
      if (!state.sessions[action.id]) return state
      return {
        ...state,
        subagents: { ...state.subagents, [action.id]: normalizeAgents(action.agents) },
        subagentsSeq: { ...state.subagentsSeq, [action.id]: (state.subagentsSeq[action.id] ?? 0) + 1 },
      }
    case 'subagents.loaded':
      if (!state.sessions[action.id] || (state.subagentsSeq[action.id] ?? 0) !== action.seq) return state
      return { ...state, subagents: { ...state.subagents, [action.id]: normalizeAgents(action.agents) } }
  }
}

function applyEffect(state: AppState, id: string, effect: Effect): AppState {
  switch (effect.type) {
    case 'possibly_stale': {
      const prev = state.stale[id] ?? []
      const merged = [...new Set([...prev, ...effect.request_ids])]
      return { ...state, stale: { ...state.stale, [id]: merged } }
    }
    case 'request_resolved': {
      const s = state.sessions[id]
      const stale = { ...state.stale }
      const left = (stale[id] ?? []).filter((r) => r !== effect.request_id)
      if (left.length) stale[id] = left
      else delete stale[id]
      if (!s) return { ...state, stale }
      // Retrait immédiat ; le `session.updated` qui suit confirme l'état.
      const pending = s.pending.filter((p) => p.request_id !== effect.request_id)
      return { ...state, stale, sessions: { ...state.sessions, [id]: { ...s, pending } } }
    }
    case 'clear_waiting': {
      if (!state.stale[id]) return state
      const stale = { ...state.stale }
      delete stale[id]
      return { ...state, stale }
    }
    case 'notify_waiting':
      // Signal des notifications desktop (lot 5) ; l'état arrive par `session.updated`.
      return state
  }
}

/** Une demande est-elle peut-être obsolète ? */
export function isStale(state: Pick<AppState, 'sessions' | 'stale'>, id: string, requestId: number): boolean {
  return !!state.sessions[id]?.possibly_stale || !!state.stale[id]?.includes(requestId)
}

/** Faut-il (re)demander `projects.resolve` pour ce dossier ? */
export function needsResolve(
  state: Pick<AppState, 'projects' | 'projectRetry'>,
  cwd: string,
  now: number,
  opts: {
    /** Le démon dit que le dossier existe (session, ancienne session). */
    daemonSaysExists?: boolean
    /** Déjà redemandé pour ce désaccord (évite une boucle si la résolution persiste). */
    rechecked?: boolean
  } = {},
): boolean {
  const info = state.projects[cwd]
  if (!info) return true
  const retry = state.projectRetry[cwd]
  if (retry !== undefined && now >= retry) return true
  // Dossier « disparu » en cache, mais le démon le voit : il a été recréé.
  return info.exists === false && opts.daemonSaysExists === true && !opts.rechecked
}
