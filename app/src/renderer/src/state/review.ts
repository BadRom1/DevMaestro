/**
 * Revue d'une session : commentaires par ligne du diff, commentaires sur des
 * lignes de fichier (onglet Fichiers), commentaires par ligne du diff d'un
 * commit (onglet Commits) et commentaire général, en mémoire tant qu'ils ne
 * sont pas envoyés (gardés quand on change de session ou d'onglet). Un seul
 * brouillon par session, partagé par les onglets Diff, Fichiers et Commits.
 * Réducteur pur, réancrage après rechargement du diff et construction de la
 * revue envoyée (`sessions.sendReview`).
 *
 * Chaque commentaire de diff garde le texte de sa ligne : quand le diff change,
 * il est replacé sur la ligne au même texte la plus proche ; sinon il devient
 * « ligne modifiée » (hors du compte, pas envoyé, gardé avec un avertissement).
 * Un commentaire de fichier ne garde que ses numéros de ligne : le démon relit
 * les lignes actuelles à l'envoi. Un commentaire de commit n'est jamais
 * réancré (un commit ne change pas) ; si le commit sort de l'historique de la
 * session, le démon le refuse et la barre de revue le désigne.
 */
import type { AnyReviewComment, DiffFile, ReviewSide } from '../../../shared/protocol'
import type { PromptVars } from '../../../shared/prompts'
import type { DiffRow, LineAnchor } from './diff'

/** Limites du démon (`sessions.sendReview`). */
export const MAX_COMMENTS = 200
export const MAX_COMMENT_CHARS = 4000
/** Lignes d'un commentaire de fichier, au plus. */
export const MAX_FILE_COMMENT_LINES = 400

