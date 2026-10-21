/**
 * Panneau « Forge » d'un projet (v0.3, ADR 0006), à deux onglets :
 * « Issues » (lot 13a) et « Demandes de fusion » (lot 13b, `PullsPanel`).
 *
 * Issues : liste filtrable (barre alignée : état, étiquettes choisies dans
 * la liste du dépôt, assignées à moi, recherche), détail avec le corps en
 * Markdown (rendu sûr) et, fixée en bas du détail, la barre d'actions :
 * « Lancer une session » (préremplit « Nouvelle session » avec un nom et une
 * branche courts) et, pour un epic, « Lancer une session par sous-issue ».
 *
 * Panneau ancré à droite sur toute la largeur disponible, redimensionnable et
 * agrandissable (lot 15) ; la liste et le détail défilent chacun de leur côté.
 *
 * Contenu venu de la forge = non fiable : Markdown sans HTML brut ni image,
 * liens ouverts seulement après la confirmation des liens externes, couleurs
 * d'étiquette validées. Forge indisponible : la raison et la commande à
 * lancer soi-même (jamais exécutée par l'app). Démon d'avant la forge :
 * `onUnsupported` masque les entrées.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react'

import type { MessageKey } from '../../../shared/i18n'
import { ISSUE_STATE_FILTERS, type ForgeStatus, type Issue, type IssueStateFilter, type RepoLabel, type Session } from '../../../shared/protocol'
import { api, call, errorCode, errorText, CallError } from '../api'
import { useI18n, useT } from '../i18n'
import { outcomeUncertain } from '../state/errors'
import {
  DEFAULT_FILTERS,
  EPIC_MODES,
  forgeContentWarning,
  uncertainLaunchText,
  invisibleNote,
  onlyRepoIssues,
  prepareEpic,
  type EpicMode,
  type Prepared,
  availabilityFromError,
  availabilityFromStatus,
  epicPlan,
  isEpic,
  issueBranch,
  issuePrefill,
  issueSessionName,
  MAX_FILTER_LABELS,
  repoLabelsFrom,
  issueStateLabel,
  issuesParams,
  oneLine,
  openSubIssues,
  runEpicPlan,
  subIssueProgress,
  type EpicRow,
  type ForgeAvailability,
  type IssueFilters,
  type IssuePrefill,
  type RowResult,
} from '../state/forge'
import { relativeTime, shortAgo } from '../state/format'
import { useSettings } from '../settings'
import { ForgeMarkdown, IssueLabels } from './ForgeContent'
import { LabelPicker } from './LabelPicker'
import { Modal } from './Modal'
import { PullsTab } from './PullsPanel'

/** Onglet du panneau « Forge ». */
export type ForgeTab = 'issues' | 'pulls'

const NO_LAUNCHED: ReadonlyMap<number, 'done' | 'uncertain'> = new Map()

/** Libellés des filtres d'état (clés du catalogue, traduites au rendu). */
const STATE_LABELS = { open: 'forge.issues.filter.open', closed: 'forge.issues.filter.closed', all: 'forge.issues.filter.all' } as const satisfies Record<IssueStateFilter, MessageKey>

/** Clé de la taille retenue du panneau Forge. */
export const FORGE_PANEL_SIZE_KEY = 'devmaestro.forge.panel'

/** Étiquettes du dépôt : liste (sélecteur), ou saisie libre si le démon ne la donne pas (avant le lot 15). */
type RepoLabelsState = { phase: 'loading' } | { phase: 'ready'; labels: RepoLabel[] } | { phase: 'fallback' }

/** Recherche avec un qualificatif de GitHub (`repo:`, `is:pr`…) : l'avertissement s'affiche. */
const QUALIFIER = /(^|\s)-?[a-z-]+:/i

/** Délai avant de relancer la recherche pendant la saisie. */
const SEARCH_DEBOUNCE_MS = 350

/** Contexte du lancement d'un epic, préparé par l'app (profil, emplacement des worktrees). */
export interface EpicLaunchContext {
  /** Le démon crée les worktrees (sinon, pas de lancement par sous-issue). */
  worktrees: boolean
  /** Branches déjà extraites dans un worktree du dépôt. */
  takenBranches: ReadonlySet<string>
  /** Libellés affichés dans l'aperçu. */
  profileLabel: string
  locationLabel: string
  /** Le démon sait taper la consigne puis coller le contenu (`initial`). */
  initial: boolean
  /** Modèle de la consigne `issue` du projet (Réglages → Consignes, lot 18). */
  issueTemplate?: string
  /** Lance une session dans son worktree, avec son nom, son issue et son mode. */
  launch: (row: EpicRow, prefill: IssuePrefill, mode: EpicMode) => Promise<{ session: Session; warnings: string[] }>
  /** Session lancée (la liste de l'app est mise à jour, sans changer de vue). */
  onLaunched: (s: Session) => void
}

