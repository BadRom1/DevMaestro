import { describe, expect, it } from 'vitest'

import type { PendingRequest } from '../src/shared/protocol'
import { initialState, isStale, reducer, type AppState } from '../src/renderer/src/state/store'
import { session } from './fixtures'

const perm = (id: number): PendingRequest => ({
  request_id: id,
  pending: { kind: 'permission', tool_name: 'Bash', tool_input: { command: 'ls' } },
  since: '2026-10-19T10:00:00Z',
})

describe('état de la page', () => {
  it('session.updated : ajout puis remplacement (le dernier fait foi)', () => {
    const s = session()
    let st = reducer(initialState, { type: 'session.updated', session: s })
    expect(st.sessions[s.id]).toBe(s)
    const s2 = { ...s, status: { state: 'waiting' as const, wait: 'permission' as const }, pending: [perm(1)] }
    st = reducer(st, { type: 'session.updated', session: s2 })
    expect(st.sessions[s.id]!.status.state).toBe('waiting')
    expect(Object.keys(st.sessions)).toHaveLength(1)
  })

  it('session.response : ignorée si un session.updated plus récent est arrivé', () => {
    const s = session({ updated_at: '2026-10-19T10:00:00.100Z', title: null })
    let st = reducer(initialState, { type: 'session.updated', session: s })
    const fresh = { ...s, title: 'Nouveau', updated_at: '2026-10-19T10:00:00.200Z' }
    st = reducer(st, { type: 'session.response', session: fresh })
    expect(st.sessions[s.id]!.title).toBe('Nouveau')
    const late = { ...s, title: 'Ancien', updated_at: '2026-10-19T10:00:00.150Z' }
    expect(reducer(st, { type: 'session.response', session: late })).toBe(st)
    // Session inconnue : ajoutée.
    const other = session()
    expect(reducer(st, { type: 'session.response', session: other }).sessions[other.id]).toBe(other)
  })

  it('sessions.list remplace tout (reconnexion)', () => {
    const a = session()
    const b = session()
    let st = reducer(initialState, { type: 'session.updated', session: a })
    st = reducer(st, { type: 'sessions', sessions: [b] })
    expect(Object.keys(st.sessions)).toEqual([b.id])
  })

  it('effets : possibly_stale, puis request_resolved retire la demande', () => {
    const s = session({ status: { state: 'waiting', wait: 'permission' }, pending: [perm(1), perm(2)] })
    let st: AppState = reducer(initialState, { type: 'session.updated', session: s })
    st = reducer(st, { type: 'session.effect', id: s.id, effect: { type: 'possibly_stale', request_ids: [1] } })
    expect(isStale(st, s.id, 1)).toBe(true)
    expect(isStale(st, s.id, 2)).toBe(false)
    st = reducer(st, { type: 'session.effect', id: s.id, effect: { type: 'request_resolved', request_id: 1, how: 'answered' } })
    expect(st.sessions[s.id]!.pending.map((p) => p.request_id)).toEqual([2])
    expect(isStale(st, s.id, 1)).toBe(false)
    expect(st.stale[s.id]).toBeUndefined()
  })

  it('session.updated élague les marques obsolètes des demandes disparues', () => {
    const s = session({ pending: [perm(1), perm(2)] })
    let st = reducer(initialState, { type: 'session.updated', session: s })
    st = reducer(st, { type: 'session.effect', id: s.id, effect: { type: 'possibly_stale', request_ids: [1, 2] } })
    st = reducer(st, { type: 'session.updated', session: { ...s, pending: [perm(2)] } })
    expect(st.stale[s.id]).toEqual([2])
  })

  it('clear_waiting efface les marques ; notify_waiting ne change rien', () => {
    const s = session({ pending: [perm(3)] })
    let st = reducer(initialState, { type: 'session.updated', session: s })
    st = reducer(st, { type: 'session.effect', id: s.id, effect: { type: 'possibly_stale', request_ids: [3] } })
    st = reducer(st, { type: 'session.effect', id: s.id, effect: { type: 'clear_waiting' } })
    expect(st.stale).toEqual({})
    const before = st
    st = reducer(st, {
      type: 'session.effect',
      id: s.id,
      effect: { type: 'notify_waiting', request_id: 4, pending: { kind: 'question', detailed: false } },
    })
    expect(st).toBe(before)
  })

  it('drapeau possibly_stale de la session', () => {
    const s = session({ possibly_stale: true, pending: [perm(1)] })
    const st = reducer(initialState, { type: 'session.updated', session: s })
    expect(isStale(st, s.id, 1)).toBe(true)
  })

  it('effet pour une session inconnue : sans erreur', () => {
    const st = reducer(initialState, {
      type: 'session.effect',
      id: 'inconnue',
      effect: { type: 'request_resolved', request_id: 1, how: 'cleared' },
    })
    expect(st.sessions).toEqual({})
  })
})
