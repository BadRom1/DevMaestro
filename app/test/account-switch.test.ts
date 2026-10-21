/** Changer de compte (lot 15 ter) : logique pure de l'enchaînement arrêt → reprise. */
import { describe, expect, it } from 'vitest'

import type { PastSession, Profile } from '../src/shared/protocol'
import {
  IDLE_SETTLE_MS,
  RESUME_ATTEMPTS,
  RESUME_RETRY_MS,
  STOP_TIMEOUT_MS,
  busyReason,
  canSwitch,
  ceilingOf,
  ceilingSuggestion,
  VISIBILITY_LIMIT,
  ceilingKey,
  dangerousMode,
  originRetryCaveat,
  switchRisks,
  visibilityIn,
  needsTicks,
  resumeFailureText,
  switchInFlight,
  switchStep,
  switchTargets,
  type SwitchState,
} from '../src/renderer/src/state/accountSwitch'
import type { QuotaView } from '../src/renderer/src/state/quotas'
import { session } from './fixtures'

const P = (name: string): Profile => ({ name, config_dir: `/h/.claude-${name}`, sets_config_dir_env: true })
const TWO = [P('perso'), P('work')]
const IDLE = session({ profile: 'perso', status: { state: 'idle' }, activity: { kind: 'idle' } })
const BUSY = session({ profile: 'perso', status: { state: 'running' }, activity: { kind: 'tool', tool: 'Bash' } })

function view(profile: string, five: number | null, seven: number | null = null): QuotaView {
  return {
    profile,
    fiveHour: five === null ? null : { used_pct: five, resets_at: null },
    sevenDay: seven === null ? null : { used_pct: seven, resets_at: null },
    fiveHourMeta: null,
    sevenDayMeta: null,
    source: 'usage_api',
    error: null,
    fetchedAt: null,
  }
}

describe('action et profils cibles', () => {
  it('au moins deux profils', () => {
    expect(canSwitch(IDLE, [P('perso')])).toBe(false)
    expect(canSwitch(IDLE, TWO)).toBe(true)
    expect(switchTargets(IDLE, TWO).map((p) => p.name)).toEqual(['work'])
  })

  it('session arrêtée : seulement si reprenable', () => {
    expect(canSwitch(session({ profile: 'perso', alive: false }), TWO)).toBe(true)
    expect(canSwitch(session({ profile: 'perso', alive: false, resumable: false }), TWO)).toBe(false)
    expect(canSwitch(session({ profile: 'perso', alive: false, resume_blocker: 'cwd_missing' as never }), TWO)).toBe(false)
  })
})

describe('Claude au repos ?', () => {
  it('outil, sous-agents, compaction, tour en cours', () => {
    expect(busyReason(IDLE)).toBeNull()
    expect(busyReason(BUSY)).toBe('Claude utilise l’outil Bash')
    expect(busyReason({ ...IDLE, activity: { kind: 'subagents' } })).toBe('des sous-agents travaillent')
    expect(busyReason({ ...IDLE, activity: { kind: 'compacting' } })).toBe('Claude compacte la conversation')
    expect(busyReason({ ...IDLE, status: { state: 'running' }, activity: null })).toBe('Claude travaille')
  })

  it('demande en attente', () => {
    const q = { ...IDLE, status: { state: 'waiting' as const, wait: 'question' as const } }
    expect(busyReason(q)).toBe('une question attend ta réponse')
    const perm = {
      ...IDLE,
      pending: [{ request_id: 1, pending: { kind: 'permission' as const, detailed: false as const } }],
    }
    expect(busyReason(perm)).toBe('une demande de permission attend ta réponse')
  })

  it('session arrêtée : rien à attendre', () => {
    expect(busyReason({ ...BUSY, alive: false })).toBeNull()
  })
})

