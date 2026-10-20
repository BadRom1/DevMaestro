/**
 * Demandes en attente de la session affichée, dans une zone réservée au bas du
 * volet (sous l'onglet affiché, quel qu'il soit) : le contenu au-dessus
 * rétrécit au lieu d'être recouvert, et le terminal est redimensionné.
 *
 * « Réduire » la ramène à une ligne ; les cartes restent montées (masquées),
 * pour garder ce qui a été saisi. La zone est une région `aria-live` polie
 * toujours présente (vide : hauteur nulle, jamais `display: none`) : la
 * première demande est annoncée, la ligne réduite aussi, et son bouton reste
 * atteignable au clavier.
 */
import { useEffect, useId, useRef, useState, type Ref, type RefObject } from 'react'

import type { PendingRequest, Session } from '../../../shared/protocol'
import { dockReduced, pruneDock, reduceDock, requestKey, showDock } from '../state/askDock'
import { PermissionCard, QuestionCard } from './RequestCards'

/**
 * État de la zone pour les demandes affichées (`keys`, voir `requestKey`) :
 * - réduite ou non, calculé au rendu (sans effet) pour qu'une nouvelle demande
 *   rouvre la zone dans le rendu même où elle arrive ;
 * - une nouvelle demande prend le focus (sa carte), sauf si `typingElsewhere()`
 *   dit que l'utilisateur tape ailleurs (terminal, champ) ;
 * - seules les demandes de la session affichée sont retenues (voir `pruneDock`).
 */
export function useRequestDock(
  sessionId: string | null,
  keys: readonly string[],
  typingElsewhere: () => boolean = () => false,
): { reduced: boolean; toggle: () => void; dockRef: RefObject<HTMLDivElement | null> } {
  const [reducedKeys, setReducedKeys] = useState<ReadonlySet<string>>(() => new Set())
  const reduced = dockReduced(reducedKeys, keys)
  const sig = keys.join(',')
  const dockRef = useRef<HTMLDivElement>(null)
  const seen = useRef(new Set<string>())
  const typingRef = useRef(typingElsewhere)
  typingRef.current = typingElsewhere
  useEffect(() => {
    setReducedKeys((r) => pruneDock(r, keys))
    const fresh = keys.filter((k) => !seen.current.has(k))
    seen.current = new Set(keys)
    if (fresh.length === 0 || typingRef.current()) return
    dockRef.current?.querySelector<HTMLElement>(`[data-request-key="${CSS.escape(fresh[0]!)}"]`)?.focus()
    // La signature des clés suffit comme dépendance.
  }, [sig, sessionId])
  const toggle = () => setReducedKeys((r) => (reduced ? showDock(r, keys) : reduceDock(r, keys)))
  return { reduced, toggle, dockRef }
}

export function RequestDock({
  session,
  pending,
  stale,
  reduced,
  onToggle,
  dockRef,
}: {
  session: Session | null
  pending: readonly PendingRequest[]
  /** Demandes peut-être déjà traitées dans le terminal. */
  stale: readonly number[]
  reduced: boolean
  /** « Réduire » (zone ouverte) ou « Afficher » (zone réduite). */
  onToggle: () => void
  dockRef?: Ref<HTMLDivElement>
}) {
  const listId = useId()
  const n = session ? pending.length : 0
  return (
    <div className={`asks${reduced ? ' reduced' : ''}`} ref={dockRef} role="region" aria-live="polite" aria-label="Demandes en attente">
      {session && n > 0 && (
        <>
          <div className="asks-bar">
            <span className="asks-t">
              {reduced
                ? `Claude attend ta réponse${n > 1 ? ` (${n} demandes)` : ''}`
                : n > 1
                  ? `${n} demandes en attente`
                  : 'Demande en attente'}
            </span>
            {reduced && (
              <span className="asks-sep" aria-hidden="true">
                —
              </span>
            )}
            {/* Un seul bouton pour les deux états : le focus reste dessus quand il bascule. */}
            <button
              type="button"
              className={`btn sm${reduced ? '' : ' ghost'}`}
              aria-expanded={!reduced}
              aria-controls={listId}
              onClick={onToggle}
            >
              {reduced ? 'Afficher' : 'Réduire'}
            </button>
          </div>
          <div className="asks-list" id={listId} hidden={reduced}>
            {pending.map((r) => {
              const isStale = session.possibly_stale || stale.includes(r.request_id)
              const k = requestKey(session.id, r.request_id)
              return r.pending.kind === 'question' ? (
                <QuestionCard key={k} cardKey={k} session={session} req={r} stale={isStale} />
              ) : (
                <PermissionCard key={k} cardKey={k} session={session} req={r} stale={isStale} />
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
