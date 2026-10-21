// @vitest-environment jsdom
/**
 * « Nouvelle session » › « Reprendre une session » : le profil se choisit
 * (reprendre sous Perso une session lancée sous Work, à court de quota) ;
 * une conversation vue par plusieurs profils (`projects/` partagé) n'apparaît
 * qu'une fois ; avertissement si le profil choisi ne la voit pas.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PastSession, ProjectInfo } from '../../src/shared/protocol'
import { defaultSettings } from '../../src/shared/settings'
import { pastToOffer } from '../../src/renderer/src/state/projects'
import { session } from '../fixtures'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ROOT = '/w/projet'
const PROJECTS: Record<string, ProjectInfo> = {
  [ROOT]: { path: ROOT, is_git: true, root: ROOT, worktree_root: ROOT, common_dir: `${ROOT}/.git`, branch: 'main', name: 'projet', exists: true },
}
/** Session du démon arrêtée, lancée sous Work. */
const STOPPED = session({
  cwd: ROOT,
  project_root: ROOT,
  project_common_dir: `${ROOT}/.git`,
  profile: 'work',
  alive: false,
  pid: null,
  resumable: true,
  resume_blocker: null,
  status: { state: 'stopped' },
  metrics: { session_name: 'Réconciliation' } as never,
  last_activity: '2026-10-21T09:00:00Z',
})

function past(id: string, last: string, over: Partial<PastSession> = {}): PastSession {
  return {
    claude_session_id: id,
    transcript_path: null,
    cwd: ROOT,
    git_branch: 'main',
    first_prompt: `conversation ${id}`,
    title: null,
    first_timestamp: null,
    last_timestamp: last,
    message_count: 1,
    cwd_exists: true,
    ...over,
  }
}

/** `partagee` : vue par les deux profils (`projects/` partagé) ; `work-seul` : vue par Work seulement. */
const PAST = pastToOffer(
  {
    perso: [past('partagee', '2026-10-20T10:00:00Z')],
    work: [past('partagee', '2026-10-20T10:00:00Z'), past('work-seul', '2026-10-19T10:00:00Z')],
  },
  [STOPPED],
)

const calls: { method: string; params: Record<string, unknown> }[] = []

type Mod = typeof import('../../src/renderer/src/components/NewSessionDialog')
type Provider = typeof import('../../src/renderer/src/settings')['SettingsProvider']
let NewSessionDialog: Mod['NewSessionDialog']
let SettingsProvider: Provider

beforeAll(async () => {
  ;(window as unknown as { devmaestro: object }).devmaestro = {
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      if (method === 'sessions.resume') return { ok: true, result: { session: STOPPED, warnings: [] } }
      return { ok: false, error: { code: -32601, message: 'inconnue' } }
    },
  }
  ;({ NewSessionDialog } = await import('../../src/renderer/src/components/NewSessionDialog'))
  ;({ SettingsProvider } = await import('../../src/renderer/src/settings'))
})

let root: Root | null = null
let host: HTMLElement | null = null
beforeEach(() => {
  calls.length = 0
})
afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
})

