/**
 * Coloration syntaxique (highlight.js, cœur seul) : liste fermée de langages,
 * jamais de détection automatique. Le langage vient de l'info d'un bloc de
 * code Markdown (« ```rust ») ou de l'extension du fichier.
 *
 * La sortie de highlight.js est du texte échappé entouré de
 * `<span class="hljs-…">` : aucun HTML venu du fichier n'est interprété.
 * Au-delà de 200 Kio ou 5 000 lignes : pas de coloration (texte brut).
 */
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import go from 'highlight.js/lib/languages/go'
import ini from 'highlight.js/lib/languages/ini'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

const LANGUAGES = { bash, css, diff, go, ini, javascript, json, markdown, python, rust, sql, typescript, xml, yaml }
for (const [name, fn] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, fn)

/** Seuils au-delà desquels on affiche le texte brut. */
export const HIGHLIGHT_MAX_BYTES = 200 * 1024
export const HIGHLIGHT_MAX_LINES = 5000

/** Extension (minuscules) → langage enregistré (Map : `constructor`, `__proto__`… ne trouvent rien). */
const BY_EXTENSION: ReadonlyMap<string, string> = new Map([
  ['rs', 'rust'],
  ['ts', 'typescript'],
  ['tsx', 'typescript'],
  ['mts', 'typescript'],
  ['cts', 'typescript'],
  ['js', 'javascript'],
  ['jsx', 'javascript'],
  ['mjs', 'javascript'],
  ['cjs', 'javascript'],
  ['json', 'json'],
  ['jsonc', 'json'],
  ['toml', 'ini'],
  ['ini', 'ini'],
  ['yaml', 'yaml'],
  ['yml', 'yaml'],
  ['sh', 'bash'],
  ['bash', 'bash'],
  ['zsh', 'bash'],
  ['py', 'python'],
  ['go', 'go'],
  ['sql', 'sql'],
  ['css', 'css'],
  ['html', 'xml'],
  ['htm', 'xml'],
  ['xml', 'xml'],
  ['svg', 'xml'],
  ['xhtml', 'xml'],
  ['md', 'markdown'],
  ['markdown', 'markdown'],
  ['mdx', 'markdown'],
  ['diff', 'diff'],
  ['patch', 'diff'],
])

const REGISTERED: ReadonlySet<string> = new Set(Object.keys(LANGUAGES))

/** Langage d'un fichier d'après son extension ; `null` si inconnu. */
export function languageForPath(path: string): string | null {
  const name = path.split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  if (dot === -1) return null
  return BY_EXTENSION.get(name.slice(dot + 1).toLowerCase()) ?? null
}

/**
 * Langage d'un bloc de code Markdown (premier mot de l'info, nom ou alias d'un
 * langage enregistré : `rust`, `ts`, `toml`, `html`, `sh`…) ; `null` si inconnu.
 */
export function languageForFence(info: string): string | null {
  const word = info.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
  if (!word) return null
  const byExt = BY_EXTENSION.get(word)
  if (byExt) return byExt
  try {
    const lang = hljs.getLanguage(word)
    if (!lang) return null
    // Nom enregistré correspondant (alias résolu par highlight.js).
    return [...REGISTERED].find((n) => hljs.getLanguage(n) === lang) ?? null
  } catch {
    return null
  }
}

/** Nombre de lignes (une fin de ligne finale n'en ajoute pas ; texte vide : 0). */
export function lineCount(text: string): number {
  if (!text) return 0
  let n = 1
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) n++
  return text.endsWith('\n') ? n - 1 : n
}

const encoder = new TextEncoder()

/** Assez petit pour être coloré (200 Kio et 5 000 lignes au plus). */
export function withinHighlightLimits(text: string): boolean {
  // Plus de 200 Ki unités UTF-16 : au moins autant d'octets, inutile d'encoder.
  if (text.length > HIGHLIGHT_MAX_BYTES) return false
  return lineCount(text) <= HIGHLIGHT_MAX_LINES && encoder.encode(text).length <= HIGHLIGHT_MAX_BYTES
}

/**
 * HTML coloré (échappé par highlight.js) pour un langage enregistré, `null`
 * sinon (langage inconnu ou erreur : à afficher en texte brut).
 */
export function highlightCode(code: string, language: string | null): string | null {
  // Seulement un nom enregistré (jamais une clé héritée d'objet), et rien qui puisse lever hors du try.
  if (typeof language !== 'string' || !REGISTERED.has(language)) return null
  try {
    if (!hljs.getLanguage(language)) return null
    return hljs.highlight(code, { language, ignoreIllegals: true }).value
  } catch {
    return null
  }
}
