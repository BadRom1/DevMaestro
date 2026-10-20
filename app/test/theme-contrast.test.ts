/**
 * Contrastes des jetons de texte (WCAG AA, 4,5:1 pour le texte de 11 à
 * 13,5 px) sur les fonds réels de chaque mode et de chaque palette : neutres
 * (`fg`, `muted`, `faint`) et variantes texte des couleurs d'état (`wait-ink`…,
 * `link`), y compris pour des couleurs choisies illisibles telles quelles.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import type { PaletteName, ThemeSettings, ThemeToken } from '../src/shared/settings'
import {
  BASE,
  BASE_NEUTRALS,
  INK_OF,
  accentInk,
  INK_TARGET,
  PALETTES,
  contrastRatio,
  inkTokens,
  mixHex,
  readableInk,
  schemeTokens,
  textBackgrounds,
  type Scheme,
} from '../src/renderer/src/state/themeTokens'
import { terminalTheme } from '../src/renderer/src/theme'

const SCHEMES: Scheme[] = ['light', 'dark']
const AA = 4.5

function theme(palette: PaletteName, custom: Partial<Record<ThemeToken, string>> = {}): Pick<ThemeSettings, Scheme> {
  return { light: { palette, custom }, dark: { palette, custom } }
}

/**
 * Fonds où du texte est posé : neutres (dont `panel-2`, ligne sélectionnée),
 * et teintes réelles des cartes, bandeaux et lignes de diff (attente, erreur,
 * ajout, suppression, de 7 à 13 %) sur chacun d'eux. Les contrôles désactivés
 * (`.btn.pri[disabled]`…) sont exemptés par WCAG 1.4.3 et ne sont pas testés.
 */
function backgrounds(t: Record<string, string>): Record<string, string> {
  const neutrals = { bg: t.bg!, panel: t.panel!, 'panel-2 (ligne sélectionnée)': t['panel-2']!, sunk: t.sunk! }
  const out: Record<string, string> = { ...neutrals }
  for (const tint of ['wait', 'err', 'add', 'del'])
    for (const [n, c] of Object.entries(neutrals)) for (const p of [0.07, 0.1, 0.13]) out[`${tint} ${Math.round(p * 100)} % sur ${n}`] = mixHex(t[tint]!, c, p)
  return out
}

function worst(fg: string, bgs: Record<string, string>): [string, number] {
  return Object.entries(bgs)
    .map(([k, b]) => [k, contrastRatio(fg, b)] as [string, number])
    .sort((a, b) => a[1] - b[1])[0]!
}

describe('contrastes des jetons de texte, par mode et par palette', () => {
  for (const palette of Object.keys(PALETTES) as PaletteName[]) {
    for (const scheme of SCHEMES) {
      it(`${PALETTES[palette].name}, mode ${scheme === 'light' ? 'clair' : 'sombre'} : texte ≥ 4,5:1 partout`, () => {
        const t = schemeTokens(theme(palette), scheme)
        const bgs = backgrounds(t)
        // Coloration syntaxique (styles.css, `--hl-*`) : mélanges des variantes texte.
        t['hl-type'] = mixHex(t.link!, t['err-ink']!, 0.55)
        t['hl-attr'] = mixHex(t['wait-ink']!, t.fg!, 0.65)
        t['hl-meta'] = mixHex(t.muted!, t.fg!, 0.7)
        t['hl-inline'] = mixHex(t['err-ink']!, t.fg!, 0.7)
        // Texte neutre : fonds neutres et cartes ou bandeaux teintés (attente, erreur : 7 à 10 % sur `panel`) ;
        // il n'est jamais posé sur une ligne de diff teintée (numéros de ligne hors de la teinte).
        const neutralBgs = Object.fromEntries(Object.entries(bgs).filter(([k]) => !k.includes(' % ') || (/^(wait|err) (7|10) % sur panel$/.test(k))))
        const text = [...Object.values(INK_OF), 'hl-type', 'hl-attr', 'hl-meta', 'hl-inline']
        const low = [
          ...['fg', 'muted', 'faint'].map((k) => [k, ...worst(t[k]!, neutralBgs)] as const),
          ...text.map((k) => [k, ...worst(t[k]!, bgs)] as const),
        ]
          .filter(([, , r]) => r < AA)
          .map(([k, bg, r]) => `${k} ${t[k]} sur ${bg} : ${r.toFixed(2)}`)
        expect(low).toEqual([])
      })

      it(`${PALETTES[palette].name}, mode ${scheme === 'light' ? 'clair' : 'sombre'} : pastilles pleines et bouton principal`, () => {
        const t = schemeTokens(theme(palette), scheme)
        // `.badge.wait`, `.st.waiting`, `.st.error` : texte `--bg` sur la variante texte pleine.
        for (const k of ['wait-ink', 'err-ink']) expect(contrastRatio(t.bg!, t[k]!), k).toBeGreaterThanOrEqual(AA)
        // `.btn.pri` : `--accent-ink` sur `--accent`.
        expect(contrastRatio(t['accent-ink']!, t.accent!)).toBeGreaterThanOrEqual(AA)
      })

      it(`${PALETTES[palette].name}, mode ${scheme === 'light' ? 'clair' : 'sombre'} : hiérarchie fg > muted > faint gardée`, () => {
        const t = schemeTokens(theme(palette), scheme)
        const on = (k: string) => contrastRatio(t[k]!, t['panel-2']!)
        expect(on('fg')).toBeGreaterThan(on('muted'))
        expect(on('muted')).toBeGreaterThan(on('faint'))
      })
    }
  }
})

