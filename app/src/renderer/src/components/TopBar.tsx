import { useEffect, useRef, useState } from 'react'

import type { DaemonProfileQuota, Profile, Session } from '../../../shared/protocol'
import { errorText } from '../api'
import { formatReset, relativeTime } from '../state/format'
import {
  QUOTA_REFRESH_MS,
  quotaViews,
  refreshSettled,
  sourceLabel,
  type QuotaView,
  type WindowMeta,
} from '../state/quotas'
import type { ThemeMode } from '../theme'
import { Meter, StatusGlyph, profileClass } from './common'

const THEMES: [ThemeMode, string][] = [
  ['light', 'Clair'],
  ['dark', 'Sombre'],
  ['system', 'Auto'],
]

function metaText(meta: WindowMeta | null): string | undefined {
  if (!meta) return undefined
  const parts = [sourceLabel(meta.source) && `source : ${sourceLabel(meta.source)}`, meta.fetchedAt && `relevé ${relativeTime(meta.fetchedAt)}`]
  const t = parts.filter(Boolean).join(' · ')
  return t || undefined
}

function QuotaLine({
  k,
  pct,
  reset,
  error,
  meta,
}: {
  k: string
  pct: number | null
  reset: string | null
  error: string | null
  meta: WindowMeta | null
}) {
  return (
    <>
      <span className="k">{k}</span>
      <span className="v" title={pct === null ? undefined : metaText(meta)}>
        {pct === null ? (
          <span title={error ? `Inconnu : ${error}` : 'Aucune mesure pour l’instant'}>
            inconnu{error && <span className="sr-only"> ({error})</span>}
          </span>
        ) : (
          <>
            <Meter pct={pct} label={`Quota ${k}`} /> {Math.round(pct)} %{reset ? ` · reset ${reset}` : ''}
          </>
        )}
      </span>
    </>
  )
}

function quotaTitle(q: QuotaView): string {
  const parts = [`Forfait du profil ${q.profile}`]
  if (q.source) parts.push(`source : ${sourceLabel(q.source)}`)
  if (q.fetchedAt) parts.push(`relevé ${relativeTime(q.fetchedAt)}`)
  if (q.error) parts.push(`erreur : ${q.error}`)
  return parts.join(' · ')
}

/**
 * Bouton « actualiser les quotas » (`quotas.get {refresh: true}`). Le démon
 * répond tout de suite avec l'instantané courant ; l'indicateur reste jusqu'au
 * `quotas.updated` de chaque profil affiché, ou 15 s.
 */
function RefreshQuotas({
  onRefresh,
  seq,
  profiles,
}: {
  onRefresh: () => Promise<void>
  seq: Record<string, number>
  profiles: string[]
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const before = useRef<Record<string, number> | null>(null)
  const waitFor = useRef<string[]>([])

  // Valeurs fraîches reçues pour chaque profil : fin de l'attente.
  useEffect(() => {
    if (busy && before.current && refreshSettled(before.current, seq, waitFor.current)) setBusy(false)
  }, [busy, seq])

  useEffect(() => {
    if (!busy) return
    const t = setTimeout(() => setBusy(false), QUOTA_REFRESH_MS)
    return () => clearTimeout(t)
  }, [busy])

  return (
    <span className="qrefresh">
      <button
        className="btn sm ghost"
        aria-label="Actualiser les quotas"
        title={error ? `Actualisation impossible : ${error}` : 'Actualiser les quotas'}
        aria-busy={busy}
        disabled={busy}
        onClick={() => {
          before.current = { ...seq }
          waitFor.current = profiles
          setBusy(true)
          setError(null)
          onRefresh().catch((e: unknown) => {
            setError(errorText(e))
            setBusy(false)
          })
        }}
      >
        <span className={busy ? 'spin' : undefined} aria-hidden="true">
          {busy ? '' : '↻'}
        </span>
      </button>
      {error && (
        <span className="inline-err" role="alert">
          Actualisation impossible
        </span>
      )}
    </span>
  )
}

export function TopBar(props: {
  sessions: Session[]
  profiles: Profile[]
  /** Quotas du démon (`null` : inconnus, ou démon plus ancien). */
  daemonQuotas: Record<string, DaemonProfileQuota> | null
  /** Nombre de `quotas.updated` reçus par profil. */
  quotasSeq: Record<string, number>
  /** `null` : le démon ne sait pas actualiser les quotas. */
  onRefreshQuotas: (() => Promise<void>) | null
  waitingCount: number
  onNextWaiting: () => void
  themeMode: ThemeMode
  onTheme: (m: ThemeMode) => void
  onNew: () => void
}) {
  const quotas = quotaViews(props.sessions, props.profiles, props.daemonQuotas)
  return (
    <header className="top">
      <div className="brand">
        <b>DevMaestro</b>
        <span className="ver">v0.1</span>
      </div>
      <div className="quotas" aria-label="Quotas par profil">
        {quotas.map((q) => (
          <div className="quota" key={q.profile} title={quotaTitle(q)}>
            <span className={`who chip ${profileClass(q.profile, props.profiles)}`}>{q.profile}</span>
            <QuotaLine k="5 h" pct={q.fiveHour?.used_pct ?? null} reset={formatReset(q.fiveHour?.resets_at)} error={q.error} meta={q.fiveHourMeta} />
            <QuotaLine k="hebdo" pct={q.sevenDay?.used_pct ?? null} reset={formatReset(q.sevenDay?.resets_at)} error={q.error} meta={q.sevenDayMeta} />
          </div>
        ))}
        {props.onRefreshQuotas && quotas.length > 0 && (
          <RefreshQuotas
            onRefresh={props.onRefreshQuotas}
            seq={props.quotasSeq}
            profiles={Object.keys(props.daemonQuotas ?? {}).length ? Object.keys(props.daemonQuotas ?? {}) : quotas.map((q) => q.profile)}
          />
        )}
      </div>
      <span className="spacer" />
      {props.waitingCount > 0 && (
        <button
          className="pill-wait"
          onClick={props.onNextWaiting}
          title="Aller à la première session qui attend une réponse"
        >
          <StatusGlyph glyph={{ kind: 'waiting', label: 'À répondre' }} /> {props.waitingCount} à répondre
        </button>
      )}
      <div className="seg" role="group" aria-label="Thème">
        {THEMES.map(([m, label]) => (
          <button key={m} aria-pressed={props.themeMode === m} onClick={() => props.onTheme(m)}>
            {label}
          </button>
        ))}
      </div>
      <button className="btn pri" onClick={props.onNew}>
        + Nouvelle session
      </button>
    </header>
  )
}
