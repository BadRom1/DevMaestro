import { describe, expect, it } from 'vitest'

import { ErrorCode } from '../src/shared/protocol'
import {
  MODE_CONFIRM_MS,
  MODE_RETRY_MS,
  displayedMode,
  idleMode,
  modeReducer,
  type ModeEvent,
  type ModeSwitch,
} from '../src/renderer/src/state/modeSwitch'

function run(events: ModeEvent[], from: ModeSwitch = idleMode): ModeSwitch {
  return events.reduce(modeReducer, from)
}

const T0 = 1_000_000

describe('changement de mode', () => {
  it('attend la confirmation par session.updated', () => {
    const s1 = run([{ type: 'request', target: 'plan', mode: 'default', now: T0 }])
    expect(s1).toMatchObject({ phase: 'pending', target: 'plan', deadline: T0 + MODE_CONFIRM_MS })
    expect(displayedMode(s1, 'default')).toBe('plan')
    const s2 = run([{ type: 'sent', sent: 2, mode: 'default' }], s1)
    expect(s2.phase).toBe('pending')
    // Un mode intermédiaire ne clôt pas l'attente.
    const s3 = run([{ type: 'session', mode: 'acceptEdits', alive: true }], s2)
    expect(s3.phase).toBe('pending')
    const s4 = run([{ type: 'session', mode: 'plan', alive: true }], s3)
    expect(s4).toEqual(idleMode)
    expect(displayedMode(s4, 'plan')).toBe('plan')
  })

  it('confirmation arrivée avant la réponse', () => {
    const s = run([
      { type: 'request', target: 'auto', mode: 'plan', now: T0 },
      { type: 'session', mode: 'auto', alive: true },
      { type: 'sent', sent: 1, mode: 'auto' },
    ])
    expect(s).toEqual(idleMode)
  })

  it('« manual » vaut « default »', () => {
    const s = run([
      { type: 'request', target: 'default', mode: 'plan', now: T0 },
      { type: 'session', mode: 'manual', alive: true },
    ])
    expect(s).toEqual(idleMode)
    expect(displayedMode(s, 'manual')).toBe('default')
    expect(run([{ type: 'request', target: 'default', mode: 'manual', now: T0 }])).toEqual(idleMode)
  })

  it('aucune touche envoyée : rien à attendre', () => {
    const s = run([
      { type: 'request', target: 'plan', mode: 'default', now: T0 },
      { type: 'sent', sent: 0, mode: 'default' },
    ])
    expect(s).toEqual(idleMode)
  })

  it('sans confirmation après 3 s : affiche le vrai mode et le dit', () => {
    const s = run([
      { type: 'request', target: 'plan', mode: 'default', now: T0 },
      { type: 'sent', sent: 2, mode: 'default' },
      { type: 'timeout', mode: 'acceptEdits' },
    ])
    expect(s.phase).toBe('idle')
    expect(s.phase === 'idle' && s.error).toMatch(/pas été confirmé.*Accepter les modifs/)
    expect(s.phase === 'idle' && s.errorMode).toBe('acceptEdits')
    expect(displayedMode(s, 'acceptEdits')).toBe('acceptEdits')
  })

  it('le délai écoulé mais le mode atteint : pas d’erreur', () => {
    const s = run([
      { type: 'request', target: 'plan', mode: 'default', now: T0 },
      { type: 'timeout', mode: 'plan' },
    ])
    expect(s).toEqual(idleMode)
  })

  it('-32002 : un seul réessai silencieux après 500 ms', () => {
    const s1 = run([
      { type: 'request', target: 'plan', mode: 'default', now: T0 },
      { type: 'failed', code: ErrorCode.InvalidState, message: 'changement de mode vers « plan » pas encore confirmé par Claude Code : réessayer après le prochain hook', mode: 'default', now: T0 + 10 },
    ])
    expect(s1).toMatchObject({ phase: 'pending', retried: true, retryAt: T0 + 10 + MODE_RETRY_MS })
    // Pendant le réessai programmé, un délai n'interrompt rien.
    expect(run([{ type: 'timeout', mode: 'default' }], s1)).toBe(s1)
    const s2 = run([{ type: 'retrying', now: T0 + 510 }], s1)
    expect(s2).toMatchObject({ phase: 'pending', retryAt: null, deadline: T0 + 510 + MODE_CONFIRM_MS })
    const ok = run([{ type: 'session', mode: 'plan', alive: true }], s2)
    expect(ok).toEqual(idleMode)
    const ko = run([{ type: 'failed', code: ErrorCode.InvalidState, message: 'changement de mode vers « plan » pas encore confirmé par Claude Code : réessayer après le prochain hook', mode: 'default', now: T0 + 600 }], s2)
    expect(ko.phase).toBe('idle')
    expect(ko.phase === 'idle' && ko.error).toMatch(/^Changement de mode impossible : changement de mode vers « plan » pas encore confirmé/)
  })

  it('-32002 pour une autre raison : pas de réessai, raison du démon affichée', () => {
    for (const message of ['la session ne tourne pas', 'une demande attend une réponse']) {
      const s = run([
        { type: 'request', target: 'plan', mode: 'default', now: T0 },
        { type: 'failed', code: ErrorCode.InvalidState, message, mode: 'default', now: T0 },
      ])
      expect(s).toEqual({ phase: 'idle', error: `Changement de mode impossible : ${message}`, errorMode: 'default' })
    }
  })

  it('l’erreur s’efface dès que le mode de la session change', () => {
    const timedOut = run([
      { type: 'request', target: 'plan', mode: 'default', now: T0 },
      { type: 'timeout', mode: 'acceptEdits' },
    ])
    expect(timedOut.phase === 'idle' && timedOut.error).toBeTruthy()
    // Même mode (`session.updated` sans changement de mode) : l'erreur reste.
    expect(run([{ type: 'session', mode: 'acceptEdits', alive: true }], timedOut)).toBe(timedOut)
    // Le mode visé arrive en retard : l'erreur disparaît.
    expect(run([{ type: 'session', mode: 'plan', alive: true }], timedOut)).toEqual(idleMode)
    // Tout autre changement aussi.
    expect(run([{ type: 'session', mode: 'auto', alive: true }], timedOut)).toEqual(idleMode)
    const failed = run([
      { type: 'request', target: 'plan', mode: 'manual', now: T0 },
      { type: 'failed', code: -32014, message: 'x', mode: 'manual', now: T0 },
    ])
    expect(run([{ type: 'session', mode: 'default', alive: true }], failed)).toBe(failed)
    expect(run([{ type: 'session', mode: 'plan', alive: true }], failed)).toEqual(idleMode)
  })

  it('autres erreurs : message en français, sans réessai', () => {
    const s = run([
      { type: 'request', target: 'plan', mode: 'default', now: T0 },
      { type: 'failed', code: -32014, message: 'mode courant inconnu', mode: 'default', now: T0 },
    ])
    expect(s.phase === 'idle' && s.error).toBe(
      'Changement de mode impossible : mode courant inconnu ou hors du cycle Shift+Tab (mode courant inconnu)',
    )
    const d = run([
      { type: 'request', target: 'plan', mode: 'default', now: T0 },
      { type: 'failed', code: ErrorCode.Disconnected, message: 'x', mode: 'default', now: T0 },
    ])
    expect(d.phase === 'idle' && d.error).toBe('Changement de mode impossible : démon non connecté')
  })

  it('fin de la session : l’attente cesse', () => {
    const s = run([
      { type: 'request', target: 'plan', mode: 'default', now: T0 },
      { type: 'session', mode: 'default', alive: false },
    ])
    expect(s).toEqual(idleMode)
  })

  it('hors attente, le sélecteur suit toujours le dernier session.updated', () => {
    const s = run([
      { type: 'request', target: 'plan', mode: 'default', now: T0 },
      { type: 'session', mode: 'plan', alive: true },
    ])
    expect(displayedMode(s, 'auto')).toBe('auto')
    // Une nouvelle demande efface l'erreur précédente.
    const err: ModeSwitch = { phase: 'idle', error: 'x' }
    expect(run([{ type: 'request', target: 'auto', mode: 'plan', now: T0 }], err).phase).toBe('pending')
    // Demande ignorée pendant une attente.
    const p = run([{ type: 'request', target: 'plan', mode: 'default', now: T0 }])
    expect(run([{ type: 'request', target: 'auto', mode: 'default', now: T0 }], p)).toBe(p)
  })
})
