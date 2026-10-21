import { runnersIndicator } from '../state/runners'
import { useCallback, useId, useState, type ReactNode } from 'react'

import type { Profile, ProjectInfo, Session, Subagent } from '../../../shared/protocol'
import { errorText } from '../api'
import { PAST_SECTION, browserStorage, loadCollapsed, saveCollapsed, toggleCollapsed } from '../state/collapse'
import {
  COLOR_LABELS,
  basename,
  folderMissing,
  pastDisplayName,
  relativeTime,
  sessionColor,
  sessionDisplayName,
  shortAgo,
  tildify,
} from '../state/format'
import { RESOLVING_GROUP, pastFolderMissing, pastOrigin, type PastEntry, type PastGroup, type ProjectGroup } from '../state/projects'
import { sessionIssue } from '../state/forge'
import { glyphFor } from '../state/status'
import { candidate, cleanupCount, removable, worktreeOf, type WorktreeLists } from '../state/worktrees'
import { deliveryOf } from '../state/delivery'
import { AnyProfileBadge, PathLabel, ProfileBadge, StatusGlyph } from './common'
import { useSettings } from '../settings'
import { ForgetConfirm, HideConfirm } from './ForgetConfirm'
import { ColorBar } from './SessionIdentity'
import { SidebarAgents } from './Subagents'

