/** Thème clair / sombre / auto, porté par `data-theme` sur `<html>`. */
import type { ITheme } from '@xterm/xterm'

export type ThemeMode = 'light' | 'dark' | 'system'
const KEY = 'devmaestro.theme'

export function loadThemeMode(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch {
    /* stockage indisponible */
  }
  return 'system'
}

export function applyThemeMode(mode: ThemeMode): void {
  const root = document.documentElement
  if (mode === 'system') delete root.dataset.theme
  else root.dataset.theme = mode
  try {
    localStorage.setItem(KEY, mode)
  } catch {
    /* stockage indisponible */
  }
}

export function effectiveScheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode !== 'system') return mode
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

/** Couleurs du terminal, tirées des jetons du thème. */
export function terminalTheme(scheme: 'light' | 'dark'): ITheme {
  const base: ITheme = {
    background: token('--sunk'),
    foreground: token('--fg'),
    cursor: token('--fg'),
    cursorAccent: token('--sunk'),
    selectionBackground: token('--sel'),
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
