/**
 * Ctrl + molette : un palier de taille de l'interface par cran, au plus un
 * toutes les `WHEEL_ZOOM_INTERVAL_MS` (un pavé tactile envoie des dizaines
 * d'événements par geste). Calcul pur, testable sans DOM.
 */
import type { ZoomDirection } from '../../../shared/settings'

export const WHEEL_ZOOM_INTERVAL_MS = 150

export class WheelZoom {
  private last = Number.NEGATIVE_INFINITY

  /** Pas à faire pour cet événement (molette vers le haut : plus grand), ou `null`. */
  step(e: { ctrlKey: boolean; deltaY: number }, now: number): ZoomDirection | null {
    if (!e.ctrlKey || e.deltaY === 0 || !Number.isFinite(e.deltaY)) return null
    if (now - this.last < WHEEL_ZOOM_INTERVAL_MS) return null
    this.last = now
    return e.deltaY < 0 ? 'in' : 'out'
  }
}
