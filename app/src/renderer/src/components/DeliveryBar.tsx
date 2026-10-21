/**
 * Livraison et CI d'une session (v0.3, lot 14b), sous l'en-tête :
 *
 * - « Ouvrir une demande de fusion » et « Fusionner dans <branche par
 *   défaut> » : la consigne (modèle des réglages, par projet) est montrée
 *   telle qu'elle sera **tapée**, puis envoyée à Claude seulement après
 *   « Envoyer à Claude ». C'est Claude qui livre, dans sa session, avec ses
 *   demandes de permission habituelles : l'app n'écrit rien sur la forge.
 *   Le bouton principal est celui du mode du projet (PR ou trunk-based).
 * - État de livraison (« Livrée », « PR #n ouverte ») et CI suivie
 *   (`forge.sessionCi`, relue toutes les 60 s tant que la session est
 *   affichée, et à chaque `forge.ci_changed`).
 * - « Voir l'échec » : jobs en échec et extrait des journaux ; « Envoyer
 *   l'échec à Claude » tape une consigne fixe et **colle** l'extrait comme
 *   donnée (`sessions.sendPrompt {instruction, pasted}`), jamais comme
 *   consigne.
 */
import { useEffect, useId, useState } from 'react'

import type { Session, SessionCi } from '../../../shared/protocol'
import { projectDelivery } from '../../../shared/settings'
import { api, call, errorCode, errorText } from '../api'
import {
  SESSION_CI_REFRESH_MS,
  actionLabel,
  ciBadge,
  deliveryBadge,
  deliveryBlocker,
  deliveryOf,
  deliveryPrompt,
  failedRuns,
  primaryAction,
  runLabel,
  sessionCiErrorKind,
  sessionCiOf,
  type DeliveryAction,
} from '../state/delivery'
import type { RunFailure } from '../../../shared/protocol'
import { useSettings } from '../settings'
import { LinkDialog } from './LinkDialog'
import { Modal } from './Modal'
import { ForgeBadge } from './PullsPanel'

/** Démon sans `forge.sessionCi` (constaté une fois par connexion) : plus d'appel. */
let unsupported = false

/** Nouvelle connexion au démon : il peut avoir été mis à jour. */
export function resetSessionCiSupport(): void {
  unsupported = false
}

/** Livraison et CI de la session, relues tant qu'elle est affichée. */
export function useSessionCi(
  session: Session,
  mode: 'pr' | 'trunk',
  enabled: boolean,
): { ci: SessionCi | null; old: boolean; reload: () => void } {
  const [ci, setCi] = useState<SessionCi | null>(null)
  const [old, setOld] = useState(unsupported)
  const [tick, setTick] = useState(0)
  const deliveryKey = JSON.stringify(session.delivery ?? null)
  useEffect(() => {
    setCi(null)
  }, [session.id, mode])
  useEffect(() => {
    if (!enabled || unsupported) return
    let alive = true
    const load = async () => {
      if (unsupported) return
      try {
        const r = sessionCiOf(await call('forge.sessionCi', { id: session.id, mode }))
        if (alive) setCi(r)
      } catch (e) {
        const kind = sessionCiErrorKind(errorCode(e))
        if (kind === 'old-daemon') {
          unsupported = true
          if (alive) setOld(true)
        }
        if (alive && kind !== 'other') setCi(null)
      }
    }
    void load()
    const timer = setInterval(() => {
      if (!document.hidden) void load()
    }, SESSION_CI_REFRESH_MS)
    const off = api.onNotification((n) => {
      if (n.method === 'forge.ci_changed' && n.params?.id === session.id) void load()
    })
    return () => {
      alive = false
      clearInterval(timer)
      off()
    }
  }, [session.id, mode, enabled, tick, deliveryKey])
  return { ci, old, reload: () => setTick((t) => t + 1) }
}

