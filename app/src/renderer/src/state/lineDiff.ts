/**
 * Diff par lignes calculé dans la page (lot 7, « Voir les différences ») :
 * algorithme de Myers sur les lignes, après retrait du début et de la fin
 * communs. Le résultat a la forme d'un `FileDiff` du démon (hunks avec
 * 3 lignes de contexte) pour passer par `diffRows` et le lecteur de diff.
 *
 * Au-delà de `MAX_EDIT_DISTANCE` lignes différentes, la partie centrale est
 * donnée en bloc (tout supprimé puis tout ajouté) : diff exact mais pas
 * minimal, signalé par `approximate`.
 */
import type { DiffHunk, DiffLine, FileDiff } from '../../../shared/protocol'

/** Distance d'édition (lignes ajoutées + supprimées) au-delà de laquelle on renonce au diff minimal. */
export const MAX_EDIT_DISTANCE = 2000
export const CONTEXT_LINES = 3

export interface LineDiffResult {
  diff: FileDiff
  /** Aucune différence de lignes. */
  identical: boolean
  /** Diff non minimal (trop de différences pour l'algorithme de Myers). */
  approximate: boolean
}

/** Lignes d'un texte : une fin de ligne finale n'ajoute pas de ligne vide ; le `\r` d'une fin CRLF est retiré. */
export function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
}

type Op = { kind: ' ' | '+' | '-'; a: number; b: number }

/** Script d'édition minimal entre `a[lo..aHi)` et `b[lo..bHi)` (identifiants de lignes), ou `null` si trop long. */
function myers(a: Int32Array, b: Int32Array, aLo: number, aHi: number, bLo: number, bHi: number, maxD: number): Op[] | null {
  const n = aHi - aLo
  const m = bHi - bLo
  const max = Math.min(n + m, maxD)
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  v[offset + 1] = 0
  /** État de `v` avant chaque étape `d` (fenêtre `k ∈ [-d-1, d+1]`). */
  const trace: Int32Array[] = []
  let found = -1
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2))
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1
      let y = x - k
      while (x < n && y < m && a[aLo + x] === b[bLo + y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) {
        found = d
        break
      }
    }
    if (found !== -1) break
  }
  if (found === -1) return null
  const ops: Op[] = []
  let x = n
  let y = m
  for (let d = found; d >= 0; d--) {
    const w = trace[d]!
    // Fenêtre de l'étape d : indice k → w[k + d + 1].
    const at = (k: number) => w[k + d + 1]!
    const k = x - y
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const prevX = at(prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      x--
      y--
      ops.push({ kind: ' ', a: aLo + x, b: bLo + y })
    }
    if (d > 0) {
      if (x === prevX) ops.push({ kind: '+', a: aLo + x, b: bLo + prevY })
      else ops.push({ kind: '-', a: aLo + prevX, b: bLo + y })
    }
    x = prevX
    y = prevY
  }
  return ops.reverse()
}

/** Diff des lignes de `before` vers `after`, en hunks de `context` lignes de contexte. */
export function lineDiff(before: string, after: string, opts: { context?: number; maxDistance?: number } = {}): LineDiffResult {
  const context = opts.context ?? CONTEXT_LINES
  const maxD = opts.maxDistance ?? MAX_EDIT_DISTANCE
  const left = splitLines(before)
  const right = splitLines(after)
  // Lignes → entiers (comparaisons rapides).
  const ids = new Map<string, number>()
  const idOf = (l: string) => {
    let i = ids.get(l)
    if (i === undefined) {
      i = ids.size
      ids.set(l, i)
    }
    return i
  }
  const a = Int32Array.from(left, idOf)
  const b = Int32Array.from(right, idOf)
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++

  const ops: Op[] = []
  for (let i = 0; i < pre; i++) ops.push({ kind: ' ', a: i, b: i })
  let approximate = false
  const mid = myers(a, b, pre, a.length - suf, pre, b.length - suf, maxD)
  if (mid) ops.push(...mid)
  else {
    approximate = true
    for (let i = pre; i < a.length - suf; i++) ops.push({ kind: '-', a: i, b: pre })
    for (let j = pre; j < b.length - suf; j++) ops.push({ kind: '+', a: a.length - suf, b: j })
  }
  for (let i = 0; i < suf; i++) ops.push({ kind: ' ', a: a.length - suf + i, b: b.length - suf + i })

  const hunks = toHunks(ops, left, right, context)
  return { diff: { hunks, binary: false, too_large: false }, identical: hunks.length === 0, approximate }
}

function toHunks(ops: readonly Op[], left: readonly string[], right: readonly string[], context: number): DiffHunk[] {
  const changes: number[] = []
  ops.forEach((o, i) => o.kind !== ' ' && changes.push(i))
  if (changes.length === 0) return []
  // Plages d'opérations [début, fin] : changements proches regroupés.
  const ranges: [number, number][] = []
  for (const i of changes) {
    const start = Math.max(0, i - context)
    const end = Math.min(ops.length - 1, i + context)
    const last = ranges[ranges.length - 1]
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end)
    else ranges.push([start, end])
  }
  return ranges.map(([s, e]) => {
    const lines: DiffLine[] = []
    let oldLines = 0
    let newLines = 0
    for (let i = s; i <= e; i++) {
      const o = ops[i]!
      if (o.kind === ' ') {
        lines.push({ kind: ' ', old_no: o.a + 1, new_no: o.b + 1, text: left[o.a]! })
        oldLines++
        newLines++
      } else if (o.kind === '-') {
        lines.push({ kind: '-', old_no: o.a + 1, new_no: null, text: left[o.a]! })
        oldLines++
      } else {
        lines.push({ kind: '+', old_no: null, new_no: o.b + 1, text: right[o.b]! })
        newLines++
      }
    }
    const first = ops[s]!
    // Convention de diff unifié : un côté vide commence à la ligne qui le précède.
    const oldStart = oldLines === 0 ? first.a : first.a + 1
    const newStart = newLines === 0 ? first.b : first.b + 1
    return {
      header: `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`,
      old_start: oldStart,
      old_lines: oldLines,
      new_start: newStart,
      new_lines: newLines,
      lines,
    }
  })
}

function eolLabel(text: string): string {
  const crlf = text.includes('\r\n')
  const lf = /(^|[^\r])\n/.test(text)
  return crlf && lf ? 'LF et CRLF mélangés' : crlf ? 'CRLF' : lf ? 'LF' : 'aucune'
}

/**
 * À appeler quand le diff par lignes est vide : ce qui diffère quand même
 * (fins de ligne, saut de ligne final), ou `null` si les textes sont identiques.
 */
export function invisibleDifference(before: string, after: string): string | null {
  if (before === after) return null
  const parts: string[] = []
  const eolBefore = eolLabel(before)
  const eolAfter = eolLabel(after)
  if (eolBefore !== eolAfter) parts.push(`les fins de ligne diffèrent (${eolBefore} → ${eolAfter})`)
  const finalBefore = /\r?\n$/.test(before)
  const finalAfter = /\r?\n$/.test(after)
  if (finalBefore !== finalAfter) parts.push(`le saut de ligne final diffère (${finalBefore ? 'présent' : 'absent'} → ${finalAfter ? 'présent' : 'absent'})`)
  if (parts.length === 0) parts.push('les fins de ligne diffèrent')
  const msg = parts.join(' ; ')
  return `Aucune différence de lignes, mais ${msg}.`
}
