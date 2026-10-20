/**
 * Raccourcis de taille de l'interface, interceptés par le processus principal
 * (`before-input-event`) avant la page : ni le terminal (donc Claude) ni le
 * menu par défaut d'Electron (zoom au demi-niveau hors paliers) ne les voient.
 * Sans Electron : testable seul.
 */
import type { ZoomDirection } from '../shared/settings'

/** Champs utiles d'un `Electron.Input`. */
export interface KeyInput {
  type: string
  key: string
  code: string
  control: boolean
  meta: boolean
  alt: boolean
  /** Touche maintenue : répétition automatique du système. */
  isAutoRepeat?: boolean
}

/**
 * Ctrl + = / Ctrl + + / Ctrl + − / Ctrl + 0 (et le pavé numérique) ; Cmd sur macOS.
 * Comparé à la touche produite (`key`) et non à sa position : en AZERTY, « - »
 * et « 0 » ne sont pas aux mêmes places qu'en QWERTY. Seule exception : Ctrl +
 * la touche du « 0 » de la rangée des chiffres, qui produit « à » en AZERTY
 * sans Maj.
 */
export function zoomShortcut(input: KeyInput, platform: string = process.platform): ZoomDirection | null {
  if (input.type !== 'keyDown' || input.alt) return null
  const mod = platform === 'darwin' ? input.meta : input.control
  if (!mod) return null
  if (input.key === '=' || input.key === '+' || input.code === 'NumpadAdd') return 'in'
  if (input.key === '-' || input.code === 'NumpadSubtract') return 'out'
  if (input.key === '0' || input.code === 'Numpad0' || input.code === 'Digit0') return 'reset'
  return null
}

/**
 * Raccourci de zoom à intercepter (`intercept` : jamais transmis à la page ni
 * au terminal) et pas à faire : aucun pour la répétition d'une touche
 * maintenue (un palier par appui, comme un cran de molette).
 */
export function zoomKey(input: KeyInput, platform: string = process.platform): { intercept: true; step: ZoomDirection | null } | null {
  const dir = zoomShortcut(input, platform)
  if (!dir) return null
  return { intercept: true, step: input.isAutoRepeat ? null : dir }
}
