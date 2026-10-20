/**
 * Sous-agents (v0.2, lot 5) : durée tenue à jour sans re-rendu, glyphe de
 * statut (forme + texte), sous-arbre de la barre latérale et onglet « Agents ».
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react'

import { ErrorCode, type Session, type Subagent } from '../../../shared/protocol'
import { call, errorCode, errorText } from '../api'
import { classifyLink, renderMarkdown } from '../state/markdown'
import {
  agentDurationMs,
  agentGlyph,
  agentTitle,
  agentTree,
  agentType,
  formatDuration,
  reportKey,
  subagentFromResult,
  toolCountLabel,
  totalCount,
  runningCount,
} from '../state/subagents'

/* ---------- Durée vivante ---------- */

/** Une seule horloge (1 s) pour toutes les durées affichées d'agents en cours. */
const tickers = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null

function onTick(f: () => void): () => void {
  tickers.add(f)
  timer ??= setInterval(() => {
    for (const g of tickers) g()
  }, 1000)
  return () => {
    tickers.delete(f)
    if (tickers.size === 0 && timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }
}

/**
 * Durée d'un agent. Le texte est écrit directement dans le nœud (pas d'état
 * React) : la seconde qui passe ne re-rend ni la ligne ni la liste.
 */
export function AgentDuration({ agent, className = 'dur' }: { agent: Subagent; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const { started_at, ended_at, status } = agent
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const a = { started_at, ended_at, status }
    const paint = () => {
      el.textContent = formatDuration(agentDurationMs(a, Date.now()))
    }
    paint()
    if (status !== 'running' || ended_at) return
    const off = onTick(paint)
    return () => off()
  }, [started_at, ended_at, status])
  return <span ref={ref} className={className} />
}

/** Glyphe de statut : forme distincte par statut, libellé pour les lecteurs d'écran. */
export function AgentGlyphIcon({ agent, decorative = true }: { agent: Pick<Subagent, 'status'>; decorative?: boolean }) {
  const g = agentGlyph(agent.status)
  return decorative ? (
    <span className={`st ${g.kind}`} aria-hidden="true" title={g.label} />
  ) : (
    <span className={`st ${g.kind}`} role="img" aria-label={g.label} title={g.label} />
  )
}

/* ---------- Barre latérale ---------- */

/** Sous-arbre des sous-agents d'une session (en cours, puis les 5 derniers finis). */
export function SidebarAgents({
  session,
  agents,
  open,
  onToggle,
  onOpen,
}: {
  session: Session
  agents: readonly Subagent[]
  open: boolean
  onToggle: () => void
  /** Ouvre l'onglet « Agents » (sur cet agent, ou sans choix). */
  onOpen: (agentId: string | null) => void
}) {
  const tree = useMemo(() => agentTree(agents), [agents])
  if (agents.length === 0) return null
  const running = tree.running.length
  const listId = `agents-${session.id}`
  const rows = [...tree.running, ...tree.finished]
  return (
    <div className="agents">
      <button className="ag-toggle" aria-expanded={open} aria-controls={listId} onClick={onToggle}>
        <span className="chev" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span>Sous-agents</span>
        <span className="hint">
          {running > 0 ? `${running} en cours · ` : ''}
          {agents.length}
        </span>
      </button>
      {/* Replié : la liste reste (cible d'`aria-controls`) mais ses lignes ne sont pas montées. */}
      <ul id={listId} role="list" className="ag-rows" hidden={!open}>
        {open && rows.map((a) => {
          const g = agentGlyph(a.status)
          const title = agentTitle(a)
          const type = agentType(a)
          return (
            <li key={a.agent_id}>
              <button
                className="ag-row"
                onClick={() => onOpen(a.agent_id)}
                title={`${title}\n${type} · ${g.label}${a.current_tool ? ` · ${a.current_tool}` : ''}`}
                aria-label={`Sous-agent ${title}, ${type}, ${g.label}${a.current_tool ? `, outil en cours ${a.current_tool}` : ''}`}
              >
                <AgentGlyphIcon agent={a} />
                <span className="names">
                  <span className="nm-t">{title}</span>
                  <span className="sub">
                    <span className={`ag-stt ${g.kind}`}>{g.label}</span>
                    {a.description && <span className="br">{type}</span>}
                    {a.current_tool && <span className="tool mono">{a.current_tool}</span>}
                  </span>
                </span>
                <AgentDuration agent={a} className="ago" />
              </button>
            </li>
          )
        })}
        {open && tree.more > 0 && (
          <li>
            <button className="ag-more hint" onClick={() => onOpen(null)}>
              + {tree.more} autre{tree.more > 1 ? 's' : ''}
            </button>
          </li>
        )}
      </ul>
    </div>
  )
}

