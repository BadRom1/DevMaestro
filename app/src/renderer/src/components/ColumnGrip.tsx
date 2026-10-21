/**
 * Poignée d'une colonne redimensionnable (lot 16) : barre latérale des
 * projets, colonne du kanban. Placée en absolu dans l'espace entre la colonne
 * et la session (le conteneur porte `--col-w`). Souris : glisser ; clavier :
 * flèches gauche et droite, Début / Fin (bornes), Entrée ou double clic :
 * largeur par défaut. La largeur est enregistrée au relâcher.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react'

import { clampColumn, columnMax, COLUMN_BOUNDS, COLUMN_KEY_STEP, type ColumnKey } from '../state/columnWidth'
import { useT } from '../i18n'
import { setColumn, useColumns } from './layoutStore'

/**
 * Largeur disponible dans le conteneur, suivie par un `ResizeObserver` (fenêtre,
 * zoom, barre de défilement) ; le conteneur est ré-observé quand il change
 * (vue par statut puis par projet : nouvel élément sous la même référence).
 */
function useAvailable(container: RefObject<HTMLElement | null>): number | undefined {
  const [avail, setAvail] = useState<number | undefined>(undefined)
  const observed = useRef<{ el: HTMLElement | null; stop: () => void } | null>(null)
  const measure = useRef(() => {})
  measure.current = () => {
    const w = container.current?.clientWidth || (typeof window === 'undefined' ? 0 : window.innerWidth)
    setAvail(w > 0 ? w : undefined)
  }
  // À chaque rendu : l'élément observé est-il toujours celui de la référence ?
  useEffect(() => {
    const el = container.current
    if (observed.current?.el === el) return
    observed.current?.stop()
    const onChange = () => measure.current()
    let stop: () => void
    if (el && typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(onChange)
      ro.observe(el)
      stop = () => ro.disconnect()
    } else {
      window.addEventListener('resize', onChange)
      stop = () => window.removeEventListener('resize', onChange)
    }
    observed.current = { el, stop }
    onChange()
  })
  useEffect(
    () => () => {
      observed.current?.stop()
      observed.current = null
    },
    [],
  )
  return avail
}

/** Largeur effective de la colonne (retenue, bornée à la place disponible). */
export function useColumnWidth(column: ColumnKey, container: RefObject<HTMLElement | null>) {
  const columns = useColumns()
  const avail = useAvailable(container)
  return { width: clampColumn(column, columns[column], avail), max: columnMax(column, avail), avail }
}

export function ColumnGrip({
  column,
  label,
  width,
  max,
  avail,
}: {
  column: ColumnKey
  /** Nom accessible (« Largeur de la barre latérale »). */
  label: string
  width: number
  max: number
  avail: number | undefined
}) {
  const t = useT()
  const b = COLUMN_BOUNDS[column]
  const drag = useRef<{ x: number; width: number; last: number | null } | null>(null)

  function onDown(e: PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    drag.current = { x: e.clientX, width, last: null }
  }
  function onMove(e: PointerEvent<HTMLDivElement>) {
    const d = drag.current
    if (!d) return
    d.last = clampColumn(column, d.width + e.clientX - d.x, avail)
    setColumn(column, d.last, false)
  }
  function onUp(e: PointerEvent<HTMLDivElement>) {
    const d = drag.current
    if (!d) return
    drag.current = null
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    if (d.last !== null) setColumn(column, d.last)
  }
  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    let next: number | undefined
    if (e.key === 'ArrowLeft') next = width - COLUMN_KEY_STEP
    else if (e.key === 'ArrowRight') next = width + COLUMN_KEY_STEP
    else if (e.key === 'Home') next = b.min
    else if (e.key === 'End') next = max
    else if (e.key === 'Enter') next = b.def
    if (next === undefined) return
    e.preventDefault()
    setColumn(column, clampColumn(column, next, avail))
  }

  return (
    <div
      className="col-grip"
      role="separator"
      aria-orientation="vertical"
      aria-label={t('shell.columnGrip.label', { label })}
      aria-valuemin={b.min}
      aria-valuemax={max}
      aria-valuenow={width}
      aria-valuetext={t('shell.pixels', { n: width })}
      tabIndex={0}
      title={t('shell.columnGrip.title')}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onDoubleClick={() => setColumn(column, clampColumn(column, b.def, avail))}
      onKeyDown={onKey}
    />
  )
}
