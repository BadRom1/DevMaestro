import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RpcClient, RpcError } from '../src/main/daemon/rpc'
import { ErrorCode } from '../src/shared/protocol'

describe('client JSON-RPC', () => {
  let sent: Record<string, unknown>[]
  let rpc: RpcClient
  beforeEach(() => {
    vi.useFakeTimers()
    sent = []
    rpc = new RpcClient((m) => sent.push(m as Record<string, unknown>), { timeoutMs: 1000 })
  })
  afterEach(() => vi.useRealTimers())

  it('identifiants croissants et réponses dans le désordre', async () => {
    const a = rpc.request('a', { x: 1 })
    const b = rpc.request('b')
    expect(sent).toEqual([
      { jsonrpc: '2.0', id: 1, method: 'a', params: { x: 1 } },
      { jsonrpc: '2.0', id: 2, method: 'b', params: {} },
    ])
    rpc.handle({ jsonrpc: '2.0', id: 2, result: 'B' })
    rpc.handle({ jsonrpc: '2.0', id: 1, result: 'A' })
    await expect(a).resolves.toBe('A')
    await expect(b).resolves.toBe('B')
    expect(rpc.pendingCount).toBe(0)
  })

  it('erreur du démon : code et message', async () => {
    const p = rpc.request('sessions.get', { id: 'x' })
    rpc.handle({ jsonrpc: '2.0', id: 1, error: { code: -32001, message: 'session inconnue' } })
    await expect(p).rejects.toMatchObject({ name: 'RpcError', code: -32001, message: 'session inconnue' })
  })

  it('délai dépassé, puis réponse tardive ignorée', async () => {
    const p = rpc.request('lent', {}, 500)
    vi.advanceTimersByTime(499)
    expect(rpc.pendingCount).toBe(1)
    vi.advanceTimersByTime(1)
    await expect(p).rejects.toMatchObject({ code: ErrorCode.Timeout })
    expect(rpc.handle({ jsonrpc: '2.0', id: 1, result: 1 })).toBeNull()
  })

  it('notifications du démon', () => {
    expect(rpc.handle({ jsonrpc: '2.0', method: 'session.updated', params: { session: {} } })).toEqual({
      method: 'session.updated',
      params: { session: {} },
    })
    expect(rpc.handle('n’importe quoi')).toBeNull()
    expect(rpc.handle([1, 2])).toBeNull()
  })

  it('connexion perdue : toutes les requêtes en vol sont rejetées', async () => {
    const a = rpc.request('a')
    const b = rpc.request('b')
    rpc.failAll('connexion perdue')
    await expect(a).rejects.toMatchObject({ code: ErrorCode.Disconnected })
    await expect(b).rejects.toBeInstanceOf(RpcError)
    expect(rpc.pendingCount).toBe(0)
  })

  it('onResult est appelé de façon synchrone, avant la résolution', () => {
    const order: string[] = []
    void rpc.request('sessions.subscribe', {}, undefined, () => order.push('onResult')).then(() => order.push('then'))
    rpc.handle({ jsonrpc: '2.0', id: 1, result: {} })
    order.push('après handle')
    expect(order).toEqual(['onResult', 'après handle'])
  })

  it('échec d’envoi : rejet immédiat', async () => {
    const broken = new RpcClient(() => {
      throw new Error('socket fermé')
    })
    await expect(broken.request('x')).rejects.toMatchObject({ code: ErrorCode.Disconnected })
    expect(broken.pendingCount).toBe(0)
  })
})
