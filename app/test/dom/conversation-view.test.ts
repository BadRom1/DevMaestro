// @vitest-environment jsdom
/**
 * Onglet « Conversation » rendu avec React (lots 11 et 12) : chaque type
 * d'entrée et le repli « inconnu », contenu hostile, virtualisation (nœuds
 * bornés sur 5 000 entrées), défilement collé et « Aller en bas », chargement
 * en remontant, fusion des notifications, saisie (Entrée, Maj+Entrée,
 * historique, refus, prompt en attente), indicateur d'activité.
 *
 * jsdom n'a pas de mise en page : la hauteur de la fenêtre est imposée
 * (`viewportHeight`) et `scrollTop` / `scrollHeight` / `clientHeight` du fil
 * sont simulés à partir de la hauteur calculée de la liste.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ConversationEntry, ConversationPage, Notification, Session } from '../../src/shared/protocol'
import { session } from '../fixtures'
import { normalizeTranscript } from '../conversation-fixture'
import transcript from '../../../spikes/05-vue-conversation/fixtures/transcripts/f413d189-39c7-41ff-aeb1-4df75e059737.jsonl?raw'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type View = typeof import('../../src/renderer/src/components/ConversationView')
let ConversationView: View['ConversationView']
let forgetComposerMemory: View['forgetComposerMemory']

type Handler = (method: string, params: Record<string, unknown>) => unknown
let handler: Handler = () => ({ segments: [], entries: [], has_more: false })
const calls: { method: string; params: Record<string, unknown> }[] = []
const notifListeners = new Set<(n: Notification) => void>()
const connListeners = new Set<(c: { state: string }) => void>()

class RpcError {
  constructor(
    readonly code: number,
    readonly message: string,
  ) {}
}

/* ---------- Défilement simulé ---------- */

const VIEWPORT = 800
/** Hauteur de la fenêtre simulée (celle passée à `viewportHeight`). */
let viewportNow = VIEWPORT
const tops = new WeakMap<Element, number>()
const isFeed = (el: Element) => el.classList.contains('cv-scroll')
const feedHeight = (el: Element) => parseFloat((el.querySelector('.cv-list') as HTMLElement | null)?.style.height ?? '0') || 0
const saved: Record<string, PropertyDescriptor | undefined> = {}

beforeAll(async () => {
  for (const k of ['scrollTop', 'scrollHeight', 'clientHeight']) saved[k] = Object.getOwnPropertyDescriptor(Element.prototype, k)
  Object.defineProperty(Element.prototype, 'clientHeight', {
    configurable: true,
    get(this: Element) {
      return isFeed(this) ? viewportNow : 0
    },
  })
  Object.defineProperty(Element.prototype, 'scrollHeight', {
    configurable: true,
    get(this: Element) {
      return isFeed(this) ? Math.max(viewportNow, feedHeight(this)) : 0
    },
  })
  Object.defineProperty(Element.prototype, 'scrollTop', {
    configurable: true,
    get(this: Element) {
      return tops.get(this) ?? 0
    },
    set(this: Element, v: number) {
      const max = Math.max(0, this.scrollHeight - this.clientHeight)
      tops.set(this, Math.min(Math.max(0, v), max))
    },
  })
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
    onNotification: (cb: (n: Notification) => void) => {
      notifListeners.add(cb)
      return () => void notifListeners.delete(cb)
    },
    onConnection: (cb: (c: { state: string }) => void) => {
      connListeners.add(cb)
      return () => void connListeners.delete(cb)
    },
  }
  ;({ ConversationView, forgetComposerMemory } = await import('../../src/renderer/src/components/ConversationView'))
})

afterAll(() => {
  for (const [k, d] of Object.entries(saved)) {
    if (d) Object.defineProperty(Element.prototype, k, d)
  }
})

let root: Root | null = null
let host: HTMLElement | null = null
const links: string[] = []

beforeEach(() => {
  calls.length = 0
  links.length = 0
  forgetComposerMemory()
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
  notifListeners.clear()
  connListeners.clear()
})

const pageOf = (entries: ConversationEntry[], has_more = false): ConversationPage => ({
  segments: [
    { segment: 0, claude_session_id: 'c1', reason: 'start', started_at: null },
    { segment: 1, claude_session_id: 'c2', reason: 'clear', started_at: null },
  ],
  entries,
  has_more,
  invalid_lines: 0,
})

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

