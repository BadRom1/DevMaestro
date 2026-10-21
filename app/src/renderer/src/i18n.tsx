/**
 * Langue de la page (v0.3, lot 20) : fournisseur React et `useT()`.
 *
 * Le fournisseur fixe la langue courante globale **pendant son rendu**, avant
 * celui des enfants : les fonctions pures (`state/*.ts`) appelées au rendu
 * traduisent donc déjà dans la nouvelle langue. Sans fournisseur (composants
 * rendus seuls dans les tests), `useT()` suit la langue globale : le
 * français, sauf si un test l'a changée.
 */
import { Fragment, createContext, useContext, useEffect, useMemo, type ReactNode } from 'react'

import {
  getLocale,
  pluralForm,
  rawMessage,
  resolveLocale,
  setLocale,
  splitVariables,
  translate,
  type LanguagePref,
  type Locale,
  type MessageKey,
  type MessageVars,
  type Translate,
  type Vars,
} from '../../shared/i18n'
import { useOptionalSettings } from './settings'

export interface I18n {
  locale: Locale
  /** Texte d'une clé (pluriel par `count`, variables `{nom}`). */
  t: Translate
  /** Texte riche : les variables peuvent être des nœuds React (lien, `<code>`…). */
  rich: <K extends MessageKey>(key: K, vars: { readonly [P in MessageVars<K>]: ReactNode }) => ReactNode
}

/** Texte riche d'une clé dans une langue donnée. */
export function richText(locale: Locale, key: MessageKey, vars: Readonly<Record<string, ReactNode>>): ReactNode {
  const count = vars.count
  const text = pluralForm(locale, rawMessage(locale, key), typeof count === 'number' ? count : undefined)
  return splitVariables(text).map((part, i) =>
    'text' in part ? (
      <Fragment key={i}>{part.text}</Fragment>
    ) : (
      <Fragment key={i}>{part.name in vars ? vars[part.name] : `{${part.name}}`}</Fragment>
    ),
  )
}

function make(locale: Locale): I18n {
  return {
    locale,
    t: (key, ...args) => translate(locale, key, ...args),
    rich: (key, vars) => richText(locale, key, vars),
  }
}

const Ctx = createContext<I18n | null>(null)

export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  // Pendant le rendu, avant les enfants : les fonctions pures suivent tout de suite.
  if (getLocale() !== locale) setLocale(locale)
  useEffect(() => {
    setLocale(locale)
    document.documentElement.lang = locale
  }, [locale])
  const value = useMemo(() => make(locale), [locale])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

/**
 * Langue tirée des réglages (`ui.language`) et des langues du système
 * transmises par le processus principal au démarrage.
 */
export function SettingsI18nProvider({ systemLocales, children }: { systemLocales: readonly string[] | null | undefined; children: ReactNode }) {
  const pref: LanguagePref | undefined = useOptionalSettings()?.settings.ui.language
  return <I18nProvider locale={resolveLocale(pref, systemLocales)}>{children}</I18nProvider>
}

/** Textes dans la langue de l'interface. */
export function useI18n(): I18n {
  const v = useContext(Ctx)
  return v ?? make(getLocale())
}

export function useT(): I18n['t'] {
  return useI18n().t
}