async function render(onLaunched = vi.fn()) {
  const dialog = createElement(NewSessionDialog, {
    profiles: [
      { name: 'perso', config_dir: '/h/.claude', sets_config_dir_env: false },
      { name: 'work', config_dir: '/h/.claude-work', sets_config_dir_env: true },
    ],
    sessions: [STOPPED],
    past: PAST,
    projects: PROJECTS,
    home: '/h',
    // Profil du projet : Perso.
    projectProfiles: { [ROOT]: 'perso' },
    initialCwd: ROOT,
    initialProjectKey: `git:${ROOT}/.git`,
    termSize: null,
    worktreeLists: {},
    worktreesSupported: false,
    loadWorktrees: () => undefined,
    managedDir: null,
    onClose: () => undefined,
    onLaunched,
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(createElement(SettingsProvider, { initial: defaultSettings(), children: dialog })))
}

function profileField() {
  const l = [...document.querySelectorAll('label.field')].find((x) => x.querySelector('.lbl')?.textContent === 'Profil')!
  return { select: l.querySelector('select') as HTMLSelectElement, hint: () => l.querySelector('.hint')!.textContent }
}

async function openResume() {
  const tab = [...document.querySelectorAll('[role="tab"]')].find((b) => b.textContent?.startsWith('Reprendre une session')) as HTMLButtonElement
  await act(async () => tab.click())
  return tab
}

function rows() {
  return [...document.querySelectorAll<HTMLLabelElement>('.resume-list .rrow')]
}

async function pick(text: string) {
  const row = rows().find((r) => r.textContent?.includes(text))!
  await act(async () => row.querySelector('input')!.click())
}

async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

async function submit() {
  await act(async () => (document.querySelector('form') as HTMLFormElement).requestSubmit())
  return calls.filter((c) => c.method === 'sessions.resume').at(-1)!.params
}

describe('« Reprendre une session » : choix du profil', () => {
  it('une conversation vue par deux profils n’apparaît qu’une fois ; compteur après dédoublonnage', async () => {
    await render()
    const tab = await openResume()
    expect(rows()).toHaveLength(3)
    expect(rows().filter((r) => r.textContent?.includes('conversation partagee'))).toHaveLength(1)
    expect(tab.querySelector('.badge')?.textContent).toBe('3')
  })

  it('aucune session choisie : « profil par défaut du projet »', async () => {
    await render()
    await openResume()
    const { select, hint } = profileField()
    expect(select.value).toBe('perso')
    expect(hint()).toBe('profil par défaut du projet')
  })

  it('session du démon : sélecteur actif, défaut = son profil ; un autre profil part dans `sessions.resume`', async () => {
    await render()
    await openResume()
    await pick('Réconciliation')
    const { select, hint } = profileField()
    expect(select.disabled).toBe(false)
    expect(select.value).toBe('work')
    expect(hint()).toBe('profil de la session')
    await choose(select, 'perso')
    expect(hint()).toMatch(/^reprise sous .+ \(session lancée sous .+\)$/)
    expect(await submit()).toEqual({ id: STOPPED.id, profile: 'perso' })
  })

  it('session du démon, profil inchangé : non envoyé (le démon garde celui de la session)', async () => {
    await render()
    await openResume()
    await pick('Réconciliation')
    expect(await submit()).toEqual({ id: STOPPED.id })
  })

  it('choix explicite gardé au changement de session ; défaut sinon', async () => {
    await render()
    await openResume()
    await pick('conversation work-seul')
    const { select } = profileField()
    // Vue par Work seulement : Work par défaut, même si le projet est réglé sur Perso.
    expect(select.value).toBe('work')
    await pick('conversation partagee')
    // Vue par les deux : le profil du projet.
    expect(select.value).toBe('perso')
    expect(profileField().hint()).toBe('conversation visible par plusieurs profils : au choix')
    await choose(select, 'work')
    await pick('Réconciliation')
    expect(select.value).toBe('work')
    await pick('conversation partagee')
    expect(select.value).toBe('work')
    expect(await submit()).toMatchObject({ claude_session_id: 'partagee', cwd: ROOT, profile: 'work' })
  })

  it('ancienne session : le profil choisi est envoyé ; avertissement s’il ne voit pas la conversation, sans bloquer', async () => {
    await render()
    await openResume()
    await pick('conversation work-seul')
    const { select, hint } = profileField()
    await choose(select, 'perso')
    expect(hint()).toBe('ce profil ne voit pas cette conversation : la reprise échouera probablement')
    const go = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Reprendre ▶')! as HTMLButtonElement
    expect(go.disabled).toBe(false)
    expect(await submit()).toMatchObject({ claude_session_id: 'work-seul', profile: 'perso' })
  })

  it('badge de profil : gardé pour les sessions du démon et les conversations vues par un seul profil', async () => {
    await render()
    await openResume()
    const badgeOf = (t: string) => rows().find((r) => r.textContent?.includes(t))!.querySelector('.pbadge')!
    expect(badgeOf('Réconciliation').classList.contains('pany')).toBe(false)
    expect(badgeOf('conversation work-seul').classList.contains('pany')).toBe(false)
    expect(badgeOf('conversation partagee').classList.contains('pany')).toBe(true)
  })
})
