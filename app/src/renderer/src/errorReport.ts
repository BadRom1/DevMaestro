/**
 * Erreurs de la page envoyées au journal du processus principal (sans quoi
 * une page blanche ne laisse aucune trace) : erreurs non rattrapées, promesses
 * rejetées sans gestionnaire, erreurs d'affichage rattrapées par un garde-fou.
 * Texte borné ici et revalidé par le processus principal.
 */
import { api } from './api'

export const MAX_ERROR_REPORT = 4000

/** Valeur rejetée qui n'est pas une `Error` : JSON borné si possible (un objet ne donne plus « [object Object] »). */
function describe(v: unknown): string {
  if (typeof v === 'string') return v
  try {
    const json = JSON.stringify(v)
    if (typeof json === 'string') return json.length > MAX_ERROR_REPORT ? json.slice(0, MAX_ERROR_REPORT) : json
  } catch {
    // Structure circulaire, BigInt… : repli sur String.
  }
  return String(v)
}

/** Message bénin de Chromium (boucle de ResizeObserver résolue à l'image suivante) : pas journalisé. */
export function benignError(message: string): boolean {
  return message.startsWith('ResizeObserver loop')
}

/** Texte d'une erreur pour le journal : message, pile, pile des composants ; borné. */
export function errorReportText(context: string, error: unknown, componentStack?: string | null): string {
  const e = error instanceof Error ? error : null
  const parts = [`${context} : ${e ? `${e.name}: ${e.message}` : describe(error)}`]
  if (e?.stack) parts.push(e.stack)
  if (componentStack) parts.push(`composants :${componentStack}`)
  const text = parts.join('\n')
  return text.length > MAX_ERROR_REPORT ? `${text.slice(0, MAX_ERROR_REPORT - 1)}…` : text
}

export function reportRendererError(context: string, error: unknown, componentStack?: string | null): void {
  try {
    api?.logError?.(errorReportText(context, error, componentStack))
  } catch {
    // Pas de preload (tests) ou canal fermé : la console garde l'erreur.
  }
}

/** À appeler une fois au démarrage : erreurs et rejets non rattrapés de la page. */
export function installErrorReporting(): void {
  window.addEventListener('error', (e) => {
    if (benignError(e.message ?? '')) return
    // i18n-exempt: journal technique
    reportRendererError('erreur non rattrapée', e.error ?? e.message)
  })
  // i18n-exempt: journal technique
  window.addEventListener('unhandledrejection', (e) => reportRendererError('promesse rejetée sans gestionnaire', e.reason))
}