async function render(s: Session, viewportHeight = VIEWPORT, hidden = false) {
  viewportNow = viewportHeight
  if (!root) {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  }
  act(() => root!.render(createElement(ConversationView, { session: s, onLink: (u: string) => links.push(u), viewportHeight, hidden })))
  await flush()
}

function notify(id: string, upserts: ConversationEntry[], segment_started?: unknown) {
  act(() => {
    for (const l of notifListeners) l({ method: 'conversation.changed', params: { id, upserts, segment_started } } as Notification)
  })
}

const feed = () => host!.querySelector<HTMLElement>('.cv-scroll')!
const items = () => [...host!.querySelectorAll<HTMLElement>('.cv-item')]
const button = (label: string) => [...host!.querySelectorAll('button')].find((b) => b.textContent?.includes(label))

function scrollTo(top: number) {
  act(() => {
    feed().scrollTop = top
    feed().dispatchEvent(new Event('scroll'))
  })
}

function type(text: string) {
  const ta = host!.querySelector('textarea')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(ta, text)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function key(k: string, opts: KeyboardEventInit = {}) {
  const ta = host!.querySelector('textarea')!
  act(() => {
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }))
  })
}

const base = { ts: '2026-10-20T10:00:00Z', segment: 0 }
const t = (uid: string, markdown: string, segment = 0): ConversationEntry => ({ ...base, uid, kind: 'text', markdown, segment })

function allKinds(): ConversationEntry[] {
  return [
    { ...base, uid: 'p', kind: 'prompt', text: 'Corrige le calcul', source: 'typed', pasted: [{ id: 'd1', text: 'l1\nl2\nl3' }] },
    { ...base, uid: 'th', kind: 'thinking' },
    t('tx', '## Plan\n\nJe **lis** le fichier.'),
    {
      ...base,
      uid: 'ed',
      kind: 'tool',
      tool_use_id: 'tu1',
      name: 'Edit',
      summary: 'calcul.py',
      input: { file_path: 'calcul.py', old_string: 'a', new_string: 'b' },
      result: { status: 'ok', text: 'Fichier modifié', truncated: false, patch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] },
    },
    { ...base, uid: 'bs', kind: 'tool', tool_use_id: 'tu2', name: 'Bash', summary: 'pytest', input: { command: 'pytest' }, result: { status: 'error', text: '1 failed', truncated: false } },
    { ...base, uid: 'rd', kind: 'tool', tool_use_id: 'tu3', name: 'Read', summary: 'LISEZMOI.md', input: {} },
    {
      ...base,
      uid: 'q',
      kind: 'question',
      tool_use_id: 'tu4',
      questions: [{ question: 'Thé ou café ?', header: 'Boisson', options: [{ label: 'Thé' }, { label: 'Café' }] }],
      answers: { 'Thé ou café ?': 'Café' },
    },
    { ...base, uid: 'sa', kind: 'subagent', tool_use_id: 'tu5', agent_id: 'a413854c8aebbc6cf', agent_type: 'Explore', description: 'Compter les .txt', status: 'done' },
    { ...base, uid: 'no', kind: 'notification', task_id: 'a41', status: 'completed', summary: 'Agent « Compter » terminé' },
    { ...base, uid: 'cp', kind: 'compaction', trigger: 'manual', pre_tokens: 49233, post_tokens: 18235, summary: 'Résumé **court**' },
    { ...base, uid: 'cm', kind: 'command', name: '/compact', args: null, output: 'Compacted' },
    { ...base, uid: 'er', kind: 'error', message: 'Erreur de l’API (529)' },
    { ...base, uid: 'un', kind: 'unknown', type: 'system', subtype: 'nouveau_type' },
    t('cl', 'Après le clear', 1),
  ]
}

