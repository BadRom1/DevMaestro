/**
 * Lecteur de diff commun aux onglets « Diff » (worktree de la session) et
 * « Commits » (diff d'un commit) : liste des fichiers (j / k, flèches),
 * lignes du diff avec commentaire par ligne et boîte de commentaire.
 */
import { Fragment, type KeyboardEvent, type ReactNode, type RefObject } from 'react'

import type { DiffFile } from '../../../shared/protocol'
import { STATUS_LABELS, countLabel, stepFile, type DiffRow, type LineAnchor } from '../state/diff'
import type { ReviewAction, ReviewDraft } from '../state/review'
import { PathLabel } from './common'
import { CommentBox } from './ReviewBar'

function typing(t: EventTarget | null): boolean {
  return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement
}

/**
 * Raccourcis de la liste : `j` / `k` (partout dans le volet, hors saisie) et
 * flèches (dans la liste) passent au fichier suivant / précédent.
 */
export function fileKeys(
  files: readonly DiffFile[],
  selected: string | null,
  select: (path: string) => void,
  listRef: RefObject<HTMLElement | null>,
): (e: KeyboardEvent<HTMLElement>) => void {
  function move(delta: 1 | -1) {
    const next = stepFile(files, selected, delta)
    if (!next) return
    select(next)
    listRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(next)}"]`)?.focus()
  }
  return (e) => {
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
}

/** Liste des fichiers d'un diff (bouton par fichier, statut, compteurs, commentaires). */
export function DiffFileList({
  files,
  selected,
  onSelect,
  listRef,
  head,
  empty,
  comments,
  seen,
  label,
}: {
  files: readonly DiffFile[]
  selected: string | null
  onSelect: (path: string) => void
  listRef: RefObject<HTMLDivElement | null>
  /** En-tête (base, totaux…). */
  head: ReactNode
  empty: string
  /** Commentaires en attente sur un fichier. */
  comments: (path: string) => number
  /** Fichiers marqués « vu » (onglet Diff seulement). */
  seen?: Record<string, boolean>
  label: string
}) {
  return (
    <div className="files" ref={listRef} aria-label={label}>
      <div className="fhead">{head}</div>
      {files.length === 0 && <p className="hint pad">{empty}</p>}
      <ul role="list">
        {files.map((f) => {
          const n = comments(f.path)
          const isSeen = !!seen?.[f.path]
          return (
            <li key={f.path}>
              <button
                className={`frow${isSeen ? ' seen' : ''}`}
                data-path={f.path}
                aria-current={f.path === selected}
                aria-label={`${f.path}, ${STATUS_LABELS[f.status]}, ${f.additions ?? 'nombre inconnu de'} ajouts, ${f.deletions ?? 'nombre inconnu de'} suppressions${n ? `, ${n} commentaire${n > 1 ? 's' : ''}` : ''}${isSeen ? ', vu' : ''}`}
                onClick={() => onSelect(f.path)}
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
  )
}

/** Commentaire en attente affiché sous sa ligne. */
export interface LineComment {
  id: number
  line: number
  text: string
}

/** Lignes du diff d'un fichier, avec « + » pour commenter, commentaires en attente et boîte ouverte. */
export function DiffTable({
  rows,
  draft,
  review,
  full,
  commentsAt,
  editingAt,
  onEdit,
}: {
  rows: readonly DiffRow[]
  draft: ReviewDraft
  review: (a: ReviewAction) => void
  /** Limite de commentaires atteinte : plus de « + ». */
  full: boolean
  commentsAt: (a: LineAnchor) => readonly LineComment[]
  editingAt: (a: LineAnchor) => boolean
  /** « + » d'une ligne : ouvre la boîte de commentaire. */
  onEdit: (a: LineAnchor, lineText: string) => void
}) {
  return (
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
          const cms = a ? commentsAt(a) : []
          const sign = r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ' '
          return (
            <Fragment key={r.key}>
              <tr className={r.kind}>
                <td className="cbtn">
                  {a && !full && (
                    <button
                      type="button"
                      aria-label={`Commenter la ligne ${a.line} (${a.side === 'new' ? 'nouvelle' : 'ancienne'} version)`}
                      onClick={() => onEdit(a, r.text)}
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
              {a && editingAt(a) && (
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
  )
}
