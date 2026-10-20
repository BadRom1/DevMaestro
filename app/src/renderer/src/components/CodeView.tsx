/**
 * Vue code de l'onglet Fichiers : numéros de ligne, coloration (highlight.js,
 * sortie échappée) sous les seuils de taille, sélection de lignes à commenter.
 *
 * Un seul `<pre>` pour le code (et un pour les numéros) quelle que soit la
 * taille du fichier. La ligne d'un clic se déduit de sa position et de la
 * hauteur de ligne **mesurée** sur la colonne des numéros ; celle d'une
 * sélection de texte (souris ou Maj+flèches) de sa position dans le texte.
 */
import { useEffect, useMemo, useRef, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react'

import { codeSelection } from '../state/domSelection'
import { highlightCode, lineCount } from '../state/highlight'
import type { FileDraftComment } from '../state/review'
import { spanBetween, type LineSpan } from '../state/sourceSelection'
import { linesLabel } from './ReviewBar'

/** Hauteur de ligne et marge haute posées en style (les bandes en dépendent en CSS ; la mesure, non). */
const LINE_CSS = '20px'
const PAD_CSS = '12px'

/** Position (coordonnées de la fenêtre) où placer le bouton « Commenter ». */
export interface SelectionPoint {
  x: number
  y: number
}

/** Géométrie réelle des lignes, mesurée sur la colonne des numéros. */
export function lineGeometry(gutter: HTMLElement, total: number): { top: number; padTop: number; lineHeight: number } {
  const cs = getComputedStyle(gutter)
  const padTop = parseFloat(cs.paddingTop) || 0
  const padBottom = parseFloat(cs.paddingBottom) || 0
  const measured = total > 0 ? (gutter.scrollHeight - padTop - padBottom) / total : 0
  const lineHeight = measured > 0 ? measured : parseFloat(cs.lineHeight) || 20
  return { top: gutter.getBoundingClientRect().top, padTop, lineHeight }
}

export function CodeView({
  text,
  language,
  highlight,
  selection,
  comments,
  onSelect,
}: {
  text: string
  /** Langage enregistré, ou `null` (texte brut). */
  language: string | null
  /** Sous les seuils de taille : coloration permise. */
  highlight: boolean
  /** Lignes choisies (affichées en surbrillance). */
  selection: LineSpan | null
  /** Extraits déjà dans la revue pour ce fichier (marqués dans la marge). */
  comments: readonly FileDraftComment[]
  onSelect: (span: LineSpan | null, at: SelectionPoint | null) => void
}) {
  const total = useMemo(() => lineCount(text), [text])
  const numbers = useMemo(() => Array.from({ length: total }, (_, i) => i + 1).join('\n'), [total])
  const html = useMemo(() => (highlight ? highlightCode(text, language) : null), [text, language, highlight])
  const codeRef = useRef<HTMLElement>(null)
  const gutterRef = useRef<HTMLPreElement>(null)
  /** Ligne d'ancrage des Maj+clics (remise à zéro quand le texte change). */
  const anchor = useRef<number | null>(null)
  const dragging = useRef(false)
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect

  useEffect(() => {
    anchor.current = null
    dragging.current = false
  }, [text])

  const lineAtY = (clientY: number): number => {
    const g = gutterRef.current
    if (!g) return 1
    const { top, padTop, lineHeight } = lineGeometry(g, total)
    return Math.min(Math.max(1, Math.floor((clientY - top - padTop) / lineHeight) + 1), Math.max(1, total))
  }
  const pointAfter = (lineEnd: number): SelectionPoint => {
    const g = gutterRef.current
    if (!g) return { x: 0, y: 0 }
    const { top, padTop, lineHeight } = lineGeometry(g, total)
    return { x: g.getBoundingClientRect().right + 8, y: top + padTop + lineEnd * lineHeight }
  }

  // Sélection de texte dans le code (souris ou clavier) : ramenée aux lignes qu'elle couvre.
  const readTextSelection = () => {
    const code = codeRef.current
    const sel = window.getSelection()
    if (!code || !sel || sel.rangeCount === 0 || sel.isCollapsed) return
    const range = sel.getRangeAt(0)
    const span = codeSelection(code, text, range)
    if (!span) return
    anchor.current = span.line
    const after = pointAfter(span.lineEnd)
    onSelectRef.current(span, { x: after.x, y: range.getBoundingClientRect().bottom || after.y })
  }
  const readRef = useRef(readTextSelection)
  readRef.current = readTextSelection

  // Glisser sur les numéros, et Maj+flèches dans le code.
  useEffect(() => {
    function move(e: MouseEvent) {
      if (!dragging.current || anchor.current === null) return
      const span = spanBetween(anchor.current, lineAtYRef.current(e.clientY), total)
      onSelectRef.current(span, pointAfterRef.current(span.lineEnd))
    }
    function up() {
      dragging.current = false
    }
    function key(e: KeyboardEvent) {
      if (e.shiftKey || /^(Arrow|Home|End|Page)/.test(e.key)) readRef.current()
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    document.addEventListener('keyup', key)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.removeEventListener('keyup', key)
    }
  }, [total])
  const lineAtYRef = useRef(lineAtY)
  lineAtYRef.current = lineAtY
  const pointAfterRef = useRef(pointAfter)
  pointAfterRef.current = pointAfter

  function onGutterDown(e: ReactMouseEvent<HTMLPreElement>) {
    if (e.button !== 0 || total === 0) return
    e.preventDefault()
    window.getSelection()?.removeAllRanges()
    const line = lineAtY(e.clientY)
    // Maj+clic : de la ligne d'ancrage (ou du début de la sélection) jusqu'ici.
    const from = e.shiftKey ? (anchor.current ?? selection?.line ?? line) : line
    anchor.current = from
    dragging.current = true
    const span = spanBetween(from, line, total)
    onSelect(span, pointAfter(span.lineEnd))
  }

  const style = { '--lh': LINE_CSS, '--pad': PAD_CSS } as CSSProperties
  const band = (s: LineSpan): CSSProperties => ({ '--l0': s.line - 1, '--n': s.lineEnd - s.line + 1 }) as CSSProperties

  return (
    <div className="codeview" style={style}>
      <pre className="gutter" ref={gutterRef} aria-hidden="true" onMouseDown={onGutterDown} title="Clique, glisse ou Maj+clic pour choisir des lignes à commenter">
        {numbers}
      </pre>
      <pre className="code" onMouseUp={readTextSelection}>
        {html !== null ? (
          // HTML produit par highlight.js : texte du fichier échappé, seules des balises <span class="hljs-…">.
          <code ref={codeRef} className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <code ref={codeRef}>{text}</code>
        )}
      </pre>
      {comments.map((c) => (
        <span
          key={c.id}
          className="cmark"
          style={band({ line: c.line, lineEnd: c.lineEnd })}
          title={`Dans la revue (lignes ${linesLabel(c.line, c.lineEnd)})${c.text ? ` : ${c.text}` : ''}`}
        />
      ))}
      {selection && <span className="selband" style={band(selection)} aria-hidden="true" />}
    </div>
  )
}
