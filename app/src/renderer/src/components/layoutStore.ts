/**
 * Disposition de l'interface (lot 16), tenue hors des composants : zones
 * d'onglets des sessions et largeur des colonnes, globales (une seule
 * disposition pour toutes les sessions et les deux vues), lues une fois du
 * `localStorage` et enregistrées à chaque changement validé.
 */
import { useSyncExternalStore } from 'react'

import { browserStorage } from '../state/collapse'
import { clampColumn, defaultColumns, loadColumns, saveColumns, type ColumnKey, type ColumnWidths } from '../state/columnWidth'
import { defaultLayout, loadLayout, saveLayout, type Layout } from '../state/layout'

interface Snapshot {
  zones: Layout
  columns: ColumnWidths
}

let snap: Snapshot | null = null
const listeners = new Set<() => void>()

function current(): Snapshot {
  if (!snap) {
    const storage = browserStorage()
    snap = { zones: loadLayout(storage), columns: loadColumns(storage) }
  }
  return snap
}

function emit(): void {
  for (const l of listeners) l()
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** Disposition des zones ; `persist` à `false` : changement d'affichage seulement (onglet par défaut au démarrage). */
export function setZones(next: Layout, persist = true): void {
  const s = current()
  if (next !== s.zones) snap = { ...s, zones: next }
  if (persist) saveLayout(browserStorage(), next)
  if (next !== s.zones) emit()
}

/** Largeur d'une colonne ; `persist` à `false` pendant un glisser (enregistrée au relâcher). */
export function setColumn(key: ColumnKey, width: number, persist = true): void {
  const s = current()
  const w = clampColumn(key, width)
  const columns = s.columns[key] === w ? s.columns : { ...s.columns, [key]: w }
  if (columns !== s.columns) snap = { ...s, columns }
  if (persist) saveColumns(browserStorage(), columns)
  if (columns !== s.columns) emit()
}

/** « Réinitialiser la disposition » : une zone avec tous les onglets, colonnes par défaut. */
export function resetLayout(): void {
  snap = { zones: defaultLayout(), columns: defaultColumns() }
  const storage = browserStorage()
  saveLayout(storage, snap.zones)
  saveColumns(storage, snap.columns)
  emit()
}

/** Relit le stockage (tests). */
export function reloadLayoutStore(): void {
  snap = null
  emit()
}

export function getZones(): Layout {
  return current().zones
}

export function useZones(): Layout {
  return useSyncExternalStore(subscribe, () => current().zones)
}

export function useColumns(): ColumnWidths {
  return useSyncExternalStore(subscribe, () => current().columns)
}
