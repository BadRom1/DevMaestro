import { useId, useRef, useState } from 'react'

import type { PendingRequest, PermissionDecision, Question, Session } from '../../../shared/protocol'
import { call, errorCode, errorText } from '../api'
import { ALREADY_CLOSED } from '../state/errors'
import {
  answerability,
  buildAnswers,
  canAllowAlways,
  describeSuggestions,
  emptyDraft,
  summarizeToolInput,
  toggleOption,
  type QuestionDraft,
} from '../state/requests'

/**
 * Envoi d'une réponse, une seule fois : la carte reste désactivée après un
 * succès jusqu'à ce que la demande disparaisse de `pending` (la carte est
 * alors démontée). Un « déjà close » (-32010) qui suit notre propre succès
 * n'est pas une erreur.
 */
function useAnswer() {
  const inFlight = useRef(false)
  const succeeded = useRef(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function send(label: string, f: () => Promise<unknown>) {
    if (inFlight.current || succeeded.current) return
    inFlight.current = true
    setBusy(label)
    setError(null)
    try {
      await f()
      succeeded.current = true
      setDone(true)
    } catch (e) {
      if (!(succeeded.current && errorCode(e) === ALREADY_CLOSED)) setError(`Réponse non transmise : ${errorText(e)}`)
    } finally {
      inFlight.current = false
      setBusy(null)
    }
  }
  return { busy, done, error, send, locked: busy !== null || done }
}

function StaleBadge() {
  return (
    <span
      className="chip pend"
      title="La demande a peut-être déjà été traitée dans le terminal (interruption, dialogue fermé) : la réponse peut être refusée."
    >
      peut-être obsolète
    </span>
  )
}

export function PermissionCard({
  session,
  req,
  stale,
  cardKey,
}: {
  session: Session
  req: PendingRequest
  stale: boolean
  cardKey: string
}) {
  const { busy, done, error, send, locked } = useAnswer()
  const [denyOpen, setDenyOpen] = useState(false)
  const [message, setMessage] = useState('')
  const msgId = useId()
  const d = req.pending
  const detailed = d.kind === 'permission' && d.detailed !== false
  const tool = detailed ? d.tool_name : null
  const summary = detailed ? summarizeToolInput(d.tool_name, d.tool_input) : null
  const suggestions = describeSuggestions(req)
  const can = answerability(req)
  const always = canAllowAlways(req)
  const off = locked || !can.ok

  function answer(decision: PermissionDecision) {
    const msg = message.trim()
    return send(decision, () =>
      call('sessions.answerPermission', {
        id: session.id,
        request_id: req.request_id,
        decision,
        ...(decision === 'deny' && msg ? { message: msg } : {}),
      }),
    )
  }

  return (
    <section
      className={`ask${stale ? ' stale' : ''}`}
      aria-label={`Permission demandée${tool ? ` : ${tool}` : ''}`}
      tabIndex={-1}
      data-request-key={cardKey}
    >
      <span className="t">
        Permission demandée
        {stale && <StaleBadge />}
        {done && <span className="chip">réponse envoyée</span>}
      </span>
      {detailed && (
        <div>
          {tool} : <code>{summary}</code>
        </div>
      )}
      {!can.ok && <div className="muted">{can.why}</div>}
      {suggestions.length > 0 && (
        <div>
          <span className="muted">« Toujours » ajouterait :</span>
          <ul className="sugg">
            {suggestions.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="row">
        <button className="btn pri" disabled={off} onClick={() => void answer('allow')}>
          {busy === 'allow' ? 'Envoi…' : 'Autoriser'}
        </button>
        <button
          className="btn"
          disabled={off || !always}
          title={always ? undefined : 'Claude Code ne propose aucune règle à enregistrer pour cette demande.'}
          onClick={() => void answer('allow_always')}
        >
          {busy === 'allow_always' ? 'Envoi…' : 'Toujours pour ce projet'}
        </button>
        <button className="btn" disabled={off} onClick={() => void answer('deny')}>
          {busy === 'deny' ? 'Envoi…' : 'Refuser'}
        </button>
        <button
          className="btn ghost"
          disabled={off}
          aria-expanded={denyOpen}
          aria-controls={msgId}
          onClick={() => setDenyOpen((v) => !v)}
        >
          Refuser avec un message…
        </button>
      </div>
      {denyOpen && (
        <form
          className="row"
          id={msgId}
          onSubmit={(e) => {
            e.preventDefault()
            void answer('deny')
          }}
        >
          <input
            type="text"
            aria-label="Message pour Claude (facultatif)"
            placeholder="Pourquoi refuser, ou quoi faire à la place…"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            autoFocus
          />
          <button className="btn danger" disabled={off}>
            Envoyer le refus
          </button>
        </form>
      )}
      {error && (
        <div className="err" role="alert">
          {error}
        </div>
      )}
    </section>
  )
}

function QuestionBlock({
  q,
  index,
  draft,
  onDraft,
  onPick,
  disabled,
}: {
  q: Question
  index: number
  draft: QuestionDraft
  onDraft: (d: QuestionDraft) => void
  onPick?: (label: string) => void
  disabled: boolean
}) {
  const name = useId()
  const multi = !!q.multi_select
  return (
    <fieldset className="q">
      <legend>
        {q.header && <span className="chip">{q.header}</span>} {q.question}
      </legend>
      {multi ? (
        q.options.map((o) => (
          <label className="opt" key={o.label}>
            <input
              type="checkbox"
              name={`${name}-${index}`}
              checked={draft.selected.includes(o.label)}
              disabled={disabled}
              onChange={() => onDraft(toggleOption(draft, o.label, true))}
            />
            <span>
              {o.label}
              {o.description && <small> — {o.description}</small>}
            </span>
          </label>
        ))
      ) : (
        <div className="row">
          {q.options.map((o) => (
            <button
              key={o.label}
              type="button"
              className="btn"
              aria-pressed={draft.selected[0] === o.label && !draft.other.trim()}
              title={o.description ?? undefined}
              disabled={disabled}
              onClick={() => (onPick ? onPick(o.label) : onDraft(toggleOption(draft, o.label, false)))}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
      <div className="row">
        <input
          type="text"
          aria-label={`Autre réponse à « ${q.question} »`}
          placeholder="Autre réponse (texte libre)…"
          value={draft.other}
          disabled={disabled}
          onChange={(e) => onDraft({ ...draft, other: e.target.value })}
        />
      </div>
    </fieldset>
  )
}

export function QuestionCard({
  session,
  req,
  stale,
  cardKey,
}: {
  session: Session
  req: PendingRequest
  stale: boolean
  cardKey: string
}) {
  const d = req.pending
  const questions = d.kind === 'question' && d.detailed !== false ? d.questions : []
  const [drafts, setDrafts] = useState<QuestionDraft[]>(() => questions.map(() => emptyDraft()))
  const { busy, done, error, send: sendOnce, locked } = useAnswer()
  const { answers, complete } = buildAnswers(questions, drafts)
  // Une seule question à choix simple : un clic sur une option répond.
  const quick = questions.length === 1 && !questions[0]!.multi_select
  const can = answerability(req)

  function send(a: Record<string, string | string[]>) {
    return sendOnce('answer', () =>
      call('sessions.answerQuestion', { id: session.id, request_id: req.request_id, answers: a }),
    )
  }

  if (questions.length === 0) {
    return (
      <section className={`ask${stale ? ' stale' : ''}`} aria-label="Question de Claude" tabIndex={-1} data-request-key={cardKey}>
        <span className="t">
          Claude te pose une question
          {stale && <StaleBadge />}
        </span>
        <div className="muted">{can.ok ? 'Détails inconnus : réponds dans le terminal.' : can.why}</div>
      </section>
    )
  }

  return (
    <section className={`ask${stale ? ' stale' : ''}`} aria-label="Question de Claude" tabIndex={-1} data-request-key={cardKey}>
      <span className="t">
        Claude te pose {questions.length > 1 ? `${questions.length} questions` : 'une question'}
        {stale && <StaleBadge />}
        {done && <span className="chip">réponse envoyée</span>}
      </span>
      <form
        style={{ display: 'grid', gap: 10 }}
        onSubmit={(e) => {
          e.preventDefault()
          if (complete && can.ok) void send(answers)
        }}
      >
        {questions.map((q, i) => (
          <QuestionBlock
            key={i}
            q={q}
            index={i}
            draft={drafts[i] ?? emptyDraft()}
            disabled={locked || !can.ok}
            onDraft={(nd) => setDrafts((all) => all.map((x, j) => (j === i ? nd : x)))}
            onPick={quick ? (label) => void send({ [q.question]: label }) : undefined}
          />
        ))}
        {!can.ok && <div className="muted">{can.why}</div>}
        <div className="row">
          <button className="btn pri" disabled={!complete || locked || !can.ok}>
            {busy ? 'Envoi…' : 'Envoyer la réponse'}
          </button>
          {!complete && <span className="hint">Réponds à chaque question pour envoyer.</span>}
        </div>
      </form>
      {error && (
        <div className="err" role="alert">
          {error}
        </div>
      )}
    </section>
  )
}