describe('rendu de chaque type d’entrée', () => {
  it('fil complet : prompt et collage, réflexion, Markdown, outils repliés, question, sous-agent, notification, compaction, commande, erreur, repli, /clear', async () => {
    const s = session()
    handler = () => pageOf(allKinds())
    await render(s, 100_000)
    const text = host!.textContent!
    expect(calls[0]).toEqual({ method: 'conversation.get', params: { id: s.id, limit: 200 } })
    expect(text).toContain('Corrige le calcul')
    expect(text).toContain('Collage d1')
    expect(text).toContain('Claude a réfléchi')
    expect(host!.querySelector('.cv-md h2')?.textContent).toBe('Plan')
    expect(host!.querySelector('.cv-md strong')?.textContent).toBe('lis')
    // Outils repliés en une ligne : nom, résumé, statut en texte.
    const edit = button('Edit')!
    expect(edit.getAttribute('aria-expanded')).toBe('false')
    expect(edit.textContent).toContain('calcul.py')
    expect(edit.textContent).toContain('réussi')
    expect(button('Bash')!.textContent).toContain('erreur')
    expect(button('Read')!.textContent).toContain('en cours')
    expect(text).not.toContain('Fichier modifié')
    // Question avec la réponse choisie (glyphe et texte, pas seulement la couleur).
    const chosen = host!.querySelector('.cv-opts li.chosen')!
    expect(chosen.textContent).toContain('Café')
    expect(chosen.textContent).toContain('(choisi)')
    expect(button('Explore')!.textContent).toContain('terminé')
    expect(text).toContain('Tâche terminée')
    expect(text).toContain('Conversation compactée (manuelle) · 49 k → 18 k tokens')
    expect(text).toContain('/compact')
    expect(host!.querySelector('.cv-error')?.textContent).toContain('Erreur de l’API (529)')
    expect(host!.querySelector('.cv-unknown')?.textContent).toContain('system / nouveau_type')
    expect(host!.querySelector('.cv-clear')?.textContent).toBe('Nouvelle conversation (/clear)')
  })

  it('outil déplié : entrée, diff de l’Edit (lecteur de diff, sans commentaire), résultat', async () => {
    handler = () => pageOf(allKinds())
    await render(session(), 100_000)
    act(() => button('Edit')!.click())
    expect(button('Edit')!.getAttribute('aria-expanded')).toBe('true')
    const body = host!.querySelector('.cv-tool.open')!
    expect(body.textContent).toContain('"old_string": "a"')
    expect(body.querySelector('table.code tr.del')?.textContent).toContain('a')
    expect(body.querySelector('table.code tr.add')?.textContent).toContain('b')
    expect(body.querySelector('table.code td.cbtn button')).toBeNull()
    expect(body.textContent).toContain('Fichier modifié')
  })

  it('/clear masqué par le démon (hidden_by_segment) : pas affiché, le séparateur reste ; absent : affiché', async () => {
    const clear = (hidden?: boolean): ConversationEntry => ({
      ...base,
      uid: 'clr',
      kind: 'command',
      segment: 1,
      name: '/clear',
      args: null,
      output: null,
      ...(hidden === undefined ? {} : { hidden_by_segment: hidden }),
    })
    handler = () => pageOf([t('a', 'Avant'), clear(true), t('b', 'Après', 1)])
    await render(session(), 100_000)
    expect(items().map((i) => i.dataset.uid)).toEqual(['a', 'b'])
    expect(host!.querySelector('.cv-clear')?.textContent).toBe('Nouvelle conversation (/clear)')
    act(() => root!.unmount())
    root = null
    handler = () => pageOf([t('a', 'Avant'), clear(), t('b', 'Après', 1)])
    await render(session(), 100_000)
    expect(items().map((i) => i.dataset.uid)).toEqual(['a', 'clr', 'b'])
  })

  it('fil d’un sous-agent : sa consigne (prompt système) vient de Claude, pas de « Toi »', async () => {
    const s = session()
    const agent = 'a413854c8aebbc6cf'
    handler = (m) =>
      m === 'conversation.subagent'
        ? pageOf([
            { ...base, uid: 'sp', kind: 'prompt', text: 'Compte les fichiers .txt', source: 'system', agent_id: agent },
            { ...t('s1', 'Je compte.'), agent_id: agent },
          ])
        : pageOf(allKinds())
    await render(s, 100_000)
    act(() => button('Explore')!.click())
    await flush()
    const who = host!.querySelector('.cv-thread .cv-who')!
    expect(who.textContent).toContain('Claude (agent parent)')
    expect(who.textContent).not.toContain('Toi')
    expect(who.textContent).not.toContain('système')
    // Fil principal : le prompt tapé reste « Toi ».
    expect(host!.querySelector('[data-uid="p"] .cv-who')?.textContent).toContain('Toi')
  })

  it('sous-agent replié, chargé à l’ouverture puis tenu à jour', async () => {
    const s = session()
    handler = (m) =>
      m === 'conversation.subagent'
        ? pageOf([{ ...t('s1', 'Je compte les fichiers.'), agent_id: 'a413854c8aebbc6cf' }])
        : pageOf(allKinds())
    await render(s, 100_000)
    expect(calls.some((c) => c.method === 'conversation.subagent')).toBe(false)
    act(() => button('Explore')!.click())
    await flush()
    expect(calls.find((c) => c.method === 'conversation.subagent')?.params).toEqual({ id: s.id, agent_id: 'a413854c8aebbc6cf', limit: 200 })
    expect(host!.querySelector('.cv-thread')?.textContent).toContain('Je compte les fichiers.')
    notify(s.id, [{ ...t('s2', 'Il y en a 3.'), agent_id: 'a413854c8aebbc6cf' }])
    expect(host!.querySelector('.cv-thread')?.textContent).toContain('Il y en a 3.')
    // L'entrée du sous-agent ne va pas dans le fil principal.
    expect(items().some((i) => i.dataset.uid === 's2')).toBe(false)
  })

  it('gros résultat coupé par le démon : « Voir tout » lit conversation.full', async () => {
    const s = session()
    const big: ConversationEntry = {
      ...base,
      uid: 'big',
      kind: 'tool',
      tool_use_id: 'x',
      name: 'Bash',
      summary: 'cat',
      input: {},
      result: { status: 'ok', text: 'début', truncated: true },
    }
    handler = (m) => (m === 'conversation.full' ? { text: 'début et fin entière' } : pageOf([big]))
    await render(s, 100_000)
    act(() => button('Bash')!.click())
    act(() => button('Voir tout')!.click())
    await flush()
    expect(calls.find((c) => c.method === 'conversation.full')?.params).toEqual({ id: s.id, uid: 'big', part: 'result' })
    expect(host!.textContent).toContain('début et fin entière')
  })

  it('fixture réelle du prototype : rendue sans repli ni erreur', async () => {
    const entries = normalizeTranscript(transcript)
    handler = () => pageOf(entries)
    await render(session(), 1_000_000)
    expect(items()).toHaveLength(entries.length)
    expect(host!.querySelector('.cv-unknown')).toBeNull()
    expect(host!.textContent).toContain('Conversation compactée')
  })

  it('démon trop ancien : message clair, pas d’erreur', async () => {
    handler = () => {
      throw new RpcError(-32601, 'Method not found')
    }
    await render(session())
    expect(host!.textContent).toContain('mets orchd à jour')
  })
})

