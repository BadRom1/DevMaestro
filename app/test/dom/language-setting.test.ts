// @vitest-environment jsdom
/**
 * Réglages → Général → Langue (lot 20) : trois choix (Système, Français,
 * English, noms des langues dans leur propre langue) ; le choix est envoyé
 * tout de suite au processus principal.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { setLocale } from '../../src/shared/i18n'
import { defaultSettings, type AppSettings, type SettingsPatch } from '../../src/shared/settings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const updateSettings = vi.fn(async (_p: SettingsPatch) => ({ ok: false as const, error: { code: -1, message: 'test' } }))

type SettingsMod = typeof import('../../src/renderer/src/settings')
let SettingsProvider: SettingsMod['SettingsProvider']
let useSettings: SettingsMod['useSettings']
let I18nProvider: typeof import('../../src/renderer/src/i18n')['I18nProvider']
let SettingsI18nProvider: typeof import('../../src/renderer/src/i18n')['SettingsI18nProvider']
let SettingsDialog: typeof import('../../src/renderer/src/components/SettingsDialog')['SettingsDialog']

beforeAll(async () => {
  ;(window as unknown as { devmaestro: object }).devmaestro = {
    updateSettings,
    onZoomChanged: () => () => undefined,
    copyText: async () => true,
  }
  ;({ SettingsProvider, useSettings } = await import('../../src/renderer/src/settings'))
  ;({ I18nProvider, SettingsI18nProvider } = await import('../../src/renderer/src/i18n'))
  ;({ SettingsDialog } = await import('../../src/renderer/src/components/SettingsDialog'))
})

let root: Root | null = null
let host: HTMLElement | null = null
let latest: AppSettings | null = null

beforeEach(() => {
  updateSettings.mockClear()
  latest = null
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
  setLocale('fr')
})

function Spy() {
  latest = useSettings().settings
  return null
}

function render(locale: 'fr' | 'en' = 'fr') {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const dialog = createElement(SettingsDialog, { profiles: [], projects: [], home: null, scheme: 'dark', onClose: () => undefined })
  act(() =>
    root!.render(
      createElement(SettingsProvider, {
        initial: defaultSettings(),
        children: [createElement(Spy, { key: 's' }), createElement(I18nProvider, { key: 'd', locale, children: dialog })],
      }),
    ),
  )
}

describe('réglages : langue', () => {
  it('« Langue » dans Général : Système, Français, English ; « English » envoie ui.language = en', () => {
    render()
    act(() => [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent === 'Général')!.click())
    const select = document.querySelector<HTMLSelectElement>('#st-language')!
    expect(document.querySelector('label[for="st-language"]')!.textContent).toBe('Langue')
    expect([...select.options].map((o) => [o.value, o.textContent])).toEqual([
      ['system', 'Système'],
      ['fr', 'Français'],
      ['en', 'English'],
    ])
    expect(select.value).toBe('system')
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, 'en')
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(updateSettings).toHaveBeenCalledWith({ ui: { language: 'en' } })
    expect(latest!.ui.language).toBe('en')
  })

  it('interface en anglais : Réglages traduits, noms des langues inchangés', () => {
    render('en')
    act(() => [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent === 'General')!.click())
    expect(document.querySelector('label[for="st-language"]')!.textContent).toBe('Language')
    expect([...document.querySelector<HTMLSelectElement>('#st-language')!.options].map((o) => o.textContent)).toEqual(['System', 'Français', 'English'])
    act(() => [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent === 'Instructions')!.click())
    expect(document.body.textContent).toContain('Instructions sent to Claude')
    expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Instruction “Issue”"]')!.value).toMatch(/^Work on issue \{issue\}/)
  })

  it('à chaud, de bout en bout : « English » puis « Français » retraduisent la fenêtre ouverte, sans la remonter', () => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    const dialog = createElement(SettingsDialog, { profiles: [], projects: [], home: null, scheme: 'dark', onClose: () => undefined })
    act(() =>
      root!.render(
        createElement(SettingsProvider, {
          initial: defaultSettings(),
          children: createElement(SettingsI18nProvider, { systemLocales: ['de-DE'], children: dialog }),
        }),
      ),
    )
    act(() => [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent === 'Général')!.click())
    const select = document.querySelector<HTMLSelectElement>('#st-language')!
    const choose = (v: string) =>
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, v)
        select.dispatchEvent(new Event('change', { bubbles: true }))
      })
    // « Système » sur un système allemand : français en repli.
    expect(document.documentElement.lang).toBe('fr')
    choose('en')
    expect(document.querySelector('label[for="st-language"]')!.textContent).toBe('Language')
    expect(document.documentElement.lang).toBe('en')
    // Même élément : l'onglet ouvert (Général) est gardé.
    expect(document.querySelector('#st-language')).toBe(select)
    choose('fr')
    expect(document.querySelector('label[for="st-language"]')!.textContent).toBe('Langue')
    expect(document.documentElement.lang).toBe('fr')
  })
})
