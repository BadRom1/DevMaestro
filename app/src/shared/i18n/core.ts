/**
 * Cœur des langues (v0.3, lot 20) : langue courante, choix de la langue,
 * interpolation, pluriels et formats `Intl` par langue. Sans dépendance,
 * partagé par la page et le processus principal ; les catalogues sont dans
 * `catalog/`, réunis par `index.ts`.
 */

export const LOCALES = ['fr', 'en'] as const
export type Locale = (typeof LOCALES)[number]

/** Choix de l'utilisateur (Réglages → Général → Langue). */
export const LANGUAGE_PREFS = ['system', 'fr', 'en'] as const
export type LanguagePref = (typeof LANGUAGE_PREFS)[number]
export const DEFAULT_LANGUAGE: LanguagePref = 'system'
/** Langue de repli : celle de l'app d'origine. */
export const FALLBACK_LOCALE: Locale = 'fr'

export function isLocale(v: unknown): v is Locale {
  return (LOCALES as readonly unknown[]).includes(v)
}

export function isLanguagePref(v: unknown): v is LanguagePref {
  return (LANGUAGE_PREFS as readonly unknown[]).includes(v)
}

/** Langue prise en charge d'une étiquette BCP 47 (« fr-CA », « en_US.UTF-8 »…), ou `null`. */
export function supportedLocale(tag: unknown): Locale | null {
  if (typeof tag !== 'string') return null
  const primary = tag.trim().toLowerCase().split(/[-_.@]/)[0]
  return isLocale(primary) ? primary : null
}

/**
 * Langue effective : le choix s'il est explicite ; sinon la première langue
 * du système prise en charge (dans l'ordre de préférence) ; sinon le français.
 */
export function resolveLocale(pref: unknown, systemLocales: readonly unknown[] | null | undefined): Locale {
  if (pref === 'fr' || pref === 'en') return pref
  for (const tag of Array.isArray(systemLocales) ? systemLocales : []) {
    const l = supportedLocale(tag)
    if (l) return l
  }
  return FALLBACK_LOCALE
}

/* ---------- Messages ---------- */

/** Message au pluriel : forme choisie par `Intl.PluralRules` selon `count`. */
export interface PluralMessage {
  one: string
  other: string
}
export type Message = string | PluralMessage
export type MessageTable = Record<string, Message>

/**
 * Déclare les messages d'un domaine : `en` doit avoir exactement les clés de
 * `fr` (vérifié par le compilateur ; les variables, par le test d'alignement).
 */
export function defineMessages<const F extends MessageTable>(m: { fr: F; en: { [K in keyof F]: Message } }): { fr: F; en: { [K in keyof F]: Message } } {
  return m
}

export type Vars = Readonly<Record<string, string | number | null | undefined>>

const pluralCache = new Map<Locale, Intl.PluralRules>()
function pluralRules(l: Locale): Intl.PluralRules {
  let r = pluralCache.get(l)
  if (!r) {
    r = new Intl.PluralRules(intlLocale(l))
    pluralCache.set(l, r)
  }
  return r
}

/** Forme d'un message selon `count` (absent : `other`). */
export function pluralForm(l: Locale, m: Message, count: unknown): string {
  if (typeof m === 'string') return m
  if (typeof count !== 'number' || !Number.isFinite(count)) return m.other
  return pluralRules(l).select(count) === 'one' ? m.one : m.other
}

const VAR_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g

/** Remplace `{nom}` ; une variable absente reste telle quelle. */
export function interpolate(text: string, vars?: Vars): string {
  if (!vars) return text
  return text.replace(VAR_RE, (all, name: string) => {
    const v = vars[name]
    return v === undefined || v === null ? all : String(v)
  })
}

/** Variables d'un texte, dans l'ordre (test d'alignement des catalogues, texte riche). */
export function variablesOf(m: Message): string[] {
  const texts = typeof m === 'string' ? [m] : [m.one, m.other]
  const out = new Set<string>()
  for (const t of texts) for (const x of t.matchAll(VAR_RE)) out.add(x[1]!)
  return [...out]
}

/** Découpe un texte sur ses variables (texte riche) : morceaux de texte et noms de variables. */
export function splitVariables(text: string): Array<{ text: string } | { name: string }> {
  const out: Array<{ text: string } | { name: string }> = []
  let last = 0
  for (const x of text.matchAll(VAR_RE)) {
    if (x.index! > last) out.push({ text: text.slice(last, x.index) })
    out.push({ name: x[1]! })
    last = x.index! + x[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out
}

/* ---------- Langue courante ---------- */

let current: Locale = FALLBACK_LOCALE

export function getLocale(): Locale {
  return current
}

/** Change la langue courante (fonctions pures, processus principal). */
export function setLocale(l: Locale): void {
  if (!isLocale(l) || l === current) return
  current = l
}

/* ---------- Formats ---------- */

/** Étiquette `Intl` d'une langue. */
export function intlLocale(l: Locale): string {
  return l === 'en' ? 'en-US' : 'fr-FR'
}

const intlCache = new Map<string, unknown>()
function cached<T>(kind: string, l: Locale, opts: object | undefined, make: () => T): T {
  const k = `${kind}|${l}|${opts ? JSON.stringify(opts) : ''}`
  let v = intlCache.get(k) as T | undefined
  if (v === undefined) {
    v = make()
    intlCache.set(k, v)
  }
  return v
}

export function numberFormat(opts?: Intl.NumberFormatOptions, l: Locale = current): Intl.NumberFormat {
  return cached('n', l, opts, () => new Intl.NumberFormat(intlLocale(l), opts))
}

export function dateFormat(opts?: Intl.DateTimeFormatOptions, l: Locale = current): Intl.DateTimeFormat {
  return cached('d', l, opts, () => new Intl.DateTimeFormat(intlLocale(l), opts))
}

/** Tri « naturel » des noms (chemins, branches) selon la langue. */
export function collator(l: Locale = current): Intl.Collator {
  return cached('c', l, undefined, () => new Intl.Collator(l, { numeric: true, sensitivity: 'base' }))
}

/** Liste « a, b et c » / « a, b, and c ». */
export function formatList(items: readonly string[], l: Locale = current): string {
  return cached('l', l, undefined, () => new Intl.ListFormat(intlLocale(l), { style: 'long', type: 'conjunction' })).format(items)
}
