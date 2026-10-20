/**
 * Changement de mode d'une session (`sessions.setMode`) : petite machine à
 * états, pure, pilotée par le composant (minuteries) et par les
 * `session.updated`.
 *
 * - Après une demande, le sélecteur est désactivé et affiche « en cours… »
 *   jusqu'à ce qu'un `session.updated` rapporte le mode visé, ou 3 s.
 * - Hors attente, le mode affiché est **toujours** celui du dernier
 *   `session.updated` (jamais une valeur optimiste restée en place).
 * - Le démon attend déjà lui-même la confirmation d'un changement précédent
 *   (environ 1 s) : un `-32002` n'est réessayé (une fois, sans message,
 *   500 ms plus tard) que s'il dit « pas encore confirmé ». Sinon (session
 *   arrêtée, demande en attente), la raison du démon est affichée.
 * - Un message d'erreur disparaît dès que le mode de la session change.
 */
import { ErrorCode, type SettableMode } from '../../../shared/protocol'
import { describeError } from './errors'
import { modeLabel } from './format'

export const MODE_CONFIRM_MS = 3000
export const MODE_RETRY_MS = 500

export type ModeSwitch =
  | {
      phase: 'idle'
      error: string | null
      /** Mode de la session quand l'erreur est apparue : l'erreur s'efface quand il change. */
      errorMode?: string
    }
  | {
      phase: 'pending'
      target: SettableMode
      /** Fin de l'attente de confirmation (horloge `Date.now()`). */
      deadline: number
      /** Le réessai unique a déjà été fait (ou programmé). */
      retried: boolean
      /** Réessai programmé à cette heure, ou `null`. */
      retryAt: number | null
    }

export type ModeEvent =
  /** L'utilisateur choisit un mode. */
  | { type: 'request'; target: SettableMode; mode: string | null; now: number }
  /** Réponse du démon : nombre de Shift+Tab envoyés. */
  | { type: 'sent'; sent: unknown; mode: string | null }
  /** Échec de l'appel. */
  | { type: 'failed'; code: number | null; message: string; mode: string | null; now: number }
  /** Le réessai programmé part maintenant. */
  | { type: 'retrying'; now: number }
  /** Nouvel état de la session (`session.updated`). */
  | { type: 'session'; mode: string | null; alive: boolean }
  /** Fin du délai de confirmation. */
  | { type: 'timeout'; mode: string | null }

export const idleMode: ModeSwitch = { phase: 'idle', error: null }

/** `manual` est l'autre nom de `default`. */
export function normalizeMode(mode: string | null | undefined): string {
  return mode === 'manual' ? 'default' : (mode ?? '')
}

/** Le démon refuse parce qu'un changement précédent attend encore sa confirmation. */
export function isNotYetConfirmed(code: number | null, message: string): boolean {
  return code === ErrorCode.InvalidState && /pas encore confirm/i.test(message)
}

function failure(code: number | null, message: string): string {
  if (code === ErrorCode.InvalidState) {
    // Raison donnée par le démon, en français (« la session ne tourne pas »…).
    return message.trim()
      ? `Changement de mode impossible : ${message.trim()}`
      : 'Changement de mode impossible dans l’état actuel de la session.'
  }
  const text = code === null ? message : describeError(code, message)
  // Le texte du démon (-32014) commence déjà par « changement de mode impossible ».
  const prefix = 'changement de mode impossible'
  if (text.toLowerCase().startsWith(prefix)) return text.charAt(0).toUpperCase() + text.slice(1)
  return `Changement de mode impossible : ${text}`
}

export function modeReducer(s: ModeSwitch, e: ModeEvent): ModeSwitch {
  switch (e.type) {
    case 'request':
      if (s.phase === 'pending') return s
      if (normalizeMode(e.mode) === e.target) return idleMode
      return { phase: 'pending', target: e.target, deadline: e.now + MODE_CONFIRM_MS, retried: false, retryAt: null }
    case 'sent':
      if (s.phase !== 'pending') return s
      // Aucune touche envoyée : déjà dans ce mode, aucune confirmation à attendre.
      if (e.sent === 0) return idleMode
      return normalizeMode(e.mode) === s.target ? idleMode : s
    case 'failed':
      if (s.phase !== 'pending') return s
      if (isNotYetConfirmed(e.code, e.message) && !s.retried) {
        return { ...s, retried: true, retryAt: e.now + MODE_RETRY_MS, deadline: e.now + MODE_RETRY_MS + MODE_CONFIRM_MS }
      }
      return { phase: 'idle', error: failure(e.code, e.message), errorMode: normalizeMode(e.mode) }
    case 'retrying':
      if (s.phase !== 'pending' || s.retryAt === null) return s
      return { ...s, retryAt: null, deadline: e.now + MODE_CONFIRM_MS }
    case 'session':
      if (s.phase !== 'pending') {
        // Le mode a changé depuis l'erreur : elle ne dit plus rien d'actuel.
        if (s.error && s.errorMode !== undefined && normalizeMode(e.mode) !== s.errorMode) return idleMode
        return s
      }
      if (!e.alive) return { phase: 'idle', error: null }
      return normalizeMode(e.mode) === s.target ? idleMode : s
    case 'timeout': {
      // Le composant ne programme ce délai que pour l'attente en cours.
      if (s.phase !== 'pending' || s.retryAt !== null) return s
      if (normalizeMode(e.mode) === s.target) return idleMode
      return {
        phase: 'idle',
        error: `Le passage en « ${modeLabel(s.target)} » n’a pas été confirmé : la session est en « ${modeLabel(e.mode)} ».`,
        errorMode: normalizeMode(e.mode),
      }
    }
  }
}

/** Mode à montrer dans le sélecteur : le mode visé pendant l'attente, sinon celui de la session. */
export function displayedMode(s: ModeSwitch, sessionMode: string | null): string {
  return s.phase === 'pending' ? s.target : normalizeMode(sessionMode)
}
