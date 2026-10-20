/**
 * Sous-agents d'une session (v0.2, lot 5) : lecture tolérante des données
 * du démon, sous-arbre de la barre latérale, durées et libellés. Pur,
 * testable sans DOM.
 *
 * Démon plus ancien : champs `subagents_*` absents → 0, liste vide.
 */
import type { Session, Subagent, SubagentStatus } from '../../../shared/protocol'

const STATUSES: readonly SubagentStatus[] = ['running', 'done', 'failed', 'interrupted']

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

function countOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null
}

/**
 * Sous-agent lu du démon ; `null` sans `agent_id`. Champs absents ou mal
 * typés : `null`. Statut inconnu (démon plus récent) : « en cours » tant
 * qu'il n'a pas de fin, sinon « terminé ».
 */
export function normalizeSubagent(raw: unknown): Subagent | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const id = o.agent_id
  if (typeof id !== 'string' || id === '') return null
  const ended = strOrNull(o.ended_at)
  const status = (STATUSES as readonly unknown[]).includes(o.status)
    ? (o.status as SubagentStatus)
    : ended
      ? 'done'
      : 'running'
  const a: Subagent = {
    agent_id: id,
    agent_type: strOrNull(o.agent_type),
    description: strOrNull(o.description),
    model: strOrNull(o.model),
    tool_use_id: strOrNull(o.tool_use_id),
    status,
    started_at: strOrNull(o.started_at),
    ended_at: ended,
    tool_count: countOrNull(o.tool_count),
    current_tool: strOrNull(o.current_tool),
    last_tool: strOrNull(o.last_tool),
    transcript_path: strOrNull(o.transcript_path),
  }
  if ('report' in o) a.report = strOrNull(o.report)
  if ('report_truncated' in o) a.report_truncated = o.report_truncated === true
  return a
}

/** Liste du démon (`{agents}` ou tableau) ; entrées illisibles et doublons écartés. */
export function normalizeAgents(raw: unknown): Subagent[] {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'object' && raw !== null && Array.isArray((raw as { agents?: unknown }).agents)
      ? (raw as { agents: unknown[] }).agents
      : []
  const seen = new Set<string>()
  const out: Subagent[] = []
  for (const x of list) {
    const a = normalizeSubagent(x)
    if (!a || seen.has(a.agent_id)) continue
    seen.add(a.agent_id)
    out.push(a)
  }
  return out
}

/** Résultat de `sessions.subagent` : le sous-agent lui-même, ou enveloppé (`{agent}`, `{subagent}`). */
export function subagentFromResult(raw: unknown): Subagent | null {
  const direct = normalizeSubagent(raw)
  if (direct) return direct
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  return normalizeSubagent(o.agent) ?? normalizeSubagent(o.subagent)
}

/**
 * Sous-agents en cours. Une seule source pour toute l'interface (en-tête,
 * onglet, kanban, barre latérale) : la liste quand elle est connue (même
 * vide), sinon le champ de la session, sinon 0 (démon plus ancien).
 */
export function runningCount(session: Pick<Session, 'subagents_running'>, agents?: readonly Subagent[] | null): number {
  if (agents) return agents.filter((a) => a.status === 'running').length
  return countOrNull(session.subagents_running) ?? 0
}

/**
 * Sous-agents connus du démon : champ de la session (il compte aussi ceux
 * que la liste n'a pas encore), sinon taille de la liste, sinon 0.
 */
export function totalCount(session: Pick<Session, 'subagents_total'>, agents?: readonly Subagent[] | null): number {
  return countOrNull(session.subagents_total) ?? agents?.length ?? 0
}

/** « 1 sous-agent en cours », « 2 sous-agents en cours » ; `null` à 0. */
export function runningLabel(n: number): string | null {
  if (!(n > 0)) return null
  return `${n} sous-agent${n > 1 ? 's' : ''} en cours`
}

