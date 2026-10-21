// @vitest-environment jsdom
/**
 * « Changer de compte… » (lot 15 ter) : bouton masqué avec un seul profil,
 * `sessions.stop` puis `sessions.resume {id, profile}`, « Attendre la fin »
 * jusqu'au repos, annulation, échec de reprise avec « Reprendre sous
 * <origine> », invite quand le compte est au plafond.
 */
import { Fragment, act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Profile, Session } from '../../src/shared/protocol'
import { defaultSettings } from '../../src/shared/settings'
import type { QuotaView } from '../../src/renderer/src/state/quotas'
import { IDLE_SETTLE_MS } from '../../src/renderer/src/state/accountSwitch'
import { session } from '../fixtures'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const P = (name: string): Profile => ({ name, config_dir: `/h/.claude-${name}`, sets_config_dir_env: true })
const TWO = [P('perso'), P('work')]

function view(profile: string, five: number | null): QuotaView {
  return {
    profile,
    fiveHour: five === null ? null : { used_pct: five, resets_at: null },
    sevenDay: null,
    fiveHourMeta: null,
    sevenDayMeta: null,
    source: 'usage_api',
    error: null,
    fetchedAt: null,
  }
}

const calls: { method: string; params: Record<string, unknown> }[] = []
/** Réponse de `sessions.resume` par profil demandé ; absent : la session reprise sous ce profil. */
let resumeErrors: Record<string, { code: number; message: string }> = {}
let stopResult = { stopping: true, alive: true }
/** Échec de `sessions.stop` (sinon `stopResult`). */
let stopError: { code: number; message: string } | null = null
/** `sessions.stop` en suspens jusqu'à `releaseStop()`. */
let holdStop = false
let releaseStop: () => void = () => {}
/**
 * Transcripts vus par chaque profil (identifiants de conversation), comme le
 * démon : `exclude_known` (vrai par défaut) écarte les conversations des
 * sessions qu'il connaît.
 */
let transcripts: Record<string, string[]> = {}

type Mod = typeof import('../../src/renderer/src/components/AccountSwitch')
let M: Mod
let SettingsProvider: (typeof import('../../src/renderer/src/settings'))['SettingsProvider']

beforeAll(async () => {
  ;(window as unknown as { devmaestro: object }).devmaestro = {
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      if (method === 'sessions.stop') {
        if (holdStop) await new Promise<void>((r) => (releaseStop = r))
        if (stopError) return { ok: false, error: stopError }
        return { ok: true, result: stopResult }
      }
      if (method === 'transcripts.list') {
        const known = new Set(Object.values(current).map((x) => x.claude_session_id))
        const ids = (transcripts[params.profile as string] ?? []).filter((c) => params.exclude_known === false || !known.has(c))
        return { ok: true, result: { profile: params.profile, sessions: ids.map((c) => ({ claude_session_id: c })) } }
      }
      if (method === 'sessions.resume') {
        const err = resumeErrors[params.profile as string]
        if (err) return { ok: false, error: err }
        return { ok: true, result: { session: { ...current[params.id as string]!, alive: true, profile: params.profile }, warnings: [] } }
      }
      return { ok: false, error: { code: -32601, message: 'inconnue' } }
    },
  }
  M = await import('../../src/renderer/src/components/AccountSwitch')
  ;({ SettingsProvider } = await import('../../src/renderer/src/settings'))
})

/** Sessions vues par le harnais (comme `state.sessions` de l'app). */
let current: Record<string, Session> = {}
const resumed: Session[] = []

function Harness(props: {
  sessions: Record<string, Session>
  id: string
  profiles: Profile[]
  quotas: QuotaView[]
}) {
  const api = M.useAccountSwitch({ sessions: props.sessions, termSize: null, onSession: (s) => resumed.push(s) })
  const [open, setOpen] = useState(false)
  const [off, setOff] = useState<ReadonlySet<string>>(() => new Set())
  const s = props.sessions[props.id]!
  const st = api.states[s.id] ?? null
  return createElement(
    'div',
    null,
    createElement(M.SwitchAccountButton, { session: s, profiles: props.profiles, state: st, onOpen: () => setOpen(true) }),
    createElement(M.SwitchArea, {
      state: st,
      children: createElement(
        Fragment,
        null,
        createElement(M.SwitchStatus, {
        session: s,
        state: st,
        onCancel: () => api.cancel(s.id),
        onResumeAs: (p: string) => api.resumeAs(s.id, p),
      }),
      createElement(M.CeilingHint, {
        session: s,
        profiles: props.profiles,
        quotas: props.quotas,
        state: st,
        dismissed: (k: string) => off.has(k),
        onDismiss: (k: string) => setOff((x) => new Set(x).add(k)),
        onOpen: () => setOpen(true),
      }),
      ),
    }),
    open &&
      createElement(M.AccountSwitchDialog, {
        session: s,
        profiles: props.profiles,
        quotas: props.quotas,
        onStart: (t: string, w: boolean) => {
          api.start(s, t, w)
          setOpen(false)
        },
        onClose: () => setOpen(false),
      }),
  )
}

