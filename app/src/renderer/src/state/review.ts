/**
 * Revue d'une session : commentaires par ligne et commentaire général, en
 * mémoire tant qu'ils ne sont pas envoyés (gardés quand on change de session).
 * Réducteur pur, réancrage après rechargement du diff et construction de la
 * revue envoyée (`sessions.sendReview`).
 *
 * Chaque commentaire garde le texte de sa ligne : quand le diff change, il est
 * replacé sur la ligne au même texte la plus proche ; sinon il devient
 * « ligne modifiée » (hors du compte, pas envoyé, gardé avec un avertissement).
 */
import type { DiffFile, ReviewComment, ReviewSide } from '../../../shared/protocol'
import type { DiffRow, LineAnchor } from './diff'

/** Limites du démon (`sessions.sendReview`). */
export const MAX_COMMENTS = 200
export const MAX_COMMENT_CHARS = 4000

export interface DraftComment {
  id: number
  path: string
  side: ReviewSide
  line: number
  text: string
  /** Texte de la ligne commentée, pour la retrouver si le diff change. */
  lineText: string
  /** La ligne n'existe plus telle quelle dans le diff : « ligne modifiée ». */
  stale?: boolean
}

export interface ReviewEditing {
  path: string
  side: ReviewSide
  line: number
  lineText: string
  /** Brouillon du commentaire (gardé si le diff est rechargé). */
  text: string
}

export interface ReviewDraft {
  comments: DraftComment[]
  general: string
  /** Ligne dont la boîte de commentaire est ouverte. */
  editing: ReviewEditing | null
  nextId: number
}

export const emptyDraft: ReviewDraft = { comments: [], general: '', editing: null, nextId: 1 }

export type ReviewAction =
  | { type: 'edit'; path: string; anchor: LineAnchor; lineText: string }
  /** Texte de la boîte ouverte. */
  | { type: 'editText'; text: string }
  | { type: 'cancel' }
  /** Enregistre la boîte ouverte ; texte vide = annuler. */
  | { type: 'save' }
  | { type: 'delete'; id: number }
  | { type: 'general'; text: string }
  | { type: 'clear' }
  /** Revue envoyée : seuls ces commentaires (et le commentaire général s'il est parti) sont retirés. */
  | { type: 'sent'; ids: number[]; general: boolean }
  /** Lignes du fichier rechargées : commentaires et boîte ouverte replacés. */
  | { type: 'reanchor'; path: string; rows: DiffRow[] }

function clip(s: string, max: number): string {
  const chars = [...s]
  return chars.length > max ? chars.slice(0, max).join('') : s
}

/** Commentaires comptés et envoyables (hors « ligne modifiée »). */
export function activeComments(d: ReviewDraft): DraftComment[] {
  return d.comments.filter((c) => !c.stale)
}

/**
 * Ligne au même texte, du même côté, la plus proche de l'ancienne position ;
 * `null` si aucune.
 */
export function findAnchor(rows: readonly DiffRow[], side: ReviewSide, line: number, lineText: string): number | null {
  let best: number | null = null
  for (const r of rows) {
    if (r.type !== 'line' || !r.anchor || r.anchor.side !== side || r.text !== lineText) continue
    const n = r.anchor.line
    if (best === null || Math.abs(n - line) < Math.abs(best - line) || (Math.abs(n - line) === Math.abs(best - line) && n < best)) best = n
  }
  return best
}

