// @vitest-environment jsdom
/**
 * Disposition (lot 16) rendue avec React : poignée de colonne au clavier
 * (largeur bornée et retenue), zones d'onglets du volet de session pilotées
 * par l'alternative clavier (menu « ⋯ ») : scission, déplacement, zone vidée
 * fermée, limite de 4 zones, un seul terminal monté après déplacement,
 * séparateur au clavier, réinitialisation, disposition stockée invalide ignorée.
 */
import { act, createElement, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { defaultSettings } from '../../src/shared/settings'
import { emptyDraft } from '../../src/renderer/src/state/review'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** Terminaux xterm créés et détruits (un seul attendu, jamais recréé). */
const terms = { created: 0, disposed: 0, fits: 0 }
/** Rappels des ResizeObserver simulés (déclenchés à la main). */
const observers: (() => void)[] = []

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    options: Record<string, unknown> = {}
    constructor() {
      terms.created++
    }
    open() {}
    loadAddon(a: { activate?: (t: unknown) => void }) {
      a.activate?.(this)
    }
    attachCustomKeyEventHandler() {}
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
    clearTextureAtlas() {}
    dispose() {
      terms.disposed++
    }
  },
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    activate() {}
    dispose() {}
    fit() {
      terms.fits++
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

type Store = typeof import('../../src/renderer/src/components/layoutStore')
let store: Store
let SessionPane: typeof import('../../src/renderer/src/components/SessionPane')['SessionPane']
let SettingsProvider: typeof import('../../src/renderer/src/settings')['SettingsProvider']
let ColumnGrip: typeof import('../../src/renderer/src/components/ColumnGrip')['ColumnGrip']
let useColumnWidth: typeof import('../../src/renderer/src/components/ColumnGrip')['useColumnWidth']
let LAYOUT_KEY: string
let unsaved: typeof import('../../src/renderer/src/state/unsaved')
let COLUMNS_KEY: string

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
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia
  ;(window as unknown as { devmaestro: object }).devmaestro = {
    view: async () => ({ ok: true }),
    call: async () => ({ ok: false, error: { code: -32601, message: 'inconnue' } }),
    onTerminal: () => () => {},
  }
  store = await import('../../src/renderer/src/components/layoutStore')
  unsaved = await import('../../src/renderer/src/state/unsaved')
  ;({ SessionPane } = await import('../../src/renderer/src/components/SessionPane'))
  ;({ SettingsProvider } = await import('../../src/renderer/src/settings'))
  ;({ ColumnGrip, useColumnWidth } = await import('../../src/renderer/src/components/ColumnGrip'))
  ;({ LAYOUT_KEY } = await import('../../src/renderer/src/state/layout'))
  ;({ COLUMNS_KEY } = await import('../../src/renderer/src/state/columnWidth'))
})

let root: Root | null = null
let host: HTMLElement | null = null

beforeEach(() => {
  localStorage.clear()
  store.reloadLayoutStore()
  terms.created = 0
  terms.disposed = 0
  terms.fits = 0
  observers.length = 0
  unsaved.resetUnsaved()
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
})

async function mount(el: React.ReactElement) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(el))
  for (let i = 0; i < 3; i++) await act(async () => {})
}

const noop = () => {}

function pane(runnersSupported: boolean | null = true) {
  return createElement(SettingsProvider, {
    initial: defaultSettings(),
    children: createElement(SessionPane, {
      session: null,
      project: undefined,
      profiles: [],
      stale: [],
      termTheme: {},
      termSize: null,
      onTermSize: noop,
      onLink: noop,
      onSessionUpdated: noop,
      onForget: async () => {},
      diffSeq: 0,
      draft: emptyDraft,
      review: noop,
      seen: {},
      onSeen: noop,
      agents: undefined,
      agentsLoad: null,
      onRetryAgents: noop,
      agentId: null,
      onSelectAgent: noop,
      openAgents: 0,
      runnersSupported,
      runnersRunning: 0,
      onRunnersRunning: noop,
      onRunnersUnsupported: noop,
    }),
  })
}

