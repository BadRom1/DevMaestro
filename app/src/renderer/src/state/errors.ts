/** Messages d'erreur en français pour les codes du démon (protocole § 3). */
import { ErrorCode } from '../../../shared/protocol'

const FRIENDLY: Record<number, string> = {
  [ErrorCode.MethodNotFound]: 'méthode inconnue du démon (démon trop ancien ? mets orchd à jour)',
  [ErrorCode.UnknownSession]: 'session inconnue du démon',
  [ErrorCode.InvalidState]: 'action impossible dans l’état actuel de la session',
  [ErrorCode.UnknownProfile]: 'profil inconnu',
  [ErrorCode.LaunchFailed]: 'lancement impossible',
  [-32005]: 'mode dangereux refusé (bypassPermissions ou dontAsk demandent allow_dangerous_modes dans la configuration du démon)',
  [-32010]: 'demande déjà close (répondue dans le terminal, ou tour terminé)',
  [-32011]: 'mauvais type de demande',
  [-32012]: 'aucun relais n’attend cette réponse : réponds dans le terminal',
  [-32013]: '« Toujours » impossible : Claude Code ne propose aucune règle pour cette demande',
  [-32014]: 'changement de mode impossible : mode courant inconnu ou hors du cycle Shift+Tab',
  [-32015]: 'Claude Code n’a pas de transcript pour cette session : impossible de la reprendre (retire-la de la liste)',
  [-32016]: 'le dossier de la session n’existe plus (worktree supprimé ?)',
  [ErrorCode.WorktreeBusy]: 'une session tourne dans ce worktree : arrête-la d’abord',
  [ErrorCode.WorktreeDirty]: 'le worktree a des modifications non commitées',
  [ErrorCode.FileChanged]: 'le fichier a été modifié depuis son ouverture',
  [ErrorCode.PullChanged]: 'la demande de fusion a changé depuis son ouverture',
  [ErrorCode.Timeout]: 'le démon n’a pas répondu à temps',
  [ErrorCode.Disconnected]: 'démon non connecté',
}

export const ALREADY_CLOSED = -32010

/** Codes dont le message du démon est déjà une phrase française complète (avec le dossier…). */
const DAEMON_WORDING = new Set([-32015, -32016])

/** Texte d'une erreur du démon : explication, puis détail du démon s'il apporte quelque chose. */
export function describeError(code: number, message: string): string {
  if (DAEMON_WORDING.has(code) && message.trim()) return message.trim()
  const f = FRIENDLY[code]
  if (!f) return message
  if (!message || message === f || code === ErrorCode.Disconnected) return f
  return `${f} (${message})`
}

/**
 * Délai dépassé ou connexion perdue : l'opération a pu aboutir côté démon
 * (création d'un worktree, suppression…). Le résultat est incertain.
 */
export function outcomeUncertain(code: number | null): boolean {
  return code === ErrorCode.Timeout || code === ErrorCode.Disconnected
}

export const UNCERTAIN_TEXT = 'résultat incertain : vérifie la liste'
