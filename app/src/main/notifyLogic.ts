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
import type { Demand, Session, WorktreeInfo } from '../shared/protocol'
import { summarizeToolInput } from '../shared/summary'
import { cleanupCandidate, hasOwnWork } from '../shared/worktrees'

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

/* ---------- Branche intégrée (v0.2, lot 6) ---------- */

/**
 * Notification « branche intégrée » : une seule fois par worktree et par
 * état d'intégration. Un worktree est signalé quand il devient candidat au
 * nettoyage (`cleanupCandidate` : intégré de façon crédible, sans session
 * vivante, hors Claude Desktop). La première liste vue d'un dépôt sert de
 * référence sans rien montrer (au démarrage comme pour un dépôt inconnu) :
 * on ne signale pas l'existant. Seul le retour à « non intégrée » (`no`,
 * nouveaux commits) réarme un worktree ; un état inconnu (`null`, échec
 * passager de git) ne l'oublie pas.
 */
export class IntegratedNotifier {
  /** Clés `racine\0chemin\0état` déjà signalées (ou vues à la référence). */
  private seen = new Set<string>()
  private baselined = new Set<string>()
  /** Worktrees vus avec du travail à eux (non intégrés ou en avance), par `racine\0chemin`. */
  private worked = new Set<string>()

  private key(root: string, w: WorktreeInfo): string {
    return `${root}\0${w.path}\0${w.integrated}`
  }

  private forget(root: string, path: string): void {
    const prefix = `${root}\0${path}\0`
    for (const k of this.seen) if (k.startsWith(prefix)) this.seen.delete(k)
  }

  /** Dépôt déjà pris comme référence ? */
  known(root: string): boolean {
    return this.baselined.has(root)
  }

  private note(root: string, list: readonly WorktreeInfo[]): void {
    for (const w of list) if (hasOwnWork(w)) this.worked.add(`${root}\0${w.path}`)
  }

  private candidate(root: string, w: WorktreeInfo): boolean {
    return cleanupCandidate(w, this.worked.has(`${root}\0${w.path}`))
  }

  /** Référence : les candidats actuels ne seront pas signalés. */
  baseline(root: string, list: readonly WorktreeInfo[]): void {
    this.baselined.add(root)
    this.note(root, list)
    for (const w of list) if (this.candidate(root, w)) this.seen.add(this.key(root, w))
  }

  /**
   * Nouvelle liste (`project.worktrees_changed`, fin d'une session) :
   * worktrees à signaler. Dépôt jamais vu : la liste sert de référence.
   * `enabled` faux : rien n'est montré, mais l'état est retenu (réactiver la
   * notification ne rejoue pas les anciennes intégrations).
   */
  changed(root: string, list: readonly WorktreeInfo[], enabled: boolean): WorktreeInfo[] {
    if (!this.baselined.has(root)) {
      this.baseline(root, list)
      return []
    }
    this.note(root, list)
    const out: WorktreeInfo[] = []
    const present = new Set(list.map((w) => w.path))
    // Worktree disparu (supprimé) : oublié.
    for (const k of [...this.seen]) {
      const [r, p] = k.split('\0')
      if (r === root && p !== undefined && !present.has(p)) this.seen.delete(k)
    }
    for (const k of [...this.worked]) {
      const [r, p] = k.split('\0')
      if (r === root && p !== undefined && !present.has(p)) this.worked.delete(k)
    }
    for (const w of list) {
      if (w.integrated === 'no') {
        this.forget(root, w.path)
        continue
      }
      if (!this.candidate(root, w)) continue
      const k = this.key(root, w)
      if (this.seen.has(k)) continue
      this.seen.add(k)
      if (enabled && w.branch) out.push(w)
    }
    return out
  }
}

/** Texte de la notification « branche intégrée ». */
export function integratedContent(root: string, w: Pick<WorktreeInfo, 'branch' | 'path'>): { title: string; body: string } {
  const title = oneLine(`La branche ${w.branch ?? basename(w.path)} est intégrée : nettoyer le worktree ?`, TITLE_MAX * 2)
  const body = oneLine(`${basename(root)} · ${w.path}`, BODY_MAX)
  return { title, body }
}
