import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TerminalRelay, type RelayClient } from '../src/main/daemon/relay'
import { RpcError } from '../src/main/daemon/rpc'
import { ErrorCode } from '../src/shared/protocol'
import type { PortDown } from '../src/shared/bridge'
import type { Snapshot } from '../src/shared/protocol'

const snap = (ansi: string): Snapshot => ({ cols: 80, rows: 24, cursor: { row: 0, col: 0, visible: true }, ansi, text: '' })

/** Faux démon : les réponses sont rendues à la main, comme à la réception d'une trame. */
function fakeClient() {
  const calls: { method: string; params: unknown; onResult?: (r: unknown) => void; resolve: (r: unknown) => void }[] = []
  const inputs: [string, number[]][] = []
  const client: RelayClient = {
    request(method, params, _t, onResult) {
      return new Promise((resolve, reject) => {
        calls.push({
          method,
          params,
          onResult: onResult as (r: unknown) => void,
          resolve: resolve as (r: unknown) => void,
          reject,
        } as (typeof calls)[number])
      })
    },
    sendInput(id, data) {
      inputs.push([id, [...data]])
      return true
    },
  }
  const respond = (method: string, result: unknown) => {
    const c = calls.find((x) => x.method === method && !(x as { done?: boolean }).done)!
    ;(c as { done?: boolean }).done = true
    c.onResult?.(result)
    c.resolve(result)
  }
  const fail = (method: string, err: Error) => {
    const c = calls.find((x) => x.method === method && !(x as { done?: boolean }).done)!
    ;(c as { done?: boolean; reject?: (e: Error) => void }).done = true
    ;(c as unknown as { reject: (e: Error) => void }).reject(err)
  }
  return { client, calls, inputs, respond, fail }
}

