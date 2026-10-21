/**
 * Largeur des colonnes redimensionnables (lot 16) : barre latérale des
 * projets (vue par projet) et colonne du kanban quand une session est ouverte
 * à côté (vue par statut). Retenues dans `localStorage` (stockage injecté :
 * testable sans DOM) ; valeur illisible ou hors bornes : largeur par défaut.
 */
import type { KeyValueStorage } from './collapse'

export type ColumnKey = 'sidebar' | 'kanban'

export interface ColumnBounds {
  min: number
  max: number
  def: number
}

export const COLUMN_BOUNDS: Record<ColumnKey, ColumnBounds> = {
  sidebar: { min: 200, max: 560, def: 268 },
  kanban: { min: 220, max: 720, def: 420 },
}

export type ColumnWidths = Record<ColumnKey, number>

export const COLUMNS_KEY = 'devmaestro.layout.columns'
/** Pas du clavier sur la poignée (flèches gauche et droite). */
export const COLUMN_KEY_STEP = 24
/** Largeur toujours laissée à la session à côté de la colonne. */
export const MIN_SESSION_WIDTH = 480

export function defaultColumns(): ColumnWidths {
  return { sidebar: COLUMN_BOUNDS.sidebar.def, kanban: COLUMN_BOUNDS.kanban.def }
}

/**
 * Borne haute effective : celle de la colonne, réduite pour laisser
 * `MIN_SESSION_WIDTH` à la session dans `available` pixels (jamais sous le minimum).
 */
export function columnMax(key: ColumnKey, available?: number): number {
  const b = COLUMN_BOUNDS[key]
  if (available === undefined || !Number.isFinite(available) || available <= 0) return b.max
  return Math.max(b.min, Math.min(b.max, Math.floor(available - MIN_SESSION_WIDTH)))
}

/** Largeur bornée à `[min, columnMax]`, arrondie au pixel. */
export function clampColumn(key: ColumnKey, width: number, available?: number): number {
  const b = COLUMN_BOUNDS[key]
  if (!Number.isFinite(width)) return b.def
  return Math.round(Math.min(Math.max(width, b.min), columnMax(key, available)))
}

export function loadColumns(storage: KeyValueStorage | null | undefined): ColumnWidths {
  const out = defaultColumns()
  try {
    const raw = storage?.getItem(COLUMNS_KEY)
    if (!raw) return out
    const v: unknown = JSON.parse(raw)
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return out
    for (const key of Object.keys(COLUMN_BOUNDS) as ColumnKey[]) {
      const w = (v as Record<string, unknown>)[key]
      const b = COLUMN_BOUNDS[key]
      if (typeof w === 'number' && Number.isFinite(w) && w >= b.min && w <= b.max) out[key] = Math.round(w)
    }
    return out
  } catch {
    return out
  }
}

export function saveColumns(storage: KeyValueStorage | null | undefined, widths: ColumnWidths): void {
  try {
    storage?.setItem(COLUMNS_KEY, JSON.stringify(widths))
  } catch {
  }
}
