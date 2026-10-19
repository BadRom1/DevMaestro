/** UUID texte ↔ 16 octets dans l'ordre RFC 4122 (celui de `uuid::Uuid::as_bytes`). */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function uuidToBytes(id: string): Buffer {
  if (!UUID_RE.test(id)) throw new Error(`UUID invalide : ${id}`)
  return Buffer.from(id.replaceAll('-', ''), 'hex')
}

export function bytesToUuid(b: Uint8Array): string {
  if (b.length !== 16) throw new Error(`UUID de ${b.length} octets au lieu de 16`)
  const h = Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
