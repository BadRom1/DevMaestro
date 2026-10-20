// @vitest-environment jsdom
/**
 * Terminal (lot 8) avec xterm simulé : quand la place change (zone des
 * demandes qui apparaît, se réduit ou disparaît : le ResizeObserver du
 * terminal se déclenche), les colonnes sont réajustées (`fit`) ; quand le
 * rapport de pixels change (zoom de l'interface), l'atlas des glyphes est
 * vidé puis les colonnes réajustées.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const fits: number[] = []
const atlas: number[] = []

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    options: Record<string, unknown> = {}
    open() {}
    loadAddon(a: { activate?: (t: unknown) => void }) {
      a.activate?.(this)
    }
    onData() {
      return { dispose() {} }
    }
    onBinary() {
      return { dispose() {} }
    }
    onResize() {
      return { dispose() {} }
    }
    write() {}
    resize() {}
    refresh() {}
    clearTextureAtlas() {
      atlas.push(1)
    }
    dispose() {}
  },
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    activate() {}
    dispose() {}
    fit() {
      fits.push(1)
    }
  },
}))
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    activate() {}
    dispose() {}
    onContextLoss() {}
  },
}))

/** ResizeObserver simulé : les rappels sont gardés pour être déclenchés à la main. */
const observers: (() => void)[] = []
/** Requête `(resolution: …)` simulée : ses abonnés « change ». */
const dprListeners: (() => void)[] = []

type Mod = typeof import('../../src/renderer/src/terminal/TerminalView')
let TerminalView: Mod['TerminalView']

beforeAll(async () => {
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    constructor(cb: () => void) {
      observers.push(cb)
    }
    observe() {}
    disconnect() {}
  }
  window.matchMedia = ((q: string) => ({
    media: q,
    matches: true,
    addEventListener: (_t: string, l: () => void) => dprListeners.push(l),
    removeEventListener: (_t: string, l: () => void) => {
      const i = dprListeners.indexOf(l)
      if (i >= 0) dprListeners.splice(i, 1)
    },
  })) as unknown as typeof window.matchMedia
  ;(window as unknown as { devmaestro: object }).devmaestro = {
    view: async () => ({ ok: true }),
    call: async () => ({ ok: true, result: {} }),
  }
  ;({ TerminalView } = await import('../../src/renderer/src/terminal/TerminalView'))
})

let root: Root | null = null
let host: HTMLElement | null = null

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
})

const frame = () => new Promise((ok) => requestAnimationFrame(() => ok(null)))

describe('terminal : réajustement', () => {
  it('place changée (zone des demandes) : colonnes réajustées ; zoom : atlas vidé puis réajusté', async () => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        createElement(TerminalView, { sessionId: null, alive: true, theme: {}, emptyText: 'vide' }),
      )
    })
    for (let i = 0; i < 5; i++) await act(async () => {})
    expect(observers).toHaveLength(1)
    const before = fits.length
    expect(before).toBeGreaterThan(0)

    // La zone des demandes apparaît : le conteneur du terminal rétrécit.
    await act(async () => {
      observers[0]!()
      await frame()
    })
    expect(fits.length).toBe(before + 1)

    // Zoom de l'interface : le rapport de pixels change.
    expect(dprListeners).toHaveLength(1)
    await act(async () => dprListeners[0]!())
    expect(atlas).toHaveLength(1)
    expect(fits.length).toBe(before + 2)
    // Une nouvelle requête suit le nouveau rapport (l'ancienne est abandonnée).
    expect(dprListeners).toHaveLength(1)
  })
})
