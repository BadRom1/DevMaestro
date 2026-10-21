/**
 * Livraison pilotée par Claude (v0.3, lot 14b) : modèles de consigne
 * (« Ouvrir une demande de fusion », « Fusionner dans <branche par
 * défaut> »), leurs variables et leur validation. Calculs purs, partagés par
 * les réglages (processus principal) et la page.
 *
 * La consigne est **tapée** dans la session (`sessions.sendPrompt {text}`) :
 * elle a l'autorité d'un prompt de l'utilisateur. Elle ne contient donc que
 * ce que l'utilisateur a écrit (le modèle) et des valeurs locales sûres : le
 * nom de la branche, celui de la branche par défaut et le **numéro** de
 * l'issue liée. Jamais le titre ni le corps d'une issue : ce sont des
 * contenus de la forge, non fiables (ADR 0006).
 */

import type { DeliveryMode } from './protocol'

/**
 * Une consigne tapée tient sur une ligne de moins de 2 000 caractères : à
 * partir de 2 000, le démon la collerait au lieu de la taper.
 */
export const MAX_DELIVERY_PROMPT = 1999
/** Un modèle, avant remplacement des variables. */
export const MAX_DELIVERY_TEMPLATE = 1500

/** Variables d'un modèle : `{branche}`, `{base}`, `{issue}` (« #42 », ou « aucune »). */
export const DELIVERY_VARIABLES = ['branche', 'base', 'issue'] as const
export type DeliveryVariable = (typeof DELIVERY_VARIABLES)[number]

export const DEFAULT_PR_TEMPLATE =
  'Livre ce travail : lance les tests, commite ce qui reste, pousse la branche {branche} puis ouvre une demande de fusion vers {base} avec « gh pr create » (titre et description clairs ; issue liée : {issue}).'

export const DEFAULT_MERGE_TEMPLATE =
  'Livre ce travail en trunk-based : lance les tests, commite ce qui reste, intègre {branche} dans {base} si ce n’est pas déjà la même branche, puis pousse {base} (issue liée : {issue}).'

/** Ce que fait chaque bouton de livraison. */
export type DeliveryAction = 'pr' | 'merge'

/** Bouton principal selon le mode du projet. */
export function primaryAction(mode: DeliveryMode): DeliveryAction {
  return mode === 'trunk' ? 'merge' : 'pr'
}

/** Libellé d'un bouton de livraison. */
export function actionLabel(action: DeliveryAction, base: string | null): string {
  return action === 'pr' ? 'Ouvrir une demande de fusion' : `Fusionner dans ${base ?? 'la branche par défaut'}`
}

const CONTROL_OR_INVISIBLE = /[\p{Cc}\p{Cf}\u2028\u2029]/u

/** Problème d'un modèle (message en français), ou `null`. */
export function templateProblem(t: unknown): string | null {
  if (typeof t !== 'string') return 'le modèle doit être un texte'
  if (t.trim() === '') return 'le modèle est vide'
  if ([...t].length > MAX_DELIVERY_TEMPLATE) return `le modèle est trop long (${MAX_DELIVERY_TEMPLATE} caractères au plus)`
  if (CONTROL_OR_INVISIBLE.test(t)) return 'le modèle doit tenir sur une ligne, sans caractère de contrôle ni invisible'
  // Un « \ » final ferait passer la TUI à la ligne au lieu d'envoyer (le démon collerait la consigne).
  if (t.trimEnd().endsWith('\\')) return 'le modèle ne doit pas finir par « \\ »'
  for (const m of t.matchAll(/\{([^{}]*)\}?/g)) {
    const name = m[1] ?? ''
    if (!m[0].endsWith('}')) return 'accolade « { » sans « } » : écris une variable {branche}, {base} ou {issue}'
    if (!(DELIVERY_VARIABLES as readonly string[]).includes(name)) {
      return `variable inconnue : {${name}} (variables : {branche}, {base}, {issue})`
    }
  }
  if (t.includes('}') && t.replace(/\{(branche|base|issue)\}/g, '').includes('}')) return 'accolade « } » isolée'
  return null
}

/**
 * Nom de branche rendu sûr pour une consigne tapée : seulement lettres,
 * chiffres et `. _ / + -` (une branche peut venir d'une fourche, son nom
 * choisi par un tiers ne doit pas pouvoir écrire une phrase), 100 caractères au plus.
 */
function safeValue(v: string, max = 100): string {
  return [...v.replace(/[^\p{L}\p{N}._/+-]/gu, '')].slice(0, max).join('')
}

export interface DeliveryVars {
  branch: string | null
  base: string | null
  /** Numéro de l'issue liée (jamais son titre). */
  issue: number | null
}

/**
 * Consigne tapée : le modèle, ses variables remplacées. Lève une erreur si
 * le modèle est invalide ou si la consigne dépasserait `MAX_DELIVERY_PROMPT`
 * caractères (elle ne serait plus tapée) : jamais coupée en silence.
 */
export function renderDeliveryPrompt(template: string, vars: DeliveryVars): string {
  const problem = templateProblem(template)
  if (problem) throw new Error(problem)
  const values: Record<DeliveryVariable, string> = {
    branche: vars.branch ? safeValue(vars.branch) : 'la branche courante',
    base: vars.base ? safeValue(vars.base) : 'la branche par défaut',
    issue: vars.issue && Number.isSafeInteger(vars.issue) && vars.issue > 0 ? `#${vars.issue}` : 'aucune',
  }
  const out = template.replace(/\{(branche|base|issue)\}/g, (_, k: DeliveryVariable) => values[k]).replace(/\s+/g, ' ').trim()
  const n = [...out].length
  if (n > MAX_DELIVERY_PROMPT) throw new Error(`consigne trop longue (${n} caractères, ${MAX_DELIVERY_PROMPT} au plus pour être tapée) : raccourcis le modèle`)
  return out
}
