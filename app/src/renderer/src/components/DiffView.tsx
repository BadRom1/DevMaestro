/**
 * Onglet « Diff » (maquette) : fichiers changés par la session depuis la base
 * de sa branche, diff ligne à ligne, commentaires par ligne envoyés à Claude
 * en une revue (`sessions.sendReview`).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { ErrorCode, type DiffFile, type DiffSummary, type FileDiff, type Session } from '../../../shared/protocol'
import { call, errorCode, errorText } from '../api'
import { STATUS_LABELS, baseLabel, diffRows, skippedCount, sortFiles, totals } from '../state/diff'
import { MAX_COMMENTS, activeComments, commentsAt, editingAt, isDiffComment, type ReviewAction, type ReviewDraft } from '../state/review'
import { useNotifiedReload } from '../notifiedReload'
import { DiffFileList, DiffTable, FileHeadCounts, fileKeys, useFileNav } from './DiffReader'
import { ReviewBar } from './ReviewBar'

/** Fichier choisi et défilement, par session (gardés hors du composant). */
interface DiffMemory {
  selected: string | null
  scroll: number
  /** Dernière demande « Voir le diff » traitée (consommée une seule fois). */
  focusN: number
}

const diffMemory = new Map<string, DiffMemory>()

function diffMemoryFor(id: string): DiffMemory {
  let m = diffMemory.get(id)
  if (!m) {
    m = { selected: null, scroll: 0, focusN: 0 }
    diffMemory.set(id, m)
  }
  return m
}

/** Session oubliée : son état d'onglet n'a plus à être gardé. */
export function forgetDiffMemory(id: string): void {
  diffMemory.delete(id)
}

export const OLD_DAEMON_DIFF = 'Le démon ne sait pas encore calculer le diff : mets orchd à jour.'

export interface DiffState {
  summary: DiffSummary | null
  loading: boolean
  error: string | null
  /** Rechargé à chaque nouvelle liste (même contenu) : sert à relire le fichier affiché. */
  version: number
}

/**
 * Liste des fichiers changés de la session affichée. Chargée seulement une fois
 * l'onglet « Diff » ouvert pour cette session (`active`), puis rechargée sur
 * `session.diff_changed` (avec anti-rebond) pour garder le badge à jour.
 */
export function useSessionDiff(sessionId: string | null, seq: number, active: boolean): DiffState & { reload: () => void } {
  const [state, setState] = useState<DiffState>({ summary: null, loading: false, error: null, version: 0 })
  const current = useRef(sessionId)
  current.current = sessionId

  const load = useCallback(async () => {
    const id = current.current
    if (!id) return
    setState((s) => ({ ...s, loading: true }))
    try {
      const r = await call('sessions.diff', { id })
      if (current.current !== id) return
      setState((s) => ({ summary: r, loading: false, error: null, version: s.version + 1 }))
    } catch (e) {
      if (current.current !== id) return
      const msg = errorCode(e) === ErrorCode.MethodNotFound ? OLD_DAEMON_DIFF : `Diff indisponible : ${errorText(e)}`
      setState((s) => ({ ...s, loading: false, error: msg }))
    }
  }, [])

  useEffect(() => {
    setState({ summary: null, loading: false, error: null, version: 0 })
  }, [sessionId])

  useEffect(() => {
    if (sessionId && active) void load()
  }, [sessionId, active, load])

  const reload = useNotifiedReload(load, seq, active)
  return { ...state, reload }
}

