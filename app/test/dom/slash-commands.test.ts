// @vitest-environment jsdom
/**
 * Slash commands dans le champ de saisie (lot 17), rendu React : ouverture à
 * `/` en tête, clavier (↑ / ↓, Tab, Entrée, Échap), clic, attributs ARIA,
 * chargement par `commands.list` à chaque ouverture, repli sur la liste
 * intégrée (capacité absente, `-32601`), historique non détourné.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { CommandsList } from '../../src/shared/protocol'
import { session } from '../fixtures'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type View = typeof import('../../src/renderer/src/components/ConversationView')
let Composer: View['Composer']
let forgetComposerMemory: View['forgetComposerMemory']

class RpcError {
  constructor(
    readonly code: number,
    readonly message: string,
  ) {}
}

type Handler = (method: string, params: Record<string, unknown>) => unknown
let handler: Handler = () => ({})
const calls: { method: string; params: Record<string, unknown> }[] = []
const sent: string[] = []

beforeAll(async () => {
  ;(window as unknown as { devmaestro: object }).devmaestro = {
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      try {
        return { ok: true, result: await handler(method, params) }
      } catch (e) {
        if (e instanceof RpcError) return { ok: false, error: { code: e.code, message: e.message } }
        throw e
      }
    },
    onNotification: () => () => {},
    onConnection: () => () => {},
  }
  ;({ Composer, forgetComposerMemory } = await import('../../src/renderer/src/components/ConversationView'))
})

let root: Root | null = null
let host: HTMLElement | null = null

beforeEach(() => {
  calls.length = 0
  sent.length = 0
  handler = () => ({})
  forgetComposerMemory()
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
})

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

const S = session()

async function render(slashCommands: boolean | null) {
  host = document.createElement('div')
  host.className = 'cv'
  document.body.append(host)
  root = createRoot(host)
  act(() =>
    root!.render(
      createElement(Composer, {
        session: S,
        slashCommands,
        onSend: async (t: string) => {
          sent.push(t)
        },
      }),
    ),
  )
  await flush()
}

const ta = () => host!.querySelector('textarea')!
const listbox = () => host!.querySelector<HTMLElement>('[role="listbox"]')
const options = () => [...host!.querySelectorAll<HTMLElement>('[role="option"]')]
const names = () => options().map((o) => o.querySelector('.slash-name')!.textContent)
const selected = () => options().find((o) => o.getAttribute('aria-selected') === 'true')

function focus() {
  act(() => ta().focus())
}

function type(text: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(ta(), text)
    ta().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function key(k: string, opts: KeyboardEventInit = {}): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts })
  act(() => {
    ta().dispatchEvent(ev)
  })
  return ev
}

const list = (commands: CommandsList['commands']): CommandsList => ({ commands, claude_code_version: '2.1.306', truncated: false })

describe('liste des slash commands', () => {
  it('s’ouvre à « / » en tête, se filtre, se parcourt et complète (liste intégrée, sans appel)', async () => {
    await render(null)
    focus()
    type('/')
    expect(listbox()).not.toBeNull()
    expect(options().length).toBeGreaterThan(20)
    expect(calls.filter((c) => c.method === 'commands.list')).toHaveLength(0)
    // ARIA : le champ désigne la liste et l'option choisie.
    expect(ta().getAttribute('aria-autocomplete')).toBe('list')
    expect(ta().getAttribute('aria-controls')).toBe(listbox()!.id)
    expect(ta().getAttribute('aria-activedescendant')).toBe(options()[0]!.id)
    expect(host!.querySelector('[aria-live="polite"]')!.textContent).toMatch(/commandes proposées/)

    type('/con')
    expect(names().slice(0, 2)).toEqual(['/config', '/context'])
    type('/co')
    expect(names().slice(0, 5)).toEqual(['/color', '/compact', '/config', '/context', '/copy'])
    key('ArrowDown')
    expect(ta().getAttribute('aria-activedescendant')).toBe(options()[1]!.id)
    key('ArrowUp')
    key('ArrowUp')
    // En boucle : de la première à la dernière.
    expect(selected()).toBe(options().at(-1))
    key('ArrowDown')
    key('ArrowDown')
    expect(selected()?.querySelector('.slash-name')!.textContent).toBe('/compact')
    const tab = key('Tab')
    expect(tab.defaultPrevented).toBe(true)
    // `/compact` attend des arguments : espace ajouté, la liste se ferme.
    expect(ta().value).toBe('/compact ')
    expect(listbox()).toBeNull()
    type('/conf')
    key('Tab')
    expect(ta().value).toBe('/config')
    expect(listbox()).not.toBeNull()
    expect(sent).toEqual([])
    // Le mot est exactement la commande choisie : Entrée envoie.
    key('Enter')
    await flush()
    expect(sent).toEqual(['/config'])
    expect(listbox()).toBeNull()
  })

  it('Entrée complète un mot partiel ; espace si la commande attend des arguments ; commande interactive signalée', async () => {
    await render(null)
    focus()
    type('/mode')
    const model = options().find((o) => o.querySelector('.slash-name')!.textContent === '/model')!
    expect(model.textContent).toContain('s’ouvre dans le terminal')
    expect(model.textContent).toContain('intégrée')
    key('Enter')
    expect(ta().value).toBe('/model ')
    expect(sent).toEqual([])
    // Curseur après l'espace : hors du premier mot, la liste se ferme.
    expect(listbox()).toBeNull()
  })

  it('Échap ferme la liste seulement, jusqu’au prochain changement du mot', async () => {
    await render(null)
    let outside = 0
    const onDoc = () => outside++
    document.addEventListener('keydown', onDoc)
    try {
      focus()
      type('/cl')
      expect(listbox()).not.toBeNull()
      const esc = key('Escape')
      expect(esc.defaultPrevented).toBe(true)
      expect(outside).toBe(0)
      expect(listbox()).toBeNull()
      expect(ta().getAttribute('aria-activedescendant')).toBeNull()
      // Liste fermée : Entrée envoie le texte tel quel.
      type('/cle')
      expect(listbox()).not.toBeNull()
      key('Escape')
      key('Enter')
      await flush()
      expect(sent).toEqual(['/cle'])
    } finally {
      document.removeEventListener('keydown', onDoc)
    }
  })

  it('un « / » ailleurs qu’en tête ne fait rien ; un clic complète', async () => {
    handler = (m) =>
      m === 'commands.list' ? list([{ name: 'review', source: 'project', kind: 'command', argument_hint: '[n]' }]) : {}
    await render(true)
    focus()
    type('voir /compact')
    expect(listbox()).toBeNull()
    type('/rev')
    await flush()
    expect(names()).toEqual(['/review'])
    const opt = options()[0]!
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    act(() => {
      opt.dispatchEvent(down)
      opt.click()
    })
    expect(down.defaultPrevented).toBe(true)
    expect(ta().value).toBe('/review ')
    expect(document.activeElement).toBe(ta())
  })

  it('une intégrée n’est jamais masquée : la reprise est montrée à côté, marquée ; mention des bornes', async () => {
    handler = (m) =>
      m === 'commands.list'
        ? {
            ...list([
              { name: 'compact', source: 'builtin', kind: 'command', description: 'Libérer du contexte' },
              { name: 'compact', source: 'project', kind: 'command', description: 'Version du dépôt', conflict: 'builtin' },
            ]),
            truncated: true,
            ignored: 2,
          }
        : {}
    await render(true)
    focus()
    type('/compact')
    await flush()
    expect(names()).toEqual(['/compact', '/compact'])
    expect(options()[0]!.textContent).toContain('intégrée')
    expect(options()[0]!.textContent).not.toContain('même nom')
    expect(options()[1]!.textContent).toContain('projet')
    expect(options()[1]!.textContent).toContain('même nom qu’une commande intégrée')
    expect(host!.textContent).toContain('Liste incomplète')
    expect(host!.textContent).toContain('2 fichiers ignorés')
    // Le choix par défaut est l'intégrée ; Entrée l'envoie.
    expect(selected()).toBe(options()[0])
    key('Enter')
    await flush()
    expect(sent).toEqual(['/compact'])
  })

  it('Entrée sur un alias exact envoie', async () => {
    await render(null)
    focus()
    type('/reset')
    expect(selected()?.querySelector('.slash-name')!.textContent).toBe('/clear')
    key('Enter')
    await flush()
    expect(sent).toEqual(['/reset'])
  })

  it('pas de liste sans le focus ni sur un champ bloqué', async () => {
    await render(null)
    type('/co')
    expect(listbox()).toBeNull()
    act(() => root!.unmount())
    root = createRoot(host!)
    act(() =>
      root!.render(createElement(Composer, { session: { ...S, alive: false }, slashCommands: null, onSend: async () => {} })),
    )
    focus()
    type('/co')
    expect(listbox()).toBeNull()
  })

  it('avec la capacité : commands.list à chaque ouverture, sources affichées', async () => {
    handler = (m) =>
      m === 'commands.list'
        ? list([
            { name: 'compact', source: 'builtin', kind: 'command' },
            { name: 'revue', source: 'project', kind: 'command', description: 'Revue du projet', argument_hint: '[fichier]' },
            { name: 'forge:grill', source: 'plugin', kind: 'skill', plugin: 'forge' },
          ])
        : {}
    await render(true)
    focus()
    type('/')
    await flush()
    expect(calls.filter((c) => c.method === 'commands.list')).toEqual([{ method: 'commands.list', params: { id: S.id } }])
    expect(names()).toEqual(['/compact', '/revue', '/forge:grill'])
    expect(options()[1]!.textContent).toContain('projet')
    expect(options()[1]!.textContent).toContain('Revue du projet')
    expect(options()[2]!.textContent).toContain('plugin forge, skill')
    // Frappe : pas de nouvel appel.
    type('/g')
    type('/gr')
    expect(calls.filter((c) => c.method === 'commands.list')).toHaveLength(1)
    expect(names()).toEqual(['/forge:grill'])
    // Fermée puis rouverte : relue.
    type('')
    type('/')
    await flush()
    expect(calls.filter((c) => c.method === 'commands.list')).toHaveLength(2)
  })

  it('démon sans la méthode (-32601) ou sans la capacité : liste intégrée et mention', async () => {
    handler = () => {
      throw new RpcError(-32601, 'méthode inconnue')
    }
    await render(true)
    focus()
    type('/')
    await flush()
    expect(names()).toContain('/compact')
    expect(host!.textContent).toContain('Démon ancien : seules les commandes intégrées sont proposées.')
    // Plus d'appel une fois le refus connu.
    type('')
    type('/')
    await flush()
    expect(calls.filter((c) => c.method === 'commands.list')).toHaveLength(1)

    act(() => root!.unmount())
    host!.remove()
    calls.length = 0
    await render(false)
    focus()
    type('/')
    await flush()
    expect(calls).toHaveLength(0)
    expect(names()).toContain('/model')
    expect(host!.textContent).toContain('Démon ancien')
  })

  it('échec de la lecture : liste intégrée et raison', async () => {
    handler = () => {
      throw new RpcError(-32001, 'session inconnue')
    }
    await render(true)
    focus()
    type('/')
    await flush()
    expect(names()).toContain('/compact')
    expect(host!.textContent).toContain('Liste des commandes indisponible (')
    expect(host!.textContent).toContain('session inconnue')
    expect(host!.textContent).toContain('commandes intégrées seulement')
  })

  it('l’historique ↑ / ↓ n’est pas détourné par un prompt « / » rappelé', async () => {
    await render(null)
    focus()
    type('premier')
    key('Enter')
    await flush()
    type('/compact')
    key('Enter')
    await flush()
    expect(sent).toEqual(['premier', '/compact'])
    key('ArrowUp')
    expect(ta().value).toBe('/compact')
    expect(listbox()).toBeNull()
    key('ArrowUp')
    expect(ta().value).toBe('premier')
  })
})
