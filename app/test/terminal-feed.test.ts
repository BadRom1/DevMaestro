import { describe, expect, it } from 'vitest'

import { CLEAR, FULL_RESET, TerminalFeed } from '../src/renderer/src/terminal/feed'
import type { Snapshot } from '../src/shared/protocol'

const snap = (ansi: string): Snapshot => ({ cols: 80, rows: 24, cursor: { row: 0, col: 0, visible: true }, ansi, text: '' })

function setup() {
  const writes: (string | Uint8Array)[] = []
  const feed = new TerminalFeed({ write: (d) => writes.push(d) })
  return { feed, writes }
}

describe('canal du terminal côté page', () => {
  it('abonnement : réinitialisation, effacement puis écran ; ensuite les octets', () => {
    const { feed, writes } = setup()
    feed.expect('A')
    expect(feed.handle({ t: 'data', id: 'A', gen: 1, bytes: new Uint8Array([1]) })).toBe(false)
    expect(feed.handle({ t: 'reset', id: 'A', gen: 1, snapshot: snap('écran'), reason: 'subscribe' })).toBe(true)
    expect(feed.handle({ t: 'data', id: 'A', gen: 1, bytes: new Uint8Array([0x61]) })).toBe(true)
    expect(writes).toEqual([FULL_RESET + CLEAR + 'écran', new Uint8Array([0x61])])
    expect(CLEAR).toBe('\x1b[0m\x1b[2J\x1b[H')
  })

  it('resync : effacement sans réinitialisation complète', () => {
    const { feed, writes } = setup()
    feed.expect('A')
    feed.handle({ t: 'reset', id: 'A', gen: 1, snapshot: snap('1'), reason: 'subscribe' })
    feed.handle({ t: 'reset', id: 'A', gen: 1, snapshot: snap('2'), reason: 'resync' })
    expect(writes[1]).toBe(CLEAR + '2')
  })

  it('changement de session : messages de l’ancienne ignorés', () => {
    const { feed, writes } = setup()
    feed.expect('A')
    feed.handle({ t: 'reset', id: 'A', gen: 1, snapshot: snap('A'), reason: 'subscribe' })
    feed.expect('B')
    expect(feed.handle({ t: 'data', id: 'A', gen: 1, bytes: new Uint8Array([1]) })).toBe(false)
    expect(feed.handle({ t: 'reset', id: 'A', gen: 1, snapshot: snap('A'), reason: 'resync' })).toBe(false)
    expect(feed.handle({ t: 'reset', id: 'B', gen: 2, snapshot: snap('B'), reason: 'subscribe' })).toBe(true)
    expect(writes).toHaveLength(2)
  })

  it('aller-retour A → B → A : un ancien instantané ne passe pas après le nouveau', () => {
    const { feed } = setup()
    feed.expect('A')
    feed.handle({ t: 'reset', id: 'A', gen: 3, snapshot: snap('récent'), reason: 'subscribe' })
    expect(feed.handle({ t: 'reset', id: 'A', gen: 1, snapshot: snap('vieux'), reason: 'subscribe' })).toBe(false)
    expect(feed.handle({ t: 'data', id: 'A', gen: 1, bytes: new Uint8Array([1]) })).toBe(false)
  })

  it('aucune session : terminal réinitialisé', () => {
    const { feed, writes } = setup()
    feed.expect(null)
    expect(feed.handle({ t: 'none', gen: 4 })).toBe(true)
    expect(writes).toEqual([FULL_RESET])
  })
})

describe('contrôle de flux et taille côté page', () => {
  it('accusé après l’écriture effective, lots périmés acquittés aussitôt', () => {
    const acks: [number, number][] = []
    const pending: (() => void)[] = []
    const feed = new TerminalFeed(
      { write: (_d, done) => done && pending.push(done) },
      { ack: (g, n) => acks.push([g, n]) },
    )
    feed.expect('A')
    feed.handle({ t: 'reset', id: 'A', gen: 2, snapshot: snap(''), reason: 'subscribe' })
    feed.handle({ t: 'data', id: 'A', gen: 2, bytes: new Uint8Array(10) })
    expect(acks).toEqual([])
    pending.forEach((f) => f())
    expect(acks).toEqual([[2, 10]])
    feed.handle({ t: 'data', id: 'A', gen: 1, bytes: new Uint8Array(5) })
    expect(acks).toEqual([[2, 10], [1, 5]])
  })

  it('instantané d’une autre taille : signalé avant l’écriture', () => {
    const order: string[] = []
    const feed = new TerminalFeed(
      { cols: 80, rows: 24, write: () => order.push('write') },
      { sizeMismatch: (c, r) => order.push(`taille ${c}x${r}`) },
    )
    feed.expect('A')
    feed.handle({ t: 'reset', id: 'A', gen: 1, snapshot: { ...snap(''), cols: 100, rows: 30 }, reason: 'subscribe' })
    expect(order).toEqual(['taille 100x30', 'write'])
  })

  it('suspension annoncée pour la session affichée seulement', () => {
    let paused = 0
    const feed = new TerminalFeed({ write: () => {} }, { paused: () => paused++ })
    feed.expect('A')
    feed.handle({ t: 'reset', id: 'A', gen: 1, snapshot: snap(''), reason: 'subscribe' })
    feed.handle({ t: 'paused', id: 'B', gen: 1 })
    feed.handle({ t: 'paused', id: 'A', gen: 1 })
    expect(paused).toBe(1)
  })
})
