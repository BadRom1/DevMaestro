/**
 * Lignes source couvertes par une sélection dans l'onglet Fichiers (calcul pur,
 * sans DOM) : vue code (positions dans le texte) et Markdown rendu (blocs
 * portant `data-source-start` / `data-source-end`).
 */

/** Lignes 1-based, bornes comprises. */
export interface LineSpan {
  line: number
  lineEnd: number
}

/**
 * Lignes couvertes par la sélection `[start, end)` (positions en unités UTF-16)
 * dans `text`. Une sélection qui s'arrête juste après un saut de ligne ne
 * prend pas la ligne suivante (triple-clic, glisser jusqu'au début d'une ligne).
 */
export function offsetsToLines(text: string, start: number, end: number): LineSpan {
  const a = Math.max(0, Math.min(start, end, text.length))
  let b = Math.max(0, Math.min(Math.max(start, end), text.length))
  if (b > a && text[b - 1] === '\n') b--
  const lineAt = (pos: number) => {
    let n = 1
    for (let i = text.indexOf('\n'); i !== -1 && i < pos; i = text.indexOf('\n', i + 1)) n++
    return n
  }
  const line = lineAt(a)
  return { line, lineEnd: Math.max(line, lineAt(b)) }
}

/**
 * Lignes source d'une sélection dans le Markdown rendu, d'après les blocs
 * qu'elle touche. Un bloc qui en contient un autre touché (liste autour d'un
 * élément, citation autour d'un paragraphe) est ignoré : seuls les blocs les
 * plus fins comptent, la sélection ne s'étend pas à toute la liste.
 */
export function blocksToLines(blocks: readonly LineSpan[]): LineSpan | null {
  const valid = blocks.filter((b) => Number.isInteger(b.line) && Number.isInteger(b.lineEnd) && b.line >= 1 && b.lineEnd >= b.line)
  const contains = (o: LineSpan, i: LineSpan) => o.line <= i.line && o.lineEnd >= i.lineEnd && (o.line !== i.line || o.lineEnd !== i.lineEnd)
  const leaves = valid.filter((b) => !valid.some((o) => o !== b && contains(b, o)))
  if (leaves.length === 0) return null
  return { line: Math.min(...leaves.map((b) => b.line)), lineEnd: Math.max(...leaves.map((b) => b.lineEnd)) }
}

/** Plage entre deux lignes cliquées (dans n'importe quel ordre), bornée au fichier. */
export function spanBetween(a: number, b: number, total: number): LineSpan {
  const clamp = (n: number) => Math.min(Math.max(1, Math.round(n)), Math.max(1, total))
  const x = clamp(a)
  const y = clamp(b)
  return { line: Math.min(x, y), lineEnd: Math.max(x, y) }
}
