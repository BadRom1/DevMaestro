/**
 * Flux du terminal d'un runner (lot 14a) : mêmes trames que les PTY de
 * session (`0x02` en sortie, `0x03` en entrée, UUID de l'exécution), mêmes
 * règles d'instantané et de resynchronisation (protocole § 6), par les
 * méthodes `runners.*`.
 *
 * Tout ce que l'app suppose du démon pour ce flux est ici, en un seul
 * endroit : noms des méthodes, paramètres (`{id, process_id}` : `id`, la
 * session, est facultatif pour le démon et vérifié s'il est donné), cible
 * d'une resynchronisation (`runners.resync {process_id, snapshot}`). Le
 * relais (`TerminalRelay`) est le même que celui des sessions.
 */
import type { StreamMethods } from './relay'

export const RUNNER_STREAM: StreamMethods = {
  subscribe: 'runners.subscribe',
  unsubscribe: 'runners.unsubscribe',
  resize: 'runners.resize',
  resync: ['runners.resync'],
  params: (processId, sessionId) => ({ id: sessionId, process_id: processId }),
  resyncTarget: (p) => (typeof p.process_id === 'string' ? p.process_id : undefined),
}
