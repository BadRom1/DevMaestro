/**
 * Détecteur de chaînes en dur (lot 20) : heuristique sur l'arbre syntaxique
 * (analyseur d'oxc fourni par Vite), utilisée par `i18n-hardcoded.test.ts`.
 *
 * Signalé :
 * - **JSX** (`.tsx`) : texte contenant un mot (deux lettres ou plus) ; valeur
 *   littérale d'un attribut affiché (`aria-label`, `title`, `placeholder`,
 *   `alt`, `label`…) ; texte littéral dans une expression enfant
 *   (`{ok ? 'Oui' : 'Non'}`).
 * - **Texte français** dans le code (`.ts`/`.tsx`) : chaîne ou gabarit qui
 *   ressemble à une phrase française (lettre accentuée, guillemets « », ou
 *   mot outil courant), hors arguments d'appel de `t()`/`rich()`.
 *
 * Exemption : un commentaire `i18n-exempt: <raison>` sur la ligne ou la
 * ligne au-dessus, ou une entrée de `i18n-exceptions.ts` (raison obligatoire).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

import { parseSync } from 'vite'

export interface Finding {
  file: string
  line: number
  kind: 'jsx-text' | 'jsx-attr' | 'jsx-expr' | 'french'
  text: string
}

const SHOWN_ATTRS = new Set([
  'aria-label',
  'aria-description',
  'aria-roledescription',
  'aria-valuetext',
  'aria-placeholder',
  'title',
  'placeholder',
  'alt',
  'label',
])

const WORD = /\p{L}{2,}/u
const FRENCH_MARK = /[àâçéèêëîïôûùüÿœæÀÂÇÉÈÊËÎÏÔÛÙÜŸŒÆ«»’]/u
const FRENCH_WORDS =
  /\b(le|la|les|des|du|une|un|est|sont|pas|sur|dans|pour|avec|aucun|aucune|impossible|fichier|fichiers|session|sessions|ligne|lignes|demande|démon|dossier|branche|réglages|tu|ton|ta|tes|ou|et)\b/i

/** Longueur minimale de la raison d'une exemption (`i18n-exempt: …`). */
export const MIN_REASON = 10

/**
 * Erreurs de validation stricte (patch de réglages, paramètres venus de la
 * page) : détail technique en français, jamais produit par l'interface, et
 * gardé hors des messages traduits (journal en anglais). Contrat du lot 20.
 */
const DETAIL_ERRORS = new Set(['SettingsError', 'ValidationError'])

/** Fonctions dont le premier argument est une clé (ou un texte déjà traduit). */
const KEY_CALLEES = new Set(['t', 'rich', 'translate', 'richText'])

type Node = { type: string; start: number; end: number; [k: string]: unknown }

function isNode(v: unknown): v is Node {
  return typeof v === 'object' && v !== null && typeof (v as { type?: unknown }).type === 'string'
}

function children(n: Node): Array<[string, Node]> {
  const out: Array<[string, Node]> = []
  for (const [k, v] of Object.entries(n)) {
    if (k === 'type' || k === 'start' || k === 'end') continue
    if (Array.isArray(v)) for (const x of v) isNode(x) && out.push([k, x])
    else if (isNode(v)) out.push([k, v])
  }
  return out
}

function lineStarts(src: string): number[] {
  const out = [0]
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) out.push(i + 1)
  return out
}

function lineOf(starts: number[], offset: number): number {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid]! <= offset) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function looksFrench(s: string): boolean {
  const c = clean(s)
  if (!WORD.test(c)) return false
  if (FRENCH_MARK.test(c)) return true
  // Au moins deux mots, dont un mot outil français.
  return /\s/.test(c) && FRENCH_WORDS.test(c)
}

/** Texte d'une chaîne ou d'un gabarit (variables remplacées par « … »). */
function literalText(n: Node): string | null {
  if (n.type === 'Literal' && typeof n.value === 'string') return n.value
  if (n.type === 'TemplateLiteral') {
    const quasis = n.quasis as Array<{ value: { cooked: string | null; raw: string } }>
    return quasis.map((q) => q.value.cooked ?? q.value.raw).join('…')
  }
  return null
}

function calleeName(n: Node): string | null {
  const c = n.callee as Node | undefined
  if (!c) return null
  if (c.type === 'Identifier') return c.name as string
  if (c.type === 'MemberExpression' || c.type === 'StaticMemberExpression') {
    const p = c.property as Node | undefined
    return p && p.type === 'Identifier' ? (p.name as string) : null
  }
  return null
}