/** Commentaire sur une ligne du diff. */
export interface DiffDraftComment {
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

/** Commentaire sur les lignes `line` à `lineEnd` d'un fichier (remarque facultative). */
export interface FileDraftComment {
  kind: 'file'
  id: number
  path: string
  line: number
  lineEnd: number
  text: string
}

/** Commentaire sur une ligne du diff d'un commit (`sha` complet). */
export interface CommitDraftComment {
  kind: 'commit'
  id: number
  sha: string
  path: string
  side: ReviewSide
  line: number
  text: string
  lineText: string
}

export type DraftComment = DiffDraftComment | FileDraftComment | CommitDraftComment

export const isFileComment = (c: DraftComment): c is FileDraftComment => 'kind' in c && c.kind === 'file'
export const isCommitComment = (c: DraftComment): c is CommitDraftComment => 'kind' in c && c.kind === 'commit'
export const isDiffComment = (c: DraftComment): c is DiffDraftComment => !('kind' in c)

/** Sha court affiché (7 caractères, comme git). */
export const shortSha = (sha: string): string => sha.slice(0, 7)

/** « a1b2c3d src/a.rs:12 » (« (ancienne version) » côté ancien). */
export function commitCommentLabel(c: Pick<CommitDraftComment, 'sha' | 'path' | 'line' | 'side'>): string {
  return `${shortSha(c.sha)} ${c.path}:${c.line}${c.side === 'old' ? ' (ancienne version)' : ''}`
}

/** Lignes couvertes par une sélection de fichier, ou pourquoi on ne peut pas la commenter. */
export function fileSelectionError(line: number, lineEnd: number): string | null {
  if (!Number.isInteger(line) || !Number.isInteger(lineEnd) || line < 1 || lineEnd < line) return 'sélection invalide'
  const n = lineEnd - line + 1
  return n > MAX_FILE_COMMENT_LINES ? `sélection trop longue (${n} lignes) : ${MAX_FILE_COMMENT_LINES} lignes au plus` : null
}

export interface ReviewEditing {
  /** Commit commenté (onglet Commits) ; absent : diff du worktree. */
  sha?: string
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
  | { type: 'edit'; path: string; anchor: LineAnchor; lineText: string; sha?: string }
  /** Texte de la boîte ouverte. */
  | { type: 'editText'; text: string }
  | { type: 'cancel' }
  /** Enregistre la boîte ouverte ; texte vide = annuler. */
  | { type: 'save' }
  | { type: 'delete'; id: number }
  /** Commentaire sur des lignes d'un fichier (texte facultatif). */
  | { type: 'addFile'; path: string; line: number; lineEnd: number; text: string }
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

/** Commentaires comptés et envoyables (hors « ligne modifiée »), diff, fichiers et commits. */
export function activeComments(d: ReviewDraft): DraftComment[] {
  return d.comments.filter((c) => !isDiffComment(c) || !c.stale)
}

/** Commentaires de commit du brouillon (d'un commit, ou tous), par ordre d'ajout. */
export function commitComments(d: ReviewDraft, sha?: string): CommitDraftComment[] {
  return d.comments.filter(isCommitComment).filter((c) => sha === undefined || c.sha === sha)
}

/** La boîte ouverte est-elle sur cette ligne (du diff du worktree si `sha` est absent) ? */
export function editingAt(d: ReviewDraft, path: string | null, anchor: LineAnchor, sha?: string): boolean {
  const e = d.editing
  return !!e && e.path === path && (e.sha ?? null) === (sha ?? null) && e.side === anchor.side && e.line === anchor.line
}

/** Commentaires de fichier du brouillon, par chemin puis ligne. */
export function fileComments(d: ReviewDraft, path?: string): FileDraftComment[] {
  return d.comments
    .filter(isFileComment)
    .filter((c) => path === undefined || c.path === path)
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.line - b.line || a.id - b.id)
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
      if (editingAt(d, a.path, a.anchor, a.sha)) return d
      return {
        ...d,
        editing: { ...(a.sha ? { sha: a.sha } : {}), path: a.path, side: a.anchor.side, line: a.anchor.line, lineText: a.lineText, text: '' },
      }
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
      const comment: DraftComment = e.sha
        ? { kind: 'commit', id: d.nextId, sha: e.sha, path: e.path, side: e.side, line: e.line, text, lineText: e.lineText }
        : { id: d.nextId, path: e.path, side: e.side, line: e.line, text, lineText: e.lineText }
      return { ...d, editing: null, comments: [...d.comments, comment], nextId: d.nextId + 1 }
    }
    case 'delete':
      return { ...d, comments: d.comments.filter((c) => c.id !== a.id) }
    case 'addFile': {
      if (!a.path || fileSelectionError(a.line, a.lineEnd) || activeComments(d).length >= MAX_COMMENTS) return d
      const comment: FileDraftComment = {
        kind: 'file',
        id: d.nextId,
        path: a.path,
        line: a.line,
        lineEnd: a.lineEnd,
        text: clip(a.text.trim(), MAX_COMMENT_CHARS),
      }
      return { ...d, comments: [...d.comments, comment], nextId: d.nextId + 1 }
    }
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
        if (!isDiffComment(c) || c.path !== a.path) return c
        const n = findAnchor(a.rows, c.side, c.line, c.lineText)
        const next: DiffDraftComment = n === null ? { ...c, stale: true } : { ...c, line: n, stale: false }
        if (next.line === c.line && !!next.stale === !!c.stale) return c
        changed = true
        return next
      })
      let editing = d.editing
      if (editing && !editing.sha && editing.path === a.path) {
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

export function commentsAt(d: ReviewDraft, path: string, anchor: LineAnchor): DiffDraftComment[] {
  return d.comments.filter(isDiffComment).filter((c) => !c.stale && c.path === path && c.side === anchor.side && c.line === anchor.line)
}

/** Commentaires d'une ligne du diff d'un commit. */
export function commitCommentsAt(d: ReviewDraft, sha: string, path: string, anchor: LineAnchor): CommitDraftComment[] {
  return commitComments(d, sha).filter((c) => c.path === path && c.side === anchor.side && c.line === anchor.line)
}

export interface BuiltReview {
  comments: AnyReviewComment[]
  /** Identifiants des commentaires envoyés (retirés après succès). */
  ids: number[]
  general?: string
  /** Commentaires de diff pas envoyés : « ligne modifiée », ou fichier qui n'est plus dans le diff. */
  dropped: DiffDraftComment[]
}

/**
 * Revue à envoyer : les commentaires de diff ancrés dont le fichier est dans
 * la liste du diff (le démon refuse les autres), dans l'ordre de la liste puis
 * des lignes, puis les commentaires de commit (commits dans l'ordre où ils ont
 * été commentés, puis chemin et ligne ; le démon vérifie que le commit est
 * dans l'historique), puis les commentaires de fichier (toujours envoyables :
 * le démon relit les lignes), par chemin puis ligne. `null` s'il n'y a rien à
 * envoyer.
 */
export function buildReview(d: ReviewDraft, files: readonly DiffFile[]): BuiltReview | null {
  const order = new Map(files.map((f, i) => [f.path, i]))
  const diffs = d.comments.filter(isDiffComment)
  const ok = (c: DiffDraftComment) => !c.stale && order.has(c.path)
  const dropped = diffs.filter((c) => !ok(c))
  const sortedDiff = diffs
    .filter(ok)
    .sort(
      (a, b) =>
        order.get(a.path)! - order.get(b.path)! || a.line - b.line || (a.side === b.side ? 0 : a.side === 'old' ? -1 : 1) || a.id - b.id,
    )
  const commits = commitComments(d)
  const firstSeen = new Map<string, number>()
  commits.forEach((c, i) => firstSeen.has(c.sha) || firstSeen.set(c.sha, i))
  const sortedCommits = [...commits].sort(
    (a, b) =>
      firstSeen.get(a.sha)! - firstSeen.get(b.sha)! ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
      a.line - b.line ||
      (a.side === b.side ? 0 : a.side === 'old' ? -1 : 1) ||
      a.id - b.id,
  )
  const sorted: DraftComment[] = [...sortedDiff, ...sortedCommits, ...fileComments(d)].slice(0, MAX_COMMENTS)
  const general = d.general.trim()
  if (sorted.length === 0 && !general) return null
  return {
    comments: sorted.map((c): AnyReviewComment =>
      isFileComment(c)
        ? { kind: 'file', path: c.path, line: c.line, line_end: c.lineEnd, text: c.text }
        : isCommitComment(c)
          ? { kind: 'commit', sha: c.sha, path: c.path, line: c.line, side: c.side, text: c.text }
          : { path: c.path, line: c.line, side: c.side, text: c.text },
    ),
    ids: sorted.map((c) => c.id),
    ...(general ? { general } : {}),
    dropped,
  }
}

/** Ce que dit le démon d'un commentaire refusé (`-32602`). */
export interface Rejection {
  /** Rang 0-based dans `comments` tel qu'envoyé. */
  index: number | null
  path: string | null
  line: number | null
  lineEnd: number | null
}

const posInt = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null)

