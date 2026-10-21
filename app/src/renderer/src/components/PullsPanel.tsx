/**
 * Onglet « Demandes de fusion » du panneau « Forge » (v0.3, lot 13b, ADR
 * 0006) : liste filtrable (ouvertes / fusionnées / fermées / toutes, les
 * miennes, recherche) ; détail avec description (Markdown sûr), vérifications
 * de CI, fils de revue existants (lecture seule), fichiers et diff (lecteur
 * de diff, j / k) ; commentaire par ligne dans le **brouillon de revue de la
 * forge** (distinct de celui pour Claude, destination affichée) ; « Publier
 * la revue… » : événement, commentaire général, aperçu figé exact puis
 * « Publier sur GitHub ». Conflit de tête : brouillon gardé, « Recharger la
 * demande de fusion », commentaires sur des lignes disparues signalés.
 *
 * Seule écriture vers la forge : `publishConfirmed`, appelée uniquement par le
 * bouton « Publier sur GitHub » de l'étape de confirmation.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react'

import {
  FORGE_REVIEW_EVENTS,
  PULL_STATE_FILTERS,
  type FileDiff,
  type ForgeStatus,
  type Pull,
  type PullDetail,
  type PullStateFilter,
} from '../../../shared/protocol'
import { CallError, call, errorCode, errorText } from '../api'
import type { ReviewTarget } from '../state/aiReview'
import { STATUS_LABELS, diffRows } from '../state/diff'
import { firstFile } from '../state/diffTree'
import { oneLine } from '../state/forge'
import {
  DEFAULT_PULL_FILTERS,
  EVENT_LABELS,
  FORGE_DESTINATION,
  MAX_FORGE_COMMENTS,
  MAX_FORGE_TEXT,
  OLD_DAEMON_PULLS,
  PULL_FILTER_LABELS,
  activeForgeComments,
  buildForgeReview,
  checkDuration,
  checkRunLabel,
  checksLabel,
  confirmStep,
  forgeCommentsAt,
  forgeDraftKey,
  forgeDrafts,
  forgeEditingAt,
  movedLabel,
  pullFileErrorText,
  reloadForReview,
  onlyRepoPulls,
  publishForgeReview,
  pullCounters,
  pullDiffFiles,
  pullStateLabel,
  pullsErrorKind,
  pullsParams,
  reviewDecisionLabel,
  supportsForgeReview,
  validHeadSha,
  type Badge,
  type ForgeDraft,
  type ForgeDraftAction,
  type PublishState,
  type PullFilters,
} from '../state/forgePulls'
import { relativeTime, shortAgo } from '../state/format'
import { AiReviewButton, AiReviewConfirm, useAiReview } from './AiReview'
import { DiffFileList, DiffTable, FileHeadCounts, fileKeys, useFileNav, useListMode } from './DiffReader'
import { ForgeMarkdown, IssueLabels } from './ForgeContent'

const SEARCH_DEBOUNCE_MS = 350

/** Badge glyphe + texte (jamais la couleur seule). */
export function ForgeBadge({ b, className = '' }: { b: Badge; className?: string }) {
  return (
    <span className={`fbadge ${b.tone} ${className}`.trim()} title={b.label}>
      <span aria-hidden="true">{b.glyph}</span> {b.text}
      {b.label !== b.text && <span className="sr-only"> ({b.label})</span>}
    </span>
  )
}

type ListState = { phase: 'loading' } | { phase: 'ready'; pulls: Pull[]; truncated: boolean } | { phase: 'error'; message: string } | { phase: 'old' }
type DetailState = { phase: 'loading'; number: number } | { phase: 'ready'; pull: PullDetail } | { phase: 'error'; number: number; message: string }
type DetailTab = 'desc' | 'checks' | 'threads' | 'files'

/** Lien https de la forge (non fiable) : ouvert par la confirmation des liens ; autre schéma : inerte. */
function safeHttps(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && !u.username && !u.password ? u.toString() : null
  } catch {
    return null
  }
}

