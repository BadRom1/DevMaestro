/**
 * Runners en cours, par session (lot 14a) : pour l'indicateur de la barre
 * latérale et du kanban, et pour savoir si le démon connaît les runners
 * (sinon l'onglet « Lancer » est masqué).
 *
 * Aucun appel au démon : le compte vient de `Session.runners_running`
 * (`session.updated` à chaque lancement ou fin), à défaut de la dernière
 * liste connue (`runners.changed`, ou celle de l'onglet « Lancer »).
 * `runners.list` n'est appelé qu'à l'ouverture de l'onglet. Démon ancien :
 * l'onglet reçoit `-32601` et le signale (`markUnsupported`) ; une nouvelle
 * connexion remet l'état à « inconnu ».
 */
import { useCallback, useEffect, useMemo, useReducer } from 'react'

import type { ConnectionState } from '../../shared/bridge'
import type { Session } from '../../shared/protocol'
import { api } from './api'
import { indexReducer, initialIndex, normalizeProcs, sessionRunnerCounts, type RunnerProc } from './state/runners'

export function useRunnersIndex(connection: ConnectionState, sessions: readonly Session[]) {
  const [index, dispatch] = useReducer(indexReducer, initialIndex)

  // Nouvelle connexion (démon peut-être mis à jour) : support redevenu inconnu.
  useEffect(() => {
    if (connection.state === 'connected') dispatch({ type: 'reset' })
  }, [connection])

  useEffect(
    () =>
      api.onNotification((n) => {
        if (n.method === 'runners.changed' && typeof n.params?.id === 'string' && Array.isArray(n.params.running)) {
          dispatch({ type: 'list', sessionId: n.params.id, running: normalizeProcs(n.params.running) })
        } else if (n.method === 'session.removed' && typeof n.params?.id === 'string') {
          dispatch({ type: 'forget', sessionId: n.params.id })
        }
      }),
    [],
  )

  /** Liste reçue par l'onglet « Lancer ». */
  const noteRunning = useCallback((sessionId: string, running: RunnerProc[]) => {
    dispatch({ type: 'list', sessionId, running })
  }, [])
  const markUnsupported = useCallback(() => dispatch({ type: 'unsupported' }), [])

  const counts = useMemo(() => sessionRunnerCounts(sessions, index), [sessions, index])
  // Un champ `runners_running` dans une session suffit à savoir que le démon connaît les runners.
  const supported =
    index.supported === false ? false : index.supported === true || sessions.some((s) => typeof s.runners_running === 'number') ? true : null
  return { supported, counts, noteRunning, markUnsupported }
}