describe('visibilité de la conversation et risques', () => {
  const p = (id: string) => ({ claude_session_id: id }) as PastSession
  it('listée : visible ; absente d’une liste complète : absent ; liste pleine ou échec : unknown', () => {
    expect(visibilityIn('c', [p('x'), p('c')])).toBe('visible')
    expect(visibilityIn('c', [p('x')])).toBe('absent')
    expect(visibilityIn('c', Array.from({ length: VISIBILITY_LIMIT }, (_, i) => p(`x${i}`)))).toBe('unknown')
    expect(visibilityIn('c', null)).toBe('unknown')
    expect(visibilityIn(null, [])).toBe('unknown')
  })

  const S = { mode: 'default', first_prompt: 'bonjour', claude_session_id: 'c' }
  it('cible aveugle', () => {
    expect(switchRisks(S, 'visible', 'absent')).toEqual({ noTranscript: null, targetBlind: true, dangerous: false })
    expect(switchRisks(S, 'visible', 'visible')).toEqual({ noTranscript: null, targetBlind: false, dangerous: false })
  })
  it('pas encore de transcript : sûr si absente de l’origine, probable sans premier prompt', () => {
    expect(switchRisks(S, 'absent', 'absent').noTranscript).toBe('sure')
    expect(switchRisks({ ...S, claude_session_id: null }, 'unknown', 'unknown').noTranscript).toBe('sure')
    expect(switchRisks({ ...S, first_prompt: null }, 'unknown', 'unknown').noTranscript).toBe('likely')
    // Démon plus ancien (champ absent) : rien n'est supposé.
    expect(switchRisks({ mode: 'default', claude_session_id: 'c' }, 'unknown', 'unknown').noTranscript).toBeNull()
  })
  it('mode dangereux', () => {
    expect(dangerousMode('bypassPermissions')).toBe(true)
    expect(dangerousMode('dontAsk')).toBe(true)
    expect(dangerousMode('acceptEdits')).toBe(false)
    expect(switchRisks({ ...S, mode: 'bypassPermissions' }, 'visible', 'visible').dangerous).toBe(true)
  })
})

describe('plafond', () => {
  it('seuil critique de la jauge, fenêtre la plus pleine', () => {
    expect(ceilingOf(view('perso', 89))).toBeNull()
    expect(ceilingOf(view('perso', 90))).toEqual({ window: '5 h', pct: 90 })
    expect(ceilingOf(view('perso', 92, 97))).toEqual({ window: '7 j', pct: 97 })
  })
  it('suggestion seulement si un autre profil a un quota connu sous le plafond', () => {
    expect(ceilingSuggestion(IDLE, TWO, [view('perso', 96), view('work', null)])).toBeNull()
    expect(ceilingSuggestion(IDLE, TWO, [view('perso', 96)])).toBeNull()
    expect(ceilingKey('s', 'perso', { window: '5 h', pct: 96.4 })).toBe('s|perso|5 h|96')
    expect(ceilingSuggestion(IDLE, TWO, [view('perso', 96), view('work', 10)])).toEqual({ window: '5 h', pct: 96 })
    expect(ceilingSuggestion(IDLE, TWO, [view('perso', 96), view('work', 99)])).toBeNull()
    expect(ceilingSuggestion(IDLE, TWO, [view('perso', 50), view('work', 10)])).toBeNull()
    expect(ceilingSuggestion(IDLE, [P('perso')], [view('perso', 96)])).toBeNull()
  })
})

