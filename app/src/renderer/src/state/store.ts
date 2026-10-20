/**
 * État de la page, mis à jour par les notifications du démon. Réducteur pur,
 * testable sans DOM. Le dernier `session.updated` reçu fait toujours foi ;
 * les effets ne servent qu'à ce que l'état ne porte pas (demandes
 * « peut-être obsolètes », retrait immédiat d'une demande résolue).
 */
import type { ConnectionState } from '../../../shared/bridge'
import type { Effect, PastSession, Profile, ProjectInfo, Session } from '../../../shared/protocol'

export interface AppState {
  connection: ConnectionState
  sessions: Record<string, Session>
  profiles: Profile[]
  /** Projets résolus, par dossier de session. */
  projects: Record<string, ProjectInfo>
  /** Anciennes sessions trouvées dans les transcripts, par profil. */
  past: Record<string, PastSession[]>
  /** Demandes signalées « peut-être obsolètes » par effet, par session. */
  stale: Record<string, number[]>
  selectedId: string | null
}

export const initialState: AppState = {
  connection: { state: 'connecting', attempt: 0 },
  sessions: {},
  profiles: [],
  projects: {},
  past: {},
  stale: {},
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
  | { type: 'profiles'; profiles: Profile[] }
  | { type: 'project'; cwd: string; info: ProjectInfo }
  | { type: 'past'; profile: string; sessions: PastSession[] }
  | { type: 'select'; id: string | null }

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
    case 'connection':
      return { ...state, connection: action.state }
    case 'sessions': {
      const sessions: Record<string, Session> = {}
      let stale: Record<string, number[]> = {}
      for (const s of action.sessions) {
        sessions[s.id] = s
        if (state.stale[s.id]) stale[s.id] = state.stale[s.id]!
        stale = pruneStale(stale, s)
      }
      return { ...state, sessions, stale }
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
    case 'session.effect':
      return applyEffect(state, action.id, action.effect)
    case 'profiles':
      return { ...state, profiles: action.profiles }
    case 'project':
      return { ...state, projects: { ...state.projects, [action.cwd]: action.info } }
    case 'past':
      return { ...state, past: { ...state.past, [action.profile]: action.sessions } }
    case 'select':
      return { ...state, selectedId: action.id }
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
