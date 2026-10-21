// @vitest-environment jsdom
/**
 * Plugins (lot 22a) rendus avec React : Réglages → Plugins (liste, états,
 * permissions expliquées, avertissement fort pour `network`, accepter et
 * révoquer par les canaux IPC dédiés), onglet de session `plugin:<nom>`
 * (rendu natif de chaque bloc, tableau trié, arbre au clavier, Markdown sans
 * HTML exécuté, redemande automatique seulement onglet affiché), « Envoyer à
 * Claude » (consigne tapée du registre sans texte du plugin, contenu collé,
 * envoi seulement au clic), capacité absente (rien d'affiché ni d'appelé).
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { defaultPrompt } from '../../src/shared/prompts'
import type { PluginInfo } from '../../src/shared/protocol'
import { defaultSettings, type AppSettings } from '../../src/shared/settings'
import { emptyDraft } from '../../src/renderer/src/state/review'
import { session as fixtureSession } from '../fixtures'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../src/renderer/src/terminal/TerminalView', () => ({
  TerminalView: (p: { sessionId: string | null }) => createElement('div', { 'data-testid': 'term', 'data-id': p.sessionId ?? '' }),
}))

const FP = 'a'.repeat(64)
const FP_NET = 'c'.repeat(64)
const FP_OLD = 'e'.repeat(64)

function plugin(over: Partial<PluginInfo> & { name: string }): PluginInfo {
  return {
    valid: true,
    errors: [],
    version: '0.1.0',
    label: { fr: `Libellé ${over.name}`, en: `Label ${over.name}` },
    description: { fr: 'Description du plugin', en: 'Plugin description' },
    command: ['python3', '-I', 'main.py'],
    files: ['main.py'],
    permissions: ['diff.read'],
    actions: [],
    fingerprint: FP,
    acceptance: 'none',
    process: { state: 'stopped' },
    ...over,
  }
}

const IMPACT = plugin({
  name: 'codegraph-impact',
  label: { fr: 'Impact du diff', en: 'Diff impact' },
  permissions: ['diff.read', 'worktree.read', 'worktree.write', 'claude.propose'],
  tab: { label: { fr: 'Impact', en: 'Impact' } },
  actions: [
    { id: 'index', label: { fr: 'Indexer', en: 'Index' }, propose: false },
    { id: 'send-impact', label: { fr: 'Envoyer l’impact', en: 'Send impact' }, propose: true },
  ],
  acceptance: 'accepted',
  accepted_fingerprint: FP,
})
const NET = plugin({ name: 'net', permissions: ['network'], fingerprint: FP_NET })
const BROKEN = plugin({ name: 'broken', valid: false, errors: ['champ inconnu : foo'], fingerprint: null, command: undefined, permissions: [] })
const CHANGED = plugin({ name: 'chg', acceptance: 'changed', accepted_fingerprint: FP_OLD })
const FAILED = plugin({
  name: 'failing',
  acceptance: 'accepted',
  process: { state: 'failed', reason: 'timeout', stderr_tail: 'Traceback‮: boom' },
})

let list: PluginInfo[]
let accepted: Record<string, string>
const calls: { method: string; params: Record<string, unknown> }[] = []
let replies: Record<string, (p: Record<string, unknown>) => unknown>
const acceptPlugin = vi.fn(async (_r: { name: string; fingerprint: string }) => ({ ok: true }))
const revokePlugin = vi.fn(async (_r: { name: string }) => ({ ok: true }))

const DOC = {
  title: 'Impact du diff',
  blocks: [
    { type: 'notice', level: 'warning', text: 'Rust mal couvert' },
    { type: 'markdown', text: 'Texte <script>window.__pwned = 1</script> <img src=x onerror="window.__pwned = 2"> **gras** [lien](https://exemple.org)' },
    { type: 'kv', items: [{ key: 'Profondeur', value: '2' }] },
    { type: 'list', ordered: true, items: [{ text: 'a.test.ts', detail: 'touché' }] },
    {
      type: 'table',
      caption: 'Symboles',
      columns: [
        { id: 'symbol', label: 'Symbole' },
        { id: 'depth', label: 'Profondeur', align: 'end' },
      ],
      rows: [
        { symbol: 'beta', depth: 2 },
        { symbol: 'alpha', depth: 10 },
        { symbol: 'gamma', depth: 1 },
      ],
    },
    { type: 'tree', nodes: [{ label: 'src/a.rs', children: [{ label: 'fn x' }, { label: 'fn y' }] }, { label: 'src/b.rs' }] },
    {
      type: 'actions',
      items: [
        { id: 'index', label: 'Mettre à jour', args: { full: true } },
        { id: 'send-impact', label: 'Envoyer à Claude', primary: true },
      ],
    },
  ],
}

let SettingsProvider: typeof import('../../src/renderer/src/settings')['SettingsProvider']
let SettingsDialog: typeof import('../../src/renderer/src/components/SettingsDialog')['SettingsDialog']
let SessionPane: typeof import('../../src/renderer/src/components/SessionPane')['SessionPane']
let store: typeof import('../../src/renderer/src/pluginsStore')
let layoutStore: typeof import('../../src/renderer/src/components/layoutStore')

beforeAll(async () => {
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  }
  window.matchMedia = ((q: string) => ({ media: q, matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
  ;(window as unknown as { devmaestro: object }).devmaestro = {
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      if (method === 'plugins.list') return { ok: true, result: { dir: '/home/u/.config/devmaestro/plugins', plugins: list } }
      const r = replies[method]
      return r ? { ok: true, result: r(params) } : { ok: false, error: { code: -32601, message: 'inconnue' } }
    },
    settings: async () => ({ settings: { ...defaultSettings(), plugins: { accepted } }, fresh: false }),
    acceptPlugin,
    revokePlugin,
    copyText: async () => true,
    updateSettings: async () => ({ ok: true, settings: defaultSettings() }),
    onZoomChanged: () => () => undefined,
    onNotification: () => () => undefined,
    view: async () => ({ ok: true }),
  }
  ;({ SettingsProvider } = await import('../../src/renderer/src/settings'))
  ;({ SettingsDialog } = await import('../../src/renderer/src/components/SettingsDialog'))
  ;({ SessionPane } = await import('../../src/renderer/src/components/SessionPane'))
  store = await import('../../src/renderer/src/pluginsStore')
  layoutStore = await import('../../src/renderer/src/components/layoutStore')
})

let root: Root | null = null
let host: HTMLElement | null = null

beforeEach(() => {
  calls.length = 0
  acceptPlugin.mockClear()
  revokePlugin.mockClear()
  list = [IMPACT, NET, BROKEN, CHANGED, FAILED]
  accepted = { 'codegraph-impact': FP, failing: FP, chg: FP_OLD }
  replies = {
    'plugins.panel': () => ({ document: DOC }),
    'plugins.action': (p) =>
      p.action === 'send-impact'
        ? { propose: { content: '# Impact\n\nSymboles touchés : 12\n<b>pas du HTML</b>' } }
        : { document: { blocks: [{ type: 'notice', level: 'info', text: 'Indexation lancée' }], refresh_ms: 2000 } },
    'sessions.sendPrompt': () => ({ sent: true }),
  }
  store.resetPluginsStore()
  localStorage.clear()
  layoutStore.reloadLayoutStore()
  delete (window as { __pwned?: unknown }).__pwned
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
})

async function mount(el: React.ReactElement, settings: AppSettings = defaultSettings()) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(createElement(SettingsProvider, { initial: settings, children: el })))
  for (let i = 0; i < 4; i++) await act(async () => {})
}

async function flush() {
  for (let i = 0; i < 4; i++) await act(async () => {})
}

async function enable() {
  await act(async () => {
    store.setPluginsEnabled(true)
  })
  await flush()
}

const buttons = (label: string | RegExp) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].filter((b) => (typeof label === 'string' ? b.textContent === label : label.test(b.textContent ?? '')))
const card = (name: string) => [...document.querySelectorAll<HTMLElement>('.pl-card')].find((c) => c.textContent?.includes(`nom : ${name}`))!
const pluginCalls = () => calls.filter((c) => c.method.startsWith('plugins.'))

function dialog(plugins: boolean) {
  return createElement(SettingsDialog, { profiles: [], projects: [], home: null, scheme: 'dark', plugins, onClose: () => undefined })
}

describe('Réglages → Plugins', () => {
  it('liste : dossier, libellé, état, permissions expliquées (network et worktree.write signalées), erreurs, échec du processus', async () => {
    await enable()
    await mount(dialog(true))
    await act(async () => buttons('Plugins')[0]!.click())
    await flush()
    expect(document.body.textContent).toContain('Dossier des plugins : /home/u/.config/devmaestro/plugins')
    const impact = card('codegraph-impact')
    expect(impact.querySelector('h3')!.textContent).toBe('Impact du diff')
    expect(impact.textContent).toContain('État : actif')
    expect(impact.textContent).toContain('écrit dans le worktree de la session')
    expect(impact.querySelector('.pl-perms li.flag code')!.textContent).toBe('worktree.write')
    expect(impact.textContent).toContain('python3 -I main.py')
    expect(impact.textContent).toContain('main.py')
    const fp = impact.querySelector<HTMLElement>('.pl-fp code')!
    expect(fp.textContent).toBe(`${FP.slice(0, 12)}…`)
    expect(fp.getAttribute('title')).toBe(FP)
    expect(card('net').textContent).toContain('État : nouveau : pas encore accepté')
    expect(card('net').querySelector('.pl-perms li.flag')!.textContent).toMatch(/va sur le réseau/)
    expect(card('broken').textContent).toContain('manifeste invalide')
    expect(card('broken').textContent).toContain('champ inconnu : foo')
    expect(card('chg').textContent).toContain('modifié depuis ton accord : relis puis accepte de nouveau')
    expect(card('failing').textContent).toContain('Raison : délai dépassé')
    // Fin de stderr nettoyée (caractère de direction retiré).
    expect(card('failing').querySelector('.pd-stderr')!.textContent).toBe('Traceback: boom')
    // Un plugin invalide ne se propose pas à l'accord.
    expect(card('broken').querySelectorAll('button.pri')).toHaveLength(0)
  })

  it('accepter : confirmation avec commande, permissions, empreinte et avertissement fort pour network, puis canal acceptPlugin', async () => {
    await enable()
    await mount(dialog(true))
    await act(async () => buttons('Plugins')[0]!.click())
    await flush()
    await act(async () => card('net').querySelector<HTMLButtonElement>('button.pri')!.click())
    const confirm = document.querySelector<HTMLElement>('.pl-confirm')!
    expect(confirm.querySelector('h3')!.textContent).toBe('Accepter le plugin net')
    const alert = confirm.querySelector('[role="alert"]')!
    expect(alert.textContent).toMatch(/ce plugin va sur le réseau.*envoyer sur le réseau ce qu’il lit : diff, fichiers/)
    expect(confirm.textContent).toContain('python3 -I main.py')
    expect(confirm.textContent).toContain(FP_NET)
    await act(async () => buttons('Accepter')[0]!.click())
    await flush()
    expect(acceptPlugin).toHaveBeenCalledWith({ name: 'net', fingerprint: FP_NET })
    // Jamais par le protocole depuis la page.
    expect(calls.some((c) => c.method === 'plugins.accept' || c.method === 'plugins.revoke')).toBe(false)
  })

  it('pas d’avertissement réseau pour un plugin sans network ; révoquer passe par le canal revokePlugin', async () => {
    list = [CHANGED, IMPACT]
    await enable()
    await mount(dialog(true))
    await act(async () => buttons('Plugins')[0]!.click())
    await flush()
    await act(async () => buttons('Relire et accepter de nouveau…')[0]!.click())
    expect(document.querySelector('.pl-confirm [role="alert"]')).toBeNull()
    await act(async () => buttons('Annuler')[0]!.click())
    await act(async () => card('codegraph-impact').querySelector<HTMLButtonElement>('button.danger')!.click())
    await flush()
    expect(revokePlugin).toHaveBeenCalledWith({ name: 'codegraph-impact' })
  })
})

describe('capacité absente', () => {
  it('aucun onglet Plugins, aucun onglet de session de plugin, aucun appel plugins.*', async () => {
    await act(async () => {
      store.setPluginsEnabled(false)
    })
    await mount(dialog(false))
    expect(buttons('Plugins')).toHaveLength(0)
    await act(async () => buttons('Consignes')[0]!.click())
    expect(document.body.textContent).not.toContain('Actions des plugins actifs')
    await act(async () => store.reloadPlugins())
    expect(pluginCalls()).toHaveLength(0)
    act(() => root?.unmount())
    host?.remove()
    await mount(pane(fixtureSession(), []))
    expect([...document.querySelectorAll('[role="tab"]')].map((t) => t.id).filter((id) => id.includes('plugin:'))).toHaveLength(0)
    expect(pluginCalls()).toHaveLength(0)
  })
})

const noop = () => {}

function pane(session: ReturnType<typeof fixtureSession> | null, plugins: PluginInfo[]) {
  return createElement(SessionPane, {
    session,
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
    runnersSupported: true,
    runnersRunning: 0,
    onRunnersRunning: noop,
    onRunnersUnsupported: noop,
    plugins,
  })
}

const tabNamed = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((t) => t.querySelector('.tlabel')?.textContent === label)

describe('onglet de session plugin:<nom>', () => {
  it('ajouté à la première zone, panneau demandé avec la langue courante, chaque bloc rendu nativement', async () => {
    const s = fixtureSession({ branch: 'feat/impact' })
    await mount(pane(s, [IMPACT]))
    const tab = tabNamed('Impact')!
    expect(tab).toBeTruthy()
    // Distingué des onglets de l'app : marque « plugin » et nom accessible.
    expect(tab.querySelector('.tplug')!.textContent).toContain('plugin')
    expect(tab.getAttribute('aria-label')).toBe('Plugin codegraph-impact : Impact')
    expect(tabNamed('Terminal')!.getAttribute('aria-label')).toBeNull()
    expect(tab.id).toMatch(/plugin:codegraph-impact$/)
    expect(JSON.parse(localStorage.getItem('devmaestro.layout.zones')!).root.tabs).toContain('plugin:codegraph-impact')
    await act(async () => tab.click())
    await flush()
    expect(calls.find((c) => c.method === 'plugins.panel')!.params).toEqual({ name: 'codegraph-impact', session_id: s.id, locale: 'fr' })
    const panel = document.getElementById(tab.getAttribute('aria-controls')!)!
    expect(panel.textContent).toContain('Contenu fourni par un plugin (contenu tiers)')
    // Notice : icône et texte (pas seulement une couleur).
    const notice = panel.querySelector('.pd-notice.warning')!
    expect(notice.getAttribute('role')).toBe('note')
    expect(notice.textContent).toContain('Avertissement')
    expect(notice.textContent).toContain('Rust mal couvert')
    // Markdown sans HTML exécuté.
    const md = panel.querySelector('.pd-md')!
    expect(md.querySelector('script, img')).toBeNull()
    expect(md.textContent).toContain('<script>')
    expect(md.querySelector('strong')!.textContent).toBe('gras')
    expect((window as { __pwned?: unknown }).__pwned).toBeUndefined()
    // kv, liste
    expect(panel.querySelector('.pd-kv dt')!.textContent).toBe('Profondeur')
    expect(panel.querySelector('ol.pd-list li')!.textContent).toContain('a.test.ts')
  })

  it('tableau : en-têtes de colonnes, tri par le bouton de l’en-tête (aria-sort)', async () => {
    await mount(pane(fixtureSession(), [IMPACT]))
    await act(async () => tabNamed('Impact')!.click())
    await flush()
    const table = document.querySelector('.pd-table')!
    expect(table.querySelector('caption')!.textContent).toBe('Symboles')
    const col = (i: number) => [...table.querySelectorAll('tbody tr')].map((r) => r.querySelectorAll('td')[i]!.textContent)
    expect(col(0)).toEqual(['beta', 'alpha', 'gamma'])
    const ths = table.querySelectorAll<HTMLElement>('th[scope="col"]')
    expect(ths[1]!.getAttribute('aria-sort')).toBe('none')
    const sortBtn = ths[1]!.querySelector('button')!
    sortBtn.focus()
    expect(document.activeElement).toBe(sortBtn)
    await act(async () => sortBtn.click())
    expect(ths[1]!.getAttribute('aria-sort')).toBe('ascending')
    expect(col(1)).toEqual(['1', '2', '10'])
    await act(async () => sortBtn.click())
    expect(ths[1]!.getAttribute('aria-sort')).toBe('descending')
    expect(col(1)).toEqual(['10', '2', '1'])
    await act(async () => ths[0]!.querySelector('button')!.click())
    expect(col(0)).toEqual(['alpha', 'beta', 'gamma'])
    expect(ths[1]!.getAttribute('aria-sort')).toBe('none')
  })

  it('arbre : role tree/treeitem, flèches (bas, droite, gauche), un seul élément dans l’ordre de tabulation', async () => {
    await mount(pane(fixtureSession(), [IMPACT]))
    await act(async () => tabNamed('Impact')!.click())
    await flush()
    const tree = document.querySelector<HTMLElement>('[role="tree"]')!
    const items = () => [...tree.querySelectorAll<HTMLElement>('[role="treeitem"]')]
    expect(items().map((i) => i.querySelector('.pd-text')!.textContent)).toEqual(['src/a.rs', 'fn x', 'fn y', 'src/b.rs'])
    expect(items().filter((i) => i.tabIndex === 0)).toHaveLength(1)
    const first = items()[0]!
    expect(first.getAttribute('aria-expanded')).toBe('true')
    const key = async (el: HTMLElement, k: string) => act(async () => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })))
    first.focus()
    await key(first, 'ArrowLeft')
    expect(first.getAttribute('aria-expanded')).toBe('false')
    expect(items()).toHaveLength(2)
    await key(first, 'ArrowDown')
    expect(document.activeElement!.querySelector('.pd-text')!.textContent).toBe('src/b.rs')
    await key(document.activeElement as HTMLElement, 'ArrowUp')
    await key(document.activeElement as HTMLElement, 'ArrowRight')
    expect(items()[0]!.getAttribute('aria-expanded')).toBe('true')
    await key(document.activeElement as HTMLElement, 'ArrowRight')
    expect(document.activeElement!.querySelector('.pd-text')!.textContent).toBe('fn x')
    await key(document.activeElement as HTMLElement, 'ArrowLeft')
    expect(document.activeElement!.querySelector('.pd-text')!.textContent).toBe('src/a.rs')
  })

  it('document invalide : message traduit, rien du document affiché', async () => {
    replies['plugins.panel'] = () => ({ document: { blocks: [{ type: 'markdown', text: 'secret' }, { type: 'html', text: '<b>x</b>' }] } })
    await mount(pane(fixtureSession(), [IMPACT]))
    await act(async () => tabNamed('Impact')!.click())
    await flush()
    expect(document.body.textContent).toMatch(/Document du plugin refusé : blocks\[1\]\.type : type de bloc inconnu/)
    expect(document.body.textContent).not.toContain('secret')
  })

  it('défaillance du processus : erreur traduite, raison et fin de stderr', async () => {
    replies = {}
    ;(window as unknown as { devmaestro: { call: unknown } }).devmaestro.call = async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      if (method === 'plugins.panel') return { ok: false, error: { code: -32033, message: 'processus du plugin terminé', data: { reason: 'closed', stderr_tail: 'Erreur​ fatale' } } }
      return { ok: false, error: { code: -32601, message: 'inconnue' } }
    }
    try {
      await mount(pane(fixtureSession(), [IMPACT]))
      await act(async () => tabNamed('Impact')!.click())
      await flush()
      const err = document.querySelector('.pplug-err')!
      expect(err.textContent).toContain('le processus du plugin a échoué')
      expect(err.textContent).toContain('Le plugin a échoué : processus terminé.')
      expect(err.querySelector('.pd-stderr')!.textContent).toBe('Erreur fatale')
    } finally {
      ;(window as unknown as { devmaestro: { call: unknown } }).devmaestro.call = async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params })
        if (method === 'plugins.list') return { ok: true, result: { dir: '/home/u/.config/devmaestro/plugins', plugins: list } }
        const r = replies[method]
        return r ? { ok: true, result: r(params) } : { ok: false, error: { code: -32601, message: 'inconnue' } }
      }
    }
  })

  it('plugin plus actif : onglet masqué, sa place gardée dans la disposition', async () => {
    await mount(pane(fixtureSession(), [IMPACT]))
    expect(tabNamed('Impact')).toBeTruthy()
    await act(async () => root!.render(createElement(SettingsProvider, { initial: defaultSettings(), children: pane(fixtureSession(), []) })))
    await flush()
    expect(tabNamed('Impact')).toBeUndefined()
    expect(JSON.parse(localStorage.getItem('devmaestro.layout.zones')!).root.tabs).toContain('plugin:codegraph-impact')
  })

  it('redemande automatique selon refresh_ms, seulement onglet affiché', async () => {
    replies['plugins.panel'] = () => ({ document: { refresh_ms: 1000, blocks: [{ type: 'markdown', text: 'progression' }] } })
    await mount(pane(fixtureSession(), [IMPACT]))
    await act(async () => tabNamed('Impact')!.click())
    await flush()
    const panels = () => calls.filter((c) => c.method === 'plugins.panel').length
    expect(panels()).toBe(1)
    await act(async () => new Promise((r) => setTimeout(r, 1150)))
    await flush()
    expect(panels()).toBe(2)
    await act(async () => tabNamed('Terminal')!.click())
    await act(async () => new Promise((r) => setTimeout(r, 1150)))
    await flush()
    expect(panels()).toBe(2)
  })
})

describe('actions et « Envoyer à Claude »', () => {
  it('action avec args → plugins.action ; un document remplace le panneau', async () => {
    const s = fixtureSession()
    await mount(pane(s, [IMPACT]))
    await act(async () => tabNamed('Impact')!.click())
    await flush()
    await act(async () => buttons('Mettre à jour')[0]!.click())
    await flush()
    expect(calls.find((c) => c.method === 'plugins.action')!.params).toEqual({
      name: 'codegraph-impact',
      action: 'index',
      session_id: s.id,
      locale: 'fr',
      args: { full: true },
    })
    expect(document.body.textContent).toContain('Indexation lancée')
    expect(document.querySelector('.pd-table')).toBeNull()
  })

  it('propose : consigne tapée du registre (aucun texte du plugin), contenu collé en lecture seule, envoi seulement au clic', async () => {
    const s = fixtureSession({ branch: 'feat/impact' })
    await mount(pane(s, [IMPACT]))
    await act(async () => tabNamed('Impact')!.click())
    await flush()
    await act(async () => buttons('Envoyer à Claude').find((b) => b.closest('.pd-actions'))!.click())
    await flush()
    const instruction = document.querySelector('[data-testid="propose-instruction"]')!.textContent!
    expect(instruction).toBe(defaultPrompt('pluginPropose'))
    for (const third of ['codegraph-impact', 'Impact du diff', 'send-impact', 'Envoyer l’impact']) expect(instruction).not.toContain(third)
    const pasted = document.querySelector<HTMLElement>('[data-testid="propose-pasted"]')!
    expect(pasted.tagName).toBe('PRE')
    expect(pasted.textContent).toBe('# Impact\n\nSymboles touchés : 12\n<b>pas du HTML</b>')
    expect(pasted.querySelector('b')).toBeNull()
    expect(calls.some((c) => c.method === 'sessions.sendPrompt')).toBe(false)
    await act(async () => buttons('Envoyer')[0]!.click())
    await flush()
    expect(calls.filter((c) => c.method === 'sessions.sendPrompt').map((c) => c.params)).toEqual([
      { id: s.id, instruction: defaultPrompt('pluginPropose'), pasted: '# Impact\n\nSymboles touchés : 12\n<b>pas du HTML</b>' },
    ])
    expect(document.querySelector('[data-testid="propose-pasted"]')).toBeNull()
  })

  it('consigne surchargée pour cette action ; session arrêtée : « Envoyer » désactivé avec explication', async () => {
    const settings = defaultSettings()
    settings.prompts.global['pluginPropose:codegraph-impact:send-impact'] = 'Données de l’outil pour {branche}.'
    const s = fixtureSession({ branch: 'feat/impact', alive: false })
    await mount(pane(s, [IMPACT]), settings)
    await act(async () => tabNamed('Impact')!.click())
    await flush()
    await act(async () => buttons('Envoyer à Claude').find((b) => b.closest('.pd-actions'))!.click())
    await flush()
    expect(document.querySelector('[data-testid="propose-instruction"]')!.textContent).toBe('Données de l’outil pour feat/impact.')
    const send = buttons('Envoyer')[0]!
    expect(send.disabled).toBe(true)
    expect(document.getElementById(send.getAttribute('aria-describedby')!)!.textContent).toMatch(/La session est arrêtée/)
    await act(async () => send.click())
    expect(calls.some((c) => c.method === 'sessions.sendPrompt')).toBe(false)
  })
})

describe('Réglages → Consignes : entrées par action de plugin', () => {
  it('l’action propose d’un plugin actif a sa consigne surchargeable, qui retombe sur la générique', async () => {
    await enable()
    await mount(dialog(true))
    await act(async () => buttons('Consignes')[0]!.click())
    const heads = [...document.querySelectorAll('.prompt-ed h3')].map((h) => h.textContent)
    expect(heads).toContain('Contenu proposé par un plugin')
    expect(heads).toContain('Impact du diff : Envoyer l’impact')
    // Le plugin en échec (accepté, sans action propose) n'ajoute rien ; un plugin non actif non plus.
    expect(heads.filter((h) => h?.includes(' : ') && h.startsWith('Libellé'))).toHaveLength(0)
  })
})

describe('lot 22a, corrections après critique', () => {
  it('confirmation : commande, fichiers et config avec invisibles rendus visibles, focus initial sur « Annuler »', async () => {
    list = [
      plugin({
        name: 'sneaky',
        command: ['python3', 'run‮gnp.py'],
        files: ['run‮gnp.py', 'a​b.py'],
        config: { codegraph: '/usr/bin/x⁦', depth: 2 },
      }),
    ]
    await enable()
    await mount(dialog(true))
    await act(async () => buttons('Plugins')[0]!.click())
    await flush()
    await act(async () => card('sneaky').querySelector<HTMLButtonElement>('button.pri')!.click())
    await flush()
    const confirm = document.querySelector<HTMLElement>('.pl-confirm')!
    expect(confirm.querySelector('.pl-cmd')!.textContent).toBe('python3 run⟨U+202E⟩gnp.py')
    expect([...confirm.querySelectorAll('.pl-files li')].map((l) => l.textContent)).toEqual(['run⟨U+202E⟩gnp.py', 'a⟨U+200B⟩b.py'])
    expect(confirm.querySelector('.pl-config')!.textContent).toContain('/usr/bin/x⟨U+2066⟩')
    expect(confirm.textContent).not.toMatch(/[‮​⁦]/)
    expect(document.activeElement!.textContent).toBe('Annuler')
  })

  it('erreurs du manifeste : 20 au plus, « … et N autres », messages tronqués et nettoyés', async () => {
    const errors = Array.from({ length: 25 }, (_, i) => `erreur ${i}`)
    errors[0] = `longue‮ ${'x'.repeat(400)}`
    list = [plugin({ name: 'many', valid: false, fingerprint: null, errors })]
    await enable()
    await mount(dialog(true))
    await act(async () => buttons('Plugins')[0]!.click())
    await flush()
    const items = [...card('many').querySelectorAll('.pl-errors li')]
    expect(items).toHaveLength(21)
    expect(items[20]!.textContent).toBe('… et 5 autres')
    expect([...items[0]!.textContent!].length).toBeLessThanOrEqual(300)
    expect(items[0]!.textContent).not.toContain('‮')
  })

  it('dossier au nom invalide : montré comme plugin invalide avec ses erreurs, sans accord possible', async () => {
    list = [{ ...plugin({ name: 'Bad Name', errors: ['nom invalide : Bad Name'] }), valid: true, fingerprint: FP, acceptance: 'accepted' }]
    await enable()
    expect(store.getPlugins().plugins.map((p) => [p.name, p.valid, p.fingerprint, p.acceptance])).toEqual([['Bad Name', false, null, 'none']])
    await mount(dialog(true))
    await act(async () => buttons('Plugins')[0]!.click())
    await flush()
    const c = card('Bad Name')
    expect(c.textContent).toContain('manifeste invalide')
    expect(c.textContent).toContain('nom invalide : Bad Name')
    expect(c.querySelectorAll('button.pri')).toHaveLength(0)
    expect(store.activePlugins(store.getPlugins())).toHaveLength(0)
  })

  it('liens d’un document Markdown : http(s) par la confirmation des liens, autres inertes, ancres suivies', async () => {
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    replies['plugins.panel'] = () => ({
      document: {
        blocks: [
          { type: 'markdown', text: '# Haut\n\n[web](https://exemple.org/a) [js](javascript:alert(1)) [fichier](file:///etc/passwd) [ancre](#haut)' },
        ],
      },
    })
    const onLink = vi.fn()
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    const el = pane(fixtureSession(), [IMPACT])
    await act(async () => root!.render(createElement(SettingsProvider, { initial: defaultSettings(), children: { ...el, props: { ...el.props, onLink } } })))
    await flush()
    await act(async () => tabNamed('Impact')!.click())
    await flush()
    const link = (text: string) => [...document.querySelectorAll<HTMLAnchorElement>('.pd-md a')].find((a) => a.textContent === text)
    await act(async () => link('web')!.click())
    expect(onLink).toHaveBeenCalledWith('https://exemple.org/a')
    onLink.mockClear()
    // markdown-it ne fait pas de lien javascript: ; un lien file: est inerte.
    expect(link('js')).toBeUndefined()
    const file = link('fichier')
    if (file) await act(async () => file.click())
    expect(onLink).not.toHaveBeenCalled()
    await act(async () => link('ancre')!.click())
    expect(scroll).toHaveBeenCalled()
    expect(onLink).not.toHaveBeenCalled()
  })
})