describe('enchaînement', () => {
  it('au repos, « Changer » : arrêt, arrêt constaté, reprise sous la cible', () => {
    let r = switchStep(null, { type: 'start', session: IDLE, target: 'work', wait: false, now: 0 })
    expect(r.effect).toEqual({ kind: 'stop' })
    expect(r.state?.kind).toBe('stopping')
    expect(switchInFlight(r.state)).toBe(true)
    // `sessions.stop` répond « en cours d'arrêt » : on attend l'instantané.
    r = switchStep(r.state, { type: 'stopSent', alive: true, now: 10 })
    expect(r.effect).toBeNull()
    r = switchStep(r.state, { type: 'session', session: { ...IDLE, alive: false, status: { state: 'stopped' } }, now: 500 })
    expect(r.effect).toEqual({ kind: 'resume', profile: 'work' })
    // Un deuxième instantané n'en relance pas une autre.
    const again = switchStep(r.state, { type: 'session', session: { ...IDLE, alive: false }, now: 600 })
    expect(again.effect).toBeNull()
    r = switchStep(r.state, { type: 'resumed', warnings: [] })
    expect(r.state).toBeNull()
  })

  it('déjà arrêtée par `sessions.stop` : reprise tout de suite', () => {
    let r = switchStep(null, { type: 'start', session: IDLE, target: 'work', wait: false, now: 0 })
    r = switchStep(r.state, { type: 'stopSent', alive: false, now: 1 })
    expect(r.effect).toEqual({ kind: 'resume', profile: 'work' })
  })

  it('session arrêtée au départ : reprise seule', () => {
    const r = switchStep(null, { type: 'start', session: { ...IDLE, alive: false }, target: 'work', wait: true, now: 0 })
    expect(r.effect).toEqual({ kind: 'resume', profile: 'work' })
  })

  it('« Attendre la fin » : bascule après un repos tenu', () => {
    let r = switchStep(null, { type: 'start', session: BUSY, target: 'work', wait: true, now: 0 })
    expect(r.state).toMatchObject({ kind: 'waiting', idleSince: null, reason: 'Claude utilise l’outil Bash' })
    expect(r.effect).toBeNull()
    expect(needsTicks(r.state)).toBe(false)
    r = switchStep(r.state, { type: 'session', session: IDLE, now: 1_000 })
    expect(r.state).toMatchObject({ kind: 'waiting', idleSince: 1_000 })
    expect(needsTicks(r.state)).toBe(true)
    // Reprise du travail avant la fin du délai : on attend de nouveau.
    r = switchStep(r.state, { type: 'session', session: BUSY, now: 1_500 })
    expect(r.state).toMatchObject({ kind: 'waiting', idleSince: null })
    r = switchStep(r.state, { type: 'session', session: IDLE, now: 2_000 })
    r = switchStep(r.state, { type: 'tick', now: 2_000 + IDLE_SETTLE_MS - 1 })
    expect(r.effect).toBeNull()
    r = switchStep(r.state, { type: 'tick', now: 2_000 + IDLE_SETTLE_MS })
    expect(r.effect).toEqual({ kind: 'stop' })
  })

  it('« Attendre la fin » déjà au repos : bascule après le délai', () => {
    let r = switchStep(null, { type: 'start', session: IDLE, target: 'work', wait: true, now: 0 })
    expect(r.effect).toBeNull()
    r = switchStep(r.state, { type: 'tick', now: IDLE_SETTLE_MS })
    expect(r.effect).toEqual({ kind: 'stop' })
  })

  it('annulation pendant l’attente ; rien à annuler une fois l’arrêt envoyé', () => {
    const w = switchStep(null, { type: 'start', session: BUSY, target: 'work', wait: true, now: 0 })
    expect(switchStep(w.state, { type: 'cancel' }).state).toBeNull()
    const s = switchStep(null, { type: 'start', session: IDLE, target: 'work', wait: false, now: 0 })
    expect(switchStep(s.state, { type: 'cancel' }).state?.kind).toBe('stopping')
  })

  it('arrêt qui ne vient pas : échec après le délai', () => {
    let r = switchStep(null, { type: 'start', session: IDLE, target: 'work', wait: false, now: 0 })
    r = switchStep(r.state, { type: 'tick', now: STOP_TIMEOUT_MS })
    expect(r.state).toMatchObject({ kind: 'failed', step: 'stop' })
  })

  it('arrêt refusé', () => {
    let r = switchStep(null, { type: 'start', session: IDLE, target: 'work', wait: false, now: 0 })
    r = switchStep(r.state, { type: 'stopFailed', message: 'démon non connecté', code: -2 })
    expect(r.state).toMatchObject({ kind: 'failed', step: 'stop', message: 'démon non connecté' })
  })

  it('« la session tourne encore » (-32002) : nouveaux essais, puis échec', () => {
    let r = switchStep(null, { type: 'start', session: { ...IDLE, alive: false }, target: 'work', wait: false, now: 0 })
    let now = 0
    for (let i = 1; i < RESUME_ATTEMPTS; i++) {
      r = switchStep(r.state, { type: 'resumeFailed', message: 'tourne encore', code: -32002, now })
      expect(r.state).toMatchObject({ kind: 'resuming', retryAt: now + RESUME_RETRY_MS })
      now += RESUME_RETRY_MS
      r = switchStep(r.state, { type: 'tick', now })
      expect(r.effect).toEqual({ kind: 'resume', profile: 'work' })
    }
    r = switchStep(r.state, { type: 'resumeFailed', message: 'tourne encore', code: -32002, now })
    expect(r.state).toMatchObject({ kind: 'failed', step: 'resume' })
  })

  it('reprise refusée (-32015) puis « Reprendre sous » l’origine', () => {
    let r = switchStep(null, { type: 'start', session: IDLE, target: 'work', wait: false, now: 0 })
    r = switchStep(r.state, { type: 'stopSent', alive: false, now: 1 })
    r = switchStep(r.state, { type: 'resumeFailed', message: 'pas de transcript', code: -32015, now: 2 })
    expect(r.state).toMatchObject({ kind: 'failed', step: 'resume', origin: 'perso', profile: 'work', code: -32015 })
    const stopped = { ...IDLE, alive: false }
    r = switchStep(r.state, { type: 'resumeAs', profile: 'perso', session: stopped, now: 3 })
    expect(r.effect).toEqual({ kind: 'resume', profile: 'perso' })
    r = switchStep(r.state, { type: 'resumed', warnings: ['dossier'] })
    expect(r.state).toEqual({ kind: 'done', target: 'perso', origin: 'perso', warnings: ['dossier'] } satisfies SwitchState)
  })

  it('session retirée (attente, arrêt, échec) : état purgé', () => {
    const w = switchStep(null, { type: 'start', session: BUSY, target: 'work', wait: true, now: 0 })
    expect(switchStep(w.state, { type: 'session', session: null, now: 1 }).state).toBeNull()
    const st = switchStep(null, { type: 'start', session: IDLE, target: 'work', wait: false, now: 0 })
    expect(switchStep(st.state, { type: 'session', session: null, now: 1 })).toEqual({ state: null, effect: null })
    const f = switchStep(st.state, { type: 'stopFailed', message: 'x', code: null })
    expect(switchStep(f.state, { type: 'session', session: null, now: 2 }).state).toBeNull()
  })

  it('session arrêtée d’elle-même pendant l’attente : aucune reprise sans clic', () => {
    const w = switchStep(null, { type: 'start', session: BUSY, target: 'work', wait: true, now: 0 })
    const stopped = { ...BUSY, alive: false, status: { state: 'stopped' as const } }
    const r = switchStep(w.state, { type: 'session', session: stopped, now: 1 })
    expect(r).toEqual({ state: { kind: 'interrupted', target: 'work', origin: 'perso' }, effect: null })
    expect(needsTicks(r.state)).toBe(false)
    expect(switchStep(r.state, { type: 'tick', now: 99_999 }).effect).toBeNull()
    // Reprise à confirmer d'un clic.
    expect(switchStep(r.state, { type: 'resumeAs', profile: 'work', session: stopped, now: 2 }).effect).toEqual({
      kind: 'resume',
      profile: 'work',
    })
    // Reprise faite ailleurs : l'information disparaît.
    expect(switchStep(r.state, { type: 'session', session: BUSY, now: 3 }).state).toBeNull()
    expect(switchStep(r.state, { type: 'cancel' }).state).toBeNull()
  })

  it('réponse de reprise perdue mais session repartie sous la cible : échec effacé', () => {
    let r = switchStep(null, { type: 'start', session: { ...IDLE, alive: false }, target: 'work', wait: false, now: 0 })
    r = switchStep(r.state, { type: 'resumeFailed', message: 'délai', code: -1, now: 1 })
    expect(r.state?.kind).toBe('failed')
    expect(switchStep(r.state, { type: 'session', session: { ...IDLE, profile: 'work' }, now: 2 }).state).toBeNull()
    expect(switchStep(r.state, { type: 'session', session: { ...IDLE, alive: false }, now: 2 }).state?.kind).toBe('failed')
  })

  it('double « start » : un seul arrêt', () => {
    const a = switchStep(null, { type: 'start', session: IDLE, target: 'work', wait: false, now: 0 })
    const b = switchStep(a.state, { type: 'start', session: IDLE, target: 'work', wait: false, now: 1 })
    expect(b).toEqual({ state: a.state, effect: null })
  })

  it('message d’échec : -32015 explique le profil', () => {
    expect(resumeFailureText(-32015, 'x', 'Work')).toMatch(/^le profil Work ne voit pas cette conversation/)
    expect(resumeFailureText(-32004, 'lancement impossible', 'Work')).toBe('lancement impossible')
    expect(originRetryCaveat(-32005, 'Perso')).toContain('échouera aussi')
    expect(originRetryCaveat(-32015, 'Perso')).toContain('peut aussi échouer')
  })
})

