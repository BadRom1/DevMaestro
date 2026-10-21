/**
 * Revue en cours d'une session, commune aux onglets « Diff », « Fichiers » et
 * « Commits » : boîte de commentaire, listes des extraits de fichiers et des
 * commentaires de commit du brouillon, commentaire général, compteur et envoi
 * (`sessions.sendReview`, une fois pour tous les commentaires).
 */
import { useEffect, useMemo, useRef, useState } from 'react'

import { promptDef, renderPrompt, resolvePrompt, type PromptSettings } from '../../../shared/prompts'
import { ErrorCode, type DiffFile, type Session } from '../../../shared/protocol'
import { CallError, call, errorCode, errorText } from '../api'
import { usePromptScope } from '../promptScope'
import { useOptionalSettings } from '../settings'
import { awaitingAnswer } from '../state/status'
import {
  MAX_COMMENTS,
  MAX_COMMENT_CHARS,
  activeComments,
  buildReview,
  commitComments,
  fileComments,
  hasDraft,
  isCommitComment,
  isFileComment,
  parseRejection,
  rejectedId,
  reviewPromptOf,
  commitCommentLabel,
  type CommitDraftComment,
  type FileDraftComment,
  type ReviewAction,
  type ReviewDraft,
} from '../state/review'
import { ConfirmBar } from './ForgetConfirm'

/** Sans réglages (composant rendu seul) : les consignes par défaut. */
const NO_PROMPTS: PromptSettings = { global: {}, projects: {} }

