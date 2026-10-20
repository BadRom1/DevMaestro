/**
 * Palettes et couleurs personnalisées (calcul pur, testable sans DOM).
 *
 * Les valeurs de base des deux modes sont dans `styles.css` ; la palette et
 * les couleurs choisies **du mode effectivement affiché** (chaque mode a les
 * siennes) s'y ajoutent sous forme de propriétés CSS sur `<html>`. Les glyphes de statut gardent leur forme
 * quelle que soit la couleur.
 */
import type { PaletteName, Scheme, ThemeSettings, ThemeToken } from '../../../shared/settings'

export type { Scheme } from '../../../shared/settings'

/** Jetons neutres qu'une palette (contraste élevé) peut aussi changer. */
export const NEUTRAL_TOKENS = ['bg', 'panel', 'panel-2', 'sunk', 'line', 'line-2', 'fg', 'muted', 'faint', 'accent-ink'] as const

export const TOKEN_LABELS: Record<ThemeToken, string> = {
  accent: 'Accent (sélection, liens)',
  wait: 'En attente de réponse',
  run: 'En cours',
  done: 'Terminée / succès',
  err: 'Erreur / échec',
  add: 'Lignes ajoutées',
  del: 'Lignes supprimées',
}

/** Valeurs de `styles.css` (palette DevMaestro). */
export const BASE: Record<Scheme, Record<ThemeToken, string>> = {
  light: { accent: '#2f5bd3', wait: '#b26a00', run: '#11866a', done: '#3f7d2c', err: '#c33b3b', add: '#11866a', del: '#c33b3b' },
  dark: { accent: '#86a8ff', wait: '#f2a93b', run: '#55c4a2', done: '#7fb069', err: '#ef6b6b', add: '#55c4a2', del: '#ef6b6b' },
}

export interface Palette {
  name: string
  description: string
  light: Record<string, string>
  dark: Record<string, string>
}

/** Palettes de la maquette (`prototype/orchestrateur.html`). */
export const PALETTES: Record<PaletteName, Palette> = {
  devmaestro: { name: 'DevMaestro', description: 'Palette par défaut', light: {}, dark: {} },
  okabe: {
    name: 'Okabe-Ito',
    description: 'Sûre pour les daltonismes rouge-vert : plus d’opposition rouge/vert',
    light: { accent: '#a24f86', wait: '#a86f00', run: '#00785a', done: '#0072b2', err: '#c04f00', add: '#0072b2', del: '#c04f00' },
    dark: { accent: '#cc79a7', wait: '#e69f00', run: '#1fb58a', done: '#56b4e9', err: '#e0702a', add: '#56b4e9', del: '#e0702a' },
  },
  contraste: {
    name: 'Contraste élevé',
    description: 'Fonds purs, bordures marquées, texte au maximum',
    light: {
      bg: '#ffffff', panel: '#ffffff', 'panel-2': '#f0f0f0', sunk: '#ffffff', line: '#5a5a5a', 'line-2': '#333333',
      fg: '#000000', muted: '#262626', faint: '#444444', accent: '#0033cc', 'accent-ink': '#ffffff',
      wait: '#8a4b00', run: '#005f46', done: '#003f8a', err: '#b00000', add: '#005f46', del: '#b00000',
    },
    dark: {
      bg: '#000000', panel: '#0a0a0a', 'panel-2': '#161616', sunk: '#000000', line: '#7a7a7a', 'line-2': '#a0a0a0',
      fg: '#ffffff', muted: '#dedede', faint: '#b8b8b8', accent: '#ffd400', 'accent-ink': '#000000',
      wait: '#ffb000', run: '#00e0a0', done: '#7fd4ff', err: '#ff7070', add: '#7fd4ff', del: '#ff7070',
    },
  },
}

/** Mode affiché : celui choisi, ou celui du système pour « Auto ». */
export function resolveScheme(mode: ThemeSettings['mode'], systemPrefersLight: boolean): Scheme {
  return mode === 'system' ? (systemPrefersLight ? 'light' : 'dark') : mode
}

/** Propriétés CSS à poser sur `<html>` (sans `--`) pour ce mode : sa palette puis ses couleurs choisies. */
export function themeOverrides(theme: Pick<ThemeSettings, Scheme>, scheme: Scheme): Record<string, string> {
  const { palette: name, custom } = theme[scheme]
  const palette = PALETTES[name] ?? PALETTES.devmaestro
  return { ...palette[scheme], ...custom }
}

/** Valeur effective d'un jeton (sélecteurs de couleur, aperçu). */
export function tokenValue(theme: Pick<ThemeSettings, Scheme>, scheme: Scheme, token: ThemeToken): string {
  return { ...BASE[scheme], ...themeOverrides(theme, scheme) }[token]!
}

/** Valeur d'un jeton dans une palette, sans couleur choisie (pour savoir si une couleur est personnalisée). */
export function paletteValue(palette: PaletteName, scheme: Scheme, token: ThemeToken): string {
  return { ...BASE[scheme], ...(PALETTES[palette] ?? PALETTES.devmaestro)[scheme] }[token]!
}

/**
 * Variante « texte » de chaque couleur d'état : la même teinte, assombrie (clair)
 * ou éclaircie (sombre) juste assez pour se lire (≥ 4,5:1) sur tous les fonds où
 * elle sert de texte. La couleur d'origine reste pour les fonds, bordures et glyphes.
 * `accent-ink` désigne déjà le texte posé SUR l'accent : la variante texte de l'accent s'appelle `link`.
 */
