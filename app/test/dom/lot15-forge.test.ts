// @vitest-environment jsdom
/**
 * Lot 15 (retours sur la forge), rendu React : sélecteur d'étiquettes au
 * clavier (combobox ARIA), filtre par étiquettes du dépôt et repli en saisie
 * libre (démon sans `forge.labels`, sans masquer la forge), barre d'actions
 * en bas du détail d'une issue, panneau redimensionnable (taille retenue,
 * « Agrandir / Réduire »), cases à cocher Markdown annoncées.
 */
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ForgeStatus, Issue, RepoLabel } from '../../src/shared/protocol'
import { defaultSettings } from '../../src/shared/settings'
import type { EpicLaunchContext } from '../../src/renderer/src/components/IssuesPanel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ROOT = '/w/projet'
const STATUS: ForgeStatus = { available: true, kind: 'github', host: 'github.com', repo: 'o/r', reason: null }
const REPO_LABELS: RepoLabel[] = [
  { name: 'bug', color: 'd73a4a', description: 'Quelque chose ne marche pas' },
  { name: 'documentation', color: '0075ca', description: 'Améliorations de la documentation' },
  { name: 'démon', color: 'fbca04', description: 'orchd (Rust)' },
]
const ISSUE: Issue = {
  number: 42,
  title: 'Ajouter la division et une erreur explicite pour la division par zéro dans le module de calcul',
  state: 'open',
  url: 'https://github.com/o/r/issues/42',
  author: 'romain',
  labels: [{ name: 'bug', color: 'd73a4a' }],
  assignees: [],
  updated_at: '2026-10-20T10:00:00Z',
  body: '## À faire\n\n- [x] fonction\n- [ ] tests\n',
  sub_issues: [{ number: 43, title: 'Partie A', state: 'open' }],
}

/** `forge.labels` : liste du dépôt, ou méthode inconnue (démon d'avant le lot 15). */
let labelsMode: 'ok' | 'unknown' = 'ok'
const calls: { method: string; params: Record<string, unknown> }[] = []

type Mod = typeof import('../../src/renderer/src/components/IssuesPanel')
let ForgePanel: Mod['ForgePanel']
let FORGE_PANEL_SIZE_KEY: string
let LabelPicker: typeof import('../../src/renderer/src/components/LabelPicker')['LabelPicker']
let ForgeMarkdown: typeof import('../../src/renderer/src/components/ForgeContent')['ForgeMarkdown']
let SettingsProvider: typeof import('../../src/renderer/src/settings')['SettingsProvider']

beforeAll(async () => {
  ;(window as unknown as { devmaestro: object }).devmaestro = {
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      if (method === 'forge.status') return { ok: true, result: STATUS }
      if (method === 'forge.labels') {
        return labelsMode === 'ok' ? { ok: true, result: { labels: REPO_LABELS } } : { ok: false, error: { code: -32601, message: 'méthode inconnue : forge.labels' } }
      }
      if (method === 'forge.issues') return { ok: true, result: { issues: [ISSUE], truncated: false } }
      if (method === 'forge.issue') return { ok: true, result: ISSUE }
      return { ok: false, error: { code: -32601, message: 'inconnue' } }
    },
    copyText: async () => true,
  }
  ;({ ForgePanel, FORGE_PANEL_SIZE_KEY } = await import('../../src/renderer/src/components/IssuesPanel'))
  ;({ LabelPicker } = await import('../../src/renderer/src/components/LabelPicker'))
  ;({ ForgeMarkdown } = await import('../../src/renderer/src/components/ForgeContent'))
  ;({ SettingsProvider } = await import('../../src/renderer/src/settings'))
})

let root: Root | null = null
let host: HTMLElement | null = null

beforeEach(() => {
  calls.length = 0
  labelsMode = 'ok'
  localStorage.clear()
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
})

const epic: EpicLaunchContext = {
  worktrees: true,
  initial: true,
  takenBranches: new Set(),
  profileLabel: 'Défaut',
  locationLabel: 'À côté du dépôt',
  launch: async () => {
    throw new Error('pas dans ce test')
  },
  onLaunched: () => undefined,
}

async function flush() {
  for (let i = 0; i < 5; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)))
}

async function mount(el: ReturnType<typeof createElement>) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(el))
  await flush()
}