const tablists = () => [...host!.querySelectorAll<HTMLElement>('[role="tablist"]')]
const tabsIn = (list: HTMLElement) => [...list.querySelectorAll<HTMLElement>('[role="tab"]')].map((t) => t.textContent)
const tab = (label: string) => [...host!.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((t) => t.textContent === label)!

async function click(el: HTMLElement) {
  await act(async () => el.click())
}

/** Ouvre le menu « ⋯ » de la zone `i` (0 : première) et choisit `label`. */
async function menu(i: number, label: string) {
  const btn = host!.querySelectorAll<HTMLButtonElement>('.zmenu-btn')[i]!
  await click(btn)
  const item = [...host!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent === label)
  if (!item) throw new Error(`entrée absente : ${label}`)
  await click(item)
  return item
}

function stored() {
  return JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? 'null')
}

describe('zones d’onglets', () => {
  it('par défaut : une zone, sept onglets, Terminal actif, un seul terminal', async () => {
    await mount(pane())
    expect(tablists()).toHaveLength(1)
    expect(tablists()[0]!.getAttribute('aria-label')).toBe('Vues de la session')
    expect(tabsIn(tablists()[0]!)).toEqual(['Conversation', 'Terminal', 'Diff', 'Commits', 'Fichiers', 'Agents', 'Lancer'])
    expect(tab('Terminal').getAttribute('aria-selected')).toBe('true')
    expect(host!.querySelectorAll('.term')).toHaveLength(1)
    expect(terms.created).toBe(1)
    // Chaque onglet commande son volet.
    for (const t of host!.querySelectorAll('[role="tab"]')) {
      expect(document.getElementById(t.getAttribute('aria-controls')!)?.getAttribute('role')).toBe('tabpanel')
    }
  })

  it('« Scinder à droite » au clavier : nouvelle zone, focus sur l’onglet déplacé, terminal ni recréé ni dupliqué', async () => {
    await mount(pane())
    const menuBtn = host!.querySelector<HTMLButtonElement>('.zmenu-btn')!
    expect(menuBtn.getAttribute('aria-haspopup')).toBe('menu')
    expect(menuBtn.getAttribute('aria-label')).toBe('Disposition de l’onglet Terminal')
    await click(menuBtn)
    expect(menuBtn.getAttribute('aria-expanded')).toBe('true')
    const first = host!.querySelector<HTMLElement>('[role="menuitem"]')!
    expect(document.activeElement).toBe(first)
    await act(async () => first.click())
    expect(tablists()).toHaveLength(2)
    expect(tablists().map((l) => l.getAttribute('aria-label'))).toEqual(['Zone 1 sur 2', 'Zone 2 sur 2 (zone courante)'])
    expect(tabsIn(tablists()[1]!)).toEqual(['Terminal'])
    expect(document.activeElement).toBe(tab('Terminal'))
    expect(host!.querySelectorAll('.term')).toHaveLength(1)
    expect(terms.created).toBe(1)
    expect(terms.disposed).toBe(0)
    // Volet du terminal placé dans la moitié droite.
    const panel = document.getElementById(tab('Terminal').getAttribute('aria-controls')!)!
    expect(panel.style.left).toBe('50%')
    expect(panel.style.width).toBe('50%')
    // Les deux zones affichent leur onglet actif.
    expect(tab('Terminal').getAttribute('aria-selected')).toBe('true')
    expect(tab('Conversation').getAttribute('aria-selected')).toBe('true')
    expect(stored().root.kind).toBe('split')
  })

  it('déplacer vers une autre zone : la zone vidée se ferme ; toujours un seul terminal', async () => {
    await mount(pane())
    await menu(0, 'Scinder en bas')
    expect(tablists()).toHaveLength(2)
    expect(host!.querySelectorAll('[role="separator"]')).toHaveLength(1)
    expect(host!.querySelector('[role="separator"]')!.getAttribute('aria-orientation')).toBe('horizontal')
    await menu(1, 'Déplacer vers la zone 1')
    expect(tablists()).toHaveLength(1)
    expect(host!.querySelectorAll('[role="separator"]')).toHaveLength(0)
    expect(tabsIn(tablists()[0]!)).toContain('Terminal')
    expect(document.activeElement).toBe(tab('Terminal'))
    expect(host!.querySelectorAll('.term')).toHaveLength(1)
    expect(terms.created).toBe(1)
    expect(terms.disposed).toBe(0)
    expect(stored().root.kind).toBe('zone')
  })

  it('au plus 4 zones : « Scinder » désactivé et sans effet ; le dernier onglet d’une zone ne la scinde pas', async () => {
    await mount(pane())
    // Zone 1 : onglet actif Diff, scindé à droite ; puis Commits et Fichiers.
    await click(tab('Diff'))
    await menu(0, 'Scinder à droite')
    await click(tab('Commits'))
    await menu(0, 'Scinder en bas')
    await click(tab('Fichiers'))
    await menu(0, 'Scinder à droite')
    expect(tablists()).toHaveLength(4)
    await click(tab('Agents'))
    const split = await menu(0, 'Scinder à droite')
    expect(split.getAttribute('aria-disabled')).toBe('true')
    expect(tablists()).toHaveLength(4)
    // Zone qui n'a que Diff : scission impossible (dernier onglet), déplacement possible.
    const diffZone = tablists().findIndex((l) => tabsIn(l).join() === 'Diff')
    await click(host!.querySelectorAll<HTMLButtonElement>('.zmenu-btn')[diffZone]!)
    const items = [...host!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    expect(items.find((b) => b.textContent === 'Scinder à droite')!.getAttribute('aria-disabled')).toBe('true')
    expect(items.filter((b) => b.textContent?.startsWith('Déplacer vers la zone'))).toHaveLength(3)
    // Échap ferme le menu et rend le focus au bouton.
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(host!.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement?.classList.contains('zmenu-btn')).toBe(true)
    expect(terms.created).toBe(1)
  })

  it('séparateur au clavier : pourcentage annoncé, flèches, Entrée = moitié, retenu', async () => {
    await mount(pane())
    await menu(0, 'Scinder à droite')
    const sep = host!.querySelector<HTMLElement>('[role="separator"]')!
    expect(sep.getAttribute('aria-orientation')).toBe('vertical')
    expect(sep.getAttribute('aria-valuenow')).toBe('50')
    expect(sep.tabIndex).toBe(0)
    const key = async (k: string) =>
      act(async () => {
        sep.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
      })
    await key('ArrowRight')
    expect(host!.querySelector('[role="separator"]')!.getAttribute('aria-valuenow')).toBe('55')
    expect(stored().root.ratio).toBe(0.55)
    await key('End')
    expect(host!.querySelector('[role="separator"]')!.getAttribute('aria-valuenow')).toBe('85')
    await key('Enter')
    expect(host!.querySelector('[role="separator"]')!.getAttribute('aria-valuenow')).toBe('50')
  })

  it('« Réinitialiser la disposition » : une zone, tous les onglets, colonnes par défaut', async () => {
    store.setColumn('sidebar', 400)
    await mount(pane())
    await menu(0, 'Scinder à droite')
    await menu(0, 'Scinder en bas')
    expect(tablists()).toHaveLength(3)
    await menu(0, 'Réinitialiser la disposition')
    expect(tablists()).toHaveLength(1)
    expect(tabsIn(tablists()[0]!)).toHaveLength(7)
    expect(stored().root.kind).toBe('zone')
    expect(JSON.parse(localStorage.getItem(COLUMNS_KEY)!).sidebar).toBe(268)
    expect(terms.created).toBe(1)
  })

  it('disposition retenue relue au montage ; invalide (onglet en double) : ignorée', async () => {
    localStorage.setItem(
      LAYOUT_KEY,
      JSON.stringify({
        root: {
          kind: 'split',
          dir: 'row',
          ratio: 0.4,
          a: { kind: 'zone', tabs: ['conversation', 'terminal', 'commits', 'files', 'agents', 'runners'], active: 'terminal' },
          b: { kind: 'zone', tabs: ['diff'], active: 'diff' },
        },
      }),
    )
    store.reloadLayoutStore()
    await mount(pane())
    expect(tablists()).toHaveLength(2)
    expect(host!.querySelector('[role="separator"]')!.getAttribute('aria-valuenow')).toBe('40')
    act(() => root!.unmount())
    root = null
    host!.remove()
    localStorage.setItem(
      LAYOUT_KEY,
      JSON.stringify({ root: { kind: 'split', dir: 'row', ratio: 0.5, a: { kind: 'zone', tabs: ['diff', 'terminal'] }, b: { kind: 'zone', tabs: ['diff'] } } }),
    )
    store.reloadLayoutStore()
    await mount(pane())
    expect(tablists()).toHaveLength(1)
    expect(tabsIn(tablists()[0]!)).toHaveLength(7)
  })

  it('« Lancer » indisponible : retiré de l’affichage (sa zone se ferme), disposition retenue intacte', async () => {
    await mount(pane())
    await click(tab('Lancer'))
    await menu(0, 'Scinder à droite')
    expect(tablists()).toHaveLength(2)
    const before = localStorage.getItem(LAYOUT_KEY)
    act(() => root!.unmount())
    host!.remove()
    await mount(pane(false))
    expect(tablists()).toHaveLength(1)
    expect(tabsIn(tablists()[0]!)).not.toContain('Lancer')
    expect(localStorage.getItem(LAYOUT_KEY)).toBe(before)
  })

  it('« Lancer » indisponible puis de nouveau connu : les opérations portent sur la disposition complète, Lancer revient à sa place', async () => {
    // Trois zones retenues, dont une avec « Lancer » seul (en bas à droite).
    localStorage.setItem(
      LAYOUT_KEY,
      JSON.stringify({
        root: {
          kind: 'split',
          dir: 'row',
          ratio: 0.5,
          a: { kind: 'zone', tabs: ['conversation', 'terminal', 'commits', 'files', 'agents'], active: 'terminal' },
          b: { kind: 'split', dir: 'column', ratio: 0.5, a: { kind: 'zone', tabs: ['diff'], active: 'diff' }, b: { kind: 'zone', tabs: ['runners'], active: 'runners' } },
        },
      }),
    )
    store.reloadLayoutStore()
    await mount(pane(false))
    expect(tablists()).toHaveLength(2)
    // Une scission : 4 zones dans la disposition complète (3 affichées) ; la suivante est refusée.
    await click(tab('Commits'))
    await menu(0, 'Scinder en bas')
    expect(tablists()).toHaveLength(3)
    await click(tab('Fichiers'))
    const refused = await menu(0, 'Scinder à droite')
    expect(refused.getAttribute('aria-disabled')).toBe('true')
    expect(tablists()).toHaveLength(3)
    const saved = stored()
    const count = (n: { kind: string; a?: unknown; b?: unknown }): number => (n.kind === 'zone' ? 1 : count(n.a as never) + count(n.b as never))
    expect(count(saved.root)).toBe(4)
    expect(JSON.stringify(saved)).toContain('"runners"')
    // Le démon connaît de nouveau les runners : « Lancer » réapparaît seul dans sa zone.
    act(() => root!.unmount())
    host!.remove()
    store.reloadLayoutStore()
    await mount(pane(true))
    expect(tablists()).toHaveLength(4)
    expect(tablists().some((l) => tabsIn(l).join() === 'Lancer')).toBe(true)
  })

  it('garde « fichier non enregistré » : refusée, la disposition ne change pas et aucun focus n’est armé ; acceptée, elle s’applique', async () => {
    await mount(pane())
    await click(tab('Diff'))
    await menu(0, 'Scinder à droite')
    await click(tab('Fichiers'))
    unsaved.setUnsaved('s1', 'src/a.ts')
    // Ramener Diff dans la zone 1 masquerait Fichiers : confirmation demandée.
    await menu(1, 'Déplacer vers la zone 1')
    expect(unsaved.pendingLeave()?.path).toBe('src/a.ts')
    expect(tablists()).toHaveLength(2)
    // Menu contextuel pendant ce temps : il vise l'onglet cliqué.
    await act(async () => {
      tab('Commits').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    })
    expect(host!.querySelector('[role="menu"]')!.getAttribute('aria-label')).toBe('Disposition de l’onglet Commits')
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await act(async () => unsaved.cancelLeave())
    expect(tablists()).toHaveLength(2)
    expect(tab('Fichiers').getAttribute('aria-selected')).toBe('true')
    // Un changement ultérieur (séparateur) ne déplace pas le focus vers Diff.
    const sep = host!.querySelector<HTMLElement>('[role="separator"]')!
    sep.focus()
    await act(async () => {
      sep.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    })
    expect(document.activeElement).toBe(host!.querySelector('[role="separator"]'))
    // Cette fois accepté : Diff rejoint la zone 1 et reçoit le focus.
    await menu(1, 'Déplacer vers la zone 1')
    await act(async () => unsaved.confirmLeave())
    expect(tablists()).toHaveLength(1)
    expect(document.activeElement).toBe(tab('Diff'))
  })

  it('le menu se ferme quand on attrape un séparateur ; annulation du pointeur : la dernière position est enregistrée', async () => {
    await mount(pane())
    await menu(0, 'Scinder à droite')
    const zones = host!.querySelector<HTMLElement>('.zones')!
    zones.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 600, right: 1000, bottom: 600, x: 0, y: 0, toJSON() {} }) as DOMRect
    await click(host!.querySelector<HTMLButtonElement>('.zmenu-btn')!)
    expect(host!.querySelector('[role="menu"]')).not.toBeNull()
    const sep = host!.querySelector<HTMLElement>('[role="separator"]')!
    const ptr = (type: string, clientX: number) => act(async () => {
      sep.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX }))
    })
    await ptr('pointerdown', 500)
    expect(host!.querySelector('[role="menu"]')).toBeNull()
    await ptr('pointermove', 300)
    expect(sep.getAttribute('aria-valuenow')).toBe('30')
    expect(stored().root.ratio).toBe(0.5)
    await ptr('pointercancel', 300)
    expect(stored().root.ratio).toBe(0.3)
  })

  it('terminal réajusté quand sa zone change de taille (ResizeObserver), sans être recréé', async () => {
    await mount(pane())
    await menu(0, 'Scinder à droite')
    const before = terms.fits
    await act(async () => {
      for (const cb of observers) cb()
      await new Promise((ok) => requestAnimationFrame(() => ok(null)))
    })
    expect(terms.fits).toBeGreaterThan(before)
    expect(terms.created).toBe(1)
  })
})

