// @vitest-environment jsdom
/**
 * Onglet « Lancer » (lot 14a) rendu avec React : confirmation demandée quand
 * le processus principal refuse (commande et corps montrés), retenue par
 * lui, commande changée redemandée, lancement par identifiant seulement, démon ancien (onglet masqué), aperçu en iframe isolée
 * seulement pour les serveurs de la machine, « Ouvrir dans le navigateur »
 * par la confirmation des liens.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { ErrorCode } from '../../src/shared/protocol'
import { defaultSettings } from '../../src/shared/settings'
import { session } from '../fixtures'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Le terminal (xterm) n'est pas l'objet de ces tests.
vi.mock('../../src/renderer/src/terminal/TerminalView', () => ({
  TerminalView: (p: { sessionId: string | null }) => createElement('div', { 'data-testid': 'term', 'data-id': p.sessionId ?? '' }),
}))

const S = session({ id: '00000000-0000-4000-8000-0000000000aa', cwd: '/w/alpha/app' })
const P = '11111111-2222-4333-8444-555555555555'
const RUNNERS = [
  { id: 'package.json:dev', label: 'dev', kind: 'dev', command: ['pnpm', 'run', 'dev'], cwd: '', source: 'package.json:scripts.dev' },
  { id: 'package.json:test', label: 'test', kind: 'test', command: ['pnpm', 'run', 'test'], cwd: '', source: 'package.json:scripts.test' },
]

type Reply = { ok: true; result: unknown } | { ok: false; error: { code: number; message: string; data?: unknown } }
let replies: Record<string, (params: unknown) => Reply>
const calls: [string, unknown][] = []
const FP = 'd'.repeat(64)
/** Commandes acceptées, comme les tient le processus principal (empreinte → oui). */
let accepted: Set<string>
/** Empreinte actuelle de la détection (change si le dépôt change). */
let currentFp: string
const confirmation = (fingerprint: string) => ({
  worktree: '/w/alpha',
  runner_id: 'package.json:dev',
  label: 'dev',
  command: ['pnpm', 'run', 'dev'],
  cwd: '',
  source: 'package.json:scripts.dev',
  body: 'vite --host <script>alert(1)</script>',
  fingerprint,
})
const confirmRunner = vi.fn(async (req: { fingerprint: string }) => {
  if (req.fingerprint !== currentFp) return { ok: false, error: { code: ErrorCode.RunnerConfirmationRequired, message: 'changé', data: confirmation(currentFp) } }
  accepted.add(req.fingerprint)
  return { ok: true }
})
const viewRunner = vi.fn(async () => ({ ok: true }))

let RunnersView: typeof import('../../src/renderer/src/components/RunnersView')['RunnersView']
let SettingsProvider: typeof import('../../src/renderer/src/settings')['SettingsProvider']

beforeAll(async () => {
  ;(window as unknown as { devmaestro: object }).devmaestro = {
    call: async (method: string, params: unknown) => {
      calls.push([method, params])
      const r = replies[method]
      return r ? r(params) : { ok: false, error: { code: ErrorCode.MethodNotFound, message: 'inconnue' } }
    },
    onNotification: () => () => undefined,
    viewRunner,
    confirmRunner,
    resizeRunner: () => undefined,
    updateSettings: async () => ({ ok: true, settings: defaultSettings() }),
    onZoomChanged: () => () => undefined,
  }
  ;({ RunnersView } = await import('../../src/renderer/src/components/RunnersView'))
  ;({ SettingsProvider } = await import('../../src/renderer/src/settings'))
})

let root: Root | null = null
let host: HTMLElement | null = null

beforeEach(() => {
  calls.length = 0
  confirmRunner.mockClear()
  accepted = new Set()
  currentFp = FP
  replies = {
    'runners.list': () => ({ ok: true, result: { runners: RUNNERS, running: [] } }),
    // Comme le processus principal : refus tant que l'empreinte actuelle n'est pas acceptée.
    'runners.start': (p) =>
      (p as { runner_id: string }).runner_id === 'package.json:dev' && !accepted.has(currentFp)
        ? { ok: false, error: { code: ErrorCode.RunnerConfirmationRequired, message: 'confirmation', data: confirmation(currentFp) } }
        : {
      ok: true,
      result: {
        process_id: P,
        runner_id: (p as { runner_id: string }).runner_id,
        session_id: S.id,
        port: 41000,
        started_at: new Date().toISOString(),
        state: 'running',
        exit_code: null,
        urls: [],
      },
    },
  }
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
})

async function render(opts: { onLink?: (u: string) => void; onUnsupported?: () => void } = {}) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const view = createElement(RunnersView, {
    session: S,
    theme: {},
    onLink: opts.onLink ?? (() => undefined),
    onRunning: () => undefined,
    onUnsupported: opts.onUnsupported ?? (() => undefined),
  })
  await act(async () => {
    root!.render(createElement(SettingsProvider, { initial: defaultSettings(), children: view }))
  })
  await act(async () => undefined)
}

const buttons = (label: string) => [...document.querySelectorAll('button')].filter((b) => b.textContent?.trim() === label)