export function DiffView({
  session,
  diff,
  reviewFiles,
  draft,
  review,
  seen,
  onSeen,
  onSent,
  onOpenFile,
  onOpenCommit,
  focusPath,
}: {
  session: Session
  /** Fichier à sélectionner (« Voir le diff » de l'onglet Fichiers) ; `n` change à chaque demande. */
  focusPath?: { sessionId: string; path: string; n: number } | null
  diff: DiffState & { reload: () => void }
  /** Liste du diff triée, commune aux barres de revue de tous les onglets. */
  reviewFiles: readonly DiffFile[]
  draft: ReviewDraft
  review: (a: ReviewAction) => void
  seen: Record<string, boolean>
  onSeen: (path: string, value: boolean) => void
  /** Revue envoyée : retour au terminal. */
  onSent: () => void
  /** Extrait de fichier cliqué dans la liste de la revue : onglet Fichiers. */
  onOpenFile?: (path: string, line: number) => void
  /** Commentaire de commit cliqué dans la liste de la revue : onglet Commits. */
  onOpenCommit?: (sha: string, path: string) => void
}) {
  const files = useMemo(() => sortFiles(diff.summary?.files ?? []), [diff.summary])
  const memo = diffMemoryFor(session.id)
  /** Demande « Voir le diff » pour cette session, pas encore traitée. */
  const freshFocus = focusPath && focusPath.sessionId === session.id && focusPath.n > memo.focusN ? focusPath : null
  const [selected, setSelected] = useState<string | null>(freshFocus?.path ?? memo.selected)
  const scrollRef = useRef<HTMLDivElement>(null)
  const restoreScroll = useRef<number | null>(freshFocus ? null : memo.scroll)
  // Fichier et défilement gardés par session (l'onglet est démonté quand on en change).
  useEffect(() => {
    memo.selected = selected
  }, [memo, selected])
  useEffect(() => {
    const el = scrollRef.current
    return () => {
      if (el) memo.scroll = el.scrollTop
    }
  }, [memo])
  useEffect(() => {
    if (!freshFocus) return
    memo.focusN = freshFocus.n
    setSelected(freshFocus.path)
  }, [focusPath?.n])
  const [fileDiff, setFileDiff] = useState<{ path: string; data: FileDiff } | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const nav = useFileNav(files, selected)

  // Fichier choisi : le premier, ou le même s'il est toujours dans la liste.
  useEffect(() => {
    // Liste pas encore chargée : on garde le fichier demandé.
    if (files.length === 0 && !diff.summary) return
    if (selected && files.some((f) => f.path === selected)) return
    setSelected(nav.first)
  }, [files, selected])

  const file: DiffFile | null = files.find((f) => f.path === selected) ?? null
  const onKey = fileKeys(files, selected, setSelected, listRef, {
    nav,
    onToggleSeen: () => file && onSeen(file.path, !seen[file.path]),
  })

  // Lignes du fichier choisi, relues à chaque nouvelle liste.
  useEffect(() => {
    if (!selected) {
      setFileDiff(null)
      return
    }
    let alive = true
    setFileError(null)
    call('sessions.diffFile', { id: session.id, path: selected })
      .then((data) => alive && setFileDiff({ path: selected, data }))
      .catch((e: unknown) => {
        if (!alive) return
        setFileDiff(null)
        setFileError(errorCode(e) === ErrorCode.MethodNotFound ? OLD_DAEMON_DIFF : `Diff du fichier indisponible : ${errorText(e)}`)
      })
    return () => {
      alive = false
    }
  }, [session.id, selected, diff.version])

  const rows = useMemo(() => (fileDiff && fileDiff.path === selected ? diffRows(fileDiff.data) : []), [fileDiff, selected])

  useLayoutEffect(() => {
    if (restoreScroll.current === null || rows.length === 0 || !scrollRef.current) return
    scrollRef.current.scrollTop = restoreScroll.current
    restoreScroll.current = null
  }, [rows])

  // Lignes rechargées : commentaires (et boîte ouverte) replacés sur leur ligne, ou « ligne modifiée ».
  useEffect(() => {
    if (fileDiff && fileDiff.path === selected && !fileDiff.data.binary && !fileDiff.data.too_large) {
      review({ type: 'reanchor', path: fileDiff.path, rows })
    }
  }, [rows])

  const count = activeComments(draft).length
  const staleHere = selected ? draft.comments.filter(isDiffComment).filter((c) => c.stale && c.path === selected) : []
  const full = count >= MAX_COMMENTS
  const seenCount = files.filter((f) => seen[f.path]).length
  const t = totals(files)

  if (diff.error && !diff.summary) {
    return (
      <div className="diffpane empty" role="alert">
        <b>{diff.error}</b>
        <button className="btn sm" onClick={diff.reload}>
          Réessayer
        </button>
      </div>
    )
  }
  if (!diff.summary) {
    return (
      <div className="diffpane empty" role="status">
        Calcul du diff…
      </div>
    )
  }

  return (
    <div className="diffpane" onKeyDown={onKey}>
      <DiffFileList
        files={files}
        selected={selected}
        onSelect={setSelected}
        listRef={listRef}
        label="Fichiers changés"
        empty="Aucune modification depuis la base."
        seen={seen}
        nav={nav}
        comments={(path) => draft.comments.filter(isDiffComment).filter((c) => c.path === path && !c.stale).length}
        head={
          <>
            <span className="lbl">
              {seenCount}/{files.length} vus
            </span>
            <span className="hint" title={diff.summary.base ? `${diff.summary.base.ref} ${diff.summary.base.sha}` : undefined}>
              {baseLabel(diff.summary.base)}
            </span>
            <span className="hint">
              <span className="plus">
                +{t.additions}
                {t.unknown ? '+?' : ''}
              </span>{' '}
              <span className="minus">
                −{t.deletions}
                {t.unknown ? '−?' : ''}
              </span>
              {diff.loading && ' · mise à jour…'}
            </span>
            {diff.summary.truncated && (
              <span className="chip pend" title="Trop de fichiers changés : le démon n’en donne qu’une partie.">
                liste tronquée
              </span>
            )}
            {skippedCount(diff.summary.skipped_non_utf8) > 0 && (
              <span
                className="hint"
                title={Array.isArray(diff.summary.skipped_non_utf8) ? diff.summary.skipped_non_utf8.join('\n') : undefined}
              >
                {skippedCount(diff.summary.skipped_non_utf8)} fichier{skippedCount(diff.summary.skipped_non_utf8) > 1 ? 's' : ''} non UTF-8
                ignoré{skippedCount(diff.summary.skipped_non_utf8) > 1 ? 's' : ''}
              </span>
            )}
          </>
        }
      />
      <div className="dmain">
        {file ? (
          <div className="dhead">
            <span className="path">
              {file.old_path ? `${file.old_path} → ` : ''}
              {file.path}
            </span>
            <FileHeadCounts file={file} fileDiff={fileDiff?.path === file.path ? fileDiff.data : null} />
            <span className="hint">{STATUS_LABELS[file.status]} · survole une ligne et clique sur + pour commenter</span>
            <label>
              <input type="checkbox" checked={!!seen[file.path]} onChange={(e) => onSeen(file.path, e.target.checked)} /> Vu
            </label>
          </div>
        ) : (
          <div className="dhead" />
        )}
        <div className="dscroll" ref={scrollRef} tabIndex={0} aria-label={file ? `Diff de ${file.path}` : 'Diff'}>
          {fileError && (
            <p className="inline-err pad" role="alert">
              {fileError}
            </p>
          )}
          {file && fileDiff?.path === file.path && fileDiff.data.binary && <p className="empty">Fichier binaire : pas de diff ligne à ligne.</p>}
          {file && fileDiff?.path === file.path && fileDiff.data.too_large && (
            <p className="empty">Fichier trop volumineux pour être affiché ici.</p>
          )}
          {file && !fileDiff && !fileError && <p className="empty">Chargement…</p>}
          {rows.length > 0 && selected && (
            <DiffTable
              rows={rows}
              draft={draft}
              review={review}
              full={full}
              commentsAt={(a) => commentsAt(draft, selected, a)}
              editingAt={(a) => editingAt(draft, selected, a)}
              onEdit={(a, lineText) => review({ type: 'edit', path: selected, anchor: a, lineText })}
            />
          )}
          {staleHere.length > 0 && (
            <section className="stale-comments" aria-label="Commentaires hors diff">
              <h3 className="lbl">Commentaires hors diff</h3>
              <p className="hint">La ligne commentée a changé : ces commentaires ne seront pas envoyés. Supprime-les ou recopie-les sur la bonne ligne.</p>
              {staleHere.map((c) => (
                <div key={c.id} className="cbox">
                  <div className="who">
                    <span>
                      ligne modifiée · ancienne ligne {c.line} ({c.side === 'new' ? 'nouvelle' : 'ancienne'} version) :{' '}
                      <code>{c.lineText}</code>
                    </span>
                    <button
                      type="button"
                      className="btn sm ghost"
                      aria-label={`Supprimer le commentaire de l’ancienne ligne ${c.line}`}
                      onClick={() => review({ type: 'delete', id: c.id })}
                    >
                      ×
                    </button>
                  </div>
                  <div className="ctext">{c.text}</div>
                </div>
              ))}
            </section>
          )}
        </div>
        <ReviewBar
          session={session}
          draft={draft}
          review={review}
          files={reviewFiles}
          onSent={onSent}
          {...(onOpenFile ? { onOpenFile } : {})}
          {...(onOpenCommit ? { onOpenCommit } : {})}
        />
      </div>
    </div>
  )
}
