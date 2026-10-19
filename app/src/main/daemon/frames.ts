/**
 * Trames du socket (protocole § 2) :
 * `[longueur u32 gros-boutiste][type u8][charge utile]`, où la longueur compte
 * l'octet de type et la charge utile (au moins 1, au plus 16 Mio).
 */
import { bytesToUuid, uuidToBytes } from './uuid'

export const FrameType = {
  Rpc: 0x01,
  PtyOutput: 0x02,
  PtyInput: 0x03,
  Hook: 0x10,
  Statusline: 0x11,
  Ack: 0x12,
} as const

export const MAX_FRAME_LEN = 16 * 1024 * 1024
const HEADER = 4

export interface RawFrame {
  type: number
  payload: Buffer
}

export class FrameError extends Error {
  override name = 'FrameError'
}

export function encodeFrame(type: number, payload: Uint8Array): Buffer {
  const len = payload.length + 1
  if (len > MAX_FRAME_LEN) throw new FrameError(`trame trop grande (${len} octets)`)
  const out = Buffer.allocUnsafe(HEADER + len)
  out.writeUInt32BE(len, 0)
  out.writeUInt8(type, HEADER)
  out.set(payload, HEADER + 1)
  return out
}

export function encodeRpc(message: unknown): Buffer {
  return encodeFrame(FrameType.Rpc, Buffer.from(JSON.stringify(message), 'utf8'))
}

export function encodePtyInput(sessionId: string, data: Uint8Array): Buffer {
  const id = uuidToBytes(sessionId)
  const payload = Buffer.allocUnsafe(16 + data.length)
  payload.set(id, 0)
  payload.set(data, 16)
  return encodeFrame(FrameType.PtyInput, payload)
}

/** Charge utile d'une trame 0x02 / 0x03 : UUID de session puis octets. */
export function decodePtyPayload(payload: Buffer): { id: string; data: Buffer } {
  if (payload.length < 16) throw new FrameError('UUID de session tronqué')
  return { id: bytesToUuid(payload.subarray(0, 16)), data: payload.subarray(16) }
}

/**
 * Découpe un flux d'octets en trames. Garde l'état entre les morceaux : en-tête
 * coupé, trame à cheval sur plusieurs lectures, plusieurs trames par morceau.
 * Une longueur invalide lève `FrameError` (la connexion doit être fermée).
 */
export class FrameDecoder {
  private chunks: Buffer[] = []
  private buffered = 0
  private failure: FrameError | null = null

  /**
   * Ajoute un morceau et renvoie les trames complètes. Les trames valides qui
   * précèdent une longueur invalide sont rendues ; l'erreur est alors levée
   * par `check()` (ou au prochain `push`).
   */
  push(chunk: Uint8Array): RawFrame[] {
    this.check()
    if (chunk.length > 0) {
      this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      this.buffered += chunk.length
    }
    const frames: RawFrame[] = []
    for (;;) {
      if (this.buffered < HEADER) break
      const head = this.peek(HEADER)
      const len = head.readUInt32BE(0)
      if (len < 1 || len > MAX_FRAME_LEN) {
        this.failure = new FrameError(`longueur de trame invalide : ${len}`)
        if (frames.length === 0) this.check()
        break
      }
      if (this.buffered < HEADER + len) break
      const whole = this.take(HEADER + len)
      frames.push({ type: whole[HEADER]!, payload: whole.subarray(HEADER + 1) })
    }
    return frames
  }

  /** Lève l'erreur d'une longueur invalide rencontrée plus tôt. */
  check(): void {
    if (this.failure) throw this.failure
  }

  /** Octets en attente d'une trame incomplète. */
  get pending(): number {
    return this.buffered
  }

  private peek(n: number): Buffer {
    if (this.chunks[0]!.length >= n) return this.chunks[0]!.subarray(0, n)
    const merged = Buffer.concat(this.chunks)
    this.chunks = [merged]
    return merged.subarray(0, n)
  }

  private take(n: number): Buffer {
    let first = this.chunks[0]!
    if (first.length < n) {
      first = Buffer.concat(this.chunks)
      this.chunks = [first]
    }
    const out = first.subarray(0, n)
    const rest = first.subarray(n)
    if (rest.length > 0) this.chunks[0] = rest
    else this.chunks.shift()
    this.buffered -= n
    return out
  }
}