export const INK_OF: Record<ThemeToken, string> = {
  accent: 'link',
  wait: 'wait-ink',
  run: 'run-ink',
  done: 'done-ink',
  err: 'err-ink',
  add: 'add-ink',
  del: 'del-ink',
}

/** Contraste visé (WCAG AA texte courant : 4,5:1), avec une marge pour les arrondis de `color-mix`. */
export const INK_TARGET = 4.6

const HEX6 = /^#[0-9a-f]{6}$/i

function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]
}

/** Mélange sRGB (comme `color-mix(in srgb, a p, b)`), en `#rrggbb`. */
export function mixHex(a: string, b: string, p: number): string {
  const x = rgb(a)
  const y = rgb(b)
  return `#${x.map((v, i) => Math.round(v * p + y[i]! * (1 - p)).toString(16).padStart(2, '0')).join('')}`
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** Rapport de contraste WCAG entre deux couleurs `#rrggbb`. */
export function contrastRatio(a: string, b: string): number {
  const x = luminance(a)
  const y = luminance(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

/**
 * `color` si elle atteint `target` sur chacun des `backgrounds`, sinon la
 * première variante assombrie (clair) ou éclaircie (sombre) par pas de 2 % qui
 * l'atteint. Une valeur qui n'est pas `#rrggbb` est rendue telle quelle.
 */
export function readableInk(color: string, backgrounds: readonly string[], scheme: Scheme, target = INK_TARGET): string {
  if (!HEX6.test(color)) return color
  const bgs = backgrounds.filter((b) => HEX6.test(b))
  const toward = scheme === 'light' ? '#000000' : '#ffffff'
  for (let k = 0; k <= 50; k++) {
    const c = k === 0 ? color.toLowerCase() : mixHex(toward, color, k / 50)
    if (bgs.every((b) => contrastRatio(c, b) >= target)) return c
  }
  return toward
}

/** Teinte la plus forte d'un fond coloré sous du texte (`tr.add td.c`, `.preview .diff` : 13 %). */
export const MAX_TINT = 0.13

/**
 * Fonds sur lesquels du texte d'état est posé : les neutres du mode, et les
 * fonds teintés (cartes et bandeaux d'attente ou d'erreur, lignes de diff,
 * la couleur elle-même) de 0 à 13 % sur chacun de ces neutres.
 */
export function textBackgrounds(tokens: Record<string, string>, tint?: string): string[] {
  const neutrals = [tokens.bg!, tokens.panel!, tokens['panel-2']!, tokens.sunk!].filter((b) => HEX6.test(b))
  const out = [...neutrals]
  for (const t of [tokens.wait, tokens.err, tint]) {
    if (!t || !HEX6.test(t)) continue
    for (const n of neutrals) out.push(mixHex(t, n, MAX_TINT))
  }
  return out
}

/**
 * Texte posé sur l'accent (bouton principal) : celui de la palette s'il se lit
 * sur l'accent effectif, sinon le meilleur de blanc et noir (accent choisi).
 */
export function accentInk(accent: string, current: string | undefined): string {
  if (!HEX6.test(accent)) return current ?? '#ffffff'
  if (current && HEX6.test(current) && contrastRatio(current, accent) >= 4.5) return current
  return contrastRatio('#ffffff', accent) >= contrastRatio('#000000', accent) ? '#ffffff' : '#000000'
}

/** Variantes texte (`wait-ink`…, `link`) pour ces jetons (neutres et couleurs d'état d'un mode). */
export function inkTokens(tokens: Record<string, string>, scheme: Scheme): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [token, ink] of Object.entries(INK_OF)) {
    const c = tokens[token]
    if (c) out[ink] = readableInk(c, textBackgrounds(tokens, c), scheme)
  }
  return out
}

/** Toutes les propriétés qu'une palette ou une personnalisation peut poser (pour les retirer). */
export const ALL_OVERRIDABLE: readonly string[] = [...NEUTRAL_TOKENS, ...Object.keys(BASE.dark), ...Object.values(INK_OF)]

/** Thème à copier (JSON lisible, à coller ou partager). */
export function themeJson(theme: ThemeSettings): string {
  return JSON.stringify({ mode: theme.mode, light: theme.light, dark: theme.dark }, null, 2)
}

/** Neutres de `styles.css`, par mode (aperçu d'un mode autre que celui affiché). */
export const BASE_NEUTRALS: Record<Scheme, Record<(typeof NEUTRAL_TOKENS)[number], string>> = {
  dark: {
    bg: '#0f1218', panel: '#161a22', 'panel-2': '#1c212b', sunk: '#0b0d12', line: '#272d3a', 'line-2': '#323949',
    fg: '#dde2ec', muted: '#a4abb9', faint: '#8a919f', 'accent-ink': '#0f1218',
  },
  light: {
    bg: '#eef1f6', panel: '#ffffff', 'panel-2': '#f3f5f9', sunk: '#f7f8fb', line: '#d9dee8', 'line-2': '#c9d0dc',
    fg: '#1a1f2c', muted: '#4b5262', faint: '#656c7a', 'accent-ink': '#ffffff',
  },
}

/**
 * Tous les jetons d'un mode (neutres et sémantiques), palette et couleurs
 * choisies comprises, avec leurs variantes texte calculées (`inkTokens`).
 */
export function schemeTokens(theme: Pick<ThemeSettings, Scheme>, scheme: Scheme): Record<string, string> {
  const tokens: Record<string, string> = { ...BASE_NEUTRALS[scheme], ...BASE[scheme], ...themeOverrides(theme, scheme) }
  tokens['accent-ink'] = accentInk(tokens.accent!, tokens['accent-ink'])
  return { ...tokens, ...inkTokens(tokens, scheme) }
}
