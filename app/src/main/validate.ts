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

/** Identifiant de sous-agent de Claude Code (« a1dcf2f8a7682d931 ») : pas un UUID. */
const AGENT_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/

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

function str(o: Obj, k: string, max: number, opts: { nonEmpty?: boolean; codePoints?: boolean } = {}): string {
  const v = o[k]
  if (typeof v !== 'string') throw new ValidationError(`« ${k} » doit être une chaîne`)
  const n = opts.codePoints ? [...v].length : v.length
  if (n > max) throw new ValidationError(`« ${k} » est trop long (${max} caractères au plus)`)
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

/** Limites du démon pour une revue : 200 commentaires, 4 000 caractères chacun (et le général). */
const MAX_REVIEW_COMMENTS = 200
const MAX_REVIEW_TEXT = 4000
/** Commentaire de fichier : 400 lignes au plus (`line_end - line + 1`). */
const MAX_REVIEW_FILE_LINES = 400

/** Chemin d'un fichier du diff (relatif au dépôt, tel que donné par `sessions.diff`). */
function relPath(o: Obj, k: string): string {
  const v = str(o, k, MAX_PATH, { nonEmpty: true })
  if (v.includes('\0')) throw new ValidationError(`« ${k} » contient un caractère nul`)
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
    case 'sessions.diff':
    case 'sessions.subagents':
      out.id = uuid(o, 'id')
      return out
    case 'sessions.subagent': {
      out.id = uuid(o, 'id')
      const a = o.agent_id
      if (typeof a !== 'string' || !AGENT_ID_RE.test(a)) throw new ValidationError('« agent_id » doit être un identifiant de sous-agent')
      out.agent_id = a
      return out
    }
    case 'files.list':
      out.id = uuid(o, 'id')
      // Racine : chemin absent ou vide.
      if (present(o, 'path') && o.path !== '') out.path = relPath(o, 'path')
      return out
    case 'sessions.input':
      out.id = uuid(o, 'id')
      out.data = str(o, 'data', MAX_TEXT, { nonEmpty: true })
      return out
    case 'files.read':
      out.id = uuid(o, 'id')
      out.path = relPath(o, 'path')
      return out
    case 'sessions.diffFile':
      out.id = uuid(o, 'id')
      out.path = relPath(o, 'path')
      return out
    case 'sessions.sendReview': {
      out.id = uuid(o, 'id')
      const list = o.comments
      if (!Array.isArray(list) || list.length > MAX_REVIEW_COMMENTS) {
        throw new ValidationError(`« comments » : liste de ${MAX_REVIEW_COMMENTS} commentaires au plus`)
      }
      out.comments = list.map((c, i) => {
        const x = obj(c)
        const where = `commentaire ${i + 1}`
        try {
          if (x.kind === 'file') {
            // Commentaire de fichier : lignes relues par le démon, remarque facultative.
            // `line_end` absent : une seule ligne ; `text` absent : extrait sans remarque.
            const line = int(x, 'line', 1, 10_000_000)
            const lineEnd = x.line_end === undefined ? line : int(x, 'line_end', line, line + MAX_REVIEW_FILE_LINES - 1)
            return {
              kind: 'file',
              path: relPath(x, 'path'),
              line,
              line_end: lineEnd,
              text: x.text === undefined ? '' : str(x, 'text', MAX_REVIEW_TEXT, { codePoints: true }),
            }
          }
          if (x.kind !== undefined && x.kind !== 'diff') throw new ValidationError('« kind » doit valoir diff ou file')
          return {
            path: relPath(x, 'path'),
            line: int(x, 'line', 1, 10_000_000),
            side: oneOf(x, 'side', ['new', 'old'] as const),
            text: str(x, 'text', MAX_REVIEW_TEXT, { nonEmpty: true, codePoints: true }),
          }
        } catch (e) {
          throw new ValidationError(`${where} : ${(e as Error).message}`)
        }
      })
      optional(o, out, 'general', (x, k) => str(x, k, MAX_REVIEW_TEXT, { codePoints: true }))
      const general = typeof out.general === 'string' ? out.general.trim() : ''
      if ((out.comments as unknown[]).length === 0 && !general) throw new ValidationError('revue vide : aucun commentaire')
      return out
    }
    case 'quotas.get':
      optional(o, out, 'refresh', (x, k) => bool(x, k))
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
