/**
 * Validation des paramètres venus de la page avant de les relayer au démon.
 * La page est considérée comme non fiable : chaque méthode a un schéma
 * minimal (identifiants UUID, entiers bornés, énumérations, chaînes de
 * longueur bornée). Les champs inconnus sont retirés. Messages en français.
 */
import { COMMIT_RANGES, FULL_PARTS, MAX_TITLE, SESSION_COLORS, type MethodName } from '../shared/protocol'
import { ZOOM_DIRECTIONS, type ZoomDirection } from '../shared/settings'
import { WORKTREE_LOCATIONS, branchNameProblem } from '../shared/worktrees'

export class ValidationError extends Error {
  override name = 'ValidationError'
}

/** Identifiant de sous-agent de Claude Code (« a1dcf2f8a7682d931 ») : pas un UUID. */
const AGENT_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/

/**
 * Identifiant d'une entrée de conversation (`uid`, curseur `before`) : forme
 * choisie par le démon, non fixée par le contrat ; caractères sûrs, 256 au plus.
 */
const ENTRY_UID_RE = /^[A-Za-z0-9_.:#@-]{1,256}$/

/** Prompt envoyé par `sessions.sendPrompt` : 256 Kio d'UTF-8 au plus. */
export const MAX_PROMPT_BYTES = 256 * 1024

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

function agentId(o: Obj, k: string): string {
  const a = o[k]
  if (typeof a !== 'string' || !AGENT_ID_RE.test(a)) throw new ValidationError(`« ${k} » doit être un identifiant de sous-agent`)
  return a
}

function entryUid(o: Obj, k: string): string {
  const v = o[k]
  if (typeof v !== 'string' || !ENTRY_UID_RE.test(v)) throw new ValidationError(`« ${k} » doit être un identifiant d'entrée`)
  return v
}

/** Texte d'un prompt : non vide après nettoyage, 256 Kio d'UTF-8 au plus, sans caractère nul. */
function promptText(o: Obj, k: string): string {
  const v = o[k]
  if (typeof v !== 'string') throw new ValidationError(`« ${k} » doit être une chaîne`)
  // Borne grossière avant l'encodage (4 octets au plus par point de code UTF-16).
  if (v.length > MAX_PROMPT_BYTES || new TextEncoder().encode(v).length > MAX_PROMPT_BYTES) {
    throw new ValidationError(`« ${k} » est trop long (256 Kio au plus)`)
  }
  if (v.includes('\0')) throw new ValidationError(`« ${k} » contient un caractère nul`)
  if (v.trim() === '') throw new ValidationError(`« ${k} » est vide`)
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

/** Identifiant complet d'un commit : 40 (SHA-1) ou 64 (SHA-256) caractères hexadécimaux en minuscules. */
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

function sha(o: Obj, k: string): string {
  const v = o[k]
  if (typeof v !== 'string' || !SHA_RE.test(v)) {
    throw new ValidationError(`« ${k} » doit être un identifiant de commit complet (40 ou 64 caractères hexadécimaux en minuscules)`)
  }
  return v
}

/** Chemin d'un fichier du diff (relatif au dépôt, tel que donné par `sessions.diff`). */
function relPath(o: Obj, k: string): string {
  const v = str(o, k, MAX_PATH, { nonEmpty: true })
  if (v.includes('\0')) throw new ValidationError(`« ${k} » contient un caractère nul`)
  return v
}

/** Nom de branche (ou référence de base) : règles prudentes de `git check-ref-format`. */
function branchName(o: Obj, k: string): string {
  const v = str(o, k, MAX_SHORT * 2, { nonEmpty: true })
  const problem = branchNameProblem(v)
  if (problem) throw new ValidationError(`« ${k} » : ${problem}`)
  return v
}

/**
 * Worktree demandé avec la session : `branch`, `base` facultative,
 * `location` parmi les emplacements connus, `path` absolu seulement (et
 * obligatoirement) pour `custom`.
 */
function worktreeRequest(o: Obj, k: string): Obj {
  const v = o[k]
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new ValidationError(`« ${k} » doit être un objet`)
  const w = v as Obj
  const out: Obj = {}
  try {
    out.branch = branchName(w, 'branch')
    optional(w, out, 'base', branchName)
    out.location = oneOf(w, 'location', WORKTREE_LOCATIONS)
    if (out.location === 'custom') out.path = absPath(w, 'path')
    else if (present(w, 'path')) throw new ValidationError('« path » seulement pour l’emplacement custom')
  } catch (e) {
    throw new ValidationError(`${k} : ${(e as Error).message}`)
  }
  return out
}

/** Délai des opérations git longues du démon (création, liste, suppression de worktrees). */
export const WORKTREE_TIMEOUT_MS = 120_000

/**
 * Délai d'attente d'une méthode relayée : 120 s pour `worktrees.*` et pour
 * un lancement qui crée un worktree (extraction d'un gros dépôt) ;
 * `undefined` : délai par défaut du client.
 */
export function requestTimeoutMs(method: MethodName, clean: Obj): number | undefined {
  if (method === 'worktrees.list' || method === 'worktrees.remove') return WORKTREE_TIMEOUT_MS
  if (method === 'sessions.launch' && clean.worktree !== undefined) return WORKTREE_TIMEOUT_MS
  return undefined
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
      optional(o, out, 'worktree', worktreeRequest)
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
    case 'sessions.subagent':
      out.id = uuid(o, 'id')
      out.agent_id = agentId(o, 'agent_id')
      return out
    case 'conversation.get':
      out.id = uuid(o, 'id')
      optional(o, out, 'before', entryUid)
      optional(o, out, 'limit', (x, k) => int(x, k, 1, 1000))
      return out
    case 'conversation.subagent':
      out.id = uuid(o, 'id')
      out.agent_id = agentId(o, 'agent_id')
      optional(o, out, 'before', entryUid)
      optional(o, out, 'limit', (x, k) => int(x, k, 1, 1000))
      return out
    case 'conversation.full':
      out.id = uuid(o, 'id')
      out.uid = entryUid(o, 'uid')
      out.part = oneOf(o, 'part', FULL_PARTS)
      return out
    case 'sessions.sendPrompt':
      out.id = uuid(o, 'id')
      out.text = promptText(o, 'text')
      return out
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
    case 'sessions.commits':
      out.id = uuid(o, 'id')
      optional(o, out, 'limit', (x, k) => int(x, k, 1, 500))
      // `null` ou absent : choix automatique du démon.
      optional(o, out, 'range', (x, k) => oneOf(x, k, COMMIT_RANGES))
      return out
    case 'sessions.commitDiff':
      out.id = uuid(o, 'id')
      out.sha = sha(o, 'sha')
      return out
    case 'sessions.commitDiffFile':
      out.id = uuid(o, 'id')
      out.sha = sha(o, 'sha')
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
          if (x.kind === 'commit') {
            return {
              kind: 'commit',
              sha: sha(x, 'sha'),
              path: relPath(x, 'path'),
              line: int(x, 'line', 1, 10_000_000),
              side: oneOf(x, 'side', ['new', 'old'] as const),
              text: str(x, 'text', MAX_REVIEW_TEXT, { nonEmpty: true, codePoints: true }),
            }
          }
          if (x.kind !== undefined && x.kind !== 'diff') throw new ValidationError('« kind » doit valoir diff, file ou commit')
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
    case 'worktrees.list':
      out.root = absPath(o, 'root')
      return out
    case 'worktrees.remove':
      out.root = absPath(o, 'root')
      out.path = absPath(o, 'path')
      out.delete_branch = bool(o, 'delete_branch')
      out.force = bool(o, 'force')
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

/** Pas de taille de l'interface demandé par la page (Ctrl + molette) : `in`, `out` ou `reset`. */
export function validateZoomDirection(raw: unknown): ZoomDirection {
  if (!(ZOOM_DIRECTIONS as readonly unknown[]).includes(raw)) throw new ValidationError('taille de l’interface : in, out ou reset attendu')
  return raw as ZoomDirection
}

/** Erreur de la page pour le journal : texte, caractères de contrôle retirés (sauf saut de ligne), 4 000 caractères au plus. */
export const MAX_RENDERER_ERROR = 4000

export function validateRendererError(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') throw new ValidationError('erreur de la page : texte attendu')
  // eslint-disable-next-line no-control-regex
  const clean = raw.slice(0, MAX_RENDERER_ERROR * 2).replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
  return clean.length > MAX_RENDERER_ERROR ? `${clean.slice(0, MAX_RENDERER_ERROR - 1)}…` : clean
}
