/**
 * Panneau « Issues du projet » (v0.3, lot 13a, ADR 0006) : liste filtrable
 * (état, recherche, assignées à moi, étiquette), détail avec le corps en
 * Markdown (rendu sûr), « Lancer une session » (préremplit « Nouvelle
 * session ») et, pour un epic, « Lancer une session par sous-issue ».
 *
 * Contenu venu de la forge = non fiable : Markdown sans HTML brut ni image,
 * liens ouverts seulement après la confirmation des liens externes, couleurs
 * d'étiquette validées. Forge indisponible : la raison et la commande à
 * lancer soi-même (jamais exécutée par l'app). Démon d'avant la forge :
 * `onUnsupported` masque les entrées.
 */
import { useEffect, useId, useMemo, useRef, useState, type MouseEvent } from 'react'

import { ISSUE_STATE_FILTERS, type ForgeStatus, type Issue, type IssueStateFilter, type Session } from '../../../shared/protocol'
import { api, call, errorCode, errorText, CallError } from '../api'
import { outcomeUncertain } from '../state/errors'
import {
  DEFAULT_FILTERS,
  EPIC_MODES,
  FORGE_CONTENT_WARNING,
  UNCERTAIN_LAUNCH,
  cleanForge,
  invisibleNote,
  onlyRepoIssues,
  prepareEpic,
  type EpicMode,
  type Prepared,
  availabilityFromError,
  availabilityFromStatus,
  epicPlan,
  isEpic,
  issuePrefill,
  issueStateLabel,
  issuesParams,
  labelColors,
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
import { classifyLink, renderMarkdown } from '../state/markdown'
import { useSettings } from '../settings'
import { Modal } from './Modal'

const NO_LAUNCHED: ReadonlyMap<number, 'done' | 'uncertain'> = new Map()

const STATE_LABELS: Record<IssueStateFilter, string> = { open: 'Ouvertes', closed: 'Fermées', all: 'Toutes' }

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
  /** Lance une session dans son worktree, avec son nom, son issue et son mode. */
  launch: (row: EpicRow, prefill: IssuePrefill, mode: EpicMode) => Promise<{ session: Session; warnings: string[] }>
  /** Session lancée (la liste de l'app est mise à jour, sans changer de vue). */
  onLaunched: (s: Session) => void
}

export function IssueLabels({ labels }: { labels: Issue['labels'] }) {
  if (!labels?.length) return null
  return (
    <span className="ilabels">
      {labels.map((l, i) => {
        const c = labelColors(l.color)
        const name = oneLine(l.name)
        return (
          <span
            key={`${name}-${i}`}
            className={`ilabel${c ? ' colored' : ''}`}
            style={c ? { background: c.background, color: c.color, borderColor: c.background } : undefined}
            title={`Étiquette : ${name}`}
          >
            <span className="ldot" aria-hidden="true" />
            {name}
          </span>
        )
      })}
    </span>
  )
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
  const [copied, setCopied] = useState(false)
  if (a.kind === 'unsupported') {
    return (
      <div className="forge-off" role="status">
        <p>Le démon ne connaît pas encore les forges : mets orchd à jour pour lire les issues.</p>
      </div>
    )
  }
  if (a.kind !== 'unavailable') return null
  return (
    <div className="forge-off" role="status">
      <p>
        <b>Issues indisponibles :</b> {a.reason}
      </p>
      {a.command && (
        <>
          <p className="forge-cmd">
            Lance toi-même, dans un terminal : <code className="mono">{a.command}</code>
            <button
              type="button"
              className="btn sm ghost"
              onClick={() => void api.copyText(a.command!).then((ok) => setCopied(ok))}
            >
              {copied ? 'Copié' : 'Copier'}
            </button>
          </p>
          <p className="hint">DevMaestro n’exécute jamais cette commande : elle reste entre toi et la CLI GitHub.</p>
        </>
      )}
      <p>
        <button type="button" className="btn sm" onClick={onRetry}>
          Réessayer
        </button>
      </p>
    </div>
  )
}

