import { useCallback, useId, useState, type ReactNode } from 'react'

import type { Profile, Session } from '../../../shared/protocol'
import { errorText } from '../api'
import { PAST_SECTION, browserStorage, loadCollapsed, saveCollapsed, toggleCollapsed } from '../state/collapse'
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
import { RESOLVING_GROUP, type PastEntry, type PastGroup, type ProjectGroup } from '../state/projects'
import { glyphFor } from '../state/status'
import { PathLabel, StatusGlyph, profileClass } from './common'
import { ForgetConfirm, HideConfirm } from './ForgetConfirm'
import { ColorBar } from './SessionIdentity'

/** Groupes et sections repliés, retenus dans `localStorage`. */
function useCollapsed() {
  const [keys, setKeys] = useState(() => loadCollapsed(browserStorage()))
  const toggle = useCallback((key: string) => {
    setKeys((prev) => {
      const next = toggleCollapsed(prev, key)
      saveCollapsed(browserStorage(), next)
      return next
    })
  }, [])
  return { isCollapsed: (key: string) => keys.has(key), toggle }
}

function Chevron({ open }: { open: boolean }) {
  return (
    <span className="chev" aria-hidden="true">
      {open ? '▾' : '▸'}
    </span>
  )
}

/** Groupe repliable : en-tête bouton (nom, extras), chemin tronqué par le début, liste. */
function Group({
  name,
  path,
  title,
  open,
  onToggle,
  extra,
  children,
}: {
  name: string
  path: string | null
  title?: string
  open: boolean
  onToggle: () => void
  extra?: ReactNode
  children: ReactNode
}) {
  const listId = useId()
  return (
    <div className="proj">
      <button className="proj-h" aria-expanded={open} aria-controls={listId} onClick={onToggle} title={title ?? name}>
        <Chevron open={open} />
        <b>{name}</b>
        {extra}
      </button>
      {path && <PathLabel className="proj-path" path={path} title={title} />}
      <ul id={listId} role="list" className="rows" hidden={!open}>
        {children}
      </ul>
    </div>
  )
}

