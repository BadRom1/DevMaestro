/**
 * Vue par statut (kanban) : colonnes « À répondre », « En cours »,
 * « Inactive », « Arrêtée » (les sessions en erreur y vont, avec leur glyphe).
 * Ordre dans une colonne : la demande la plus ancienne d'abord pour « À
 * répondre » (la plus urgente), sinon la dernière activité d'abord.
 */
import type { Demand, PendingRequest, Session } from '../../../shared/protocol'
import { summarizeToolInput } from '../../../shared/summary'
import { getLocale, t, type PlainKey } from '../../../shared/i18n'
import { glyphFor } from './status'

export type ColumnKey = 'waiting' | 'running' | 'idle' | 'stopped'

/** Titre d'une colonne : calculé à la lecture, dans la langue courante. */
function column(key: ColumnKey, titleKey: PlainKey): { key: ColumnKey; readonly title: string } {
  return {
    key,
    get title() {
      return t(titleKey)
    },
  }
}

export const COLUMNS: readonly { key: ColumnKey; readonly title: string }[] = [
  column('waiting', 'shell.kanban.column.waiting'),
  column('running', 'shell.kanban.column.running'),
  column('idle', 'shell.kanban.column.idle'),
  column('stopped', 'shell.kanban.column.stopped'),
]

export function columnOf(s: Session): ColumnKey {
  const k = glyphFor(s.status).kind
  return k === 'error' ? 'stopped' : k
}

function time(iso: string | null | undefined): number {
  const t = Date.parse(iso ?? '')
  return Number.isNaN(t) ? 0 : t
}

/** Heure de la plus ancienne demande en attente (ou de la dernière activité). */
function waitingSince(s: Session): number {
  const since = s.pending.map((p) => time(p.since)).filter((t) => t > 0)
  return since.length ? Math.min(...since) : time(s.last_activity ?? s.updated_at)
}

export function kanbanColumns(sessions: readonly Session[]): Record<ColumnKey, Session[]> {
  const cols: Record<ColumnKey, Session[]> = { waiting: [], running: [], idle: [], stopped: [] }
  for (const s of sessions) cols[columnOf(s)].push(s)
  cols.waiting.sort((a, b) => waitingSince(a) - waitingSince(b) || a.id.localeCompare(b.id, getLocale()))
  for (const k of ['running', 'idle', 'stopped'] as const) {
    cols[k].sort(
      (a, b) => time(b.last_activity ?? b.created_at) - time(a.last_activity ?? a.created_at) || a.id.localeCompare(b.id, getLocale()),
    )
  }
  return cols
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  const chars = [...t]
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : t
}

/** Texte court de la demande en attente pour une carte. */
export function demandSummary(d: Demand, max = 140): string {
  if (d.detailed === false) return d.kind === 'question' ? t('shell.kanban.questionNoDetail') : t('shell.kanban.permissionNoDetail')
  if (d.kind === 'question') {
    const q = d.questions[0]?.question ?? t('shell.kanban.question')
    return oneLine(d.questions.length > 1 ? `${q} (+${d.questions.length - 1})` : q, max)
  }
  const what = summarizeToolInput(d.tool_name, d.tool_input)
  return oneLine(`${d.tool_name}${what ? ` · ${what}` : ''}`, max)
}

/**
 * Permission détaillée : l'outil et son entrée (commande, chemin…) séparés,
 * pour poser l'entrée en chasse fixe sur la carte. `null` pour une question ou
 * une demande sans détail (voir `demandSummary`).
 */
export function permissionParts(d: Demand, max = 140): { tool: string; input: string | null } | null {
  if (d.kind !== 'permission' || d.detailed === false) return null
  const what = summarizeToolInput(d.tool_name, d.tool_input)
  return { tool: d.tool_name, input: what ? oneLine(what, Math.max(1, max - [...d.tool_name].length - 3)) : null }
}

/**
 * Le résumé tient-il en entier sur la carte : une seule ligne (pas de commande
 * multiligne aplatie), rien de coupé, au plus `max` caractères ?
 */
export function summaryFits(d: Demand, max = 140): boolean {
  if (d.detailed === false) return false
  let raw: string
  if (d.kind === 'question') raw = d.questions.map((q) => q.question).join('\n')
  else {
    const what = summarizeToolInput(d.tool_name, d.tool_input)
    raw = `${d.tool_name}${what ? ` · ${what}` : ''}`
  }
  return !/[\r\n]/.test(raw) && !raw.endsWith('…') && [...raw].length <= max
}

/**
 * Autoriser / Refuser directement sur la carte ? Seulement si la demande est
 * répondable, détaillée, pas « peut-être obsolète », et que ce qu'on autorise
 * se lit en entier sur la carte ; sinon « Ouvrir » la session.
 */
export function oneClickAllowed(s: Session, req: PendingRequest, stale: readonly number[]): boolean {
  if (req.pending.kind !== 'permission' || req.pending.detailed === false) return false
  if (req.answerable === false || s.possibly_stale || stale.includes(req.request_id)) return false
  return summaryFits(req.pending)
}

/** Première demande en attente (la plus ancienne). */
export function firstPending(s: Session): PendingRequest | null {
  if (!s.pending.length) return null
  return [...s.pending].sort((a, b) => time(a.since) - time(b.since) || a.request_id - b.request_id)[0]!
}
