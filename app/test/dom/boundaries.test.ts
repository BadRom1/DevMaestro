// @vitest-environment jsdom
/**
 * Garde-fous d'affichage (après l'écran blanc du 2026-10-20) : une erreur
 * dans le contenu d'un dialogue reste dans le dialogue (en-tête et × gardés),
 * une erreur ailleurs affiche « Une erreur d'affichage est survenue » avec un
 * bouton « Recharger l'interface » ; chaque erreur part au journal du
 * processus principal (`logError`), texte borné.
 */
import { act, createElement, useEffect, useState, type EffectCallback } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const logError = vi.fn()
const updateSettings = vi.fn(async () => ({ ok: true }))

let Modal: typeof import('../../src/renderer/src/components/Modal')['Modal']
let AppBoundary: typeof import('../../src/renderer/src/components/AppBoundary')['AppBoundary']
let benignError: typeof import('../../src/renderer/src/errorReport')['benignError']
let errorReportText: typeof import('../../src/renderer/src/errorReport')['errorReportText']
let MAX: number

beforeAll(async () => {
  ;(window as unknown as { devmaestro: object }).devmaestro = { logError, updateSettings }
  ;({ Modal } = await import('../../src/renderer/src/components/Modal'))
  ;({ AppBoundary } = await import('../../src/renderer/src/components/AppBoundary'))
  ;({ errorReportText, benignError, MAX_ERROR_REPORT: MAX } = await import('../../src/renderer/src/errorReport'))
})

let root: Root | null = null
let host: HTMLElement | null = null

beforeEach(() => {
  logError.mockClear()
  updateSettings.mockClear()
  // React journalise les erreurs rattrapées : sortie de test silencieuse.
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
  vi.restoreAllMocks()
})

function Boom(): never {
  throw new Error('aperçu cassé')
}

function render(el: ReturnType<typeof createElement>) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root!.render(el))
}

describe('garde-fous d’affichage', () => {
  it('dialogue : l’erreur reste dans le dialogue, × marche encore, erreur journalisée', () => {
    const onClose = vi.fn()
    render(createElement(Modal, { title: 'Réglages', onClose, children: createElement(Boom) }))
    const modal = host!.querySelector('.modal')!
    expect(modal.querySelector('h2')!.textContent).toBe('Réglages')
    expect(modal.querySelector('[role="alert"]')!.textContent).toContain('Le dialogue « Réglages » a rencontré une erreur : aperçu cassé')
    act(() => modal.querySelector<HTMLButtonElement>('[aria-label="Fermer"]')!.click())
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError.mock.calls[0]![0]).toMatch(/^affichage du dialogue « Réglages » : Error: aperçu cassé/)
  })

  it('interface entière : message, « Recharger l’interface », jamais d’écran blanc', () => {
    render(createElement(AppBoundary, { children: createElement(Boom) }))
    expect(host!.textContent).toContain('Une erreur d’affichage est survenue')
    expect(host!.textContent).toContain('aperçu cassé')
    const reload = [...host!.querySelectorAll('button')].find((b) => b.textContent === 'Recharger l’interface')
    expect(reload).toBeDefined()
    expect(logError).toHaveBeenCalledTimes(1)
  })

  it('texte du journal borné', () => {
    const t = errorReportText('x', new Error('m'.repeat(10_000)))
    expect(t.length).toBeLessThanOrEqual(MAX)
    expect(t.endsWith('…')).toBe(true)
    expect(errorReportText('promesse rejetée', 'raison')).toBe('promesse rejetée : raison')
  })

  it('bug d’origine dans un dialogue : un enfant dont l’effet renvoie une promesse est démonté, le dialogue survit', () => {
    // Effet fautif écrit exprès (le test des effets l'interdit dans le code de l'app).
    const promiseEffect = (() => Promise.resolve()) as unknown as EffectCallback
    function Bad() {
      useEffect(promiseEffect, [])
      return createElement('p', null, 'aperçu')
    }
    let hide: () => void = () => undefined
    function Content() {
      const [shown, setShown] = useState(true)
      hide = () => setShown(false)
      return createElement('div', { className: 'mb' }, shown ? createElement(Bad) : 'fermé')
    }
    render(createElement(Modal, { title: 'Réglages', onClose: () => undefined, children: createElement(Content) }))
    act(() => hide())
    expect(host!.querySelector('.modal h2')!.textContent).toBe('Réglages')
    expect(host!.querySelector('.modal [role="alert"]')!.textContent).toContain('Affichage impossible')
    expect(logError).toHaveBeenCalledTimes(1)
  })

  it('« Réessayer » : focus dessus, second échec rattrapé, puis contenu rendu ; Échap ferme en état d’erreur', () => {
    let failing = true
    function Flaky() {
      if (failing) throw new Error('encore cassé')
      return createElement('p', { className: 'ok' }, 'réparé')
    }
    const onClose = vi.fn()
    render(createElement(Modal, { title: 'Nouvelle session', onClose, children: createElement(Flaky) }))
    const retry = () => [...host!.querySelectorAll('button')].find((b) => b.textContent === 'Réessayer')!
    expect(document.activeElement).toBe(retry())
    act(() => retry().click())
    expect(host!.querySelector('[role="alert"]')!.textContent).toContain('encore cassé')
    expect(logError).toHaveBeenCalledTimes(2)
    act(() => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)
    failing = false
    act(() => retry().click())
    expect(host!.querySelector('.ok')!.textContent).toBe('réparé')
  })

  it('« Réinitialiser l’apparence » : thème par défaut et 100 % envoyés, puis rechargement', async () => {
    const reload = vi.fn()
    render(createElement(AppBoundary, { reload, children: createElement(Boom) }))
    const reset = [...host!.querySelectorAll('button')].find((b) => b.textContent === 'Réinitialiser l’apparence')!
    await act(async () => reset.click())
    expect(updateSettings).toHaveBeenCalledWith({
      theme: { mode: 'system', light: { palette: 'devmaestro', custom: {} }, dark: { palette: 'devmaestro', custom: {} } },
      ui: { zoom: 100 },
    })
    expect(reload).toHaveBeenCalledTimes(1)
    act(() => [...host!.querySelectorAll('button')].find((b) => b.textContent === 'Recharger l’interface')!.click())
    expect(reload).toHaveBeenCalledTimes(2)
  })

  it('rejet d’un objet : JSON borné ; boucle de ResizeObserver ignorée', () => {
    expect(errorReportText('promesse rejetée', { code: -2, message: 'non connecté' })).toBe(
      'promesse rejetée : {"code":-2,"message":"non connecté"}',
    )
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(errorReportText('x', circular)).toBe('x : [object Object]')
    expect(benignError('ResizeObserver loop completed with undelivered notifications.')).toBe(true)
    expect(benignError('TypeError: x')).toBe(false)
  })
})