describe('contenu hostile', () => {
  it('jamais de HTML brut ; liens par la confirmation de l’app, javascript: inerte', async () => {
    const evil = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>'
    handler = () =>
      pageOf([
        { ...base, uid: 'p', kind: 'prompt', text: evil, source: 'typed', pasted: [] },
        t('m', `${evil}\n\n[ok](https://exemple.fr) et [mal](javascript:alert(1))`),
        { ...base, uid: 'b', kind: 'tool', tool_use_id: 'x', name: '<b>Bash</b>', summary: evil, input: { cmd: evil }, result: { status: 'ok', text: evil } },
        { ...base, uid: 'u', kind: 'unknown', type: evil, subtype: null },
        { ...base, uid: 'q', kind: 'question', tool_use_id: 'y', questions: [{ question: evil, options: [{ label: evil }] }] },
      ])
    await render(session(), 100_000)
    act(() => button('Bash')!.click())
    expect(host!.querySelector('img, script, b:not(.cv-tname)')).toBeNull()
    expect((window as { __pwned?: number }).__pwned).toBeUndefined()
    expect(host!.textContent).toContain('<img src=x')
    const anchors = [...host!.querySelectorAll<HTMLAnchorElement>('.cv-md a')]
    act(() => anchors.find((a) => a.textContent === 'ok')!.click())
    expect(links).toEqual(['https://exemple.fr'])
    // markdown-it refuse les liens javascript: : ils restent du texte, sans lien.
    expect(anchors.find((a) => a.textContent === 'mal')).toBeUndefined()
    expect(host!.textContent).toContain('[mal](javascript:alert(1))')
    expect(links).toEqual(['https://exemple.fr'])
  })
})

