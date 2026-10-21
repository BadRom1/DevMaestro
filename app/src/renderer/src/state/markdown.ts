/**
 * Lecteur Markdown de l'onglet « Fichiers » (markdown-it) :
 * - aucun HTML brut (`html: false` : il est échappé) ;
 * - images jamais chargées : remplacées par leur texte alternatif ;
 * - titres numérotés pour le sommaire (« Sur cette page ») ;
 * - liens classés au clic (`classifyLink`) : fichier `.md` relatif → lecteur,
 *   http(s) → confirmation puis navigateur, ancre → titre, le reste inerte ;
 * - blocs de code colorés (highlight.js, langage de l'info du bloc, sortie
 *   échappée ; langage inconnu ou document trop gros : texte échappé) ;
 * - chaque bloc porte ses lignes source (`data-source-start` / `data-source-end`,
 *   1-based, bornes comprises), tirées de `token.map`, pour commenter une sélection ;
 * - listes de tâches (`- [ ]`, `- [x]`, `* [X]`, `1. [ ]`) : cases à cocher
 *   désactivées, produites par une règle maison (balise fixe, jamais tirée du
 *   texte ; le reste de l'élément reste échappé).
 */
import MarkdownIt from 'markdown-it'
import type { MarkdownIt as MarkdownItInstance, StateCore } from 'markdown-it'

import { highlightCode, languageForFence, withinHighlightLimits } from './highlight'

export interface OutlineItem {
  level: number
  text: string
  id: string
}

/** Identifiant d'ancre lisible : minuscules, sans accents, tirets. */
export function slugify(text: string): string {
  const s = text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return s || 'section'
}

/**
 * Lignes source sur chaque bloc ouvrant ou autonome (paragraphe, titre, liste,
 * élément, citation, tableau, ligne, bloc de code, filet). `map` vaut
 * `[début, fin)` en lignes 0-based : `data-source-start = début + 1`,
 * `data-source-end = fin` (dernière ligne, 1-based).
 */
function sourceLines(state: StateCore): void {
  const lines = state.src.split('\n')
  for (const t of state.tokens) {
    if (!t.block || !t.map || t.nesting === -1 || t.type === 'inline') continue
    let [start, end] = t.map
    // Les listes comptent la ligne vide qui les suit : elle n'est pas du bloc.
    while (end - 1 > start && !lines[end - 1]?.trim()) end--
    t.attrSet('data-source-start', String(start + 1))
    t.attrSet('data-source-end', String(Math.max(start + 1, end)))
  }
}

/** Marqueur de tâche en tête d'un élément de liste : « [ ] », « [x] » ou « [X] », suivi d'un blanc ou de rien. */
const TASK_MARKER = /^\[([ xX])\](?=\s|$)\s*/

/**
 * Listes de tâches : un élément dont le premier paragraphe commence par un
 * marqueur reçoit la classe `task-item` (et sa liste `task-list`) ; le
 * marqueur est retiré du texte et remplacé par un jeton `task_checkbox`, rendu
 * en `<input type="checkbox" disabled>` (coché pour « x »). Le marqueur doit
 * ouvrir le texte brut de l'élément : `[ ]` au milieu d'une phrase, dans du
 * code ou suivi d'une lettre reste du texte.
 */
function taskLists(state: StateCore): void {
  const tokens = state.tokens
  for (let i = 0; i + 2 < tokens.length; i++) {
    const li = tokens[i]!
    if (li.type !== 'list_item_open') continue
    const para = tokens[i + 1]!
    const inline = tokens[i + 2]!
    if (para.type !== 'paragraph_open' || inline.type !== 'inline') continue
    const first = inline.children?.[0]
    if (!first || first.type !== 'text') continue
    const m = TASK_MARKER.exec(first.content)
    if (!m) continue
    first.content = first.content.slice(m[0].length)
    const box = new state.Token('task_checkbox', 'input', 0)
    box.meta = { checked: m[1] !== ' ' }
    inline.children!.unshift(box)
    li.attrJoin('class', 'task-item')
    // Liste qui contient l'élément : le dernier ouvrant de niveau inférieur.
    for (let j = i - 1; j >= 0; j--) {
      const t = tokens[j]!
      if ((t.type === 'bullet_list_open' || t.type === 'ordered_list_open') && t.level === li.level - 1) {
        if (!String(t.attrGet('class') ?? '').split(' ').includes('task-list')) t.attrJoin('class', 'task-list')
        break
      }
    }
  }
}