describe('variante texte calculée (`readableInk`)', () => {
  it('une couleur déjà lisible est gardée telle quelle', () => {
    expect(readableInk('#1a1f2c', ['#ffffff', '#eef1f6'], 'light')).toBe('#1a1f2c')
    expect(inkTokens(schemeTokens(theme('devmaestro'), 'dark'), 'dark')['wait-ink']).toBe(BASE.dark.wait)
  })

  it('ambre du mode clair : assombri juste assez, même teinte', () => {
    const ink = readableInk(BASE.light.wait, ['#eef1f6', '#ffffff'], 'light')
    expect(contrastRatio(ink, '#eef1f6')).toBeGreaterThanOrEqual(INK_TARGET)
    // Pas plus foncé que nécessaire : le pas précédent (2 % de noir en moins) n'atteint pas la cible.
    const k = [...Array(51).keys()].find((i) => mixHex('#000000', BASE.light.wait, i / 50) === ink)!
    expect(k).toBeGreaterThan(0)
    expect(contrastRatio(mixHex('#000000', BASE.light.wait, (k - 1) / 50), '#eef1f6')).toBeLessThan(INK_TARGET)
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(ink.slice(i, i + 2), 16))
    expect(r).toBeGreaterThan(g!)
    expect(g).toBeGreaterThan(b!)
  })

  it('couleurs choisies illisibles (jaune en clair, gris foncé en sombre) : variante lisible', () => {
    const light = schemeTokens(theme('devmaestro', { wait: '#ffee00', run: '#ffffff' }), 'light')
    const dark = schemeTokens(theme('okabe', { done: '#222222', err: '#000000' }), 'dark')
    for (const [t, keys] of [
      [light, ['wait-ink', 'run-ink']],
      [dark, ['done-ink', 'err-ink']],
    ] as const) {
      for (const k of keys) expect(worst(t[k]!, backgrounds(t))[1]).toBeGreaterThanOrEqual(AA)
    }
    // La couleur d'origine reste pour les fonds et bordures.
    expect(light.wait).toBe('#ffee00')
  })

  it('texte sur l’accent : recalculé pour un accent choisi (bleu foncé en sombre, jaune en clair)', () => {
    const dark = schemeTokens(theme('devmaestro', { accent: '#1a237e' }), 'dark')
    expect(dark['accent-ink']).toBe('#ffffff')
    const light = schemeTokens(theme('devmaestro', { accent: '#ffd400' }), 'light')
    expect(light['accent-ink']).toBe('#000000')
    // Accent de la palette lisible avec son texte : gardé.
    expect(schemeTokens(theme('contraste'), 'dark')['accent-ink']).toBe('#000000')
    expect(accentInk('#2f5bd3', '#ffffff')).toBe('#ffffff')
  })

  it('valeur qui n’est pas #rrggbb : rendue telle quelle', () => {
    expect(readableInk('rebeccapurple', ['#ffffff'], 'light')).toBe('rebeccapurple')
  })

  it('fonds teintés pris en compte : attente, erreur et la couleur elle-même', () => {
    const t = schemeTokens(theme('devmaestro'), 'light')
    // 4 neutres + (attente, erreur, la couleur) à 13 % sur chacun.
    expect(textBackgrounds(t, t.run)).toHaveLength(16)
  })
})

describe('styles.css : valeurs de base alignées sur le calcul', () => {
  const css = readFileSync(path.join(__dirname, '../src/renderer/src/styles.css'), 'utf8')
  const block = (start: string) => {
    const i = css.indexOf(start)
    return css.slice(i, css.indexOf('}', i))
  }
  const read = (b: string, k: string) => b.match(new RegExp(`--${k}: (#[0-9a-f]{6})`))?.[1]

  it('neutres, couleurs d’état et variantes texte de la palette DevMaestro, dans les deux modes', () => {
    const blocks: Record<Scheme, string[]> = {
      dark: [block(':root {')],
      light: [block(':root:not([data-theme="dark"]) {'), block(':root[data-theme="light"] {')],
    }
    for (const scheme of SCHEMES) {
      const t = schemeTokens(theme('devmaestro'), scheme)
      const expected: Record<string, string> = { ...BASE_NEUTRALS[scheme], ...BASE[scheme] }
      for (const k of Object.values(INK_OF)) expected[k] = t[k]!
      for (const b of blocks[scheme]) for (const [k, v] of Object.entries(expected)) expect(read(b, k), `${scheme} --${k}`).toBe(v)
    }
  })
})

describe('terminal : couleurs ANSI de texte lisibles sur son fond', () => {
  const ANSI = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'] as const
  for (const palette of Object.keys(PALETTES) as PaletteName[]) {
    for (const scheme of SCHEMES) {
      it(`${PALETTES[palette].name}, mode ${scheme === 'light' ? 'clair' : 'sombre'}`, () => {
        const term = terminalTheme({ mode: scheme, ...theme(palette) }, scheme)
        const keys = scheme === 'light' ? (['black', ...ANSI] as const) : ANSI
        const low = keys.filter((k) => contrastRatio(term[k]!, term.background!) < AA).map((k) => `${k} ${term[k]}`)
        expect(low).toEqual([])
      })
    }
  }
})
