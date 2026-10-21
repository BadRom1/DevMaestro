import { runnersIndicator } from '../state/runners'
import { useCallback, useId, useState, type ReactNode } from 'react'

import type { KeyWith } from '../../../shared/i18n'
import type { Profile, ProjectInfo, Session, Subagent } from '../../../shared/protocol'
import { errorText } from '../api'
import { useT } from '../i18n'
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
import { ReviewBadge, useReviewMarks } from './AiReview'
import { reviewCleanupWorktree } from '../state/aiReview'

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
  const t = useT()
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
  const reviewMarksNow = useReviewMarks()

  /** Retrait ou masquage : confirmation dans l'app, sauf si elle est coupée dans les réglages. */
  function ask(key: string, act: () => Promise<void>, failed: KeyWith<'error'>) {
    if (settings.confirmRemoval) {
      setConfirm(key)
      return
    }
    setError(null)
    act().catch((e: unknown) => setError(t(failed, { error: errorText(e) })))
  }

  async function resume(p: PastEntry) {
    setBusy(p.claude_session_id)
    setError(null)
    try {
      await props.onResumePast(p)
    } catch (e) {
      setError(t('shell.sidebar.resumeFailed', { error: errorText(e) }))
    } finally {
      setBusy(null)
    }
  }

  /** « Issue #n », suivi du titre s'il est connu. */
  function issueText(n: number, title: string | null | undefined): string {
    return title ? t('shell.sidebar.issueWithTitle', { n, title }) : t('shell.sidebar.issue', { n })
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
    // Session de revue assistée (lot 19) : badge, et son worktree jetable proposé au nettoyage une fois arrêtée.
    const mark = reviewMarksNow[s.id]
    const reviewWt =
      !integratedWt && props.worktreesEnabled && isGit ? reviewCleanupWorktree(s, mark, props.worktrees?.[groupRoot]?.worktrees) : null
    const delivered = deliveryOf(s.delivery, !!integratedWt) === 'merged'
    const branch = s.branch ?? (s.cwd !== groupRoot ? basename(s.cwd) : t('shell.noBranch'))
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
          aria-label={[
            name,
            branch,
            glyph.label,
            t('shell.sidebar.profile', { label: labelOf(s.profile).long }),
            color && t('shell.sidebar.color', { color: COLOR_LABELS[color].toLowerCase() }),
            missing && t('shell.folderDeleted'),
            delivered && t('shell.sidebar.delivered'),
            integratedWt && t('shell.sidebar.mergedBranch'),
            mark && t('shell.sidebar.reviewSession'),
            runners,
            t('shell.sidebar.lastActivity', { when: relativeTime(s.last_activity) }),
          ]
            .filter(Boolean)
            .join(', ')}
          title={`${name}\n${branch} · ${s.cwd}${missing ? ` (${t('shell.folderDeleted')})` : ''}`}
          onClick={() => props.onSelect(s.id)}
          onContextMenu={(e) => {
            if (!forgettable) return
            e.preventDefault()
            ask(s.id, () => props.onForget(s.id), 'shell.pane.forgetFailed')
          }}
        >
          <StatusGlyph glyph={glyph} />
          <ProfileBadge profile={s.profile} profiles={props.profiles} />
          <span className="names">
            <span className="nm">
              <ColorBar color={color} />
              <span className="nm-t">{name}</span>
            </span>
            {(branch !== name || missing || integratedWt || runners || delivered || mark) && (
              <span className="sub">
                {mark && <ReviewBadge mark={mark} />}
                {branch !== name && <span className="br">{branch}</span>}
                {missing && (
                  <span className="gone" title={t('shell.sidebar.formerLocation', { path: s.cwd })}>
                    {t('shell.folderDeleted')}
                  </span>
                )}
                {runners && (
                  <span className="run-ind" title={t('shell.sidebar.runnersTitle', { runners })}>
                    <span aria-hidden="true">▶</span> {props.runnersRunning?.[s.id]}
                  </span>
                )}
                {delivered && (
                  <span className="integ" title={s.delivery?.state === 'merged' ? t('shell.sidebar.deliveredPullTitle') : t('shell.sidebar.deliveredBranchTitle')}>
                    <span aria-hidden="true">✓</span> {t('shell.sidebar.delivered')}
                  </span>
                )}
                {integratedWt && !delivered && (
                  <span className="integ" title={t('shell.sidebar.mergedTitle', { path: integratedWt.path })}>
                    <span aria-hidden="true">✓</span> {t('shell.sidebar.merged')}
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
            aria-label={t('shell.sidebar.cleanupWorktreeAria', { name })}
            title={t('shell.sidebar.cleanupWorktreeTitle')}
            onClick={() => props.onCleanup!(groupRoot, groupName, integratedWt.path)}
          >
            {t('shell.sidebar.cleanup')}
          </button>
        )}
        {reviewWt && props.onCleanup && (
          <button
            className="row-act wt-act"
            aria-label={t('shell.sidebar.cleanupReviewAria', { name })}
            title={t('shell.sidebar.cleanupReviewTitle')}
            onClick={() => props.onCleanup!(groupRoot, groupName, reviewWt.path)}
          >
            {t('shell.sidebar.cleanup')}
          </button>
        )}
        {forgettable && (
          <button
            className="row-act"
            aria-label={t('shell.sidebar.removeAria', { name })}
            title={t('shell.removeFromList')}
            onClick={() => ask(s.id, () => props.onForget(s.id), 'shell.pane.forgetFailed')}
          >
            ×
          </button>
        )}
        </div>
        {iss &&
          (props.onOpenIssue ? (
            <button
              className="srow-issue"
              title={t('shell.sidebar.issueOpenTitle', { issue: issueText(iss.number, iss.title) })}
              aria-label={
                iss.title
                  ? t('shell.sidebar.issueAriaTitle', { n: iss.number, name, title: iss.title })
                  : t('shell.sidebar.issueAria', { n: iss.number, name })
              }
              onClick={() => props.onOpenIssue!(s)}
            >
              <span className="mono">#{iss.number}</span> {iss.title}
            </button>
          ) : (
            <span className="srow-issue" title={issueText(iss.number, iss.title)}>
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
    const seenBy = origin
      ? t('shell.sidebar.profile', { label: labelOf(origin).long })
      : t('shell.sidebar.seenBy', { profiles: p.profiles.map((n) => labelOf(n).long).join(', ') })
    return (
      <li key={key} className="srow-wrap">
        <button
          onContextMenu={(e) => {
            e.preventDefault()
            ask(key, () => props.onHidePast(p), 'shell.sidebar.hideFailed')
          }}
          className="srow"
          aria-busy={busy === p.claude_session_id}
          disabled={busy !== null || !p.cwd || missing}
          title={
            missing
              ? t('shell.sidebar.pastGone', { cwd: p.cwd })
              : `${p.cwd ?? t('shell.sidebar.unknownFolder')} · ${origin ? `${seenBy} (${origin})` : seenBy}${p.first_prompt ? `\n${p.first_prompt}` : ''}`
          }
          aria-label={[
            missing ? label : t('shell.sidebar.resumeAria', { label }),
            p.git_branch && t('shell.sidebar.branch', { branch: p.git_branch }),
            missing && t('shell.sidebar.deletedNoResume'),
            seenBy,
            relativeTime(last),
          ]
            .filter(Boolean)
            .join(', ')}
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
                  <span className="gone" title={t('shell.sidebar.formerLocation', { path: p.cwd })}>
                    {t('shell.folderDeleted')}
                  </span>
                )}
              </span>
            )}
          </span>
          <span className="ago">{busy === p.claude_session_id ? t('shell.sidebar.resuming') : shortAgo(last)}</span>
        </button>
        <button
          className="row-act"
          aria-label={t('shell.sidebar.hideAria', { label })}
          title={t('shell.sidebar.hideTitle')}
          disabled={busy === p.claude_session_id}
          onClick={() => ask(key, () => props.onHidePast(p), 'shell.sidebar.hideFailed')}
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
    <nav className="panel side" aria-label={t('shell.sidebar.nav')} tabIndex={-1}>
      {/* Projets en haut (défilement propre), anciennes sessions ancrées en bas. */}
      <div className="side-projects">
      <div className="cap">
        <span className="lbl">{t('shell.sidebar.projects')}</span>
        <span className="hint">{t('shell.sidebar.projectsHint')}</span>
      </div>
      {error && (
        <p className="inline-err" role="alert">
          {error}
        </p>
      )}
      {props.groups.length === 0 && <p className="empty-note">{t('shell.sidebar.noSession')}</p>}
      {props.groups.map((g) => {
        // i18n-exempt: clé de repli (identifiant)
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
                    aria-label={t('shell.sidebar.forgeAria', { name: g.name })}
                    title={t('shell.sidebar.forgeTitle')}
                    onClick={() => props.onOpenIssues!({ root: g.root, name: g.name, key: g.key })}
                  >
                    <span aria-hidden="true">◎</span>
                  </button>
                )}
                {canClean && (
                <button
                  className={`proj-act${toClean > 0 ? ' has' : ''}`}
                  aria-label={
                    toClean > 0
                      ? t('shell.sidebar.cleanupAllAriaCount', { name: g.name, count: toClean })
                      : t('shell.sidebar.cleanupAllAria', { name: g.name })
                  }
                  title={t('shell.sidebar.cleanupAllTitle')}
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
                  <span className="gone" title={t('shell.sidebar.formerLocation', { path: g.root ?? t('shell.sidebar.unknown') })}>
                    {t('shell.folderDeleted')}
                  </span>
                )}
                {g.waiting > 0 && (
                  <span className="count" aria-label={t('shell.pane.badge.waiting', { count: g.waiting })}>
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
          <span className="lbl">{t('shell.sidebar.past')}</span>
          <span className="badge" aria-label={t('shell.sidebar.pastCount', { n: props.past.length })}>
            {props.past.length}
          </span>
          <span className="hint">{t('shell.sidebar.pastHint')}</span>
        </button>
        <div id={pastListId} className="old-list" hidden={!pastOpen}>
          {props.past.length === 0 && <p className="empty-note">{t('shell.sidebar.noPast')}</p>}
          {props.pastGroups.map((g) => {
            const placeholder = g.key === RESOLVING_GROUP
            // i18n-exempt: clé de repli (identifiant)
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
                  <span className="gone" title={t('shell.sidebar.formerLocation', { path: g.root ?? t('shell.sidebar.unknown') })}>
                    {t('shell.folderDeleted')}
                  </span>
                )}
                  <span
                    className="hint grp-n"
                    aria-label={t('shell.sidebar.groupCount', { count: g.entries.length, when: relativeTime(latest) })}
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
