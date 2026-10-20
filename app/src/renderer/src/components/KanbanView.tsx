/**
 * Vue par statut (kanban) : une colonne par statut, une carte par session.
 * Une permission se règle depuis la carte (Autoriser / Refuser) ; une
 * question ouvre la session. Cliquer sur le nom ouvre la session « par projet ».
 */
import { useState } from 'react'

import type { PendingRequest, ProjectInfo, Profile, Session } from '../../../shared/protocol'

const NO_STALE: readonly number[] = []
import { call, errorCode, errorText } from '../api'
import { ALREADY_CLOSED } from '../state/errors'
import { basename, formatPct, formatUsd, relativeTime, sessionColor, sessionDisplayName } from '../state/format'
import { COLUMNS, demandSummary, firstPending, kanbanColumns, oneClickAllowed } from '../state/kanban'
import { answerability } from '../state/requests'
import { glyphFor } from '../state/status'
import { ProfileBadge, StatusGlyph } from './common'
import { ColorBar } from './SessionIdentity'

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
  project,
  profiles,
  stale,
  onOpen,
}: {
  session: Session
  project: ProjectInfo | undefined
  profiles: Profile[]
  stale: readonly number[]
  onOpen: () => void
}) {
  const glyph = glyphFor(session.status)
  const name = sessionDisplayName(session)
  const projectName = project?.name ?? basename(project?.root ?? session.project_root ?? session.cwd)
  const req = firstPending(session)
  const m = session.metrics
  return (
    <li className={`kcard${glyph.kind === 'waiting' ? ' wait' : ''}`}>
      <div className="khead">
        <StatusGlyph glyph={glyph} decorative={false} />
        <ColorBar color={sessionColor(session)} />
        <button className="kname" onClick={onOpen} title={`Ouvrir « ${name} » (vue par projet)`}>
          {name}
        </button>
        <ProfileBadge profile={session.profile} profiles={profiles} />
      </div>
      <div className="kwhere mono">
        {projectName} <span>/</span> {session.branch ?? 'sans branche'}
      </div>
      {req && (
        <p className="kask" title={demandSummary(req.pending, 1000)}>
          <b>{req.pending.kind === 'question' ? 'Question' : 'Permission'} :</b> {demandSummary(req.pending)}
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
      <div className="kmeta hint">
        <span>contexte {formatPct(m?.context_used_pct)}</span>
        <span>{formatUsd(m?.cost_usd)}</span>
        <span>{relativeTime(session.last_activity)}</span>
      </div>
    </li>
  )
}

export function KanbanView({
  sessions,
  projects,
  profiles,
  stale,
  onOpen,
}: {
  sessions: Session[]
  projects: Record<string, ProjectInfo>
  profiles: Profile[]
  /** Demandes signalées « peut-être obsolètes », par session. */
  stale: Record<string, number[]>
  onOpen: (id: string) => void
}) {
  const cols = kanbanColumns(sessions)
  return (
    <main className="kanban" aria-label="Sessions par statut">
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
                project={projects[s.cwd]}
                profiles={profiles}
                stale={stale[s.id] ?? NO_STALE}
                onOpen={() => onOpen(s.id)}
              />
            ))}
          </ul>
        </section>
      ))}
    </main>
  )
}