/* ---------- Onglet « Agents » ---------- */

/** Rapports déjà lus (par session et clé de rapport), pour ne pas les redemander. */
const reports = new Map<string, Subagent>()
const MAX_REPORTS = 50

function remember(key: string, a: Subagent): void {
  reports.delete(key)
  reports.set(key, a)
  if (reports.size > MAX_REPORTS) reports.delete(reports.keys().next().value!)
}

type Detail =
  | { phase: 'loading' }
  | { phase: 'ready'; agent: Subagent }
  | { phase: 'error'; message: string }
  | { phase: 'unsupported' }

/** Rapport de l'agent choisi : `sessions.subagent`, rechargé quand l'agent change de statut. */
function useAgentDetail(sessionId: string, agent: Subagent | null): Detail | null {
  const key = agent ? `${sessionId}:${reportKey(agent)}` : null
  const [detail, setDetail] = useState<{ key: string; d: Detail } | null>(null)
  // Rapport déjà lu : pris dans le cache pendant le rendu (pas de « Chargement » fugace).
  const hit = key ? reports.get(key) : undefined
  useEffect(() => {
    if (!key || !agent || reports.has(key)) return
    let alive = true
    setDetail({ key, d: { phase: 'loading' } })
    call('sessions.subagent', { id: sessionId, agent_id: agent.agent_id })
      .then((r) => {
        if (!alive) return
        const a = subagentFromResult(r)
        if (!a) {
          setDetail({ key, d: { phase: 'error', message: 'réponse du démon illisible' } })
          return
        }
        remember(key, a)
        setDetail({ key, d: { phase: 'ready', agent: a } })
      })
      .catch((e: unknown) => {
        if (!alive) return
        setDetail({
          key,
          d: errorCode(e) === ErrorCode.MethodNotFound ? { phase: 'unsupported' } : { phase: 'error', message: errorText(e) },
        })
      })
    return () => {
      alive = false
    }
    // `key` porte l'agent, son statut et sa fin.
  }, [key])
  if (hit) return { phase: 'ready', agent: hit }
  return detail && detail.key === key ? detail.d : key ? { phase: 'loading' } : null
}

function Report({ agent, detail, onLink }: { agent: Subagent; detail: Detail | null; onLink: (url: string) => void }) {
  const ref = useRef<HTMLElement>(null)
  const report = detail?.phase === 'ready' ? detail.agent.report : null
  const truncated = detail?.phase === 'ready' && detail.agent.report_truncated === true
  const html = useMemo(() => (report ? renderMarkdown(report).html : null), [report])

  function onClick(e: MouseEvent<HTMLElement>) {
    const a = (e.target as HTMLElement).closest('a')
    if (!a) return
    e.preventDefault()
    const t = classifyLink(a.getAttribute('href'), '')
    if (t.kind === 'external') onLink(t.url)
    else if (t.kind === 'anchor') ref.current?.querySelector(`[id="${CSS.escape(t.id)}"]`)?.scrollIntoView({ block: 'start' })
    // Fichiers et autres liens : inertes (le rapport n'a pas de dossier de référence).
  }

  if (!detail || detail.phase === 'loading') return <p className="empty">Chargement du rapport…</p>
  if (detail.phase === 'unsupported') {
    return <p className="empty">Le démon ne donne pas encore les rapports des sous-agents : mets orchd à jour.</p>
  }
  if (detail.phase === 'error') {
    return (
      <p className="inline-err pad" role="alert">
        Rapport indisponible : {detail.message}
      </p>
    )
  }
  if (!html) {
    return (
      <p className="empty">
        {agent.status === 'running' ? 'Le rapport arrivera à la fin de l’agent.' : 'Aucun rapport pour cet agent.'}
      </p>
    )
  }
  return (
    <>
      {truncated && (
        <p className="ag-cut" role="note">
          Rapport coupé par le démon (64 Kio au plus) : la fin manque.
        </p>
      )}
      {/* HTML produit par markdown-it sans HTML brut (échappé) ni image chargée, comme l'onglet Fichiers. */}
      <article ref={ref} className="md" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
    </>
  )
}

function formatClock(iso: string | null): string | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  return new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/** Aucun sous-agent (référence stable). */
const NO_AGENTS: readonly Subagent[] = []

