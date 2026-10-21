/**
 * Onglet « Commits » (v0.3, lot 9) : commits de la branche de la session
 * depuis la base du diff, ou derniers commits de `HEAD` (choix du démon, ou
 * mode forcé par l'utilisateur), puis fichiers et diff du commit choisi dans
 * le lecteur de l'onglet Diff (mêmes raccourcis, même commentaire par ligne,
 * même brouillon de revue : commentaires `kind: "commit"`).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'

import type { CommitDiff, CommitRange, CommitsList, DiffFile, FileDiff, Session } from '../../../shared/protocol'
import { call, errorCode, errorText } from '../api'
import {
  commitAriaLabel,
  commitsErrorText,
  commitsMemoryFor,
  countsLabel,
  emptyLabel,
  filesLabel,
  hasCounts,
  NO_STATS,
  statsOf,
  fullDate,
  otherRange,
  pickCommit,
  rangeLabel,
  stepCommit,
  toggleRangeLabel,
} from '../state/commits'
import { STATUS_LABELS, diffRows, skippedCount, sortFiles, totals } from '../state/diff'
import { relativeTime } from '../state/format'
import {
  MAX_COMMENTS,
  activeComments,
  commitComments,
  commitCommentsAt,
  editingAt,
  shortSha,
  type ReviewAction,
  type ReviewDraft,
} from '../state/review'
import { useNotifiedReload } from '../notifiedReload'
import { DiffFileList, DiffTable, FileHeadCounts, fileKeys, useFileNav } from './DiffReader'
import { ReviewBar } from './ReviewBar'

export interface CommitsState {
  list: CommitsList | null
  loading: boolean
  error: string | null
}

/** Dernière liste lue par session : affichée tout de suite au retour sur l'onglet, puis relue. */
const listCache = new Map<string, CommitsList>()

/**
 * Liste des commits de la session (l'onglet est monté seulement quand il est
 * affiché) : la dernière liste connue tout de suite, une lecture au montage
 * et à chaque changement de mode, puis une relecture sur `session.diff_changed`
 * (`seq`, avec anti-rebond) avec le même mode demandé (`range` : forcé, ou
 * `null` pour le choix automatique).
 */
