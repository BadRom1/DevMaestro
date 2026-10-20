import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { SettingsStore } from '../src/main/settingsStore'
import {
  SettingsError,
  applyPatch,
  defaultSettings,
  mergePatches,
  normalizeSettings,
  validatePatch,
  type ThemeSettings,
} from '../src/shared/settings'
import { PALETTES, paletteValue, resolveScheme, schemeTokens, themeJson, themeOverrides } from '../src/renderer/src/state/themeTokens'
import { terminalTheme } from '../src/renderer/src/theme'

/** Clair : Okabe-Ito ; sombre : contraste élevé, avec chacun une couleur choisie. */
const split: ThemeSettings = {
  mode: 'system',
  light: { palette: 'okabe', custom: { wait: '#111111' } },
  dark: { palette: 'contraste', custom: { done: '#222222' } },
}

describe('thème : migration de l’ancien format (une seule palette)', () => {
  it('la palette et ses couleurs sont reprises dans les deux modes', () => {
    const s = normalizeSettings({
      theme: { mode: 'light', palette: 'okabe', custom: { light: { accent: '#ABCDEF' }, dark: { err: '#010203' } } },
      worktrees: { location: 'managed', projectLocations: {}, branchPrefix: '', notifyIntegrated: false },
    })
    expect(s.theme).toEqual({
      mode: 'light',
      light: { palette: 'okabe', custom: { accent: '#abcdef' } },
      dark: { palette: 'okabe', custom: { err: '#010203' } },
    })
    // Les autres réglages ne sont pas touchés par la migration.
    expect(s.worktrees.location).toBe('managed')
  })

  it('ancien format partiel ou abîmé : valeurs par défaut là où il manque', () => {
    expect(normalizeSettings({ theme: { mode: 'dark', palette: 'contraste' } }).theme).toEqual({
      mode: 'dark',
      light: { palette: 'contraste', custom: {} },
      dark: { palette: 'contraste', custom: {} },
    })
    expect(normalizeSettings({ theme: { palette: 'violet', custom: 'x' } }).theme).toEqual(defaultSettings().theme)
    expect(normalizeSettings({ theme: 'sombre' }).theme).toEqual(defaultSettings().theme)
  })

  it('nouveau format : relu tel quel ; mode abîmé isolé', () => {
    expect(normalizeSettings({ theme: split }).theme).toEqual(split)
    const s = normalizeSettings({ theme: { ...split, dark: { palette: 'inconnue', custom: { done: '#222222', zz: '#000000' } } } })
    expect(s.theme.light).toEqual(split.light)
    expect(s.theme.dark).toEqual({ palette: 'devmaestro', custom: { done: '#222222' } })
  })

  it('un mode au nouveau format, l’autre absent : l’autre reprend l’ancienne palette', () => {
    const s = normalizeSettings({ theme: { mode: 'dark', palette: 'okabe', dark: { palette: 'contraste', custom: {} } } })
    expect(s.theme.dark.palette).toBe('contraste')
    expect(s.theme.light.palette).toBe('okabe')
  })

  describe('sur disque', () => {
    let dir: string
    afterEach(() => rmSync(dir, { recursive: true, force: true }))

    it('ancien fichier lu, réécrit au nouveau format à la modification suivante', async () => {
      dir = mkdtempSync(path.join(tmpdir(), 'dm-theme-'))
      const file = path.join(dir, 'settings.json')
      writeFileSync(file, JSON.stringify({ version: 1, theme: { mode: 'system', palette: 'okabe', custom: { light: {}, dark: { run: '#00ff00' } } } }))
      const st = new SettingsStore(dir)
      const s = await st.load()
      expect(s.theme.dark).toEqual({ palette: 'okabe', custom: { run: '#00ff00' } })
      await st.update({ theme: { light: { palette: 'contraste', custom: {} } } })
      const disk = JSON.parse(readFileSync(file, 'utf8'))
      expect(disk.theme).toEqual({
        mode: 'system',
        light: { palette: 'contraste', custom: {} },
        dark: { palette: 'okabe', custom: { run: '#00ff00' } },
      })
      expect(disk.theme.palette).toBeUndefined()
      expect(disk.theme.custom).toBeUndefined()
    })
  })
})

