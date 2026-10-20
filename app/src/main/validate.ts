/**
 * Validation des paramètres venus de la page avant de les relayer au démon.
 * La page est considérée comme non fiable : chaque méthode a un schéma
 * minimal (identifiants UUID, entiers bornés, énumérations, chaînes de
 * longueur bornée). Les champs inconnus sont retirés. Messages en français.
 */
import { MAX_TITLE, SESSION_COLORS, type MethodName } from '../shared/protocol'

export class ValidationError extends Error {
  override name = 'ValidationError'
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const MAX_PATH = 4096
const MAX_TEXT = 100_000
const MAX_SHORT = 200
const MAX_ANSWERS = 50

const LAUNCH_MODES = ['default', 'manual', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'] as const
const SET_MODES = ['default', 'acceptEdits', 'plan', 'auto'] as const
const DECISIONS = ['allow', 'allow_always', 'deny'] as const

type Obj = Record<string, unknown>

function obj(v: unknown): Obj {
  if (v === undefined || v === null) return {}
  if (typeof v !== 'object' || Array.isArray(v)) throw new ValidationError('paramètres invalides : objet attendu')
  return v as Obj
}

function present(o: Obj, k: string): boolean {
  return o[k] !== undefined && o[k] !== null
}

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v)
}

function uuid(o: Obj, k: string): string {
  const v = o[k]
  if (!isUuid(v)) throw new ValidationError(`« ${k} » doit être un identifiant UUID`)
  return v
}

function int(o: Obj, k: string, min: number, max: number): number {
  const v = o[k]
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new ValidationError(`« ${k} » doit être un entier entre ${min} et ${max}`)
  }
  return v
}

function str(o: Obj, k: string, max: number, opts: { nonEmpty?: boolean } = {}): string {
  const v = o[k]
  if (typeof v !== 'string') throw new ValidationError(`« ${k} » doit être une chaîne`)
  if (v.length > max) throw new ValidationError(`« ${k} » est trop long (${max} caractères au plus)`)
  if (opts.nonEmpty && v.trim() === '') throw new ValidationError(`« ${k} » est vide`)
  return v
}

function bool(o: Obj, k: string): boolean {
  const v = o[k]
  if (typeof v !== 'boolean') throw new ValidationError(`« ${k} » doit être un booléen`)
  return v
}

function oneOf<T extends string>(o: Obj, k: string, values: readonly T[]): T {
  const v = o[k]
  if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) {
    throw new ValidationError(`« ${k} » doit valoir ${values.join(', ')}`)
  }
  return v as T
}

function absPath(o: Obj, k: string): string {
  const v = str(o, k, MAX_PATH, { nonEmpty: true })
  if (!v.startsWith('/') || v.includes('\0')) throw new ValidationError(`« ${k} » doit être un chemin absolu`)
  return v
}

/** `cols` et `rows` : ensemble, entiers de 1 à 1000. */
function size(o: Obj, out: Obj): void {
  const c = present(o, 'cols')
  const r = present(o, 'rows')
  if (c !== r) throw new ValidationError('« cols » et « rows » vont ensemble')
  if (c) {
    out.cols = int(o, 'cols', 1, 1000)
    out.rows = int(o, 'rows', 1, 1000)
  }
}

function optional(o: Obj, out: Obj, k: string, f: (o: Obj, k: string) => unknown): void {
  if (present(o, k)) out[k] = f(o, k)
}

function answers(o: Obj): Record<string, string | string[]> {
  const a = o.answers
  if (typeof a !== 'object' || a === null || Array.isArray(a)) throw new ValidationError('« answers » doit être un objet')
  const entries = Object.entries(a)
  if (entries.length === 0 || entries.length > MAX_ANSWERS) throw new ValidationError('« answers » : de 1 à 50 réponses')
  const out: Record<string, string | string[]> = {}
  for (const [q, v] of entries) {
    if (q.length > MAX_TEXT) throw new ValidationError('question trop longue')
    if (typeof v === 'string') {
      if (v.length > MAX_TEXT) throw new ValidationError('réponse trop longue')
      out[q] = v
    } else if (Array.isArray(v) && v.length <= 100 && v.every((x) => typeof x === 'string' && x.length <= MAX_TEXT)) {
      out[q] = v as string[]
    } else {
      throw new ValidationError('chaque réponse doit être un texte ou une liste de textes')
    }
  }
  return out
}

/** Champ facultatif qui accepte `null` (effacement) : présent dès que la clé l'est. */
function nullable(o: Obj, out: Obj, k: string, f: (o: Obj, k: string) => unknown): boolean {
  if (!Object.prototype.hasOwnProperty.call(o, k) || o[k] === undefined) return false
  out[k] = o[k] === null ? null : f(o, k)
  return true
}

