/**
 * Lecteur Markdown de l'onglet « Fichiers » (markdown-it) :
 * - aucun HTML brut (`html: false` : il est échappé) ;
 * - images jamais chargées : remplacées par leur texte alternatif ;
 * - titres numérotés pour le sommaire (« Sur cette page ») ;
 * - liens classés au clic (`classifyLink`) : fichier `.md` relatif → lecteur,
 *   http(s) → confirmation puis navigateur, ancre → titre, le reste inerte.
 */
import MarkdownIt from 'markdown-it'

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

const md = new MarkdownIt({ html: false, linkify: false, typographer: false })

const escapeHtml = (s: string) => md.utils.escapeHtml(s)

// Images : jamais chargées (la CSP les bloquerait de toute façon), texte alternatif à la place.
md.renderer.rules.image = (tokens, idx) => {
  const t = tokens[idx]!
  const alt = t.children?.map((c) => c.content).join('') || t.content || ''
  const src = String(t.attrGet('src') ?? '')
  return `<span class="img-alt" title="${escapeHtml(src)}">[image${alt ? ` : ${escapeHtml(alt)}` : ''}]</span>`
}

export interface RenderedMarkdown {
  html: string
  outline: OutlineItem[]
}

/** Rendu sûr et sommaire (titres de niveau 1 à 4, identifiants uniques). */
export function renderMarkdown(src: string): RenderedMarkdown {
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
    let id = `h-${n ? `${base}-${n}` : base}`
    while (taken.has(id)) id = `h-${base}-${++n}`
    used.set(base, n + 1)
    taken.add(id)
    t.attrSet('id', id)
    if (level <= 4 && text) outline.push({ level, text, id })
  }
  return { html: md.renderer.render(tokens, md.options, env), outline }
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
