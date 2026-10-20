/**
 * Titre de session saisi dans l'app, nettoyé avant `sessions.update` comme le
 * démon le fera (blancs de bord retirés, caractères de contrôle refusés,
 * 80 caractères au plus, comptés en points de code), et un peu plus :
 * - les contrôles bidirectionnels (U+202A–U+202E, U+2066–U+2069, U+200E,
 *   U+200F, U+061C) sont retirés : ils pourraient retourner l'affichage ;
 * - un titre fait seulement de caractères invisibles ou de format vaut
 *   « pas de titre » (`null`).
 */
import { MAX_TITLE } from '../../../shared/protocol'

const BIDI = /[‪-‮⁦-⁩‎‏؜]/gu
const CONTROL = /\p{Cc}/u
/** Format (Cf), séparateurs et blancs : rien de visible. */
const INVISIBLE_ONLY = /^[\p{Cf}\p{Z}\sᅟᅠㅤﾠ]*$/u

export type TitleInput = { ok: true; title: string | null } | { ok: false; error: string }

export function titleLength(s: string): number {
  return [...s].length
}

/** Coupe une saisie à `MAX_TITLE` points de code (sans couper une paire de substitution). */
export function clampTitle(s: string): string {
  const chars = [...s]
  return chars.length > MAX_TITLE ? chars.slice(0, MAX_TITLE).join('') : s
}

export function normalizeTitleInput(raw: string): TitleInput {
  const t = raw.replace(BIDI, '').trim()
  if (CONTROL.test(t)) {
    return { ok: false, error: 'le titre ne doit pas contenir de caractère de contrôle (saut de ligne, tabulation…)' }
  }
  if (INVISIBLE_ONLY.test(t)) return { ok: true, title: null }
  const n = titleLength(t)
  if (n > MAX_TITLE) return { ok: false, error: `titre trop long : ${n} caractères, ${MAX_TITLE} au plus` }
  return { ok: true, title: t }
}
