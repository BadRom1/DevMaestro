// @vitest-environment jsdom
/**
 * Vue par statut rendue avec React : Échap ferme le volet (sauf dans le
 * terminal, un champ, une liste ou un dialogue), focus sur « Fermer » à
 * l'ouverture et retour à la carte à la fermeture, filtre qui masque la carte
 * choisie sans fermer le volet.
 */
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { Session } from '../../src/shared/protocol'
import { defaultSettings } from '../../src/shared/settings'
import { groupByProject } from '../../src/renderer/src/state/projects'
import { session } from '../fixtures'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Kanban = typeof import('../../src/renderer/src/components/KanbanView')['KanbanView']
type Provider = typeof import('../../src/renderer/src/settings')['SettingsProvider']
let KanbanView: Kanban
let SettingsProvider: Provider

beforeAll(async () => {
  // `api.ts` lit l'API du preload au chargement : une API vide suffit (aucun appel ici).
  ;(window as unknown as { devmaestro: object }).devmaestro = {}
  ;({ KanbanView } = await import('../../src/renderer/src/components/KanbanView'))
  ;({ SettingsProvider } = await import('../../src/renderer/src/settings'))
})

let root: Root | null = null
let host: HTMLElement | null = null

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
  localStorage.clear()
})

const A = session({ id: '00000000-0000-4000-8000-00000000000a', cwd: '/w/alpha', project_root: '/w/alpha', display_name: 'Alpha' })
const B = session({ id: '00000000-0000-4000-8000-00000000000b', cwd: '/w/beta', project_root: '/w/beta', display_name: 'Beta' })
const SESSIONS: Session[] = [A, B]
const GROUPS = groupByProject(SESSIONS, {})

function pane(): ReactNode {
  return createElement(
    'div',
    { className: 'pane-test' },
    createElement('input', { 'aria-label': 'champ' }),
    createElement('div', { className: 'xterm', tabIndex: 0, 'data-testid': 'term' }),
    createElement('div', { role: 'dialog', tabIndex: 0, 'data-testid': 'dlg' }),
  )
}

function render(props: { open: boolean; selectedId: string | null; onClose?: () => void }) {
  const view = createElement(KanbanView, {
      sessions: SESSIONS,
      groups: GROUPS,
      projects: {},
      profiles: [],
      stale: {},
      subagents: {},
      selectedId: props.selectedId,
      paneOpen: props.open,
      pane: props.open ? pane() : null,
      onOpen: () => undefined,
      onClose: props.onClose ?? (() => undefined),
    })
  const el = createElement(SettingsProvider, { initial: defaultSettings(), children: view })
  if (!root) {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  }
  act(() => root!.render(el))
}

function key(target: Element, k = 'Escape') {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
  })
}

function closeButton(): HTMLButtonElement {
  return [...document.querySelectorAll('button')].find((b) => b.textContent === 'Fermer') as HTMLButtonElement
}

describe('vue par statut : volet de session', () => {
  it('à l’ouverture, le focus va sur « Fermer » ; à la fermeture, il revient à la carte', () => {
    render({ open: false, selectedId: A.id })
    expect(closeButton()).toBeUndefined()
    render({ open: true, selectedId: A.id })
    expect(document.activeElement).toBe(closeButton())
    render({ open: false, selectedId: A.id })
    expect(document.activeElement?.id).toBe(`kcard-${A.id}`)
  })

  it('Échap ferme le volet depuis une carte ou le volet', () => {
    const onClose = vi.fn()
    render({ open: true, selectedId: A.id, onClose })
    key(document.getElementById(`kcard-${B.id}`)!)
    expect(onClose).toHaveBeenCalledTimes(1)
    key(closeButton())
    expect(onClose).toHaveBeenCalledTimes(2)
    // Une autre touche ne ferme rien.
    key(closeButton(), 'Enter')
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('Échap ne ferme pas dans le terminal, un champ, la liste des projets ou un dialogue', () => {
    const onClose = vi.fn()
    render({ open: true, selectedId: A.id, onClose })
    key(document.querySelector('[data-testid="term"]')!)
    key(document.querySelector('input[aria-label="champ"]')!)
    key(document.getElementById('kanban-project')!)
    key(document.querySelector('[data-testid="dlg"]')!)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('volet fermé : Échap ne fait rien', () => {
    const onClose = vi.fn()
    render({ open: false, selectedId: A.id, onClose })
    key(document.getElementById(`kcard-${A.id}`)!)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('un filtre qui masque la carte choisie garde le volet', () => {
    render({ open: true, selectedId: A.id })
    const select = document.getElementById('kanban-project') as HTMLSelectElement
    const beta = [...select.options].find((o) => o.textContent?.startsWith('beta'))!
    act(() => {
      select.value = beta.value
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(document.getElementById(`kcard-${A.id}`)).toBeNull()
    expect(document.getElementById(`kcard-${B.id}`)).not.toBeNull()
    expect(document.querySelector('.pane-test')).not.toBeNull()
    expect(closeButton()).toBeDefined()
  })
})
