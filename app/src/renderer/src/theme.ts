/** Thème clair / sombre / auto, palettes et couleurs personnalisées, appliqués sur `<html>`. */
import type { ITheme } from '@xterm/xterm'

import type { ThemeSettings } from '../../shared/settings'
import { ALL_OVERRIDABLE, schemeTokens, themeOverrides, type Scheme } from './state/themeTokens'

export type { ThemeMode } from '../../shared/settings'

/** Ancienne clé (lot 4) : lue une fois pour reprendre le mode choisi. */
export const LEGACY_THEME_KEY = 'devmaestro.theme'

export function legacyThemeMode(): ThemeSettings['mode'] | null {
  try {
    const v = localStorage.getItem(LEGACY_THEME_KEY)
    return v === 'light' || v === 'dark' || v === 'system' ? v : null
  } catch {
    return null
  }
}

export function systemPrefersLight(): boolean {
  return window.matchMedia('(prefers-color-scheme: light)').matches
}

/**
 * Pose `data-theme` et les couleurs de la palette et de l'utilisateur pour le
 * mode affiché `scheme` (résolu une seule fois, par l'app : voir `resolveScheme`).
 */
export function applyTheme(theme: ThemeSettings, scheme: Scheme): void {
  const root = document.documentElement
  // Toujours explicite : la feuille de style suit le mode résolu par l'app, pas sa propre requête média.
  root.dataset.theme = scheme
  for (const k of ALL_OVERRIDABLE) root.style.removeProperty(`--${k}`)
  const values = themeOverrides(theme, scheme)
  for (const [k, v] of Object.entries(values)) root.style.setProperty(`--${k}`, v)
  // Sélection dérivée de l'accent effectif du mode (toutes palettes, couleurs choisies comprises), comme le terminal.
  root.style.setProperty('--sel', selectionColor(schemeTokens(theme, scheme).accent, scheme))
}

/** Fond de sélection : l'accent à 22 % (clair) ou 30 % (sombre), en `#rrggbbaa`. */
export function selectionColor(accent: string | undefined, scheme: Scheme): string {
  const a = accent && /^#[0-9a-f]{6}$/i.test(accent) ? accent : scheme === 'light' ? '#2f5bd3' : '#86a8ff'
  return `${a}${scheme === 'light' ? '38' : '4d'}`
}

/**
 * Couleurs du terminal, calculées à partir des jetons du thème (`schemeTokens` :
 * base du mode, palette, couleurs choisies) et non relues dans le CSS : pas de
 * décalage quand le mode change (les effets des enfants passent avant ceux de l'app).
 */
export function terminalThemeFrom(tokens: Record<string, string>, scheme: Scheme): ITheme {
  const sunk = tokens.sunk ?? (scheme === 'light' ? '#f7f8fb' : '#0b0d12')
  const fg = tokens.fg ?? (scheme === 'light' ? '#1a1f2c' : '#dde2ec')
  const accent = tokens.accent ?? (scheme === 'light' ? '#2f5bd3' : '#86a8ff')
  const base: ITheme = {
    background: sunk,
    foreground: fg,
    cursor: fg,
    cursorAccent: sunk,
    // Même sélection que `--sel` (`selectionColor`).
    selectionBackground: selectionColor(accent, scheme),
  }
  if (scheme === 'light') {
    return {
      ...base,
      black: '#1a1f2c',
      red: '#c33b3b',
      green: '#11866a',
      yellow: '#9a5b00',
      blue: '#2f5bd3',
      magenta: '#8a3fb0',
      cyan: '#0f7c8c',
      white: '#5b6476',
      brightBlack: '#6b7385',
      brightRed: '#d24d4d',
      brightGreen: '#1b9a7b',
      brightYellow: '#b26a00',
      brightBlue: '#4470e0',
      brightMagenta: '#a052c4',
      brightCyan: '#1a93a5',
      brightWhite: '#8b93a3',
    }
  }
  return {
    ...base,
    black: '#272d3a',
    red: '#ef6b6b',
    green: '#55c4a2',
    yellow: '#f2a93b',
    blue: '#86a8ff',
    magenta: '#c792ea',
    cyan: '#5fc9d8',
    white: '#dde2ec',
    brightBlack: '#5f6779',
    brightRed: '#ff8585',
    brightGreen: '#7fdcbc',
    brightYellow: '#ffc56b',
    brightBlue: '#a9c1ff',
    brightMagenta: '#ddb0f5',
    brightCyan: '#8ce0ea',
    brightWhite: '#ffffff',
  }
}

/** Thème du terminal pour ces réglages et ce mode. */
export function terminalTheme(theme: ThemeSettings, scheme: Scheme): ITheme {
  return terminalThemeFrom(schemeTokens(theme, scheme), scheme)
}
