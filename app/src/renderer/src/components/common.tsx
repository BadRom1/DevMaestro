import { useLayoutEffect, useRef, useState } from 'react'

import { useSettings } from '../settings'
import { truncateStart } from '../state/format'
import { profileTone } from '../state/profileTone'
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
  return `p${profileTone(profile, profiles)}`
}

/** Badge court d'un profil (« P », « W ») ; libellé long et nom technique en infobulle. */
export function ProfileBadge({ profile, profiles }: { profile: string; profiles: { name: string }[] }) {
  const { label } = useSettings()
  const l = label(profile)
  const tip = `Profil ${l.long} (${profile})`
  return (
    <span className={`pbadge ${profileClass(profile, profiles)}`} title={tip} aria-hidden="true">
      {l.short}
    </span>
  )
}

/** Libellé long d'un profil (sans le badge court : jamais les deux côte à côte), nom technique en infobulle. */
export function ProfileChip({ profile, profiles, className = '' }: { profile: string; profiles: { name: string }[]; className?: string }) {
  const { label } = useSettings()
  const l = label(profile)
  return (
    <span className={`chip ${profileClass(profile, profiles)} ${className}`.trim()} title={`Profil Claude Code ${l.long} (${profile})`}>
      {l.long}
    </span>
  )
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
export function PathLabel({
  path,
  title,
  className,
  inline = false,
}: {
  path: string
  title?: string
  className?: string
  /** Rendu en `<span>` (dans un bouton, par exemple). */
  inline?: boolean
}) {
  const ref = useRef<HTMLElement>(null)
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
    inline ? (
      <span ref={ref} className={className} title={title ?? path} dir="ltr">
        {max === null ? path : truncateStart(path, max)}
      </span>
    ) : (
      <div ref={ref as React.RefObject<HTMLDivElement>} className={className} title={title ?? path} dir="ltr">
        {max === null ? path : truncateStart(path, max)}
      </div>
    )
  )
}
