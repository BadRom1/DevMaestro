/** Client du démon contre un faux démon (socket Unix de test) : reconnexion, démarrage, refus, trames. */
import { mkdtempSync, rmSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { ConnectionState } from '../src/shared/bridge'
import { DaemonClient, MAX_INPUT_CHUNK } from '../src/main/daemon/client'
import { FrameDecoder, FrameType, decodePtyPayload, encodeRpc } from '../src/main/daemon/frames'
import { ErrorCode } from '../src/shared/protocol'

const ID = '0c69fdc4-b2c9-4511-97c8-bb78d2323d61'

async function until<T>(f: () => T | undefined | false | null, ms = 3000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = f()
    if (v) return v
    if (Date.now() - start > ms) throw new Error('délai dépassé')
    await new Promise((r) => setTimeout(r, 5))
  }
}

type Handler = (sock: net.Socket, msg: { id?: number; method?: string } | null, raw: { type: number; payload: Buffer }) => void

const cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

function tmpSocket(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dmc-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return path.join(dir, 's.sock')
}

/** Faux démon : `onConnect` à chaque connexion, `handler` à chaque trame. */
function fakeDaemon(socketPath: string, handler: Handler, onConnect?: (s: net.Socket) => void) {
  const conns: net.Socket[] = []
  const server = net.createServer((sock) => {
    conns.push(sock)
    onConnect?.(sock)
    const d = new FrameDecoder()
    sock.on('data', (c: Buffer) => {
      for (const f of d.push(c)) {
        const msg = f.type === FrameType.Rpc ? JSON.parse(f.payload.toString()) : null
        handler(sock, msg, f)
      }
    })
    sock.on('error', () => {})
  })
  server.listen(socketPath)
  cleanups.push(() => {
    conns.forEach((c) => c.destroy())
    server.close()
  })
  return { server, conns }
}

const hello = (protocol = 1): Handler => (sock, msg) => {
  if (msg?.method === 'hello') sock.write(encodeRpc({ jsonrpc: '2.0', id: msg.id, result: { server: 'orchd', version: 't', protocol, pid: 1 } }))
}

function client(socketPath: string, extra: Partial<ConstructorParameters<typeof DaemonClient>[0]> = {}) {
  const states: ConnectionState[] = []
  const c = new DaemonClient({ socketPath, backoffInitialMs: 10, backoffMaxMs: 40, helloTimeoutMs: 500, ...extra })
  c.on('state', (s) => states.push(s))
  cleanups.push(() => c.stop())
  return { c, states }
}

describe('client du démon', () => {
  it('attente croissante et plafonnée entre les essais', async () => {
    const { c, states } = client(tmpSocket())
    c.start()
    await until(() => states.filter((s) => s.state === 'disconnected').length >= 4)
    const delays = states.flatMap((s) => (s.state === 'disconnected' ? [s.retryInMs] : []))
    expect(delays.slice(0, 4)).toEqual([20, 40, 40, 40])
  })

  it('démarre le démon si le socket manque, au plus une fois par intervalle', async () => {
    let spawns = 0
    const { c, states } = client(tmpSocket(), {
      respawnIntervalMs: 60_000,
      startDaemon: () => {
        spawns++
        return { bin: 'orchd', error: Promise.resolve(null) }
      },
    })
    c.start()
    await until(() => states.filter((s) => s.state === 'connecting').length >= 6)
    expect(spawns).toBe(1)
    expect(states.some((s) => s.state === 'starting-daemon')).toBe(true)
  })

  it('protocole incompatible : arrêt sans reconnexion', async () => {
    const p = tmpSocket()
    const d = fakeDaemon(p, hello(2))
    const { c, states } = client(p)
    c.start()
    await until(() => states.find((s) => s.state === 'incompatible'))
    await new Promise((r) => setTimeout(r, 100))
    expect(d.conns).toHaveLength(1)
    expect(c.connected).toBe(false)
  })

  it('requêtes en vol rejetées quand la connexion tombe, puis reconnexion', async () => {
    const p = tmpSocket()
    const d = fakeDaemon(p, (sock, msg, raw) => {
      hello()(sock, msg, raw)
      if (msg?.method === 'sessions.list') sock.destroy()
    })
    const { c } = client(p)
    c.start()
    await c.waitConnected(2000)
    await expect(c.request('sessions.list')).rejects.toMatchObject({ code: ErrorCode.Disconnected })
    await until(() => d.conns.length >= 2 && c.connected)
  })

  it('trame invalide : connexion fermée puis rétablie', async () => {
    const p = tmpSocket()
    let first = true
    const d = fakeDaemon(p, (sock, msg, raw) => {
      hello()(sock, msg, raw)
      if (msg?.method === 'hello' && first) {
        first = false
        sock.write(Buffer.from([0, 0, 0, 0])) // longueur nulle
      }
    })
    const { c, states } = client(p)
    c.start()
    await until(() => d.conns.length >= 2 && c.connected)
    expect(states.filter((s) => s.state === 'connected')).toHaveLength(2)
  })

  it('refus du pair (fermeture sans réponse) : annoncé, sans boucle rapide', async () => {
    const p = tmpSocket()
    const d = fakeDaemon(p, () => {}, (sock) => sock.destroy())
    const { c, states } = client(p, { refusalThreshold: 3, refusedRetryMs: 60_000, insideSession: true })
    c.start()
    const refused = await until(() => states.find((s) => s.state === 'refused'))
    expect(refused.state === 'refused' && refused.error).toMatch(/lancée depuis une session DevMaestro/)
    const n = d.conns.length
    await new Promise((r) => setTimeout(r, 150))
    expect(d.conns.length).toBe(n)
  })

  it('entrées : trames 0x03 d’au plus 64 Kio, dans l’ordre, sans perte', async () => {
    const p = tmpSocket()
    const got: Buffer[] = []
    const sizes: number[] = []
    fakeDaemon(p, (sock, msg, raw) => {
      hello()(sock, msg, raw)
      if (raw.type === FrameType.PtyInput) {
        const { id, data } = decodePtyPayload(raw.payload)
        expect(id).toBe(ID)
        sizes.push(data.length)
        got.push(Buffer.from(data))
      }
    })
    const { c } = client(p)
    c.start()
    await c.waitConnected(2000)
    const big = Buffer.alloc(150 * 1024)
    for (let i = 0; i < big.length; i++) big[i] = i % 251
    expect(c.sendInput(ID, big)).toBe(true)
    await until(() => got.reduce((n, b) => n + b.length, 0) === big.length)
    expect(sizes.every((s) => s <= MAX_INPUT_CHUNK)).toBe(true)
    expect(sizes).toHaveLength(3)
    expect(Buffer.concat(got).equals(big)).toBe(true)
    expect(c.sendInput('pas-un-uuid', Buffer.from('x'))).toBe(false)
  })

  it('entrées refusées hors connexion', () => {
    const { c } = client(tmpSocket())
    expect(c.sendInput(ID, Buffer.from('x'))).toBe(false)
  })
})