/** Corps de l'issue : Markdown sûr ; liens externes par la confirmation, ancres internes, le reste inerte. */
function IssueBody({ issue, onLink }: { issue: Issue; onLink: (url: string) => void }) {
  const ref = useRef<HTMLElement>(null)
  // Contenu de la forge : contrôles et caractères invisibles (bidi, tags Unicode…) retirés avant le rendu.
  const clean = useMemo(() => cleanForge(issue.body ?? ''), [issue.body])
  const body = clean.text
  const html = useMemo(() => (body.trim() ? renderMarkdown(body, { idPrefix: `issue-${issue.number}` }).html : null), [body, issue.number])
  const note = invisibleNote(clean.invisible)
  function onClick(e: MouseEvent<HTMLElement>) {
    const a = (e.target as HTMLElement).closest('a')
    if (!a) return
    e.preventDefault()
    const t = classifyLink(a.getAttribute('href'), '')
    if (t.kind === 'external') onLink(t.url)
    else if (t.kind === 'anchor') {
      ref.current?.querySelector(`[id="issue-${issue.number}-${CSS.escape(t.id)}"]`)?.scrollIntoView({ block: 'start' })
    }
  }
  if (!html) return <p className="hint">Aucune description.</p>
  return (
    <>
      {note && (
        <p className="chip pend" role="note">
          {note} de la description
        </p>
      )}
      {issue.truncated && (
        <p className="ag-cut" role="note">
          Description coupée par le démon (64 Kio au plus) : la suite est sur la forge.
        </p>
      )}
      {/* HTML produit par markdown-it sans HTML brut (échappé) ni image chargée, comme l'onglet Fichiers. */}
      <article ref={ref} className="md issue-md" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
    </>
  )
}

type ListState = { phase: 'idle' } | { phase: 'loading' } | { phase: 'ready'; issues: Issue[]; truncated: boolean } | { phase: 'error'; message: string }
type DetailState = { phase: 'loading'; number: number } | { phase: 'ready'; issue: Issue } | { phase: 'error'; number: number; message: string }

