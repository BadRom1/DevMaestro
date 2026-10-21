/**
 * Relais du terminal de la session affichée vers la page (ADR 0004). Les
 * noms de méthodes cités ici sont ceux des sessions (`SESSION_STREAM`) ; le
 * terminal d'un runner (lot 14a) utilise le même relais avec les siens
 * (`RUNNER_STREAM`, `runnerStream.ts`), sur un second canal :
 *
 * - une seule session transmise à la fois ; changer de session désabonne
 *   la précédente ;
 * - au changement : `sessions.unsubscribe` (ancienne), `sessions.resize`
 *   (taille du terminal de la page), puis `sessions.subscribe`. L'instantané
 *   part vers la page **avant** les octets qui le suivent, par le même canal ;
 *   un abonnement sans réponse (délai) est retenté avec une attente
 *   croissante, puis signalé ;
 * - octets regroupés par lots (au moins `minBatchBytes`, ou au plus tard
 *   après `maxDelayMs`), envoyés en binaire ;
 * - contrôle de flux : la page accuse réception des lots une fois écrits
 *   dans xterm. Au-delà de `highWaterBytes` non acquittés, le relais cesse
 *   d'envoyer et abandonne les octets ; quand la page a rattrapé (moins de
 *   `resumeBelowBytes` en vol), il redemande un instantané au démon plutôt
 *   que de rejouer ;
 * - `session.resync` : lot en cours envoyé, puis nouvel instantané ;
 * - à la reconnexion au démon, la session affichée est réabonnée.
 *
 * Aucune dépendance à Electron : le canal vers la page est une interface.
 */
import type { PortDown } from '../../shared/bridge'
import { ErrorCode, type Snapshot } from '../../shared/protocol'
import { RpcError, type RpcNotification } from './rpc'

export interface RelayClient {
  request<T = unknown>(
    method: string,
    params?: unknown,
    timeoutMs?: number,
    onResult?: (result: T) => void,
  ): Promise<T>
  sendInput(sessionId: string, data: Uint8Array): boolean
}

export interface RelaySink {
  post(msg: PortDown): void
}

/**
 * Méthodes du flux d'un terminal : celles des sessions par défaut ; le
 * terminal d'un runner (lot 14a) passe par les siennes (`runnerStream`).
 */
export interface StreamMethods {
  subscribe: string
  unsubscribe: string
  /** `null` : pas de redimensionnement côté démon. */
  resize: string | null
  /** Notifications d'un nouvel instantané (abonné en retard). */
  resync: readonly string[]
  /** Paramètres d'une requête pour une cible (`owner` : session d'un runner). */
  params(id: string, owner: string | undefined): Record<string, unknown>
  /** Cible d'une notification de resynchronisation (`undefined` : pas pour nous). */
  resyncTarget(params: Record<string, unknown>): string | undefined
}

export const SESSION_STREAM: StreamMethods = {
  subscribe: 'sessions.subscribe',
  unsubscribe: 'sessions.unsubscribe',
  resize: 'sessions.resize',
  resync: ['session.resync'],
  params: (id) => ({ id }),
  resyncTarget: (p) => (typeof p.id === 'string' ? p.id : undefined),
}

export interface RelayOptions {
  /** Méthodes du flux (sessions par défaut). */
  methods?: StreamMethods
  minBatchBytes?: number
  maxDelayMs?: number
  highWaterBytes?: number
  resumeBelowBytes?: number
  /** Essais supplémentaires d'un abonnement resté sans réponse. */
  subscribeRetries?: number
  subscribeBackoffMs?: number
  subscribeTimeoutMs?: number
  log?: (msg: string) => void
}

interface Target {
  id: string
  /** Session propriétaire (terminal d'un runner). */
  owner?: string | undefined
  gen: number
  /** Vrai une fois l'instantané envoyé : les octets suivants sont relayés. */
  accepting: boolean
  cols?: number | undefined
  rows?: number | undefined
}

export class TerminalRelay {
  private sink: RelaySink | null = null
  private target: Target | null = null
  private gen = 0
  private batch: Buffer[] = []
  private batchBytes = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private unacked = 0
  private paused = false
  private readonly o: Required<RelayOptions>

  constructor(
    private readonly client: RelayClient,
    opts: RelayOptions = {},
  ) {
    this.o = {
      minBatchBytes: 1024,
      maxDelayMs: 16,
      highWaterBytes: 2 * 1024 * 1024,
      resumeBelowBytes: 256 * 1024,
      subscribeRetries: 3,
      subscribeBackoffMs: 300,
      subscribeTimeoutMs: 5_000,
      methods: SESSION_STREAM,
      log: () => {},
      ...opts,
    }
  }

  /** Nouveau canal vers la page (rechargement) : l'écran est renvoyé. */
  setSink(sink: RelaySink | null): void {
    this.sink = sink
    if (sink && this.target) this.resubscribe('nouveau canal')
  }

  get visible(): string | null {
    return this.target?.id ?? null
  }

  /** Octets envoyés à la page et pas encore acquittés. */
  get inFlightBytes(): number {
    return this.unacked
  }

  get isPaused(): boolean {
    return this.paused
  }

