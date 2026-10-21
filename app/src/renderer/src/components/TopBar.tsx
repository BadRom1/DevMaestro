import { useEffect, useRef, useState } from 'react'

import { t as tr, type PlainKey, type Translate } from '../../../shared/i18n'
import type { DaemonProfileQuota, Profile, Session } from '../../../shared/protocol'
import { errorText } from '../api'
import { useT } from '../i18n'
import { useSettings } from '../settings'
import { daemonText } from '../state/errors'
import { formatReset, relativeTime } from '../state/format'
import {
  QUOTA_REFRESH_MS,
  quotaViews,
  refreshSettled,
  sourceLabel,
  type QuotaView,
  type WindowMeta,
} from '../state/quotas'
import type { MainView } from '../../../shared/settings'
import type { ThemeMode } from '../theme'
import { Meter, ProfileChip, StatusGlyph } from './common'

/** Couple (mode, libellé) dont le libellé est lu dans la langue courante à chaque accès. */
function themeEntry(mode: ThemeMode, key: PlainKey): [ThemeMode, string] {
  const entry: [ThemeMode, string] = [mode, '']
  Object.defineProperty(entry, 1, { get: () => tr(key), enumerable: true })
  return entry
}

/** Mêmes libellés que dans les Réglages (`SettingsDialog`) ; libellés calculés à l'accès. */
export const THEMES: [ThemeMode, string][] = [
  themeEntry('light', 'shell.theme.light'),
  themeEntry('dark', 'shell.theme.dark'),
  themeEntry('system', 'shell.theme.system'),
]

/** Titre du mode « Auto », dans la langue courante. */
export function autoTitle(): string {
  return tr('shell.theme.autoTitle')
}

function metaText(meta: WindowMeta | null, t: Translate): string | undefined {
  if (!meta) return undefined
  const source = sourceLabel(meta.source)
  const parts = [source && t('shell.quota.source', { source }), meta.fetchedAt && t('shell.quota.fetched', { when: relativeTime(meta.fetchedAt) })]
  const text = parts.filter(Boolean).join(' · ')
  return text || undefined
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
  const t = useT()
  return (
    <>
      <span className="k">{k}</span>
      <span
        className="v"
        title={pct === null ? undefined : [reset && t('shell.quota.reset', { reset }), metaText(meta, t)].filter(Boolean).join(' · ') || undefined}
      >
        {pct === null ? (
          <span title={error ? t('shell.quota.unknownError', { error }) : t('shell.quota.noMeasure')}>
            {t('shell.quota.unknown')}
            {error && <span className="sr-only"> ({error})</span>}
          </span>
        ) : (
          <>
            <Meter pct={pct} label={t('shell.quota.meter', { k })} /> {t('shell.quota.pct', { n: Math.round(pct) })}
            {reset && <span className="q-reset"> · {t('shell.quota.reset', { reset })}</span>}
          </>
        )}
      </span>
    </>
  )
}

function quotaTitle(q: QuotaView, label: string, t: Translate): string {
  const parts = [t('shell.quota.plan', { label, profile: q.profile })]
  if (q.source) parts.push(t('shell.quota.source', { source: sourceLabel(q.source) }))
  if (q.fetchedAt) parts.push(t('shell.quota.fetched', { when: relativeTime(q.fetchedAt) }))
  if (q.error) parts.push(t('shell.quota.error', { error: daemonText(q.error) }))
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
  const t = useT()
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
    const timer = setTimeout(() => setBusy(false), QUOTA_REFRESH_MS)
    return () => clearTimeout(timer)
  }, [busy])

  return (
    <span className="qrefresh">
      <button
        className="btn sm ghost"
        aria-label={t('shell.quota.refresh')}
        title={error ? t('shell.quota.refreshFailedDetail', { error }) : t('shell.quota.refresh')}
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
          {t('shell.quota.refreshFailed')}
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
  onSettings: () => void
  view: MainView
  onView: (v: MainView) => void
}) {
  const t = useT()
  const { label: labelOf } = useSettings()
  const quotas = quotaViews(props.sessions, props.profiles, props.daemonQuotas)
  return (
    <header className="top">
      {/* Trois groupes qui passent à la ligne d'un bloc (zoom, fenêtre étroite) : marque et quotas, vue, actions. */}
      <div className="top-g top-main">
        <div className="brand">
          {/* i18n-exempt: nom propre du produit */}
          <b>DevMaestro</b>
          <span className="ver">v0.1</span>
        </div>
        <div className="quotas" aria-label={t('shell.quota.byProfile')}>
          {quotas.map((q) => (
            <div className="quota" key={q.profile} title={quotaTitle(q, labelOf(q.profile).long, t)}>
              <ProfileChip profile={q.profile} profiles={props.profiles} className="who" />
              <QuotaLine k={t('shell.quota.fiveHour')} pct={q.fiveHour?.used_pct ?? null} reset={formatReset(q.fiveHour?.resets_at)} error={q.error && daemonText(q.error)} meta={q.fiveHourMeta} />
              <QuotaLine k={t('shell.quota.weekly')} pct={q.sevenDay?.used_pct ?? null} reset={formatReset(q.sevenDay?.resets_at)} error={q.error && daemonText(q.error)} meta={q.sevenDayMeta} />
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
      </div>
      <div className="seg" role="group" aria-label={t('shell.topbar.view')}>
        <button aria-pressed={props.view === 'projet'} onClick={() => props.onView('projet')}>
          {t('shell.topbar.byProject')}
        </button>
        <button aria-pressed={props.view === 'statut'} onClick={() => props.onView('statut')}>
          {t('shell.topbar.byStatus')}
        </button>
      </div>
      <span className="spacer" />
      <div className="top-g top-acts">
        {props.waitingCount > 0 && (
          <button
            className="pill-wait"
            onClick={props.onNextWaiting}
            title={t('shell.topbar.nextWaitingTitle')}
          >
            <StatusGlyph glyph={{ kind: 'waiting', label: t('shell.kanban.column.waiting') }} />{' '}
            {t('shell.topbar.waitingCount', { count: props.waitingCount })}
          </button>
        )}
        <div className="seg" role="group" aria-label={t('shell.theme.label')}>
          {THEMES.map(([m, label]) => (
            <button
              key={m}
              aria-pressed={props.themeMode === m}
              title={m === 'system' ? autoTitle() : undefined}
              onClick={() => props.onTheme(m)}
            >
              {label}
            </button>
          ))}
        </div>
        <button className="btn" onClick={props.onSettings}>
          {t('shell.topbar.settings')}
        </button>
        <button className="btn pri" onClick={props.onNew}>
          {t('shell.topbar.newSession')}
        </button>
      </div>
    </header>
  )
}