export function AgentsView({
  session,
  agents: known,
  load,
  onRetry,
  selectedId,
  onSelect,
  onLink,
}: {
  session: Session
  /** Liste connue, ou `undefined` (pas encore reçue). */
  agents: readonly Subagent[] | undefined
  /** Amorçage de la liste (voir `subagentsLoad`). */
  load: 'loading' | 'failed' | 'unsupported' | null
  onRetry: () => void
  /** Agent choisi (gardé par session), ou `null`. */
  selectedId: string | null
  onSelect: (agentId: string) => void
  onLink: (url: string) => void
}) {
  const agents = known ?? NO_AGENTS
  // Même ordre que la barre latérale, sans limite : en cours, puis les finis du plus récent au plus ancien.
  const ordered = useMemo(() => {
    const t = agentTree(agents, Number.MAX_SAFE_INTEGER)
    return [...t.running, ...t.finished]
  }, [agents])
  const agent = ordered.find((a) => a.agent_id === selectedId) ?? ordered[0] ?? null
  // Agent affiché sans choix explicite : il devient le choix, pour ne plus changer tout seul.
  const shownId = agent?.agent_id ?? null
  useEffect(() => {
    if (shownId && shownId !== selectedId) onSelect(shownId)
  }, [shownId, selectedId, onSelect])
  const detail = useAgentDetail(session.id, agent)
  const running = runningCount(session, known)
  const total = totalCount(session, known)
  const titleId = useId()

  if (ordered.length === 0) {
    if (total > 0 && load !== 'unsupported') {
      // Liste reçue vide alors que le démon en compte, ou demande en échec : « indisponible ».
      return load === 'failed' || (known !== undefined && load !== 'loading') ? (
        <div className="empty">
          <p>
            Liste indisponible : {total} sous-agent{total > 1 ? 's' : ''} connu{total > 1 ? 's' : ''} du démon.
          </p>
          <button className="btn sm" onClick={onRetry}>
            Réessayer
          </button>
        </div>
      ) : (
        <p className="empty">Chargement des sous-agents…</p>
      )
    }
    return (
      <p className="empty">
        {session.subagents_total === undefined
          ? 'Le démon ne suit pas encore les sous-agents : mets orchd à jour.'
          : 'Aucun sous-agent lancé dans cette session.'}
      </p>
    )
  }

  return (
    <div className="agents-view">
      <div className="ag-list">
        <div className="cap">
          <span className="lbl">Sous-agents</span>
          <span className="hint">
            {running > 0 ? `${running} en cours · ` : ''}
            {total} au total
          </span>
        </div>
        <ul role="list">
          {ordered.map((a) => {
            const g = agentGlyph(a.status)
            const title = agentTitle(a)
            return (
              <li key={a.agent_id}>
                <button
                  className="ag-item"
                  aria-current={a.agent_id === agent?.agent_id}
                  onClick={() => onSelect(a.agent_id)}
                  title={title}
                >
                  <span className="ag-l1">
                    <AgentGlyphIcon agent={a} />
                    <span className={`ag-stt ${g.kind}`}>{g.label}</span>
                    <span className="ag-type mono">{agentType(a)}</span>
                    <AgentDuration agent={a} className="dur hint" />
                  </span>
                  <span className="ag-desc">{title}</span>
                  <span className="ag-l3 hint">
                    {a.model && <span>{a.model}</span>}
                    <span>{toolCountLabel(a.tool_count)}</span>
                    {a.current_tool && <span className="mono">▸ {a.current_tool}</span>}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </div>
      {agent && (
        <div className="ag-detail" tabIndex={0} role="region" aria-labelledby={titleId}>
          <div className="ag-dh">
            <h3 id={titleId}>
              <AgentGlyphIcon agent={agent} decorative={false} /> {agentTitle(agent)}
            </h3>
            <dl className="ag-meta">
              <div>
                <dt>Statut</dt>
                <dd>{agentGlyph(agent.status).label}</dd>
              </div>
              <div>
                <dt>Type</dt>
                <dd className="mono">{agentType(agent)}</dd>
              </div>
              <div>
                <dt>Modèle</dt>
                <dd>{agent.model ?? 'inconnu'}</dd>
              </div>
              <div>
                <dt>Durée</dt>
                <dd>
                  <AgentDuration agent={agent} />
                  {formatClock(agent.started_at) && (
                    <span className="hint">
                      {' '}
                      (départ {formatClock(agent.started_at)}
                      {formatClock(agent.ended_at) ? `, fin ${formatClock(agent.ended_at)}` : ''})
                    </span>
                  )}
                </dd>
              </div>
              <div>
                <dt>Outils</dt>
                <dd>
                  {toolCountLabel(agent.tool_count)}
                  {agent.current_tool ? (
                    <span className="mono"> · en cours : {agent.current_tool}</span>
                  ) : agent.last_tool ? (
                    <span className="mono hint"> · dernier : {agent.last_tool}</span>
                  ) : null}
                </dd>
              </div>
            </dl>
          </div>
          <Report agent={agent} detail={detail} onLink={onLink} />
        </div>
      )}
    </div>
  )
}