async function renderPanel(props: { initialNumber?: number | null; onClose?: () => void; onUnsupported?: () => void } = {}) {
  const settings = { ...defaultSettings(), worktrees: { ...defaultSettings().worktrees, branchPrefix: 'romain/' } }
  const panel = createElement(ForgePanel, {
    root: ROOT,
    name: 'projet',
    initialNumber: props.initialNumber ?? null,
    epic,
    onClose: props.onClose ?? (() => undefined),
    onLink: () => undefined,
    onLaunchIssue: () => undefined,
    onUnsupported: props.onUnsupported ?? (() => undefined),
  })
  await mount(createElement(SettingsProvider, { initial: settings, children: panel }))
}

function key(el: Element, k: string) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
  })
}

function type(input: HTMLInputElement, value: string) {
  act(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    set.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const combo = () => document.querySelector<HTMLInputElement>('[role="combobox"]')!
const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')]

/** Sélecteur seul, avec son état (comme dans le panneau). */
function Picker({ onChange }: { onChange: (v: string[]) => void }) {
  const [sel, setSel] = useState<string[]>([])
  return createElement(LabelPicker, {
    labels: REPO_LABELS,
    selected: sel,
    onChange: (v: string[]) => {
      setSel(v)
      onChange(v)
    },
  })
}

describe('sélecteur d’étiquettes (combobox ARIA)', () => {
  it('clavier : flèches, Entrée choisit et retire, option active annoncée, Échap ferme, Retour arrière retire la dernière pastille', async () => {
    const changes: string[][] = []
    await mount(createElement(Picker, { onChange: (v) => changes.push(v) }))
    const input = combo()
    expect(input.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('[role="listbox"]')).toBeNull()
    // Liste fermée : aria-controls ne désigne rien d'absent.
    expect(input.hasAttribute('aria-controls')).toBe(false)
    act(() => input.focus())
    key(input, 'ArrowDown')
    expect(input.getAttribute('aria-expanded')).toBe('true')
    const lb = document.querySelector('[role="listbox"]')!
    expect(lb.getAttribute('aria-multiselectable')).toBe('true')
    expect(input.getAttribute('aria-controls')).toBe(lb.id)
    expect(options().map((o) => o.textContent)).toEqual(['bugQuelque chose ne marche pas', 'documentationAméliorations de la documentation', 'démonorchd (Rust)'])
    expect(input.getAttribute('aria-activedescendant')).toBe(options()[0]!.id)
    key(input, 'ArrowDown')
    key(input, 'ArrowDown')
    expect(input.getAttribute('aria-activedescendant')).toBe(options()[2]!.id)
    key(input, 'Enter')
    expect(changes.at(-1)).toEqual(['démon'])
    expect(options()[2]!.getAttribute('aria-selected')).toBe('true')
    // En boucle : du dernier au premier.
    key(input, 'ArrowDown')
    key(input, 'Enter')
    expect(changes.at(-1)).toEqual(['démon', 'bug'])
    // Entrée sur une option choisie : retirée.
    key(input, 'Enter')
    expect(changes.at(-1)).toEqual(['démon'])
    expect(document.querySelector('.lpick')?.textContent).toContain('1 étiquette choisie : démon')
    // Liste ouverte : la fenêtre ne doit pas se fermer sur Échap.
    expect(document.querySelector('.lpick')?.hasAttribute('data-own-escape')).toBe(true)
    key(input, 'Escape')
    expect(input.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('.lpick')?.hasAttribute('data-own-escape')).toBe(false)
    key(input, 'Backspace')
    expect(changes.at(-1)).toEqual([])
    expect(document.querySelectorAll('.lchip')).toHaveLength(0)
  })

  it('recherche dans la liste du dépôt (sans accents), pastilles avec nom et bouton de retrait nommé', async () => {
    const changes: string[][] = []
    await mount(createElement(Picker, { onChange: (v) => changes.push(v) }))
    const input = combo()
    act(() => input.focus())
    type(input, 'DEMON')
    expect(options().map((o) => o.querySelector('.lopt-n')?.textContent)).toEqual(['démon'])
    type(input, 'rust')
    expect(options().map((o) => o.querySelector('.lopt-n')?.textContent)).toEqual(['démon'])
    key(input, 'Enter')
    expect(changes.at(-1)).toEqual(['démon'])
    // Recherche vidée après un choix : toute la liste revient.
    expect(input.value).toBe('')
    expect(options()).toHaveLength(3)
    type(input, 'zzz')
    expect(options()).toHaveLength(0)
    expect(document.querySelector('.lpick-pop')?.textContent).toContain('Aucune étiquette ne correspond')
    // Clic sur une option (la souris) : choisie aussi.
    type(input, '')
    act(() => options()[0]!.click())
    expect(changes.at(-1)).toEqual(['démon', 'bug'])
    const chips = [...document.querySelectorAll('.lchip')]
    expect(chips.map((c) => c.querySelector('.lchip-n')?.textContent)).toEqual(['démon', 'bug'])
    const x = chips[0]!.querySelector('button')!
    expect(x.getAttribute('aria-label')).toBe('Retirer l’étiquette démon')
    act(() => x.focus())
    act(() => x.click())
    expect(changes.at(-1)).toEqual(['bug'])
    // Pastille retirée : le focus revient au champ.
    expect(document.activeElement).toBe(input)
    // Appui dans la liste (barre de défilement comprise) : empêché, le champ garde le focus et la liste reste ouverte.
    act(() => input.focus())
    key(input, 'ArrowDown')
    const pop = document.querySelector('.lpick-pop')!
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    act(() => pop.dispatchEvent(down))
    expect(down.defaultPrevented).toBe(true)
    expect(input.getAttribute('aria-expanded')).toBe('true')
  })
})

describe('panneau Forge (lot 15)', () => {
  it('filtre par étiquettes du dépôt (triées) : une étiquette en `label`, deux en `labels`', async () => {
    await renderPanel()
    expect(calls.map((c) => c.method)).toEqual(['forge.status', 'forge.issues', 'forge.labels'])
    const input = combo()
    act(() => input.focus())
    key(input, 'ArrowDown')
    key(input, 'Enter')
    await flush()
    expect(calls.at(-1)).toEqual({ method: 'forge.issues', params: { root: ROOT, state: 'open', label: 'bug', limit: 50 } })
    key(input, 'ArrowDown')
    key(input, 'Enter')
    await flush()
    expect(calls.at(-1)).toEqual({ method: 'forge.issues', params: { root: ROOT, state: 'open', labels: ['bug', 'démon'], limit: 50 } })
    // « Actualiser » redemande aussi les étiquettes, sans le cache.
    calls.length = 0
    act(() => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Actualiser')!.click())
    await flush()
    expect(calls).toContainEqual({ method: 'forge.labels', params: { root: ROOT, refresh: true } })
  })

  it('démon sans forge.labels : saisie libre d’une étiquette, la forge reste affichée', async () => {
    labelsMode = 'unknown'
    const onUnsupported = vi.fn()
    await renderPanel({ onUnsupported })
    expect(onUnsupported).not.toHaveBeenCalled()
    expect(document.querySelector('[role="combobox"]')).toBeNull()
    const free = document.querySelector<HTMLInputElement>('.ifield-labels input')!
    expect(free).not.toBeNull()
    expect(document.querySelector('.irows')).not.toBeNull()
    type(free, 'bug')
    await act(async () => await new Promise((r) => setTimeout(r, 400)))
    await flush()
    expect(calls.at(-1)).toEqual({ method: 'forge.issues', params: { root: ROOT, state: 'open', label: 'bug', limit: 50 } })
  })

  it('barre de filtres dans l’ordre du contrat : État, Étiquettes, Assignées à moi, Recherche', async () => {
    await renderPanel()
    const bar = document.querySelector('.ifilters')!
    const order = [...bar.querySelectorAll('select, [role="combobox"], input[type="checkbox"], input[type="search"]')].map(
      (e) => e.closest('.field, .optrow')?.querySelector('.lbl, span')?.textContent,
    )
    expect(order).toEqual(['État', 'Étiquettes', 'Assignées à moi', 'Recherche'])
  })

  it('issue choisie : barre d’actions en bas du détail (hors du texte qui défile), nom et branche courts affichés', async () => {
    await renderPanel({ initialNumber: 42 })
    const article = document.querySelector('.iissue')!
    const bar = article.querySelector('.iissue-bar')!
    expect(bar).not.toBeNull()
    // Après le texte, pas dedans.
    expect(article.lastElementChild).toBe(bar)
    expect(article.querySelector('.iissue-body .iissue-bar')).toBeNull()
    const launch = [...bar.querySelectorAll('button')].find((b) => b.textContent === 'Lancer une session')!
    expect(launch.classList.contains('pri')).toBe(true)
    expect(launch.classList.contains('sm')).toBe(false)
    expect(bar.textContent).toContain('Lancer une session par sous-issue (1)')
    expect(bar.textContent).toContain('session « #42 Ajouter la division et une erreur »')
    expect(bar.querySelector('.mono')?.textContent).toBe('romain/42-ajouter-division-erreur')
    // Étiquettes : pastilles neutres, pas des boutons.
    const label = document.querySelector('.iissue-body .ilabel')!
    expect(label.tagName).toBe('SPAN')
    expect(label.getAttribute('style')).toBeNull()
  })

  it('cases à cocher du corps : désactivées, cochée / non cochée exposées', async () => {
    await renderPanel({ initialNumber: 42 })
    const boxes = [...document.querySelectorAll<HTMLInputElement>('.issue-md input[type="checkbox"]')]
    expect(boxes.map((b) => [b.disabled, b.checked])).toEqual([
      [true, true],
      [true, false],
    ])
    expect(document.querySelector('.issue-md')?.textContent).not.toContain('[x]')
  })

  it('panneau : toute la largeur par défaut ; « Agrandir / Réduire » retenu ; poignée au clavier retenue', async () => {
    await renderPanel()
    const modal = document.querySelector<HTMLElement>('.modal')!
    expect(modal.classList.contains('panel-modal')).toBe(true)
    expect(modal.style.width).toBe('100%')
    const grow = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Agrandir')!
    act(() => grow.click())
    expect(modal.classList.contains('max')).toBe(true)
    expect(document.querySelector('.scrim')?.classList.contains('max')).toBe(true)
    expect(JSON.parse(localStorage.getItem(FORGE_PANEL_SIZE_KEY)!)).toEqual({ width: null, maximized: true })
    // Agrandi : pas de poignée.
    expect(document.querySelector('[role="separator"]')).toBeNull()
    act(() => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Réduire')!.click())
    expect(modal.classList.contains('max')).toBe(false)
    const grip = document.querySelector<HTMLElement>('[role="separator"]')!
    expect(grip.getAttribute('aria-orientation')).toBe('vertical')
    // Bornes cohérentes : min ≤ valeur ≤ max (toute la largeur : valeur = max).
    const [min, now, max] = ['aria-valuemin', 'aria-valuenow', 'aria-valuemax'].map((k) => Number(grip.getAttribute(k)))
    expect(min).toBeLessThanOrEqual(now!)
    expect(now).toBe(max)
    expect(max).toBe(window.innerWidth - 16)
    expect(grip.tabIndex).toBe(0)
    // Le focus initial ne va pas à la poignée.
    expect(document.activeElement).not.toBe(grip)
    // jsdom : largeur de la fenêtre 1024, disponible 1024 - 16 ; « Début » : largeur minimale.
    key(grip, 'Home')
    expect(modal.style.width).toBe('min(560px, 100%)')
    key(grip, 'ArrowLeft')
    expect(modal.style.width).toBe('min(600px, 100%)')
    expect(JSON.parse(localStorage.getItem(FORGE_PANEL_SIZE_KEY)!)).toEqual({ width: 600, maximized: false })
    key(grip, 'End')
    expect(modal.style.width).toBe('100%')
  })

  it('taille retenue réappliquée à la réouverture', async () => {
    localStorage.setItem(FORGE_PANEL_SIZE_KEY, JSON.stringify({ width: 900, maximized: false }))
    await renderPanel()
    expect(document.querySelector<HTMLElement>('.modal')!.style.width).toBe('min(900px, 100%)')
  })

  it('Échap dans la liste d’étiquettes ouverte la ferme sans fermer le panneau ; ensuite, Échap ferme', async () => {
    const onClose = vi.fn()
    await renderPanel({ onClose })
    const input = combo()
    act(() => input.focus())
    key(input, 'ArrowDown')
    key(input, 'Escape')
    expect(onClose).not.toHaveBeenCalled()
    expect(input.getAttribute('aria-expanded')).toBe('false')
    key(input, 'Escape')
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('cases à cocher dans les autres vues Markdown', () => {
  it('ForgeMarkdown (issues, demandes de fusion, commentaires) : cases désactivées', async () => {
    await mount(createElement(ForgeMarkdown, { text: '* [X] fait\n1. [ ] à faire', idPrefix: 't', onLink: () => undefined }))
    const boxes = [...document.querySelectorAll<HTMLInputElement>('input.task-cb')]
    expect(boxes.map((b) => [b.type, b.disabled, b.checked])).toEqual([
      ['checkbox', true, true],
      ['checkbox', true, false],
    ])
  })
})
