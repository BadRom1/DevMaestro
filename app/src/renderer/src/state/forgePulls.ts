/**
 * Forge d'un projet, demandes de fusion (v0.3, lot 13b, ADR 0006) : calculs
 * purs, testables sans DOM. Liste et filtres, libellés (état, décision de
 * revue, CI : toujours un glyphe et un texte, jamais la couleur seule),
 * brouillon de revue **de la forge** (distinct du brouillon de revue pour
 * Claude de `review.ts` : autre type, autre magasin, jamais mélangés),
 * construction de la revue publiée et issue d'une publication.
 *
 * Écriture vers la forge (ADR 0006, point 5) : `publishForgeReview` n'envoie
 * que depuis l'état « confirm » (aperçu figé affiché à l'utilisateur), et
 * envoie exactement cet aperçu. Le seul appel de `forge.submitReview` est
 * dans `PullsPanel.tsx`, derrière le bouton « Publier » du dialogue
 * (vérifié par `test/forge-pulls.test.ts`).
 */
import {
  ErrorCode,
  type CheckRunState,
  type ChecksSummary,
  type DiffFile,
  type DiffStatus,
  type FileDiff,
  type ForgeReviewEvent,
  type ForgeReviewPayload,
  type ForgeStatus,
  type Pull,
  type PullDetail,
  type PullFile,
  type PullState,
  type PullStateFilter,
  type ReviewDecision,
  type ReviewSide,
} from '../../../shared/protocol'
import { diffRows, type DiffRow, type LineAnchor } from './diff'
import { oneLine } from './forge'
import { findAnchor, type ReviewEditing } from './review'

/* ---------- Liste et filtres ---------- */

export interface PullFilters {
  state: PullStateFilter
  search: string
  /** « Les miennes » (auteur : moi). */
  mine: boolean
}

export const DEFAULT_PULL_FILTERS: PullFilters = { state: 'open', search: '', mine: false }
export const PULLS_LIMIT = 50

export const PULL_FILTER_LABELS: Record<PullStateFilter, string> = {
  open: 'Ouvertes',
  merged: 'Fusionnées',
  closed: 'Fermées',
  all: 'Toutes',
}

/** Paramètres de `forge.pulls` (champs vides omis). */
export function pullsParams(
  root: string,
  f: PullFilters,
  refresh = false,
): { root: string; state: PullStateFilter; search?: string; author?: '@me'; limit: number; refresh?: boolean } {
  const search = [...f.search.trim()].slice(0, 256).join('')
  return {
    root,
    state: f.state,
    ...(search ? { search } : {}),
    ...(f.mine ? { author: '@me' as const } : {}),
    limit: PULLS_LIMIT,
    ...(refresh ? { refresh: true } : {}),
  }
}

