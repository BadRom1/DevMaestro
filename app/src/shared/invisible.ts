/**
 * Caractères invisibles (lot 18) : **même liste** que `invisible()` du démon
 * (`crates/core/src/domain/forge.rs`) ; un test compare les deux. Contrôles
 * bidirectionnels, espaces et jointures de largeur nulle, séparateurs de
 * ligne et de paragraphe Unicode, opérateurs invisibles, BOM, « tags »
 * Unicode et sélecteurs de variante : de quoi cacher du texte à
 * l'utilisateur. Retirés d'un texte de la forge, refusés dans une consigne.
 */

/** Plages (bornes comprises) de points de code invisibles. */
export const INVISIBLE_RANGES: readonly (readonly [number, number])[] = [
  [0x00ad, 0x00ad],
  [0x061c, 0x061c],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x206f],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xe0000, 0xe007f],
  [0xe0100, 0xe01ef],
]

const hex = (n: number) => `\\u{${n.toString(16)}}`

/** Classe d'expression régulière (`[…]`, drapeau `u`) des caractères invisibles. */
export const INVISIBLE_CLASS = `[${INVISIBLE_RANGES.map(([a, b]) => (a === b ? hex(a) : `${hex(a)}-${hex(b)}`)).join('')}]`

export function isInvisible(c: string): boolean {
  const cp = c.codePointAt(0)
  return cp !== undefined && INVISIBLE_RANGES.some(([a, b]) => cp >= a && cp <= b)
}