describe('relais du terminal (processus principal)', () => {
  let posted: PortDown[]
  beforeEach(() => {
    vi.useFakeTimers()
    posted = []
  })
  afterEach(() => vi.useRealTimers())

  function make(opts: ConstructorParameters<typeof TerminalRelay>[1] = {}) {
    const f = fakeClient()
    const relay = new TerminalRelay(f.client, { minBatchBytes: 8, maxDelayMs: 16, ...opts })
    relay.setSink({ post: (m) => posted.push(m) })
    return { ...f, relay }
  }

  it('redimensionne avant de s’abonner ; instantané avant les octets', async () => {
    const { relay, calls, respond } = make()
    const p = relay.view({ id: 'A', cols: 100, rows: 30 })
    expect(calls.map((c) => c.method)).toEqual(['sessions.resize', 'sessions.subscribe'])
    relay.onPty('A', Buffer.from('trop tôt')) // avant la réponse : ignoré
    respond('sessions.subscribe', { id: 'A', snapshot: snap('écran') })
    // Trame 0x02 traitée dans la même boucle que la réponse (avant toute promesse).
    relay.onPty('A', Buffer.from('suite-123'))
    await p
    expect(posted[0]).toMatchObject({ t: 'reset', id: 'A', reason: 'subscribe' })
    expect(posted[1]).toMatchObject({ t: 'data', id: 'A' })
    expect(Buffer.from((posted[1] as { bytes: Uint8Array }).bytes).toString()).toBe('suite-123')
    expect(posted).toHaveLength(2)
  })

  it('regroupe les petits morceaux (délai), envoie tout de suite au-delà du seuil', () => {
    const { relay, respond } = make()
    void relay.view({ id: 'A' })
    respond('sessions.subscribe', { id: 'A', snapshot: snap('') })
    relay.onPty('A', Buffer.from('ab'))
    relay.onPty('A', Buffer.from('cd'))
    expect(posted).toHaveLength(1)
    vi.advanceTimersByTime(16)
    expect(posted).toHaveLength(2)
    expect(Buffer.from((posted[1] as { bytes: Uint8Array }).bytes).toString()).toBe('abcd')
    relay.onPty('A', Buffer.from('0123456789'))
    expect(posted).toHaveLength(3)
  })

  it('seule la session affichée passe ; changement = désabonnement de la précédente', () => {
    const { relay, calls, respond } = make()
    void relay.view({ id: 'A' })
    respond('sessions.subscribe', { id: 'A', snapshot: snap('A') })
    relay.onPty('B', Buffer.from('autre session'))
    vi.advanceTimersByTime(20)
    expect(posted).toHaveLength(1)
    void relay.view({ id: 'B' })
    expect(calls.slice(-2).map((c) => [c.method, c.params])).toEqual([
      ['sessions.unsubscribe', { id: 'A' }],
      ['sessions.subscribe', { id: 'B' }],
    ])
    relay.onPty('A', Buffer.from('en vol'))
    respond('sessions.subscribe', { id: 'B', snapshot: snap('B') })
    vi.advanceTimersByTime(20)
    expect(posted.map((m) => m.t)).toEqual(['reset', 'reset'])
  })

  it('réponse d’un ancien abonnement ignorée après un changement', () => {
    const { relay, respond } = make()
    void relay.view({ id: 'A' })
    void relay.view({ id: 'B' })
    respond('sessions.subscribe', { id: 'A', snapshot: snap('A') })
    expect(posted).toHaveLength(0)
    respond('sessions.subscribe', { id: 'B', snapshot: snap('B') })
    expect(posted).toMatchObject([{ t: 'reset', id: 'B' }])
  })

  it('resync : lot en cours envoyé, puis nouvel instantané', () => {
    const { relay, respond } = make()
    void relay.view({ id: 'A' })
    respond('sessions.subscribe', { id: 'A', snapshot: snap('A') })
    relay.onPty('A', Buffer.from('x'))
    relay.onNotification({ method: 'session.resync', params: { id: 'A', snapshot: snap('A2') } })
    expect(posted.map((m) => m.t)).toEqual(['reset', 'data', 'reset'])
    expect(posted[2]).toMatchObject({ reason: 'resync' })
    relay.onNotification({ method: 'session.resync', params: { id: 'Z', snapshot: snap('Z') } })
    expect(posted).toHaveLength(3)
  })

  it('reconnexion : réabonnement de la session affichée', () => {
    const { relay, calls, respond } = make()
    void relay.view({ id: 'A', cols: 90, rows: 20 })
    respond('sessions.subscribe', { id: 'A', snapshot: snap('A') })
    relay.onDisconnected()
    relay.onPty('A', Buffer.from('perdu'))
    relay.onConnected()
    expect(calls.slice(-2).map((c) => c.method)).toEqual(['sessions.resize', 'sessions.subscribe'])
    respond('sessions.subscribe', { id: 'A', snapshot: snap('A') })
    expect(posted.map((m) => m.t)).toEqual(['reset', 'reset'])
  })

  it('touches : seulement vers la session affichée', () => {
    const { relay, inputs } = make()
    void relay.view({ id: 'A' })
    relay.input('A', new Uint8Array([0x6c, 0x0d]))
    relay.input('B', new Uint8Array([0x78]))
    expect(inputs).toEqual([['A', [0x6c, 0x0d]]])
  })

  it('aucune session : message « none »', async () => {
    const { relay, calls } = make()
    void relay.view({ id: 'A' })
    await relay.view({ id: null })
    expect(calls.at(-1)).toMatchObject({ method: 'sessions.unsubscribe', params: { id: 'A' } })
    expect(posted.at(-1)).toMatchObject({ t: 'none' })
  })

  it('contrôle de flux : suspension au-delà du seuil, nouvel instantané quand la page a rattrapé', () => {
    const { relay, calls, respond } = make({ highWaterBytes: 30, resumeBelowBytes: 10 })
    void relay.view({ id: 'A' })
    respond('sessions.subscribe', { id: 'A', snapshot: snap('A') })
    const gen = (posted[0] as { gen: number }).gen
    relay.onPty('A', Buffer.alloc(12)) // 12 en vol
    relay.onPty('A', Buffer.alloc(12)) // 24 en vol
    relay.onPty('A', Buffer.alloc(12)) // dépasserait 30 : abandonné, suspendu
    expect(posted.map((m) => m.t)).toEqual(['reset', 'data', 'data', 'paused'])
    expect(relay.isPaused).toBe(true)
    relay.onPty('A', Buffer.alloc(12)) // abandonné aussi
    vi.advanceTimersByTime(50)
    expect(posted).toHaveLength(4)
    const before = calls.length
    relay.ack(gen, 12) // 12 en vol : pas encore assez
    expect(calls.length).toBe(before)
    relay.ack(gen + 99, 12) // accusé d'un autre abonnement : ignoré
    relay.ack(gen, 12) // 0 en vol : reprise par un nouvel instantané
    expect(calls.slice(before).map((c) => c.method)).toEqual(['sessions.subscribe'])
    respond('sessions.subscribe', { id: 'A', snapshot: snap('A2') })
    expect(posted.at(-1)).toMatchObject({ t: 'reset', reason: 'subscribe' })
    expect(relay.isPaused).toBe(false)
    relay.onPty('A', Buffer.alloc(9))
    expect(posted.at(-1)).toMatchObject({ t: 'data' })
  })

  it('abonnement sans réponse : nouvel essai (désabonnement + abonnement), puis échec en français', async () => {
    const { relay, calls, fail, respond } = make({ subscribeRetries: 1, subscribeBackoffMs: 100 })
    const p = relay.view({ id: 'A' })
    fail('sessions.subscribe', new RpcError(ErrorCode.Timeout, 'délai'))
    await vi.advanceTimersByTimeAsync(100)
    expect(calls.map((c) => c.method)).toEqual(['sessions.subscribe', 'sessions.unsubscribe', 'sessions.subscribe'])
    fail('sessions.subscribe', new RpcError(ErrorCode.Timeout, 'délai'))
    await expect(p).rejects.toThrow(/le terminal ne répond pas/)
    // Un succès au deuxième essai suffit.
    const q = relay.view({ id: 'B' })
    fail('sessions.subscribe', new RpcError(ErrorCode.Timeout, 'délai'))
    await vi.advanceTimersByTimeAsync(100)
    respond('sessions.subscribe', { id: 'B', snapshot: snap('B') })
    await expect(q).resolves.toBeUndefined()
  })
})
