import { describe, expect, it } from 'vitest'

import {
  FrameDecoder,
  FrameError,
  FrameType,
  MAX_FRAME_LEN,
  decodePtyPayload,
  encodeFrame,
  encodePtyInput,
  encodeRpc,
} from '../src/main/daemon/frames'
import { bytesToUuid, uuidToBytes } from '../src/main/daemon/uuid'

const ID = '00112233-4455-6677-8899-aabbccddeeff'

describe('trames', () => {
  it('encode l’exemple du protocole (longueur = type + charge utile)', () => {
    // Hook « Stop », jeton « t », JSON « {} » : 00 00 00 0c 10 00 01 74 00 04 53 74 6f 70 7b 7d
    const payload = Buffer.from([0x00, 0x01, 0x74, 0x00, 0x04, 0x53, 0x74, 0x6f, 0x70, 0x7b, 0x7d])
    expect(encodeFrame(FrameType.Hook, payload).toString('hex')).toBe('0000000c10000174000453746f707b7d')
  })

  it('trame vide de charge : longueur 1', () => {
    expect([...encodeFrame(FrameType.Ack, new Uint8Array())]).toEqual([0, 0, 0, 1, 0x12])
  })

  it('JSON-RPC : type 0x01 et UTF-8', () => {
    const f = encodeRpc({ jsonrpc: '2.0', id: 1, method: 'hello', params: { client: 'é' } })
    const json = '{"jsonrpc":"2.0","id":1,"method":"hello","params":{"client":"é"}}'
    const len = Buffer.byteLength(json) + 1
    expect(f.readUInt32BE(0)).toBe(len)
    expect(f[4]).toBe(0x01)
    expect(f.subarray(5).toString('utf8')).toBe(json)
  })

  it('UUID dans l’ordre RFC 4122', () => {
    expect(uuidToBytes(ID).toString('hex')).toBe('00112233445566778899aabbccddeeff')
    expect(bytesToUuid(uuidToBytes(ID))).toBe(ID)
    expect(() => uuidToBytes('pas-un-uuid')).toThrow()
    expect(() => bytesToUuid(new Uint8Array(15))).toThrow()
  })

  it('entrée PTY 0x03 : octets exacts', () => {
    const f = encodePtyInput(ID, Buffer.from('ls\r'))
    expect(f.toString('hex')).toBe('00000014' + '03' + '00112233445566778899aabbccddeeff' + '6c730d')
  })

  it('aller-retour d’une sortie PTY 0x02', () => {
    const data = Buffer.from([0x1b, 0x5b, 0x48, 0xff, 0x00])
    const f = encodeFrame(FrameType.PtyOutput, Buffer.concat([uuidToBytes(ID), data]))
    const [frame] = new FrameDecoder().push(f)
    expect(frame!.type).toBe(FrameType.PtyOutput)
    const { id, data: out } = decodePtyPayload(frame!.payload)
    expect(id).toBe(ID)
    expect([...out]).toEqual([...data])
  })

  it('UUID tronqué : erreur', () => {
    expect(() => decodePtyPayload(Buffer.alloc(10))).toThrow(FrameError)
  })

  it('plusieurs trames par morceau', () => {
    const a = encodeRpc({ a: 1 })
    const b = encodePtyInput(ID, Buffer.from('x'))
    const c = encodeFrame(0x7f, Buffer.from('?'))
    const frames = new FrameDecoder().push(Buffer.concat([a, b, c]))
    expect(frames.map((f) => f.type)).toEqual([0x01, 0x03, 0x7f])
    expect(JSON.parse(frames[0]!.payload.toString())).toEqual({ a: 1 })
  })

  it('lectures partielles : octet par octet, en-tête et UUID coupés', () => {
    const all = Buffer.concat([
      encodeRpc({ method: 'session.updated', params: { x: 'é'.repeat(100) } }),
      encodeFrame(FrameType.PtyOutput, Buffer.concat([uuidToBytes(ID), Buffer.from('bonjour')])),
    ])
    const d = new FrameDecoder()
    const got = []
    for (const byte of all) got.push(...d.push(Buffer.from([byte])))
    expect(got).toHaveLength(2)
    expect(d.pending).toBe(0)
    expect(decodePtyPayload(got[1]!.payload).data.toString()).toBe('bonjour')

    // Découpes arbitraires.
    for (const cut of [1, 3, 4, 5, 7, 20, all.length - 1]) {
      const d2 = new FrameDecoder()
      const f = [...d2.push(all.subarray(0, cut)), ...d2.push(all.subarray(cut))]
      expect(f.map((x) => x.type)).toEqual([0x01, 0x02])
    }
  })

  it('trames valides rendues avant une longueur invalide, erreur ensuite', () => {
    const d = new FrameDecoder()
    const frames = d.push(Buffer.concat([encodeRpc({ ok: 1 }), Buffer.from([0, 0, 0, 0])]))
    expect(frames).toHaveLength(1)
    expect(() => d.check()).toThrow(FrameError)
    expect(() => d.push(Buffer.alloc(0))).toThrow(FrameError)
  })

  it('longueur nulle ou trop grande : erreur', () => {
    expect(() => new FrameDecoder().push(Buffer.from([0, 0, 0, 0]))).toThrow(FrameError)
    const big = Buffer.alloc(4)
    big.writeUInt32BE(MAX_FRAME_LEN + 1)
    expect(() => new FrameDecoder().push(big)).toThrow(FrameError)
  })
})
