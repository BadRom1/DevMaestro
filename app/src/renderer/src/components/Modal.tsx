/**
 * Fenêtre modale accessible : focus piégé (Tab et Maj+Tab restent dedans),
 * Échap ferme (sauf depuis un élément marqué `data-own-escape`, qui le gère), clic sur le fond ferme, focus rendu à l'élément d'origine à la
 * fermeture seulement (pas à chaque rendu du parent).
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

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
}: {
  title: string
  onClose: () => void
  children: ReactNode
  width?: number
  /** Action en cours : Échap, le fond et × ne ferment pas. */
  busy?: boolean
}) {
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

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && !busyRef.current && onCloseRef.current()}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={box}
        style={width ? { width: `min(${width}px, 100%)` } : undefined}
      >
        <div className="mh">
          <h2 id={titleId}>{title}</h2>
          <button className="btn ghost sm x" onClick={() => onCloseRef.current()} aria-label="Fermer" disabled={busy}>
            ×
          </button>
        </div>
        {/* Une erreur d'affichage du contenu reste dans le dialogue (en-tête et × gardés). */}
        <ViewBoundary label={title} kind="dialogue">
          {children}
        </ViewBoundary>
      </div>
    </div>
  )
}