/** Aucun sous-agent (référence stable). */
const NO_AGENTS: readonly Subagent[] = []

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
  action,
  children,
}: {
  name: string
  path: string | null
  title?: string
  open: boolean
  onToggle: () => void
  extra?: ReactNode
  /** Action du projet, à côté de l'en-tête (hors du bouton de repli). */
  action?: ReactNode
  children: ReactNode
}) {
  const listId = useId()
  const header = (
    <button className="proj-h" aria-expanded={open} aria-controls={listId} onClick={onToggle} title={title ?? name}>
      <Chevron open={open} />
      <b>{name}</b>
      {extra}
    </button>
  )
  return (
    <div className="proj">
      {action ? (
        <div className="proj-hrow">
          {header}
          {action}
        </div>
      ) : (
        header
      )}
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
  /** Projets résolus, par dossier (pour signaler les dossiers disparus). */
  projects: Record<string, ProjectInfo>
  selectedId: string | null
  onSelect: (id: string) => void
  onResumePast: (p: PastEntry) => Promise<void>
  onForget: (id: string) => Promise<void>
  onHidePast: (p: PastEntry) => Promise<void>
  /** Sous-agents connus, par session. */
  subagents: Record<string, Subagent[]>
  /** Runners en cours, par session (lot 14a) ; absent : aucun. */
  runnersRunning?: Record<string, number>
  /** Ouvre l'onglet « Agents » de la session (sur cet agent, ou sans choix). */
  onOpenAgent: (sessionId: string, agentId: string | null) => void
  /** Worktrees connus, par racine de dépôt (lot 6). */
  worktrees?: WorktreeLists
  /** Worktrees vus avec du travail à eux (intégration crédible, voir `noteWork`). */
  worktreesWorked?: ReadonlySet<string>
  /** Le démon connaît les worktrees : badges et nettoyage proposés. */
  worktreesEnabled?: boolean
  /** Ouvre « Nettoyer les worktrees » d'un dépôt (`focus` : worktree visé). */
  onCleanup?: (root: string, name: string, focus: string | null) => void
  /** Ouvre le panneau « Forge » (issues, demandes de fusion) d'un dépôt (absent : forge masquée ou désactivée). */
  onOpenIssues?: (project: { root: string; name: string; key: string }) => void
  /** Ouvre le détail de l'issue liée à une session (absent : « #n » affiché sans lien). */
  onOpenIssue?: (s: Session) => void
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
  const { settings, label: labelOf } = useSettings()

  /** Retrait ou masquage : confirmation dans l'app, sauf si elle est coupée dans les réglages. */
  function ask(key: string, act: () => Promise<void>, what: string) {
    if (settings.confirmRemoval) {
      setConfirm(key)
      return
    }
    setError(null)
    act().catch((e: unknown) => setError(`${what} impossible : ${errorText(e)}`))
  }

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

  function sessionRow(s: Session, groupRoot: string, groupName: string, isGit: boolean) {
    const glyph = glyphFor(s.status)
    // Worktree intégré sans session vivante (lot 6) : badge et « Nettoyer… ».
    const wt = props.worktreesEnabled && isGit ? worktreeOf(s.cwd, props.worktrees?.[groupRoot]?.worktrees) : undefined
    // Demande de fusion fusionnée (lot 14b) : même proposition de nettoyage, même sans intégration vue par git.
    const pullMerged = s.delivery?.state === 'merged'
    const integratedWt =
      wt && !s.alive && (candidate(wt, props.worktreesWorked) || (pullMerged && removable(wt) && wt.managed_by !== 'claude_desktop'))
        ? wt
        : undefined
    const delivered = deliveryOf(s.delivery, !!integratedWt) === 'merged'
    const branch = s.branch ?? (s.cwd !== groupRoot ? basename(s.cwd) : 'sans branche')
    const name = sessionDisplayName(s)
    const color = sessionColor(s)
    const forgettable = !s.alive
    const missing = folderMissing(s, props.projects[s.cwd])
    const iss = sessionIssue(s)
    const runners = runnersIndicator(props.runnersRunning?.[s.id] ?? 0)
    return (
      <li key={s.id} className="srow-wrap">
        <div className="srow-line">
        <button
          className="srow"
          aria-current={s.id === props.selectedId}
          aria-label={`${name}, ${branch}, ${glyph.label}, profil ${labelOf(s.profile).long}${color ? `, couleur ${COLOR_LABELS[color].toLowerCase()}` : ''}${missing ? ', dossier supprimé' : ''}${delivered ? ', livrée' : ''}${integratedWt ? ', branche intégrée' : ''}${runners ? `, ${runners}` : ''}, dernière activité ${relativeTime(s.last_activity)}`}
          title={`${name}\n${branch} · ${s.cwd}${missing ? ' (dossier supprimé)' : ''}`}
          onClick={() => props.onSelect(s.id)}
          onContextMenu={(e) => {
            if (!forgettable) return
            e.preventDefault()
            ask(s.id, () => props.onForget(s.id), 'Retrait')
          }}
        >
          <StatusGlyph glyph={glyph} />
          <ProfileBadge profile={s.profile} profiles={props.profiles} />
          <span className="names">
            <span className="nm">
              <ColorBar color={color} />
              <span className="nm-t">{name}</span>
            </span>
            {(branch !== name || missing || integratedWt || runners || delivered) && (
              <span className="sub">
                {branch !== name && <span className="br">{branch}</span>}
                {missing && (
                  <span className="gone" title={`ancien emplacement : ${s.cwd}`}>
                    dossier supprimé
                  </span>
                )}
                {runners && (
                  <span className="run-ind" title={`${runners} (onglet « Lancer »)`}>
                    <span aria-hidden="true">▶</span> {props.runnersRunning?.[s.id]}
                  </span>
                )}
                {delivered && (
                  <span className="integ" title={s.delivery?.state === 'merged' ? 'Livrée : demande de fusion fusionnée, ou commits poussés sur la branche par défaut' : 'Livrée : branche intégrée dans la référence'}>
                    <span aria-hidden="true">✓</span> livrée
                  </span>
                )}
                {integratedWt && !delivered && (
                  <span className="integ" title={`Branche intégrée, aucune session ne tourne dans ${integratedWt.path}`}>
                    <span aria-hidden="true">✓</span> intégrée
                  </span>
                )}
              </span>
            )}
          </span>
          <span className="ago">{shortAgo(s.last_activity ?? s.created_at)}</span>
        </button>
        {integratedWt && props.onCleanup && (
          <button
            className="row-act wt-act"
            aria-label={`Nettoyer le worktree de « ${name} »`}
            title="Nettoyer le worktree (branche intégrée)…"
            onClick={() => props.onCleanup!(groupRoot, groupName, integratedWt.path)}
          >
            Nettoyer…
          </button>
        )}
        {forgettable && (
          <button
            className="row-act"
            aria-label={`Retirer « ${name} » de la liste`}
            title="Retirer de la liste"
            onClick={() => ask(s.id, () => props.onForget(s.id), 'Retrait')}
          >
            ×
          </button>
        )}
        </div>
        {iss &&
          (props.onOpenIssue ? (
            <button
              className="srow-issue"
              title={`Issue #${iss.number}${iss.title ? ` : ${iss.title}` : ''} (voir le détail)`}
              aria-label={`Issue #${iss.number} de « ${name} »${iss.title ? ` : ${iss.title}` : ''}, voir le détail`}
              onClick={() => props.onOpenIssue!(s)}
            >
              <span className="mono">#{iss.number}</span> {iss.title}
            </button>
          ) : (
            <span className="srow-issue" title={`Issue #${iss.number}${iss.title ? ` : ${iss.title}` : ''}`}>
              <span className="mono">#{iss.number}</span> {iss.title}
            </span>
          ))}
        <SidebarAgents
          session={s}
          agents={props.subagents[s.id] ?? NO_AGENTS}
          open={!isCollapsed(`agents:${s.id}`)}
          onToggle={() => toggle(`agents:${s.id}`)}
          onOpen={(agentId) => props.onOpenAgent(s.id, agentId)}
        />
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
    // Une conversation vue par plusieurs profils n'apparaît qu'une fois (voir `pastToOffer`).
    const key = `past:${p.claude_session_id}`
    const missing = pastFolderMissing(p, props.projects)
    const origin = pastOrigin(p)
    const seenBy = origin ? `profil ${labelOf(origin).long}` : `visible par les profils ${p.profiles.map((n) => labelOf(n).long).join(', ')}`
    return (
      <li key={key} className="srow-wrap">
        <button
          onContextMenu={(e) => {
            e.preventDefault()
            ask(key, () => props.onHidePast(p), 'Masquage')
          }}
          className="srow"
          aria-busy={busy === p.claude_session_id}
          disabled={busy !== null || !p.cwd || missing}
          title={
            missing
              ? `Le dossier ${p.cwd} n’existe plus (worktree supprimé ?) : reprise impossible`
              : `${p.cwd ?? 'dossier inconnu'} · ${origin ? `${seenBy} (${origin})` : seenBy}${p.first_prompt ? `\n${p.first_prompt}` : ''}`
          }
          aria-label={`${missing ? '' : 'Reprendre '}${label}${p.git_branch ? `, branche ${p.git_branch}` : ''}${missing ? ', dossier supprimé, reprise impossible' : ''}, ${seenBy}, ${relativeTime(last)}`}
          onClick={() => void resume(p)}
        >
          <span className="st past" aria-hidden="true" />
          {/* Badge seulement si le profil d'origine est connu (un seul profil voit la conversation). */}
          {origin ? <ProfileBadge profile={origin} profiles={props.profiles} /> : <AnyProfileBadge />}
          <span className="names">
            <span className="nm-t">{label}</span>
            {(p.git_branch || missing) && (
              <span className="sub">
                {p.git_branch && <span className="br">{p.git_branch}</span>}
                {missing && (
                  <span className="gone" title={`ancien emplacement : ${p.cwd}`}>
                    dossier supprimé
                  </span>
                )}
              </span>
            )}
          </span>
          <span className="ago">{busy === p.claude_session_id ? 'reprise…' : shortAgo(last)}</span>
        </button>
        <button
          className="row-act"
          aria-label={`Masquer « ${label} »`}
          title="Masquer cette ancienne session"
          disabled={busy === p.claude_session_id}
          onClick={() => ask(key, () => props.onHidePast(p), 'Masquage')}
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
      {/* Projets en haut (défilement propre), anciennes sessions ancrées en bas. */}
      <div className="side-projects">
      <div className="cap">
        <span className="lbl">Projets</span>
        <span className="hint">par dépôt git ou dossier</span>
      </div>
      {error && (
        <p className="inline-err" role="alert">
          {error}
        </p>
      )}
      {props.groups.length === 0 && <p className="empty-note">Aucune session pour l’instant.</p>}
      {props.groups.map((g) => {
        const key = `proj:${g.key}`
        const canClean = !!props.worktreesEnabled && g.isGit && !g.missing && !!props.onCleanup
        const toClean = canClean ? cleanupCount(props.worktrees?.[g.root], props.worktreesWorked) : 0
        const canIssues = g.isGit && !g.missing && !!props.onOpenIssues
        return (
          <Group
            key={g.key}
            name={g.name}
            path={tildify(g.root, props.home)}
            title={g.root}
            open={!isCollapsed(key)}
            onToggle={() => toggle(key)}
            action={
              canClean || canIssues ? (
                <>
                {canIssues && (
                  <button
                    className="proj-act"
                    aria-label={`Forge de ${g.name} : issues et demandes de fusion…`}
                    title="Forge du projet : issues et demandes de fusion…"
                    onClick={() => props.onOpenIssues!({ root: g.root, name: g.name, key: g.key })}
                  >
                    <span aria-hidden="true">◎</span>
                  </button>
                )}
                {canClean && (
                <button
                  className={`proj-act${toClean > 0 ? ' has' : ''}`}
                  aria-label={`Nettoyer les worktrees de ${g.name}${toClean > 0 ? ` (${toClean} intégré${toClean > 1 ? 's' : ''})` : ''}…`}
                  title="Nettoyer les worktrees…"
                  onClick={() => props.onCleanup!(g.root, g.name, null)}
                >
                  <span aria-hidden="true">⑂</span>
                  {toClean > 0 && (
                    <span className="n" aria-hidden="true">
                      {toClean} ✓
                    </span>
                  )}
                </button>
                )}
                </>
              ) : undefined
            }
            extra={
              <>
                {g.missing && (
                  <span className="gone" title={`ancien emplacement : ${g.root ?? 'inconnu'}`}>
                    dossier supprimé
                  </span>
                )}
                {g.waiting > 0 && (
                  <span className="count" aria-label={`${g.waiting} à répondre`}>
                    {g.waiting} ⚠
                  </span>
                )}
              </>
            }
          >
            {g.sessions.map((s) => sessionRow(s, g.root, g.name, g.isGit))}
          </Group>
        )
      })}
      </div>
      <div className={`old${pastOpen ? ' open' : ''}`}>
        <button className="cap sec" aria-expanded={pastOpen} aria-controls={pastListId} onClick={() => toggle(PAST_SECTION)}>
          <Chevron open={pastOpen} />
          <span className="lbl">Anciennes sessions</span>
          <span className="badge" aria-label={`${props.past.length} anciennes sessions`}>
            {props.past.length}
          </span>
          <span className="hint">à reprendre</span>
        </button>
        <div id={pastListId} className="old-list" hidden={!pastOpen}>
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
                  <>
                  {g.missing && (
                  <span className="gone" title={`ancien emplacement : ${g.root ?? 'inconnu'}`}>
                    dossier supprimé
                  </span>
                )}
                  <span
                    className="hint grp-n"
                    aria-label={`${g.entries.length} session${g.entries.length > 1 ? 's' : ''}, dernière activité ${relativeTime(latest)}`}
                  >
                    {g.entries.length} · {shortAgo(latest)}
                  </span>
                  </>
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
