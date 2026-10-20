/**
 * Amorçage des listes de sous-agents (`sessions.subagents`), sans React ni
 * démon : testable. Ensuite, `session.subagents_changed` tient les listes à
 * jour.
 *
 * - Une demande par session et par connexion, seulement si la session a des
 *   sous-agents (`subagents_total` > 0) : un démon plus ancien n'a pas ce
 *   champ et n'est jamais interrogé.
 * - Méthode inconnue (-32601) : plus aucune demande jusqu'à la reconnexion.
 * - Connexion perdue ou délai : nouvel essai au passage suivant.
 * - Autre erreur : liste « indisponible », nouvel essai après `RETRY_MS`
 *   (ou tout de suite sur « Réessayer »).
 */
import { ErrorCode, type Session } from '../../../shared/protocol'
import { totalCount } from './subagents'

export const RETRY_MS = 30_000

export type LoadEntry =
  | { phase: 'loading' }
  | { phase: 'loaded' }
  | { phase: 'failed'; retryAt: number }

export interface LoadState {
  supported: boolean
  entries: ReadonlyMap<string, LoadEntry>
}

/** État d'une nouvelle connexion : rien demandé. */
export function initialLoad(): LoadState {
  return { supported: true, entries: new Map() }
}

/** Sessions à (re)demander maintenant. */
export function sessionsToLoad(
  st: LoadState,
  sessions: readonly Pick<Session, 'id' | 'subagents_total'>[],
  now: number,
): string[] {
  if (!st.supported) return []
  return sessions
    .filter((s) => {
      if (totalCount(s) === 0) return false
      const e = st.entries.get(s.id)
      return !e || (e.phase === 'failed' && now >= e.retryAt)
    })
    .map((s) => s.id)
}

function withEntry(st: LoadState, id: string, e: LoadEntry | null): LoadState {
  const entries = new Map(st.entries)
  if (e) entries.set(id, e)
  else entries.delete(id)
  return { ...st, entries }
}

/**
 * Demande lancée : renvoie aussi le compteur de notifications de la session
 * à ce moment-là (une réponse plus ancienne qu'une notification est ignorée).
 */
export function startLoad(st: LoadState, id: string, seqs: Readonly<Record<string, number>>): { state: LoadState; seq: number } {
  return { state: withEntry(st, id, { phase: 'loading' }), seq: seqs[id] ?? 0 }
}

export function loadSucceeded(st: LoadState, id: string): LoadState {
  return withEntry(st, id, { phase: 'loaded' })
}

export function loadFailed(st: LoadState, id: string, code: number | null, now: number): LoadState {
  if (code === ErrorCode.MethodNotFound) return { ...withEntry(st, id, null), supported: false }
  if (code === ErrorCode.Disconnected || code === ErrorCode.Timeout) return withEntry(st, id, null)
  return withEntry(st, id, { phase: 'failed', retryAt: now + RETRY_MS })
}

/** « Réessayer » : la session sera redemandée au prochain passage. */
export function retryNow(st: LoadState, id: string): LoadState {
  return withEntry(st, id, null)
}

/** Ce que l'onglet doit dire quand la liste reçue est vide. */
export function loadPhase(st: LoadState, id: string): 'loading' | 'failed' | 'unsupported' | null {
  if (!st.supported) return 'unsupported'
  const e = st.entries.get(id)
  return e?.phase === 'loading' ? 'loading' : e?.phase === 'failed' ? 'failed' : null
}
