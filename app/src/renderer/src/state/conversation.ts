/**
 * Vue conversation (v0.3, lots 11 et 12, ADR 0005) : logique pure, testable
 * sans React ni DOM.
 *
 * - `conversationReducer` : page chargée par `conversation.get`, entrées plus
 *   anciennes ajoutées en tête, `conversation.changed` fusionné (un `upsert`
 *   d'un `uid` connu remplace l'entrée, un nouveau s'ajoute à la fin), mis de
 *   côté tant que la première page n'est pas arrivée ; prompts envoyés par
 *   l'app affichés « en attente » jusqu'à leur arrivée dans le transcript.
 * - Historique des prompts (↑ / ↓ dans un champ vide).
 * - Fenêtre de la liste virtualisée (hauteurs estimées puis mesurées).
 * - Lecture tolérante des formes libres (questions, hunks d'un `Edit`).
 */
import type {
  ConversationEntry,
  ConversationPage,
  ConversationSegment,
  DiffHunk,
  DiffLine,
  PromptEntry,
  SessionActivity,
} from '../../../shared/protocol'
import { numberFormat, t } from '../../../shared/i18n'

/* ---------- Fusion des entrées ---------- */

/**
 * Entrées `base` mises à jour par `upserts` : un `uid` connu est remplacé sur
 * place ; un nouveau se range juste avant la première entrée déjà connue qui
 * le suit dans le lot (ordre du démon : la commande `/compact` arrive avec sa
 * compaction et se place devant elle), sinon à la fin. Une entrée ancienne
 * mise à jour dans le même lot ne sert pas de repère : elle peut être loin
 * en arrière dans le fil. Renvoie `base` lui-même si rien ne change.
 */
export function upsertEntries(
  base: readonly ConversationEntry[],
  upserts: readonly ConversationEntry[],
): readonly ConversationEntry[] {
  const batch = upserts.filter(isEntry)
  if (batch.length === 0) return base
  const out: ConversationEntry[] = base.slice()
  let pos = new Map(out.map((x, i) => [x.uid, i]))
  batch.forEach((e, k) => {
    const i = pos.get(e.uid)
    if (i !== undefined) {
      out[i] = e
      return
    }
    let at: number | undefined
    for (let j = k + 1; j < batch.length && at === undefined; j++) at = pos.get(batch[j]!.uid)
    if (at === undefined) {
      pos.set(e.uid, out.length)
      out.push(e)
    } else {
      out.splice(at, 0, e)
      pos = new Map(out.map((x, n) => [x.uid, n]))
    }
  })
  return out
}

/** Entrée masquée par le démon : la commande `/clear` qui ouvre un segment (le séparateur la dit déjà). */
export function isHiddenEntry(e: ConversationEntry): boolean {
  return e.kind === 'command' && e.hidden_by_segment === true
}

/** Entrées plus anciennes `older` placées avant `base` (sans doublon de `uid`). */
export function prependEntries(
  base: readonly ConversationEntry[],
  older: readonly ConversationEntry[],
): readonly ConversationEntry[] {
  const known = new Set(base.map((e) => e.uid))
  const add = older.filter((e) => isEntry(e) && !known.has(e.uid))
  return add.length ? [...add, ...base] : base
}

/** Forme minimale d'une entrée (le démon est fiable, mais une entrée abîmée ne doit pas casser la vue). */
export function isEntry(e: unknown): e is ConversationEntry {
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof (e as { uid?: unknown }).uid === 'string' &&
    typeof (e as { kind?: unknown }).kind === 'string'
  )
}

/* ---------- Prompts envoyés en attente ---------- */

export interface PendingPrompt {
  /** Identifiant local (ordre d'envoi). */
  id: number
  text: string
  /** Le démon a accepté l'envoi (sinon : envoi en cours). */
  sent: boolean
  /** Instant de l'envoi (ms). */
  at: number
  /** L'activité de la session a quitté `idle` depuis l'envoi (le prompt a été pris en compte). */
  busy: boolean
}

