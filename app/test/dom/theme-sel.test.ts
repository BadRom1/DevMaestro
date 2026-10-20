// @vitest-environment jsdom
/** `--sel` suit l'accent effectif du mode affiché, pour toutes les palettes, comme le terminal. */
import { describe, expect, it } from 'vitest'

import { PALETTE_NAMES, type ThemeSettings } from '../../src/shared/settings'
import { schemeTokens } from '../../src/renderer/src/state/themeTokens'
import { applyTheme, selectionColor, terminalTheme } from '../../src/renderer/src/theme'

describe('couleur de sélection', () => {
  for (const palette of PALETTE_NAMES) {
    for (const scheme of ['light', 'dark'] as const) {
      it(`${palette}, mode ${scheme === 'light' ? 'clair' : 'sombre'} : --sel = accent du mode, comme le terminal`, () => {
        const theme: ThemeSettings = {
          mode: scheme,
          light: { palette, custom: {} },
          dark: { palette, custom: {} },
        }
        applyTheme(theme, scheme)
        const accent = schemeTokens(theme, scheme).accent!
        const sel = document.documentElement.style.getPropertyValue('--sel')
        expect(sel).toBe(selectionColor(accent, scheme))
        expect(sel.toLowerCase().startsWith(accent.toLowerCase())).toBe(true)
        expect(terminalTheme(theme, scheme).selectionBackground).toBe(sel)
      })
    }
  }

  it('accent choisi par l’utilisateur : repris par --sel', () => {
    const theme: ThemeSettings = {
      mode: 'dark',
      light: { palette: 'devmaestro', custom: {} },
      dark: { palette: 'contraste', custom: { accent: '#123456' } },
    }
    applyTheme(theme, 'dark')
    expect(document.documentElement.style.getPropertyValue('--sel')).toBe('#1234564d')
    applyTheme(theme, 'light')
    expect(document.documentElement.style.getPropertyValue('--sel')).toBe(selectionColor(schemeTokens(theme, 'light').accent, 'light'))
  })
})