/** Boîte de commentaire (Entrée : ajouter, Maj+Entrée : nouvelle ligne, Échap : annuler). */
export function CommentBox({
  text,
  onText,
  onSave,
  onCancel,
  placeholder = 'Ton commentaire sur cette ligne… (Entrée : ajouter, Maj+Entrée : nouvelle ligne, Échap : annuler)',
  label = 'Commentaire sur la ligne',
  title,
  max = MAX_COMMENT_CHARS,
}: {
  text: string
  onText: (t: string) => void
  onSave: () => void
  onCancel: () => void
  placeholder?: string
  label?: string
  /** En-tête facultatif (lignes commentées…). */
  title?: string
  /** Longueur maximale (compteur affiché près de la limite). */
  max?: number
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [])
  const n = [...text].length
  return (
    // Échap annule le commentaire sans fermer la fenêtre qui le contient (panneau « Forge »).
    <div className="cbox" data-own-escape>
      {title && <div className="who">{title}</div>}
      <textarea
        ref={ref}
        value={text}
        placeholder={placeholder}
        aria-label={label}
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
          {n > max * 0.9 ? `${n}/${max}` : ''}
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

/** « 12 » ou « 12-18 ». */
export function linesLabel(line: number, lineEnd: number): string {
  return lineEnd > line ? `${line}-${lineEnd}` : `${line}`
}

/** Extraits de fichiers du brouillon : voir, aller au fichier, retirer. */
function FileCommentList({
  draft,
  review,
  onOpen,
  rejected,
}: {
  draft: ReviewDraft
  review: (a: ReviewAction) => void
  onOpen?: (path: string, line: number) => void
  /** Extrait refusé par le démon au dernier envoi. */
  rejected: number | null
}) {
  const list = fileComments(draft)
  if (list.length === 0) return null
  return (
    <details className="fcomments" open={rejected !== null && list.some((c) => c.id === rejected) ? true : undefined}>
      <summary>
        {list.length} extrait{list.length > 1 ? 's' : ''} de fichier{list.length > 1 ? 's' : ''} dans la revue
      </summary>
      <ul role="list">
        {list.map((c) => (
          <li key={c.id} className={c.id === rejected ? 'bad' : undefined}>
            {onOpen ? (
              <button type="button" className="linkish mono" onClick={() => onOpen(c.path, c.line)}>
                {c.path}:{linesLabel(c.line, c.lineEnd)}
              </button>
            ) : (
              <span className="mono">
                {c.path}:{linesLabel(c.line, c.lineEnd)}
              </span>
            )}
            <span className={c.text ? 'ctext' : 'ctext hint'}>
              {c.id === rejected && <b className="rej">refusé · </b>}
              {c.text || 'sans commentaire'}
            </span>
            <button
              type="button"
              className="btn sm ghost"
              aria-label={`Retirer l’extrait ${c.path}:${linesLabel(c.line, c.lineEnd)} de la revue`}
              onClick={() => review({ type: 'delete', id: c.id })}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </details>
  )
}

/** Commentaires de commit du brouillon : voir (onglet Commits), retirer. */
function CommitCommentList({
  draft,
  review,
  onOpen,
  rejected,
}: {
  draft: ReviewDraft
  review: (a: ReviewAction) => void
  onOpen?: (sha: string, path: string) => void
  rejected: number | null
}) {
  const list = commitComments(draft)
  if (list.length === 0) return null
  return (
    <details className="fcomments" open={rejected !== null && list.some((c) => c.id === rejected) ? true : undefined}>
      <summary>
        {list.length} commentaire{list.length > 1 ? 's' : ''} de commit dans la revue
      </summary>
      <ul role="list">
        {list.map((c) => (
          <li key={c.id} className={c.id === rejected ? 'bad' : undefined}>
            {onOpen ? (
              <button type="button" className="linkish mono" title={c.sha} onClick={() => onOpen(c.sha, c.path)}>
                {commitCommentLabel(c)}
              </button>
            ) : (
              <span className="mono" title={c.sha}>
                {commitCommentLabel(c)}
              </span>
            )}
            <span className="ctext">
              {c.id === rejected && <b className="rej">refusé · </b>}
              {c.text}
            </span>
            <button
              type="button"
              className="btn sm ghost"
              aria-label={`Retirer le commentaire ${commitCommentLabel(c)} de la revue`}
              onClick={() => review({ type: 'delete', id: c.id })}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </details>
  )
}

export function ReviewBar({
  session,
  draft,
  review,
  files,
  onSent,
  onOpenFile,
  onOpenCommit,
  blockedReason = null,
}: {
  session: Session
  /** Envoi impossible pour l'instant (raison affichée), ex. fichier modifié non enregistré. */
  blockedReason?: string | null
  draft: ReviewDraft
  review: (a: ReviewAction) => void
  /** Liste du diff (les commentaires de diff hors de cette liste ne partent pas). */
  files: readonly DiffFile[]
  /** Revue envoyée : retour au terminal. */
  onSent: () => void
  /** Clic sur un extrait de fichier de la liste. */
  onOpenFile?: (path: string, line: number) => void
  /** Clic sur un commentaire de commit de la liste. */
  onOpenCommit?: (sha: string, path: string) => void
}) {
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  /** Commentaire refusé par le démon au dernier envoi (identifiant dans le brouillon). */
  const [rejected, setRejected] = useState<number | null>(null)
  const rejectedComment = rejected === null ? undefined : draft.comments.find((x) => x.id === rejected)
  const rejectedFile: FileDraftComment | null = rejectedComment && isFileComment(rejectedComment) ? rejectedComment : null
  const rejectedCommit: CommitDraftComment | null = rejectedComment && isCommitComment(rejectedComment) ? rejectedComment : null
  const [confirmClear, setConfirmClear] = useState(false)
  const built = useMemo(() => buildReview(draft, files), [draft, files])
  const prompts = useOptionalSettings()?.settings.prompts ?? NO_PROMPTS
  const scope = usePromptScope()
  /** Consigne tapée devant la revue (Réglages → Consignes, lot 18), ou pourquoi elle est invalide. */
  const instruction = useMemo(() => {
    if (!built) return null
    const { id, vars } = reviewPromptOf(built.comments)
    const { template } = resolvePrompt(prompts, id, scope.projectKey)
    try {
      return { id, text: renderPrompt(id, template, { ...vars, branch: session.branch ?? null }) }
    } catch (e) {
      return { id, error: `Consigne « ${promptDef(id).label} » invalide : ${(e as Error).message} (à corriger dans Réglages → Consignes).` }
    }
  }, [built, prompts, scope.projectKey, session.branch])
  const count = activeComments(draft).length
  const waiting = awaitingAnswer(session)
  const full = count >= MAX_COMMENTS

  async function send() {
    if (!built || !session.alive || waiting || sending || blockedReason || !instruction || !('text' in instruction)) return
    setSending(true)
    setSendError(null)
    setRejected(null)
    try {
      await call('sessions.sendReview', {
        id: session.id,
        comments: built.comments,
        ...(built.general ? { general: built.general } : {}),
        // Un démon ancien (sans `review_instruction`) ignore le champ et tape sa consigne fixe.
        instruction: instruction.text,
      })
      // Seuls les commentaires envoyés partent ; les autres restent avec leur avertissement.
      review({ type: 'sent', ids: built.ids, general: !!built.general })
      onSent()
    } catch (e) {
      const code = errorCode(e)
      if (code === ErrorCode.InvalidParams && e instanceof CallError) {
        const r = parseRejection(e.failure.message, e.failure.data)
        setRejected(r ? rejectedId(built, r) : null)
      }
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

  return (
    <div className="dfoot">
      {built && built.dropped.length > 0 && (
        <span className="hint warnline">
          {built.dropped.length} commentaire{built.dropped.length > 1 ? 's' : ''} ne {built.dropped.length > 1 ? 'seront' : 'sera'} pas
          envoyé{built.dropped.length > 1 ? 's' : ''} (ligne modifiée, ou fichier qui n’est plus dans le diff) : ils restent ici.
        </span>
      )}
      {full && <span className="hint warnline">Limite de {MAX_COMMENTS} commentaires atteinte.</span>}
      <CommitCommentList draft={draft} review={review} rejected={rejected} {...(onOpenCommit ? { onOpen: onOpenCommit } : {})} />
      <FileCommentList draft={draft} review={review} rejected={rejected} {...(onOpenFile ? { onOpen: onOpenFile } : {})} />
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
      {instruction && 'text' in instruction && (
        <span className="hint review-instr" title="Consigne tapée devant la revue collée (Réglages → Consignes)">
          {scope.reviewInstruction === false ? (
            <>Démon ancien : la consigne par défaut du démon sera tapée (redémarrer orchd pour la tienne).</>
          ) : (
            <>
              Consigne : <span className="mono">{instruction.text}</span>
            </>
          )}
        </span>
      )}
      {instruction && 'error' in instruction && (
        <span className="inline-err" role="alert">
          {instruction.error}
        </span>
      )}
      <button
        type="button"
        className="btn pri"
        disabled={!built || !session.alive || waiting || sending || !!blockedReason || !instruction || !('text' in instruction)}
        onClick={() => void send()}
        title={
          blockedReason
            ? blockedReason
            : !session.alive
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
          {rejectedFile && (
            <>
              Extrait refusé : <b className="mono">{`${rejectedFile.path}:${linesLabel(rejectedFile.line, rejectedFile.lineEnd)}`}</b>.{' '}
            </>
          )}
          {rejectedCommit && (
            <>
              Commentaire de commit refusé : <b className="mono">{commitCommentLabel(rejectedCommit)}</b>.{' '}
            </>
          )}
          {sendError}
          {rejectedCommit && (
            <button
              type="button"
              className="btn sm"
              onClick={() => {
                review({ type: 'delete', id: rejectedCommit.id })
                setRejected(null)
                setSendError(null)
              }}
            >
              Retirer ce commentaire
            </button>
          )}
          {rejectedFile && (
            <button
              type="button"
              className="btn sm"
              onClick={() => {
                review({ type: 'delete', id: rejectedFile.id })
                setRejected(null)
                setSendError(null)
              }}
            >
              Retirer cet extrait
            </button>
          )}
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
  )
}