/** Demandes du dépôt seulement (une recherche avec `repo:` peut ramener d'ailleurs) : `https://<hôte>/<dépôt>/pull/<n>`. */
export function onlyRepoPulls(pulls: readonly Pull[], status: Pick<ForgeStatus, 'host' | 'repo'>): { pulls: Pull[]; dropped: number } {
  if (!status.host || !status.repo) return { pulls: [...pulls], dropped: 0 }
  const prefix = `https://${status.host}/${status.repo}/pull/`.toLowerCase()
  const kept = pulls.filter(
    (p) => typeof p.url === 'string' && p.url.toLowerCase().startsWith(prefix) && /^\d+$/.test(p.url.slice(prefix.length).split(/[?#/]/)[0]!),
  )
  return { pulls: kept, dropped: pulls.length - kept.length }
}

/* ---------- Libellés : glyphe + texte, jamais la couleur seule ---------- */

export type Tone = 'ok' | 'bad' | 'pend' | 'muted' | 'open' | 'done'

export interface Badge {
  glyph: string
  text: string
  tone: Tone
  /** Infobulle et nom accessible (plus détaillé que `text`). */
  label: string
}

export function pullStateLabel(state: PullState | string, draft = false): Badge {
  if (state === 'merged') return { glyph: '⑂', text: 'fusionnée', tone: 'done', label: 'Demande fusionnée' }
  if (state === 'closed') return { glyph: '✕', text: 'fermée', tone: 'muted', label: 'Demande fermée sans fusion' }
  if (draft) return { glyph: '◌', text: 'brouillon', tone: 'muted', label: 'Demande ouverte, en brouillon' }
  return { glyph: '○', text: 'ouverte', tone: 'open', label: 'Demande ouverte' }
}

export function reviewDecisionLabel(d: ReviewDecision | string | null | undefined): Badge | null {
  switch (d) {
    case 'approved':
      return { glyph: '✓', text: 'approuvée', tone: 'ok', label: 'Revue : approuvée' }
    case 'changes_requested':
      return { glyph: '✗', text: 'modifications demandées', tone: 'bad', label: 'Revue : modifications demandées' }
    case 'review_required':
      return { glyph: '◷', text: 'revue attendue', tone: 'pend', label: 'Revue : en attente d’une revue' }
    default:
      return null
  }
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : 0)

/** État de la CI : « ✓ CI réussie », « ✗ CI en échec (2/7) », « ◷ CI en cours », « – pas de CI », « ? CI inconnue ». */
export function checksLabel(c: ChecksSummary | null | undefined): Badge {
  if (!c || typeof c !== 'object') return { glyph: '?', text: 'CI inconnue', tone: 'muted', label: 'État de la CI inconnu' }
  const total = count(c.total)
  const passed = count(c.passed)
  const failed = count(c.failed)
  const pending = count(c.pending)
  const of = total > 0 ? ` sur ${total}` : ''
  switch (c.state) {
    case 'success':
      return {
        glyph: '✓',
        text: 'CI réussie',
        tone: 'ok',
        label: `CI réussie : ${passed} vérification${passed > 1 ? 's' : ''} réussie${passed > 1 ? 's' : ''}${of}`,
      }
    case 'failure':
      return {
        glyph: '✗',
        text: failed > 0 ? `CI en échec (${failed}${total > 0 ? `/${total}` : ''})` : 'CI en échec',
        tone: 'bad',
        label: `CI en échec : ${failed} vérification${failed > 1 ? 's' : ''} en échec${of}`,
      }
    case 'pending':
      return {
        glyph: '◷',
        text: 'CI en cours',
        tone: 'pend',
        label: `CI en cours : ${pending} vérification${pending > 1 ? 's' : ''} en attente${of}`,
      }
    case 'none':
      return { glyph: '–', text: 'pas de CI', tone: 'muted', label: 'Aucune vérification de CI' }
    default:
      return { glyph: '?', text: 'CI inconnue', tone: 'muted', label: 'État de la CI inconnu' }
  }
}

export function checkRunLabel(state: CheckRunState | string): Badge {
  switch (state) {
    case 'success':
      return { glyph: '✓', text: 'réussie', tone: 'ok', label: 'Vérification réussie' }
    case 'failure':
      return { glyph: '✗', text: 'échec', tone: 'bad', label: 'Vérification en échec' }
    case 'pending':
      return { glyph: '◷', text: 'en cours', tone: 'pend', label: 'Vérification en cours ou en attente' }
    case 'skipped':
      return { glyph: '↷', text: 'ignorée', tone: 'muted', label: 'Vérification ignorée' }
    case 'cancelled':
      return { glyph: '⊘', text: 'annulée', tone: 'muted', label: 'Vérification annulée' }
    default:
      return { glyph: '?', text: 'inconnue', tone: 'muted', label: 'État de la vérification inconnu' }
  }
}

/** Durée d'une vérification (« 42 s », « 3 min 05 s », « 1 h 02 min ») ; `null` si inconnue. */
export function checkDuration(started: string | null | undefined, completed: string | null | undefined, now = Date.now()): string | null {
  if (!started) return null
  const a = Date.parse(started)
  const b = completed ? Date.parse(completed) : now
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null
  const s = Math.round((b - a) / 1000)
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')} s`
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`
}

/** « +12 −3 · 4 fichiers ». */
export function pullCounters(p: Pick<Pull, 'additions' | 'deletions' | 'changed_files'>): string {
  const parts: string[] = []
  if (typeof p.additions === 'number' || typeof p.deletions === 'number') parts.push(`+${count(p.additions)} −${count(p.deletions)}`)
  if (typeof p.changed_files === 'number') parts.push(`${count(p.changed_files)} fichier${count(p.changed_files) > 1 ? 's' : ''}`)
  return parts.join(' · ')
}

/* ---------- Fichiers ---------- */

const STATUS_WORDS: Record<string, DiffStatus> = {
  a: 'A',
  added: 'A',
  m: 'M',
  modified: 'M',
  changed: 'M',
  d: 'D',
  removed: 'D',
  deleted: 'D',
  r: 'R',
  renamed: 'R',
  c: 'A',
  copied: 'A',
}

/** Fichiers de la demande au format du lecteur de diff (statut en lettre de git, quelle que soit la forme donnée). */
export function pullDiffFiles(files: readonly PullFile[] | null | undefined): DiffFile[] {
  return (files ?? [])
    .filter((f) => typeof f?.path === 'string' && f.path !== '')
    .map((f) => ({
      path: f.path,
      ...(f.old_path ? { old_path: f.old_path } : {}),
      status: STATUS_WORDS[String(f.status ?? '').toLowerCase()] ?? 'M',
      additions: typeof f.additions === 'number' ? f.additions : null,
      deletions: typeof f.deletions === 'number' ? f.deletions : null,
      binary: false,
    }))
}

/* ---------- Démon ancien, capacités ---------- */

/** Erreur d'un appel sur les demandes de fusion : démon d'avant le lot 13b, forge indisponible, ou autre. */
export function pullsErrorKind(code: number | null): 'old-daemon' | 'unavailable' | 'other' {
  if (code === ErrorCode.MethodNotFound) return 'old-daemon'
  if (code === ErrorCode.ForgeUnavailable) return 'unavailable'
  return 'other'
}

export const OLD_DAEMON_PULLS = 'Le démon ne connaît pas encore les demandes de fusion : mets orchd à jour.'

/** Le démon sait-il publier une revue ligne à ligne ? Absent (démon du lot 13a) : non. */
export function supportsForgeReview(status: Pick<ForgeStatus, 'capabilities'> | null | undefined): boolean {
  return status?.capabilities?.review_comments === true
}

/* ---------- Demande de fusion d'une session ---------- */

export interface BranchPull {
  number: number
  title: string
  url: string
  draft: boolean
  checks: ChecksSummary | null
}

/** Réponse de `forge.pullForBranch` lue avec tolérance : `null` si aucune demande ouverte (ou forme inattendue). */
export function branchPullOf(v: unknown): BranchPull | null {
  if (typeof v !== 'object' || v === null) return null
  const p = v as Record<string, unknown>
  if (typeof p.number !== 'number' || !Number.isInteger(p.number) || p.number < 1) return null
  if (p.state !== undefined && p.state !== 'open') return null
  return {
    number: p.number,
    title: typeof p.title === 'string' ? oneLine(p.title) : '',
    url: typeof p.url === 'string' ? p.url : '',
    draft: p.draft === true,
    checks: typeof p.checks === 'object' && p.checks !== null ? (p.checks as ChecksSummary) : null,
  }
}

/** Intervalle de rafraîchissement de la demande d'une session affichée. */
export const BRANCH_PULL_REFRESH_MS = 60_000

/* ---------- Brouillon de revue de la forge ---------- */

/** Limites du démon (`forge.submitReview`). */
export const MAX_FORGE_COMMENTS = 100
export const MAX_FORGE_TEXT = 65_536

/** Destination affichée partout où le brouillon de la forge apparaît. */
export const FORGE_DESTINATION = 'Publiée sur GitHub, visible par tous'

export interface ForgeDraftComment {
  id: number
  path: string
  side: ReviewSide
  line: number
  text: string
  /** Texte de la ligne commentée, pour la retrouver si le diff change (nouvelle tête). */
  lineText: string
  /** La ligne (ou le fichier) n'est plus dans le diff : signalé, jamais publié. */
  stale?: boolean
  /** Ligne où le commentaire a été écrit, quand il a été replacé ailleurs (« ligne 40 → 42 »). */
  movedFrom?: number
}

/** Brouillon de revue d'une demande de fusion : en mémoire seulement, par projet et numéro. */
export interface ForgeDraft {
  /** Tête de la demande lue quand le brouillon a été commencé (ou rechargée après un conflit). */
  headSha: string | null
  comments: ForgeDraftComment[]
  general: string
  event: ForgeReviewEvent
  editing: ReviewEditing | null
  nextId: number
}

export const emptyForgeDraft: ForgeDraft = { headSha: null, comments: [], general: '', event: 'comment', editing: null, nextId: 1 }

export type ForgeDraftAction =
  | { type: 'edit'; path: string; anchor: LineAnchor; lineText: string }
  | { type: 'editText'; text: string }
  | { type: 'cancel' }
  | { type: 'save' }
  | { type: 'delete'; id: number }
  | { type: 'general'; text: string }
  | { type: 'event'; event: ForgeReviewEvent }
  /** Tête lue : retenue si le brouillon n'a pas de commentaire de ligne, ou imposée (`force`) après « Recharger ». */
  | { type: 'head'; sha: string; force?: boolean }
  /** Diff d'un fichier (re)chargé : commentaires replacés sur la ligne au même texte, sinon signalés. */
  | { type: 'reanchor'; path: string; rows: DiffRow[] }
  /**
   * Demande relue après un conflit de tête, tous les fichiers commentés relus
   * avec succès : nouvelle tête ; chaque commentaire est d'abord signalé, et ne
   * l'est plus que si sa ligne est retrouvée dans `rows` de son fichier.
   */
  | { type: 'reloaded'; sha: string; paths: readonly string[]; rows: Readonly<Record<string, DiffRow[]>> }
  /** Liste des fichiers de la demande : les commentaires sur un fichier absent sont signalés. */
  | { type: 'files'; paths: readonly string[] }
  /** Revue publiée : ces commentaires et le commentaire général sont retirés. */
  | { type: 'published'; ids: number[] }
  | { type: 'clear' }

function clip(s: string, max: number): string {
  const chars = [...s]
  return chars.length > max ? chars.slice(0, max).join('') : s
}

/** Commentaires publiables (hors « ligne disparue »). */
export function activeForgeComments(d: ForgeDraft): ForgeDraftComment[] {
  return d.comments.filter((c) => !c.stale)
}

export function forgeEditingAt(d: ForgeDraft, path: string | null, a: LineAnchor): boolean {
  const e = d.editing
  return !!e && e.path === path && e.side === a.side && e.line === a.line
}

export function forgeCommentsAt(d: ForgeDraft, path: string, a: LineAnchor): ForgeDraftComment[] {
  return d.comments.filter((c) => !c.stale && c.path === path && c.side === a.side && c.line === a.line)
}

export function hasForgeDraft(d: ForgeDraft | undefined): boolean {
  return !!d && (d.comments.length > 0 || d.general.trim() !== '' || !!d.editing?.text.trim())
}

/** Ligne sans contenu propre (vide, accolade, ponctuation seule) : trop banale pour être retrouvée ailleurs. */
export function isBanalLine(text: string): boolean {
  return /^[\s\p{P}\p{S}]*$/u.test(text)
}

/**
 * Ligne du commentaire dans un diff relu : la ligne au même texte la plus
 * proche ; pour une ligne banale, seulement la même ligne avec le même texte.
 */
export function findForgeAnchor(rows: readonly DiffRow[], side: ReviewSide, line: number, lineText: string): number | null {
  if (!isBanalLine(lineText)) return findAnchor(rows, side, line, lineText)
  const same = rows.some((r) => r.type === 'line' && r.anchor?.side === side && r.anchor.line === line && r.text === lineText)
  return same ? line : null
}

/** Commentaire replacé (`n`) ou signalé (`null`), avec sa ligne d'origine s'il a bougé. */
function placed(c: ForgeDraftComment, n: number | null): ForgeDraftComment {
  if (n === null) return { ...c, stale: true }
  const origin = c.movedFrom ?? c.line
  const { movedFrom: _, ...rest } = c
  return n === origin ? { ...rest, line: n, stale: false } : { ...rest, line: n, stale: false, movedFrom: origin }
}

/** « ligne 40 → 42 » pour un commentaire replacé, sinon `null`. */
export function movedLabel(c: Pick<ForgeDraftComment, 'line' | 'movedFrom'>): string | null {
  return typeof c.movedFrom === 'number' && c.movedFrom !== c.line ? `ligne ${c.movedFrom} → ${c.line}` : null
}

export function forgeDraftReducer(d: ForgeDraft, a: ForgeDraftAction): ForgeDraft {
  switch (a.type) {
    case 'edit':
      if (activeForgeComments(d).length >= MAX_FORGE_COMMENTS || forgeEditingAt(d, a.path, a.anchor)) return d
      return { ...d, editing: { path: a.path, side: a.anchor.side, line: a.anchor.line, lineText: a.lineText, text: '' } }
    case 'editText':
      return d.editing ? { ...d, editing: { ...d.editing, text: clip(a.text, MAX_FORGE_TEXT) } } : d
    case 'cancel':
      return d.editing ? { ...d, editing: null } : d
    case 'save': {
      const e = d.editing
      if (!e) return d
      // Texte gardé tel quel (indentation comprise) : `publishedText` ne retire que les lignes vides de bord.
      if (!e.text.trim() || activeForgeComments(d).length >= MAX_FORGE_COMMENTS) return { ...d, editing: null }
      const c: ForgeDraftComment = { id: d.nextId, path: e.path, side: e.side, line: e.line, text: e.text, lineText: e.lineText }
      return { ...d, editing: null, comments: [...d.comments, c], nextId: d.nextId + 1 }
    }
    case 'delete':
      return { ...d, comments: d.comments.filter((c) => c.id !== a.id) }
    case 'general':
      return { ...d, general: clip(a.text, MAX_FORGE_TEXT) }
    case 'event':
      return d.event === a.event ? d : { ...d, event: a.event }
    case 'head':
      // Une tête plus récente n'est adoptée d'elle-même que sans commentaire de ligne (rien à revérifier).
      if (d.headSha === a.sha || (d.headSha !== null && !a.force && d.comments.length > 0)) return d
      return { ...d, headSha: a.sha }
    case 'reanchor': {
      let changed = false
      const comments = d.comments.map((c) => {
        if (c.path !== a.path) return c
        const next = placed(c, findForgeAnchor(a.rows, c.side, c.line, c.lineText))
        if (next.line === c.line && !!next.stale === !!c.stale && next.movedFrom === c.movedFrom) return c
        changed = true
        return next
      })
      let editing = d.editing
      if (editing && editing.path === a.path) {
        const n = findForgeAnchor(a.rows, editing.side, editing.line, editing.lineText)
        const next = n === null ? null : n === editing.line ? editing : { ...editing, line: n }
        if (next !== editing) {
          changed = true
          editing = next
        }
      }
      return changed ? { ...d, comments, editing } : d
    }
    case 'reloaded': {
      const present = new Set(a.paths)
      const comments = d.comments.map((c) => {
        const rows = present.has(c.path) ? a.rows[c.path] : undefined
        return placed({ ...c, stale: true }, rows ? findForgeAnchor(rows, c.side, c.line, c.lineText) : null)
      })
      return { ...d, headSha: a.sha, comments, editing: null }
    }
    case 'files': {
      const present = new Set(a.paths)
      let changed = false
      const comments = d.comments.map((c) => {
        if (present.has(c.path) || c.stale) return c
        changed = true
        return { ...c, stale: true }
      })
      const editing = d.editing && !present.has(d.editing.path) ? null : d.editing
      return changed || editing !== d.editing ? { ...d, comments, editing } : d
    }
    case 'published': {
      const ids = new Set(a.ids)
      return { ...d, comments: d.comments.filter((c) => !ids.has(c.id)), general: '', editing: null, event: 'comment' }
    }
    case 'clear':
      return { ...emptyForgeDraft, headSha: d.headSha, nextId: d.nextId }
  }
}

/**
 * Magasin des brouillons de la forge, par projet et numéro : gardés quand on
 * ferme le panneau, perdus à la fermeture de l'app. Distinct des brouillons
 * de revue pour Claude (par session, dans `App`).
 */
export function createForgeDraftStore() {
  const drafts = new Map<string, ForgeDraft>()
  const listeners = new Set<() => void>()
  return {
    get: (key: string): ForgeDraft => drafts.get(key) ?? emptyForgeDraft,
    dispatch(key: string, a: ForgeDraftAction): void {
      const prev = drafts.get(key) ?? emptyForgeDraft
      const next = forgeDraftReducer(prev, a)
      if (next === prev) return
      drafts.set(key, next)
      for (const l of listeners) l()
    },
    subscribe(l: () => void): () => void {
      listeners.add(l)
      return () => void listeners.delete(l)
    },
  }
}

export const forgeDrafts = createForgeDraftStore()

export const forgeDraftKey = (root: string, number: number): string => JSON.stringify([root, number])

/* ---------- Revue publiée ---------- */

export const EVENT_LABELS: Record<ForgeReviewEvent, string> = {
  comment: 'Commenter',
  approve: 'Approuver',
  request_changes: 'Demander des modifications',
}

/** Contrôles C0/C1 sauf `\n` et `\t`, et contrôles bidirectionnels (texte qui se lit autrement qu'il ne s'écrit). */
/** Caractères invisibles (même liste que le démon) : seulement pour reconnaître une ligne blanche, jamais retirés. */
const INVISIBLE_CHARS =
  /[\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u206f\ufe00-\ufe0f\ufeff\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu

const USER_TEXT_STRIP = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

/**
 * Texte écrit par l'utilisateur, tel que publié (même règle que le démon,
 * fixture partagée `crates/core/tests/fixtures/forge/user-text-cleaning.json`) :
 * fins de ligne `\r\n` ramenées à `\n`, contrôles (sauf `\n`, `\t`) et
 * contrôles bidirectionnels retirés ; tout le reste gardé (ZWJ, sélecteurs
 * de variation, trait d'union conditionnel…) ; seules les lignes blanches
 * (blancs et invisibles) de début et de fin sont retirées : l'indentation de
 * la première ligne et les blancs de fin de la dernière sont gardés.
 */
export function publishedText(s: string): string {
  const lines = s.replace(/\r\n?/g, '\n').replace(USER_TEXT_STRIP, '').split('\n')
  // Ligne blanche : rien que des blancs ou des caractères invisibles (comme `clean_user_text` du démon).
  const blank = (l: string) => /^\s*$/u.test(l.replace(INVISIBLE_CHARS, ''))
  const first = lines.findIndex((l) => !blank(l))
  if (first < 0) return ''
  let last = lines.length - 1
  while (blank(lines[last]!)) last--
  return clip(lines.slice(first, last + 1).join('\n'), MAX_FORGE_TEXT)
}

export interface BuiltForgeReview {
  /** Exactement ce qui sera publié (hors `root`), affiché tel quel dans l'aperçu. */
  payload: ForgeReviewPayload
  /** Identifiants des commentaires publiés, dans l'ordre de `payload.comments`. */
  ids: number[]
  /** Commentaires signalés (ligne ou fichier disparu), non publiés. */
  dropped: ForgeDraftComment[]
  /** Pourquoi la revue ne peut pas partir, ou `null`. */
  problem: string | null
}

/**
 * Revue à publier : commentaires ancrés dont le fichier est dans la demande,
 * dans l'ordre des fichiers puis des lignes ; corps et commentaires nettoyés
 * (l'aperçu montre le texte exact). `problem` : tête inconnue, ou commentaire
 * général absent pour « Commenter » / « Demander des modifications ».
 */
export function buildForgeReview(d: ForgeDraft, number: number, files: readonly Pick<DiffFile, 'path'>[]): BuiltForgeReview {
  const order = new Map(files.map((f, i) => [f.path, i]))
  const ok = (c: ForgeDraftComment) => !c.stale && order.has(c.path) && publishedText(c.text) !== ''
  const dropped = d.comments.filter((c) => c.stale || !order.has(c.path))
  const sorted = d.comments
    .filter(ok)
    .sort((a, b) => order.get(a.path)! - order.get(b.path)! || a.line - b.line || (a.side === b.side ? 0 : a.side === 'old' ? -1 : 1) || a.id - b.id)
    .slice(0, MAX_FORGE_COMMENTS)
  const body = publishedText(d.general)
  const payload: ForgeReviewPayload = {
    number,
    expected_head_sha: d.headSha ?? '',
    event: d.event,
    body,
    comments: sorted.map((c) => ({ path: c.path, line: c.line, side: c.side, body: publishedText(c.text) })),
  }
  let problem: string | null = null
  if (!d.headSha) problem = 'tête de la demande inconnue : recharge la demande de fusion'
  else if (d.event !== 'approve' && body === '')
    problem = `commentaire général obligatoire : « ${EVENT_LABELS[d.event]} » demande un commentaire général (GitHub l’exige), même avec des commentaires de ligne`
  return { payload, ids: sorted.map((c) => c.id), dropped, problem }
}

/* ---------- Publication ---------- */

export type PublishState =
  /** Dialogue ouvert : choix de l'événement, commentaire général. */
  | { phase: 'compose' }
  /** Aperçu figé affiché ; seul « Publier » envoie, et envoie exactement `payload`. */
  | { phase: 'confirm'; payload: ForgeReviewPayload; ids: number[] }
  | { phase: 'publishing'; payload: ForgeReviewPayload; ids: number[] }
  | { phase: 'done'; url: string | null }
  /** La tête a changé : brouillon gardé, « Recharger la demande de fusion ». */
  | { phase: 'conflict'; headSha: string | null }
  /** Refus du démon (`-32602`) ; `commentId` : commentaire désigné, s'il l'est. */
  | { phase: 'rejected'; message: string; commentId: number | null }
  /** Autre échec ; `uncertain` : délai dépassé ou connexion perdue, la revue a pu partir. */
  | { phase: 'error'; message: string; uncertain: boolean }

/** Aperçu figé (étape de confirmation), ou `null` si la revue ne peut pas partir. */
export function confirmStep(built: BuiltForgeReview): PublishState | null {
  if (built.problem) return null
  return { phase: 'confirm', payload: structuredClone(built.payload), ids: [...built.ids] }
}

export interface PublishError {
  code: number | null
  message: string
  data?: unknown
}

/** Issue d'un échec de `forge.submitReview`. */
export function publishFailure(e: PublishError, ids: readonly number[], describe: (e: PublishError) => string): PublishState {
  if (e.code === ErrorCode.PullChanged) {
    const h = typeof e.data === 'object' && e.data !== null ? (e.data as { head_sha?: unknown }).head_sha : undefined
    return { phase: 'conflict', headSha: typeof h === 'string' ? h : null }
  }
  if (e.code === ErrorCode.InvalidParams) {
    const d = typeof e.data === 'object' && e.data !== null ? (e.data as Record<string, unknown>) : {}
    const rank = /commentaire (\d+)/.exec(e.message)
    const index = rank ? Number(rank[1]) - 1 : typeof d.index === 'number' && Number.isInteger(d.index) ? d.index : null
    return { phase: 'rejected', message: describe(e), commentId: index !== null ? (ids[index] ?? null) : null }
  }
  const uncertain = e.code === ErrorCode.Timeout || e.code === ErrorCode.Disconnected
  return { phase: 'error', message: describe(e), uncertain }
}

/**
 * Publie la revue de l'aperçu figé. Ne fait rien hors de l'étape
 * « confirm » ; `send` reçoit exactement `{root, ...payload}` de l'aperçu.
 */
export async function publishForgeReview(
  state: PublishState,
  root: string,
  deps: {
    send: (params: { root: string } & ForgeReviewPayload) => Promise<{ url?: string | null } | null | undefined>
    toError: (e: unknown) => PublishError
    describe: (e: PublishError) => string
    onState: (s: PublishState) => void
  },
): Promise<PublishState> {
  if (state.phase !== 'confirm') return state
  deps.onState({ phase: 'publishing', payload: state.payload, ids: state.ids })
  let next: PublishState
  try {
    const r = await deps.send({ root, ...state.payload })
    next = { phase: 'done', url: typeof r?.url === 'string' ? r.url : null }
  } catch (e) {
    next = publishFailure(deps.toError(e), state.ids, deps.describe)
  }
  deps.onState(next)
  return next
}

/** Chemins commentés du brouillon (à relire après un rechargement de la demande). */
export function commentedPaths(d: ForgeDraft): string[] {
  return [...new Set(d.comments.map((c) => c.path))]
}

/** Sha d'une tête lue (40 ou 64 caractères hexadécimaux) ; sinon `null`. */
export function validHeadSha(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.toLowerCase()
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(s) ? s : null
}

/**
 * « Recharger la demande de fusion » après un conflit de tête : relit la
 * demande (sans cache), puis le diff de chaque fichier commenté encore dans la
 * demande (sans cache pour le premier seulement : le diff est gardé par tête
 * côté démon). Rend l'action à appliquer au brouillon, **seulement** si tout a
 * été relu ; une panne rejette, et le brouillon garde son ancienne tête.
 */
export async function reloadForReview(
  draft: ForgeDraft,
  deps: { fetchPull: () => Promise<PullDetail>; fetchFile: (path: string, refresh: boolean) => Promise<FileDiff> },
): Promise<{ pull: PullDetail; action: ForgeDraftAction }> {
  const pull = await deps.fetchPull()
  const sha = validHeadSha(pull.head?.sha)
  if (!sha) throw new Error('tête de la demande illisible')
  const paths = pullDiffFiles(pull.files).map((f) => f.path)
  const rows: Record<string, DiffRow[]> = {}
  let first = true
  for (const p of commentedPaths(draft)) {
    if (!paths.includes(p)) continue
    rows[p] = diffRows(await deps.fetchFile(p, first))
    first = false
  }
  return { pull, action: { type: 'reloaded', sha, paths, rows } }
}

/** Message d'un échec de `forge.pullFile` : diff trop gros pour GitHub dit explicitement. */
export function pullFileErrorText(message: string): string {
  if (/too[ _-]?large|exceed|maximum number|HTTP 406|trop gros|trop volumineux/i.test(message)) {
    return 'diff trop gros pour être affiché par GitHub : vois ce fichier sur la forge'
  }
  return `Diff du fichier indisponible : ${message}`
}