export function PullsTab({
  root,
  status,
  initialNumber,
  onLink,
  onBusy,
}: {
  root: string
  status: ForgeStatus
  /** Demande à ouvrir d'emblée (« PR #n » d'une session). */
  initialNumber?: number | null
  onLink: (url: string) => void
  /** Publication en cours : la fenêtre ne se ferme pas. */
  onBusy: (busy: boolean) => void
}) {
  const [filters, setFilters] = useState<PullFilters>(DEFAULT_PULL_FILTERS)
  const [applied, setApplied] = useState<PullFilters>(DEFAULT_PULL_FILTERS)
  const [listSeq, setListSeq] = useState(0)
  const refreshNext = useRef(false)
  const [list, setList] = useState<ListState>({ phase: 'loading' })
  const [selected, setSelected] = useState<number | null>(initialNumber ?? null)
  const [detail, setDetail] = useState<DetailState | null>(null)
  const [detailSeq, setDetailSeq] = useState(0)
  /** Prochaine lecture du détail sans cache (à usage unique). */
  const refreshDetailNext = useRef(false)
  /** Publication ou rechargement en cours : liste, filtres et fermeture désactivés. */
  const [busy, setBusy] = useState(false)
  const uid = useId()
  function busyChange(b: boolean) {
    setBusy(b)
    onBusy(b)
  }

  useEffect(() => {
    if (filters === applied) return
    const t = setTimeout(() => setApplied(filters), filters.search === applied.search ? 0 : SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [filters, applied])

  useEffect(() => {
    let alive = true
    const refresh = refreshNext.current
    refreshNext.current = false
    setList((l) => (l.phase === 'ready' ? l : { phase: 'loading' }))
    void (async () => {
      try {
        const r = await call('forge.pulls', pullsParams(root, applied, refresh))
        if (alive) setList({ phase: 'ready', pulls: Array.isArray(r?.pulls) ? r.pulls : [], truncated: r?.truncated === true })
      } catch (e) {
        if (!alive) return
        setList(pullsErrorKind(errorCode(e)) === 'old-daemon' ? { phase: 'old' } : { phase: 'error', message: errorText(e) })
      }
    })()
    return () => {
      alive = false
    }
  }, [root, applied, listSeq])

  useEffect(() => {
    if (selected === null) {
      setDetail(null)
      return
    }
    let alive = true
    const refresh = refreshDetailNext.current
    refreshDetailNext.current = false
    setDetail((d) => (d?.phase === 'ready' && d.pull.number === selected ? d : { phase: 'loading', number: selected }))
    void (async () => {
      try {
        const pull = await call('forge.pull', { root, number: selected, ...(refresh ? { refresh: true } : {}) })
        if (alive) setDetail({ phase: 'ready', pull })
      } catch (e) {
        if (!alive) return
        const msg = pullsErrorKind(errorCode(e)) === 'old-daemon' ? OLD_DAEMON_PULLS : errorText(e)
        setDetail({ phase: 'error', number: selected, message: msg })
      }
    })()
    return () => {
      alive = false
    }
  }, [root, selected, detailSeq])

  /** Liste et détail relus sans le cache (« Actualiser », après une publication). */
  function refresh() {
    refreshNext.current = true
    setListSeq((n) => n + 1)
    if (selected !== null) {
      refreshDetailNext.current = true
      setDetailSeq((n) => n + 1)
    }
  }

  const shown = useMemo(() => (list.phase === 'ready' ? onlyRepoPulls(list.pulls, status) : { pulls: [], dropped: 0 }), [list, status])
  const current = detail?.phase === 'ready' ? detail.pull : null

  if (list.phase === 'old') {
    return (
      <div className="forge-off" role="status">
        <p>{OLD_DAEMON_PULLS}</p>
      </div>
    )
  }

  return (
    <div className="issues pulls">
      <div className="ifilters-wrap">
        <fieldset className="ifilters" aria-label="Filtres des demandes de fusion" disabled={busy}>
          <label className="field ifield-state">
            <span className="lbl">État</span>
            <select value={filters.state} onChange={(e) => setFilters((f) => ({ ...f, state: e.target.value as PullStateFilter }))}>
              {PULL_STATE_FILTERS.map((s) => (
                <option key={s} value={s}>
                  {PULL_FILTER_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
          <label className="optrow imine">
            <input type="checkbox" checked={filters.mine} onChange={(e) => setFilters((f) => ({ ...f, mine: e.target.checked }))} />
            <span>Les miennes</span>
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
          </label>
          <button type="button" className="btn ghost ictl" onClick={refresh} title="Redemander à la forge (sans le cache)">
            Actualiser
          </button>
        </fieldset>
      </div>
      <section className="ilist" aria-label="Liste des demandes de fusion">
        {list.phase === 'loading' && <p className="hint">Chargement des demandes de fusion…</p>}
        {list.phase === 'error' && (
          <p className="inline-err" role="alert">
            Liste indisponible : {list.message}
          </p>
        )}
        {list.phase === 'ready' && shown.pulls.length === 0 && <p className="empty-note">Aucune demande de fusion pour ces filtres.</p>}
        {list.phase === 'ready' && shown.pulls.length > 0 && (
          <ul className="irows" role="list" aria-describedby={`${uid}-n`}>
            {shown.pulls.map((p) => (
              <li key={p.number}>
                <button
                  type="button"
                  className="irow"
                  disabled={busy}
                  aria-current={selected === p.number ? 'true' : undefined}
                  onClick={() => setSelected(p.number)}
                >
                  <span className="irow-1">
                    <span className="inum mono">#{p.number}</span>
                    <span className="ititle">{oneLine(p.title)}</span>
                  </span>
                  <span className="irow-2">
                    <ForgeBadge b={pullStateLabel(p.state, p.draft)} />
                    {reviewDecisionLabel(p.review_decision) && <ForgeBadge b={reviewDecisionLabel(p.review_decision)!} />}
                    <ForgeBadge b={checksLabel(p.checks)} />
                    <span className="hint mono pbranch" title={`${oneLine(p.head?.branch ?? '')} → ${oneLine(p.base?.branch ?? '')}`}>
                      {oneLine(p.head?.branch ?? '')}
                    </span>
                    <span className="hint">{pullCounters(p)}</span>
                    <span className="hint iago" title={p.updated_at ? `mise à jour ${relativeTime(p.updated_at)}` : undefined}>
                      {shortAgo(p.updated_at)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {list.phase === 'ready' && (
          <p className="hint" id={`${uid}-n`}>
            {shown.pulls.length} demande{shown.pulls.length > 1 ? 's' : ''}
            {list.truncated ? ' (liste coupée : affine les filtres)' : ''}
            {shown.dropped > 0 ? ` · ${shown.dropped} élément${shown.dropped > 1 ? 's' : ''} hors du dépôt écarté${shown.dropped > 1 ? 's' : ''}` : ''}
          </p>
        )}
      </section>
      <section className="idetail" aria-label="Détail de la demande de fusion" aria-live="polite">
        {selected === null && <p className="empty">Choisis une demande de fusion pour voir son détail.</p>}
        {detail?.phase === 'loading' && <p className="hint">Chargement de la demande #{detail.number}…</p>}
        {detail?.phase === 'error' && (
          <p className="inline-err" role="alert">
            Demande #{detail.number} indisponible : {detail.message}
          </p>
        )}
        {current && (
          <PullDetailView
            key={current.number}
            root={root}
            pull={current}
            canReview={supportsForgeReview(status) && current.state === 'open'}
            reviewSupported={supportsForgeReview(status)}
            onLink={onLink}
            onBusy={busyChange}
            onPull={(pull) => setDetail({ phase: 'ready', pull })}
            onPublished={refresh}
          />
        )}
      </section>
    </div>
  )
}

function useForgeDraft(key: string): [ForgeDraft, (a: ForgeDraftAction) => void] {
  const draft = useSyncExternalStore(forgeDrafts.subscribe, () => forgeDrafts.get(key))
  return [draft, (a) => forgeDrafts.dispatch(key, a)]
}

function PullDetailView({
  root,
  pull,
  canReview,
  reviewSupported,
  onLink,
  onBusy,
  onPull,
  onPublished,
}: {
  root: string
  pull: PullDetail
  /** Revue publiée (ou peut-être) : liste et détail relus sans cache. */
  onPublished: () => void
  /** Demande ouverte et démon qui sait publier une revue. */
  canReview: boolean
  reviewSupported: boolean
  onLink: (url: string) => void
  onBusy: (busy: boolean) => void
  /** Demande relue (« Recharger la demande de fusion »). */
  onPull: (p: PullDetail) => void
}) {
  const [tab, setTab] = useState<DetailTab>('desc')
  /** Raccourcis du lecteur (onglet « Fichiers ») : écoutés sur tout le détail, le focus pouvant être sur l'onglet lui-même. */
  const fileKeysRef = useRef<((e: KeyboardEvent<HTMLElement>) => void) | null>(null)
  const [publish, setPublish] = useState<PublishState | null>(null)
  /** Confirmation de la revue assistée (lot 19), affichée à la place du détail. */
  const [assist, setAssist] = useState<ReviewTarget | null>(null)
  const aiReview = useAiReview()
  /** Bouton « Revue assistée » : le focus y revient quand on annule la confirmation. */
  const assistBtn = useRef<HTMLButtonElement>(null)
  const refocusAssist = useRef(false)
  useEffect(() => {
    if (assist || !refocusAssist.current) return
    refocusAssist.current = false
    assistBtn.current?.focus()
  }, [assist])
  const [draft, dispatch] = useForgeDraft(forgeDraftKey(root, pull.number))
  const files = useMemo(() => pullDiffFiles(pull.files), [pull.files])
  const head = validHeadSha(pull.head?.sha)

  // Tête lue (adoptée si le brouillon n'a pas de commentaire de ligne) ; fichiers absents signalés.
  useEffect(() => {
    if (head) dispatch({ type: 'head', sha: head })
    dispatch({ type: 'files', paths: files.map((f) => f.path) })
  }, [head, files])

  const runs = Array.isArray(pull.check_runs) ? pull.check_runs : []
  const threads = Array.isArray(pull.review_threads) ? pull.review_threads : []
  const open = threads.filter((t) => !t.resolved).length
  const stale = draft.comments.filter((c) => c.stale)
  const moved = draft.comments.filter((c) => !c.stale && movedLabel(c))
  const n = activeForgeComments(draft).length
  const decision = reviewDecisionLabel(pull.review_decision)
  const url = safeHttps(pull.url)

  if (assist && aiReview) {
    return (
      <article className="iissue pdetail" aria-label={`Revue assistée de la demande #${pull.number}`}>
        <h3 className="ih">
          Revue assistée de <span className="inum mono">#{pull.number}</span> {oneLine(pull.title)}
        </h3>
        <AiReviewConfirm
          target={assist}
          deps={aiReview}
          onBusy={onBusy}
          onCancel={() => {
            refocusAssist.current = true
            setAssist(null)
          }}
          onDone={() => setAssist(null)}
        />
      </article>
    )
  }

  if (publish) {
    return (
      <PublishReview
        root={root}
        pull={pull}
        files={files}
        draft={draft}
        dispatch={dispatch}
        state={publish}
        setState={setPublish}
        onLink={onLink}
        onBusy={onBusy}
        onPull={onPull}
        onPublished={onPublished}
      />
    )
  }

  return (
    <article className="iissue pdetail" onKeyDown={tab === 'files' ? (e) => fileKeysRef.current?.(e) : undefined}>
      <h3 className="ih">
        <span className="inum mono">#{pull.number}</span> {oneLine(pull.title)}
      </h3>
      <div className="imeta">
        <ForgeBadge b={pullStateLabel(pull.state, pull.draft)} />
        {decision && <ForgeBadge b={decision} />}
        <ForgeBadge b={checksLabel(pull.checks)} />
        <IssueLabels labels={pull.labels ?? []} />
        {pull.author && <span className="hint">par {oneLine(pull.author)}</span>}
        <span className="hint mono">
          {oneLine(pull.head?.branch ?? '')} → {oneLine(pull.base?.branch ?? '')}
        </span>
        <span className="hint">{pullCounters(pull)}</span>
        {pull.updated_at && <span className="hint">mise à jour {relativeTime(pull.updated_at)}</span>}
      </div>
      <div className="iacts">
        {url && (
          <button type="button" className="btn sm ghost" onClick={() => onLink(url)} title={url}>
            Voir sur la forge ↗
          </button>
        )}
        <AiReviewButton
          target={() => (head ? { kind: 'pull', root, pull, files, listTruncated: !!pull.files_truncated } : null)}
          onClick={setAssist}
          buttonRef={assistBtn}
        />
      </div>
      <div className="ptabs" role="tablist" aria-label="Vues de la demande">
        {(
          [
            ['desc', 'Description'],
            ['checks', `Vérifications (${runs.length})`],
            ['threads', `Fils de revue (${threads.length}${open ? `, ${open} non résolu${open > 1 ? 's' : ''}` : ''})`],
            ['files', `Fichiers (${files.length})`],
          ] as const
        ).map(([id, label]) => (
          <button key={id} type="button" role="tab" className="ptab" aria-selected={tab === id} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'desc' && <ForgeMarkdown text={pull.body} idPrefix={`pull-${pull.number}`} onLink={onLink} truncated={pull.truncated} />}
      {tab === 'checks' && <ChecksList runs={runs} onLink={onLink} />}
      {tab === 'threads' && (
        <>
          {pull.review_threads_truncated && (
            <p className="ag-cut" role="note">
              Plus de 100 fils de revue : les suivants ne sont visibles que sur la forge.
            </p>
          )}
          <ThreadsList threads={threads} number={pull.number} onLink={onLink} />
        </>
      )}
      {tab === 'files' && pull.files_truncated && (
        <p className="ag-cut" role="note">
          Liste des fichiers coupée par GitHub (3 000 au plus) : les suivants ne sont visibles que sur la forge.
        </p>
      )}
      {tab === 'files' && (
        <PullFiles root={root} pull={pull} files={files} draft={draft} dispatch={dispatch} canReview={canReview} keysRef={fileKeysRef} />
      )}
      <section className="fdraft" aria-label="Brouillon de revue de la forge">
        <div className="fdraft-h">
          <b>Brouillon de revue de la forge</b>
          <span className="fdest" role="note">
            <span aria-hidden="true">⚠ </span>
            {FORGE_DESTINATION}
          </span>
          <span className="hint">
            {n} commentaire{n > 1 ? 's' : ''} de ligne{draft.general.trim() ? ' · commentaire général' : ''} · distinct du brouillon de revue pour
            Claude
          </span>
        </div>
        {!reviewSupported && <p className="hint">Le démon ne sait pas encore publier de revue : mets orchd à jour (lecture seule).</p>}
        {reviewSupported && pull.state !== 'open' && <p className="hint">Demande fermée : plus de revue possible.</p>}
        {stale.length > 0 && (
          <div className="stale-comments" role="note">
            <p className="hint">
              {stale.length} commentaire{stale.length > 1 ? 's' : ''} sur une ligne (ou un fichier) qui n’est plus dans le diff : non publié
              {stale.length > 1 ? 's' : ''}. Supprime-les ou recopie-les sur la bonne ligne.
            </p>
            {stale.map((c) => (
              <div key={c.id} className="cbox">
                <div className="who">
                  <span className="mono">
                    {c.path}:{c.line} ({c.side === 'new' ? 'nouvelle' : 'ancienne'} version) · <code>{c.lineText}</code>
                  </span>
                  <button type="button" className="btn sm ghost" aria-label={`Supprimer le commentaire de ${c.path}:${c.line}`} onClick={() => dispatch({ type: 'delete', id: c.id })}>
                    ×
                  </button>
                </div>
                <div className="ctext">{c.text}</div>
              </div>
            ))}
          </div>
        )}
        {moved.length > 0 && (
          <ul className="fmoved" role="list" aria-label="Commentaires replacés">
            {moved.map((c) => (
              <li key={c.id} className="hint">
                <span className="mono">{c.path}</span> : {movedLabel(c)} (même texte de ligne : <code>{c.lineText}</code>)
              </li>
            ))}
          </ul>
        )}
        {canReview && (
          <div className="iacts">
            <button type="button" className="btn sm pri" onClick={() => setPublish({ phase: 'compose' })}>
              Publier la revue…
            </button>
          </div>
        )}
      </section>
    </article>
  )
}

function ChecksList({ runs, onLink }: { runs: PullDetail['check_runs']; onLink: (url: string) => void }) {
  if (runs.length === 0) return <p className="hint">Aucune vérification de CI.</p>
  return (
    <ul className="pchecks" role="list">
      {runs.map((r, i) => {
        const b = checkRunLabel(r.state)
        const d = checkDuration(r.started_at, r.completed_at)
        const url = safeHttps(r.url)
        return (
          <li key={`${r.name}-${i}`}>
            <ForgeBadge b={b} />
            <span className="pcheck-n">
              {r.workflow ? <span className="hint">{oneLine(r.workflow)} · </span> : null}
              {oneLine(r.name ?? '')}
            </span>
            {d && <span className="hint">{d}</span>}
            {url && (
              <button type="button" className="btn sm ghost" onClick={() => onLink(url)} title={url}>
                Voir ↗
              </button>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function ThreadsList({ threads, number, onLink }: { threads: PullDetail['review_threads']; number: number; onLink: (url: string) => void }) {
  if (threads.length === 0) return <p className="hint">Aucun fil de revue.</p>
  return (
    <div className="pthreads">
      <p className="hint">Fils de revue existants, en lecture seule (écrits sur la forge : contenu non fiable).</p>
      {threads.map((t, i) => (
        <section key={i} className="pthread" aria-label={`Fil sur ${t.path}`}>
          <div className="pthread-h">
            <ForgeBadge
              b={
                t.resolved
                  ? { glyph: '✓', text: 'résolu', tone: 'ok', label: 'Fil résolu' }
                  : { glyph: '○', text: 'non résolu', tone: 'pend', label: 'Fil non résolu' }
              }
            />
            <span className="mono">
              {t.path}
              {typeof t.line === 'number' ? `:${t.line}` : ' (version dépassée)'}
              {t.side === 'old' ? ' (ancienne version)' : ''}
            </span>
            {t.outdated && <ForgeBadge b={{ glyph: '⌛', text: 'périmé', tone: 'muted', label: 'Fil sur une version dépassée du diff' }} />}
          </div>
          {(t.comments ?? []).map((c, j) => (
            <div key={j} className="cbox">
              <div className="who">
                <span>
                  {c.author ? oneLine(c.author) : 'inconnu'}
                  {c.created_at ? ` · ${relativeTime(c.created_at)}` : ''}
                </span>
              </div>
              <ForgeMarkdown text={c.body} idPrefix={`pull-${number}-t${i}-c${j}`} onLink={onLink} empty="(vide)" what="du commentaire" />
            </div>
          ))}
          {t.comments_truncated && <p className="hint">Plus de 50 commentaires dans ce fil : les suivants sont sur la forge.</p>}
        </section>
      ))}
    </div>
  )
}

function PullFiles({
  root,
  pull,
  files,
  draft,
  dispatch,
  canReview,
  keysRef,
}: {
  root: string
  pull: PullDetail
  files: ReturnType<typeof pullDiffFiles>
  draft: ForgeDraft
  dispatch: (a: ForgeDraftAction) => void
  canReview: boolean
  /** Reçoit le gestionnaire des raccourcis, posé par le détail de la demande. */
  keysRef: { current: ((e: KeyboardEvent<HTMLElement>) => void) | null }
}) {
  const [listMode] = useListMode()
  const [selected, setSelected] = useState<string | null>(() => firstFile(files, listMode))
  const [fileDiff, setFileDiff] = useState<{ path: string; sha: string; data: FileDiff } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const nav = useFileNav(files, selected)
  const onKey = fileKeys(files, selected, setSelected, listRef, { nav })
  useLayoutEffect(() => {
    keysRef.current = onKey
  })
  useLayoutEffect(
    () => () => {
      keysRef.current = null
    },
    [keysRef],
  )
  const sha = pull.head?.sha ?? ''

  useEffect(() => {
    if (!selected) {
      setFileDiff(null)
      return
    }
    let alive = true
    setError(null)
    call('forge.pullFile', { root, number: pull.number, path: selected })
      .then((data) => alive && setFileDiff({ path: selected, sha, data }))
      .catch((e: unknown) => {
        if (!alive) return
        setFileDiff(null)
        setError(pullsErrorKind(errorCode(e)) === 'old-daemon' ? OLD_DAEMON_PULLS : pullFileErrorText(errorText(e)))
      })
    return () => {
      alive = false
    }
  }, [root, pull.number, selected, sha])

  const rows = useMemo(() => (fileDiff && fileDiff.path === selected ? diffRows(fileDiff.data) : []), [fileDiff, selected])
  useEffect(() => {
    if (fileDiff && fileDiff.path === selected && !fileDiff.data.binary && !fileDiff.data.too_large) {
      dispatch({ type: 'reanchor', path: fileDiff.path, rows })
    }
  }, [rows])

  const file = files.find((f) => f.path === selected) ?? null
  const full = activeForgeComments(draft).length >= MAX_FORGE_COMMENTS

  return (
    <div className="diffpane pfiles">
      <DiffFileList
        files={files}
        selected={selected}
        onSelect={setSelected}
        listRef={listRef}
        nav={nav}
        label="Fichiers de la demande"
        empty="Aucun fichier."
        comments={(path) => draft.comments.filter((c) => c.path === path && !c.stale).length}
        head={<span className="lbl">{pullCounters(pull)}</span>}
      />
      <div className="dmain">
        <div className="dhead">
          {file && (
            <>
              <span className="path">
                {file.old_path ? `${file.old_path} → ` : ''}
                {file.path}
              </span>
              <FileHeadCounts file={file} fileDiff={fileDiff?.path === file.path ? fileDiff.data : null} />
              <span className="hint">
                {STATUS_LABELS[file.status]}
                {canReview ? ' · clique sur + pour commenter (brouillon de la forge)' : ''}
              </span>
            </>
          )}
        </div>
        <div className="dscroll" tabIndex={0} aria-label={file ? `Diff de ${file.path}` : 'Diff'}>
          {error && (
            <p className="inline-err pad" role="alert">
              {error}
            </p>
          )}
          {file && fileDiff?.path === file.path && fileDiff.data.binary && <p className="empty">Fichier binaire : pas de diff ligne à ligne.</p>}
          {file && fileDiff?.path === file.path && fileDiff.data.too_large && <p className="empty">Fichier trop volumineux pour être affiché ici.</p>}
          {file && !fileDiff && !error && <p className="empty">Chargement…</p>}
          {rows.length > 0 && selected && (
            <DiffTable
              rows={rows}
              draft={draft}
              review={dispatch}
              full={full}
              readOnly={!canReview}
              pendingLabel={`Toi · en attente · ${FORGE_DESTINATION.toLowerCase()}`}
              maxChars={MAX_FORGE_TEXT}
              commentsAt={(a) => forgeCommentsAt(draft, selected, a).map((c) => ({ id: c.id, line: c.line, text: c.text }))}
              editingAt={(a) => forgeEditingAt(draft, selected, a)}
              onEdit={(a, lineText) => dispatch({ type: 'edit', path: selected, anchor: a, lineText })}
            />
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * « Publier la revue… » : événement et commentaire général, puis aperçu figé
 * (exactement ce qui part) et « Publier sur GitHub ». Rien n'est envoyé avant
 * ce clic.
 */
function PublishReview({
  root,
  pull,
  files,
  draft,
  dispatch,
  state,
  setState,
  onLink,
  onBusy,
  onPull,
  onPublished,
}: {
  root: string
  pull: PullDetail
  /** Revue publiée, ou résultat incertain : demande et liste relues sans cache. */
  onPublished: () => void
  files: ReturnType<typeof pullDiffFiles>
  draft: ForgeDraft
  dispatch: (a: ForgeDraftAction) => void
  state: PublishState
  setState: (s: PublishState | null) => void
  onLink: (url: string) => void
  onBusy: (busy: boolean) => void
  onPull: (p: PullDetail) => void
}) {
  const built = useMemo(() => buildForgeReview(draft, pull.number, files), [draft, pull.number, files])
  const [reloading, setReloading] = useState<string | null>(null)
  const [reloadError, setReloadError] = useState<string | null>(null)
  const byId = useMemo(() => new Map(draft.comments.map((c) => [c.id, c])), [draft.comments])
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  /** Seule écriture vers la forge : appelée uniquement par le bouton « Publier sur GitHub ». */
  async function publishConfirmed() {
    if (state.phase !== 'confirm') return
    onBusy(true)
    try {
      const out = await publishForgeReview(state, root, {
        send: (params) => call('forge.submitReview', params),
        toError: (e) =>
          e instanceof CallError ? { code: e.failure.code, message: e.failure.message, data: e.failure.data } : { code: null, message: errorText(e) },
        describe: (e) => (e.code === null ? e.message : errorText(new CallError({ code: e.code, message: e.message }))),
        onState: (s) => alive.current && setState(s),
      })
      if (out.phase === 'done') dispatch({ type: 'published', ids: state.ids })
      // Revue publiée (ou peut-être) : la demande, ses fils et la liste ont changé sur la forge.
      if (out.phase === 'done' || (out.phase === 'error' && out.uncertain)) onPublished()
    } finally {
      onBusy(false)
    }
  }

  /**
   * Conflit de tête : demande relue, puis chaque fichier commenté. La nouvelle
   * tête n'est adoptée (et les commentaires replacés ou signalés) qu'une fois
   * tout relu ; une panne garde l'ancienne tête et le brouillon tel quel.
   */
  async function reload() {
    setReloading('Lecture de la demande de fusion et des lignes commentées…')
    setReloadError(null)
    onBusy(true)
    try {
      const out = await reloadForReview(forgeDrafts.get(forgeDraftKey(root, pull.number)), {
        fetchPull: () => call('forge.pull', { root, number: pull.number, refresh: true }),
        fetchFile: (path, refresh) => call('forge.pullFile', { root, number: pull.number, path, ...(refresh ? { refresh: true } : {}) }),
      })
      dispatch(out.action)
      if (!alive.current) return
      onPull(out.pull)
      setState({ phase: 'compose' })
    } catch (e) {
      if (alive.current) setReloadError(`Rechargement impossible (${errorText(e)}) : le brouillon garde l’ancienne tête ; réessaie.`)
    } finally {
      onBusy(false)
      if (alive.current) setReloading(null)
    }
  }

  const stale = draft.comments.filter((c) => c.stale)
  const doneUrl = state.phase === 'done' ? safeHttps(state.url) : null

  return (
    <article className="iissue ppublish" aria-label="Publier la revue">
      <h3 className="ih">
        Publier la revue de <span className="inum mono">#{pull.number}</span> {oneLine(pull.title)}
      </h3>
      <p className="fdest big" role="note">
        <span aria-hidden="true">⚠ </span>
        {FORGE_DESTINATION}
        {' · '}
        <span className="mono">{oneLine(`${pull.url ?? ''}`)}</span>
      </p>
      {state.phase === 'compose' && (
        <>
          <fieldset className="pevents">
            <legend className="lbl">Décision</legend>
            {FORGE_REVIEW_EVENTS.map((ev) => (
              <label key={ev} className="optrow">
                <input type="radio" name="forge-event" value={ev} checked={draft.event === ev} onChange={() => dispatch({ type: 'event', event: ev })} />
                <span>{EVENT_LABELS[ev]}</span>
              </label>
            ))}
          </fieldset>
          <label className="field">
            <span className="lbl">
              Commentaire général (Markdown, mis en forme par GitHub){draft.event !== 'approve' ? ' : obligatoire pour cette décision' : ' : facultatif'}
            </span>
            <textarea value={draft.general} rows={5} onChange={(e) => dispatch({ type: 'general', text: e.target.value })} />
          </label>
          <p className="hint">
            {built.payload.comments.length} commentaire{built.payload.comments.length > 1 ? 's' : ''} de ligne
            {stale.length > 0 ? ` · ${stale.length} sur des lignes disparues, non publié${stale.length > 1 ? 's' : ''}` : ''}
          </p>
          {built.problem && (
            <p className="inline-err" role="alert">
              {built.problem}
            </p>
          )}
          <div className="iacts">
            <button type="button" className="btn ghost" onClick={() => setState(null)}>
              Retour au brouillon
            </button>
            <button
              type="button"
              className="btn pri"
              disabled={!!built.problem}
              onClick={() => {
                const s = confirmStep(built)
                if (s) setState(s)
              }}
            >
              Voir l’aperçu…
            </button>
          </div>
        </>
      )}
      {(state.phase === 'confirm' || state.phase === 'publishing') && (
        <>
          <section className="ppreview" aria-label="Aperçu exact de ce qui sera publié">
            <p>
              <b>Décision :</b> {EVENT_LABELS[state.payload.event]}
            </p>
            <p className="lbl">Commentaire général</p>
            <pre className="forge-pre">{state.payload.body || '(aucun)'}</pre>
            <p className="lbl">
              Commentaires de ligne ({state.payload.comments.length})
            </p>
            {state.payload.comments.length === 0 && <p className="hint">(aucun)</p>}
            <ol className="ppreview-c">
              {state.payload.comments.map((c, i) => {
                const d = byId.get(state.ids[i] ?? -1)
                return (
                  <li key={i}>
                    <span className="mono">
                      {c.path}:{c.line} ({c.side === 'new' ? 'nouvelle' : 'ancienne'} version)
                    </span>
                    {d && movedLabel(d) && <span className="hint"> · replacé : {movedLabel(d)}</span>}
                    {d && <code className="pline">{d.lineText}</code>}
                    <pre className="forge-pre">{c.body}</pre>
                  </li>
                )
              })}
            </ol>
            <p className="hint">
              Tête de la demande : <span className="mono">{state.payload.expected_head_sha.slice(0, 12)}</span> ; si elle a changé, rien n’est publié.
            </p>
          </section>
          <div className="forget wt-confirm" role="group" aria-label="Confirmation">
            <span>
              Publier cette revue sur GitHub ? Elle sera <b>visible par tous</b> ceux qui voient la demande de fusion.
            </span>
          </div>
          <div className="iacts">
            <button type="button" className="btn ghost" disabled={state.phase === 'publishing'} onClick={() => setState({ phase: 'compose' })} autoFocus>
              Modifier
            </button>
            <button type="button" className="btn pri" disabled={state.phase === 'publishing'} onClick={() => void publishConfirmed()}>
              {state.phase === 'publishing' ? 'Publication…' : 'Publier sur GitHub'}
            </button>
          </div>
        </>
      )}
      {state.phase === 'done' && (
        <>
          <p role="status">
            <span aria-hidden="true">✓ </span>Revue publiée.
          </p>
          <div className="iacts">
            {doneUrl && (
              <button type="button" className="btn sm ghost" onClick={() => onLink(doneUrl)} title={doneUrl}>
                Voir sur la forge ↗
              </button>
            )}
            <button type="button" className="btn" onClick={() => setState(null)}>
              Retour à la demande
            </button>
          </div>
        </>
      )}
      {state.phase === 'conflict' && (
        <>
          <p className="inline-err" role="alert">
            La demande de fusion a changé depuis son ouverture (nouveaux commits) : rien n’a été publié. Ton brouillon est gardé ; recharge la
            demande pour revérifier les lignes commentées.
          </p>
          <div className="iacts">
            <button type="button" className="btn ghost" disabled={!!reloading} onClick={() => setState(null)}>
              Retour au brouillon
            </button>
            <button type="button" className="btn pri" disabled={!!reloading} onClick={() => void reload()}>
              Recharger la demande de fusion
            </button>
          </div>
          {reloading && (
            <p className="hint" role="status">
              <span className="spin" aria-hidden="true" /> {reloading}
            </p>
          )}
          {reloadError && (
            <p className="inline-err" role="alert">
              {reloadError}
            </p>
          )}
        </>
      )}
      {state.phase === 'rejected' && (
        <>
          <p className="inline-err" role="alert">
            Revue refusée, rien n’a été publié : {state.message}
            {state.commentId !== null && byId.get(state.commentId) && (
              <>
                {' '}
                (commentaire sur{' '}
                <span className="mono">
                  {byId.get(state.commentId)!.path}:{byId.get(state.commentId)!.line}
                </span>
                )
              </>
            )}
          </p>
          <div className="iacts">
            <button type="button" className="btn" onClick={() => setState({ phase: 'compose' })}>
              Modifier
            </button>
          </div>
        </>
      )}
      {state.phase === 'error' && (
        <>
          <p className="inline-err" role="alert">
            {state.uncertain
              ? `Résultat incertain (${state.message}) : la revue a pu être publiée. Vérifie sur la forge avant de republier.`
              : `Publication impossible : ${state.message}`}
          </p>
          <div className="iacts">
            <button type="button" className="btn" onClick={() => setState({ phase: 'compose' })}>
              Modifier
            </button>
          </div>
        </>
      )}
    </article>
  )
}
