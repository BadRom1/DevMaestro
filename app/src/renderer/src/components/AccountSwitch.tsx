/**
 * « Changer de compte… » (v0.3, lot 15 ter) : dialogue, état de la bascule
 * dans l'en-tête de la session, invite quand le compte est au plafond, et le
 * crochet qui exécute l'enchaînement (`state/accountSwitch`).
 *
 * L'état vit dans l'app (pas dans l'en-tête, démonté quand on change de
 * session) : « Attendre la fin » peut durer plusieurs minutes.
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'

import type { Profile, Session } from '../../../shared/protocol'
import { call, errorCode, errorText } from '../api'
import {
  busyReason,
  canSwitch,
  VISIBILITY_LIMIT,
  ceilingKey,
  ceilingSuggestion,
  needsTicks,
  originRetryCaveat,
  resumeFailureText,
  switchRisks,
  switchInFlight,
  switchStep,
  switchTargets,
  type SwitchEffect,
  type SwitchEvent,
  type SwitchState,
  type Visibility,
  visibilityIn,
} from '../state/accountSwitch'
import { formatPct, sessionDisplayName } from '../state/format'
import { QUOTA_CRIT_PCT, type QuotaView } from '../state/quotas'
import { useSettings } from '../settings'
import { Meter } from './common'
import { Modal } from './Modal'

/** Pas de l'horloge de la bascule (repos à tenir, délai d'arrêt, nouvel essai). */
const TICK_MS = 250

export interface AccountSwitchApi {
  /** Bascule en cours, par identifiant de session. */
  states: Record<string, SwitchState>
  /** Lance la bascule : `wait` = attendre que Claude soit au repos. */
  start: (session: Session, target: string, wait: boolean) => void
  /** Annule l'attente, ou ferme un échec ou un avertissement. */
  cancel: (id: string) => void
  /** Après un échec : reprendre sous ce profil. */
  resumeAs: (id: string, profile: string) => void
}

/**
 * Exécute les bascules : arrêt, attente de l'arrêt (instantanés reçus par
 * `session.updated`), reprise `{id, profile}`. `onSession` reçoit la session
 * rendue par la reprise (même identifiant : sélection et onglet conservés).
 */
export function useAccountSwitch({
  sessions,
  termSize,
  onSession,
  now = Date.now,
}: {
  sessions: Readonly<Record<string, Session>>
  termSize: { cols: number; rows: number } | null
  onSession: (s: Session) => void
  now?: () => number
}): AccountSwitchApi {
  const [states, setStates] = useState<Record<string, SwitchState>>({})
  const ref = useRef(states)
  const latest = useRef({ sessions, termSize, onSession, now })
  latest.current = { sessions, termSize, onSession, now }

  const stepRef = useRef<(id: string, ev: SwitchEvent) => void>(() => {})
  const run = useCallback((id: string, effect: SwitchEffect) => {
    if (!effect) return
    const step = (ev: SwitchEvent) => stepRef.current(id, ev)
    if (effect.kind === 'stop') {
      call('sessions.stop', { id }).then(
        (r) => step({ type: 'stopSent', alive: r.alive, now: latest.current.now() }),
        (e: unknown) => step({ type: 'stopFailed', message: errorText(e), code: errorCode(e) }),
      )
      return
    }
    call('sessions.resume', { id, profile: effect.profile, ...(latest.current.termSize ?? {}) }).then(
      (r) => {
        latest.current.onSession(r.session)
        step({ type: 'resumed', warnings: r.warnings ?? [] })
      },
      (e: unknown) => step({ type: 'resumeFailed', message: errorText(e), code: errorCode(e), now: latest.current.now() }),
    )
  }, [])

  stepRef.current = (id, ev) => {
    const cur = ref.current[id] ?? null
    const { state, effect } = switchStep(cur, ev)
    if (state !== cur) {
      const next = { ...ref.current }
      if (state) next[id] = state
      else delete next[id]
      ref.current = next
      setStates(next)
    }
    run(id, effect)
  }

  // Instantanés de la session : repos atteint, arrêt constaté, session retirée.
  useEffect(() => {
    for (const id of Object.keys(ref.current)) {
      stepRef.current(id, { type: 'session', session: sessions[id] ?? null, now: latest.current.now() })
    }
  }, [sessions])

  // Horloge, seulement quand une bascule en a besoin.
  const ticking = Object.values(states).some(needsTicks)
  useEffect(() => {
    if (!ticking) return
    const t = setInterval(() => {
      for (const id of Object.keys(ref.current)) stepRef.current(id, { type: 'tick', now: latest.current.now() })
    }, TICK_MS)
    return () => clearInterval(t)
  }, [ticking])

  const start = useCallback((session: Session, target: string, wait: boolean) => {
    stepRef.current(session.id, { type: 'start', session, target, wait, now: latest.current.now() })
  }, [])
  const cancel = useCallback((id: string) => stepRef.current(id, { type: 'cancel' }), [])
  const resumeAs = useCallback((id: string, profile: string) => {
    stepRef.current(id, { type: 'resumeAs', profile, session: latest.current.sessions[id] ?? null, now: latest.current.now() })
  }, [])

  return { states, start, cancel, resumeAs }
}

