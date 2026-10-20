import { useState } from 'react'

import type { Profile } from '../../../shared/protocol'
import {
  COLOR_LABELS,
  basename,
  pastDisplayName,
  relativeTime,
  sessionColor,
  sessionDisplayName,
  shortAgo,
  tildify,
} from '../state/format'
import type { PastEntry, ProjectGroup } from '../state/projects'
import { glyphFor } from '../state/status'
import { PathLabel, StatusGlyph, profileClass } from './common'
import { ColorBar } from './SessionIdentity'

export function Sidebar(props: {
  groups: ProjectGroup[]
  past: PastEntry[]
  profiles: Profile[]
  home: string | null
  selectedId: string | null
  onSelect: (id: string) => void
  onResumePast: (p: PastEntry) => Promise<void>
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function resume(p: PastEntry) {
    setBusy(p.claude_session_id)
    setError(null)
    try {
      await props.onResumePast(p)
    } catch (e) {
      setError(`Reprise impossible : ${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <nav className="panel side" aria-label="Projets et sessions">
      <div className="cap">
        <span className="lbl">Projets</span>
        <span className="hint">regroupés par dépôt git</span>
      </div>
      {props.groups.length === 0 && <p className="empty-note">Aucune session pour l’instant.</p>}
      {props.groups.map((g) => {
        const profiles = new Set(g.sessions.map((s) => s.profile))
        const single = profiles.size === 1 ? [...profiles][0]! : null
        return (
          <div className="proj" key={g.key}>
            <div className="proj-h">
              <b title={g.name}>{g.name}</b>
              {single && <span className={`chip ${profileClass(single, props.profiles)}`}>{single}</span>}
              {g.waiting > 0 && (
                <span className="count" aria-label={`${g.waiting} à répondre`}>
                  {g.waiting} ⚠
                </span>
              )}
            </div>
            <PathLabel className="proj-path" path={tildify(g.root, props.home)} title={g.root} />
            <ul role="list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {g.sessions.map((s) => {
                const glyph = glyphFor(s.status)
                const branch = s.branch ?? (s.cwd !== g.root ? basename(s.cwd) : 'sans branche')
                const name = sessionDisplayName(s)
                const color = sessionColor(s)
                return (
                  <li key={s.id}>
                    <button
                      className="srow"
                      aria-current={s.id === props.selectedId}
                      aria-label={`${name}, ${branch}, ${glyph.label}, ${s.profile}${color ? `, couleur ${COLOR_LABELS[color].toLowerCase()}` : ''}, dernière activité ${relativeTime(s.last_activity)}`}
                      title={`${name}\n${branch} · ${s.cwd}`}
                      onClick={() => props.onSelect(s.id)}
                    >
                      <StatusGlyph glyph={glyph} />
                      <span className="names">
                        <span className="nm">
                          <ColorBar color={color} />
                          <span className="nm-t">{name}</span>
                        </span>
                        {branch !== name && <span className="br">{branch}</span>}
                      </span>
                      {!single && <span className={`chip ${profileClass(s.profile, props.profiles)}`}>{s.profile}</span>}
                      <span className="ago">{shortAgo(s.last_activity ?? s.created_at)}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        )
      })}
      <div className="old">
        <div className="cap">
          <span className="lbl">Anciennes sessions</span>
          <span className="hint">à reprendre</span>
        </div>
        {error && (
          <p className="inline-err" role="alert">
            {error}
          </p>
        )}
        {props.past.length === 0 && <p className="empty-note">Aucune ancienne session trouvée.</p>}
        <ul role="list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {props.past.map((p) => {
            const label = pastDisplayName(p)
            const where = p.cwd ? basename(p.cwd) : 'dossier inconnu'
            return (
              <li key={`${p.profile}:${p.claude_session_id}`}>
                <button
                  className="srow"
                  aria-busy={busy === p.claude_session_id}
                  disabled={busy !== null || !p.cwd}
                  title={`${p.cwd ?? 'dossier inconnu'} · profil ${p.profile}${p.first_prompt ? `\n${p.first_prompt}` : ''}`}
                  aria-label={`Reprendre ${where} · ${label}, profil ${p.profile}, ${relativeTime(p.last_timestamp)}`}
                  onClick={() => void resume(p)}
                >
                  <span className="st past" aria-hidden="true" />
                  <span className="br">
                    {where} · {label}
                  </span>
                  <span className="ago">{busy === p.claude_session_id ? 'reprise…' : shortAgo(p.last_timestamp)}</span>
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    </nav>
  )
}
