/**
 * Lecture d'une sélection du DOM dans l'onglet Fichiers, ramenée aux lignes
 * source (le calcul des lignes lui-même est pur : `sourceSelection`).
 */
import { blocksToLines, offsetsToLines, type LineSpan } from './sourceSelection'

/**
 * Position de `node:offset` dans le texte de `root` (unités UTF-16). Le texte
 * d'un code coloré est celui du fichier : les balises `<span>` n'en ajoutent pas.
 */
export function textOffset(root: Node, node: Node, offset: number): number {
  const r = root.ownerDocument!.createRange()
  r.setStart(root, 0)
  r.setEnd(node, offset)
  return r.toString().length
}

/** Lignes du texte `text` (contenu de `code`) couvertes par `range` ; `null` hors du code ou texte vide. */
export function codeSelection(code: Node, text: string, range: Range): LineSpan | null {
  if (!text || range.collapsed || !code.contains(range.startContainer) || !code.contains(range.endContainer)) return null
  return offsetsToLines(text, textOffset(code, range.startContainer, range.startOffset), textOffset(code, range.endContainer, range.endOffset))
}

/** `Range.START_TO_START` et `Range.END_TO_END` (sans dépendre du `Range` global). */
const START_TO_START = 0
const END_TO_END = 2

/** Texte sélectionné dans `el` (sélection `range` ramenée à l'élément). */
export function selectedTextIn(range: Range, el: Element): string {
  const r = el.ownerDocument.createRange()
  r.selectNodeContents(el)
  if (range.compareBoundaryPoints(START_TO_START, r) > 0) r.setStart(range.startContainer, range.startOffset)
  if (range.compareBoundaryPoints(END_TO_END, r) < 0) r.setEnd(range.endContainer, range.endOffset)
  return r.toString()
}

/** Lignes source des blocs Markdown (`data-source-*`) où la sélection a du texte. */
export function markdownSelection(article: Element, range: Range): LineSpan | null {
  if (range.collapsed || !article.contains(range.commonAncestorContainer)) return null
  const blocks: LineSpan[] = []
  for (const el of article.querySelectorAll<HTMLElement>('[data-source-start]')) {
    if (!range.intersectsNode(el) || !selectedTextIn(range, el).trim()) continue
    blocks.push({ line: Number(el.dataset.sourceStart), lineEnd: Number(el.dataset.sourceEnd) })
  }
  return blocksToLines(blocks)
}
