/**
 * Langues de l'interface (v0.3, lot 20) : catalogues réunis, clés typées et
 * `t()` dans la langue courante. Voir `core.ts` et le contrat du lot 20
 * (`docs/v0.3.md`).
 */
import { common } from './catalog/common'
import { conversation } from './catalog/conversation'
import { errors } from './catalog/errors'
import { files } from './catalog/files'
import { forge } from './catalog/forge'
import { format } from './catalog/format'
import { main } from './catalog/main'
import { plugins } from './catalog/plugins'
import { prompts } from './catalog/prompts'
import { sessions } from './catalog/sessions'
import { settings } from './catalog/settings'
import { shell } from './catalog/shell'
import { getLocale, interpolate, pluralForm, type Locale, type Message, type Vars } from './core'

export * from './core'

/** Domaines, chacun dans son fichier : ses clés commencent par `<domaine>.`. */
export const NAMESPACES = { common, conversation, errors, files, forge, format, main, plugins, prompts, sessions, settings, shell } as const

const FR = {
  ...common.fr,
  ...conversation.fr,
  ...errors.fr,
  ...files.fr,
  ...forge.fr,
  ...format.fr,
  ...main.fr,
  ...plugins.fr,
  ...prompts.fr,
  ...sessions.fr,
  ...settings.fr,
  ...shell.fr,
}

export type MessageKey = keyof typeof FR & string

/* ---------- Variables typées par clé ---------- */

/** Noms `{nom}` d'un texte littéral (un `{ a, b }` avec espaces n'est pas une variable). */
type VarNames<S> = S extends `${string}{${infer V}}${infer R}`
  ? (V extends `${string}${' ' | ',' | '{'}${string}` | '' ? never : V) | VarNames<R>
  : never

type MessageVarNames<M> = M extends string ? VarNames<M> : M extends { one: infer A; other: infer B } ? VarNames<A> | VarNames<B> | 'count' : never

/** Variables attendues par une clé (celles du texte français, la référence ; l'anglais a les mêmes, test d'alignement). */
export type MessageVars<K extends MessageKey> = MessageVarNames<(typeof FR)[K]>

type VarValue = string | number | null | undefined

/** Clés sans variable (tables de libellés indexées dynamiquement). */
export type PlainKey = { [K in MessageKey]: [MessageVars<K>] extends [never] ? K : never }[MessageKey]

/** Clés dont les variables sont exactement `V`. */
export type KeyWith<V extends string> = {
  [K in MessageKey]: [MessageVars<K>] extends [V] ? ([V] extends [MessageVars<K>] ? K : never) : never
}[MessageKey]

/**
 * Arguments de `t()` pour une clé : aucun si le texte n'a pas de variable,
 * sinon exactement ses variables (une variable manquante ou en trop est une
 * erreur de compilation).
 */
export type VarsArg<K extends MessageKey> = [MessageVars<K>] extends [never] ? [] : [vars: { readonly [P in MessageVars<K>]: VarValue }]

const EN: Record<MessageKey, Message> = {
  ...common.en,
  ...conversation.en,
  ...errors.en,
  ...files.en,
  ...forge.en,
  ...format.en,
  ...main.en,
  ...plugins.en,
  ...prompts.en,
  ...sessions.en,
  ...settings.en,
  ...shell.en,
}

export const CATALOGS: Record<Locale, Record<MessageKey, Message>> = { fr: FR, en: EN }

export function isMessageKey(k: unknown): k is MessageKey {
  return typeof k === 'string' && Object.prototype.hasOwnProperty.call(FR, k)
}

/** Message brut (avant pluriel et interpolation) ; repli sur le français. */
export function rawMessage(locale: Locale, key: MessageKey): Message {
  return CATALOGS[locale][key] ?? FR[key] ?? key
}

/** Texte d'une clé dans une langue donnée ; `count` choisit la forme d'un pluriel. */
export function translate<K extends MessageKey>(locale: Locale, key: K, ...args: VarsArg<K>): string {
  const vars = args[0] as Vars | undefined
  return interpolate(pluralForm(locale, rawMessage(locale, key), vars?.count), vars)
}

/** Texte d'une clé dans la langue courante. */
export function t<K extends MessageKey>(key: K, ...args: VarsArg<K>): string {
  return translate(getLocale(), key, ...args)
}

export type Translate = <K extends MessageKey>(key: K, ...args: VarsArg<K>) => string