function IssueState({ state }: { state: string }) {
  const s = issueStateLabel(state)
  return (
    <span className={`istate ${s.kind}`}>
      <span aria-hidden="true">{s.glyph}</span> {s.text}
    </span>
  )
}

function Progress({ issue }: { issue: Issue }) {
  const p = subIssueProgress(issue)
  if (!p) return null
  return (
    <span className="chip iprog" title={p.label} aria-label={p.label}>
      <span aria-hidden="true">☰ {p.text}</span>
    </span>
  )
}

/** Forge indisponible : raison, commande à lancer soi-même (copiable, jamais exécutée). */
function Unavailable({ a, onRetry }: { a: ForgeAvailability; onRetry: () => void }) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  if (a.kind === 'unsupported') {
    return (
      <div className="forge-off" role="status">
        <p>{t('forge.issues.unsupported')}</p>
      </div>
    )
  }
  if (a.kind !== 'unavailable') return null
  return (
    <div className="forge-off" role="status">
      <p>
        <b>{t('forge.issues.unavailableTitle')}</b> {a.reason}
      </p>
      {a.command && (
        <>
          <p className="forge-cmd">
            {t('forge.issues.runYourself')} <code className="mono">{a.command}</code>
            <button
              type="button"
              className="btn sm ghost"
              onClick={() => void api.copyText(a.command!).then((ok) => setCopied(ok))}
            >
              {copied ? t('forge.issues.copied') : t('forge.issues.copy')}
            </button>
          </p>
          <p className="hint">{t('forge.issues.neverRun')}</p>
        </>
      )}
      <p>
        <button type="button" className="btn sm" onClick={onRetry}>
          {t('forge.issues.retry')}
        </button>
      </p>
    </div>
  )
}

/** Corps de l'issue : Markdown sûr ; liens externes par la confirmation, ancres internes, le reste inerte. */
function IssueBody({ issue, onLink }: { issue: Issue; onLink: (url: string) => void }) {
  return <ForgeMarkdown text={issue.body} idPrefix={`issue-${issue.number}`} onLink={onLink} truncated={issue.truncated} />
}

type ListState = { phase: 'idle' } | { phase: 'loading' } | { phase: 'ready'; issues: Issue[]; truncated: boolean } | { phase: 'error'; message: string }
type DetailState = { phase: 'loading'; number: number } | { phase: 'ready'; issue: Issue } | { phase: 'error'; number: number; message: string }

