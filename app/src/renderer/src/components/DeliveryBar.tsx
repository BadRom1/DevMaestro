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
 *   l'échec à Claude » tape la consigne `ciFailure` des réglages (lot 18 ;
 *   plus celle du démon) et **colle** l'extrait comme donnée
 *   (`sessions.sendPrompt {instruction, pasted}`), jamais comme consigne.
 */
import { useEffect, useId, useState } from 'react'

import type { Session, SessionCi } from '../../../shared/protocol'
import { ORIGIN_LABELS, renderPrompt, resolvePrompt, type PromptOrigin } from '../../../shared/prompts'
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
  deliveryPromptId,
  failedRuns,
  primaryAction,
  runLabel,
  sessionCiErrorKind,
  sessionCiOf,
  type DeliveryAction,
} from '../state/delivery'
import type { RunFailure } from '../../../shared/protocol'
import { useI18n, useT } from '../i18n'
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
  const t = useT()
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
  const modeName = pd.mode === 'trunk' ? 'trunk-based' : 'PR' // i18n-exempt: noms de modes techniques
  const button = (a: DeliveryAction, pri: boolean) => {
    const blocker = deliveryBlocker(session, a, state, pullNumber)
    return (
      <button
        key={a}
        type="button"
        className={`btn sm${pri ? ' pri' : ' ghost'}`}
        disabled={blocker !== null}
        title={blocker ?? t('forge.delivery.bar.buttonTitle', { mode: modeName })}
        onClick={() => setConfirm(a)}
      >
        {actionLabel(a, base)}…
      </button>
    )
  }
  return (
    <div className="sh-deliv" role="group" aria-label={t('forge.delivery.bar.label')}>
      {badge && <ForgeBadge b={badge} className="sm" />}
      {ciB && <ForgeBadge b={ciB} className="sm" />}
      {failed.length > 0 && (
        <button type="button" className="btn sm ghost" onClick={() => setFailure(true)}>
          {t('forge.delivery.bar.seeFailure')}
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
          prompt={resolvePrompt(settings.prompts, deliveryPromptId(confirm), projectKey)}
          base={base}
          onClose={() => setConfirm(null)}
          onSent={reload}
        />
      )}
      {failure && (
        <CiFailureDialog
          session={session}
          root={root}
          runs={failed}
          template={resolvePrompt(settings.prompts, 'ciFailure', projectKey).template}
          onClose={() => setFailure(false)}
        />
      )}
    </div>
  )
}