export function DeliveryBar({
  session,
  projectKey,
  root,
  integrated,
  enabled,
  hidePullCi,
}: {
  session: Session
  /** Clé des réglages du projet (comme le profil par défaut). */
  projectKey: string | null
  /** Dossier d'où interroger la forge (racine du dépôt). */
  root: string
  /** Branche intégrée dans la référence (worktree proposé au nettoyage, lot 6). */
  integrated: boolean
  /** Forge accessible (réglage « Accès aux forges », dépôt git). */
  enabled: boolean
  /** La pastille « PR #n » de l'en-tête montre déjà la CI de la demande. */
  hidePullCi: boolean
}) {
  const { settings } = useSettings()
  const pd = projectDelivery(settings.delivery, projectKey)
  const { ci, old, reload } = useSessionCi(session, pd.mode, enabled)
  const [confirm, setConfirm] = useState<DeliveryAction | null>(null)
  const [failure, setFailure] = useState(false)
  if (!enabled || old) return null
  const base = ci?.base_branch ?? null
  const delivery = session.delivery ?? (ci ? { mode: ci.mode, state: ci.delivery, pull: ci.pull ? { number: ci.pull.number, url: ci.pull.url } : null, ci: ci.ci.state } : null)
  const state = deliveryOf(delivery, integrated)
  const badge = deliveryBadge(delivery, integrated)
  const ciState = ci?.ci.state ?? delivery?.ci ?? null
  const ciB = hidePullCi && state === 'pr_open' ? null : ciBadge(ciState)
  const failed = failedRuns(ci?.ci.runs)
  const primary = primaryAction(pd.mode)
  const secondary: DeliveryAction = primary === 'pr' ? 'merge' : 'pr'
  const pullNumber = delivery?.pull?.number ?? null
  const button = (a: DeliveryAction, pri: boolean) => {
    const blocker = deliveryBlocker(session, a, state, pullNumber)
    return (
      <button
        key={a}
        type="button"
        className={`btn sm${pri ? ' pri' : ' ghost'}`}
        disabled={blocker !== null}
        title={blocker ?? `La consigne sera montrée avant d’être tapée dans la session (mode ${pd.mode === 'trunk' ? 'trunk-based' : 'PR'} du projet).`}
        onClick={() => setConfirm(a)}
      >
        {actionLabel(a, base)}…
      </button>
    )
  }
  return (
    <div className="sh-deliv" role="group" aria-label="Livraison">
      {badge && <ForgeBadge b={badge} className="sm" />}
      {ciB && <ForgeBadge b={ciB} className="sm" />}
      {failed.length > 0 && (
        <button type="button" className="btn sm ghost" onClick={() => setFailure(true)}>
          Voir l’échec…
        </button>
      )}
      <span className="sh-deliv-acts">
        {button(primary, true)}
        {button(secondary, false)}
      </span>
      {confirm && (
        <DeliveryConfirm
          session={session}
          action={confirm}
          template={confirm === 'pr' ? pd.prTemplate : pd.mergeTemplate}
          base={base}
          onClose={() => setConfirm(null)}
          onSent={reload}
        />
      )}
      {failure && <CiFailureDialog session={session} root={root} runs={failed} onClose={() => setFailure(false)} />}
    </div>
  )
}