let root: Root | null = null
let host: HTMLElement | null = null
let opts = { profiles: TWO, quotas: [] as QuotaView[] }
let id = ''

beforeEach(() => {
  vi.useFakeTimers()
  calls.length = 0
  resumed.length = 0
  resumeErrors = {}
  stopResult = { stopping: true, alive: true }
  stopError = null
  holdStop = false
  transcripts = {}
  opts = { profiles: TWO, quotas: [] }
})
afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
  vi.useRealTimers()
})

/** Session d'id `s.id` ; `null` : retirée de la liste. */
async function render(s: Session, removed = false) {
  current = removed ? {} : { [s.id]: s }
  id = s.id
  if (!root) {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  }
  const tree = removed ? createElement('p', null, 'vide') : createElement(Harness, { sessions: current, id, ...opts })
  await act(async () => root!.render(createElement(SettingsProvider, { initial: defaultSettings(), children: tree })))
}

/** Nouvel instantané de la session (comme un `session.updated`). */
async function update(over: Partial<Session>) {
  await render({ ...current[id]!, ...over })
}

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms)
  })
}

const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('button')]
const button = (text: string | RegExp) =>
  buttons().find((b) => (typeof text === 'string' ? b.textContent?.trim() === text : text.test(b.textContent ?? '')))
async function click(text: string | RegExp) {
  const b = button(text)
  if (!b) throw new Error(`bouton introuvable : ${text} (${buttons().map((x) => x.textContent).join(' | ')})`)
  await act(async () => b.click())
}
/** Appels qui agissent sur la session (sans les lectures `transcripts.list`). */
const methods = () => calls.map((c) => c.method).filter((m) => m !== 'transcripts.list')

/** Conversation visible par les deux profils (`projects/` partagé), comme le plus souvent. */
function IDLE(over: Partial<Session> = {}) {
  const s = session({ profile: 'perso', status: { state: 'idle' }, activity: { kind: 'idle' }, first_prompt: 'bonjour', ...over })
  transcripts = { perso: [s.claude_session_id!], work: [s.claude_session_id!] }
  return s
}
const BUSY = (over: Partial<Session> = {}) => IDLE({ status: { state: 'running' }, activity: { kind: 'tool', tool: 'Bash' }, ...over })

async function openDialog() {
  await click('Changer de compte…')
  // Réponses de `transcripts.list`.
  await act(async () => {})
}
const dialogText = () => document.querySelector('[role="dialog"]')?.textContent ?? ''