describe('virtualisation et défilement', () => {
  const many = (n: number, from = 0) => Array.from({ length: n }, (_, i) => t(`e${from + i}`, `Entrée numéro ${from + i}`))

  it('5 000 entrées : nœuds rendus bornés, collée en bas au chargement', async () => {
    handler = () => pageOf(many(5000))
    await render(session())
    const rendered = items()
    expect(rendered.length).toBeGreaterThan(5)
    expect(rendered.length).toBeLessThan(60)
    expect(host!.querySelectorAll('*').length).toBeLessThan(800)
    expect(rendered.at(-1)!.dataset.uid).toBe('e4999')
    expect(button('Aller en bas')).toBeUndefined()
  })

  it('remontée : « Aller en bas » apparaît, les nouvelles entrées ne font pas défiler ; collée de nouveau après le bouton', async () => {
    const s = session()
    handler = () => pageOf(many(500))
    await render(s)
    scrollTo(2000)
    expect(button('Aller en bas')).toBeDefined()
    const top = feed().scrollTop
    notify(s.id, [t('neuf', 'Nouvelle entrée')])
    expect(feed().scrollTop).toBe(top)
    expect(items().some((i) => i.dataset.uid === 'neuf')).toBe(false)
    act(() => button('Aller en bas')!.click())
    expect(button('Aller en bas')).toBeUndefined()
    expect(items().at(-1)!.dataset.uid).toBe('neuf')
    notify(s.id, [t('neuf2', 'Encore une')])
    expect(items().at(-1)!.dataset.uid).toBe('neuf2')
  })

  it('collée en bas : la fenêtre rétrécit (zone des demandes), notre défilement rattrapé ne décolle pas le fil', async () => {
    handler = () => pageOf(many(500))
    await render(session())
    const max = () => feed().scrollHeight - feed().clientHeight
    expect(feed().scrollTop).toBe(max())
    try {
      // La zone des demandes s'ouvre : 200 px de moins ; l'événement de défilement arrive après, sans remontée.
      viewportNow = VIEWPORT - 200
      act(() => feed().dispatchEvent(new Event('scroll')))
      expect(feed().scrollTop).toBe(max())
      expect(button('Aller en bas')).toBeUndefined()
      // Une vraie remontée, elle, décolle le fil.
      scrollTo(feed().scrollTop - 300)
      expect(button('Aller en bas')).toBeDefined()
    } finally {
      viewportNow = VIEWPORT
    }
  })

  it('collée en bas : chaque changement de taille du fil y recolle, tant que l’utilisateur n’a pas remonté', async () => {
    type Cb = () => void
    const made: { cb: Cb; targets: Set<Element> }[] = []
    class FakeRO {
      targets = new Set<Element>()
      constructor(readonly cb: Cb) {
        made.push(this)
      }
      observe(t: Element) {
        this.targets.add(t)
      }
      unobserve(t: Element) {
        this.targets.delete(t)
      }
      disconnect() {
        this.targets.clear()
      }
    }
    const g = globalThis as { ResizeObserver?: unknown }
    const before = g.ResizeObserver
    g.ResizeObserver = FakeRO
    try {
      handler = () => pageOf(many(500))
      await render(session())
      const ro = made.find((m) => m.targets.has(feed()))!
      expect(ro).toBeDefined()
      const max = () => feed().scrollHeight - feed().clientHeight
      viewportNow = VIEWPORT - 250
      act(() => ro.cb())
      expect(feed().scrollTop).toBe(max())
      // Remonté : un changement de taille ne le ramène plus en bas.
      scrollTo(1000)
      viewportNow = VIEWPORT - 100
      act(() => ro.cb())
      expect(feed().scrollTop).toBe(1000)
    } finally {
      g.ResizeObserver = before
      viewportNow = VIEWPORT
    }
  })

  it('en haut du fil : les entrées plus anciennes sont demandées avec le curseur, la ligne lue reste en place', async () => {
    const s = session()
    handler = (_m, p) => (p.before ? pageOf(many(200, 0), false) : pageOf(many(300, 200), true))
    await render(s)
    // Toutes les entrées ont la même hauteur estimée : position de e200 = 200 × h.
    const h = feedHeight(feed()) / 300
    scrollTo(0)
    // Avant : e200 est en haut de la fenêtre (position 0 à l'écran).
    expect(items()[0]!.dataset.uid).toBe('e200')
    await flush()
    const older = calls.filter((c) => c.method === 'conversation.get' && c.params.before)
    expect(older).toHaveLength(1)
    expect(older[0]!.params).toEqual({ id: s.id, before: 'e200', limit: 200 })
    // Après : 200 entrées ajoutées au-dessus, e200 toujours en haut de la fenêtre.
    expect(feedHeight(feed())).toBeCloseTo(500 * h)
    expect(feed().scrollTop).toBeCloseTo(200 * h)
    expect(items().some((i) => i.dataset.uid === 'e200')).toBe(true)
    expect(button('Charger les entrées plus anciennes')).toBeUndefined()
  })
})

