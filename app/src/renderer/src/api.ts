/** Accès à l'API du preload et au canal du terminal. */
import { PORT_MESSAGE, RUNNER_PORT_MESSAGE, type DevMaestroApi, type PortDown, type PortUp, type RpcFailure } from '../../shared/bridge'
import type { MethodName, Methods } from '../../shared/protocol'
import { describeError } from './state/errors'

declare global {
  interface Window {
    devmaestro: DevMaestroApi
  }
}

export const api: DevMaestroApi = window.devmaestro

export class CallError extends Error {
  constructor(readonly failure: RpcFailure) {
    super(failure.message)
  }
}

/** Appel JSON-RPC ; rejette avec `CallError` (message du démon, en français). */
export async function call<M extends MethodName>(method: M, params: Methods[M]['params']): Promise<Methods[M]['result']> {
  const r = await api.call(method, params)
  if (!r.ok) throw new CallError(r.error)
  return r.result
}

/** Message d'erreur à afficher (en français, selon le code du démon). */
export function errorText(e: unknown): string {
  if (e instanceof CallError) return describeError(e.failure.code, e.failure.message)
  if (e instanceof Error) return e.message
  return String(e)
}

export function errorCode(e: unknown): number | null {
  return e instanceof CallError ? e.failure.code : null
}

type PortListener = (m: PortDown) => void

/**
 * Canal d'un terminal (`MessagePort` transmis par le preload) : celui de la
 * session affichée, et celui du terminal des runners (lot 14a).
 */
export interface TerminalChannel {
  onMessage(l: PortListener): () => void
  sendInput(id: string, data: Uint8Array): void
  ack(gen: number, bytes: number): void
}

function channel(type: string): TerminalChannel {
  let port: MessagePort | null = null
  const listeners = new Set<PortListener>()
  window.addEventListener('message', (e: MessageEvent) => {
    // Seul le preload (même fenêtre) envoie ce message, avec exactement un port.
    const d = e.data as unknown
    if (e.source !== window || e.ports.length !== 1) return
    if (typeof d !== 'object' || d === null || Object.keys(d).length !== 1 || (d as { type?: unknown }).type !== type) return
    port?.close()
    port = e.ports[0]!
    port.onmessage = (ev: MessageEvent<PortDown>) => {
      for (const l of listeners) l(ev.data)
    }
  })
  return {
    onMessage(l) {
      listeners.add(l)
      return () => void listeners.delete(l)
    },
    sendInput(id, data) {
      const m: PortUp = { t: 'input', id, data }
      port?.postMessage(m)
    },
    ack(gen, bytes) {
      const m: PortUp = { t: 'ack', gen, bytes }
      port?.postMessage(m)
    },
  }
}

export const sessionChannel = channel(PORT_MESSAGE)
export const runnerChannel = channel(RUNNER_PORT_MESSAGE)

export function onTerminalMessage(l: PortListener): () => void {
  return sessionChannel.onMessage(l)
}

export function sendTerminalInput(id: string, data: Uint8Array): void {
  sessionChannel.sendInput(id, data)
}

/** Accusé d'un lot écrit dans xterm (contrôle de flux). */
export function ackTerminal(gen: number, bytes: number): void {
  sessionChannel.ack(gen, bytes)
}

/** À appeler une fois au démarrage (et après un rechargement). */
export function requestTerminalPort(): void {
  api.requestTerminalPort()
  // Preload plus ancien : pas de canal des runners (l'onglet « Lancer » le signale).
  api.requestRunnerPort?.()
}