/** Ce que l'en-tête de la session reçoit de l'app pour la bascule. */
export interface HeaderSwitch {
  state: SwitchState | null
  quotas: readonly QuotaView[]
  open: () => void
  cancel: () => void
  resumeAs: (profile: string) => void
  /** Invite de plafond fermée pour cette clé (`ceilingKey`). */
  ceilingDismissed: (key: string) => boolean
  dismissCeiling: (key: string) => void
}

/** Bouton de l'en-tête : masqué avec un seul profil. */
export function SwitchAccountButton({
  session,
  profiles,
  state,
  onOpen,
}: {
  session: Session
  profiles: readonly Profile[]
  state: SwitchState | null
  onOpen: () => void
}) {
  if (!canSwitch(session, profiles)) return null
  const engaged = switchInFlight(state) || state?.kind === 'waiting'
  return (
    <button
      className="btn sm ghost"
      disabled={engaged}
      title={engaged ? 'Une bascule de compte est déjà en cours' : 'Reprendre cette conversation sous un autre profil Claude Code'}
      onClick={onOpen}
    >
      Changer de compte…
    </button>
  )
}

function QuotaLine({ view }: { view: QuotaView | undefined }) {
  const five = view?.fiveHour?.used_pct
  const seven = view?.sevenDay?.used_pct
  if (typeof five !== 'number' && typeof seven !== 'number') return <span className="hint">quota inconnu</span>
  return (
    <span className="asw-q">
      <span>
        5 h <Meter pct={five} width={48} label="Quota 5 h" /> <b>{formatPct(five)}</b>
      </span>
      <span>
        7 j <Meter pct={seven} width={48} label="Quota 7 jours" /> <b>{formatPct(seven)}</b>
      </span>
    </span>
  )
}

type Lookup = Visibility | 'pending'

/**
 * Visibilité de la conversation sous chaque profil, demandée au démon à
 * l'ouverture du dialogue (`transcripts.list` avec `exclude_known: false` :
 * la session du démon y figure ; masquées comprises).
 */
function useVisibility(claudeSessionId: string | null, profiles: readonly string[], seq: number): Record<string, Lookup> {
  const [vis, setVis] = useState<Record<string, Lookup>>({})
  const key = profiles.join('\u0000')
  useEffect(() => {
    let live = true
    const names = key ? key.split('\u0000') : []
    if (!claudeSessionId) {
      setVis(Object.fromEntries(names.map((n) => [n, 'unknown' as const])))
      return
    }
    setVis(Object.fromEntries(names.map((n) => [n, 'pending' as const])))
    for (const profile of names) {
      call('transcripts.list', { profile, limit: VISIBILITY_LIMIT, include_hidden: true, exclude_known: false }).then(
        (r) => live && setVis((v) => ({ ...v, [profile]: visibilityIn(claudeSessionId, r.sessions) })),
        () => live && setVis((v) => ({ ...v, [profile]: 'unknown' })),
      )
    }
    return () => {
      live = false
    }
  }, [claudeSessionId, key, seq])
  return vis
}

const settled = (v: Lookup | undefined): Visibility => (v === 'pending' || !v ? 'unknown' : v)

