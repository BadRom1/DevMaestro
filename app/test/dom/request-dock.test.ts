// @vitest-environment jsdom
/**
 * Zone des demandes (lot 8) rendue avec React : « Réduire » la ramène à une
 * ligne annoncée (région aria-live polie) dont le bouton garde le focus, les
 * cartes restent montées (la saisie est gardée), une nouvelle demande la rouvre.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import type { PendingRequest, Session } from '../../src/shared/protocol'
import { session } from '../fixtures'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Dock = typeof import('../../src/renderer/src/components/RequestDock')
let RequestDock: Dock['RequestDock']
let useRequestDock: Dock['useRequestDock']
let requestKey: typeof import('../../src/renderer/src/state/askDock')['requestKey']

beforeAll(async () => {
  // `api.ts` lit l'API du preload au chargement : une API vide suffit (aucun envoi ici).
  ;(window as unknown as { devmaestro: object }).devmaestro = {}
  ;({ RequestDock, useRequestDock } = await import('../../src/renderer/src/components/RequestDock'))
  ;({ requestKey } = await import('../../src/renderer/src/state/askDock'))
})

let root: Root | null = null
let host: HTMLElement | null = null

afterEach(() => {
  typing = false
  act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
})

function question(id: number, text: string): PendingRequest {
  return {
    request_id: id,
    answerable: true,
    pending: {
      kind: 'question',
      tool_name: 'AskUserQuestion',
      tool_input: {},
      questions: [{ question: text, options: [{ label: 'Oui' }, { label: 'Non' }] }],
    },
  }
}

/** Même branchement que `SessionPane` : état réduit tiré des clés des demandes affichées. */
let typing = false

function Harness({ s }: { s: Session }) {
  const keys = s.pending.map((r) => requestKey(s.id, r.request_id))
  const dock = useRequestDock(s.id, keys, () => typing)
  return createElement(RequestDock, {
    session: s,
    pending: s.pending,
    stale: [],
    reduced: dock.reduced,
    onToggle: dock.toggle,
    dockRef: dock.dockRef,
  })
}

function render(s: Session) {
  if (!root) {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  }
  act(() => root!.render(createElement(Harness, { s })))
}

const dock = () => host!.querySelector<HTMLElement>('.asks')!
const toggle = () => dock().querySelector<HTMLButtonElement>('.asks-bar button')!
const list = () => dock().querySelector<HTMLElement>('.asks-list')!

function typeInto(input: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    set.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('zone des demandes', () => {
  const S = session({ status: { state: 'waiting' }, pending: [question(1, 'On continue ?')] })

  it('région aria-live polie, ouverte avec « Réduire »', () => {
    render(S)
    expect(dock().getAttribute('role')).toBe('region')
    expect(dock().getAttribute('aria-label')).toBe('Demandes en attente')
    expect(dock().getAttribute('aria-live')).toBe('polite')
    expect(toggle().textContent).toBe('Réduire')
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    expect(toggle().getAttribute('aria-controls')).toBe(list().id)
    expect(list().hidden).toBe(false)
    expect(dock().querySelectorAll('[data-request-key]')).toHaveLength(1)
  })

  it('une seule demande ouverte : un seul titre visible (celui de la carte), celui de la zone pour les lecteurs d’écran', () => {
    render(S)
    expect(dock().classList.contains('solo')).toBe(true)
    const title = dock().querySelector('.asks-t')!
    expect(title.classList.contains('sr-only')).toBe(true)
    expect(title.textContent).toBe('Demande en attente')
    // Deux demandes : le titre de la zone (qui les compte) redevient visible.
    render(session({ ...S, pending: [question(1, 'On continue ?'), question(2, 'Et après ?')] }))
    expect(dock().classList.contains('solo')).toBe(false)
    expect(dock().querySelector('.asks-t')!.classList.contains('sr-only')).toBe(false)
  })

  it('« Réduire » : une ligne « Claude attend ta réponse — Afficher », focus gardé, saisie gardée', () => {
    render(S)
    const other = dock().querySelector<HTMLInputElement>('input[type="text"]')!
    typeInto(other, 'Plutôt demain')
    toggle().focus()
    act(() => toggle().click())
    expect(dock().classList.contains('reduced')).toBe(true)
    expect(dock().querySelector('.asks-bar')!.textContent).toBe('Claude attend ta réponse—Afficher')
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(toggle())
    expect(list().hidden).toBe(true)
    // Carte masquée mais montée : rouverte, la saisie est toujours là.
    act(() => toggle().click())
    expect(list().hidden).toBe(false)
    expect(dock().querySelector<HTMLInputElement>('input[type="text"]')!.value).toBe('Plutôt demain')
  })

  it('une nouvelle demande rouvre la zone ; sa clôture la laisse réduite pour les autres', () => {
    render(S)
    act(() => toggle().click())
    expect(list().hidden).toBe(true)
    const two = { ...S, pending: [question(1, 'On continue ?'), question(2, 'Et les tests ?')] }
    render(two)
    expect(list().hidden).toBe(false)
    expect(toggle().textContent).toBe('Réduire')
    expect(dock().querySelectorAll('[data-request-key]')).toHaveLength(2)
    act(() => toggle().click())
    expect(dock().querySelector('.asks-t')!.textContent).toBe('Claude attend ta réponse (2 demandes)')
    render(S)
    expect(list().hidden).toBe(true)
  })

  it('sans demande : région présente mais vide (hauteur nulle par :empty), pour annoncer la première demande', () => {
    render({ ...S, pending: [] })
    expect(dock()).not.toBeNull()
    expect(dock().childElementCount).toBe(0)
  })

  it('nouvelle demande : sa carte prend le focus', () => {
    const s = { ...S, pending: [] }
    render(s)
    render({ ...s, pending: [question(1, 'On continue ?')] })
    expect(document.activeElement?.getAttribute('data-request-key')).toBe(requestKey(s.id, 1))
    render({ ...s, pending: [question(1, 'On continue ?'), question(2, 'Et les tests ?')] })
    expect(document.activeElement?.getAttribute('data-request-key')).toBe(requestKey(s.id, 2))
  })

  it('nouvelle demande pendant une saisie ailleurs (terminal, champ) : le focus ne bouge pas', () => {
    const s = { ...S, pending: [] }
    render(s)
    const field = document.createElement('input')
    document.body.append(field)
    field.focus()
    typing = true
    render({ ...s, pending: [question(1, 'On continue ?')] })
    expect(document.activeElement).toBe(field)
    field.remove()
  })
})
