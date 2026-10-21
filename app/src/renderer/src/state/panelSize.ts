/**
 * Taille d'un panneau redimensionnable (panneau Forge, lot 15), retenue dans
 * `localStorage` (stockage injecté : testable sans DOM). Le panneau est
 * ancré à droite : on retient sa largeur (`null` : toute la largeur
 * disponible) et s'il est agrandi (plein écran dans la fenêtre).
 * Stockage indisponible ou valeur illisible : taille par défaut.
 */
import type { KeyValueStorage } from './collapse'

export interface PanelSize {
  /** Largeur en pixels CSS ; `null` : toute la largeur disponible. */
  width: number | null
  /** Plein écran dans la fenêtre. */
  maximized: boolean
}

export const DEFAULT_PANEL_SIZE: PanelSize = { width: null, maximized: false }
/** Largeur minimale du panneau (liste et détail restent lisibles). */
export const MIN_PANEL_WIDTH = 560
/** Pas du clavier sur la poignée (flèches gauche et droite). */
export const PANEL_KEY_STEP = 40
/** Marge laissée à gauche du panneau non agrandi (padding du fond ; collé au bord droit). */
export const PANEL_MARGIN = 16

/** Largeur bornée à `[MIN_PANEL_WIDTH, disponible]` ; `null` si elle atteint la largeur disponible. */
export function clampPanelWidth(width: number, available: number): number | null {
  const max = Math.max(MIN_PANEL_WIDTH, Math.floor(available))
  if (!Number.isFinite(width)) return null
  const w = Math.round(Math.min(Math.max(width, MIN_PANEL_WIDTH), max))
  return w >= max ? null : w
}

export function loadPanelSize(storage: KeyValueStorage | null | undefined, key: string): PanelSize {
  try {
    const raw = storage?.getItem(key)
    if (!raw) return DEFAULT_PANEL_SIZE
    const v: unknown = JSON.parse(raw)
    if (typeof v !== 'object' || v === null) return DEFAULT_PANEL_SIZE
    const { width, maximized } = v as Record<string, unknown>
    return {
      width: typeof width === 'number' && Number.isFinite(width) && width >= MIN_PANEL_WIDTH && width <= 100_000 ? Math.round(width) : null,
      maximized: maximized === true,
    }
  } catch {
    return DEFAULT_PANEL_SIZE
  }
}

export function savePanelSize(storage: KeyValueStorage | null | undefined, key: string, size: PanelSize): void {
  try {
    storage?.setItem(key, JSON.stringify({ width: size.width, maximized: size.maximized }))
  } catch {
  }
}