/** Dialogue : profil cible (avec sa jauge), ce qui va se passer, risques connus, attente du repos si Claude travaille. */
export function AccountSwitchDialog({
  session,
  profiles,
  quotas,
  onStart,
  onClose,
}: {
  session: Session
  profiles: readonly Profile[]
  quotas: readonly QuotaView[]
  onStart: (target: string, wait: boolean) => void
  onClose: () => void
}) {
  const { label } = useSettings()
  const targets = switchTargets(session, profiles)
  const [target, setTarget] = useState<string>(() => targets[0]?.name ?? '')
  const [confirm, setConfirm] = useState(false)
  const [seq, setSeq] = useState(0)
  const started = useRef(false)
  const legendId = useId()
  const vis = useVisibility(session.claude_session_id, [session.profile, ...targets.map((p) => p.name)], seq)
  const checking = vis[session.profile] === 'pending' || (!!target && vis[target] === 'pending')
  const reason = busyReason(session)
  const targetLabel = target ? label(target).long : ''
  const originLabel = label(session.profile).long
  const risks = switchRisks(session, settled(vis[session.profile]), settled(target ? vis[target] : undefined))
  // Pas de transcript : arrêter la session la perdrait sans reprise possible (sauf déjà arrêtée).
  const blocked = session.alive && risks.noTranscript === 'sure' && !checking
  const risky = risks.noTranscript === 'likely' || risks.targetBlind || risks.dangerous
  const name = sessionDisplayName(session)

  // Le pied du dialogue change de forme : le focus va au premier bouton présent s'il a été perdu.
  const foot = useRef<HTMLDivElement>(null)
  const shape = `${blocked}|${!!reason}|${confirm}|${risky}`
  const firstShape = useRef(shape)
  useEffect(() => {
    if (shape === firstShape.current) return
    firstShape.current = shape
    const el = document.activeElement
    if (!el || el === document.body || !el.isConnected || foot.current?.contains(el)) {
      foot.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus()
    }
  }, [shape])

  function go(wait: boolean) {
    if (started.current || !target) return
    started.current = true
    onStart(target, wait)
  }

  const warn = (key: string, text: ReactNode) => (
    <p key={key} className="hint warn" role="note" style={{ margin: 0 }}>
      <span aria-hidden="true">⚠ </span>
      {text}
    </p>
  )

  return (
    <Modal title="Changer de compte" onClose={onClose} width={560}>
      <div className="mb">
        <p style={{ margin: 0 }}>
          Session « {name} », actuellement sous le profil <b>{originLabel}</b>.
        </p>
        <fieldset className="asw-list" aria-labelledby={legendId}>
          <legend id={legendId}>Profil cible</legend>
          {targets.map((p) => (
            <label key={p.name} className="asw-opt">
              <input
                type="radio"
                name={`asw-${session.id}`}
                value={p.name}
                data-autofocus={p.name === targets[0]?.name ? true : undefined}
                checked={target === p.name}
                onChange={() => {
                  setTarget(p.name)
                  setConfirm(false)
                }}
              />
              <span className="asw-n" title={`Profil Claude Code ${label(p.name).long} (${p.name})`}>
                {label(p.name).long}
              </span>
              {vis[p.name] === 'absent' && risks.noTranscript === null && <span className="chip pend">ne voit pas la conversation</span>}
              <QuotaLine view={quotas.find((q) => q.profile === p.name)} />
            </label>
          ))}
        </fieldset>
        {target && (
          <p style={{ margin: 0 }}>
            {session.alive
              ? `La session va être arrêtée puis reprise sous ${targetLabel} ; la conversation continue (même dossier, même onglet).`
              : `La session va être reprise sous ${targetLabel} ; la conversation continue (même dossier, même onglet).`}
          </p>
        )}
        {checking && (
          <p className="hint" role="status" style={{ margin: 0 }}>
            <span className="spin" aria-hidden="true" /> Vérification de la conversation sous chaque profil…
          </p>
        )}
        {risks.noTranscript === 'sure' &&
          warn(
            'nt',
            <>
              Cette conversation n’a pas encore de transcript (aucun échange terminé) : Claude Code ne pourra la reprendre
              sous aucun profil, {originLabel} compris.
              {session.alive ? ' Attends la fin d’un premier échange, puis « Vérifier à nouveau ».' : ''}
            </>,
          )}
        {risks.noTranscript === 'likely' &&
          warn('ntl', `Aucun premier prompt connu : la conversation n’a peut-être pas encore de transcript, et la reprise échouerait alors sous tout profil, ${originLabel} compris.`)}
        {risks.targetBlind &&
          warn('tb', `Le profil ${targetLabel} ne voit pas cette conversation (dossier projects/ distinct ?) : la reprise échouera${session.alive ? ', après l’arrêt de la session' : ''}.`)}
        {risks.dangerous &&
          warn(
            'dm',
            `La session est en mode « ${session.mode} » : le démon refuse de la reprendre dans ce mode sauf si allow_dangerous_modes = true dans sa configuration ; sinon la reprise échouera, sous ${originLabel} aussi.`,
          )}
        {reason && (
          <p className="hint warn" role="status" style={{ margin: 0 }}>
            <span aria-hidden="true">● </span>
            Claude travaille : {reason}.
          </p>
        )}
        {confirm && (
          <p className="asw-confirm" role="alert" style={{ margin: 0 }}>
            {reason
              ? `Changer maintenant interrompt le travail en cours : la réponse ou l’outil en cours sera coupé${session.pending.length ? ', la demande en attente restera sans réponse' : ''}. `
              : ''}
            {risky ? 'La reprise risque d’échouer (voir ci-dessus) : la session resterait arrêtée. ' : ''}
            Confirmer ?
          </p>
        )}
      </div>
      <div className="mf" ref={foot}>
        <span style={{ marginRight: 'auto' }} />
        {blocked ? (
          <>
            <button className="btn ghost" onClick={onClose}>
              Annuler
            </button>
            <button className="btn" onClick={() => setSeq((n) => n + 1)}>
              Vérifier à nouveau
            </button>
          </>
        ) : confirm ? (
          <>
            <button className="btn ghost" onClick={() => setConfirm(false)}>
              Retour
            </button>
            <button className="btn danger" disabled={!target} onClick={() => go(false)}>
              {reason ? 'Interrompre et changer' : 'Changer quand même'}
            </button>
          </>
        ) : reason ? (
          <>
            <button className="btn ghost" onClick={onClose}>
              Annuler
            </button>
            <button className="btn warn" disabled={!target || checking} onClick={() => setConfirm(true)}>
              Changer maintenant…
            </button>
            <button className="btn pri" disabled={!target || checking} onClick={() => go(true)}>
              Attendre la fin
            </button>
          </>
        ) : (
          <>
            <button className="btn ghost" onClick={onClose}>
              Annuler
            </button>
            {risky ? (
              <button className="btn warn" disabled={!target || checking} onClick={() => setConfirm(true)}>
                Changer quand même…
              </button>
            ) : (
              <button className="btn pri" disabled={!target || checking} onClick={() => go(false)}>
                Changer de compte
              </button>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}

/** État de la bascule, dans l'en-tête de la session (attente, arrêt, reprise, échec, avertissements). */
export function SwitchStatus({
  session,
  state,
  onCancel,
  onResumeAs,
}: {
  session: Session
  state: SwitchState | null
  onCancel: () => void
  onResumeAs: (profile: string) => void
}) {
  const { label } = useSettings()
  if (!state) return null
  const t = label(state.kind === 'resuming' || state.kind === 'failed' ? state.profile : state.target).long
  switch (state.kind) {
    case 'waiting':
      return (
        <span className="asw-st" role="status">
          <span className="spin" aria-hidden="true" />
          Bascule vers {t} dès que Claude aura fini
          {state.reason ? ` (${state.reason})` : ''}
          <button className="btn sm ghost" onClick={onCancel}>
            Annuler la bascule
          </button>
        </span>
      )
    case 'stopping':
      return (
        <span className="asw-st" role="status">
          <span className="spin" aria-hidden="true" /> Bascule vers {t} : arrêt de la session…
        </span>
      )
    case 'resuming':
      return (
        <span className="asw-st" role="status">
          <span className="spin" aria-hidden="true" /> Bascule : reprise sous {t}…
        </span>
      )
    case 'done':
      return (
        <span className="asw-st" role="status">
          Reprise sous {t}, avec un avertissement : {state.warnings.join(' ; ')}
          <button className="btn sm ghost" onClick={onCancel}>
            Fermer
          </button>
        </span>
      )
    case 'interrupted':
      return (
        <span className="asw-st" role="status">
          <span aria-hidden="true">■ </span>
          {session.alive
            ? `La session a redémarré pendant l’attente : bascule vers ${t} abandonnée.`
            : `La session s’est arrêtée pendant l’attente : bascule vers ${t} suspendue, rien n’a été repris.`}
          {!session.alive && (
            <button className="btn sm" onClick={() => onResumeAs(state.target)}>
              Reprendre sous {t}
            </button>
          )}
          <button className="btn sm ghost" onClick={onCancel}>
            Fermer
          </button>
        </span>
      )
    case 'failed': {
      // D'après l'instantané (une réponse perdue ne dit rien de l'état réel), pas d'après l'étape.
      const stopped = !session.alive
      const origin = label(state.origin).long
      const why = state.step === 'resume' ? resumeFailureText(state.code, state.message, t) : state.message
      const text = stopped
        ? `La session est arrêtée ; la bascule vers ${t} a échoué : ${why}. ${originRetryCaveat(state.code, origin)}`
        : `Bascule vers ${t} impossible : ${why} ; la session tourne toujours sous ${label(session.profile).long}.`
      return (
        <span className="asw-st bad" role="alert">
          <span aria-hidden="true">× </span>
          {text}
          {stopped && (
            <button className="btn sm" onClick={() => onResumeAs(state.origin)}>
              Reprendre sous {origin}
            </button>
          )}
          {stopped && state.profile !== state.origin && (
            <button className="btn sm ghost" onClick={() => onResumeAs(state.profile)}>
              Réessayer sous {t}
            </button>
          )}
          <button className="btn sm ghost" onClick={onCancel}>
            Fermer
          </button>
        </span>
      )
    }
  }
}

/**
 * Zone de la bascule dans l'en-tête, focalisable (`tabIndex=-1`) : quand le
 * bouton qui avait le focus disparaît ou se désactive (fermeture du dialogue,
 * « Annuler la bascule », « Fermer »), le focus y revient au lieu de se perdre.
 */
export function SwitchArea({ state, children }: { state: SwitchState | null; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const kind = state?.kind ?? null
  const prev = useRef(kind)
  useEffect(() => {
    if (prev.current === kind) return
    prev.current = kind
    const a = document.activeElement
    const lost = !a || a === document.body || !a.isConnected || (a instanceof HTMLButtonElement && a.disabled)
    if (lost) ref.current?.focus()
  }, [kind])
  return (
    <div ref={ref} className="sh-asw" tabIndex={-1} aria-label="Changer de compte">
      {children}
    </div>
  )
}

/** Invite discrète quand le compte de la session est au plafond : ouvre le dialogue, ne bascule jamais seule ; fermable. */
export function CeilingHint({
  session,
  profiles,
  quotas,
  state,
  dismissed,
  onDismiss,
  onOpen,
}: {
  session: Session
  profiles: readonly Profile[]
  quotas: readonly QuotaView[]
  state: SwitchState | null
  dismissed: (key: string) => boolean
  onDismiss: (key: string) => void
  onOpen: () => void
}) {
  const { label } = useSettings()
  const c = ceilingSuggestion(session, profiles, quotas)
  if (!c || state) return null
  const key = ceilingKey(session.id, session.profile, c)
  if (dismissed(key)) return null
  const who = label(session.profile).long
  const level = c.pct >= 100 ? 'au plafond' : `presque au plafond (≥ ${QUOTA_CRIT_PCT} %)`
  return (
    <span className="asw-hint-wrap">
      <button className="asw-hint" onClick={onOpen} title={`Quota ${c.window} du profil ${who} à ${formatPct(c.pct)}`}>
        <span aria-hidden="true">⚠ </span>
        Compte {who} {level} — {c.window} : {formatPct(c.pct)} — Changer de compte…
      </button>
      <button className="asw-hint-x" aria-label={`Masquer l’invite « compte ${who} ${level} »`} title="Masquer jusqu’au prochain changement de quota" onClick={() => onDismiss(key)}>
        ×
      </button>
    </span>
  )
}
