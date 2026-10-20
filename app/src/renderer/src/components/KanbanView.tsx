/**
 * Vue par statut (kanban) : une colonne par statut, une carte par session.
 * Une permission se règle depuis la carte (Autoriser / Refuser) ; une
 * question ouvre la session. Cliquer sur une carte ouvre la session dans un
 * volet à côté du kanban (on reste dans la vue par statut) ; filtre par projet
 * retenu localement.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'

import type { PendingRequest, ProjectInfo, Profile, Session, Subagent } from '../../../shared/protocol'
import { call, errorCode, errorText } from '../api'
import { ALREADY_CLOSED } from '../state/errors'
import { basename, formatPct, formatUsd, relativeTime, sessionColor, sessionDisplayName } from '../state/format'
import { browserStorage } from '../state/collapse'
import { COLUMNS, demandSummary, firstPending, kanbanColumns, oneClickAllowed, permissionParts } from '../state/kanban'
import {
  cardSelected,
  filterFor,
  filterSessions,
  loadProjectFilter,
  projectOptions,
  saveProjectFilter,
  type ProjectFilter,
} from '../state/kanbanFilter'
import type { ProjectGroup } from '../state/projects'
import { answerability } from '../state/requests'
import { glyphFor } from '../state/status'
import { runningCount, runningLabel } from '../state/subagents'
import { ProfileBadge, StatusGlyph } from './common'
import { ColorBar } from './SessionIdentity'

const NO_STALE: readonly number[] = []

/** Actions d'une demande ; à monter avec `key = request_id` (état remis à zéro pour une nouvelle demande). */
function PermissionActions({
  session,
  req,
  stale,
  onOpen,
}: {
  session: Session
  req: PendingRequest
  stale: readonly number[]
  onOpen: () => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const can = answerability(req)
  if (!oneClickAllowed(session, req, stale)) {
    const why = !can.ok
      ? can.why
      : req.pending.kind === 'question'
        ? undefined
        : 'Demande à lire en entier (ou peut-être obsolète) : ouvre la session pour répondre.'
    return (
      <div className="kacts">
        <button className="btn sm warn" onClick={onOpen} title={why}>
          {req.pending.kind === 'question' ? 'Répondre' : 'Ouvrir pour répondre'}
        </button>
      </div>
    )
  }
  async function answer(decision: 'allow' | 'deny') {
    setBusy(decision)
    setError(null)
    try {
      await call('sessions.answerPermission', { id: session.id, request_id: req.request_id, decision })
    } catch (e) {
      if (errorCode(e) !== ALREADY_CLOSED) setError(`Réponse non transmise : ${errorText(e)}`)
      setBusy(null)
    }
  }
  return (
    <div className="kacts">
      <button className="btn sm pri" disabled={busy !== null} onClick={() => void answer('allow')}>
        {busy === 'allow' ? 'Envoi…' : 'Autoriser'}
      </button>
      <button className="btn sm danger" disabled={busy !== null} onClick={() => void answer('deny')}>
        {busy === 'deny' ? 'Envoi…' : 'Refuser'}
      </button>
      <button className="btn sm ghost" onClick={onOpen}>
        Ouvrir
      </button>
      {error && (
        <span className="inline-err" role="alert">
          {error}
        </span>
      )}
    </div>
  )
}

function Card({
  session,
  agents,
  project,
  profiles,
  stale,
  selected,
  onOpen,
}: {
  session: Session
  /** Carte de la session affichée dans le volet. */
  selected: boolean
  /** Liste connue, ou `undefined` (le compteur de la session sert alors de repli). */
  agents: readonly Subagent[] | undefined
  project: ProjectInfo | undefined
  profiles: Profile[]
  stale: readonly number[]
  onOpen: () => void
}) {
  const glyph = glyphFor(session.status)
  const name = sessionDisplayName(session)
  const projectName = project?.name ?? basename(project?.root ?? session.project_root ?? session.cwd)
  const req = firstPending(session)
  const perm = req ? permissionParts(req.pending) : null
  const m = session.metrics
  const agentsRunning = runningLabel(runningCount(session, agents))
  // Clic ailleurs que sur un bouton de la carte : ouvre la session (au clavier : le bouton du nom).
  const onCardClick = (e: MouseEvent<HTMLLIElement>) => {
    if ((e.target as Element).closest('button, a, input, select, textarea')) return
    if (window.getSelection()?.isCollapsed === false) return
    onOpen()
  }
  return (
    <li className={`kcard${glyph.kind === 'waiting' ? ' wait' : ''}${selected ? ' sel' : ''}`} onClick={onCardClick}>
      <div className="khead">
        <StatusGlyph glyph={glyph} decorative={false} />
        <ColorBar color={sessionColor(session)} />
        <button
          id={cardId(session.id)}
          className="kname"
          onClick={onOpen}
          aria-current={selected ? 'true' : undefined}
          title={`Afficher « ${name} » à côté du kanban`}
        >
          {name}
        </button>
        <ProfileBadge profile={session.profile} profiles={profiles} />
      </div>
      <div className="kwhere mono">
        {projectName} <span>/</span> {session.branch ?? 'sans branche'}
      </div>
      {req && (
        <p className="kask" title={demandSummary(req.pending, 1000)}>
          <b>{req.pending.kind === 'question' ? 'Question' : 'Permission'} :</b>{' '}
          {perm ? (
            <>
              {perm.tool}
              {perm.input && (
                <>
                  {' · '}
                  <code>{perm.input}</code>
                </>
              )}
            </>
          ) : (
            demandSummary(req.pending)
          )}
          {session.pending.length > 1 && <span className="hint"> (+{session.pending.length - 1})</span>}
        </p>
      )}
      {req && (session.possibly_stale || stale.includes(req.request_id)) && (
        <span
          className="chip pend"
          title="La demande a peut-être déjà été traitée dans le terminal : ouvre la session pour vérifier."
        >
          peut-être obsolète
        </span>
      )}
      {req && <PermissionActions key={req.request_id} session={session} req={req} stale={stale} onOpen={onOpen} />}
      {agentsRunning && (
        <span className="chip ag-chip">
          <span className="st running" aria-hidden="true" /> {agentsRunning}
        </span>
      )}
      <div className="kmeta hint">
        <span>contexte {formatPct(m?.context_used_pct)}</span>
        <span>{formatUsd(m?.cost_usd)}</span>
        <span>{relativeTime(session.last_activity)}</span>
      </div>
    </li>
  )
}

/** Identifiant du bouton de nom d'une carte (focus rendu à la fermeture du volet). */
function cardId(sessionId: string): string {
  return `kcard-${sessionId}`
}

/** Échap ferme le volet, sauf dans un champ, un dialogue ou le terminal (où Échap va à Claude). */
function escapeCloses(e: KeyboardEvent): boolean {
  if (e.key !== 'Escape' || e.defaultPrevented) return false
  const t = e.target as Element | null
  return !t?.closest?.('.xterm, input, textarea, select, [contenteditable="true"], [role="dialog"], dialog')
}

export function KanbanView({
  sessions,
  groups,
  projects,
  profiles,
  stale,
  subagents,
  selectedId,
  paneOpen,
  pane,
  onOpen,
  onClose,
}: {
  sessions: Session[]
  /** Groupes de la barre latérale (`groupByProject`) : choix du filtre par projet. */
  groups: readonly ProjectGroup[]
  /** Sous-agents connus, par session. */
  subagents: Record<string, Subagent[]>
  projects: Record<string, ProjectInfo>
  profiles: Profile[]
  /** Demandes signalées « peut-être obsolètes », par session. */
  stale: Record<string, number[]>
  /** Session choisie (celle du volet). */
  selectedId: string | null
  /** Volet ouvert (choix de l'utilisateur, gardé d'une vue à l'autre). */
  paneOpen: boolean
  /** Volet de la session (`SessionPane`), `null` s'il n'est pas affiché. */
  pane: ReactNode
  onOpen: (id: string) => void
  onClose: () => void
}) {
  const [stored, setStored] = useState<ProjectFilter | null>(() => loadProjectFilter(browserStorage()))
  // Nom à jour quand le projet est là ; sinon le nom retenu (projet sans session).
  const filter = useMemo(() => (stored ? (filterFor(groups, stored.key) ?? stored) : null), [stored, groups])
  const options = useMemo(() => projectOptions(groups, filter), [groups, filter])
  const visible = useMemo(() => filterSessions(sessions, groups, filter), [sessions, groups, filter])
  const cols = kanbanColumns(visible)
  const showPane = pane !== null && pane !== undefined && pane !== false

  const choose = (key: string) => {
    const next = key === '' ? null : (filterFor(groups, key) ?? (filter?.key === key ? filter : null))
    setStored(next)
    saveProjectFilter(browserStorage(), next)
  }

  // Focus : au volet à l'ouverture, à la carte (ou au filtre si elle est masquée) à la fermeture.
  const closeRef = useRef<HTMLButtonElement>(null)
  const selectRef = useRef<HTMLSelectElement>(null)
  const wasShown = useRef(showPane)
  const lastId = useRef(selectedId)
  useEffect(() => {
    // Ouverture seulement : passer d'une carte à l'autre, volet ouvert, laisse le focus sur les cartes.
    if (showPane && !wasShown.current) closeRef.current?.focus()
    else if (!showPane && wasShown.current && lastId.current) {
      const card = document.getElementById(cardId(lastId.current))
      ;(card ?? selectRef.current)?.focus()
    }
    wasShown.current = showPane
    lastId.current = selectedId
  }, [showPane, selectedId])

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (showPane && escapeCloses(e)) {
      e.preventDefault()
      onClose()
    }
  }

  const empty = filter !== null && visible.length === 0
  return (
    <main className={`kview${showPane ? ' open' : ''}`} onKeyDown={onKeyDown}>
      <div className="kside">
        <div className="khdr">
          <label htmlFor="kanban-project">Projet :</label>
          <select
            id="kanban-project"
            ref={selectRef}
            value={filter?.key ?? ''}
            onChange={(e) => choose(e.target.value)}
          >
            <option value="">Tous les projets ({sessions.length})</option>
            {options.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label} ({o.count})
              </option>
            ))}
          </select>
        </div>
        {empty ? (
          <div className="kempty panel" role="status">
            <p>
              Aucune session affichée pour le projet « {filter.name} ».
            </p>
            <button className="btn sm" onClick={() => choose('')}>
              Afficher tous les projets
            </button>
          </div>
        ) : (
          <div className="kanban" role="region" aria-label="Sessions par statut">
            {COLUMNS.map((c) => (
              <section key={c.key} className={`kcol k-${c.key}`} aria-labelledby={`kcol-${c.key}`}>
                <h2 id={`kcol-${c.key}`} className="kctitle">
                  <span className="lbl">{c.title}</span>
                  <span className={`badge${c.key === 'waiting' && cols[c.key].length ? ' wait' : ''}`}>{cols[c.key].length}</span>
                </h2>
                <ul role="list" className="kcards">
                  {cols[c.key].length === 0 && <li className="hint pad">Aucune session.</li>}
                  {cols[c.key].map((s) => (
                    <Card
                      key={s.id}
                      session={s}
                      selected={cardSelected(s.id, showPane, selectedId)}
                      agents={subagents[s.id]}
                      project={projects[s.cwd]}
                      profiles={profiles}
                      stale={stale[s.id] ?? NO_STALE}
                      onOpen={() => onOpen(s.id)}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
      {showPane && (
        <div className="kpane">
          <div className="kpane-bar">
            <span className="hint">Session ouverte depuis la vue par statut · Échap pour fermer</span>
            <button ref={closeRef} className="btn sm ghost" onClick={onClose}>
              Fermer
            </button>
          </div>
          {pane}
        </div>
      )}
    </main>
  )
}