describe('onglet « Lancer »', () => {
  it('runners groupés par type, commande visible', async () => {
    await render()
    const text = host!.textContent ?? ''
    expect(text).toContain('Développement')
    expect(text).toContain('Tests')
    expect(text).toContain('pnpm run dev')
    expect(calls[0]).toEqual(['runners.list', { id: S.id }])
  })

  it('refus du processus principal : commande et corps montrés, acceptés, puis lancement', async () => {
    await render()
    await act(async () => buttons('Lancer')[0]!.click())
    const dlg = document.querySelector('[role="dialog"]')!
    expect(dlg.textContent).toContain('Cette commande vient du dépôt et va s’exécuter sur ta machine')
    expect(dlg.textContent).toContain('pnpm run dev')
    // Corps : texte du dépôt, affiché tel quel (jamais interprété).
    expect(dlg.querySelector('pre code')!.textContent).toBe('vite --host <script>alert(1)</script>')
    expect(dlg.querySelector('script')).toBeNull()
    const confirm = [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'Lancer')!
    await act(async () => confirm.click())
    expect(confirmRunner).toHaveBeenCalledWith({ session_id: S.id, runner_id: 'package.json:dev', fingerprint: FP })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    const starts = calls.filter(([m]) => m === 'runners.start')
    expect(starts).toHaveLength(2)
    expect(starts[1]).toEqual(['runners.start', { id: S.id, runner_id: 'package.json:dev' }])
    // Seconde fois : déjà acceptée, plus de dialogue.
    await act(async () => buttons('Lancer')[0]!.click())
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('commande changée entre l’affichage et « Lancer » : remontrée, rien n’est lancé', async () => {
    await render()
    await act(async () => buttons('Lancer')[0]!.click())
    currentFp = 'e'.repeat(64)
    const confirm = [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'Lancer') as HTMLButtonElement
    await act(async () => confirm.click())
    const dlg = document.querySelector('[role="dialog"]')!
    expect(dlg.textContent).toContain('La commande a changé depuis son affichage')
    expect(calls.filter(([m]) => m === 'runners.start')).toHaveLength(1)
  })

  it('-32024 au lancement (commande changée depuis sa confirmation) : liste relue, confirmation redemandée', async () => {
    accepted.add(FP)
    let first = true
    const start = replies['runners.start']!
    replies['runners.start'] = (p) => {
      if (first) {
        first = false
        currentFp = 'e'.repeat(64)
        return { ok: false, error: { code: ErrorCode.RunnerUnknown, message: 'la commande a changé depuis sa confirmation' } }
      }
      return start(p)
    }
    await render()
    await act(async () => buttons('Lancer')[0]!.click())
    expect(calls.filter(([m]) => m === 'runners.list')).toHaveLength(2)
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  })

  it('« Annuler » ne lance rien et ne retient rien', async () => {
    await render()
    await act(async () => buttons('Lancer')[0]!.click())
    await act(async () => buttons('Annuler')[0]!.click())
    expect(calls.filter(([m]) => m === 'runners.start')).toHaveLength(1)
    expect(confirmRunner).not.toHaveBeenCalled()
  })

  it('démon ancien (-32601) : onglet masqué', async () => {
    replies = {}
    const onUnsupported = vi.fn()
    await render({ onUnsupported })
    expect(onUnsupported).toHaveBeenCalledTimes(1)
  })

  it('exécution : état, Arrêter, adresses ; aperçu en iframe isolée pour localhost seulement', async () => {
    replies['runners.list'] = () => ({
      ok: true,
      result: {
        runners: RUNNERS,
        running: [
          {
            process_id: P,
            runner_id: 'package.json:dev',
            session_id: S.id,
            port: 41000,
            started_at: new Date().toISOString(),
            state: 'running',
            exit_code: null,
            urls: ['http://localhost:41000/', 'http://localhost.evil.com:41000/'],
          },
        ],
      },
    })
    replies['runners.stop'] = () => ({ ok: true, result: {} })
    const onLink = vi.fn()
    await render({ onLink })
    expect(host!.querySelector('[data-testid="term"]')!.getAttribute('data-id')).toBe(P)
    expect(host!.textContent).toContain('En cours')
    const previews = buttons('Aperçu')
    expect(previews).toHaveLength(2)
    expect(previews[0]!.disabled).toBe(false)
    expect(previews[1]!.disabled).toBe(true)
    await act(async () => previews[0]!.click())
    const frame = host!.querySelector('iframe')!
    expect(frame.getAttribute('src')).toBe('http://localhost:41000/')
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-forms allow-same-origin allow-popups')
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer')
    // Le navigateur : par la confirmation des liens, même pour une adresse refusée par l'aperçu.
    await act(async () => buttons('Ouvrir dans le navigateur')[1]!.click())
    expect(onLink).toHaveBeenCalledWith('http://localhost.evil.com:41000/')
    await act(async () => buttons('Arrêter')[0]!.click())
    expect(calls.find(([m]) => m === 'runners.stop')).toEqual(['runners.stop', { id: S.id, process_id: P }])
  })
})
