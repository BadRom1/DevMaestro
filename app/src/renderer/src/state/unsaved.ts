/**
 * Modifications de fichier non enregistrées (lot 7), gardées hors de React :
 * l'onglet Fichiers les déclare, les gardes de navigation (changer de
 * fichier, d'onglet, de session, de vue) et la fermeture de la fenêtre les
 * consultent.
 *
 * `guardLeave` exécute la navigation tout de suite s'il n'y a rien à perdre ;
 * sinon il la met en attente d'une confirmation (`UnsavedConfirm`), qui
 * l'exécute (« Abandonner mes modifications ») ou l'oublie (« Rester »).
 */

/** Fichier modifié non enregistré, par session. */
const unsaved = new Map<string, string>()

export interface PendingLeave {
  /** Session dont les modifications seraient perdues. */
  sessionId: string
  /** Fichier dont les modifications seraient perdues. */
  path: string
  /** Ce que l'utilisateur s'apprête à faire (« changer d'onglet »…). */
  action: string
  proceed: () => void
}

let pending: PendingLeave | null = null
/**
 * Version du registre : augmente quand une inscription est retirée d'ailleurs
 * que par sa vue (« Abandonner mes modifications »). Une vue restée montée
 * avec des modifications se réinscrit alors (sa garde n'est jamais perdue).
 */
let version = 0
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

/** Déclare (ou retire, `path` à `null`) le fichier modifié non enregistré d'une session. */
export function setUnsaved(sessionId: string, path: string | null): void {
  if (path === null) unsaved.delete(sessionId)
  else unsaved.set(sessionId, path)
}

/** Fichier non enregistré : d'une session, ou de n'importe laquelle (`sessionId` absent). */
export function unsavedPath(sessionId?: string | null): string | null {
  return unsavedEntry(sessionId)?.[1] ?? null
}

function unsavedEntry(sessionId?: string | null): [string, string] | null {
  if (sessionId) {
    const p = unsaved.get(sessionId)
    return p === undefined ? null : [sessionId, p]
  }
  for (const e of unsaved) return e
  return null
}

export function unsavedVersion(): number {
  return version
}

export function hasUnsaved(): boolean {
  return unsaved.size > 0
}

/**
 * Navigation qui ferait perdre les modifications de la session `sessionId`
 * (`null` : de n'importe quelle session) : exécutée tout de suite s'il n'y en
 * a pas, sinon après confirmation.
 */
export function guardLeave(sessionId: string | null, action: string, proceed: () => void): void {
  const entry = unsavedEntry(sessionId)
  if (entry === null) {
    proceed()
    return
  }
  pending = { sessionId: entry[0], path: entry[1], action, proceed }
  emit()
}

export function pendingLeave(): PendingLeave | null {
  return pending
}

export function subscribeLeave(l: () => void): () => void {
  listeners.add(l)
  return () => void listeners.delete(l)
}

/** « Abandonner mes modifications » : modifications de la session concernée oubliées, puis navigation. */
export function confirmLeave(): void {
  const p = pending
  if (!p) return
  pending = null
  unsaved.delete(p.sessionId)
  version++
  emit()
  p.proceed()
}

/** « Rester » (ou Échap) : la navigation est oubliée, l'édition continue. */
export function cancelLeave(): void {
  if (!pending) return
  pending = null
  emit()
}

/** Tests : état remis à zéro. */
export function resetUnsaved(): void {
  unsaved.clear()
  pending = null
  version++
  emit()
}
