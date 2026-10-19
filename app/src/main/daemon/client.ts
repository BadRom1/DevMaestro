/**
 * Client du démon `orchd` pour le processus principal (sans dépendance à
 * Electron, testable sous Node) : connexion au socket de contrôle, `hello`,
 * requêtes JSON-RPC, notifications, trames de terminal, reconnexion avec
 * attente croissante, démarrage du démon s'il est absent.
 *
 * Écritures : une seule file pour toutes les trames, qui respecte la
 * contre-pression du socket (`write` → `false` : on attend `drain`).
 *
 * Refus du pair (protocole § 1) : le démon ferme sans répondre une connexion
 * venue d'un processus lancé depuis une session supervisée. Le client le
 * reconnaît (fermeture après connexion, sans réponse au `hello`, plusieurs
 * fois de suite) et l'annonce au lieu de boucler.
 */
import { EventEmitter } from 'node:events'
import net from 'node:net'

import type { ConnectionState } from '../../shared/bridge'
import { ErrorCode, PROTOCOL_VERSION } from '../../shared/protocol'
import { FrameDecoder, FrameType, decodePtyPayload, encodePtyInput, encodeRpc } from './frames'
import { RpcClient, RpcError, type RpcNotification } from './rpc'

/** Taille maximale des octets d'une trame d'entrée 0x03 (hors UUID). */
export const MAX_INPUT_CHUNK = 64 * 1024
/** Au-delà, les entrées en attente d'écriture sont refusées (le démon ne lit plus). */
export const MAX_QUEUED_BYTES = 16 * 1024 * 1024

export interface DaemonClientOptions {
  socketPath: string
  clientName?: string
  /** Lance le démon ; appelé quand le socket est absent ou refuse la connexion. */
  startDaemon?: () => { bin: string; error: Promise<Error | null> }
  requestTimeoutMs?: number
  helloTimeoutMs?: number
  backoffInitialMs?: number
  backoffMaxMs?: number
  /** Délai minimal entre deux démarrages du démon. */
  respawnIntervalMs?: number
  /** Fermetures sans réponse au `hello` avant de conclure à un refus du pair. */
  refusalThreshold?: number
  /** Attente entre deux essais une fois le refus constaté. */
  refusedRetryMs?: number
  /** Indice : le processus semble lancé depuis une session (variables `ORCH_*`). */
  insideSession?: boolean
  log?: (msg: string) => void
}

export interface HelloResult {
  server: string
  version: string
  protocol: number
  pid: number
}

export interface DaemonClientEvents {
  state: [ConnectionState]
  connected: [HelloResult]
  notification: [RpcNotification]
  pty: [string, Buffer]
}

type Resolved = Required<Omit<DaemonClientOptions, 'startDaemon'>> & Pick<DaemonClientOptions, 'startDaemon'>

export function refusalMessage(insideSession: boolean): string {
  return insideSession
    ? 'le démon refuse cette connexion : l’app a été lancée depuis une session DevMaestro (variables ORCH_* présentes). Lance-la hors des sessions, depuis un terminal ordinaire ou le menu des applications.'
    : 'le démon ferme la connexion sans répondre : l’app a sans doute été lancée depuis une session DevMaestro (contrôle du pair). Lance-la hors des sessions.'
}

export class DaemonClient extends EventEmitter<DaemonClientEvents> {
  private socket: net.Socket | null = null
  private rpc: RpcClient | null = null
  private ready = false
  private stopped = true
  private attempt = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private lastSpawn = -Infinity
  private lastError = ''
  private silentCloses = 0
  private current: ConnectionState = { state: 'connecting', attempt: 0 }
  private queue: Buffer[] = []
  private queued = 0
  private blocked = false
  private readonly o: Resolved

  constructor(opts: DaemonClientOptions) {
    super()
    this.o = {
      clientName: 'devmaestro-app',
      requestTimeoutMs: 10_000,
      helloTimeoutMs: 3_000,
      backoffInitialMs: 150,
      backoffMaxMs: 5_000,
      respawnIntervalMs: 10_000,
      refusalThreshold: 3,
      refusedRetryMs: 30_000,
      insideSession: false,
      log: () => {},
      ...opts,
    }
  }