export function IssuesPanel({
  root,
  name,
  initialNumber,
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
  /** Sous-issues lancées depuis ce panneau, par epic (marquées et décochées au retour). */
  const [launchedSubs, setLaunchedSubs] = useState<Record<number, Map<number, 'done' | 'uncertain'>>>({})
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
    const t = setTimeout(() => setApplied(filters), filters.search === applied.search && filters.label === applied.label ? 0 : SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
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

  function refresh() {
    refreshNext.current = true
    setListSeq((n) => n + 1)
    if (selected !== null) setDetailSeq((n) => n + 1)
  }

  const current = detail?.phase === 'ready' ? detail.issue : null
  // Recherche avec qualificatifs (`repo:`, `is:pr`…) : éléments d'autres dépôts écartés.
  const shown = useMemo(
    () => (list.phase === 'ready' && avail.kind === 'available' ? onlyRepoIssues(list.issues, avail.status) : { issues: [], dropped: 0 }),
    [list, avail],
  )

  return (
    <Modal title={`Issues du projet · ${name}`} onClose={onClose} width={1040} busy={epicBusy}>
      <div className="mb issues-mb">
        {avail.kind === 'loading' && <p className="hint">Connexion à la forge…</p>}
        {(avail.kind === 'unavailable' || avail.kind === 'unsupported') && (
          <Unavailable a={avail} onRetry={() => setStatusSeq((n) => n + 1)} />
        )}
        {available && epicOpen && current && (
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
        {available && !epicOpen && (
          <div className="issues">
            <section className="ilist" aria-label="Liste des issues">
              <div className="ifilters" role="group" aria-label="Filtres">
                <label className="field">
                  <span className="lbl">État</span>
                  <select value={filters.state} onChange={(e) => setFilters((f) => ({ ...f, state: e.target.value as IssueStateFilter }))}>
                    {ISSUE_STATE_FILTERS.map((s) => (
                      <option key={s} value={s}>
                        {STATE_LABELS[s]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field grow">
                  <span className="lbl">Recherche</span>
                  <input
                    type="search"
                    value={filters.search}
                    maxLength={256}
                    placeholder="Titre, texte…"
                    onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
                  />
                  <span className="hint">
                    Recherche de GitHub : un qualificatif (repo:, is:pr…) peut ramener des éléments d’autres dépôts ; ils sont écartés.
                  </span>
                </label>
                <label className="field">
                  <span className="lbl">Étiquette</span>
                  <input
                    value={filters.label}
                    maxLength={128}
                    placeholder="bug…"
                    onChange={(e) => setFilters((f) => ({ ...f, label: e.target.value }))}
                  />
                </label>
                <label className="optrow imine">
                  <input type="checkbox" checked={filters.mine} onChange={(e) => setFilters((f) => ({ ...f, mine: e.target.checked }))} />
                  <span>Assignées à moi</span>
                </label>
                <button type="button" className="btn sm ghost" onClick={refresh} title="Redemander à la forge (sans le cache de 60 s)">
                  Actualiser
                </button>
              </div>
              {list.phase === 'loading' && <p className="hint">Chargement des issues…</p>}
              {list.phase === 'error' && (
                <p className="inline-err" role="alert">
                  Liste indisponible : {list.message}
                </p>
              )}
              {list.phase === 'ready' && shown.issues.length === 0 && <p className="empty-note">Aucune issue pour ces filtres.</p>}
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
                            <span className="hint iago" title={i.updated_at ? `mise à jour ${relativeTime(i.updated_at)}` : undefined}>
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
                  {shown.issues.length} issue{shown.issues.length > 1 ? 's' : ''}
                  {list.truncated ? ' (liste coupée : affine les filtres)' : ''}
                  {shown.dropped > 0 ? ` · ${shown.dropped} élément${shown.dropped > 1 ? 's' : ''} hors du dépôt écarté${shown.dropped > 1 ? 's' : ''}` : ''}
                </p>
              )}
            </section>
            <section className="idetail" aria-label="Détail de l’issue" aria-live="polite">
              {selected === null && <p className="empty">Choisis une issue pour voir sa description.</p>}
              {detail?.phase === 'loading' && <p className="hint">Chargement de l’issue #{detail.number}…</p>}
              {detail?.phase === 'error' && (
                <p className="inline-err" role="alert">
                  Issue #{detail.number} indisponible : {detail.message}
                </p>
              )}
              {current && (
                <IssueDetail
                  issue={current}
                  onLink={onLink}
                  onLaunch={() => onLaunchIssue(issuePrefill(current, prefix))}
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
        <button type="button" className="btn ghost" onClick={onClose} disabled={epicBusy}>
          Fermer
        </button>
      </div>
    </Modal>
  )
}

function IssueDetail({
  issue,
  onLink,
  onLaunch,
  onEpic,
  onOpen,
}: {
  issue: Issue
  onLink: (url: string) => void
  onLaunch: () => void
  onEpic: () => void
  onOpen: (n: number) => void
}) {
  const subs = issue.sub_issues ?? []
  const openCount = openSubIssues(issue).length
  return (
    <article className="iissue">
      <h3 className="ih">
        <span className="inum mono">#{issue.number}</span> {oneLine(issue.title)}
      </h3>
      <div className="imeta">
        <IssueState state={issue.state} />
        <Progress issue={issue} />
        <IssueLabels labels={issue.labels} />
        {issue.author && <span className="hint">par {oneLine(issue.author)}</span>}
        {issue.assignees?.length > 0 && <span className="hint">assignée à {issue.assignees.map(oneLine).join(', ')}</span>}
        {issue.updated_at && <span className="hint">mise à jour {relativeTime(issue.updated_at)}</span>}
        {typeof issue.parent === 'number' && (
          <button type="button" className="linkish" onClick={() => onOpen(issue.parent!)}>
            epic #{issue.parent}
          </button>
        )}
      </div>
      <div className="iacts">
        <button type="button" className="btn sm pri" onClick={onLaunch}>
          Lancer une session
        </button>
        {isEpic(issue) && (
          <button type="button" className="btn sm" onClick={onEpic} disabled={openCount === 0} title={openCount === 0 ? 'Aucune sous-issue ouverte' : undefined}>
            Lancer une session par sous-issue ({openCount})…
          </button>
        )}
        {issue.url && (
          <button type="button" className="btn sm ghost" onClick={() => onLink(issue.url)} title={issue.url}>
            Voir sur la forge ↗
          </button>
        )}
      </div>
      {subs.length > 0 && (
        <div className="isubs">
          <span className="lbl">Sous-issues</span>
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
    </article>
  )
}

type EpicPhase = 'select' | 'preparing' | 'confirm' | 'running' | 'done'

const MODE_LABELS: Record<EpicMode, string> = {
  default: 'Par défaut (demande les permissions)',
  plan: 'Plan (lecture seule)',
  acceptEdits: 'Accepter les modifications',
}

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
        Une session par sous-issue de <span className="inum mono">#{epic.number}</span> {oneLine(epic.title)}
      </h3>
      {!ctx.worktrees && (
        <p className="inline-err" role="alert">
          Le démon ne crée pas de worktree (version trop ancienne ?) : impossible de lancer une session par sous-issue, chacune dans
          son worktree.
        </p>
      )}
      {!ctx.initial && (
        <p className="inline-err" role="alert">
          Le démon ne sait pas encore taper la consigne puis coller le contenu des issues : mets orchd à jour pour lancer depuis un epic.
        </p>
      )}
      <p className="forge-warn" role="note">
        <span aria-hidden="true">⚠ </span>
        {FORGE_CONTENT_WARNING}
      </p>
      <div className="iepic-opts">
        <label className="field">
          <span className="lbl">Mode des sessions</span>
          <select value={mode} disabled={phase !== 'select' && phase !== 'confirm'} onChange={(e) => setMode(e.target.value as EpicMode)}>
            {EPIC_MODES.map((m) => (
              <option key={m} value={m}>
                {MODE_LABELS[m]}
              </option>
            ))}
          </select>
          <span className="hint">Jamais de mode qui approuve seul depuis un epic : le contenu collé n’est pas fiable.</span>
        </label>
        <p className="hint">
          Profil : <b>{ctx.profileLabel}</b> · worktrees : <b>{ctx.locationLabel}</b> · nom = titre de la sous-issue ; la consigne est
          tapée, puis la description de la sous-issue est collée. Les sessions partent l’une après l’autre.
        </p>
      </div>
      <fieldset className="iepic-list" disabled={phase !== 'select'}>
        <legend className="lbl">Sous-issues ouvertes ({subs.length})</legend>
        {subs.length === 0 && <p className="hint">Aucune sous-issue ouverte.</p>}
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
                        session « {row.name} » · branche <span className="mono">{row.branch}</span>
                      </span>
                    )}
                  </span>
                </label>
                {before && !r && (
                  <span className={`wt-result${before === 'done' ? ' ok' : ''}`}>
                    {before === 'done' ? '✓ déjà lancée depuis ce panneau' : `déjà tentée : ${UNCERTAIN_LAUNCH}`}
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
                      Ce qui sera tapé puis collé
                      {invisibleNote(p.prefill.invisible) && <span className="chip pend">{invisibleNote(p.prefill.invisible)}</span>}
                    </summary>
                    <p className="hint">
                      Consigne : <span className="mono">{p.prefill.instruction}</span>
                    </p>
                    <pre className="forge-pre">{p.prefill.pasted || '(aucune description : rien n’est collé)'}</pre>
                  </details>
                )}
                {showPreview && p?.phase === 'failed' && !row?.problem && !r && (
                  <span className="wt-result bad" role="alert">
                    Sous-issue illisible : {p.message}
                  </span>
                )}
                {phase === 'preparing' && p?.phase === 'loading' && <span className="wt-result">lecture de la sous-issue…</span>}
                {r && <EpicResult r={r} />}
              </li>
            )
          })}
        </ul>
      </fieldset>
      {phase === 'confirm' && (
        <div className="forget wt-confirm" role="group" aria-label="Confirmation">
          <span>
            Lancer {ready.length > 1 ? `ces ${ready.length} sessions` : ready.length === 1 ? 'cette session' : 'aucune session'}, chacune dans
            un nouveau worktree, en mode « {MODE_LABELS[mode]} » ?
            {rows.length > ready.length && ` ${rows.length - ready.length} ligne(s) en erreur ne partiront pas.`}
          </span>
          <span>Relis le contenu de chaque sous-issue (« Ce qui sera tapé puis collé ») avant de lancer.</span>
        </div>
      )}
      {phase === 'done' && (
        <p role="status">
          {nDone} session{nDone > 1 ? 's' : ''} lancée{nDone > 1 ? 's' : ''}
          {nUncertain > 0 ? `, ${nUncertain} au résultat incertain (vérifie la liste des sessions)` : ''}
          {nFailed > 0 ? `, ${nFailed} en échec` : ''}.
        </p>
      )}
      <div className="iacts">
        {phase === 'select' && (
          <>
            <button type="button" className="btn ghost" onClick={onBack}>
              Retour à l’issue
            </button>
            <button
              type="button"
              className="btn pri"
              disabled={!ctx.worktrees || !ctx.initial || plannable.length === 0}
              onClick={() => void prepare()}
            >
              Aperçu de {plannable.length} session{plannable.length > 1 ? 's' : ''}…
            </button>
          </>
        )}
        {phase === 'preparing' && (
          <span className="hint" role="status">
            <span className="spin" aria-hidden="true" /> Lecture des sous-issues…
          </span>
        )}
        {phase === 'confirm' && (
          <>
            <button type="button" className="btn ghost" onClick={() => setPhase('select')} autoFocus>
              Retour
            </button>
            <button type="button" className="btn pri" disabled={ready.length === 0} onClick={() => void run()}>
              Lancer {ready.length} session{ready.length > 1 ? 's' : ''}
            </button>
          </>
        )}
        {phase === 'running' && (
          <span className="hint" role="status">
            <span className="spin" aria-hidden="true" /> Lancement en cours…
          </span>
        )}
        {phase === 'done' && (
          <button type="button" className="btn" onClick={onBack}>
            Retour à l’issue
          </button>
        )}
      </div>
    </div>
  )
}

function EpicResult({ r }: { r: RowResult }) {
  switch (r.phase) {
    case 'pending':
      return <span className="wt-result">en attente</span>
    case 'running':
      return (
        <span className="wt-result" role="status">
          <span className="spin" aria-hidden="true" /> lancement…
        </span>
      )
    case 'done':
      return (
        <span className="wt-result ok" role="status">
          <span aria-hidden="true">✓</span> lancée{r.warnings.length ? ` (${r.warnings.join(' ')})` : ''}
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
          <span aria-hidden="true">✗</span> échec : {r.message}
        </span>
      )
  }
}