/** Espaces normalisés, pour rapprocher un prompt envoyé de son entrée du transcript. */
export function normalizePrompt(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** Texte d'un prompt avec ses collages remis à la place de leur repère `[collage <id>]`. */
export function promptWithPastes(e: PromptEntry): string {
  let text = typeof e.text === 'string' ? e.text : ''
  for (const p of Array.isArray(e.pasted) ? e.pasted : []) {
    if (!p || typeof p.text !== 'string' || typeof p.id !== 'string') continue
    const mark = `[collage ${p.id}]`
    text = text.includes(mark) ? text.split(mark).join(p.text) : `${text} ${p.text}`
  }
  return text
}

/** Textes possibles d'une entrée : prompt (seul, ou avec ses collages remis), commande (`/nom args`, `!commande`). */
function sentCandidates(e: ConversationEntry): string[] {
  if (e.kind === 'prompt') {
    const text = typeof e.text === 'string' ? e.text : ''
    return [normalizePrompt(text), normalizePrompt(promptWithPastes(e))].filter((c) => c !== '')
  }
  if (e.kind === 'command') {
    const name = typeof e.name === 'string' ? e.name.trim() : ''
    const args = typeof e.args === 'string' ? e.args : ''
    if (!name) return []
    if (name === '!') return [normalizePrompt(`!${args}`), normalizePrompt(`! ${args}`)]
    const slash = name.startsWith('/') ? name : `/${name}`
    return [normalizePrompt(`${slash} ${args}`)]
  }
  return []
}

/** Longueur du début commun qui suffit à rapprocher deux longs prompts (collages réécrits par Claude Code). */
const PREFIX_MATCH = 64

/** Le prompt envoyé `sent` est-il celui de l'entrée `e` (prompt ou commande) ? */
export function promptMatches(sent: string, e: ConversationEntry): boolean {
  const s = normalizePrompt(sent)
  if (!s) return false
  return sentCandidates(e).some(
    (c) => c === s || (c.length >= PREFIX_MATCH && s.length >= PREFIX_MATCH && c.slice(0, PREFIX_MATCH) === s.slice(0, PREFIX_MATCH)),
  )
}

/** Marge d'horloge (ms) : une entrée datée de plus tôt que l'envoi ne peut pas être ce prompt. */
const CLOCK_SLACK_MS = 5_000

/**
 * Prompts en attente moins ceux arrivés dans `arrived` (chacun en retire un
 * seul, le plus ancien). `checkTime` : ignore les entrées datées d'avant
 * l'envoi (page entière relue au rechargement, où un même texte a pu être
 * envoyé plus tôt).
 */
export function reconcilePending(
  pending: readonly PendingPrompt[],
  arrived: readonly ConversationEntry[],
  checkTime = false,
): readonly PendingPrompt[] {
  if (pending.length === 0) return pending
  let left = pending
  for (const e of arrived) {
    if ((e.kind !== 'prompt' && e.kind !== 'command') || threadOf(e) !== null) continue
    const ts = e.ts ? Date.parse(e.ts) : Number.NaN
    const i = left.findIndex((p) => promptMatches(p.text, e) && !(checkTime && Number.isFinite(ts) && ts < p.at - CLOCK_SLACK_MS))
    if (i >= 0) left = [...left.slice(0, i), ...left.slice(i + 1)]
  }
  return left
}

/** Délai de grâce après le retour au repos, pour laisser le transcript arriver (ms). */
export const SETTLE_GRACE_MS = 4_000
/** Une attente envoyée sans activité vue depuis est retirée au repos passé ce délai (ms). */
export const SETTLE_IDLE_MS = 15_000

/**
 * Repli quand le transcript n'apportera rien de reconnaissable : au repos,
 * une attente envoyée est retirée si l'activité a bougé depuis son envoi, ou
 * si elle date de plus de `SETTLE_IDLE_MS`.
 */
export function settlePending(pending: readonly PendingPrompt[], now: number): readonly PendingPrompt[] {
  const left = pending.filter((p) => !p.sent || !(p.busy || now - p.at >= SETTLE_IDLE_MS))
  return left.length === pending.length ? pending : left
}

/** Délai avant le prochain repli au repos, ou `null` si aucune attente envoyée. */
export function settleDelay(pending: readonly PendingPrompt[], now: number): number | null {
  let best: number | null = null
  for (const p of pending) {
    if (!p.sent) continue
    const d = p.busy ? SETTLE_GRACE_MS : Math.max(SETTLE_GRACE_MS, p.at + SETTLE_IDLE_MS - now)
    best = best === null ? d : Math.min(best, d)
  }
  return best
}

/* ---------- État de la conversation ---------- */

export type ConversationPhase = 'loading' | 'ready' | 'unsupported' | 'error'

export interface ConversationState {
  phase: ConversationPhase
  error: string | null
  /** Fil principal (entrées des sous-agents exclues), dans l'ordre chronologique. */
  entries: readonly ConversationEntry[]
  segments: readonly ConversationSegment[]
  hasMore: boolean
  /** Chargement des entrées plus anciennes en cours. */
  olderLoading: boolean
  olderError: string | null
  invalidLines: number
  /** `conversation.changed` reçus avant la première page (appliqués ensuite). */
  buffered: readonly ConversationEntry[]
  bufferedSegments: readonly ConversationSegment[]
  pending: readonly PendingPrompt[]
}

export const initialConversation: ConversationState = {
  phase: 'loading',
  error: null,
  entries: [],
  segments: [],
  hasMore: false,
  olderLoading: false,
  olderError: null,
  invalidLines: 0,
  buffered: [],
  bufferedSegments: [],
  pending: [],
}

export type ConversationAction =
  | { type: 'reload' }
  | { type: 'loaded'; page: ConversationPage }
  | { type: 'failed'; unsupported: boolean; message: string }
  | { type: 'olderStart' }
  | { type: 'older'; page: ConversationPage }
  | { type: 'olderFailed'; message: string }
  | { type: 'changed'; upserts: readonly ConversationEntry[]; segment?: ConversationSegment | null }
  | { type: 'send'; id: number; text: string; at: number }
  | { type: 'sent'; id: number }
  /** Activité de la session (hooks) : hors repos, les attentes envoyées sont marquées prises en compte. */
  | { type: 'activity'; idle: boolean }
  /** Repos prolongé : repli des attentes que le transcript n'a pas reconnues (`settlePending`). */
  | { type: 'settle'; now: number }
  | { type: 'sendFailed'; id: number }
  | { type: 'dismiss'; id: number }
  /** La session s'est arrêtée : plus rien n'arrivera pour les prompts en attente. */
  | { type: 'stopped' }

/**
 * Sous-agent dont l'entrée fait partie du fil, `null` pour le fil principal.
 * Une entrée `subagent` porte dans `agent_id` l'agent qu'elle **lance** : son
 * fil est celui de `parent_agent_id` (sous-agent lancé par un sous-agent),
 * sinon le fil principal.
 */
export function threadOf(e: ConversationEntry): string | null {
  return e.kind === 'subagent' ? e.parent_agent_id || null : e.agent_id || null
}

/** Entrées du fil principal seulement (celles d'un sous-agent se lisent sous son appel). */
function mainThread(list: readonly ConversationEntry[]): ConversationEntry[] {
  return list.filter((e) => isEntry(e) && threadOf(e) === null)
}

function addSegment(list: readonly ConversationSegment[], s: ConversationSegment | null | undefined): readonly ConversationSegment[] {
  if (!s || typeof s.segment !== 'number') return list
  const rest = list.filter((x) => x.segment !== s.segment)
  return [...rest, s].sort((a, b) => a.segment - b.segment)
}

export function conversationReducer(s: ConversationState, a: ConversationAction): ConversationState {
  switch (a.type) {
    case 'reload':
      // Les prompts en attente restent : ils arriveront dans la page rechargée ou dans une notification.
      return { ...initialConversation, pending: s.pending }
    case 'loaded': {
      const page = mainThread(Array.isArray(a.page.entries) ? a.page.entries : [])
      const entries = upsertEntries(page, s.buffered)
      let segments: readonly ConversationSegment[] = Array.isArray(a.page.segments) ? a.page.segments : []
      for (const seg of s.bufferedSegments) segments = addSegment(segments, seg)
      return {
        ...s,
        phase: 'ready',
        error: null,
        entries,
        segments,
        hasMore: a.page.has_more === true,
        invalidLines: typeof a.page.invalid_lines === 'number' ? a.page.invalid_lines : 0,
        buffered: [],
        bufferedSegments: [],
        pending: reconcilePending(s.pending, [...page, ...s.buffered], true),
      }
    }
    case 'failed':
      return { ...s, phase: a.unsupported ? 'unsupported' : 'error', error: a.message, buffered: [], bufferedSegments: [] }
    case 'olderStart':
      return { ...s, olderLoading: true, olderError: null }
    case 'older': {
      let segments = s.segments
      for (const seg of Array.isArray(a.page.segments) ? a.page.segments : []) segments = addSegment(segments, seg)
      return {
        ...s,
        olderLoading: false,
        entries: prependEntries(s.entries, mainThread(Array.isArray(a.page.entries) ? a.page.entries : [])),
        segments,
        hasMore: a.page.has_more === true,
      }
    }
    case 'olderFailed':
      return { ...s, olderLoading: false, olderError: a.message }
    case 'changed': {
      const upserts = mainThread(Array.isArray(a.upserts) ? a.upserts : [])
      if (s.phase === 'loading') {
        return {
          ...s,
          buffered: upsertEntries(s.buffered, upserts),
          bufferedSegments: a.segment ? [...s.bufferedSegments, a.segment] : s.bufferedSegments,
        }
      }
      if (s.phase !== 'ready') return s
      // Seules les entrées nouvelles peuvent rapprocher un prompt en attente (pas une mise à jour d'une ancienne).
      const known = new Set(s.entries.map((e) => e.uid))
      const fresh = upserts.filter((e) => !known.has(e.uid))
      const entries = upsertEntries(s.entries, upserts)
      const segments = addSegment(s.segments, a.segment)
      const pending = reconcilePending(s.pending, fresh)
      if (entries === s.entries && segments === s.segments && pending === s.pending) return s
      return { ...s, entries, segments, pending }
    }
    case 'send':
      return { ...s, pending: [...s.pending, { id: a.id, text: a.text, sent: false, at: a.at, busy: false }] }
    case 'activity':
      if (a.idle || !s.pending.some((p) => p.sent && !p.busy)) return s
      return { ...s, pending: s.pending.map((p) => (p.sent && !p.busy ? { ...p, busy: true } : p)) }
    case 'settle': {
      const pending = settlePending(s.pending, a.now)
      return pending === s.pending ? s : { ...s, pending }
    }
    case 'sent':
      return { ...s, pending: s.pending.map((p) => (p.id === a.id ? { ...p, sent: true } : p)) }
    case 'sendFailed':
    case 'dismiss':
      return { ...s, pending: s.pending.filter((p) => p.id !== a.id) }
    case 'stopped':
      return s.pending.length ? { ...s, pending: [] } : s
  }
}

/** Raison d'un segment pour son séparateur (« /clear », reprise…). */
export function segmentLabel(seg: ConversationSegment | undefined): string {
  if (!seg) return t('conversation.segment.new')
  if (seg.reason === 'clear') return t('conversation.segment.clear')
  if (seg.reason === 'resume') return t('conversation.segment.resume')
  return t('conversation.segment.start')
}

/* ---------- Historique des prompts ---------- */

export const MAX_HISTORY = 100

/** Historique après l'envoi de `text` (pas de doublon consécutif, 100 au plus). */
export function pushHistory(items: readonly string[], text: string): readonly string[] {
  if (!text.trim() || items[items.length - 1] === text) return items
  const next = [...items, text]
  return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next
}

/**
 * ↑ / ↓ dans le champ : on n'entre dans l'historique que depuis un champ
 * vide ; une fois dedans, on y circule tant que le texte affiché n'a pas été
 * modifié. ↓ après le plus récent rend un champ vide. `null` : la touche
 * garde son effet normal (déplacer le curseur).
 */
export function historyStep(
  items: readonly string[],
  index: number | null,
  value: string,
  dir: 'up' | 'down',
): { index: number | null; value: string } | null {
  if (items.length === 0) return null
  if (index === null) {
    if (value !== '' || dir === 'down') return null
    return { index: items.length - 1, value: items[items.length - 1]! }
  }
  if (items[index] !== value) return null
  if (dir === 'up') return index > 0 ? { index: index - 1, value: items[index - 1]! } : { index, value }
  if (index < items.length - 1) return { index: index + 1, value: items[index + 1]! }
  return { index: null, value: '' }
}

/** Octets UTF-8 d'un texte (borne de `sessions.sendPrompt` : 256 Kio). */
export function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length
}