export function useSessionCommits(sessionId: string, seq: number, range: CommitRange | null): CommitsState & { reload: () => void } {
  const [state, setState] = useState<CommitsState>(() => ({ list: listCache.get(sessionId) ?? null, loading: false, error: null }))
  const current = useRef({ sessionId, range })
  current.current = { sessionId, range }
  /** Numéro de la dernière lecture : une réponse plus ancienne n'écrase pas une plus récente. */
  const gen = useRef(0)

  const load = useCallback(async () => {
    const { sessionId: id, range: r } = current.current
    const mine = ++gen.current
    setState((s) => ({ ...s, loading: true }))
    try {
      const list = await call('sessions.commits', { id, ...(r ? { range: r } : {}) })
      if (mine !== gen.current) return
      listCache.set(id, list)
      setState({ list, loading: false, error: null })
    } catch (e) {
      if (mine !== gen.current) return
      setState((s) => ({ ...s, loading: false, error: commitsErrorText(errorCode(e), errorText(e), 'Historique indisponible') }))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [sessionId, range, load])

  const reload = useNotifiedReload(load, seq, true)
  return { ...state, reload }
}

/** Diff d'un commit (immuable) : gardé par session, 16 commits au plus. */
const commitDiffCache = new Map<string, Map<string, CommitDiff>>()
const MAX_CACHED = 16

function cached(sessionId: string, sha: string): CommitDiff | undefined {
  return commitDiffCache.get(sessionId)?.get(sha)
}

function remember(sessionId: string, d: CommitDiff): void {
  let m = commitDiffCache.get(sessionId)
  if (!m) {
    m = new Map()
    commitDiffCache.set(sessionId, m)
  }
  m.delete(d.sha)
  m.set(d.sha, d)
  for (const k of m.keys()) {
    if (m.size <= MAX_CACHED) break
    m.delete(k)
  }
}

export function forgetCommitDiffs(sessionId: string): void {
  commitDiffCache.delete(sessionId)
  listCache.delete(sessionId)
}

export function CommitsView({
  session,
  seq,
  draft,
  review,
  reviewFiles,
  onSent,
  onOpenFile,
  focusCommit,
}: {
  session: Session
  /** Nombre de `session.diff_changed` reçus pour la session (relecture de la liste). */
  seq: number
  draft: ReviewDraft
  review: (a: ReviewAction) => void
  /** Liste du diff du worktree triée, commune aux barres de revue (les commentaires de diff hors de cette liste ne partent pas). */
  reviewFiles: readonly DiffFile[]
  onSent: () => void
  onOpenFile?: (path: string, line: number) => void
  /** Commit et fichier à montrer (clic dans la liste de la revue) ; `n` change à chaque demande. */
  focusCommit?: { sessionId: string; sha: string; path: string; n: number } | null
}) {
  const memo = commitsMemoryFor(session.id)
  const freshFocus = focusCommit && focusCommit.sessionId === session.id && focusCommit.n > memo.focusN ? focusCommit : null
  const [range, setRange] = useState<CommitRange | null>(memo.range)
  const commits = useSessionCommits(session.id, seq, range)
  const list = commits.list
  const [sha, setSha] = useState<string | null>(freshFocus?.sha ?? memo.sha)
  const [path, setPath] = useState<string | null>(freshFocus?.path ?? memo.path)
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(memo.open))
  const [cdiff, setCdiff] = useState<CommitDiff | null>(() => (sha ? (cached(session.id, sha) ?? null) : null))
  const [cdiffError, setCdiffError] = useState<string | null>(null)
  const [fileDiff, setFileDiff] = useState<{ sha: string; path: string; data: FileDiff } | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const clistRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const restoreDiff = useRef<number | null>(freshFocus ? null : memo.diffScroll)
  const restoreList = useRef<number | null>(memo.listScroll)

  useEffect(() => {
    memo.range = range
    memo.sha = sha
    memo.path = path
    memo.open = new Set(open)
  }, [memo, range, sha, path, open])
  useEffect(() => {
    if (!freshFocus) return
    memo.focusN = freshFocus.n
    setSha(freshFocus.sha)
    setPath(freshFocus.path)
  }, [focusCommit?.n])

  // Liste (re)lue : garder le commit choisi s'il y est encore, sinon le premier.
  useEffect(() => {
    if (!list) return
    const next = pickCommit(list.commits, sha)
    if (next !== sha) {
      setSha(next)
      setPath(null)
    }
  }, [list])

  useLayoutEffect(() => {
    if (!list || restoreList.current === null || !clistRef.current) return
    clistRef.current.scrollTop = restoreList.current
    restoreList.current = null
  }, [list])

  // Fichiers du commit choisi (immuables : gardés en cache).
  useEffect(() => {
    setCdiffError(null)
    if (!sha) {
      setCdiff(null)
      return
    }
    const hit = cached(session.id, sha)
    if (hit) {
      setCdiff(hit)
      return
    }
    setCdiff(null)
    let alive = true
    call('sessions.commitDiff', { id: session.id, sha })
      .then((d) => {
        remember(session.id, d)
        if (alive) setCdiff(d)
      })
      .catch((e: unknown) => alive && setCdiffError(commitsErrorText(errorCode(e), errorText(e), 'Fichiers du commit indisponibles')))
    return () => {
      alive = false
    }
  }, [session.id, sha])

  const files = useMemo(() => (cdiff && cdiff.sha === sha ? sortFiles(cdiff.files) : []), [cdiff, sha])
  const nav = useFileNav(files, path)

  useEffect(() => {
    if (!cdiff || cdiff.sha !== sha) return
    if (path && files.some((f) => f.path === path)) return
    setPath(nav.first)
  }, [files])

  const file: DiffFile | null = files.find((f) => f.path === path) ?? null

  useEffect(() => {
    setFileError(null)
    if (!sha || !file) {
      setFileDiff(null)
      return
    }
    let alive = true
    const p = file.path
    call('sessions.commitDiffFile', { id: session.id, sha, path: p })
      .then((data) => alive && setFileDiff({ sha, path: p, data }))
      .catch((e: unknown) => {
        if (!alive) return
        setFileDiff(null)
        setFileError(commitsErrorText(errorCode(e), errorText(e), 'Diff du fichier indisponible'))
      })
    return () => {
      alive = false
    }
  }, [session.id, sha, file?.path])

  const rows = useMemo(
    () => (fileDiff && fileDiff.sha === sha && fileDiff.path === path ? diffRows(fileDiff.data) : []),
    [fileDiff, sha, path],
  )

  useLayoutEffect(() => {
    if (restoreDiff.current === null || rows.length === 0 || !scrollRef.current) return
    scrollRef.current.scrollTop = restoreDiff.current
    restoreDiff.current = null
  }, [rows])

  /** Diff de fichier du commit et du fichier choisis (pas celui d'un commit précédent encore en mémoire). */
  const shown = fileDiff && file && fileDiff.sha === sha && fileDiff.path === file.path ? fileDiff : null
  const full = activeComments(draft).length >= MAX_COMMENTS
  const onFileKey = fileKeys(files, path, setPath, listRef, { nav })
  const commit = list?.commits.find((c) => c.sha === sha) ?? null
  const t = totals(files)

  function selectCommit(next: string) {
    if (next === sha) return
    setSha(next)
    setPath(null)
    if (scrollRef.current) scrollRef.current.scrollTop = 0
    memo.diffScroll = 0
  }

  function onListKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.ctrlKey || e.metaKey || e.altKey || !list) return
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    if (!(e.target instanceof HTMLElement) || !e.target.classList.contains('cmt-row')) return
    e.preventDefault()
    const next = stepCommit(list.commits, sha, e.key === 'ArrowDown' ? 1 : -1)
    if (!next) return
    selectCommit(next)
    clistRef.current?.querySelector<HTMLElement>(`[data-sha="${next}"]`)?.focus()
  }

  if (commits.error && !list) {
    return (
      <div className="diffpane empty" role="alert">
        <b>{commits.error}</b>
        <button className="btn sm" onClick={commits.reload}>
          Réessayer
        </button>
      </div>
    )
  }
  if (!list) {
    return (
      <div className="diffpane empty" role="status">
        Lecture de l’historique…
      </div>
    )
  }

  const now = Date.now()

  return (
    // j / k écoutés sur tout l'onglet : après un clic sur un commit, le focus est dans la liste des commits, à côté du lecteur.
    <div className="commitspane" onKeyDown={onFileKey}>
      <div
        className="clist"
        ref={clistRef}
        aria-label="Commits"
        onKeyDown={onListKey}
        // Défilement retenu au fil de l'eau : au démontage, les éléments ne sont plus lisibles.
        onScroll={(e) => {
          memo.listScroll = e.currentTarget.scrollTop
        }}
      >
        <div className="fhead">
          <span className="lbl">{rangeLabel(list, session.branch)}</span>
          <span className="hint">
            {list.commits.length} commit{list.commits.length > 1 ? 's' : ''}
            {list.truncated ? ' (les plus récents)' : ''}
            {!statsOf(list) && ` · ${NO_STATS}`}
            {commits.loading && ' · mise à jour…'}
          </span>
          {list.head !== null && (
            <button
              type="button"
              className="linkish"
              onClick={() => {
                setRange(otherRange(list.range))
                restoreList.current = 0
              }}
            >
              {toggleRangeLabel(list, session.branch)}
            </button>
          )}
          {commits.error && (
            <span className="inline-err" role="alert">
              {commits.error}
            </span>
          )}
        </div>
        {list.commits.length === 0 && <p className="hint pad">{emptyLabel(list)}</p>}
        <ul role="list">
          {list.commits.map((c) => {
            const n = commitComments(draft, c.sha).length
            const isOpen = open.has(c.sha)
            return (
              <li key={c.sha} className="citem">
                <button
                  type="button"
                  className="cmt-row"
                  data-sha={c.sha}
                  aria-current={c.sha === sha}
                  aria-label={`${commitAriaLabel(c, now)}${n ? `, ${n} commentaire${n > 1 ? 's' : ''}` : ''}`}
                  onClick={() => selectCommit(c.sha)}
                >
                  <span className="csubj">{c.subject || '(sans message)'}</span>
                  <span className="cmeta" aria-hidden="true">
                    <span className="mono" title={c.sha}>
                      {shortSha(c.sha)}
                    </span>
                    <span className="cauthor">{c.author}</span>
                    <span title={fullDate(c.date)}>{relativeTime(c.date, now)}</span>
                    {hasCounts(c) ? (
                      <>
                        <span>
                          <span className="plus">+{c.additions}</span> <span className="minus">−{c.deletions}</span>
                        </span>
                        <span>{filesLabel(c.files)}</span>
                      </>
                    ) : (
                      <span title={NO_STATS}>compteurs indisponibles</span>
                    )}
                    {c.parents.length > 1 && <span className="chip">fusion</span>}
                    {n > 0 && <span className="ccount">💬{n}</span>}
                  </span>
                </button>
                {c.body && (
                  <details
                    className="cbody"
                    open={isOpen}
                    onToggle={(e) => {
                      const now = (e.currentTarget as HTMLDetailsElement).open
                      if (now === isOpen) return
                      setOpen((s) => {
                        const next = new Set(s)
                        if (now) next.add(c.sha)
                        else next.delete(c.sha)
                        return next
                      })
                    }}
                  >
                    <summary>Message complet</summary>
                    <pre>{c.body}</pre>
                  </details>
                )}
              </li>
            )
          })}
        </ul>
        <p className="hint pad">
          <kbd>↑</kbd> / <kbd>↓</kbd> dans la liste : commit précédent / suivant
        </p>
      </div>
      <div className="diffpane">
        <DiffFileList
          files={files}
          selected={path}
          onSelect={setPath}
          listRef={listRef}
          nav={nav}
          label={commit ? `Fichiers du commit ${shortSha(commit.sha)}` : 'Fichiers du commit'}
          empty={!sha ? 'Choisis un commit.' : cdiff ? 'Aucun fichier changé.' : cdiffError ? '' : 'Chargement…'}
          comments={(p) => (sha ? commitComments(draft, sha).filter((c) => c.path === p).length : 0)}
          head={
            commit ? (
              <>
                <span className="lbl mono" title={commit.sha}>
                  {shortSha(commit.sha)}
                </span>
                {cdiff?.base && (
                  <span className="hint" title={cdiff.base.sha}>
                    {cdiff.base.kind === 'root' ? 'premier commit (contre l’arbre vide)' : `contre ${cdiff.base.ref}`}
                  </span>
                )}
                {cdiff && (
                  <span className="hint">
                    <span className="plus">+{t.additions}</span> <span className="minus">−{t.deletions}</span>
                  </span>
                )}
                {cdiff?.truncated && <span className="chip pend">liste tronquée</span>}
                {cdiff && skippedCount(cdiff.skipped_non_utf8) > 0 && (
                  <span className="hint">{skippedCount(cdiff.skipped_non_utf8)} fichier(s) non UTF-8 ignoré(s)</span>
                )}
                {cdiffError && (
                  <span className="inline-err" role="alert">
                    {cdiffError}
                  </span>
                )}
              </>
            ) : null
          }
        />
        <div className="dmain">
          {file && commit ? (
            <div className="dhead">
              <span className="path">
                {file.old_path ? `${file.old_path} → ` : ''}
                {file.path}
              </span>
              <FileHeadCounts file={file} fileDiff={shown?.data ?? null} />
              <span className="hint">
                {STATUS_LABELS[file.status]} dans « {commit.subject || shortSha(commit.sha)} » · survole une ligne et clique sur + pour
                commenter
              </span>
            </div>
          ) : (
            <div className="dhead" />
          )}
          <div
            className="dscroll"
            ref={scrollRef}
            onScroll={(e) => {
              memo.diffScroll = e.currentTarget.scrollTop
            }}
            tabIndex={0} aria-label={file ? `Diff de ${file.path} dans le commit` : 'Diff du commit'}>
            {fileError && (
              <p className="inline-err pad" role="alert">
                {fileError}
              </p>
            )}
            {file && shown && shown.data.binary && <p className="empty">Fichier binaire : pas de diff ligne à ligne.</p>}
            {file && shown && shown.data.too_large && (
              <p className="empty">Fichier trop volumineux pour être affiché ici.</p>
            )}
            {file && !shown && !fileError && <p className="empty">Chargement…</p>}
            {rows.length > 0 && sha && path && (
              <DiffTable
                rows={rows}
                draft={draft}
                review={review}
                full={full}
                commentsAt={(a) => commitCommentsAt(draft, sha, path, a)}
                editingAt={(a) => editingAt(draft, path, a, sha)}
                onEdit={(a, lineText) => review({ type: 'edit', sha, path, anchor: a, lineText })}
              />
            )}
          </div>
          <ReviewBar
            session={session}
            draft={draft}
            review={review}
            files={reviewFiles}
            onSent={onSent}
            onOpenCommit={(s, p) => {
              setSha(s)
              setPath(p)
            }}
            {...(onOpenFile ? { onOpenFile } : {})}
          />
        </div>
      </div>
    </div>
  )
}
