/**
 * Zone des demandes en attente (question, permission) au bas du volet de
 * session : réduite à une ligne par « Réduire », pour les demandes affichées à
 * ce moment-là seulement. Une nouvelle demande la rouvre (sa clé n'est pas
 * dans l'ensemble). Clé d'une demande : `<session>:<request_id>`.
 */

export function requestKey(sessionId: string, requestId: number): string {
  return `${sessionId}:${requestId}`
}

/** Zone réduite : au moins une demande, et toutes réduites. */
export function dockReduced(reduced: ReadonlySet<string>, keys: readonly string[]): boolean {
  return keys.length > 0 && keys.every((k) => reduced.has(k))
}

/** « Réduire » : les demandes affichées sont réduites. */
export function reduceDock(reduced: ReadonlySet<string>, keys: readonly string[]): ReadonlySet<string> {
  if (keys.every((k) => reduced.has(k))) return reduced
  const next = new Set(reduced)
  for (const k of keys) next.add(k)
  return next
}

/** « Afficher » : les demandes affichées sont rouvertes. */
export function showDock(reduced: ReadonlySet<string>, keys: readonly string[]): ReadonlySet<string> {
  if (!keys.some((k) => reduced.has(k))) return reduced
  const next = new Set(reduced)
  for (const k of keys) next.delete(k)
  return next
}

/**
 * Ne garde que les demandes affichées (`keys`, celles de la session affichée) :
 * demandes closes, sessions quittées ou oubliées sont purgées (revenir sur une
 * session rouvre sa zone). Même ensemble si rien ne change.
 */
export function pruneDock(reduced: ReadonlySet<string>, keys: readonly string[]): ReadonlySet<string> {
  const live = new Set(keys)
  if ([...reduced].every((k) => live.has(k))) return reduced
  return new Set([...reduced].filter((k) => live.has(k)))
}
