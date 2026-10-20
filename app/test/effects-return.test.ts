/**
 * Un effet React ne doit renvoyer qu'une fonction de nettoyage (ou rien).
 * Une autre valeur (une promesse : `scrollIntoView` dans Chromium récent, une
 * fonction `async`…) fait planter React au démontage (« destroy is not a
 * function ») et, sans garde-fou, laissait la fenêtre blanche (bug du
 * 2026-10-20, import de thème).
 *
 * Vérifié sur l'arbre syntaxique (analyseur oxc fourni par Vite ; TypeScript 7
 * n'expose plus d'API JavaScript). Pour chaque `useEffect` /
 * `useLayoutEffect` / `useInsertionEffect` :
 * - le premier argument est une fonction fléchée écrite sur place, ni
 *   `async`, ni annotée d'un type de retour (pas de référence nommée ni de
 *   `function`, dont le retour ne se vérifie pas ici) ;
 * - corps d'expression : seulement un abonnement `api.onX(…)` (qui renvoie
 *   son désabonnement, sans rien d'enchaîné) ou une fonction écrite sur place ;
 * - corps en bloc : chaque `return` de l'effet (hors fonctions imbriquées) ne
 *   renvoie rien, une fonction écrite sur place, un abonnement `api.onX(…)`
 *   ou une variable locale initialisée par une fonction ou un abonnement.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { parseSync } from 'vite'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(__dirname, '../src/renderer/src')
const HOOKS = new Set(['useEffect', 'useLayoutEffect', 'useInsertionEffect'])

type Node = { type: string; start: number; [k: string]: unknown }

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? sources(p) : /\.tsx?$/.test(n) ? [p] : []
  })
}

const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null && typeof (v as Node).type === 'string'
const isFn = (n: Node | null | undefined) => !!n && (n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression')

function children(n: Node): Node[] {
  const out: Node[] = []
  for (const v of Object.values(n)) {
    if (Array.isArray(v)) for (const x of v) isNode(x) && out.push(x)
    else if (isNode(v)) out.push(v)
  }
  return out
}

function walk(n: Node, visit: (n: Node) => void): void {
  visit(n)
  for (const c of children(n)) walk(c, visit)
}

/** `api.onX(…)` ou `api.onX?.(…)`, sans rien d'enchaîné. */
function isSubscription(n: Node | null | undefined): boolean {
  if (!n) return false
  const call = n.type === 'ChainExpression' ? (n.expression as Node) : n
  if (call.type !== 'CallExpression') return false
  const callee = call.callee as Node
  return (
    callee.type === 'MemberExpression' &&
    (callee.object as Node).type === 'Identifier' &&
    (callee.object as { name: string }).name === 'api' &&
    /^on[A-Z]/.test(((callee.property as { name?: string }).name ?? '') as string)
  )
}

/** `return` de la fonction `fn` elle-même (pas ceux des fonctions imbriquées). */
function ownReturns(fn: Node): Node[] {
  const out: Node[] = []
  const visit = (n: Node) => {
    if (n.type === 'ReturnStatement') out.push(n)
    for (const c of children(n)) if (!isFn(c) && c.type !== 'FunctionDeclaration') visit(c)
  }
  visit(fn.body as Node)
  return out
}

/** Variables de l'effet initialisées par une fonction ou un abonnement (nettoyage nommé). */
function cleanupNames(fn: Node): Set<string> {
  const names = new Set<string>()
  walk(fn.body as Node, (n) => {
    if (n.type !== 'VariableDeclarator') return
    const id = n.id as Node
    const init = n.init as Node | null
    if (id.type === 'Identifier' && (isFn(init) || isSubscription(init))) names.add((id as unknown as { name: string }).name)
  })
  return names
}

/** Problèmes d'un effet, ou `null` s'il ne peut renvoyer qu'une fonction de nettoyage. */
export function effectProblem(effect: Node | undefined): string | null {
  if (!effect) return 'effet sans fonction'
  if (effect.type !== 'ArrowFunctionExpression') return 'l’effet doit être une fonction fléchée écrite sur place'
  if (effect.async) return 'effet async (renvoie une promesse)'
  if (effect.returnType) return 'effet annoté d’un type de retour'
  const body = effect.body as Node
  if (effect.expression) {
    return isSubscription(body) || isFn(body) ? null : 'corps d’expression : sa valeur devient le nettoyage'
  }
  const named = cleanupNames(effect)
  for (const r of ownReturns(effect)) {
    const a = r.argument as Node | null
    if (!a || isFn(a) || isSubscription(a)) continue
    if (a.type === 'Identifier' && named.has((a as unknown as { name: string }).name)) continue
    return '« return » d’autre chose qu’une fonction de nettoyage'
  }
  return null
}

function effectsIn(file: string, code: string): { line: number; problem: string }[] {
  const ast = parseSync(file, code)
  if (ast.errors.length > 0) throw new Error(`${file} : analyse impossible (${ast.errors[0]!.message})`)
  const out: { line: number; problem: string }[] = []
  walk(ast.program as unknown as Node, (n) => {
    if (n.type !== 'CallExpression') return
    const callee = n.callee as Node
    const name =
      callee.type === 'Identifier'
        ? (callee as unknown as { name: string }).name
        : callee.type === 'MemberExpression'
          ? ((callee.property as { name?: string }).name ?? '')
          : ''
    if (!HOOKS.has(name)) return
    const problem = effectProblem((n.arguments as Node[])[0])
    if (problem) out.push({ line: code.slice(0, n.start).split('\n').length, problem })
  })
  return out
}

describe('effets React : ne renvoient qu’une fonction de nettoyage', () => {
  it('dans tout le renderer', () => {
    const bad = sources(ROOT).flatMap((f) =>
      effectsIn(f, readFileSync(f, 'utf8')).map((p) => `${relative(ROOT, f)}:${p.line} ${p.problem}`),
    )
    expect(bad).toEqual([])
  })

  it.each([
    ['corps d’expression (bug d’origine)', `useEffect(() => box.current?.scrollIntoView?.({ block: 'nearest' }), [])`],
    ['async', `useEffect(async () => { await x() }, [])`],
    ['function', `useEffect(function () { return 1 }, [])`],
    ['référence nommée', `useEffect(load, [])`],
    ['type de retour', `useEffect((): Promise<void> => go(), [])`],
    ['return d’une expression', `useEffect(() => { if (a) return; return el.scrollIntoView() }, [])`],
    ['abonnement suivi de .then', `useEffect(() => api.onZoomChanged(cb).then(f), [])`],
    ['React.useEffect', `React.useEffect(() => fetchIt(), [])`],
  ])('refusé : %s', (_name, code) => {
    expect(effectsIn('x.tsx', code)).toHaveLength(1)
  })

  it.each([
    ['abonnement', `useEffect(() => api.onSelectSession?.((id) => show(id)), [])`],
    ['nettoyage écrit sur place', `useEffect(() => () => clearTimeout(t), [])`],
    ['bloc sans return', `useEffect(() => { void el.scrollIntoView() }, [])`],
    ['return de fonction', `useEffect(() => { if (!a) return; return () => off() }, [a])`],
    ['return d’un nettoyage nommé', `useEffect(() => { const off = api.onX(cb); return off }, [])`],
    ['return imbriqué ignoré', `useEffect(() => { list.forEach((x) => { return x + 1 }) }, [])`],
  ])('admis : %s', (_name, code) => {
    expect(effectsIn('x.tsx', code)).toEqual([])
  })
})