function DeliveryConfirm({
  session,
  action,
  prompt: { template, origin },
  base,
  onClose,
  onSent,
}: {
  session: Session
  action: DeliveryAction
  /** Modèle effectif du projet et son origine (Réglages → Consignes). */
  prompt: { template: string; origin: PromptOrigin }
  base: string | null
  onClose: () => void
  onSent: () => void
}) {
  const { t, rich } = useI18n()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const id = useId()
  const prompt = deliveryPrompt(action, template, session, base)
  async function send() {
    if (!('text' in prompt)) return
    setBusy(true)
    setError(null)
    try {
      await call('sessions.sendPrompt', { id: session.id, text: prompt.text })
      onSent()
      onClose()
    } catch (e) {
      setError(t('forge.delivery.sendFailed', { error: errorText(e) }))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal title={t('forge.delivery.confirm.title', { action: actionLabel(action, base) })} onClose={onClose} width={640} busy={busy}>
      <div className="mb">
        <p style={{ margin: 0 }}>
          {rich('forge.delivery.confirm.intro', { typed: <b>{t('forge.delivery.confirm.typed')}</b> })}
        </p>
        {'text' in prompt ? (
          <>
            <span className="lbl" id={`${id}-l`}>
              {t('forge.delivery.confirm.sentLabel')}
            </span>
            <pre className="deliv-prompt mono" aria-labelledby={`${id}-l`}>
              {prompt.text}
            </pre>
            <span className="hint">{t('forge.delivery.confirm.templateHint', { origin: ORIGIN_LABELS[origin] })}</span>
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
          {t('forge.delivery.confirm.cancel')}
        </button>
        <button className="btn pri" disabled={busy || !('text' in prompt)} onClick={() => void send()}>
          {busy ? t('forge.delivery.sending') : t('forge.delivery.confirm.send')}
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
  template,
  onClose,
}: {
  session: Session
  root: string
  runs: SessionCi['ci']['runs']
  /** Modèle de la consigne `ciFailure` du projet (lot 18). */
  template: string
  onClose: () => void
}) {
  const t = useT()
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
    ? t('forge.delivery.failure.notAlive')
    : session.status.state === 'waiting' || session.pending.length > 0
      ? t('forge.delivery.blocker.pending')
      : null
  /** Consigne tapée : le modèle des réglages, rendu (jamais l'`instruction` du démon, ni un texte de la forge). */
  let instruction: { text: string } | { error: string }
  try {
    instruction = { text: renderPrompt('ciFailure', template, { branch: session.branch ?? null, run: runId }) }
  } catch (e) {
    instruction = { error: t('forge.delivery.invalidTemplate', { message: (e as Error).message }) }
  }
  async function send(f: RunFailure) {
    if (!f.excerpt || !('text' in instruction)) return
    setBusy(true)
    setSendError(null)
    try {
      await call('sessions.sendPrompt', { id: session.id, instruction: instruction.text, pasted: f.excerpt })
      onClose()
    } catch (e) {
      setSendError(t('forge.delivery.sendFailed', { error: errorText(e) }))
    } finally {
      setBusy(false)
    }
  }
  const f = state.phase === 'ready' ? state.f : null
  return (
    <Modal title={t('forge.delivery.failure.title')} onClose={onClose} width={820} busy={busy}>
      <div className="mb">
        {runs.length > 1 && (
          <label className="wtrow">
            <span>{t('forge.delivery.failure.run')}</span>
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
            <span className="spin" aria-hidden="true" /> {t('forge.delivery.failure.loading')}
          </p>
        )}
        {state.phase === 'error' && (
          <p className="inline-err" role="alert">
            {t('forge.delivery.failure.unreadable', { error: state.message })}
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
                    {t('forge.delivery.failure.viewOnForge')}
                  </button>
                </>
              )}
            </p>
            {f.in_progress ? (
              <p className="hint">{t('forge.delivery.failure.inProgress')}</p>
            ) : (
              <>
                <span className="lbl">{t('forge.delivery.failure.failedJobs')}</span>
                {f.failed_jobs.length === 0 ? (
                  <p className="hint">{t('forge.delivery.failure.noFailedJobs')}</p>
                ) : (
                  <ul className="ci-jobs">
                    {f.failed_jobs.map((j) => (
                      <li key={j.name}>
                        <span aria-hidden="true">✗</span> <b>{j.name}</b>
                        {j.failed_steps.length > 0 && (
                          <span className="hint">
                            {t('forge.delivery.failure.steps', {
                              count: j.failed_steps.length,
                              steps: j.failed_steps.join(t('forge.delivery.failure.stepSeparator')),
                            })}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                <span className="lbl">{t('forge.delivery.failure.typedInstruction')}</span>
                {'text' in instruction ? (
                  <pre className="deliv-prompt mono">{instruction.text}</pre>
                ) : (
                  <p className="inline-err" role="alert">
                    {instruction.error}
                  </p>
                )}
                <span className="lbl" id={`${id}-x`}>
                  {t('forge.delivery.failure.excerptLabel')}
                </span>
                <pre className="ci-excerpt mono" aria-labelledby={`${id}-x`} tabIndex={0}>
                  {f.excerpt}
                </pre>
                {f.truncated && (
                  <span className="hint">{t('forge.delivery.failure.truncated')}</span>
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
          {t('forge.delivery.failure.close')}
        </button>
        <button
          className="btn pri"
          disabled={busy || !f || !f.excerpt || blocker !== null || !('text' in instruction)}
          title={blocker ?? undefined}
          onClick={() => f && void send(f)}
        >
          {busy ? t('forge.delivery.sending') : t('forge.delivery.failure.send')}
        </button>
      </div>
      {link && <LinkDialog url={link} onClose={() => setLink(null)} />}
    </Modal>
  )
}