/**
 * Commentaire refusé, d'après `data` (`{index, path, line, line_end}`, si le
 * démon le donne) sinon le message (« commentaire N : … », rang 1-based dans
 * l'ordre envoyé). `null` si rien ne le désigne.
 */
export function parseRejection(message: string, data: unknown): Rejection | null {
  const d = data && typeof data === 'object' ? (data as Record<string, unknown>) : {}
  const rank = /commentaire (\d+)/.exec(message)
  const fromMessage = rank ? Number(rank[1]) - 1 : null
  const r: Rejection = {
    index: fromMessage ?? posInt(d.index),
    path: typeof d.path === 'string' && d.path ? d.path : null,
    line: posInt(d.line),
    lineEnd: posInt(d.line_end),
  }
  return r.index === null && r.path === null ? null : r
}

/**
 * Identifiant (dans le brouillon) du commentaire refusé de la revue `built` :
 * par rang, vérifié contre le chemin et les lignes de `data` quand ils sont là
 * (`index` 0-based, sinon 1-based), puis par chemin et ligne.
 */
export function rejectedId(built: Pick<BuiltReview, 'comments' | 'ids'>, r: Rejection): number | null {
  const fits = (i: number) => {
    const c = built.comments[i]
    if (!c) return false
    if (r.path !== null && c.path !== r.path) return false
    if (r.line !== null && c.line !== r.line) return false
    return true
  }
  const tries = r.index === null ? [] : [r.index, r.index - 1]
  for (const i of tries) if (fits(i)) return built.ids[i] ?? null
  if (r.path !== null) {
    const i = built.comments.findIndex((c, k) => fits(k) && (r.lineEnd === null || !('kind' in c) || c.kind !== 'file' || c.line_end === r.lineEnd))
    if (i >= 0) return built.ids[i] ?? null
  }
  return null
}

/**
 * Consigne tapée devant une revue (lot 18), choisie comme le démon le fait :
 * celle des extraits de fichiers si la revue n'a que des commentaires de
 * fichier, sinon celle de la revue (au moins un commentaire de diff ou de
 * commit, ou seulement la remarque générale).
 */
export function reviewPromptOf(comments: readonly AnyReviewComment[]): { id: 'review' | 'fileExcerpts'; vars: PromptVars } {
  const files = comments.filter((c) => 'kind' in c && c.kind === 'file').length
  if (files > 0 && files === comments.length) return { id: 'fileExcerpts', vars: { excerpts: files } }
  return { id: 'review', vars: { comments: comments.length } }
}
