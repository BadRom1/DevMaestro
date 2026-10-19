/**
 * Client JSON-RPC 2.0 indépendant du transport : identifiants numériques par
 * connexion, délai par requête, rejet de toutes les requêtes en vol quand la
 * connexion tombe.
 */
import { ErrorCode } from '../../shared/protocol'

export class RpcError extends Error {
  override name = 'RpcError'
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message)
  }
}

export interface RpcNotification {
  method: string
  params: unknown
}

interface InFlight {
  method: string
  onResult?: ((result: unknown) => void) | undefined
  resolve: (v: unknown) => void
  reject: (e: RpcError) => void
  timer: ReturnType<typeof setTimeout>
}

export interface RpcClientOptions {
  /** Délai par défaut d'une requête, en millisecondes. */
  timeoutMs?: number
}

export class RpcClient {
  private nextId = 1
  private readonly inFlight = new Map<number, InFlight>()
  private readonly timeoutMs: number

  constructor(
    private readonly send: (message: object) => void,
    opts: RpcClientOptions = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? 10_000
  }

  /**
   * Envoie une requête. `onResult`, s'il est donné, est appelé de façon
   * synchrone à la réception de la réponse, avant le traitement des trames
   * suivantes du même morceau : utile quand l'ordre réponse → flux compte
   * (abonnement à un terminal), ce que la résolution d'une promesse,
   * différée, ne garantit pas.
   */
  request<T = unknown>(
    method: string,
    params: unknown = {},
    timeoutMs = this.timeoutMs,
    onResult?: (result: T) => void,
  ): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.inFlight.delete(id)
        reject(new RpcError(ErrorCode.Timeout, `délai dépassé pour ${method} (${timeoutMs} ms)`))
      }, timeoutMs)
      this.inFlight.set(id, {
        method,
        onResult: onResult as ((r: unknown) => void) | undefined,
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      })
      try {
        this.send({ jsonrpc: '2.0', id, method, params })
      } catch (e) {
        clearTimeout(timer)
        this.inFlight.delete(id)
        reject(new RpcError(ErrorCode.Disconnected, `envoi impossible : ${(e as Error).message}`))
      }
    })
  }

  /** Notification du client (sans réponse). */
  notify(method: string, params: unknown = {}): void {
    this.send({ jsonrpc: '2.0', method, params })
  }

  /**
   * Traite un message reçu. Renvoie la notification du démon s'il s'agit
   * d'une notification, `null` sinon (réponse, ou message ignoré).
   */
  handle(message: unknown): RpcNotification | null {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) return null
    const m = message as Record<string, unknown>
    if (typeof m.method === 'string') {
      if (m.id !== undefined && m.id !== null) return null // requête du démon : aucune n'existe
      return { method: m.method, params: m.params ?? {} }
    }
    if (typeof m.id !== 'number') return null
    const call = this.inFlight.get(m.id)
    if (!call) return null // réponse tardive (délai dépassé) : ignorée
    this.inFlight.delete(m.id)
    clearTimeout(call.timer)
    if (m.error && typeof m.error === 'object') {
      const err = m.error as { code?: unknown; message?: unknown; data?: unknown }
      call.reject(
        new RpcError(
          typeof err.code === 'number' ? err.code : ErrorCode.Internal,
          typeof err.message === 'string' ? err.message : 'erreur inconnue du démon',
          err.data,
        ),
      )
    } else {
      call.onResult?.(m.result)
      call.resolve(m.result)
    }
    return null
  }

  /** Rejette toutes les requêtes en vol (connexion perdue). */
  failAll(reason: string): void {
    for (const [id, call] of this.inFlight) {
      clearTimeout(call.timer)
      call.reject(new RpcError(ErrorCode.Disconnected, `${reason} (${call.method})`))
      this.inFlight.delete(id)
    }
  }

  get pendingCount(): number {
    return this.inFlight.size
  }
}
