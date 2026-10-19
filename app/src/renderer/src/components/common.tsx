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