describe('glisser-déposer des onglets', () => {
  const TYPE = 'application/x-devmaestro-tab'
  function transfer(types?: string[]) {
    const data = new Map<string, string>()
    for (const t of types ?? []) data.set(t, 'x')
    return {
      data,
      get types() {
        return [...data.keys()]
      },
      setData(t: string, v: string) {
        data.set(t, v)
      },
      getData(t: string) {
        return data.get(t) ?? ''
      },
      dropEffect: 'none',
      effectAllowed: 'all',
    }
  }
  function fire(el: Element, type: string, dt: ReturnType<typeof transfer>, at: { x: number; y: number } = { x: 0, y: 0 }) {
    const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y })
    Object.defineProperty(ev, 'dataTransfer', { value: dt })
    el.dispatchEvent(ev)
    return ev
  }
  const rect = (el: HTMLElement) => {
    el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 600, right: 1000, bottom: 600, x: 0, y: 0, toJSON() {} }) as DOMRect
  }
  const tick = () => act(async () => new Promise((ok) => setTimeout(ok, 0)))

  it('onglet glissé vers la bande droite : cible « Scinder à droite » écrite, dépôt = nouvelle zone', async () => {
    await mount(pane())
    const dt = transfer()
    await act(async () => void fire(tab('Diff'), 'dragstart', dt))
    expect(dt.getData(TYPE)).toBe('diff')
    expect(dt.types).toEqual([TYPE])
    await tick()
    const drop = host!.querySelector<HTMLElement>('.zdrop')!
    rect(drop)
    let ev!: MouseEvent
    await act(async () => void (ev = fire(drop, 'dragover', dt, { x: 950, y: 300 })))
    expect(ev.defaultPrevented).toBe(true)
    expect(host!.querySelector('.zdrop-hint.right')!.textContent).toBe('Scinder à droite')
    await act(async () => void (ev = fire(drop, 'dragover', dt, { x: 500, y: 300 })))
    // Même zone, centre : rien à déposer, aucune cible montrée.
    expect(ev.defaultPrevented).toBe(false)
    expect(host!.querySelector('.zdrop-hint')).toBeNull()
    await act(async () => void fire(drop, 'dragover', dt, { x: 500, y: 590 }))
    expect(host!.querySelector('.zdrop-hint.bottom')!.textContent).toBe('Scinder en bas')
    await act(async () => void fire(drop, 'drop', dt, { x: 500, y: 590 }))
    expect(tablists()).toHaveLength(2)
    expect(tabsIn(tablists()[1]!)).toEqual(['Diff'])
    expect(host!.querySelector('.zdrop')).toBeNull()
    // Glissé vers la barre d'onglets de la zone 1 : déplacé, la zone 2 se ferme.
    const dt2 = transfer()
    await act(async () => void fire(tab('Diff'), 'dragstart', dt2))
    await tick()
    const bar = host!.querySelectorAll<HTMLElement>('.ztabs')[0]!
    await act(async () => void (ev = fire(bar, 'dragover', dt2)))
    expect(ev.defaultPrevented).toBe(true)
    expect(bar.querySelector('.zdrop-label')!.textContent).toBe('Déplacer ici')
    await act(async () => void fire(bar, 'drop', dt2))
    expect(tablists()).toHaveLength(1)
    expect(terms.created).toBe(1)
  })

  it('dépôt venu d’ailleurs (fichier, texte) : refusé', async () => {
    await mount(pane())
    const bar = host!.querySelector<HTMLElement>('.ztabs')!
    const files = transfer(['Files'])
    let ev!: MouseEvent
    await act(async () => void (ev = fire(bar, 'dragover', files)))
    expect(ev.defaultPrevented).toBe(false)
    expect(host!.querySelector('.zdrop')).toBeNull()
    // Un glisser d'onglet en cours, mais l'objet survolé n'est pas un onglet (texte) : refusé aussi.
    const dt = transfer()
    await act(async () => void fire(tab('Diff'), 'dragstart', dt))
    await tick()
    const drop = host!.querySelector<HTMLElement>('.zdrop')!
    rect(drop)
    const text = transfer(['text/plain'])
    text.data.set('text/plain', 'diff')
    await act(async () => void (ev = fire(drop, 'dragover', text, { x: 950, y: 300 })))
    expect(ev.defaultPrevented).toBe(false)
    await act(async () => void fire(drop, 'drop', text, { x: 950, y: 300 }))
    expect(tablists()).toHaveLength(1)
    // Fin du glisser (même si le bouton source avait disparu) : cibles retirées.
    await act(async () => void document.dispatchEvent(new Event('dragend')))
    expect(host!.querySelector('.zdrop')).toBeNull()
  })
})