/** Le littéral est-il hors affichage (clé, comparaison, propriété, import, type…) ? */
function ignoredLiteral(parent: Node | null, key: string, grand: Node | null): boolean {
  if (!parent) return false
  switch (parent.type) {
    case 'CallExpression':
      return key === 'arguments' && KEY_CALLEES.has(calleeName(parent) ?? '')
    case 'NewExpression':
      return key === 'arguments' && DETAIL_ERRORS.has(calleeName(parent) ?? '')
    case 'BinaryExpression':
      return ['===', '!==', '==', '!=', 'in'].includes(parent.operator as string)
    case 'SwitchCase':
    case 'ImportDeclaration':
    case 'ExportNamedDeclaration':
    case 'ExportAllDeclaration':
    case 'ImportExpression':
    case 'TSLiteralType':
    case 'Directive':
      return true
    case 'Property':
    case 'ObjectProperty':
      return key === 'key'
    case 'MemberExpression':
    case 'ComputedMemberExpression':
      return key === 'property' || key === 'expression'
    case 'JSXAttribute':
      return false
    default:
      return grand?.type === 'TSLiteralType'
  }
}

function attrName(n: Node): string | null {
  const name = n.name as Node | undefined
  if (!name) return null
  if (name.type === 'JSXIdentifier') return name.name as string
  return null
}

/** Analyse un fichier source ; `rel` : chemin affiché. */
export function scanSource(rel: string, src: string): Finding[] {
  const lang = rel.endsWith('.tsx') ? 'tsx' : 'ts'
  const r = parseSync(rel, src, { lang }) as unknown as { program: Node; comments: Array<{ value: string; start: number }> }
  const starts = lineStarts(src)
  const exempt = new Set<number>()
  for (const c of r.comments) {
    const m = /i18n-exempt\s*:\s*(\S.*)?$/.exec(c.value.trim())
    if (m && m[1] && m[1].replace(/\s*\*\/?\s*$/, '').trim().length >= MIN_REASON) {
      const l = lineOf(starts, c.start)
      exempt.add(l)
      exempt.add(l + 1)
    }
  }
  const out: Finding[] = []
  const seen = new Set<string>()
  const push = (kind: Finding['kind'], n: Node, text: string) => {
    const line = lineOf(starts, n.start)
    if (exempt.has(line)) return
    const k = `${line}|${n.start}`
    if (seen.has(k)) return
    seen.add(k)
    out.push({ file: rel, line, kind, text: clean(text) })
  }

  /** Littéraux affichés d'une expression JSX (s'arrête aux éléments JSX, visités par ailleurs). */
  const exprLiterals = (n: Node, parent: Node | null, key: string, grand: Node | null, kind: Finding['kind']) => {
    if (n.type === 'JSXElement' || n.type === 'JSXFragment') return
    const text = literalText(n)
    if (text !== null) {
      if (WORD.test(text) && !ignoredLiteral(parent, key, grand)) push(kind, n, text)
      if (n.type === 'Literal') return
    }
    for (const [k, c] of children(n)) exprLiterals(c, n, k, parent, kind)
  }

  const walk = (n: Node, parent: Node | null, key: string, grand: Node | null) => {
    if (n.type === 'JSXText') {
      if (WORD.test(n.value as string)) push('jsx-text', n, n.value as string)
      return
    }
    if (n.type === 'JSXAttribute') {
      const name = attrName(n)
      const v = n.value as Node | null
      if (name && SHOWN_ATTRS.has(name) && v) {
        if (v.type === 'JSXExpressionContainer') exprLiterals(v.expression as Node, v, 'expression', n, 'jsx-attr')
        else {
          const text = literalText(v)
          if (text !== null && WORD.test(text)) push('jsx-attr', v, text)
        }
      }
    }
    if (n.type === 'JSXExpressionContainer' && (parent?.type === 'JSXElement' || parent?.type === 'JSXFragment')) {
      exprLiterals(n.expression as Node, n, 'expression', parent, 'jsx-expr')
    }
    const text = literalText(n)
    if (text !== null && looksFrench(text) && !ignoredLiteral(parent, key, grand)) push('french', n, text)
    for (const [k, c] of children(n)) walk(c, n, k, parent)
  }
  walk(r.program, null, '', null)
  return out.sort((a, b) => a.line - b.line)
}

/** Fichiers analysés : la page (composants, état, terminal) et les textes du processus principal. */
export function scannedFiles(appDir: string): string[] {
  const out: string[] = []
  const visit = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name)
      if (statSync(p).isDirectory()) visit(p)
      else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) out.push(path.relative(appDir, p))
    }
  }
  visit(path.join(appDir, 'src/renderer/src'))
  // Textes du processus principal et modules partagés qui produisent du texte affiché.
  for (const f of [
    'src/main/notifyLogic.ts',
    'src/main/index.ts',
    'src/main/runnerGuard.ts',
    'src/main/validate.ts',
    'src/main/daemon/relay.ts',
    'src/shared/prompts.ts',
    'src/shared/settings.ts',
    'src/shared/worktrees.ts',
    'src/shared/runnerFiles.ts',
  ])
    out.push(f)
  return out.sort()
}

export function scanFile(appDir: string, rel: string): Finding[] {
  return scanSource(rel, readFileSync(path.join(appDir, rel), 'utf8'))
}