function makeMd(highlight: boolean): MarkdownItInstance {
  const md = new MarkdownIt({
    html: false,
    linkify: false,
    typographer: false,
    // Chaîne vide : markdown-it échappe lui-même le contenu (langage inconnu).
    highlight: highlight ? (code, info) => highlightCode(code, languageForFence(info)) ?? '' : null,
  })
  const escape = (s: string) => md.utils.escapeHtml(s)
  // Images : jamais chargées (la CSP les bloquerait de toute façon), texte alternatif à la place.
  md.renderer.rules.image = (tokens, idx) => {
    const t = tokens[idx]!
    const alt = t.children?.map((c) => c.content).join('') || t.content || ''
    const src = String(t.attrGet('src') ?? '')
    return `<span class="img-alt" title="${escape(src)}">[image${alt ? ` : ${escape(alt)}` : ''}]</span>`
  }
  // Balise fixe : rien du texte source n'y entre. Désactivée (lecture seule), état annoncé par le lecteur d'écran.
  md.renderer.rules.task_checkbox = (tokens, idx) =>
    `<input type="checkbox" class="task-cb" disabled${(tokens[idx]!.meta as { checked?: boolean } | null)?.checked ? ' checked' : ''}> `
  md.core.ruler.push('task_lists', taskLists)
  md.core.ruler.push('source_lines', sourceLines)
  return md
}

/** Avec coloration des blocs de code, et sans (document au-delà des seuils). */
const mdColored = makeMd(true)
const mdPlain = makeMd(false)

export interface RenderedMarkdown {
  html: string
  outline: OutlineItem[]
  /** Blocs de code colorés (document sous les seuils de taille). */
  highlighted: boolean
}

/**
 * Rendu sûr et sommaire (titres de niveau 1 à 4, identifiants uniques).
 * `idPrefix` : préfixe des identifiants des titres, pour plusieurs documents
 * dans une même page (vue conversation) ; caractères hors `[A-Za-z0-9_-]` remplacés.
 */
export function renderMarkdown(src: string, opts: { idPrefix?: string } = {}): RenderedMarkdown {
  const prefix = opts.idPrefix ? `${opts.idPrefix.replace(/[^A-Za-z0-9_-]/g, '-')}-` : ''
  const highlighted = withinHighlightLimits(src)
  const md = highlighted ? mdColored : mdPlain
  const env = {}
  const tokens = md.parse(src, env)
  const outline: OutlineItem[] = []
  const used = new Map<string, number>()
  const taken = new Set<string>()
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t.type !== 'heading_open') continue
    const level = Number(t.tag.slice(1))
    const inline = tokens[i + 1]
    const text = (inline?.children ?? [])
      .filter((c) => c.type === 'text' || c.type === 'code_inline')
      .map((c) => c.content)
      .join('')
      .trim()
    const base = slugify(text)
    // Identifiant libre : un titre « A-1 » ne doit pas prendre celui du second « A ».
    let n = used.get(base) ?? 0
    let id = `${prefix}h-${n ? `${base}-${n}` : base}`
    while (taken.has(id)) id = `${prefix}h-${base}-${++n}`
    used.set(base, n + 1)
    taken.add(id)
    t.attrSet('id', id)
    if (level <= 4 && text) outline.push({ level, text, id })
  }
  return { html: md.renderer.render(tokens, md.options, env), outline, highlighted }
}

export type LinkTarget =
  | { kind: 'external'; url: string }
  | { kind: 'file'; path: string; anchor: string | null }
  | { kind: 'anchor'; id: string }
  | { kind: 'inert' }

/** Chemin relatif résolu depuis le dossier du fichier ; `null` s'il sort de la racine. */
export function resolveRelative(fromPath: string, href: string): string | null {
  const dir = fromPath.split('/').slice(0, -1)
  for (const part of href.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (dir.length === 0) return null
      dir.pop()
    } else dir.push(part)
  }
  return dir.length ? dir.join('/') : null
}

function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s)
  } catch {
    return null
  }
}

/** Que faire d'un clic sur ce lien, dans le fichier `fromPath` ? */
export function classifyLink(href: string | null | undefined, fromPath: string): LinkTarget {
  const h = (href ?? '').trim()
  if (!h) return { kind: 'inert' }
  if (/^https?:\/\//i.test(h)) return { kind: 'external', url: h }
  if (h.startsWith('#')) {
    const frag = h.length > 1 ? safeDecode(h.slice(1)) : null
    return frag ? { kind: 'anchor', id: `h-${slugify(frag)}` } : { kind: 'inert' }
  }
  // Autre schéma (mailto:, file:, javascript:…) ou chemin absolu : inerte.
  if (/^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith('/') || h.startsWith('//')) return { kind: 'inert' }
  const [rawPath, frag] = h.split('#', 2) as [string, string | undefined]
  const path = safeDecode(rawPath.split('?')[0]!)
  if (path === null) return { kind: 'inert' }
  if (!/\.(md|markdown|mdx)$/i.test(path)) return { kind: 'inert' }
  const resolved = resolveRelative(fromPath, path)
  if (!resolved) return { kind: 'inert' }
  const anchor = frag ? safeDecode(frag) : null
  return { kind: 'file', path: resolved, anchor: anchor ? `h-${slugify(anchor)}` : null }
}