function DeliveryConfirm({
  session,
  action,
  template,
  base,
  onClose,
  onSent,
}: {
  session: Session
  action: DeliveryAction
  template: string
  base: string | null
  onClose: () => void
  onSent: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const id = useId()
  const prompt = deliveryPrompt(template, session, base)
  async function send() {
    if (!('text' in prompt)) return
    setBusy(true)
    setError(null)
    try {
      await call('sessions.sendPrompt', { id: session.id, text: prompt.text })
      onSent()
      onClose()
    } catch (e) {
      setError(`Envoi impossible : ${errorText(e)}`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal title={`${actionLabel(action, base)} ?`} onClose={onClose} width={640} busy={busy}>
      <div className="mb">
        <p style={{ margin: 0 }}>
          Cette consigne sera <b>tapée</b> dans la session, comme si tu l’écrivais. Claude fera la livraison lui-même, avec ses
          demandes de permission habituelles ; l’app n’écrit rien sur la forge.
        </p>
        {'text' in prompt ? (
          <>
            <span className="lbl" id={`${id}-l`}>
              Consigne envoyée
            </span>
            <pre className="deliv-prompt mono" aria-labelledby={`${id}-l`}>
              {prompt.text}
            </pre>
            <span className="hint">Modèle modifiable dans Réglages → Général → Livraison (par projet).</span>
          </>
        ) : (
          <p className="inline-err" role="alert">
            {prompt.error}
          </p>
        )}
      </div>
      <div className="mf">
        {error ? (
          <span className="err" role="alert">
            {error}
          </span>
        ) : (
          <span style={{ marginRight: 'auto' }} />
        )}
        <button className="btn ghost" onClick={onClose} data-autofocus disabled={busy}>
          Annuler
        </button>
        <button className="btn pri" disabled={busy || !('text' in prompt)} onClick={() => void send()}>
          {busy ? 'Envoi…' : 'Envoyer à Claude'}
        </button>
      </div>
    </Modal>
  )
}

type FailureState = { phase: 'loading' } | { phase: 'ready'; f: RunFailure } | { phase: 'error'; message: string }

function CiFailureDialog({
  session,
  root,
  runs,
  onClose,
}: {
  session: Session
  root: string
  runs: SessionCi['ci']['runs']
  onClose: () => void
}) {
  const [runId, setRunId] = useState(runs[0]!.id)
  const [state, setState] = useState<FailureState>({ phase: 'loading' })
  const [busy, setBusy] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [link, setLink] = useState<string | null>(null)
  const id = useId()
  useEffect(() => {
    let alive = true
    setState({ phase: 'loading' })
    // Relu à chaque ouverture : une exécution relancée garde son numéro.
    call('forge.runFailure', { root, run_id: runId, refresh: true })
      .then((f) => alive && setState({ phase: 'ready', f }))
      .catch((e: unknown) => alive && setState({ phase: 'error', message: errorText(e) }))
    return () => {
      alive = false
    }
  }, [root, runId])
  const blocker = !session.alive
    ? 'La session ne tourne pas : reprends-la pour lui envoyer l’échec.'
    : session.status.state === 'waiting' || session.pending.length > 0
      ? 'Réponds d’abord à la demande en attente dans la session.'
      : null
  async function send(f: RunFailure) {
    if (!f.excerpt) return
    setBusy(true)
    setSendError(null)
    try {
      await call('sessions.sendPrompt', { id: session.id, instruction: f.instruction, pasted: f.excerpt })
      onClose()
    } catch (e) {
      setSendError(`Envoi impossible : ${errorText(e)}`)
    } finally {
      setBusy(false)
    }
  }
  const f = state.phase === 'ready' ? state.f : null
  return (
    <Modal title="Échec de la CI" onClose={onClose} width={820} busy={busy}>
      <div className="mb">
        {runs.length > 1 && (
          <label className="wtrow">
            <span>Exécution</span>
            <select value={runId} onChange={(e) => setRunId(Number(e.target.value))}>
              {runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {runLabel(r)}
                </option>
              ))}
            </select>
          </label>
        )}
        {state.phase === 'loading' && (
          <p className="hint" role="status">
            <span className="spin" aria-hidden="true" /> Lecture des journaux…
          </p>
        )}
        {state.phase === 'error' && (
          <p className="inline-err" role="alert">
            Échec illisible : {state.message}
          </p>
        )}
        {f && (
          <>
            <p style={{ margin: 0 }}>
              <b>{runLabel(f.run)}</b>
              {f.run.url && (
                <>
                  {' · '}
                  <button type="button" className="linkish" onClick={() => setLink(f.run.url)}>
                    Voir sur la forge
                  </button>
                </>
              )}
            </p>
            {f.in_progress ? (
              <p className="hint">L’exécution est encore en cours : la forge ne donne ses journaux qu’à la fin.</p>
            ) : (
              <>
                <span className="lbl">Jobs en échec</span>
                {f.failed_jobs.length === 0 ? (
                  <p className="hint">Aucun job en échec rendu par la forge.</p>
                ) : (
                  <ul className="ci-jobs">
                    {f.failed_jobs.map((j) => (
                      <li key={j.name}>
                        <span aria-hidden="true">✗</span> <b>{j.name}</b>
                        {j.failed_steps.length > 0 && <span className="hint"> — étape « {j.failed_steps.join(' », « ')} »</span>}
                      </li>
                    ))}
                  </ul>
                )}
                <span className="lbl">Consigne tapée</span>
                <pre className="deliv-prompt mono">{f.instruction}</pre>
                <span className="lbl" id={`${id}-x`}>
                  Extrait collé à Claude, comme donnée (contenu de la forge, non fiable)
                </span>
                <pre className="ci-excerpt mono" aria-labelledby={`${id}-x`} tabIndex={0}>
                  {f.excerpt}
                </pre>
                {f.truncated && (
                  <span className="hint">Journaux coupés : la fin de chaque job est gardée (64 Kio par job, 256 Kio en tout).</span>
                )}
              </>
            )}
          </>
        )}
      </div>
      <div className="mf">
        {sendError ? (
          <span className="err" role="alert">
            {sendError}
          </span>
        ) : (
          <span className="hint" style={{ marginRight: 'auto' }}>
            {blocker ?? ''}
          </span>
        )}
        <button className="btn ghost" onClick={onClose} data-autofocus disabled={busy}>
          Fermer
        </button>
        <button
          className="btn pri"
          disabled={busy || !f || !f.excerpt || blocker !== null}
          title={blocker ?? undefined}
          onClick={() => f && void send(f)}
        >
          {busy ? 'Envoi…' : 'Envoyer l’échec à Claude'}
        </button>
      </div>
      {link && <LinkDialog url={link} onClose={() => setLink(null)} />}
    </Modal>
  )
}
