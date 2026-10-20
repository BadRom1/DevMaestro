/**
 * Onglet « Diff » (maquette) : fichiers changés par la session depuis la base
 * de sa branche, diff ligne à ligne, commentaires par ligne envoyés à Claude
 * en une revue (`sessions.sendReview`).
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'

import { ErrorCode, type DiffFile, type DiffSummary, type FileDiff, type Session } from '../../../shared/protocol'
import { call, errorCode, errorText } from '../api'
import {
  STATUS_LABELS,
  baseLabel,
  countLabel,
  diffRows,
  skippedCount,
  sortFiles,
  stepFile,
  totals,
  type LineAnchor,
} from '../state/diff'
import {
  MAX_COMMENTS,
  MAX_COMMENT_CHARS,
  activeComments,
  buildReview,
  commentsAt,
  hasDraft,
  type ReviewAction,
  type ReviewDraft,
} from '../state/review'
import { ConfirmBar } from './ForgetConfirm'
import { PathLabel } from './common'

const DEBOUNCE_MS = 400

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
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

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

  const reload = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void load(), DEBOUNCE_MS)
  }, [load])

  // Nouvelle session affichée : liste oubliée.
  useEffect(() => {
    setState({ summary: null, loading: false, error: null, version: 0 })
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [sessionId])

  // Onglet ouvert (ou déjà ouvert pour cette session) : chargement immédiat, une seule fois.
  useEffect(() => {
    if (sessionId && active) void load()
  }, [sessionId, active, load])

  // `session.diff_changed` : avec anti-rebond, seulement si le diff de cette session a été ouvert.
  const activeRef = useRef(active)
  activeRef.current = active
  useEffect(() => {
    if (seq > 0 && activeRef.current) reload()
  }, [seq, reload])

  return { ...state, reload }
}

function typing(t: EventTarget | null): boolean {
  return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement
}

/** Boîte de commentaire : son texte vit dans la revue (un rechargement du diff ne le perd pas). */
function CommentBox({
  text,
  onText,
  onSave,
  onCancel,
}: {
  text: string
  onText: (t: string) => void
  onSave: () => void
  onCancel: () => void
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => ref.current?.focus(), [])
  const n = [...text].length
  return (
    <div className="cbox">
      <textarea
        ref={ref}
        value={text}
        placeholder="Ton commentaire sur cette ligne… (Entrée : ajouter, Maj+Entrée : nouvelle ligne, Échap : annuler)"
        aria-label="Commentaire sur la ligne"
        onChange={(e) => onText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            onSave()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            onCancel()
          }
        }}
      />
      <div className="row">
        <span className="hint counter" aria-live="polite">
          {n > MAX_COMMENT_CHARS * 0.9 ? `${n}/${MAX_COMMENT_CHARS}` : ''}
        </span>
        <button type="button" className="btn sm ghost" onClick={onCancel}>
          Annuler
        </button>
        <button type="button" className="btn sm pri" onClick={onSave}>
          Ajouter à la revue
        </button>
      </div>
    </div>
  )
}

