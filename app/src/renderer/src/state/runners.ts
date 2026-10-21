/**
 * Runners d'une session (lot 14a), côté page : lecture tolérante des
 * réponses du démon, regroupement par type, libellés, et compteur des
 * exécutions en cours par session (indicateur de la barre latérale et du
 * kanban). Pur, testable sans DOM.
 */
import type { RunnerConfirmation } from '../../../shared/bridge'
import type { Runner, RunnerKind, Session } from '../../../shared/protocol'
import { RUNNER_KINDS } from '../../../shared/protocol'
import { previewUrl } from '../../../shared/preview'

/** Exécution d'un runner, normalisée (identifiant unique `processId`). */
export interface RunnerProc {
  processId: string
  runnerId: string
  /** Libellé et commande donnés avec l'exécution (le runner a pu disparaître du dépôt depuis). */
  label: string | null
  command: string[] | null
  sessionId: string
  port: number | null
  startedAt: string | null
  state: 'running' | 'exited'
  exitCode: number | null
  /** Signal de fin (processus tué), s'il est connu. */
  signal: string | null
  urls: string[]
}

export interface RunnersData {
  runners: Runner[]
  running: RunnerProc[]
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_URLS = 20
/** Corps affiché : 4 Kio côté démon ; marge pour l'UTF-16. */
const MAX_BODY = 8192
const FINGERPRINT_RE = /^[0-9a-f]{64}$/

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Exécution lue du démon, ou `null` si elle est inutilisable. */
export function normalizeProcess(raw: unknown): RunnerProc | null {
  if (!isObj(raw)) return null
  const id = typeof raw.process_id === 'string' && UUID_RE.test(raw.process_id) ? raw.process_id : null
  if (!id || typeof raw.runner_id !== 'string' || raw.runner_id === '') return null
  const state = raw.state === 'running' || raw.state === 'exited' ? raw.state : null
  if (!state) return null
  const urls: string[] = []
  if (Array.isArray(raw.urls)) {
    for (const u of raw.urls) {
      if (typeof u === 'string' && u.length <= 2048 && !urls.includes(u)) urls.push(u)
      if (urls.length >= MAX_URLS) break
    }
  }
  return {
    processId: id,
    runnerId: raw.runner_id,
    label: typeof raw.label === 'string' && raw.label.trim() !== '' ? raw.label : null,
    command: Array.isArray(raw.command) && raw.command.length > 0 && raw.command.every((a) => typeof a === 'string') ? (raw.command as string[]) : null,
    sessionId: typeof raw.session_id === 'string' ? raw.session_id : '',
    port: typeof raw.port === 'number' && Number.isInteger(raw.port) ? raw.port : null,
    startedAt: typeof raw.started_at === 'string' ? raw.started_at : null,
    state,
    exitCode: typeof raw.exit_code === 'number' && Number.isInteger(raw.exit_code) ? raw.exit_code : null,
    signal:
      typeof raw.signal === 'number' && Number.isInteger(raw.signal)
        ? String(raw.signal)
        : typeof raw.signal === 'string' && /^[A-Z0-9]{1,16}$/.test(raw.signal)
          ? raw.signal
          : null,
    urls,
  }
}

function isKind(v: unknown): v is RunnerKind {
  return (RUNNER_KINDS as readonly unknown[]).includes(v)
}

/** Runner détecté lu du démon, ou `null` (champs manquants, commande vide). */
export function normalizeRunner(raw: unknown): Runner | null {
  if (!isObj(raw)) return null
  if (typeof raw.id !== 'string' || raw.id === '') return null
  if (!Array.isArray(raw.command) || raw.command.length === 0 || !raw.command.every((a) => typeof a === 'string')) return null
  return {
    id: raw.id,
    label: typeof raw.label === 'string' && raw.label.trim() !== '' ? raw.label : raw.id,
    kind: isKind(raw.kind) ? raw.kind : 'other',
    command: raw.command as string[],
    cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
    source: typeof raw.source === 'string' ? raw.source : '',
    body: typeof raw.body === 'string' ? raw.body.slice(0, MAX_BODY) : null,
    ...(typeof raw.fingerprint === 'string' && FINGERPRINT_RE.test(raw.fingerprint) ? { fingerprint: raw.fingerprint } : {}),
  }
}

/** Réponse de `runners.list` (entrées invalides écartées, doublons retirés). */
export function normalizeList(raw: unknown): RunnersData {
  const o = isObj(raw) ? raw : {}
  const runners: Runner[] = []
  const seen = new Set<string>()
  for (const r of Array.isArray(o.runners) ? o.runners : []) {
    const n = normalizeRunner(r)
    if (n && !seen.has(n.id)) {
      seen.add(n.id)
      runners.push(n)
    }
  }
  return { runners, running: normalizeProcs(o.running) }
}

export function normalizeProcs(raw: unknown): RunnerProc[] {
  const out: RunnerProc[] = []
  const seen = new Set<string>()
  for (const p of Array.isArray(raw) ? raw : []) {
    const n = normalizeProcess(p)
    if (n && !seen.has(n.processId)) {
      seen.add(n.processId)
      out.push(n)
    }
  }
  return out
}

export const KIND_LABELS: Record<RunnerKind, string> = {
  dev: 'Développement',
  test: 'Tests',
  build: 'Construction',
  lint: 'Vérifications',
  other: 'Autres',
}

export interface RunnerGroup {
  kind: RunnerKind
  label: string
  runners: Runner[]
}

/** Runners groupés par type, dans l'ordre dev, test, build, lint, autres ; groupes vides omis. */
export function groupRunners(runners: readonly Runner[]): RunnerGroup[] {
  return RUNNER_KINDS.map((kind) => ({ kind, label: KIND_LABELS[kind], runners: runners.filter((r) => r.kind === kind) })).filter(
    (g) => g.runners.length > 0,
  )
}

/** Argument affiché comme dans un shell (entre apostrophes s'il le faut). */
function shellArg(a: string): string {
  if (a !== '' && /^[\w@%+=:,./-]+$/.test(a)) return a
  return `'${a.replace(/'/g, `'\\''`)}'`
}

/** Commande affichée telle qu'elle sera exécutée (avec son dossier s'il n'est pas la racine). */
export function commandText(r: Pick<Runner, 'command' | 'cwd'>): string {
  const cmd = r.command.map(shellArg).join(' ')
  const dir = r.cwd.replace(/^\.\/?/, '').replace(/\/$/, '')
  return dir ? `(cd ${shellArg(dir)} && ${cmd})` : cmd
}

/** État d'une exécution, en français. */
export function stateLabel(p: Pick<RunnerProc, 'state' | 'exitCode'> & { signal?: string | null }): string {
  if (p.state === 'running') return 'En cours'
  if (p.exitCode === null) return p.signal ? `Arrêté (signal ${p.signal})` : 'Arrêté'
  return p.exitCode === 0 ? 'Terminé (code 0)' : `Échec (code ${p.exitCode})`
}

/** Ton de l'état (classe CSS). */
export function stateTone(p: Pick<RunnerProc, 'state' | 'exitCode'>): 'run' | 'done' | 'err' | 'idle' {
  if (p.state === 'running') return 'run'
  if (p.exitCode === null) return 'idle'
  return p.exitCode === 0 ? 'done' : 'err'
}

export function runningCount(procs: readonly Pick<RunnerProc, 'state'>[] | undefined): number {
  return procs ? procs.filter((p) => p.state === 'running').length : 0
}

/** Libellé de l'indicateur (barre latérale, kanban), `null` si rien ne tourne. */
export function runnersIndicator(n: number): string | null {
  if (n <= 0) return null
  return n === 1 ? '1 runner en cours' : `${n} runners en cours`
}

/** URL d'une exécution affichables dans l'aperçu (les autres : navigateur seulement). */
export function previewable(urls: readonly string[], pageOrigin: string | null): string[] {
  const out: string[] = []
  for (const u of urls) {
    const p = previewUrl(u, pageOrigin)
    if (p && !out.includes(p)) out.push(p)
  }
  return out
}

/**
 * Commande à faire accepter, lue du refus `RunnerConfirmationRequired` du
 * processus principal (`data`), ou `null` si elle est inutilisable.
 */
export function readConfirmation(raw: unknown): RunnerConfirmation | null {
  if (!isObj(raw)) return null
  const { worktree, runner_id, label, command, cwd, source, body, fingerprint } = raw
  if (typeof worktree !== 'string' || typeof runner_id !== 'string' || typeof fingerprint !== 'string') return null
  if (!FINGERPRINT_RE.test(fingerprint)) return null
  if (!Array.isArray(command) || command.length === 0 || !command.every((a) => typeof a === 'string')) return null
  return {
    worktree,
    runner_id,
    label: typeof label === 'string' ? label : runner_id,
    command: command as string[],
    cwd: typeof cwd === 'string' ? cwd : '',
    source: typeof source === 'string' ? source : '',
    body: typeof body === 'string' ? body.slice(0, MAX_BODY) : null,
    fingerprint,
  }
}

/** Texte de la confirmation demandée avant le premier lancement dans un worktree. */
export const CONFIRM_TEXT = 'Cette commande vient du dépôt et va s’exécuter sur ta machine.'

/* ---------- Indicateur : exécutions en cours, par session ---------- */
/* (sans appel au démon : voir `useRunnersIndex`) */

export interface RunnersIndex {
  /** `null` : pas encore su ; `false` : démon trop ancien (onglet masqué). */
  supported: boolean | null
  /** Exécutions connues par session (dernière liste reçue). */
  running: Record<string, RunnerProc[]>
}

export const initialIndex: RunnersIndex = { supported: null, running: {} }

export type IndexAction =
  | { type: 'reset' }
  | { type: 'unsupported' }
  | { type: 'list'; sessionId: string; running: RunnerProc[] }
  | { type: 'forget'; sessionId: string }

export function indexReducer(s: RunnersIndex, a: IndexAction): RunnersIndex {
  switch (a.type) {
    case 'reset':
      return initialIndex
    case 'unsupported':
      return { supported: false, running: {} }
    case 'list':
      return { supported: true, running: { ...s.running, [a.sessionId]: a.running } }
    case 'forget': {
      if (!s.running[a.sessionId]) return s
      const running = { ...s.running }
      delete running[a.sessionId]
      return { ...s, running }
    }
  }
}

/**
 * Nombre d'exécutions en cours par session (seulement celles qui en ont) :
 * `Session.runners_running` s'il est donné (le démon fait foi), sinon la
 * dernière liste connue.
 */
export function sessionRunnerCounts(
  sessions: readonly Pick<Session, 'id' | 'runners_running'>[],
  s: RunnersIndex,
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const sess of sessions) {
    const n = typeof sess.runners_running === 'number' ? sess.runners_running : runningCount(s.running[sess.id])
    if (n > 0) out[sess.id] = n
  }
  return out
}