describe('saisie', () => {
  it('Entrée envoie, Maj+Entrée non ; prompt en attente jusqu’à son arrivée ; historique ↑', async () => {
    const s = session()
    handler = (m) => (m === 'sessions.sendPrompt' ? { sent: true } : pageOf([t('a', 'Bonjour')]))
    await render(s)
    key('Enter')
    expect(calls.some((c) => c.method === 'sessions.sendPrompt')).toBe(false)
    type('Ajoute un test')
    key('Enter', { shiftKey: true })
    expect(calls.some((c) => c.method === 'sessions.sendPrompt')).toBe(false)
    key('Enter')
    await flush()
    expect(calls.find((c) => c.method === 'sessions.sendPrompt')?.params).toEqual({ id: s.id, text: 'Ajoute un test' })
    expect(host!.querySelector('textarea')!.value).toBe('')
    const pending = host!.querySelector('.cv-pending')!
    expect(pending.textContent).toContain('Ajoute un test')
    expect(pending.textContent).toContain('en attente du transcript')
    notify(s.id, [{ ...base, uid: 'p2', kind: 'prompt', text: 'Ajoute un test', source: 'typed', pasted: [] }])
    expect(host!.querySelector('.cv-pending')).toBeNull()
    expect(items().at(-1)!.textContent).toContain('Ajoute un test')
    key('ArrowUp')
    expect(host!.querySelector('textarea')!.value).toBe('Ajoute un test')
    key('ArrowDown')
    expect(host!.querySelector('textarea')!.value).toBe('')
  })

  it('désactivé pendant une demande ouverte et pour une session arrêtée ; mention du sondage', async () => {
    handler = () => pageOf([])
    const waiting = session({
      status: { state: 'waiting', wait: 'question' },
      pending: [{ request_id: 1, pending: { kind: 'question', detailed: false } }],
    })
    await render(waiting)
    const ta = host!.querySelector('textarea')!
    expect(ta.readOnly).toBe(true)
    expect(ta.getAttribute('aria-disabled')).toBe('true')
    type('ne part pas')
    key('Enter')
    expect(calls.some((c) => c.method === 'sessions.sendPrompt')).toBe(false)
    expect(host!.textContent).toContain('Réponds d’abord à la demande en attente')
    // La phrase est dans l'aide seulement ; le champ n'affiche qu'un rappel court (pas la même phrase deux fois).
    expect(ta.placeholder).toBe('Demande en attente')
    expect(host!.querySelector('.cv-composer .hint')!.textContent).toContain('Réponds d’abord à la demande en attente')
    expect(host!.textContent).toContain('Si la TUI affiche un sondage ou une suggestion, réponds dans le terminal.')
    act(() => root!.unmount())
    root = null
    await render(session({ alive: false, status: { state: 'stopped' } }))
    expect(host!.querySelector('textarea')!.getAttribute('aria-disabled')).toBe('true')
    expect(host!.textContent).toContain('Session arrêtée')
  })

  it('envoi refusé : le texte revient dans le champ avec le message ; démon trop ancien signalé', async () => {
    const s = session()
    handler = (m) => {
      if (m === 'sessions.sendPrompt') throw new RpcError(-32601, 'Method not found')
      return pageOf([])
    }
    await render(s)
    type('/compact')
    key('Enter')
    await flush()
    expect(host!.querySelector('textarea')!.value).toBe('/compact')
    expect(host!.querySelector('.cv-composer [role="alert"]')?.textContent).toContain('mets orchd à jour')
    expect(host!.querySelector('.cv-pending')).toBeNull()
  })
})

describe('indicateur d’activité', () => {
  it('annoncé poliment, libellé seul dans la région annoncée', async () => {
    handler = () => pageOf([])
    await render(session({ activity: { kind: 'tool', tool: 'Bash', since: new Date(Date.now() - 12_000).toISOString() } }))
    const live = host!.querySelector('.cv-activity [aria-live="polite"]')!
    expect(live.textContent).toBe('Outil : Bash…')
    expect(host!.querySelector('.cv-act')?.textContent).toMatch(/Outil : Bash… 1[23] s/)
    act(() => root!.render(createElement(ConversationView, { session: session({ activity: { kind: 'idle' } }), onLink: () => undefined, viewportHeight: VIEWPORT })))
    expect(host!.querySelector('.cv-act')).toBeNull()
  })
})