export function ForgePanel({
  root,
  name,
  initialNumber,
  initialTab = 'issues',
  initialPull,
  epic,
  onClose,
  onLink,
  onLaunchIssue,
  onUnsupported,
  onSupported,
}: {
  /** Racine du dépôt (worktree principal). */
  root: string
  name: string
  /** Issue à ouvrir d'emblée (« #42 » d'une session). */
  initialNumber?: number | null
  /** Onglet ouvert d'emblée (« PR #n » d'une session : demandes de fusion). */
  initialTab?: ForgeTab
  /** Demande de fusion à ouvrir d'emblée. */
  initialPull?: number | null
  epic: EpicLaunchContext
  onClose: () => void
  onLink: (url: string) => void
  /** « Lancer une session » : ouvre « Nouvelle session » prérempli. */
  onLaunchIssue: (prefill: IssuePrefill) => void
  /** Démon d'avant la forge : l'app masque les entrées. */
  onUnsupported: () => void
  /** `forge.status` a répondu : le démon connaît la forge (`status` : ses capacités annoncées). */
  onSupported?: (status: ForgeStatus) => void
}) {
  const t = useT()
  const { settings } = useSettings()
  const prefix = settings.worktrees.branchPrefix
  const [avail, setAvail] = useState<ForgeAvailability>({ kind: 'loading' })
  const [statusSeq, setStatusSeq] = useState(0)
  const [filters, setFilters] = useState<IssueFilters>(DEFAULT_FILTERS)
  /** Recherche et étiquette appliquées (après la saisie). */
  const [applied, setApplied] = useState<IssueFilters>(DEFAULT_FILTERS)
  const [listSeq, setListSeq] = useState(0)
  const refreshNext = useRef(false)
  const [list, setList] = useState<ListState>({ phase: 'idle' })
  const [selected, setSelected] = useState<number | null>(initialNumber ?? null)
  const [detail, setDetail] = useState<DetailState | null>(null)
  const [detailSeq, setDetailSeq] = useState(0)
  const [epicOpen, setEpicOpen] = useState(false)
  const [epicBusy, setEpicBusy] = useState(false)
  const [tab, setTab] = useState<ForgeTab>(initialTab)
  /** Publication d'une revue en cours : la fenêtre ne se ferme pas. */
  const [pullBusy, setPullBusy] = useState(false)
  const busy = epicBusy || pullBusy
  /** Sous-issues lancées depuis ce panneau, par epic (marquées et décochées au retour). */
  const [launchedSubs, setLaunchedSubs] = useState<Record<number, Map<number, 'done' | 'uncertain'>>>({})
  const [repoLabels, setRepoLabels] = useState<RepoLabelsState>({ phase: 'loading' })
  const [labelsSeq, setLabelsSeq] = useState(0)
  const onSupportedRef = useRef(onSupported)
  onSupportedRef.current = onSupported
  const uid = useId()
  const onUnsupportedRef = useRef(onUnsupported)
  onUnsupportedRef.current = onUnsupported

  /** Erreur d'un appel : forge indisponible ou démon ancien → état du panneau ; sinon message. */
  function handle(e: unknown): string | null {
    const f = e instanceof CallError ? e.failure : null
    const a = f ? availabilityFromError(f.code, f.message, f.data) : null
    if (a) {
      setAvail(a)
      if (a.kind === 'unsupported') onUnsupportedRef.current()
      return null
    }
    return errorText(e)
  }
  const handleRef = useRef(handle)
  handleRef.current = handle

  // État de la forge : premier appel (rien n'est demandé avant l'ouverture du panneau).
  useEffect(() => {
    let alive = true
    setAvail({ kind: 'loading' })
    void (async () => {
      try {
        const s = await call('forge.status', { root, ...(statusSeq > 0 ? { refresh: true } : {}) })
        if (!alive) return
        onSupportedRef.current?.(s)
        const a = availabilityFromStatus(s)
        setAvail(a)
      } catch (e) {
        if (!alive) return
        const message = handleRef.current(e)
        if (message !== null) setAvail({ kind: 'unavailable', reason: message, command: null })
      }
    })()
    return () => {
      alive = false
    }
  }, [root, statusSeq])

  // Saisie de la recherche ou de l'étiquette : appliquée après une courte pause ; le reste tout de suite.
  useEffect(() => {
    if (filters === applied) return
    const timer = setTimeout(() => setApplied(filters), filters.search === applied.search && filters.label === applied.label ? 0 : SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [filters, applied])

  const available = avail.kind === 'available'
  useEffect(() => {
    if (!available) return
    let alive = true
    const refresh = refreshNext.current
    refreshNext.current = false
    setList((l) => (l.phase === 'ready' ? l : { phase: 'loading' }))
    void (async () => {
      try {
        const r = await call('forge.issues', issuesParams(root, applied, refresh))
        if (alive) setList({ phase: 'ready', issues: Array.isArray(r.issues) ? r.issues : [], truncated: r.truncated === true })
      } catch (e) {
        if (!alive) return
        const message = handleRef.current(e)
        if (message !== null) setList({ phase: 'error', message })
      }
    })()
    return () => {
      alive = false
    }
  }, [available, root, applied, listSeq])

  useEffect(() => {
    if (!available || selected === null) {
      setDetail(null)
      return
    }
    let alive = true
    setDetail({ phase: 'loading', number: selected })
    void (async () => {
      try {
        const issue = await call('forge.issue', { root, number: selected, ...(detailSeq > 0 ? { refresh: true } : {}) })
        if (alive) setDetail({ phase: 'ready', issue })
      } catch (e) {
        if (!alive) return
        const message = handleRef.current(e)
        if (message !== null) setDetail({ phase: 'error', number: selected, message })
      }
    })()
    return () => {
      alive = false
    }
  }, [available, root, selected, detailSeq])

  // Étiquettes du dépôt, pour le sélecteur. Échec (démon d'avant le lot 15, `gh` qui refuse…) : saisie libre,
  // sans passer par `handle` (une méthode inconnue y vaut « démon sans forge » et masquerait toute la forge).
  useEffect(() => {
    if (!available) return
    let alive = true
    void (async () => {
      try {
        const r = await call('forge.labels', { root, ...(labelsSeq > 0 ? { refresh: true } : {}) })
        if (alive) setRepoLabels({ phase: 'ready', labels: repoLabelsFrom(r) })
      } catch {
        if (alive) setRepoLabels((l) => (l.phase === 'ready' ? l : { phase: 'fallback' }))
      }
    })()
    return () => {
      alive = false
    }
  }, [available, root, labelsSeq])

  function refresh() {
    refreshNext.current = true
    setListSeq((n) => n + 1)
    setLabelsSeq((n) => n + 1)
    if (selected !== null) setDetailSeq((n) => n + 1)
  }

  const current = detail?.phase === 'ready' ? detail.issue : null
  // Recherche avec qualificatifs (`repo:`, `is:pr`…) : éléments d'autres dépôts écartés.
  const shown = useMemo(
    () => (list.phase === 'ready' && avail.kind === 'available' ? onlyRepoIssues(list.issues, avail.status) : { issues: [], dropped: 0 }),
    [list, avail],
  )

  return (
    <Modal title={t('forge.issues.panelTitle', { name })} onClose={onClose} busy={busy} panel={{ sizeKey: FORGE_PANEL_SIZE_KEY }}>
      <div className="mb issues-mb">
        {available && (
          <div className="ftabs" role="tablist" aria-label={t('forge.issues.tabsLabel')}>
            {(
              [
                // i18n-exempt: identifiant d'onglet
                ['issues', t('forge.issues.tab.issues')],
                // i18n-exempt: identifiant d'onglet
                ['pulls', t('forge.issues.tab.pulls')],
              ] as const
            ).map(([id, label]) => (
              <button key={id} type="button" role="tab" className="ftab" aria-selected={tab === id} disabled={busy && tab !== id} onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
          </div>
        )}
        {available && tab === 'pulls' && (
          <PullsTab root={root} status={avail.status} initialNumber={initialPull ?? null} onLink={onLink} onBusy={setPullBusy} />
        )}
        {avail.kind === 'loading' && <p className="hint">{t('forge.issues.connecting')}</p>}
        {(avail.kind === 'unavailable' || avail.kind === 'unsupported') && (
          <Unavailable a={avail} onRetry={() => setStatusSeq((n) => n + 1)} />
        )}
        {available && tab === 'issues' && epicOpen && current && (
          <EpicLaunch
            epic={current}
            ctx={epic}
            prefix={prefix}
            root={root}
            launched={launchedSubs[current.number] ?? NO_LAUNCHED}
            onLaunchedRows={(rows) =>
              setLaunchedSubs((m) => ({ ...m, [current.number]: new Map([...(m[current.number] ?? []), ...rows]) }))
            }
            onBusy={setEpicBusy}
            onBack={() => setEpicOpen(false)}
          />
        )}
        {available && tab === 'issues' && !epicOpen && (
          <div className="issues">
            <div className="ifilters-wrap">
              <div className="ifilters" role="group" aria-label={t('forge.issues.filtersLabel')}>
                <label className="field ifield-state">
                  <span className="lbl">{t('forge.issues.filter.state')}</span>
                  <select value={filters.state} onChange={(e) => setFilters((f) => ({ ...f, state: e.target.value as IssueStateFilter }))}>
                    {ISSUE_STATE_FILTERS.map((s) => (
                      <option key={s} value={s}>
                        {t(STATE_LABELS[s])}
                      </option>
                    ))}
                  </select>
                </label>
                {repoLabels.phase === 'fallback' ? (
                  <label className="field ifield-labels">
                    <span className="lbl">{t('forge.issues.filter.label')}</span>
                    <input
                      value={filters.label}
                      maxLength={128}
                      placeholder={t('forge.issues.filter.labelPlaceholder')}
                      title={t('forge.issues.filter.labelFree')}
                      onChange={(e) => setFilters((f) => ({ ...f, label: e.target.value }))}
                    />
                  </label>
                ) : (
                  <LabelPicker
                    labels={repoLabels.phase === 'ready' ? repoLabels.labels : []}
                    loading={repoLabels.phase === 'loading'}
                    selected={filters.labels}
                    max={MAX_FILTER_LABELS}
                    onChange={(labels) => setFilters((f) => ({ ...f, labels }))}
                  />
                )}
                <label className="optrow imine">
                  <input type="checkbox" checked={filters.mine} onChange={(e) => setFilters((f) => ({ ...f, mine: e.target.checked }))} />
                  <span>{t('forge.issues.filter.mine')}</span>
                </label>
                <label className="field grow">
                  <span className="lbl">{t('forge.issues.filter.search')}</span>
                  <input
                    type="search"
                    value={filters.search}
                    maxLength={256}
                    placeholder={t('forge.issues.filter.searchPlaceholder')}
                    onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
                  />
                </label>
                <button type="button" className="btn ghost ictl" onClick={refresh} title={t('forge.issues.refreshTitle')}>
                  {t('forge.issues.refresh')}
                </button>
              </div>
              {QUALIFIER.test(filters.search) && (
                <p className="hint">
                  {t('forge.issues.qualifierHint')}
                </p>
              )}
            </div>
            <section className="ilist" aria-label={t('forge.issues.listLabel')}>
              {list.phase === 'loading' && <p className="hint">{t('forge.issues.loadingList')}</p>}
              {list.phase === 'error' && (
                <p className="inline-err" role="alert">
                  {t('forge.issues.listError', { message: list.message })}
                </p>
              )}
              {list.phase === 'ready' && shown.issues.length === 0 && <p className="empty-note">{t('forge.issues.noneForFilters')}</p>}
              {list.phase === 'ready' && shown.issues.length > 0 && (
                <ul className="irows" role="list" aria-describedby={`${uid}-n`}>
                  {shown.issues.map((i) => {
                    const title = oneLine(i.title)
                    return (
                      <li key={i.number}>
                        <button
                          type="button"
                          className="irow"
                          aria-current={selected === i.number ? 'true' : undefined}
                          onClick={() => setSelected(i.number)}
                        >
                          <span className="irow-1">
                            <span className="inum mono">#{i.number}</span>
                            <span className="ititle">{title}</span>
                          </span>
                          <span className="irow-2">
                            <IssueState state={i.state} />
                            <Progress issue={i} />
                            <IssueLabels labels={i.labels} />
                            <span className="hint iago" title={i.updated_at ? t('forge.issues.updated', { ago: relativeTime(i.updated_at) }) : undefined}>
                              {shortAgo(i.updated_at)}
                            </span>
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
              {list.phase === 'ready' && (
                <p className="hint" id={`${uid}-n`}>
                  {t('forge.issues.count', { count: shown.issues.length })}
                  {list.truncated ? t('forge.issues.countTruncated') : ''}
                  {shown.dropped > 0 ? t('forge.issues.countDropped', { count: shown.dropped }) : ''}
                </p>
              )}
            </section>
            <section className="idetail" aria-label={t('forge.issues.detailLabel')} aria-live="polite">
              {selected === null && <p className="empty">{t('forge.issues.pickOne')}</p>}
              {detail?.phase === 'loading' && <p className="hint">{t('forge.issues.loadingIssue', { number: detail.number })}</p>}
              {detail?.phase === 'error' && (
                <p className="inline-err" role="alert">
                  {t('forge.issues.issueError', { number: detail.number, message: detail.message })}
                </p>
              )}
              {current && (
                <IssueDetail
                  issue={current}
                  names={{ name: issueSessionName(current.number, current.title), branch: issueBranch(current.number, current.title, prefix) }}
                  onLink={onLink}
                  onLaunch={() => onLaunchIssue(issuePrefill(current, prefix, epic.issueTemplate))}
                  onEpic={() => setEpicOpen(true)}
                  onOpen={(n) => setSelected(n)}
                />
              )}
            </section>
          </div>
        )}
      </div>
      <div className="mf">
        <span className="hint" style={{ marginRight: 'auto' }}>
          {avail.kind === 'available' && avail.status.repo ? `${avail.status.host ? `${avail.status.host} · ` : ''}${avail.status.repo}` : ''}
        </span>
        <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
          {t('forge.issues.close')}
        </button>
      </div>
    </Modal>
  )
}

function IssueDetail({
  issue,
  names,
  onLink,
  onLaunch,
  onEpic,
  onOpen,
}: {
  issue: Issue
  /** Nom de session et branche proposés (modifiables dans « Nouvelle session »). */
  names: { name: string; branch: string }
  onLink: (url: string) => void
  onLaunch: () => void
  onEpic: () => void
  onOpen: (n: number) => void
}) {
  const { t, rich } = useI18n()
  const subs = issue.sub_issues ?? []
  const openCount = openSubIssues(issue).length
  return (
    <article className="iissue iissue-fixed">
      <div className="iissue-body">
        <h3 className="ih">
          <span className="inum mono">#{issue.number}</span> {oneLine(issue.title)}
        </h3>
        <div className="imeta">
          <IssueState state={issue.state} />
          <Progress issue={issue} />
          <IssueLabels labels={issue.labels} />
          {issue.author && <span className="hint">{t('forge.issues.by', { author: oneLine(issue.author) })}</span>}
          {issue.assignees?.length > 0 && <span className="hint">{t('forge.issues.assignedTo', { names: issue.assignees.map(oneLine).join(', ') })}</span>}
          {issue.updated_at && <span className="hint">{t('forge.issues.updated', { ago: relativeTime(issue.updated_at) })}</span>}
          {typeof issue.parent === 'number' && (
            <button type="button" className="linkish" onClick={() => onOpen(issue.parent!)}>
              {t('forge.issues.epicParent', { number: issue.parent })}
            </button>
          )}
        </div>
        {subs.length > 0 && (
          <div className="isubs">
            <span className="lbl">{t('forge.issues.subIssues')}</span>
            <ul role="list">
              {subs.map((s) => (
                <li key={s.number}>
                  <IssueState state={s.state} />{' '}
                  <button type="button" className="linkish" onClick={() => onOpen(s.number)}>
                    #{s.number}
                  </button>{' '}
                  {oneLine(s.title)}
                </li>
              ))}
            </ul>
          </div>
        )}
        <IssueBody issue={issue} onLink={onLink} />
      </div>
      {/* Barre d'actions fixée en bas du détail : toujours visible, quel que soit le défilement. */}
      <div className="iissue-bar" role="group" aria-label={t('forge.issues.actionsLabel', { number: issue.number })}>
        <button type="button" className="btn pri" onClick={onLaunch}>
          {t('forge.issues.launch')}
        </button>
        {isEpic(issue) && (
          <button type="button" className="btn" onClick={onEpic} disabled={openCount === 0} title={openCount === 0 ? t('forge.issues.noOpenSub') : undefined}>
            {t('forge.issues.launchEach', { count: openCount })}
          </button>
        )}
        <span className="hint iissue-names">
          {rich('forge.issues.names', { name: names.name, branch: <span className="mono">{names.branch}</span> })}
        </span>
        {issue.url && (
          <button type="button" className="btn sm ghost iissue-link" onClick={() => onLink(issue.url)} title={issue.url}>
            {t('forge.issues.viewOnForge')}
          </button>
        )}
      </div>
    </article>
  )
}

type EpicPhase = 'select' | 'preparing' | 'confirm' | 'running' | 'done'

/** Libellés des modes d'un epic (clés du catalogue, traduites au rendu). */
const MODE_LABELS = {
  default: 'forge.issues.mode.default',
  plan: 'forge.issues.mode.plan',
  acceptEdits: 'forge.issues.mode.acceptEdits',
} as const satisfies Record<EpicMode, MessageKey>

/**
 * Epic : sous-issues ouvertes à cocher, mode, aperçu relu (ce qui sera collé),
 * confirmation, lancement séquentiel avec résultat par ligne. Les lignes déjà
 * lancées (`launched`, gardé par le panneau) restent marquées et décochées.
 */
function EpicLaunch({
  epic,
  ctx,
  prefix,
  root,
  launched,
  onLaunchedRows,
  onBusy,
  onBack,
}: {
  epic: Issue
  ctx: EpicLaunchContext
  prefix: string
  root: string
  launched: ReadonlyMap<number, 'done' | 'uncertain'>
  onLaunchedRows: (rows: Map<number, 'done' | 'uncertain'>) => void
  onBusy: (busy: boolean) => void
  onBack: () => void
}) {
  const { t, rich } = useI18n()
  const subs = useMemo(() => openSubIssues(epic), [epic])
  const [checked, setChecked] = useState<Set<number>>(() => new Set(subs.map((s) => s.number).filter((n) => !launched.has(n))))
  const [mode, setMode] = useState<EpicMode>('default')
  const [phase, setPhase] = useState<EpicPhase>('select')
  const [prepared, setPrepared] = useState<Record<number, Prepared>>({})
  const [results, setResults] = useState<Record<number, RowResult>>({})
  const rows = useMemo(() => epicPlan(subs, checked, prefix, ctx.takenBranches), [subs, checked, prefix, ctx.takenBranches])
  const ready = rows.filter((r) => !r.problem && prepared[r.number]?.phase === 'ready')
  const plannable = rows.filter((r) => !r.problem)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  async function prepare() {
    setPhase('preparing')
    setPrepared({})
    onBusy(true)
    try {
      await prepareEpic(rows, prefix, {
        // Corps relu sans le cache de la forge : l'aperçu montre ce qui partira.
        fetchIssue: (number) => call('forge.issue', { root, number, refresh: true }),
        onRow: (number, p) => alive.current && setPrepared((m) => ({ ...m, [number]: p })),
        errorText,
        cancelled: () => !alive.current,
        template: ctx.issueTemplate,
      })
    } finally {
      onBusy(false)
      if (alive.current) setPhase('confirm')
    }
  }

  async function run() {
    setPhase('running')
    onBusy(true)
    const done = new Map<number, 'done' | 'uncertain'>()
    try {
      await runEpicPlan(rows, prepared, {
        launch: (row, prefill) => ctx.launch(row, prefill, mode),
        onRow: (number, result) => {
          if (result.phase === 'done') ctx.onLaunched(result.session)
          if (result.phase === 'done' || result.phase === 'uncertain') done.set(number, result.phase)
          if (alive.current) setResults((m) => ({ ...m, [number]: result }))
        },
        errorText,
        uncertain: (e) => outcomeUncertain(errorCode(e)),
        cancelled: () => !alive.current,
      })
    } finally {
      onLaunchedRows(done)
      onBusy(false)
      if (alive.current) setPhase('done')
    }
  }

  const nDone = Object.values(results).filter((r) => r.phase === 'done').length
  const nUncertain = Object.values(results).filter((r) => r.phase === 'uncertain').length
  const nFailed = Object.values(results).filter((r) => r.phase === 'failed').length
  const showPreview = phase === 'confirm' || phase === 'running' || phase === 'done'

  return (
    <div className="iepic">
      <h3 className="ih">
        {rich('forge.issues.epic.title', { number: <span className="inum mono">#{epic.number}</span>, title: oneLine(epic.title) })}
      </h3>
      {!ctx.worktrees && (
        <p className="inline-err" role="alert">
          {t('forge.issues.epic.noWorktrees')}
        </p>
      )}
      {!ctx.initial && (
        <p className="inline-err" role="alert">
          {t('forge.issues.epic.noInitial')}
        </p>
      )}
      <p className="forge-warn" role="note">
        <span aria-hidden="true">⚠ </span>
        {forgeContentWarning()}
      </p>
      <div className="iepic-opts">
        <label className="field">
          <span className="lbl">{t('forge.issues.epic.modeLabel')}</span>
          <select value={mode} disabled={phase !== 'select' && phase !== 'confirm'} onChange={(e) => setMode(e.target.value as EpicMode)}>
            {EPIC_MODES.map((m) => (
              <option key={m} value={m}>
                {t(MODE_LABELS[m])}
              </option>
            ))}
          </select>
          <span className="hint">{t('forge.issues.epic.modeHint')}</span>
        </label>
        <p className="hint">
          {rich('forge.issues.epic.summary', { profile: <b>{ctx.profileLabel}</b>, location: <b>{ctx.locationLabel}</b> })}
        </p>
      </div>
      <fieldset className="iepic-list" disabled={phase !== 'select'}>
        <legend className="lbl">{t('forge.issues.epic.openSubs', { count: subs.length })}</legend>
        {subs.length === 0 && <p className="hint">{t('forge.issues.epic.noneOpen')}</p>}
        <ul role="list">
          {subs.map((s) => {
            const row = rows.find((r) => r.number === s.number)
            const r = results[s.number]
            const p = prepared[s.number]
            const before = launched.get(s.number)
            return (
              <li key={s.number} className="wt-item">
                <label className="wt-main">
                  <input
                    type="checkbox"
                    checked={checked.has(s.number)}
                    onChange={(e) =>
                      setChecked((c) => {
                        const n = new Set(c)
                        if (e.target.checked) n.add(s.number)
                        else n.delete(s.number)
                        return n
                      })
                    }
                  />
                  <span className="wt-names">
                    <b>
                      <span className="mono">#{s.number}</span> {oneLine(s.title)}
                    </b>
                    {row && (
                      <span className="hint">
                        {rich('forge.issues.epic.rowNames', { name: row.name, branch: <span className="mono">{row.branch}</span> })}
                      </span>
                    )}
                  </span>
                </label>
                {before && !r && (
                  <span className={`wt-result${before === 'done' ? ' ok' : ''}`}>
                    {before === 'done' ? t('forge.issues.epic.alreadyLaunched') : t('forge.issues.epic.alreadyTried', { text: uncertainLaunchText() })}
                  </span>
                )}
                {row?.problem && !r && (
                  <span className="wt-result bad" role="alert">
                    {row.problem}
                  </span>
                )}
                {showPreview && row && !row.problem && p?.phase === 'ready' && (
                  <details className="forge-pasted">
                    <summary>
                      {t('forge.issues.epic.previewSummary')}
                      {invisibleNote(p.prefill.invisible) && <span className="chip pend">{invisibleNote(p.prefill.invisible)}</span>}
                    </summary>
                    <p className="hint">
                      {rich('forge.issues.epic.instruction', { text: <span className="mono">{p.prefill.instruction}</span> })}
                    </p>
                    <pre className="forge-pre">{p.prefill.pasted || t('forge.issues.epic.nothingPasted')}</pre>
                  </details>
                )}
                {showPreview && p?.phase === 'failed' && !row?.problem && !r && (
                  <span className="wt-result bad" role="alert">
                    {t('forge.issues.epic.unreadable', { message: p.message })}
                  </span>
                )}
                {phase === 'preparing' && p?.phase === 'loading' && <span className="wt-result">{t('forge.issues.epic.reading')}</span>}
                {r && <EpicResult r={r} />}
              </li>
            )
          })}
        </ul>
      </fieldset>
      {phase === 'confirm' && (
        <div className="forget wt-confirm" role="group" aria-label={t('forge.issues.epic.confirmLabel')}>
          <span>
            {ready.length > 1
              ? t('forge.issues.epic.confirmMany', { count: ready.length, mode: t(MODE_LABELS[mode]) })
              : ready.length === 1
                ? t('forge.issues.epic.confirmOne', { mode: t(MODE_LABELS[mode]) })
                : t('forge.issues.epic.confirmNone', { mode: t(MODE_LABELS[mode]) })}
            {rows.length > ready.length && t('forge.issues.epic.confirmErrors', { count: rows.length - ready.length })}
          </span>
          <span>{t('forge.issues.epic.confirmReread')}</span>
        </div>
      )}
      {phase === 'done' && (
        <p role="status">
          {t('forge.issues.epic.doneLaunched', { count: nDone })}
          {nUncertain > 0 ? t('forge.issues.epic.doneUncertain', { count: nUncertain }) : ''}
          {nFailed > 0 ? t('forge.issues.epic.doneFailed', { count: nFailed }) : ''}.
        </p>
      )}
      <div className="iacts">
        {phase === 'select' && (
          <>
            <button type="button" className="btn ghost" onClick={onBack}>
              {t('forge.issues.epic.backToIssue')}
            </button>
            <button
              type="button"
              className="btn pri"
              disabled={!ctx.worktrees || !ctx.initial || plannable.length === 0}
              onClick={() => void prepare()}
            >
              {t('forge.issues.epic.preview', { count: plannable.length })}
            </button>
          </>
        )}
        {phase === 'preparing' && (
          <span className="hint" role="status">
            <span className="spin" aria-hidden="true" /> {t('forge.issues.epic.readingAll')}
          </span>
        )}
        {phase === 'confirm' && (
          <>
            <button type="button" className="btn ghost" onClick={() => setPhase('select')} autoFocus>
              {t('forge.issues.epic.back')}
            </button>
            <button type="button" className="btn pri" disabled={ready.length === 0} onClick={() => void run()}>
              {t('forge.issues.epic.run', { count: ready.length })}
            </button>
          </>
        )}
        {phase === 'running' && (
          <span className="hint" role="status">
            <span className="spin" aria-hidden="true" /> {t('forge.issues.epic.running')}
          </span>
        )}
        {phase === 'done' && (
          <button type="button" className="btn" onClick={onBack}>
            {t('forge.issues.epic.backToIssue')}
          </button>
        )}
      </div>
    </div>
  )
}

function EpicResult({ r }: { r: RowResult }) {
  const t = useT()
  switch (r.phase) {
    case 'pending':
      return <span className="wt-result">{t('forge.issues.result.pending')}</span>
    case 'running':
      return (
        <span className="wt-result" role="status">
          <span className="spin" aria-hidden="true" /> {t('forge.issues.result.running')}
        </span>
      )
    case 'done':
      return (
        <span className="wt-result ok" role="status">
          <span aria-hidden="true">✓</span>{' '}
          {r.warnings.length ? t('forge.issues.result.doneWarnings', { warnings: r.warnings.join(' ') }) : t('forge.issues.result.done')}
        </span>
      )
    case 'uncertain':
      return (
        <span className="wt-result" role="alert">
          <span aria-hidden="true">?</span> {r.message}
        </span>
      )
    case 'failed':
      return (
        <span className="wt-result bad" role="alert">
          <span aria-hidden="true">✗</span> {t('forge.issues.result.failed', { message: r.message })}
        </span>
      )
  }
}