export const MAX_PROMPT_BYTES = 256 * 1024

/** Raison pour laquelle le prompt ne peut pas partir, ou `null`. */
export function promptProblem(text: string): string | null {
  if (!text.trim()) return t('conversation.prompt.empty')
  if (utf8Length(text) > MAX_PROMPT_BYTES) return t('conversation.prompt.tooLong')
  return null
}

/* ---------- Défilement ---------- */

/** Distance au bas (px) sous laquelle la vue reste « collée » en bas. */
export const STICK_THRESHOLD = 48

export function isAtBottom(scrollTop: number, scrollHeight: number, clientHeight: number, threshold = STICK_THRESHOLD): boolean {
  return scrollHeight - clientHeight - scrollTop <= threshold
}

/** Distance du haut (px) sous laquelle les entrées plus anciennes sont demandées. */
export const OLDER_THRESHOLD = 200

/* ---------- Virtualisation ---------- */

/** Hauteur estimée d'une entrée avant sa mesure (px). */
export function estimateHeight(e: ConversationEntry): number {
  switch (e.kind) {
    case 'tool':
    case 'thinking':
    case 'notification':
    case 'command':
    case 'error':
    case 'unknown':
    case 'subagent':
      return 36
    case 'compaction':
      return 48
    case 'question':
      return 120
    case 'prompt':
      return 56 + Math.min(400, Math.ceil((e.text?.length ?? 0) / 90) * 20)
    case 'text':
      return 40 + Math.min(1200, Math.ceil((e.markdown?.length ?? 0) / 90) * 22)
    default:
      return 40
  }
}