describe('colonnes redimensionnables', () => {
  function Harness() {
    const ref = useRef<HTMLDivElement>(null)
    const c = useColumnWidth('sidebar', ref)
    return createElement(
      'div',
      { ref, 'data-w': c.width },
      createElement(ColumnGrip, { column: 'sidebar', label: 'Largeur de la barre latérale', width: c.width, max: c.max, avail: c.avail }),
    )
  }

  it('poignée au clavier : flèches, Début / Fin, Entrée = défaut ; largeur retenue', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1600 })
    await mount(createElement(Harness))
    const grip = host!.querySelector<HTMLElement>('[role="separator"]')!
    expect(grip.getAttribute('aria-orientation')).toBe('vertical')
    expect(grip.getAttribute('aria-valuenow')).toBe('268')
    expect(grip.getAttribute('aria-valuemin')).toBe('200')
    expect(grip.getAttribute('aria-valuemax')).toBe('560')
    expect(grip.tabIndex).toBe(0)
    const key = async (k: string) =>
      act(async () => {
        grip.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
      })
    await key('ArrowRight')
    expect(grip.getAttribute('aria-valuenow')).toBe('292')
    expect(JSON.parse(localStorage.getItem(COLUMNS_KEY)!).sidebar).toBe(292)
    await key('End')
    expect(grip.getAttribute('aria-valuenow')).toBe('560')
    await key('Home')
    expect(grip.getAttribute('aria-valuenow')).toBe('200')
    await key('ArrowLeft')
    expect(grip.getAttribute('aria-valuenow')).toBe('200')
    await key('Enter')
    expect(grip.getAttribute('aria-valuenow')).toBe('268')
    await key('ArrowRight')
    // Relue après un redémarrage.
    store.reloadLayoutStore()
    await act(async () => {})
    expect(host!.querySelector('[role="separator"]')!.getAttribute('aria-valuenow')).toBe('292')
    // Double clic : largeur par défaut.
    await act(async () => {
      grip.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    expect(grip.getAttribute('aria-valuenow')).toBe('268')
  })

  it('fenêtre étroite : borne haute réduite pour laisser la place à la session', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 900 })
    store.setColumn('sidebar', 540)
    await mount(createElement(Harness))
    const grip = host!.querySelector<HTMLElement>('[role="separator"]')!
    expect(grip.getAttribute('aria-valuemax')).toBe('420')
    expect(grip.getAttribute('aria-valuenow')).toBe('420')
  })
})
