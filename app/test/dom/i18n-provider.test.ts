// @vitest-environment jsdom
/**
 * Lot 20 : fournisseur de langue. Changement à chaud (un rendu en anglais
 * puis en français, sans remonter l'arbre), `lang` du document, texte
 * riche, fonctions pures suivies au même rendu, langue tirée des réglages
 * (« Système » : langue du système, français en repli).
 */
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { setLocale } from '../../src/shared/i18n'
import { ErrorCode } from '../../src/shared/protocol'
import { defaultSettings, type AppSettings } from '../../src/shared/settings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type I18nMod = typeof import('../../src/renderer/src/i18n')
let I18nProvider: I18nMod['I18nProvider']
let SettingsI18nProvider: I18nMod['SettingsI18nProvider']
let useI18n: I18nMod['useI18n']
let SettingsProvider: typeof import('../../src/renderer/src/settings')['SettingsProvider']
let describeError: typeof import('../../src/renderer/src/state/errors')['describeError']
let relativeTime: typeof import('../../src/renderer/src/state/format')['relativeTime']

beforeAll(async () => {
  ;(window as unknown as { devmaestro: object }).devmaestro = { updateSettings: async () => ({ ok: true, settings: defaultSettings() }) }
  ;({ I18nProvider, SettingsI18nProvider, useI18n } = await import('../../src/renderer/src/i18n'))
  ;({ SettingsProvider } = await import('../../src/renderer/src/settings'))
  ;({ describeError } = await import('../../src/renderer/src/state/errors'))
  ;({ relativeTime } = await import('../../src/renderer/src/state/format'))
})

let root: Root | null = null
let host: HTMLDivElement | null = null

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  setLocale('fr')
})

function mount(node: React.ReactNode): HTMLDivElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(node))
  return host
}

const NOW = Date.parse('2026-10-21T12:00:00Z')

/** Écran témoin : statut (clé), durée relative (fonction pure), erreur du démon, texte riche, et un état local. */
function Probe() {
  const { t, rich, locale } = useI18n()
  const [clicks, setClicks] = useState(0)
  return createElement(
    'div',
    null,
    createElement('p', { 'data-k': 'status' }, t('common.status.idle')),
    createElement('p', { 'data-k': 'ago' }, relativeTime('2026-10-21T11:55:00Z', NOW)),
    createElement('p', { 'data-k': 'err' }, describeError(ErrorCode.WorktreeBusy, '')),
    createElement('p', { 'data-k': 'rich' }, rich('format.resume.cwdLong', { cwd: createElement('code', null, '/tmp/w') })),
    createElement('button', { 'data-k': 'btn', onClick: () => setClicks((n) => n + 1) }, `${locale}:${clicks}`),
  )
}

const text = (h: HTMLElement, k: string) => h.querySelector(`[data-k="${k}"]`)!.textContent

describe('fournisseur de langue', () => {
  it('rendu en anglais puis en français à chaud, état local gardé, lang du document suivi', () => {
    const h = mount(createElement(I18nProvider, { locale: 'en', children: createElement(Probe) }))
    expect(text(h, 'status')).toBe('Idle')
    expect(text(h, 'ago')).toBe('5 min ago')
    expect(text(h, 'err')).toBe('a session is running in this worktree: stop it first')
    expect(text(h, 'rich')).toBe('The session folder no longer exists (worktree deleted?): /tmp/w. It cannot be resumed.')
    expect(h.querySelector('[data-k="rich"] code')?.textContent).toBe('/tmp/w')
    expect(document.documentElement.lang).toBe('en')
    act(() => (h.querySelector('[data-k="btn"]') as HTMLButtonElement).click())
    expect(text(h, 'btn')).toBe('en:1')

    act(() => root!.render(createElement(I18nProvider, { locale: 'fr', children: createElement(Probe) })))
    expect(text(h, 'status')).toBe('Inactive')
    expect(text(h, 'ago')).toBe('il y a 5 min')
    expect(text(h, 'err')).toBe('une session tourne dans ce worktree : arrête-la d’abord')
    expect(text(h, 'rich')).toBe('Le dossier de la session n’existe plus (worktree supprimé ?) : /tmp/w. Elle ne peut pas être reprise.')
    expect(document.documentElement.lang).toBe('fr')
    // Même composant, pas remonté : son état est gardé.
    expect(text(h, 'btn')).toBe('fr:1')
  })

  it('sans fournisseur : français', () => {
    const h = mount(createElement(Probe))
    expect(text(h, 'status')).toBe('Inactive')
  })

  it('langue tirée des réglages : « Système » suit le système, français en repli, choix explicite prioritaire', () => {
    const withLang = (language: AppSettings['ui']['language'], systemLocales: string[]) =>
      createElement(
        SettingsProvider,
        {
          initial: { ...defaultSettings(), ui: { ...defaultSettings().ui, language } },
          children: createElement(SettingsI18nProvider, { systemLocales, children: createElement(Probe) }),
        },
      )
    const h = mount(withLang('system', ['en-GB', 'fr-FR']))
    expect(text(h, 'status')).toBe('Idle')
    act(() => root!.unmount())
    root = createRoot(h)
    act(() => root!.render(withLang('system', ['de-DE'])))
    expect(text(h, 'status')).toBe('Inactive')
    act(() => root!.unmount())
    root = createRoot(h)
    act(() => root!.render(withLang('en', ['fr-FR'])))
    expect(text(h, 'status')).toBe('Idle')
  })

  it('réponse tardive du processus principal : appliquée à son arrivée, langue comprise', async () => {
    let resolve!: (s: AppSettings) => void
    const late = new Promise<AppSettings | null>((ok) => (resolve = ok))
    const h = mount(
      createElement(SettingsProvider, {
        initial: defaultSettings(),
        late,
        children: createElement(SettingsI18nProvider, { systemLocales: [], children: createElement(Probe) }),
      }),
    )
    expect(text(h, 'status')).toBe('Inactive')
    await act(async () => {
      resolve({ ...defaultSettings(), ui: { ...defaultSettings().ui, language: 'en' } })
      await late
    })
    expect(text(h, 'status')).toBe('Idle')
  })
})