/** Décalages cumulés : `offsets[i]` = haut de l'entrée `i`, `offsets[n]` = hauteur totale. */
export function layoutOffsets(heights: readonly number[]): number[] {
  const out = new Array<number>(heights.length + 1)
  out[0] = 0
  for (let i = 0; i < heights.length; i++) out[i + 1] = out[i]! + heights[i]!
  return out
}

/** Premier indice `i` tel que `offsets[i + 1] > y` (entrée qui contient `y`). */
function indexAt(offsets: readonly number[], y: number): number {
  const n = offsets.length - 1
  let lo = 0
  let hi = n - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (offsets[mid + 1]! <= y) lo = mid + 1
    else hi = mid
  }
  return Math.max(0, Math.min(lo, n - 1))
}

/**
 * Entrées à rendre `[start, end)` pour une fenêtre de défilement, avec une
 * marge de `overscan` px de chaque côté. Liste vide : `{0, 0}`.
 */
export function visibleRange(
  offsets: readonly number[],
  scrollTop: number,
  viewport: number,
  overscan: number,
): { start: number; end: number } {
  const n = offsets.length - 1
  if (n <= 0) return { start: 0, end: 0 }
  const top = Math.max(0, scrollTop - overscan)
  const bottom = Math.max(top, scrollTop + Math.max(0, viewport) + overscan)
  const start = indexAt(offsets, top)
  const end = Math.min(n, indexAt(offsets, bottom) + 1)
  return { start, end: Math.max(end, start + 1) }
}