  /** Affiche une session (ou aucune). Rejette si l'abonnement échoue. */
  async view(req: {
    id: string | null
    owner?: string | undefined
    cols?: number | undefined
    rows?: number | undefined
  }): Promise<void> {
    const m = this.o.methods
    const gen = ++this.gen
    const previous = this.target
    this.dropBatch()
    this.unacked = 0
    this.paused = false
    if (previous && previous.id !== req.id) {
      this.client.request(m.unsubscribe, m.params(previous.id, previous.owner)).catch(() => {})
    }
    if (!req.id) {
      this.target = null
      this.sink?.post({ t: 'none', gen })
      return
    }
    const target: Target = { id: req.id, owner: req.owner, gen, accepting: false, cols: req.cols, rows: req.rows }
    this.target = target
    if (req.cols && req.rows && m.resize) {
      // Avant l'abonnement : l'instantané est rendu à la taille de la page.
      this.client.request(m.resize, { ...m.params(req.id, req.owner), cols: req.cols, rows: req.rows }).catch(() => {})
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await this.client.request<{ id: string; snapshot: Snapshot }>(
          m.subscribe,
          m.params(req.id, req.owner),
          this.o.subscribeTimeoutMs,
          (result) => {
            // Synchrone, avant les trames 0x02 qui suivent la réponse.
            if (this.target !== target) return
            this.sink?.post({ t: 'reset', id: target.id, gen, snapshot: result.snapshot, reason: 'subscribe' })
            target.accepting = true
          },
        )
        return
      } catch (e) {
        const timeout = e instanceof RpcError && e.code === ErrorCode.Timeout
        if (!timeout || this.target !== target) throw e
        if (attempt >= this.o.subscribeRetries) {
          throw new RpcError(
            ErrorCode.Timeout,
            `le terminal ne répond pas : abonnement sans réponse après ${attempt + 1} essais`,
          )
        }
        this.o.log(`abonnement à ${req.id} sans réponse, nouvel essai`)
        await new Promise((r) => setTimeout(r, this.o.subscribeBackoffMs * 2 ** attempt))
        if (this.target !== target) return
        this.client.request(m.unsubscribe, m.params(req.id, req.owner)).catch(() => {})
      }
    }
  }

  /** Taille connue du terminal de la page (réabonnement). */
  noteSize(id: string, cols: number, rows: number): void {
    if (this.target?.id === id) {
      this.target.cols = cols
      this.target.rows = rows
    }
  }

  /**
   * Redimensionne le terminal affiché (flux sans méthode relayée de la page,
   * comme celui des runners) ; ignoré pour une autre cible.
   */
  resize(id: string, cols: number, rows: number): void {
    const t = this.target
    const m = this.o.methods
    if (!t || t.id !== id || !m.resize) return
    this.noteSize(id, cols, rows)
    this.client.request(m.resize, { ...m.params(t.id, t.owner), cols, rows }).catch(() => {})
  }

  /** Octets d'un terminal reçus du démon. */
  onPty(id: string, data: Buffer): void {
    const t = this.target
    if (!t || !t.accepting || t.id !== id || this.paused) return
    this.batch.push(data)
    this.batchBytes += data.length
    if (this.batchBytes >= this.o.minBatchBytes) this.flush()
    else if (!this.timer) this.timer = setTimeout(() => this.flush(), this.o.maxDelayMs)
  }

  /** Accusé de la page : `bytes` octets du lot `gen` écrits dans xterm. */
  ack(gen: number, bytes: number): void {
    if (!this.target || gen !== this.target.gen || !Number.isFinite(bytes) || bytes < 0) return
    this.unacked = Math.max(0, this.unacked - bytes)
    if (this.paused && this.unacked <= this.o.resumeBelowBytes) {
      this.resubscribe('la page a rattrapé son retard')
    }
  }

  onNotification(n: RpcNotification): void {
    if (!this.o.methods.resync.includes(n.method)) return
    const p = (n.params ?? {}) as Record<string, unknown> & { snapshot?: Snapshot }
    const t = this.target
    if (!t || !t.accepting || this.o.methods.resyncTarget(p) !== t.id || !p.snapshot) return
    if (this.paused) return // un instantané sera redemandé à la reprise
    this.flush()
    this.sink?.post({ t: 'reset', id: t.id, gen: t.gen, snapshot: p.snapshot, reason: 'resync' })
  }

  /** Connexion (re)établie : la session affichée est réabonnée. */
  onConnected(): void {
    if (this.target) this.resubscribe('reconnexion')
  }

  onDisconnected(): void {
    this.dropBatch()
    if (this.target) this.target.accepting = false
  }

  /** Touches tapées dans la page : seulement vers la session affichée. */
  input(id: string, data: Uint8Array): void {
    if (this.target?.id !== id) return
    this.client.sendInput(id, data)
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const t = this.target
    if (!t || this.batchBytes === 0) return
    if (this.unacked + this.batchBytes > this.o.highWaterBytes) {
      // La page ne suit plus : on abandonne et on attend qu'elle rattrape.
      this.o.log(`page en retard (${this.unacked} octets non acquittés) : flux suspendu`)
      this.dropBatch()
      this.paused = true
      this.sink?.post({ t: 'paused', id: t.id, gen: t.gen })
      return
    }
    // Copie dans un tampon à la taille exacte : le clonage structuré du canal
    // copierait sinon tout le tampon sous-jacent (morceau de socket, pool de Node).
    const bytes = new Uint8Array(this.batchBytes)
    let off = 0
    for (const b of this.batch) {
      bytes.set(b, off)
      off += b.length
    }
    this.batch = []
    this.batchBytes = 0
    this.unacked += bytes.length
    this.sink?.post({ t: 'data', id: t.id, gen: t.gen, bytes })
  }

  private resubscribe(why: string): void {
    const t = this.target
    if (!t) return
    this.o.log(`nouvel instantané de ${t.id} (${why})`)
    this.view({ id: t.id, owner: t.owner, cols: t.cols, rows: t.rows }).catch((e: Error) =>
      this.o.log(`réabonnement impossible : ${e.message}`),
    )
  }

  private dropBatch(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.batch = []
    this.batchBytes = 0
  }
}
