import type { Profile, Session } from '../../../shared/protocol'
import { formatReset } from '../state/format'
import { quotasByProfile } from '../state/quotas'
import type { ThemeMode } from '../theme'
import { Meter, StatusGlyph, profileClass } from './common'

const THEMES: [ThemeMode, string][] = [
  ['light', 'Clair'],
  ['dark', 'Sombre'],
  ['system', 'Auto'],
]

function QuotaLine({ k, pct, reset }: { k: string; pct: number | null; reset: string | null }) {
  return (
    <>
      <span className="k">{k}</span>
      <span className="v">
        {pct === null ? (
          'inconnu'
        ) : (
          <>
            <Meter pct={pct} label={`Quota ${k}`} /> {Math.round(pct)} %{reset ? ` · reset ${reset}` : ''}
          </>
        )}
      </span>
    </>
  )
}

export function TopBar(props: {
  sessions: Session[]
  profiles: Profile[]
  waitingCount: number
  onNextWaiting: () => void
  themeMode: ThemeMode
  onTheme: (m: ThemeMode) => void
  onNew: () => void
}) {
  const quotas = quotasByProfile(props.sessions, props.profiles)
  return (
    <header className="top">
      <div className="brand">
        <b>DevMaestro</b>
        <span className="ver">v0.1</span>
      </div>
      <div className="quotas" aria-label="Quotas par profil">
        {quotas.map((q) => (
          <div className="quota" key={q.profile} title={`Forfait du profil ${q.profile}`}>
            <span className={`who chip ${profileClass(q.profile, props.profiles)}`}>{q.profile}</span>
            <QuotaLine k="5 h" pct={q.fiveHour?.used_pct ?? null} reset={formatReset(q.fiveHour?.resets_at)} />
            <QuotaLine k="hebdo" pct={q.sevenDay?.used_pct ?? null} reset={formatReset(q.sevenDay?.resets_at)} />
          </div>
        ))}
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
