/**
 * Fenêtre modale accessible : focus piégé (Tab et Maj+Tab restent dedans),
 * Échap ferme (sauf depuis un élément marqué `data-own-escape`, qui le gère), clic sur le fond ferme, focus rendu à l'élément d'origine à la
 * fermeture seulement (pas à chaque rendu du parent).
 *
 * `panel` (lot 15) : panneau ancré à droite, sur toute la largeur disponible
 * par défaut ; poignée sur le bord gauche (souris ou flèches du clavier,
 * double-clic : toute la largeur) et « Agrandir / Réduire » (plein écran dans
 * la fenêtre) ; taille retenue sous `panel.sizeKey`.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent, type ReactNode } from 'react'

import { browserStorage } from '../state/collapse'
import {
  DEFAULT_PANEL_SIZE,
  MIN_PANEL_WIDTH,
  PANEL_KEY_STEP,
  PANEL_MARGIN,
  clampPanelWidth,
  loadPanelSize,
  savePanelSize,
  type PanelSize,
} from '../state/panelSize'
import { useT } from '../i18n'
import { ViewBoundary } from './ViewBoundary'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.hasAttribute('hidden'))
}

export function Modal({
  title,
  onClose,
  children,
  width,
  busy = false,
  panel,
}: {
  title: string
  onClose: () => void
  children: ReactNode
  width?: number
  /** Action en cours : Échap, le fond et × ne ferment pas. */
  busy?: boolean
  /** Panneau redimensionnable ancré à droite, taille retenue sous `sizeKey`. */
  panel?: { sizeKey: string }
}) {
  const t = useT()
  const sizeKey = panel?.sizeKey ?? null
  const [size, setSize] = useState<PanelSize>(() => (sizeKey ? loadPanelSize(browserStorage(), sizeKey) : DEFAULT_PANEL_SIZE))
  /** Glisser en cours : point et largeur de départ, dernière taille calculée (enregistrée au relâcher). */
  const drag = useRef<{ x: number; width: number; available: number; last: PanelSize | null } | null>(null)
  const scrim = useRef<HTMLDivElement>(null)
  const busyRef = useRef(busy)
  busyRef.current = busy
  const titleId = useId()
  const box = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  // Pris au premier rendu, avant qu'un `autoFocus` ne déplace le focus.
  const [opener] = useState<Element | null>(() => document.activeElement)

  // Une seule fois : focus initial, piège, Échap, et retour du focus au démontage.
  useEffect(() => {
    const root = box.current
    if (root && !root.contains(document.activeElement)) {
      const auto = root.querySelector<HTMLElement>('[autofocus], [data-autofocus]') ?? focusables(root)[0]
      auto?.focus()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Une partie du dialogue qui gère elle-même Échap (panneau à fermer d'abord) : on la laisse faire.
        if (e.target instanceof Element && e.target.closest('[data-own-escape]')) return
        e.preventDefault()
        if (!busyRef.current) onCloseRef.current()
        return
      }
      if (e.key !== 'Tab' || !box.current) return
      const list = focusables(box.current)
      if (list.length === 0) {
        e.preventDefault()
        return
      }
      const first = list[0]!
      const last = list[list.length - 1]!
      const active = document.activeElement
      if (e.shiftKey && (active === first || !box.current.contains(active))) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (active === last || !box.current.contains(active))) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus()
    }
  }, [])

  /** Largeur disponible pour le panneau (fenêtre moins la marge du fond). */
  function available(): number {
    return (scrim.current?.clientWidth || window.innerWidth) - PANEL_MARGIN
  }
  function commit(next: PanelSize) {
    setSize(next)
    if (sizeKey) savePanelSize(browserStorage(), sizeKey, next)
  }
  function onGripDown(e: PointerEvent<HTMLDivElement>) {
    if (e.button !== 0 || !box.current) return
    e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    drag.current = { x: e.clientX, width: box.current.getBoundingClientRect().width, available: available(), last: null }
  }
  function onGripMove(e: PointerEvent<HTMLDivElement>) {
    const d = drag.current
    if (!d) return
    // Ancré à droite : tirer vers la gauche élargit.
    d.last = { width: clampPanelWidth(d.width + d.x - e.clientX, d.available), maximized: false }
    setSize(d.last)
  }
  function onGripUp(e: PointerEvent<HTMLDivElement>) {
    const d = drag.current
    if (!d) return
    drag.current = null
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    if (d.last) commit(d.last)
  }
  function onGripKey(e: ReactKeyboardEvent<HTMLDivElement>) {
    const avail = available()
    const current = size.width ?? avail
    let next: number | null | undefined
    if (e.key === 'ArrowLeft') next = clampPanelWidth(current + PANEL_KEY_STEP, avail)
    else if (e.key === 'ArrowRight') next = clampPanelWidth(current - PANEL_KEY_STEP, avail)
    else if (e.key === 'Home') next = clampPanelWidth(MIN_PANEL_WIDTH, avail)
    else if (e.key === 'End') next = null
    if (next === undefined) return
    e.preventDefault()
    commit({ width: next, maximized: false })
  }

  const isPanel = sizeKey !== null
  /** Bornes annoncées par la poignée : de la largeur minimale à la largeur disponible (valeur courante comprise). */
  const gripMax = Math.max(1, Math.floor((typeof window === 'undefined' ? 0 : window.innerWidth) - PANEL_MARGIN))
  const maximized = isPanel && size.maximized
  const style = isPanel
    ? maximized
      ? undefined
      : { width: size.width === null ? '100%' : `min(${size.width}px, 100%)` }
    : width
      ? { width: `min(${width}px, 100%)` }
      : undefined

  return (
    <div
      ref={scrim}
      className={`scrim${isPanel ? ' panel-scrim' : ''}${maximized ? ' max' : ''}`}
      onMouseDown={(e) => e.target === e.currentTarget && !busyRef.current && onCloseRef.current()}
    >
      <div
        className={`modal${isPanel ? ' panel-modal' : ''}${maximized ? ' max' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={box}
        style={style}
      >
        <div className="mh">
          <h2 id={titleId}>{title}</h2>
          {isPanel && (
            <button
              type="button"
              className="btn ghost sm mh-size"
              onClick={() => commit({ ...size, maximized: !maximized })}
              title={maximized ? t('shell.modal.restoreTitle') : t('shell.modal.maximizeTitle')}
            >
              {maximized ? t('shell.modal.restore') : t('shell.modal.maximize')}
            </button>
          )}
          <button className="btn ghost sm x" onClick={() => onCloseRef.current()} aria-label={t('shell.close')} disabled={busy}>
            ×
          </button>
        </div>
        {/* Une erreur d'affichage du contenu reste dans le dialogue (en-tête et × gardés). */}
        <ViewBoundary label={title} kind="dialogue">
          {children}
        </ViewBoundary>
        {/* Poignée en fin de dialogue : le focus initial va au contenu, pas à elle (placée en absolu sur le bord gauche). */}
        {isPanel && !maximized && (
          <div
            className="panel-grip"
            role="separator"
            aria-orientation="vertical"
            aria-label={t('shell.modal.gripLabel')}
            aria-valuemin={Math.min(MIN_PANEL_WIDTH, gripMax)}
            aria-valuemax={gripMax}
            aria-valuenow={Math.min(size.width ?? gripMax, gripMax)}
            aria-valuetext={size.width === null ? t('shell.modal.fullWidth') : t('shell.pixels', { n: size.width })}
            tabIndex={0}
            title={t('shell.modal.gripTitle')}
            onPointerDown={onGripDown}
            onPointerMove={onGripMove}
            onPointerUp={onGripUp}
            onPointerCancel={onGripUp}
            onDoubleClick={() => commit({ width: null, maximized: false })}
            onKeyDown={onGripKey}
          />
        )}
      </div>
    </div>
  )
}