/* ---------- Formes libres ---------- */

export interface QuestionView {
  question: string
  header: string | null
  multiSelect: boolean
  options: { label: string; description: string | null }[]
  /** Réponse choisie (libellés ou texte libre), `null` si aucune. */
  answer: string[] | null
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

/** Questions d'`AskUserQuestion` et réponses choisies, lues avec tolérance. */
export function questionViews(questions: unknown, answers: unknown): QuestionView[] {
  const list = Array.isArray(questions) ? questions : []
  const ans = typeof answers === 'object' && answers !== null && !Array.isArray(answers) ? (answers as Record<string, unknown>) : {}
  const ansList = Array.isArray(answers) ? answers : null
  return list.flatMap((q, i) => {
    if (typeof q !== 'object' || q === null) return []
    const o = q as Record<string, unknown>
    const question = str(o.question) ?? ''
    const options = (Array.isArray(o.options) ? o.options : []).flatMap((x) => {
      if (typeof x === 'string') return [{ label: x, description: null }]
      if (typeof x !== 'object' || x === null) return []
      const label = str((x as Record<string, unknown>).label)
      return label === null ? [] : [{ label, description: str((x as Record<string, unknown>).description) }]
    })
    const raw = ansList ? ansList[i] : ans[question]
    const answer =
      typeof raw === 'string'
        ? raw
            .split(/,\s*/)
            .map((x) => x.trim())
            .filter(Boolean)
        : Array.isArray(raw)
          ? raw.filter((x): x is string => typeof x === 'string')
          : null
    // Une réponse libre qui contient une virgule ne doit pas être coupée : on garde le texte entier s'il ne correspond à aucune option.
    const fixed =
      typeof raw === 'string' && answer && !answer.every((a) => options.some((op) => op.label === a)) ? [raw] : answer
    return [
      {
        question,
        header: str(o.header),
        multiSelect: o.multiSelect === true || o.multi_select === true,
        options,
        answer: fixed && fixed.length ? fixed : null,
      },
    ]
  })
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * Hunks d'un `Edit` / `Write` : forme `DiffHunk` du protocole, ou forme
 * brute de `structuredPatch` (`oldStart`, `oldLines`, `newStart`,
 * `newLines`, `lines: ["+…", "-…", " …"]`). `null` si rien d'utilisable.
 */
export function patchHunks(patch: unknown): DiffHunk[] | null {
  const list = Array.isArray(patch) ? patch : typeof patch === 'object' && patch !== null && Array.isArray((patch as { hunks?: unknown }).hunks) ? (patch as { hunks: unknown[] }).hunks : null
  if (!list) return null
  const out: DiffHunk[] = []
  for (const h of list) {
    if (typeof h !== 'object' || h === null) continue
    const o = h as Record<string, unknown>
    const oldStart = num(o.old_start) ?? num(o.oldStart) ?? 1
    const newStart = num(o.new_start) ?? num(o.newStart) ?? 1
    const oldLines = num(o.old_lines) ?? num(o.oldLines) ?? 0
    const newLines = num(o.new_lines) ?? num(o.newLines) ?? 0
    const rawLines = Array.isArray(o.lines) ? o.lines : []
    let oldNo = oldStart
    let newNo = newStart
    const lines: DiffLine[] = []
    for (const l of rawLines) {
      if (typeof l === 'string') {
        const c = l[0]
        const text = l.slice(1)
        if (c === '+') lines.push({ kind: '+', old_no: null, new_no: newNo++, text })
        else if (c === '-') lines.push({ kind: '-', old_no: oldNo++, new_no: null, text })
        else if (c === '\\') continue
        else lines.push({ kind: ' ', old_no: oldNo++, new_no: newNo++, text: c === ' ' ? text : l })
      } else if (typeof l === 'object' && l !== null) {
        const x = l as Record<string, unknown>
        const kind = x.kind === '+' || x.kind === '-' ? x.kind : ' '
        lines.push({ kind, old_no: num(x.old_no), new_no: num(x.new_no), text: str(x.text) ?? '' })
      }
    }
    if (lines.length === 0) continue
    const header = str(o.header) ?? `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`
    out.push({ header, old_start: oldStart, old_lines: oldLines, new_start: newStart, new_lines: newLines, lines })
  }
  return out.length ? out : null
}

/** Coupe un long texte pour l'affichage (« Voir tout » le montre en entier). */
export function clipText(text: string, maxChars: number, maxLines: number): { shown: string; clipped: boolean } {
  let cut = text.length > maxChars ? maxChars : text.length
  let lines = 0
  for (let i = 0; i < cut; i++) {
    if (text.charCodeAt(i) === 10 && ++lines >= maxLines) {
      cut = i
      break
    }
  }
  return cut < text.length ? { shown: text.slice(0, cut), clipped: true } : { shown: text, clipped: false }
}

/** Valeur quelconque (entrée d'un outil) en texte lisible : JSON indenté, chaînes telles quelles. */
export function inputText(input: unknown): string {
  if (typeof input === 'string') return input
  if (input === undefined || input === null) return ''
  try {
    return JSON.stringify(input, null, 2) ?? ''
  } catch {
    return String(input)
  }
}

/* ---------- Libellés ---------- */

const TOOL_ICONS: Record<string, string> = {
  Bash: '$',
  Read: '▤',
  Edit: '✎',
  MultiEdit: '✎',
  Write: '✎',
  NotebookEdit: '✎',
  Grep: '⌕',
  Glob: '⌕',
  WebFetch: '⇅',
  WebSearch: '⇅',
  Agent: '⧉',
  Task: '⧉',
  TodoWrite: '☑',
}

export function toolIcon(name: string): string {
  return TOOL_ICONS[name] ?? (name.startsWith('mcp__') ? '⚇' : '⚙')
}

/** Statut d'un outil : glyphe et texte (jamais la couleur seule). */
export function toolStatus(result: { status?: unknown } | null | undefined): { key: string; glyph: string; label: string } {
  if (!result) return { key: 'running', glyph: '…', label: t('conversation.status.running') }
  if (result.status === 'ok') return { key: 'ok', glyph: '✓', label: t('conversation.toolStatus.ok') }
  if (result.status === 'error') return { key: 'error', glyph: '×', label: t('conversation.toolStatus.error') }
  if (result.status === 'interrupted') return { key: 'interrupted', glyph: '■', label: t('conversation.status.interrupted') }
  return { key: 'other', glyph: '?', label: typeof result.status === 'string' ? result.status : t('conversation.status.unknown') }
}

export function subagentStatusLabel(status: unknown): string {
  switch (status) {
    case 'running':
      return t('conversation.status.running')
    case 'done':
      return t('conversation.agentStatus.done')
    case 'failed':
      return t('conversation.agentStatus.failed')
    case 'interrupted':
      return t('conversation.status.interrupted')
    default:
      return typeof status === 'string' && status ? status : t('conversation.status.unknown')
  }
}

export function promptSourceLabel(source: unknown): string | null {
  switch (source) {
    case 'queued':
      return t('conversation.promptSource.queued')
    case 'suggestion':
      return t('conversation.promptSource.suggestion')
    case 'system':
      return t('conversation.promptSource.system')
    case 'sdk':
      return t('conversation.promptSource.sdk')
    default:
      return null
  }
}

/** Libellé de l'indicateur d'activité, `null` au repos (ou démon plus ancien). */
export function activityLabel(a: SessionActivity | null | undefined): string | null {
  if (!a) return null
  switch (a.kind) {
    case 'prompt':
      return t('conversation.activity.prompt')
    case 'tool':
      return a.tool ? t('conversation.activity.tool', { tool: a.tool }) : t('conversation.activity.toolAny')
    case 'subagents':
      return t('conversation.activity.subagents')
    case 'compacting':
      return t('conversation.activity.compacting')
    case 'waiting':
      return t('conversation.activity.waiting')
    default:
      return null
  }
}

/** Temps écoulé lisible : « 12 s », « 3 min 05 s », « 1 h 02 min ». */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')} s`
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`
}

/** « 120 k », « 8 500 » : nombre de tokens d'une compaction. */
export function tokensLabel(n: number | null | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '?'
  if (n >= 10_000) return `${Math.round(n / 1000)} k`
  return numberFormat().format(n)
}

/** Taille d'un texte en caractères, lisible (« 1 234 caractères »). */
export function charsLabel(n: number): string {
  return t('conversation.chars', { count: n, n: numberFormat().format(n) })
}