export function reviewReducer(d: ReviewDraft, a: ReviewAction): ReviewDraft {
  switch (a.type) {
    case 'edit': {
      if (activeComments(d).length >= MAX_COMMENTS) return d
      const same =
        d.editing && d.editing.path === a.path && d.editing.side === a.anchor.side && d.editing.line === a.anchor.line
      if (same) return d
      return { ...d, editing: { path: a.path, side: a.anchor.side, line: a.anchor.line, lineText: a.lineText, text: '' } }
    }
    case 'editText':
      return d.editing ? { ...d, editing: { ...d.editing, text: clip(a.text, MAX_COMMENT_CHARS) } } : d
    case 'cancel':
      return d.editing ? { ...d, editing: null } : d
    case 'save': {
      const e = d.editing
      if (!e) return d
      const text = e.text.trim()
      if (!text || activeComments(d).length >= MAX_COMMENTS) return { ...d, editing: null }
      return {
        ...d,
        editing: null,
        comments: [...d.comments, { id: d.nextId, path: e.path, side: e.side, line: e.line, text, lineText: e.lineText }],
        nextId: d.nextId + 1,
      }
    }
    case 'delete':
      return { ...d, comments: d.comments.filter((c) => c.id !== a.id) }
    case 'general':
      return { ...d, general: clip(a.text, MAX_COMMENT_CHARS) }
    case 'clear':
      return { ...emptyDraft, nextId: d.nextId }
    case 'sent': {
      const ids = new Set(a.ids)
      return { ...d, comments: d.comments.filter((c) => !ids.has(c.id)), general: a.general ? '' : d.general }
    }
    case 'reanchor': {
      let changed = false
      const comments = d.comments.map((c) => {
        if (c.path !== a.path) return c
        const n = findAnchor(a.rows, c.side, c.line, c.lineText)
        const next: DraftComment = n === null ? { ...c, stale: true } : { ...c, line: n, stale: false }
        if (next.line === c.line && !!next.stale === !!c.stale) return c
        changed = true
        return next
      })
      let editing = d.editing
      if (editing && editing.path === a.path) {
        const n = findAnchor(a.rows, editing.side, editing.line, editing.lineText)
        // Ligne disparue : la boîte se ferme, le brouillon serait sans ancre.
        const next = n === null ? null : n === editing.line ? editing : { ...editing, line: n }
        if (next !== editing) {
          changed = true
          editing = next
        }
      }
      return changed ? { ...d, comments, editing } : d
    }
  }
}

/** Y a-t-il quelque chose à perdre ? */
export function hasDraft(d: ReviewDraft | undefined): boolean {
  return !!d && (d.comments.length > 0 || d.general.trim() !== '' || !!d.editing?.text.trim())
}

export function commentsAt(d: ReviewDraft, path: string, anchor: LineAnchor): DraftComment[] {
  return d.comments.filter((c) => !c.stale && c.path === path && c.side === anchor.side && c.line === anchor.line)
}

export interface BuiltReview {
  comments: ReviewComment[]
  /** Identifiants des commentaires envoyés (retirés après succès). */
  ids: number[]
  general?: string
  /** Commentaires pas envoyés : « ligne modifiée », ou fichier qui n'est plus dans le diff. */
  dropped: DraftComment[]
}

/**
 * Revue à envoyer : seulement les commentaires ancrés dont le fichier est dans
 * la liste du diff (le démon refuse les autres), dans l'ordre de la liste puis
 * des lignes. `null` s'il n'y a rien à envoyer.
 */
export function buildReview(d: ReviewDraft, files: readonly DiffFile[]): BuiltReview | null {
  const order = new Map(files.map((f, i) => [f.path, i]))
  const ok = (c: DraftComment) => !c.stale && order.has(c.path)
  const kept = d.comments.filter(ok).slice(0, MAX_COMMENTS)
  const dropped = d.comments.filter((c) => !ok(c))
  const sorted = [...kept].sort(
    (a, b) =>
      order.get(a.path)! - order.get(b.path)! || a.line - b.line || (a.side === b.side ? 0 : a.side === 'old' ? -1 : 1) || a.id - b.id,
  )
  const general = d.general.trim()
  if (sorted.length === 0 && !general) return null
  return {
    comments: sorted.map((c) => ({ path: c.path, line: c.line, side: c.side, text: c.text })),
    ids: sorted.map((c) => c.id),
    ...(general ? { general } : {}),
    dropped,
  }
}