describe('corrections après relecture', () => {
  const many = (n: number, from = 0) => Array.from({ length: n }, (_, i) => t(`e${from + i}`, `Entrée numéro ${from + i}`))

  it('sous-agent lancé par un sous-agent : dans le fil de son parent, statut mis à jour', async () => {
    const s = session()
    handler = (m) => (m === 'conversation.subagent' ? pageOf([{ ...t('s1', 'Je délègue.'), agent_id: 'A' }]) : pageOf([
      { ...base, uid: 'sa', kind: 'subagent', tool_use_id: 'tu', agent_id: 'A', agent_type: 'Plan', description: 'parent', status: 'running' },
    ]))
    await render(s, 100_000)
    act(() => button('Plan')!.click())
    await flush()
    const nested: ConversationEntry = { ...base, uid: 'nb', kind: 'subagent', tool_use_id: 'tu2', agent_id: 'B', parent_agent_id: 'A', agent_type: 'Explore', description: 'enfant', status: 'running' }
    notify(s.id, [nested])
    const thread = () => host!.querySelector('.cv-thread')!
    expect(thread().textContent).toContain('Explore')
    expect(thread().textContent).toContain('en cours')
    expect(items().some((i) => i.dataset.uid === 'nb')).toBe(false)
    notify(s.id, [{ ...nested, status: 'done' } as ConversationEntry])
    expect(thread().textContent).toContain('terminé')
  })

  it('reconnexion : la page rechargée résout le prompt en attente', async () => {
    const s = session()
    let sent = false
    handler = (m) => {
      if (m === 'sessions.sendPrompt') {
        sent = true
        return { sent: true }
      }
      return pageOf(sent ? [{ ...base, ts: new Date().toISOString(), uid: 'p9', kind: 'prompt', text: 'Relance', source: 'typed', pasted: [] }] : [])
    }
    await render(s)
    type('Relance')
    key('Enter')
    await flush()
    expect(host!.querySelector('.cv-pending')).not.toBeNull()
    act(() => {
      for (const l of connListeners) l({ state: 'connected' })
    })
    await flush()
    expect(calls.filter((c) => c.method === 'conversation.get')).toHaveLength(2)
    expect(host!.querySelector('.cv-pending')).toBeNull()
    expect(items().at(-1)!.textContent).toContain('Relance')
  })

  it('slash command sans prompt dans le transcript : retirée au repos après le délai de grâce', async () => {
    const s = session({ activity: { kind: 'idle', since: null } })
    handler = (m) => (m === 'sessions.sendPrompt' ? { sent: true } : pageOf([]))
    await render(s)
    type('/model')
    key('Enter')
    await flush()
    expect(host!.querySelector('.cv-pending')?.textContent).toContain('/model')
    vi.useFakeTimers()
    try {
      act(() => root!.render(createElement(ConversationView, { session: { ...s, activity: { kind: 'prompt', since: null } }, onLink: () => undefined, viewportHeight: VIEWPORT })))
      act(() => root!.render(createElement(ConversationView, { session: { ...s, activity: { kind: 'idle', since: null } }, onLink: () => undefined, viewportHeight: VIEWPORT })))
      act(() => vi.advanceTimersByTime(1000))
      expect(host!.querySelector('.cv-pending')).not.toBeNull()
      act(() => vi.advanceTimersByTime(4000))
      expect(host!.querySelector('.cv-pending')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('une ligne au-dessus de la position lue change de taille : la ligne lue ne bouge pas', async () => {
    type Cb = (items: { target: Element; borderBoxSize: { blockSize: number }[] }[]) => void
    const made: { cb: Cb; targets: Set<Element> }[] = []
    let observed = 0
    class FakeRO {
      targets = new Set<Element>()
      constructor(readonly cb: Cb) {
        made.push(this)
      }
      observe(t: Element) {
        observed++
        this.targets.add(t)
      }
      unobserve(t: Element) {
        this.targets.delete(t)
      }
      disconnect() {
        this.targets.clear()
      }
    }
    const g = globalThis as { ResizeObserver?: unknown }
    const before = g.ResizeObserver
    g.ResizeObserver = FakeRO
    try {
      handler = () => pageOf(many(500))
      const s = session()
      await render(s)
      const h = feedHeight(feed()) / 500
      scrollTo(10_000)
      const ro = made[0]!
      const at = (i: number) => items().find((x) => x.dataset.index === String(i))!
      const aboveIdx = Math.floor((10_000 - 2 * h) / h)
      const belowIdx = Math.ceil(10_000 / h) + 2
      expect(ro.targets.has(at(aboveIdx))).toBe(true)
      act(() => ro.cb([{ target: at(aboveIdx), borderBoxSize: [{ blockSize: h + 100 }] }]))
      expect(feed().scrollTop).toBeCloseTo(10_100)
      expect(feedHeight(feed())).toBeCloseTo(500 * h + 100)
      // Une ligne sous la position lue grandit : rien ne bouge.
      act(() => ro.cb([{ target: at(belowIdx), borderBoxSize: [{ blockSize: h + 50 }] }]))
      expect(feed().scrollTop).toBeCloseTo(10_100)
      // Chaque ligne n'est inscrite qu'une fois, même après de nouveaux rendus.
      const count = observed
      const shown = items().map((x) => x.dataset.uid!)
      notify(s.id, shown.map((uid) => t(uid, `${uid} modifiée`)))
      expect(items()[0]!.textContent).toContain('modifiée')
      expect(observed).toBe(count)
    } finally {
      g.ResizeObserver = before
    }
  })

  it('retour sur l’onglet : la position lue est rendue (display: none la remet à 0)', async () => {
    const s = session()
    handler = () => pageOf(many(500))
    await render(s)
    scrollTo(2000)
    await render(s, VIEWPORT, true)
    // Effet de `display: none` : défilement remis à 0, avec un événement ignoré.
    act(() => {
      tops.set(feed(), 0)
      feed().dispatchEvent(new Event('scroll'))
    })
    await render(s, VIEWPORT, false)
    expect(feed().scrollTop).toBe(2000)
    expect(button('Aller en bas')).toBeDefined()
  })

  it('IME : Entrée pendant une composition n’envoie rien ; double Entrée : un seul envoi', async () => {
    const s = session()
    let resolve: (v: unknown) => void = () => undefined
    handler = (m) => (m === 'sessions.sendPrompt' ? new Promise((r) => (resolve = r)) : pageOf([]))
    await render(s)
    type('こんにちは')
    key('Enter', { isComposing: true })
    expect(calls.some((c) => c.method === 'sessions.sendPrompt')).toBe(false)
    key('Enter')
    type('encore')
    key('Enter')
    await flush()
    expect(calls.filter((c) => c.method === 'sessions.sendPrompt')).toHaveLength(1)
    await act(async () => resolve({ sent: true }))
    expect(host!.querySelector('textarea')!.value).toBe('encore')
  })

  it('envoi refusé alors que l’utilisateur a déjà écrit autre chose : « Récupérer le texte non envoyé »', async () => {
    const s = session()
    let reject: (e: unknown) => void = () => undefined
    handler = (m) => (m === 'sessions.sendPrompt' ? new Promise((_r, j) => (reject = j)) : pageOf([]))
    await render(s)
    type('/compact')
    key('Enter')
    type('nouveau')
    await act(async () => reject(new RpcError(-32002, 'une demande attend une réponse dans la session')))
    await flush()
    expect(host!.querySelector('textarea')!.value).toBe('nouveau')
    expect(host!.querySelector('.cv-pending')).toBeNull()
    act(() => button('Récupérer le texte non envoyé')!.click())
    expect(host!.querySelector('textarea')!.value).toBe('nouveau\n/compact')
  })

  it('« Retirer » disponible pendant l’envoi ; « Voir tout » relu après remplacement de l’entrée', async () => {
    const s = session()
    let n = 0
    handler = (m) => {
      if (m === 'sessions.sendPrompt') return new Promise(() => undefined)
      if (m === 'conversation.full') return { text: `entier ${++n}` }
      return pageOf([{ ...base, uid: 'big', kind: 'tool', tool_use_id: 'x', name: 'Bash', summary: 'cat', input: {}, result: { status: 'ok', text: 'début', truncated: true } }])
    }
    await render(s, 100_000)
    type('en vol')
    key('Enter')
    expect(host!.querySelector('.cv-pending')?.textContent).toContain('envoi…')
    act(() => button('Retirer')!.click())
    expect(host!.querySelector('.cv-pending')).toBeNull()
    act(() => button('Bash')!.click())
    act(() => button('Voir tout')!.click())
    await flush()
    expect(host!.textContent).toContain('entier 1')
    notify(s.id, [{ ...base, uid: 'big', kind: 'tool', tool_use_id: 'x', name: 'Bash', summary: 'cat', input: {}, result: { status: 'ok', text: 'début 2', truncated: true } }])
    expect(host!.textContent).not.toContain('entier 1')
    act(() => button('Voir tout')!.click())
    await flush()
    expect(host!.textContent).toContain('entier 2')
  })

  it('titres Markdown : identifiants uniques par entrée', async () => {
    handler = () => pageOf([t('m1', '## Plan'), t('m2', '## Plan')])
    await render(session(), 100_000)
    const ids = [...host!.querySelectorAll('.cv-md h2')].map((h) => h.id)
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
  })
})

vi.setConfig({ testTimeout: 20_000 })
