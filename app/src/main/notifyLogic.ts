/**
 * Notifications desktop : décision et contenu (sans Electron, testable).
 *
 * - Une notification par demande (session, `request_id`) : un même
 *   `notify_waiting` reçu deux fois n'en montre qu'une.
 * - Une seule notification visible par session : une nouvelle demande
 *   remplace la précédente.
 * - Rien si les notifications sont coupées, ou si la fenêtre a le focus ET
 *   affiche cette session (l'utilisateur la voit déjà).
 * - Une demande close (réponse, fin de tour…) retire sa notification.
 */
import type { Demand, Session } from '../shared/protocol'
import { summarizeToolInput } from '../shared/summary'

export interface NotifyContext {
  enabled: boolean
  windowFocused: boolean
  /** Session affichée dans la fenêtre (terminal), ou `null`. */
  visibleSessionId: string | null
}

export type NotifyDecision =
  | { action: 'skip'; reason: 'disabled' | 'visible' | 'duplicate' }
  /** Montrer ; `replace` : fermer d'abord la notification de cette session. */
  | { action: 'show'; replace: boolean }

/** Au-delà, les plus anciennes demandes notifiées sont oubliées. */
const MAX_SEEN = 2000

export class NotifyDecider {
  /** Demande dont la notification est visible, par session. */
  private shown = new Map<string, number>()
  private seen = new Set<string>()

  decide(sessionId: string, requestId: number, ctx: NotifyContext): NotifyDecision {
    const key = `${sessionId}:${requestId}`
    if (this.seen.has(key)) return { action: 'skip', reason: 'duplicate' }
    if (!ctx.enabled) return { action: 'skip', reason: 'disabled' }
    if (ctx.windowFocused && ctx.visibleSessionId === sessionId) return { action: 'skip', reason: 'visible' }
    this.seen.add(key)
    if (this.seen.size > MAX_SEEN) this.seen.delete(this.seen.values().next().value!)
    const replace = this.shown.has(sessionId)
    this.shown.set(sessionId, requestId)
    return { action: 'show', replace }
  }

  /** Demande close : faut-il fermer la notification visible de la session ? */
  resolved(sessionId: string, requestId: number): boolean {
    if (this.shown.get(sessionId) !== requestId) return false
    this.shown.delete(sessionId)
    return true
  }

  /**
   * Nouvel état d'une session : sa notification est-elle devenue sans objet
   * (plus aucune demande en attente avec ce numéro, session retirée) ?
   */
  stale(sessionId: string, pendingIds: readonly number[] | null): boolean {
    const shown = this.shown.get(sessionId)
    if (shown === undefined) return false
    if (pendingIds && pendingIds.includes(shown)) return false
    this.shown.delete(sessionId)
    return true
  }

  /**
   * La demande est-elle toujours celle à montrer pour cette session ? (À
   * vérifier après une attente : la demande a pu être close entre-temps.)
   */
  stillExpected(sessionId: string, requestId: number): boolean {
    return this.shown.get(sessionId) === requestId
  }

  /** La notification a été fermée (clic, fermeture par l'utilisateur). */
  dismissed(sessionId: string): void {
    this.shown.delete(sessionId)
  }
}

/**
 * Texte sûr pour une notification : caractères de contrôle et de format
 * (dont les contrôles bidirectionnels) retirés, blancs regroupés, coupé à
 * `max` caractères, puis `&`, `<`, `>` échappés (balisage de libnotify).
 */
export function sanitizeNotificationText(s: string, max: number): string {
  const t = s
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const chars = [...t]
  const cut = chars.length > max ? chars.slice(0, max - 1).join('') + '…' : t
  return cut.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function oneLine(s: string, max: number): string {
  return sanitizeNotificationText(s, max)
}

function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? p
}

export const TITLE_MAX = 80
export const BODY_MAX = 180

/** Titre et texte (français, sur une ligne, tronqués) d'une demande. */
export function notificationContent(
  session: Pick<Session, 'id' | 'cwd' | 'project_root' | 'display_name' | 'title' | 'branch'> | null,
  demand: Demand,
): { title: string; body: string } {
  const name =
    session?.display_name?.trim() || session?.title?.trim() || session?.branch?.trim() || (session ? session.id.slice(0, 8) : 'Session')
  const project = session ? basename(session.project_root ?? session.cwd) : null
  const title = oneLine(project && project !== name ? `${name} · ${project}` : name, TITLE_MAX)
  let body: string
  if (demand.detailed === false) {
    body = demand.kind === 'question' ? 'Claude te pose une question.' : 'Claude attend une permission.'
  } else if (demand.kind === 'question') {
    const q = demand.questions[0]
    const more = demand.questions.length > 1 ? ` (+${demand.questions.length - 1})` : ''
    body = q ? `Question : ${q.question}${more}` : 'Claude te pose une question.'
  } else {
    const what = summarizeToolInput(demand.tool_name, demand.tool_input)
    body = `Permission : ${demand.tool_name}${what ? ` · ${what}` : ''}`
  }
  return { title, body: oneLine(body, BODY_MAX) }
}