export function DiffView({
  session,
  diff,
  draft,
  review,
  seen,
  onSeen,
  onSent,
}: {
  session: Session
  diff: DiffState & { reload: () => void }
  draft: ReviewDraft
  review: (a: ReviewAction) => void
  seen: Record<string, boolean>
  onSeen: (path: string, value: boolean) => void
  /** Revue envoyée : retour au terminal. */
  onSent: () => void
}) {
  const files = useMemo(() => sortFiles(diff.summary?.files ?? []), [diff.summary])
  const [selected, setSelected] = useState<string | null>(null)
  const [fileDiff, setFileDiff] = useState<{ path: string; data: FileDiff } | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  // Fichier choisi : le premier, ou le même s'il est toujours dans la liste.
  useEffect(() => {
    if (selected && files.some((f) => f.path === selected)) return
    setSelected(files[0]?.path ?? null)
  }, [files, selected])

  const file: DiffFile | null = files.find((f) => f.path === selected) ?? null

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

  // Lignes rechargées : commentaires (et boîte ouverte) replacés sur leur ligne, ou « ligne modifiée ».
  useEffect(() => {
    if (fileDiff && fileDiff.path === selected && !fileDiff.data.binary && !fileDiff.data.too_large) {
      review({ type: 'reanchor', path: fileDiff.path, rows })
    }
  }, [rows])

  const built = useMemo(() => buildReview(draft, files), [draft, files])
  const count = activeComments(draft).length
  const waiting = session.status.state === 'waiting' || session.pending.length > 0
  const staleHere = selected ? draft.comments.filter((c) => c.stale && c.path === selected) : []
  const full = count >= MAX_COMMENTS
  const seenCount = files.filter((f) => seen[f.path]).length
  const t = totals(files)

  function move(delta: 1 | -1) {
    const next = stepFile(files, selected, delta)
    if (!next) return
    setSelected(next)
    listRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(next)}"]`)?.focus()
  }

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    if (typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return
    const inList = listRef.current?.contains(e.target as Node)
    if (e.key === 'j' || (inList && e.key === 'ArrowDown')) {
      e.preventDefault()
      move(1)
    } else if (e.key === 'k' || (inList && e.key === 'ArrowUp')) {
      e.preventDefault()
      move(-1)
    }
  }

  async function send() {
    if (!built || !session.alive || waiting || sending) return
    setSending(true)
    setSendError(null)
    try {
      await call('sessions.sendReview', {
        id: session.id,
        comments: built.comments,
        ...(built.general ? { general: built.general } : {}),
      })
      // Seuls les commentaires envoyés partent ; les autres restent avec leur avertissement.
      review({ type: 'sent', ids: built.ids, general: !!built.general })
      onSent()
    } catch (e) {
      const code = errorCode(e)
      setSendError(
        code === ErrorCode.MethodNotFound
          ? 'Le démon ne sait pas encore envoyer une revue : mets orchd à jour.'
          : code === ErrorCode.InvalidState
            ? `Revue non envoyée : Claude attend une réponse (permission ou question), ou la session ne tourne plus. Réponds d’abord à la demande en attente, puis renvoie la revue. (${e instanceof Error ? e.message : ''})`
            : `Revue non envoyée : ${errorText(e)}`,
      )
    } finally {
      setSending(false)
    }
  }

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

  const editingHere = (a: LineAnchor) =>
    !!draft.editing && draft.editing.path === selected && draft.editing.side === a.side && draft.editing.line === a.line

  return (
    <div className="diffpane" onKeyDown={onKey}>
      <div className="files" ref={listRef} aria-label="Fichiers changés">
        <div className="fhead">
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
        </div>
        {files.length === 0 && <p className="hint pad">Aucune modification depuis la base.</p>}
        <ul role="list">
          {files.map((f) => {
            const n = draft.comments.filter((c) => c.path === f.path && !c.stale).length
            return (
              <li key={f.path}>
                <button
                  className={`frow${seen[f.path] ? ' seen' : ''}`}
                  data-path={f.path}
                  aria-current={f.path === selected}
                  aria-label={`${f.path}, ${STATUS_LABELS[f.status]}, ${f.additions ?? 'nombre inconnu de'} ajouts, ${f.deletions ?? 'nombre inconnu de'} suppressions${n ? `, ${n} commentaire${n > 1 ? 's' : ''}` : ''}${seen[f.path] ? ', vu' : ''}`}
                  onClick={() => setSelected(f.path)}
                >
                  <span className={`s s-${f.status === '?' ? 'u' : f.status}`} aria-hidden="true">
                    {f.status}
                  </span>
                  <PathLabel inline className="n" path={f.path} title={f.old_path ? `${f.old_path} → ${f.path}` : f.path} />
                  <span className="st2" aria-hidden="true">
                    {n > 0 && <span className="ccount">💬{n} </span>}
                    {f.binary ? (
                      'binaire'
                    ) : (
                      <>
                        <span className="plus">+{countLabel(f.additions)}</span> <span className="minus">−{countLabel(f.deletions)}</span>
                      </>
                    )}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
        <p className="hint pad">
          <kbd>j</kbd> / <kbd>k</kbd> : fichier suivant / précédent
        </p>
      </div>
      <div className="dmain">
        {file ? (
          <div className="dhead">
            <span className="path">
              {file.old_path ? `${file.old_path} → ` : ''}
              {file.path}
            </span>
            <span className="hint">{STATUS_LABELS[file.status]} · survole une ligne et clique sur + pour commenter</span>
            <label>
              <input type="checkbox" checked={!!seen[file.path]} onChange={(e) => onSeen(file.path, e.target.checked)} /> Vu
            </label>
          </div>
        ) : (
          <div className="dhead" />
        )}
        <div className="dscroll" tabIndex={0} aria-label={file ? `Diff de ${file.path}` : 'Diff'}>
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
          {rows.length > 0 && (
            <table className="code">
              <tbody>
                {rows.map((r) => {
                  if (r.type === 'hunk') {
                    return (
                      <tr key={r.key} className="hunk">
                        <td className="cbtn" />
                        <td className="no" />
                        <td className="no" />
                        <td className="c">{r.header}</td>
                      </tr>
                    )
                  }
                  const a = r.anchor
                  const cms = a && selected ? commentsAt(draft, selected, a) : []
                  const sign = r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ' '
                  return (
                    <Fragment key={r.key}>
                      <tr className={r.kind}>
                        <td className="cbtn">
                          {a && selected && !full && (
                            <button
                              type="button"
                              aria-label={`Commenter la ligne ${a.line} (${a.side === 'new' ? 'nouvelle' : 'ancienne'} version)`}
                              onClick={() => review({ type: 'edit', path: selected, anchor: a, lineText: r.text })}
                            >
                              +
                            </button>
                          )}
                        </td>
                        <td className="no">{r.oldNo ?? ''}</td>
                        <td className="no">{r.newNo ?? ''}</td>
                        <td className="c">
                          <span className="sign" aria-hidden="true">
                            {sign}{' '}
                          </span>
                          <span className="sr-only">{r.kind === 'add' ? 'ajout : ' : r.kind === 'del' ? 'suppression : ' : ''}</span>
                          {r.text}
                        </td>
                      </tr>
                      {cms.map((c) => (
                        <tr key={`c${c.id}`} className="cm">
                          <td colSpan={4}>
                            <div className="cbox">
                              <div className="who">
                                <span>Toi · commentaire en attente</span>
                                <button
                                  type="button"
                                  className="btn sm ghost"
                                  aria-label={`Supprimer le commentaire de la ligne ${c.line}`}
                                  onClick={() => review({ type: 'delete', id: c.id })}
                                >
                                  ×
                                </button>
                              </div>
                              <div className="ctext">{c.text}</div>
                            </div>
                          </td>
                        </tr>
                      ))}
                      {a && editingHere(a) && (
                        <tr className="cm">
                          <td colSpan={4}>
                            <CommentBox
                              text={draft.editing?.text ?? ''}
                              onText={(text) => review({ type: 'editText', text })}
                              onSave={() => review({ type: 'save' })}
                              onCancel={() => review({ type: 'cancel' })}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
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
        <div className="dfoot">
          {built && built.dropped.length > 0 && (
            <span className="hint warnline">
              {built.dropped.length} commentaire{built.dropped.length > 1 ? 's' : ''} ne {built.dropped.length > 1 ? 'seront' : 'sera'} pas
              envoyé{built.dropped.length > 1 ? 's' : ''} (ligne modifiée, ou fichier qui n’est plus dans le diff) : ils restent ici.
            </span>
          )}
          {full && <span className="hint warnline">Limite de {MAX_COMMENTS} commentaires atteinte.</span>}
          <input
            value={draft.general}
            maxLength={MAX_COMMENT_CHARS * 2}
            onChange={(e) => review({ type: 'general', text: e.target.value })}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              // Entrée seule n'envoie rien ; Ctrl+Entrée envoie la revue.
              e.preventDefault()
              if (e.ctrlKey || e.metaKey) void send()
            }}
            placeholder="Commentaire général (facultatif)"
            aria-label="Commentaire général de la revue"
            aria-describedby="review-send-hint"
          />
          {[...draft.general].length > MAX_COMMENT_CHARS * 0.9 && (
            <span className="hint counter">
              {[...draft.general].length}/{MAX_COMMENT_CHARS}
            </span>
          )}
          {hasDraft(draft) && (
            <button type="button" className="btn ghost" onClick={() => setConfirmClear(true)} disabled={sending}>
              Effacer
            </button>
          )}
          <span className="hint" id="review-send-hint">
            <kbd>Ctrl</kbd>+<kbd>Entrée</kbd> pour envoyer
          </span>
          <button
            type="button"
            className="btn pri"
            disabled={!built || !session.alive || waiting || sending}
            onClick={() => void send()}
            title={
              !session.alive
                ? 'La session ne tourne pas : reprends-la pour lui envoyer la revue.'
                : waiting
                  ? 'Réponds d’abord à la demande en attente (permission ou question).'
                  : undefined
            }
          >
            {sending ? 'Envoi…' : `Envoyer la revue à Claude${count ? ` (${count})` : ''}`}
          </button>
          {sendError && (
            <span className="inline-err" role="alert">
              {sendError}
            </span>
          )}
          {confirmClear && (
            <ConfirmBar
              message={`Effacer la revue en cours (${draft.comments.length} commentaire${draft.comments.length > 1 ? 's' : ''}${draft.general.trim() ? ' et le commentaire général' : ''}) ?`}
              confirmLabel="Effacer"
              busyLabel="Effacement…"
              errorPrefix="Effacement impossible"
              onConfirm={async () => {
                review({ type: 'clear' })
                setConfirmClear(false)
              }}
              onCancel={() => setConfirmClear(false)}
            />
          )}
        </div>
      </div>
    </div>
  )
}