  get state(): ConnectionState {
    return this.current
  }

  get connected(): boolean {
    return this.ready
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.socket?.destroy()
    this.socket = null
  }

  /** Attend la prochaine connexion prête (ou la connexion en cours). */
  waitConnected(timeoutMs = 10_000): Promise<HelloResult> {
    if (this.ready && this.current.state === 'connected') {
      const c = this.current
      return Promise.resolve({ server: c.server, version: c.version, protocol: PROTOCOL_VERSION, pid: c.pid })
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.off('connected', on)
        reject(new Error('démon injoignable'))
      }, timeoutMs)
      const on = (h: HelloResult) => {
        clearTimeout(t)
        resolve(h)
      }
      this.once('connected', on)
    })
  }

  request<T = unknown>(
    method: string,
    params: unknown = {},
    timeoutMs?: number,
    onResult?: (result: T) => void,
  ): Promise<T> {
    if (!this.ready || !this.rpc) {
      return Promise.reject(new RpcError(ErrorCode.Disconnected, 'démon non connecté'))
    }
    return this.rpc.request<T>(method, params, timeoutMs, onResult)
  }

  /**
   * Envoie des touches ou un collage au terminal d'une session : trames 0x03
   * d'au plus 64 Kio, dans l'ordre, en respectant la contre-pression.
   * Renvoie `false` (rien n'est envoyé) si le démon n'est pas connecté, si
   * l'identifiant est invalide ou si trop d'octets attendent déjà.
   */
  sendInput(sessionId: string, data: Uint8Array): boolean {
    if (!this.ready || !this.socket) return false
    if (this.queued + data.length > MAX_QUEUED_BYTES) {
      this.o.log('entrée refusée : trop d’octets en attente d’écriture vers le démon')
      return false
    }
    try {
      const frames: Buffer[] = []
      for (let off = 0; off < data.length; off += MAX_INPUT_CHUNK) {
        frames.push(encodePtyInput(sessionId, data.subarray(off, off + MAX_INPUT_CHUNK)))
      }
      for (const f of frames) this.write(f)
      return true
    } catch (e) {
      this.o.log(`entrée non envoyée : ${(e as Error).message}`)
      return false
    }
  }

  /** Octets en attente d'écriture (contre-pression). */
  get pendingWriteBytes(): number {
    return this.queued
  }

  private write(frame: Buffer): void {
    const sock = this.socket
    if (!sock) throw new Error('socket fermé')
    if (this.blocked || this.queue.length > 0) {
      this.queue.push(frame)
      this.queued += frame.length
      return
    }
    if (!sock.write(frame)) this.blocked = true
  }

  private flushQueue(): void {
    const sock = this.socket
    this.blocked = false
    while (sock && this.queue.length > 0 && !this.blocked) {
      const f = this.queue.shift()!
      this.queued -= f.length
      if (!sock.write(f)) this.blocked = true
    }
  }

  private resetQueue(): void {
    this.queue = []
    this.queued = 0
    this.blocked = false
  }

  private setState(s: ConnectionState): void {
    this.current = s
    this.emit('state', s)
  }

  private connect(): void {
    if (this.stopped) return
    this.attempt++
    this.setState({ state: 'connecting', attempt: this.attempt })
    const sock = net.createConnection({ path: this.o.socketPath })
    this.socket = sock
    this.resetQueue()
    const decoder = new FrameDecoder()
    let opened = false
    let answered = false

    sock.on('connect', () => {
      opened = true
      const rpc = new RpcClient((m) => this.write(encodeRpc(m)), { timeoutMs: this.o.requestTimeoutMs })
      this.rpc = rpc
      rpc
        .request<HelloResult>('hello', { client: this.o.clientName }, this.o.helloTimeoutMs)
        .then((hello) => {
          answered = true
          this.silentCloses = 0
          if (hello.protocol !== PROTOCOL_VERSION) {
            this.o.log(`protocole ${hello.protocol} du démon, attendu ${PROTOCOL_VERSION}`)
            this.stopped = true
            this.setState({
              state: 'incompatible',
              error: `le démon parle le protocole ${hello.protocol}, l'app attend le ${PROTOCOL_VERSION}`,
            })
            sock.destroy()
            return
          }
          this.ready = true
          this.attempt = 0
          this.o.log(`connecté à ${hello.server} ${hello.version} (pid ${hello.pid})`)
          this.setState({ state: 'connected', server: hello.server, version: hello.version, pid: hello.pid })
          this.emit('connected', hello)
        })
        .catch((e: Error) => {
          if (!sock.destroyed) this.o.log(`hello sans réponse : ${e.message}`)
          sock.destroy()
        })
    })

    sock.on('drain', () => {
      if (this.socket === sock) this.flushQueue()
    })

    sock.on('data', (chunk: Buffer) => {
      answered = true
      try {
        // Les trames valides avant une trame invalide sont traitées, puis on ferme.
        for (const f of decoder.push(chunk)) this.onFrame(sock, f.type, f.payload)
        decoder.check()
      } catch (e) {
        this.o.log(`trame invalide, connexion fermée : ${(e as Error).message}`)
        sock.destroy()
      }
    })

    sock.on('error', (e: NodeJS.ErrnoException) => {
      if (!opened && (e.code === 'ENOENT' || e.code === 'ECONNREFUSED')) this.maybeStartDaemon()
      this.lastError = e.code ? `${e.code} : ${e.message}` : e.message
    })

    sock.on('close', () => {
      if (this.socket === sock) {
        this.socket = null
        this.resetQueue()
      }
      const wasReady = this.ready
      this.ready = false
      this.rpc?.failAll('connexion au démon perdue')
      this.rpc = null
      if (wasReady) this.o.log('connexion au démon perdue')
      // Connexion acceptée puis fermée sans un octet : refus du pair probable.
      if (opened && !answered) this.silentCloses++
      else if (opened) this.silentCloses = 0
      this.scheduleRetry()
    })
  }

  private onFrame(sock: net.Socket, type: number, payload: Buffer): void {
    if (type === FrameType.Rpc) {
      let msg: unknown
      try {
        msg = JSON.parse(payload.toString('utf8'))
      } catch {
        this.o.log('JSON-RPC illisible reçu du démon, ignoré')
        return
      }
      const n = this.rpc?.handle(msg)
      if (n) this.emit('notification', n)
    } else if (type === FrameType.PtyOutput) {
      try {
        const { id, data } = decodePtyPayload(payload)
        this.emit('pty', id, data)
      } catch (e) {
        this.o.log(`trame de sortie invalide : ${(e as Error).message}`)
        sock.destroy()
      }
    }
    // Types inconnus : ignorés (compatibilité ascendante).
  }

  private maybeStartDaemon(): void {
    if (!this.o.startDaemon) return
    const now = Date.now()
    if (now - this.lastSpawn < this.o.respawnIntervalMs) return
    this.lastSpawn = now
    const { bin, error } = this.o.startDaemon()
    this.o.log(`socket absent : lancement de « ${bin} daemon »`)
    this.setState({ state: 'starting-daemon', bin })
    void error.then((e) => {
      if (e) {
        this.o.log(`lancement du démon impossible : ${e.message}`)
        this.lastError = `lancement de « ${bin} » impossible : ${e.message}`
      }
    })
  }

  private scheduleRetry(): void {
    if (this.stopped) return
    if (this.retryTimer) clearTimeout(this.retryTimer)
    let delay = Math.min(this.o.backoffMaxMs, this.o.backoffInitialMs * 2 ** Math.min(this.attempt, 10))
    if (this.silentCloses >= this.o.refusalThreshold) {
      delay = this.o.refusedRetryMs
      const error = refusalMessage(this.o.insideSession)
      if (this.current.state !== 'refused') this.o.log(error)
      this.setState({ state: 'refused', error, retryInMs: delay })
    } else if (this.current.state !== 'starting-daemon' || this.attempt > 3) {
      this.setState({ state: 'disconnected', error: this.lastError || 'connexion fermée', retryInMs: delay })
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.connect()
    }, delay)
  }
}