describe('thème : palette du mode effectif', () => {
  it('chaque mode prend sa palette et ses couleurs, jamais celles de l’autre', () => {
    expect(themeOverrides(split, 'light')).toEqual({ ...PALETTES.okabe.light, wait: '#111111' })
    expect(themeOverrides(split, 'dark')).toEqual({ ...PALETTES.contraste.dark, done: '#222222' })
    expect(themeOverrides(split, 'light').done).toBe(PALETTES.okabe.light.done)
    expect(themeOverrides(split, 'dark').wait).toBe(PALETTES.contraste.dark.wait)
  })

  it.each([
    ['system', true, 'light'],
    ['system', false, 'dark'],
    ['light', false, 'light'],
    ['dark', true, 'dark'],
  ] as const)('mode %s, système clair = %s → palette du mode %s', (mode, systemLight, expected) => {
    const theme = { ...split, mode }
    const scheme = resolveScheme(mode, systemLight)
    expect(scheme).toBe(expected)
    const tokens = schemeTokens(theme, scheme)
    expect(tokens.accent).toBe(PALETTES[theme[expected].palette][expected].accent)
    // Le terminal suit la même palette (fond, texte, sélection).
    const term = terminalTheme(theme, scheme)
    expect(term.background).toBe(tokens.sunk)
    expect(term.foreground).toBe(tokens.fg)
    expect(term.selectionBackground?.startsWith(tokens.accent!)).toBe(true)
  })

  it('basculement du système en « Auto » : le terminal change de palette tout de suite', () => {
    const bg = [true, false, true].map((light) => terminalTheme(split, resolveScheme('system', light)).background)
    // Clair Okabe-Ito (neutres de base) → sombre contraste élevé (fond noir) → clair.
    expect(bg).toEqual(['#f7f8fb', '#000000', '#f7f8fb'])
  })

  it('valeur de palette sans personnalisation (bouton « revenir à la palette »)', () => {
    expect(paletteValue('okabe', 'light', 'accent')).toBe(PALETTES.okabe.light.accent)
    expect(paletteValue('devmaestro', 'dark', 'accent')).toBe('#86a8ff')
  })

  it('JSON copié au nouveau format', () => {
    expect(JSON.parse(themeJson(split))).toEqual(split)
  })
})

describe('thème : modifications', () => {
  it('fusion : un mode modifié ne touche ni l’autre mode ni le reste des réglages', () => {
    const base = { ...defaultSettings(), theme: split, worktrees: { ...defaultSettings().worktrees, branchPrefix: 'romain/' } }
    const next = applyPatch(base, validatePatch({ theme: { dark: { palette: 'okabe', custom: {} } } }))
    expect(next.theme).toEqual({ mode: 'system', light: split.light, dark: { palette: 'okabe', custom: {} } })
    expect(next.worktrees.branchPrefix).toBe('romain/')
    expect(applyPatch(base, { theme: { mode: 'dark' } }).theme).toEqual({ ...split, mode: 'dark' })
  })

  it('fusion de modifications successives (enregistrement différé)', () => {
    const merged = mergePatches(
      { theme: { light: { palette: 'okabe', custom: {} } }, confirmRemoval: true },
      { theme: { mode: 'dark', light: { palette: 'contraste', custom: { err: '#ffffff' } } } },
    )
    expect(merged).toEqual({
      theme: { mode: 'dark', light: { palette: 'contraste', custom: { err: '#ffffff' } } },
      confirmRemoval: true,
    })
    expect(mergePatches({ theme: { light: split.light } }, { theme: { dark: split.dark } })).toEqual({ theme: { light: split.light, dark: split.dark } })
    expect(applyPatch(defaultSettings(), merged).theme.dark).toEqual(defaultSettings().theme.dark)
  })

  it('le thème complet reste une modification valide', () => {
    expect(validatePatch({ theme: split }).theme).toEqual(split)
  })

  it.each([
    ['ancien format (palette unique)', { theme: { palette: 'okabe' } }],
    ['ancien format (custom par mode)', { theme: { custom: { light: {}, dark: {} } } }],
    ['palette inconnue', { theme: { light: { palette: 'violet', custom: {} } } }],
    ['palette absente', { theme: { dark: { custom: {} } } }],
    ['couleurs absentes', { theme: { dark: { palette: 'okabe' } } }],
    ['mode non objet', { theme: { dark: 'okabe' } }],
    ['champ inconnu dans un mode', { theme: { light: { palette: 'okabe', custom: {}, extra: 1 } } }],
    ['couleur invalide', { theme: { dark: { palette: 'okabe', custom: { err: 'rouge' } } } }],
    ['jeton inconnu', { theme: { dark: { palette: 'okabe', custom: { zzz: '#ffffff' } } } }],
    ['mode d’affichage inconnu', { theme: { mode: 'auto' } }],
    ['thème non objet', { theme: 'sombre' }],
  ])('refuse : %s', (_, patch) => {
    expect(() => validatePatch(patch)).toThrow(SettingsError)
  })
})
