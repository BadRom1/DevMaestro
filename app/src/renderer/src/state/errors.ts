/**
 * Messages d'erreur pour les codes du démon (protocole § 3), dans la langue
 * de l'interface (lot 20). Le message du démon est en français : en
 * français, il est montré comme avant ; dans une autre langue, il est
 * marqué « en français » au lieu d'être deviné.
 */
import { getLocale, t, type PlainKey } from '../../../shared/i18n'
import { ErrorCode } from '../../../shared/protocol'

const FRIENDLY: Record<number, PlainKey> = {
  [ErrorCode.MethodNotFound]: 'errors.methodNotFound',
  [ErrorCode.UnknownSession]: 'errors.unknownSession',
  [ErrorCode.InvalidState]: 'errors.invalidState',
  [ErrorCode.UnknownProfile]: 'errors.unknownProfile',
  [ErrorCode.LaunchFailed]: 'errors.launchFailed',
  [-32005]: 'errors.dangerousMode',
  [-32010]: 'errors.requestClosed',
  [-32011]: 'errors.wrongRequestKind',
  [-32012]: 'errors.noRelay',
  [-32013]: 'errors.noAlwaysRule',
  [-32014]: 'errors.modeSwitch',
  [-32015]: 'errors.noTranscript',
  [-32016]: 'errors.cwdMissing',
  [ErrorCode.WorktreeBusy]: 'errors.worktreeBusy',
  [ErrorCode.WorktreeDirty]: 'errors.worktreeDirty',
  [ErrorCode.FileChanged]: 'errors.fileChanged',
  [ErrorCode.PullChanged]: 'errors.pullChanged',
  [ErrorCode.RunnerUnknown]: 'errors.runnerUnknown',
  [ErrorCode.TooManyRunners]: 'errors.tooManyRunners',
  [ErrorCode.RunnerProcessUnknown]: 'errors.runnerProcessUnknown',
  [ErrorCode.RunnerConfirmationRequired]: 'errors.runnerConfirmationRequired',
  [ErrorCode.Timeout]: 'errors.timeout',
  [ErrorCode.Disconnected]: 'errors.disconnected',
}

export const ALREADY_CLOSED = -32010

/** Codes dont le message du démon est déjà une phrase française complète (avec le dossier…). */
const DAEMON_WORDING = new Set([-32015, -32016])

/**
 * Chemin absolu à la fin d'un message du démon (« … : /chemin »), texte après
 * le dernier « : » ; `null` s'il n'y en a pas.
 */
function trailingPath(message: string): string | null {
  const i = message.lastIndexOf(':')
  const path = i < 0 ? '' : message.slice(i + 1).trim()
  return path.startsWith('/') ? path : null
}

/** Codes produits par l'app elle-même (délai, déconnexion) : leur détail n'est pas un texte du démon. */
const APP_CODES = new Set<number>([ErrorCode.Timeout, ErrorCode.Disconnected])

/** Le texte vient-il de l'app (processus principal), pas du démon ? (`data.origin === "app"`, lot 20.) */
export function fromApp(data: unknown): boolean {
  return typeof data === 'object' && data !== null && (data as { origin?: unknown }).origin === 'app'
}

/**
 * Texte libre venu du démon (avertissement, raison, message sans code connu) :
 * tel quel en français, marqué « en français » dans une autre langue.
 */
export function daemonText(message: string): string {
  if (getLocale() === 'fr' || !message.trim()) return message
  return t('errors.daemonText', { text: message.trim() })
}

/** Texte d'une erreur du démon : explication, puis détail du démon s'il apporte quelque chose. */
export function describeError(code: number, message: string, data?: unknown): string {
  const app = fromApp(data)
  const fr = getLocale() === 'fr'
  const key = FRIENDLY[code]
  if (fr && DAEMON_WORDING.has(code) && message.trim()) return message.trim()
  if (!key) return app ? message : daemonText(message)
  const f = t(key)
  // Hors du français, la phrase complète du démon n'apporte que le dossier (-32016).
  if (!fr && !app && DAEMON_WORDING.has(code)) {
    const path = code === -32016 ? trailingPath(message) : null
    return path ? t('errors.withPath', { text: f, path }) : f
  }
  if (code === ErrorCode.Disconnected) return f
  if (!message || (fr && message === t(key))) return f
  if (fr || app) return t('errors.withDetail', { text: f, detail: message })
  if (APP_CODES.has(code)) return f
  return t('errors.daemonDetail', { text: f, detail: message.trim() })
}

/**
 * Délai dépassé ou connexion perdue : l'opération a pu aboutir côté démon
 * (création d'un worktree, suppression…). Le résultat est incertain.
 */
export function outcomeUncertain(code: number | null): boolean {
  return code === ErrorCode.Timeout || code === ErrorCode.Disconnected
}

/** Texte « résultat incertain » dans la langue courante. */
export function uncertainText(): string {
  return t('errors.uncertain')
}
