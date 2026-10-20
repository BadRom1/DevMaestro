// @vitest-environment jsdom
/**
 * Réglages (lot 8) rendus avec React : taille changée par le processus
 * principal reprise sans renvoi, « Taille du texte » envoyée tout de suite,
 * « Importer un thème (JSON) » (erreur précise, aperçu, « Appliquer »), et le
 * dialogue garde Échap.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { defaultSettings, type AppSettings, type SettingsPatch } from '../../src/shared/settings'
import { themeJson } from '../../src/renderer/src/state/themeTokens'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let zoomListener: ((zoom: number) => void) | null = null
const updateSettings = vi.fn(async (_p: SettingsPatch) => ({ ok: false as const, error: { code: -1, message: 'test' } }))

type SettingsMod = typeof import('../../src/renderer/src/settings')
let SettingsProvider: SettingsMod['SettingsProvider']
let useSettings: SettingsMod['useSettings']
let SettingsDialog: typeof import('../../src/renderer/src/components/SettingsDialog')['SettingsDialog']

beforeAll(async () => {
  ;(window as unknown as { devmaestro: object }).devmaestro = {
    updateSettings,
    onZoomChanged: (cb: (zoom: number) => void) => {
      zoomListener = cb
      return () => {
        zoomListener = null
      }
    },
    copyText: async () => true,
  }
  ;({ SettingsProvider, useSettings } = await import('../../src/renderer/src/settings'))
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
})

function Spy() {
  latest = useSettings().settings
  return null
}

function render(onClose = () => undefined) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const dialog = createElement(SettingsDialog, { profiles: [], projects: [], home: null, scheme: 'dark', onClose })
  act(() =>
    root!.render(createElement(SettingsProvider, { initial: defaultSettings(), children: [createElement(Spy, { key: 's' }), createElement('div', { key: 'd' }, dialog)] })),
  )
}

function setValue(el: HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLSelectElement.prototype
  act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}

const button = (label: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === label)!

describe('réglages : taille du texte', () => {
  it('taille changée par le processus principal : reprise localement, sans modification renvoyée', () => {
    render()
    expect(zoomListener).not.toBeNull()
    act(() => zoomListener!(150))
    expect(latest!.ui.zoom).toBe(150)
    expect(document.querySelector<HTMLSelectElement>('#st-zoom')!.value).toBe('150')
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('« Taille du texte » : envoyée tout de suite (le processus principal applique le zoom)', () => {
    render()
    setValue(document.querySelector<HTMLSelectElement>('#st-zoom')!, '125')
    expect(latest!.ui.zoom).toBe(125)
    expect(updateSettings).toHaveBeenCalledWith({ ui: { zoom: 125 } })
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="Texte plus grand"]')!.click())
    expect(latest!.ui.zoom).toBe(150)
  })
})

describe('réglages : importer un thème (JSON)', () => {
  it('erreur précise, puis aperçu et « Appliquer »', () => {
    render()
    act(() => button('Importer un thème (JSON)').click())
    const area = document.querySelector<HTMLTextAreaElement>('.import-box textarea')!
    expect(document.activeElement).toBe(area)
    expect(button('Appliquer').disabled).toBe(true)

    setValue(area, '{"palette":"violet"}')
    expect(document.querySelector('.import-box [role="status"]')!.textContent).toMatch(/Thème refusé : « palette » inconnue/)
    expect(area.getAttribute('aria-invalid')).toBe('true')
    expect(button('Appliquer').disabled).toBe(true)

    const theme = { mode: 'light', light: { palette: 'okabe', custom: { wait: '#123456' } }, dark: { palette: 'contraste', custom: {} } }
    setValue(area, JSON.stringify(theme))
    expect(document.querySelectorAll('.import-box .preview')).toHaveLength(2)
    expect(button('Appliquer').disabled).toBe(false)
    act(() => button('Appliquer').click())
    expect(latest!.theme).toEqual(theme)
    expect(document.querySelector('.import-box')).toBeNull()
    expect(document.activeElement).toBe(button('Importer un thème (JSON)'))
  })

  it('ancien format accepté ; mode absent : le mode actuel est gardé', () => {
    render()
    act(() => button('Importer un thème (JSON)').click())
    setValue(document.querySelector<HTMLTextAreaElement>('.import-box textarea')!, '{"palette":"okabe"}')
    act(() => button('Appliquer').click())
    expect(latest!.theme).toEqual({ mode: 'system', light: { palette: 'okabe', custom: {} }, dark: { palette: 'okabe', custom: {} } })
  })
})

describe('réglages : dialogue', () => {
  it('Échap ferme toujours ; la croix est dans l’en-tête, hors du corps qui défile', () => {
    const onClose = vi.fn()
    render(onClose)
    const modal = document.querySelector('.modal')!
    const x = modal.querySelector('.mh [aria-label="Fermer"]')
    expect(x).not.toBeNull()
    expect(modal.querySelector('.mb')!.contains(x)).toBe(false)
    expect(modal.querySelector('.mb')!.contains(modal.querySelector('[role="tablist"]'))).toBe(false)
    act(() => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Échap dans l’import ferme d’abord le panneau, sans fermer les Réglages ni perdre le JSON sans confirmation', () => {
    const onClose = vi.fn()
    render(onClose)
    const esc = () =>
      act(() => {
        document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      })
    act(() => button('Importer un thème (JSON)').click())
    setValue(document.querySelector<HTMLTextAreaElement>('.import-box textarea')!, '{"palette":')
    esc()
    // Texte saisi : confirmation, panneau et texte gardés.
    expect(document.querySelector('.import-box .forget')).not.toBeNull()
    expect(document.querySelector<HTMLTextAreaElement>('.import-box textarea')!.value).toBe('{"palette":')
    esc()
    expect(document.querySelector('.import-box .forget')).toBeNull()
    expect(document.querySelector('.import-box')).not.toBeNull()
    // Texte vidé : Échap ferme le panneau seul.
    setValue(document.querySelector<HTMLTextAreaElement>('.import-box textarea')!, '')
    document.querySelector<HTMLTextAreaElement>('.import-box textarea')!.focus()
    esc()
    expect(document.querySelector('.import-box')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    // Hors du panneau, Échap ferme les Réglages.
    esc()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('« Abandonner » dans la confirmation ferme le panneau', async () => {
    render()
    act(() => button('Importer un thème (JSON)').click())
    setValue(document.querySelector<HTMLTextAreaElement>('.import-box textarea')!, 'x')
    act(() => [...document.querySelectorAll<HTMLButtonElement>('.import-box button')].find((b) => b.textContent === 'Annuler')!.click())
    expect(document.querySelector('.import-box')).not.toBeNull()
    await act(async () => button('Abandonner').click())
    expect(document.querySelector('.import-box')).toBeNull()
  })

  /**
   * Bug du 2026-10-20 (écran blanc définitif) : Chromium récent fait renvoyer
   * une promesse à `scrollIntoView` ; l'effet du panneau d'import la renvoyait
   * telle quelle (corps d'expression), React la prenait pour la fonction de
   * nettoyage et levait « destroy_ is not a function » en fermant le panneau
   * (« Appliquer ») : toute l'interface était démontée.
   */
  describe('« Appliquer » le thème copié (scrollIntoView qui renvoie une promesse, comme Chromium)', () => {
    const original = Element.prototype.scrollIntoView
    beforeEach(() => {
      Element.prototype.scrollIntoView = function () {
        return Promise.resolve() as unknown as void
      }
    })
    afterEach(() => {
      Element.prototype.scrollIntoView = original
    })

    const userSettings = (): AppSettings => ({
      ...defaultSettings(),
      theme: { mode: 'light', light: { palette: 'devmaestro', custom: {} }, dark: { palette: 'okabe', custom: {} } },
    })

    function renderWith(initial: AppSettings) {
      host = document.createElement('div')
      document.body.append(host)
      root = createRoot(host)
      const dialog = createElement(SettingsDialog, { profiles: [], projects: [], home: null, scheme: 'light', onClose: () => undefined })
      act(() =>
        root!.render(createElement(SettingsProvider, { initial, children: [createElement(Spy, { key: 's' }), createElement('div', { key: 'd' }, dialog)] })),
      )
    }

    it.each([
      ['identique au thème actuel', (t: AppSettings['theme']) => t],
      ['différent du thème actuel', (t: AppSettings['theme']) => ({ ...t, mode: 'dark' as const, light: { palette: 'okabe' as const, custom: {} } })],
    ])('JSON %s : pas d’exception, le dialogue reste affiché', (_name, change) => {
      const initial = userSettings()
      const errors: unknown[] = []
      const onError = (e: ErrorEvent) => errors.push(e.error)
      window.addEventListener('error', onError)
      try {
        renderWith(initial)
        act(() => button('Copier le thème (JSON)').click())
        act(() => button('Importer un thème (JSON)').click())
        const target = change(initial.theme)
        setValue(document.querySelector<HTMLTextAreaElement>('.import-box textarea')!, themeJson(target))
        expect(document.querySelectorAll('.import-box .preview')).toHaveLength(2)
        // L'aperçu est rendu, et le panneau se ferme dans le même geste.
        act(() => button('Appliquer').click())
        expect(errors).toEqual([])
        expect(document.querySelector('.modal')).not.toBeNull()
        expect(document.querySelector('.import-box')).toBeNull()
        expect(latest!.theme).toEqual(target)
      } finally {
        window.removeEventListener('error', onError)
      }
    })
  })
})