export interface AgentTree {
  /** En cours, par ordre de lancement. */
  running: Subagent[]
  /** Les derniers finis, du plus récent au plus ancien. */
  finished: Subagent[]
  /** Finis non montrés (« + n autres »). */
  more: number
}

function time(iso: string | null): number {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isNaN(t) ? -Infinity : t
}

/** Sous-arbre de la barre latérale : en cours d'abord, puis les `maxFinished` derniers finis. */
export function agentTree(agents: readonly Subagent[], maxFinished = 5): AgentTree {
  // En cours : ordre de lancement, c'est-à-dire celui de la liste du démon.
  const running = agents.filter((a) => a.status === 'running')
  const indexed = agents.map((a, i) => ({ a, i }))
  const done = indexed
    .filter((x) => x.a.status !== 'running')
    .sort((x, y) => {
      // Ordre total : heure (fin, sinon départ ; inconnue = la plus ancienne) décroissante, puis rang décroissant.
      const tx = time(x.a.ended_at ?? x.a.started_at)
      const ty = time(y.a.ended_at ?? y.a.started_at)
      if (tx !== ty) return ty - tx
      return y.i - x.i
    })
    .map((x) => x.a)
  const max = Math.max(0, maxFinished)
  return { running, finished: done.slice(0, max), more: Math.max(0, done.length - max) }
}

/** Durée en millisecondes : jusqu'à la fin, ou jusqu'à `now` s'il tourne ; `null` sans départ. */
export function agentDurationMs(a: Pick<Subagent, 'started_at' | 'ended_at' | 'status'>, now = Date.now()): number | null {
  const start = time(a.started_at)
  if (!Number.isFinite(start)) return null
  const endT = time(a.ended_at)
  const end = Number.isFinite(endT) ? endT : a.status === 'running' ? now : null
  if (end === null) return null
  return Math.max(0, end - start)
}

/** « 8 s », « 3 min 05 s », « 1 h 02 min » ; « — » inconnue. */
export function formatDuration(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s} s`
  const min = Math.floor(s / 60)
  if (min < 60) return `${min} min ${String(s % 60).padStart(2, '0')} s`
  const h = Math.floor(min / 60)
  return `${h} h ${String(min % 60).padStart(2, '0')} min`
}

export interface AgentGlyph {
  /** Classe du glyphe (forme et couleur, jamais la couleur seule). */
  kind: 'running' | 'stopped' | 'error' | 'interrupted'
  label: string
}

const GLYPHS: Record<SubagentStatus, AgentGlyph> = {
  running: { kind: 'running', label: 'en cours' },
  done: { kind: 'stopped', label: 'terminé' },
  failed: { kind: 'error', label: 'échec' },
  interrupted: { kind: 'interrupted', label: 'interrompu' },
}

export function agentGlyph(status: SubagentStatus): AgentGlyph {
  return GLYPHS[status] ?? GLYPHS.done
}

/** Nom à afficher : description, sinon type, sinon « sous-agent ». */
export function agentTitle(a: Pick<Subagent, 'description' | 'agent_type'>): string {
  return a.description?.trim() || a.agent_type?.trim() || 'sous-agent'
}

/** Type affiché (« general-purpose »), « type inconnu » sinon. */
export function agentType(a: Pick<Subagent, 'agent_type'>): string {
  return a.agent_type?.trim() || 'type inconnu'
}

/** Nombre d'outils : « 1 outil », « 12 outils », « outils : inconnu ». */
export function toolCountLabel(n: number | null | undefined): string {
  if (typeof n !== 'number') return 'outils : inconnu'
  return `${n} outil${n > 1 ? 's' : ''}`
}

/**
 * Clé de rechargement du rapport : il change quand l'agent change de
 * statut (ou reçoit sa fin).
 */
export function reportKey(a: Pick<Subagent, 'agent_id' | 'status' | 'ended_at'>): string {
  return `${a.agent_id}:${a.status}:${a.ended_at ?? ''}`
}