export function Sidebar(props: {
  groups: ProjectGroup[]
  past: PastEntry[]
  pastGroups: PastGroup[]
  profiles: Profile[]
  home: string | null
  selectedId: string | null
  onSelect: (id: string) => void
  onResumePast: (p: PastEntry) => Promise<void>
  onForget: (id: string) => Promise<void>
  onHidePast: (p: PastEntry) => Promise<void>
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Entrée dont la confirmation est ouverte : `id` d'une session ou `profil:claude_session_id`. */
  const [confirm, setConfirm] = useState<string | null>(null)
  // Repli du groupe d'attente : en mémoire seulement (il est provisoire).
  const [resolvingOpen, setResolvingOpen] = useState(true)
  const { isCollapsed, toggle } = useCollapsed()
  const pastOpen = !isCollapsed(PAST_SECTION)
  const pastListId = useId()

  async function resume(p: PastEntry) {
    setBusy(p.claude_session_id)
    setError(null)
    try {
      await props.onResumePast(p)
    } catch (e) {
      setError(`Reprise impossible : ${errorText(e)}`)
    } finally {
      setBusy(null)
    }
  }

  function sessionRow(s: Session, groupRoot: string) {
    const glyph = glyphFor(s.status)
    const branch = s.branch ?? (s.cwd !== groupRoot ? basename(s.cwd) : 'sans branche')
    const name = sessionDisplayName(s)
    const color = sessionColor(s)
    const forgettable = !s.alive
    return (
      <li key={s.id} className="srow-wrap">
        <button
          className="srow"
          aria-current={s.id === props.selectedId}
          aria-label={`${name}, ${branch}, ${glyph.label}, ${s.profile}${color ? `, couleur ${COLOR_LABELS[color].toLowerCase()}` : ''}, dernière activité ${relativeTime(s.last_activity)}`}
          title={`${name}\n${branch} · ${s.cwd}`}
          onClick={() => props.onSelect(s.id)}
          onContextMenu={(e) => {
            if (!forgettable) return
            e.preventDefault()
            setConfirm(s.id)
          }}
        >
          <StatusGlyph glyph={glyph} />
          <span className="names">
            <span className="nm">
              <ColorBar color={color} />
              <span className="nm-t">{name}</span>
            </span>
            {branch !== name && <span className="br">{branch}</span>}
          </span>
          <span className="ago">{shortAgo(s.last_activity ?? s.created_at)}</span>
        </button>
        {forgettable && (
          <button
            className="row-act"
            aria-label={`Retirer « ${name} » de la liste`}
            title="Retirer de la liste"
            onClick={() => setConfirm(s.id)}
          >
            ×
          </button>
        )}
        {confirm === s.id && (
          <ForgetConfirm
            name={name}
            onConfirm={async () => {
              await props.onForget(s.id)
              setConfirm(null)
            }}
            onCancel={() => setConfirm(null)}
          />
        )}
      </li>
    )
  }

  function pastRow(p: PastEntry) {
    const label = pastDisplayName(p)
    const last = p.last_activity ?? p.last_timestamp
    const key = `${p.profile}:${p.claude_session_id}`
    return (
      <li key={key} className="srow-wrap">
        <button
          onContextMenu={(e) => {
            e.preventDefault()
            setConfirm(key)
          }}
          className="srow"
          aria-busy={busy === p.claude_session_id}
          disabled={busy !== null || !p.cwd}
          title={`${p.cwd ?? 'dossier inconnu'} · profil ${p.profile}${p.first_prompt ? `\n${p.first_prompt}` : ''}`}
          aria-label={`Reprendre ${label}${p.git_branch ? `, branche ${p.git_branch}` : ''}, profil ${p.profile}, ${relativeTime(last)}`}
          onClick={() => void resume(p)}
        >
          <span className="st past" aria-hidden="true" />
          <span className="names">
            <span className="nm-t">{label}</span>
            {p.git_branch && <span className="br">{p.git_branch}</span>}
          </span>
          <span className="ago">{busy === p.claude_session_id ? 'reprise…' : shortAgo(last)}</span>
        </button>
        <button
          className="row-act"
          aria-label={`Masquer « ${label} »`}
          title="Masquer cette ancienne session"
          disabled={busy === p.claude_session_id}
          onClick={() => setConfirm(key)}
        >
          ×
        </button>
        {confirm === key && (
          <HideConfirm
            name={label}
            onConfirm={async () => {
              await props.onHidePast(p)
              setConfirm(null)
            }}
            onCancel={() => setConfirm(null)}
          />
        )}
      </li>
    )
  }

  return (
    // `tabIndex={-1}` : point de retour du focus quand l'élément déclencheur a disparu.
    <nav className="panel side" aria-label="Projets et sessions" tabIndex={-1}>
      <div className="cap">
        <span className="lbl">Projets</span>
        <span className="hint">par dépôt git ou dossier</span>
      </div>
      {props.groups.length === 0 && <p className="empty-note">Aucune session pour l’instant.</p>}
      {props.groups.map((g) => {
        const profiles = new Set(g.sessions.map((s) => s.profile))
        const single = profiles.size === 1 ? [...profiles][0]! : null
        const key = `proj:${g.key}`
        return (
          <Group
            key={g.key}
            name={g.name}
            path={tildify(g.root, props.home)}
            title={g.root}
            open={!isCollapsed(key)}
            onToggle={() => toggle(key)}
            extra={
              <>
                {single && <span className={`chip ${profileClass(single, props.profiles)}`}>{single}</span>}
                {g.waiting > 0 && (
                  <span className="count" aria-label={`${g.waiting} à répondre`}>
                    {g.waiting} ⚠
                  </span>
                )}
              </>
            }
          >
            {g.sessions.map((s) => sessionRow(s, g.root))}
          </Group>
        )
      })}
      <div className="old">
        <button className="cap sec" aria-expanded={pastOpen} aria-controls={pastListId} onClick={() => toggle(PAST_SECTION)}>
          <Chevron open={pastOpen} />
          <span className="lbl">Anciennes sessions</span>
          <span className="badge" aria-label={`${props.past.length} anciennes sessions`}>
            {props.past.length}
          </span>
          <span className="hint">à reprendre</span>
        </button>
        <div id={pastListId} hidden={!pastOpen}>
          {error && (
            <p className="inline-err" role="alert">
              {error}
            </p>
          )}
          {props.past.length === 0 && <p className="empty-note">Aucune ancienne session trouvée.</p>}
          {props.pastGroups.map((g) => {
            const placeholder = g.key === RESOLVING_GROUP
            const key = `past:${g.key}`
            const latest = g.latest ? new Date(g.latest).toISOString() : null
            return (
              <Group
                key={g.key}
                name={g.name}
                path={g.root ? tildify(g.root, props.home) : null}
                title={g.root ?? undefined}
                open={placeholder ? resolvingOpen : !isCollapsed(key)}
                onToggle={() => (placeholder ? setResolvingOpen((o) => !o) : toggle(key))}
                extra={
                  <span
                    className="hint grp-n"
                    aria-label={`${g.entries.length} session${g.entries.length > 1 ? 's' : ''}, dernière activité ${relativeTime(latest)}`}
                  >
                    {g.entries.length} · {shortAgo(latest)}
                  </span>
                }
              >
                {g.entries.map(pastRow)}
              </Group>
            )
          })}
        </div>
      </div>
    </nav>
  )
}