describe('changer de compte', () => {
  it('action masquée avec un seul profil, visible avec deux', async () => {
    opts.profiles = [P('perso')]
    await render(IDLE())
    expect(button('Changer de compte…')).toBeUndefined()
    act(() => root?.unmount())
    root = null
    opts.profiles = TWO
    await render(IDLE())
    expect(button('Changer de compte…')).toBeDefined()
  })

  it('au repos : stop, attente de l’arrêt, puis resume avec le profil', async () => {
    opts.quotas = [view('perso', 40), view('work', 12)]
    await render(IDLE())
    await openDialog()
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('La session va être arrêtée puis reprise sous Work ; la conversation continue')
    // Jauge du profil cible.
    expect(dialog.querySelector('[role="meter"][aria-valuenow="12"]')).not.toBeNull()
    await click('Changer de compte')
    expect(methods()).toEqual(['sessions.stop'])
    expect(calls.find((c) => c.method === 'sessions.stop')!.params).toEqual({ id })
    expect(document.body.textContent).toContain('arrêt de la session')
    // Arrêt effectif reçu par `session.updated`.
    await update({ alive: false, status: { state: 'stopped' } })
    expect(methods()).toEqual(['sessions.stop', 'sessions.resume'])
    expect(calls.filter((c) => c.method === 'sessions.resume')[0]!.params).toEqual({ id, profile: 'work' })
    await act(async () => {})
    expect(resumed.map((s) => [s.id, s.profile])).toEqual([[id, 'work']])
  })

  it('Claude travaille : « Attendre la fin » bascule au repos', async () => {
    await render(BUSY())
    await openDialog()
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Claude travaille : Claude utilise l’outil Bash')
    await click('Attendre la fin')
    expect(methods()).toEqual([])
    expect(document.body.textContent).toContain('Bascule vers Work dès que Claude aura fini')
    await advance(5_000)
    expect(methods()).toEqual([])
    await update({ status: { state: 'idle' }, activity: { kind: 'idle' } })
    await advance(IDLE_SETTLE_MS + 300)
    expect(methods()).toEqual(['sessions.stop'])
    await update({ alive: false, status: { state: 'stopped' } })
    expect(calls.at(-1)).toEqual({ method: 'sessions.resume', params: { id, profile: 'work' } })
  })

  it('« Changer maintenant » demande une confirmation explicite', async () => {
    await render(BUSY({ activity: { kind: 'prompt' } }))
    await openDialog()
    await click('Changer maintenant…')
    expect(methods()).toEqual([])
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('interrompt le travail en cours')
    await click('Interrompre et changer')
    expect(methods()).toEqual(['sessions.stop'])
  })

  it('annulation de l’attente : aucun appel', async () => {
    await render(BUSY())
    await openDialog()
    await click('Attendre la fin')
    await click('Annuler la bascule')
    await update({ status: { state: 'idle' }, activity: { kind: 'idle' } })
    await advance(IDLE_SETTLE_MS * 3)
    expect(methods()).toEqual([])
    expect(document.body.textContent).not.toContain('Bascule vers')
  })

  it('reprise refusée après l’arrêt : message clair et « Reprendre sous Perso »', async () => {
    resumeErrors = { work: { code: -32015, message: 'Claude Code n’a pas de transcript pour cette conversation' } }
    stopResult = { stopping: false, alive: false }
    await render(IDLE())
    await openDialog()
    await click('Changer de compte')
    await act(async () => {})
    await update({ alive: false, status: { state: 'stopped' } })
    const alert = document.querySelector('[role="alert"]')!
    expect(alert.textContent).toContain('La session est arrêtée ; la bascule vers Work a échoué')
    expect(alert.textContent).toContain('« Reprendre sous Perso » peut aussi échouer')
    expect(alert.textContent).toContain('le profil Work ne voit pas cette conversation')
    await click('Reprendre sous Perso')
    expect(calls.at(-1)).toEqual({ method: 'sessions.resume', params: { id, profile: 'perso' } })
    await act(async () => {})
    expect(resumed.at(-1)?.profile).toBe('perso')
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })

  it('visibilité demandée au démon (exclude_known: false) : cible aveugle → avertissement et confirmation', async () => {
    const s = IDLE()
    transcripts = { perso: [s.claude_session_id!], work: ['autre'] }
    await render(s)
    await openDialog()
    const lists = calls.filter((c) => c.method === 'transcripts.list')
    expect(lists.map((c) => c.params)).toEqual([
      { profile: 'perso', limit: 200, include_hidden: true, exclude_known: false },
      { profile: 'work', limit: 200, include_hidden: true, exclude_known: false },
    ])
    expect(dialogText()).toContain('Le profil Work ne voit pas cette conversation')
    expect(button('Changer de compte')).toBeUndefined()
    await click('Changer quand même…')
    expect(methods()).not.toContain('sessions.stop')
    await click('Changer quand même')
    expect(methods()).toContain('sessions.stop')
  })

  it('pas encore de transcript : bascule impossible, « Vérifier à nouveau »', async () => {
    const s = IDLE({ first_prompt: null })
    await render(s)
    transcripts = { perso: [], work: [] }
    await openDialog()
    expect(dialogText()).toContain('n’a pas encore de transcript')
    expect(button('Changer de compte')).toBeUndefined()
    expect(button('Changer maintenant…')).toBeUndefined()
    transcripts = { perso: [s.claude_session_id!], work: [s.claude_session_id!] }
    await click('Vérifier à nouveau')
    await act(async () => {})
    expect(button('Changer de compte')).toBeDefined()
  })

  it('mode dangereux : avertissement et confirmation', async () => {
    await render(IDLE({ mode: 'bypassPermissions' }))
    await openDialog()
    expect(dialogText()).toContain('allow_dangerous_modes')
    expect(button('Changer quand même…')).toBeDefined()
  })

  it('session arrêtée d’elle-même pendant l’attente : pas de reprise sans clic', async () => {
    await render(BUSY())
    await openDialog()
    await click('Attendre la fin')
    await update({ alive: false, status: { state: 'stopped' } })
    await advance(5_000)
    expect(methods().filter((m) => m.startsWith('sessions.'))).toEqual([])
    expect(document.body.textContent).toContain('La session s’est arrêtée pendant l’attente')
    await click('Reprendre sous Work')
    expect(calls.at(-1)).toEqual({ method: 'sessions.resume', params: { id, profile: 'work' } })
  })

  it('demande arrivée pendant le repos à tenir : pas de bascule avant le vrai repos', async () => {
    await render(BUSY())
    await openDialog()
    await click('Attendre la fin')
    await update({ status: { state: 'idle' }, activity: { kind: 'idle' } })
    await advance(IDLE_SETTLE_MS - 500)
    await update({
      status: { state: 'waiting', wait: 'question' },
      activity: { kind: 'waiting' },
      pending: [{ request_id: 1, pending: { kind: 'question', detailed: false } }],
    })
    await advance(IDLE_SETTLE_MS * 2)
    expect(methods()).not.toContain('sessions.stop')
    expect(document.body.textContent).toContain('une question attend ta réponse')
    await update({ status: { state: 'idle' }, activity: { kind: 'idle' }, pending: [] })
    await advance(IDLE_SETTLE_MS + 300)
    expect(methods()).toContain('sessions.stop')
  })

  it('double clic sur « Changer de compte » : un seul arrêt', async () => {
    await render(IDLE())
    await openDialog()
    const b = button('Changer de compte')!
    await act(async () => {
      b.click()
      b.click()
    })
    expect(methods().filter((m) => m === 'sessions.stop')).toHaveLength(1)
  })

  it('démontage pendant l’attente ou l’arrêt : aucun appel ensuite, aucune erreur', async () => {
    await render(BUSY())
    await openDialog()
    await click('Attendre la fin')
    act(() => root?.unmount())
    root = null
    await advance(IDLE_SETTLE_MS * 3)
    expect(methods()).not.toContain('sessions.stop')

    holdStop = true
    await render(IDLE())
    await openDialog()
    await click('Changer de compte')
    act(() => root?.unmount())
    root = null
    await act(async () => releaseStop())
    await advance(1_000)
    expect(methods().filter((m) => m === 'sessions.resume')).toEqual([])
  })

  it('session retirée pendant l’arrêt : rien ne reste', async () => {
    const s = IDLE()
    await render(s)
    await openDialog()
    await click('Changer de compte')
    await render(s, true)
    await render(s)
    expect(document.body.textContent).not.toContain('Bascule')
    expect(methods()).not.toContain('sessions.resume')
  })

  it('texte d’échec d’après l’état réel : arrêt « refusé » mais session arrêtée', async () => {
    stopError = { code: -1, message: 'délai' }
    await render(IDLE())
    await openDialog()
    await click('Changer de compte')
    await act(async () => {})
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('tourne toujours sous Perso')
    await update({ alive: false, status: { state: 'stopped' } })
    const t = document.querySelector('[role="alert"]')!.textContent!
    expect(t).toContain('La session est arrêtée ; la bascule vers Work a échoué')
    expect(t).toContain('« Reprendre sous Perso » peut échouer')
    expect(button('Reprendre sous Perso')).toBeDefined()
  })

  it('focus rendu à la zone de la bascule quand son bouton disparaît', async () => {
    await render(BUSY())
    await openDialog()
    await click('Attendre la fin')
    expect(document.activeElement?.classList.contains('sh-asw')).toBe(true)
    button('Annuler la bascule')!.focus()
    await click('Annuler la bascule')
    expect(document.activeElement?.classList.contains('sh-asw')).toBe(true)
  })

  it('compte au plafond : invite discrète qui ouvre le dialogue, sans bascule', async () => {
    opts.quotas = [view('perso', 97), view('work', 20)]
    await render(IDLE())
    const hint = button(/Compte Perso presque au plafond \(≥ 90 %\)/)
    expect(hint?.textContent).toContain('5 h : 97 %')
    await click(/Compte Perso presque au plafond/)
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(methods()).toEqual([])
  })

  it('invite fermable, de retour quand le quota change ; « au plafond » à 100 %', async () => {
    opts.quotas = [view('perso', 97), view('work', 20)]
    await render(IDLE())
    const x = document.querySelector<HTMLButtonElement>('button[aria-label^="Masquer l’invite"]')!
    await act(async () => x.click())
    expect(button(/plafond/)).toBeUndefined()
    await render(current[id]!)
    expect(button(/plafond/)).toBeUndefined()
    opts.quotas = [view('perso', 100), view('work', 20)]
    await render(current[id]!)
    expect(button(/^⚠ Compte Perso au plafond/)).toBeDefined()
  })

  it('pas d’invite si l’autre profil n’a pas de quota connu', async () => {
    opts.quotas = [view('perso', 97), view('work', null)]
    await render(IDLE())
    expect(button(/plafond/)).toBeUndefined()
  })

  it('pas d’invite sous le plafond', async () => {
    opts.quotas = [view('perso', 60), view('work', 20)]
    await render(IDLE())
    expect(button(/au plafond/)).toBeUndefined()
  })
})
