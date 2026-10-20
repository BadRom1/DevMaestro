import { useLayoutEffect, useRef, useState } from 'react'

import { truncateStart } from '../state/format'
import type { Glyph } from '../state/status'
import { meterLevel } from '../state/quotas'

/** Glyphe de statut (forme + couleur) ; le libellé est porté par le parent ou `title`. */
export function StatusGlyph({ glyph, decorative = true }: { glyph: Glyph; decorative?: boolean }) {
  return decorative ? (
    <span className={`st ${glyph.kind}`} aria-hidden="true" title={glyph.label} />
  ) : (
    <span className={`st ${glyph.kind}`} role="img" aria-label={glyph.label} title={glyph.label} />
  )
}

export function Meter({ pct, width, label }: { pct: number | null | undefined; width?: number; label: string }) {
  const p = typeof pct === 'number' ? Math.max(0, Math.min(100, pct)) : 0
  return (
    <span
      className="meter"
      style={width ? { width } : undefined}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={typeof pct === 'number' ? Math.round(p) : undefined}
      aria-valuetext={typeof pct === 'number' ? `${Math.round(p)} %` : 'inconnu'}
    >
      <i className={meterLevel(pct)} style={{ width: `${p}%` }} />
    </span>
  )
}

export function profileClass(profile: string, profiles: { name: string }[]): string {
  const i = profiles.findIndex((p) => p.name === profile)
  return i < 0 ? '' : `p${i % 2}`
}

/** Largeur d'un caractère de la police (à chasse fixe) de `el`, mesurée sur un canevas. */
let canvas: HTMLCanvasElement | null = null
function charWidth(el: HTMLElement): number {
  const cs = getComputedStyle(el)
  canvas ??= document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) return 7
  ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
  return ctx.measureText('0').width || 7
}

/**
 * Chemin tronqué **par le début** (« …/perso/Orchestrateur ») selon la largeur
 * disponible, chemin complet dans l'infobulle. Police à chasse fixe attendue
 * (le budget est un nombre de caractères). Toujours affiché de gauche à droite.
 */
export function PathLabel({ path, title, className }: { path: string; title?: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [max, setMax] = useState<number | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      const cs = getComputedStyle(el)
      const width = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
      const cw = charWidth(el)
      setMax(width > 0 ? Math.max(1, Math.floor(width / cw)) : null)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    // Les polices (fontsource) arrivent après le premier rendu : on remesure.
    const fonts = document.fonts
    fonts?.addEventListener?.('loadingdone', measure)
    void fonts?.ready.then(measure)
    return () => {
      ro.disconnect()
      fonts?.removeEventListener?.('loadingdone', measure)
    }
  }, [])

  return (
    <div ref={ref} className={className} title={title ?? path} dir="ltr">
      {max === null ? path : truncateStart(path, max)}
    </div>
  )
}