/** Titre de session : au plus `MAX_TITLE` caractères (points de code, comme côté démon). */
function title(o: Obj, k: string): string {
  const v = str(o, k, MAX_TITLE * 2)
  if ([...v].length > MAX_TITLE) throw new ValidationError(`« ${k} » est trop long (${MAX_TITLE} caractères au plus)`)
  return v
}

/** Paramètres nettoyés pour `method`, ou `ValidationError`. */
export function validateParams(method: MethodName, raw: unknown): Obj {
  const o = obj(raw)
  const out: Obj = {}
  switch (method) {
    case 'profiles.list':
    case 'sessions.list':
      return {}
    case 'projects.resolve':
      out.path = absPath(o, 'path')
      return out
    case 'sessions.get':
    case 'sessions.stop':
    case 'sessions.forget':
      out.id = uuid(o, 'id')
      return out
    case 'sessions.resize':
      out.id = uuid(o, 'id')
      out.cols = int(o, 'cols', 1, 1000)
      out.rows = int(o, 'rows', 1, 1000)
      return out
    case 'sessions.launch':
      out.cwd = absPath(o, 'cwd')
      optional(o, out, 'profile', (x, k) => str(x, k, MAX_SHORT, { nonEmpty: true }))
      optional(o, out, 'model', (x, k) => str(x, k, MAX_SHORT, { nonEmpty: true }))
      optional(o, out, 'mode', (x, k) => oneOf(x, k, LAUNCH_MODES))
      optional(o, out, 'prompt', (x, k) => str(x, k, MAX_TEXT))
      size(o, out)
      return out
    case 'sessions.resume':
      if (present(o, 'id')) {
        out.id = uuid(o, 'id')
      } else {
        out.claude_session_id = uuid(o, 'claude_session_id')
        optional(o, out, 'cwd', absPath)
        optional(o, out, 'profile', (x, k) => str(x, k, MAX_SHORT, { nonEmpty: true }))
      }
      optional(o, out, 'model', (x, k) => str(x, k, MAX_SHORT, { nonEmpty: true }))
      optional(o, out, 'mode', (x, k) => oneOf(x, k, LAUNCH_MODES))
      optional(o, out, 'prompt', (x, k) => str(x, k, MAX_TEXT))
      size(o, out)
      return out
    case 'sessions.setMode':
      out.id = uuid(o, 'id')
      out.mode = oneOf(o, 'mode', SET_MODES)
      return out
    case 'sessions.update': {
      out.id = uuid(o, 'id')
      const t = nullable(o, out, 'title', title)
      const c = nullable(o, out, 'color', (x, k) => oneOf(x, k, SESSION_COLORS))
      if (!t && !c) throw new ValidationError('rien à modifier : « title » ou « color » attendu')
      return out
    }
    case 'sessions.answerPermission':
      out.id = uuid(o, 'id')
      out.request_id = int(o, 'request_id', 0, Number.MAX_SAFE_INTEGER)
      out.decision = oneOf(o, 'decision', DECISIONS)
      optional(o, out, 'message', (x, k) => str(x, k, MAX_TEXT))
      return out
    case 'sessions.answerQuestion':
      out.id = uuid(o, 'id')
      out.request_id = int(o, 'request_id', 0, Number.MAX_SAFE_INTEGER)
      out.answers = answers(o)
      return out
    case 'transcripts.list':
      optional(o, out, 'profile', (x, k) => str(x, k, MAX_SHORT, { nonEmpty: true }))
      optional(o, out, 'limit', (x, k) => int(x, k, 1, 1000))
      optional(o, out, 'include_hidden', (x, k) => bool(x, k))
      return out
    case 'transcripts.hide':
    case 'transcripts.unhide':
      out.profile = str(o, 'profile', MAX_SHORT, { nonEmpty: true })
      out.claude_session_id = uuid(o, 'claude_session_id')
      return out
  }
}

/** Requête `view` : `id` UUID ou `null`, taille facultative bornée. */
export function validateView(raw: unknown): { id: string | null; cols?: number; rows?: number } {
  const o = obj(raw)
  if (o.id !== null && !isUuid(o.id)) throw new ValidationError('« id » doit être un identifiant UUID ou null')
  const out: Obj = {}
  size(o, out)
  return { id: (o.id as string | null) ?? null, ...(out as { cols?: number; rows?: number }) }
}

/** Lien à ouvrir dans le navigateur : http(s) seulement. */
export function validateExternalUrl(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 8192) throw new ValidationError('lien invalide')
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new ValidationError('lien invalide')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ValidationError('seuls les liens http et https s’ouvrent')
  return u.toString()
}
