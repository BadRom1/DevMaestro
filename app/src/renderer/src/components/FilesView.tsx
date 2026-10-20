/**
 * Onglet « Fichiers » (maquette) : arborescence de la session chargée à la
 * demande (fichiers modifiés marqués, dossiers ouverts vers eux), filtre,
 * lecteur Markdown avec sommaire ou code coloré en lecture seule, « Mentionner
 * à Claude » et « Voir le diff ». Une sélection de lignes (code) ou de blocs
 * (Markdown rendu) s'ajoute au brouillon de revue de la session, le même que
 * celui de l'onglet Diff, et part avec « Envoyer la revue ».
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react'

import { ErrorCode, type DiffSummary, type FileContent, type FileEntry, type Session } from '../../../shared/protocol'
import { call, errorCode, errorText } from '../api'
import { awaitingAnswer } from '../state/status'
import { STATUS_LABELS, sortFiles } from '../state/diff'
import {
  ancestorDirs,
  defaultFile,
  filterFiles,
  isMarkdown,
  mentionFor,
  visibleRows,
  type DirCache,
  type TreeRow,
} from '../state/fileTree'
import { languageForPath, lineCount, withinHighlightLimits } from '../state/highlight'
import { classifyLink, renderMarkdown } from '../state/markdown'
import {
  MAX_COMMENTS,
  activeComments,
  fileComments,
  fileSelectionError,
  hasDraft,
  type ReviewAction,
  type ReviewDraft,
} from '../state/review'
import { markdownSelection } from '../state/domSelection'
import type { LineSpan } from '../state/sourceSelection'
import { CodeView, lineGeometry, type SelectionPoint } from './CodeView'
import { CommentBox, ReviewBar, linesLabel } from './ReviewBar'

/** Aucun fichier dans le diff (référence stable). */
const NO_FILES: DiffSummary['files'] = []

/** Anti-rebond des rechargements après `session.diff_changed`. */
const TREE_REFRESH_MS = 1000

interface FilesMemory {
  cache: DirCache
  open: ReadonlySet<string>
  root: string | null
  truncated: ReadonlySet<string>
  filter: string
  file: string | null
  raw: boolean
  scroll: number
  autoOpened: boolean
  /** Dernière demande « montrer cet extrait » traitée (consommée une seule fois). */
  focusN: number
}

/** État de l'onglet par session, gardé hors du composant (démonté au changement d'onglet). */
const memory = new Map<string, FilesMemory>()

function memoryFor(id: string): FilesMemory {
  let m = memory.get(id)
  if (!m) {
    m = { cache: {}, open: new Set(), root: null, truncated: new Set(), filter: '', file: null, raw: false, scroll: 0, autoOpened: false, focusN: 0 }
    memory.set(id, m)
  }
  return m
}

/** Session oubliée : son état d'onglet n'a plus à être gardé. */
export function forgetFilesMemory(id: string): void {
  memory.delete(id)
}

export const OLD_DAEMON_FILES = 'Le démon ne sait pas encore lister les fichiers : mets orchd à jour.'

function failure(e: unknown, what: string): string {
  return errorCode(e) === ErrorCode.MethodNotFound ? OLD_DAEMON_FILES : `${what} : ${errorText(e)}`
}

function icon(r: Pick<TreeRow, 'kind' | 'path' | 'expanded'>): string {
  if (r.kind === 'dir') return r.expanded ? '▾' : '▸'
  if (r.kind === 'symlink') return '↪'
  return isMarkdown(r.path) ? '¶' : '·'
}

interface PendingSelection {
  span: LineSpan
  /** Position dans le contenu défilant (`.fbody`). */
  top: number
  left: number
}

export function FilesView({
  session,
  diff,
  diffVersion,
  onMentioned,
  onShowDiff,
  onLink,
  draft,
  review,
  onSent,
  focusFile,
}: {
  session: Session
  /** Brouillon de revue de la session (partagé avec l'onglet Diff). */
  draft: ReviewDraft
  review: (a: ReviewAction) => void
  /** Revue envoyée : retour au terminal. */
  onSent: () => void
  /** Fichier et ligne à montrer (extrait cliqué dans la revue) ; `n` augmente à chaque demande. */
  focusFile?: { sessionId: string; path: string; line: number; n: number } | null
  /** Liste du diff (fichiers modifiés), si chargée. */
  diff: DiffSummary | null
  /** Change à chaque nouvelle liste du diff : marques rafraîchies. */
  diffVersion: number
  /** Mention envoyée : retour au terminal. */
  onMentioned: () => void
  onShowDiff: (path: string) => void
  /** Lien http(s) : confirmation puis navigateur (dialogue existant). */
  onLink: (url: string) => void
}) {
  const memo = memoryFor(session.id)
  const [cache, setCache] = useState<DirCache>(memo.cache)
  const [open, setOpen] = useState<ReadonlySet<string>>(memo.open)
  const [root, setRoot] = useState<string | null>(memo.root)
  const [truncated, setTruncated] = useState<ReadonlySet<string>>(memo.truncated)
  const [treeError, setTreeError] = useState<string | null>(null)
  const [filter, setFilter] = useState(memo.filter)
  const [file, setFile] = useState<string | null>(memo.file)
  const [content, setContent] = useState<FileContent | null>(null)
  const [viewError, setViewError] = useState<string | null>(null)
  const [raw, setRaw] = useState(memo.raw)
  const [mentionError, setMentionError] = useState<string | null>(null)
  const [pendingAnchor, setPendingAnchor] = useState<string | null>(null)
  /** Ligne à montrer une fois le contenu affiché. */
  const [pendingLine, setPendingLine] = useState<{ path: string; line: number } | null>(null)
  /** Lignes choisies (bouton « Commenter ») et commentaire en cours de saisie. */
  const [pick, setPick] = useState<PendingSelection | null>(null)
  const [commentText, setCommentText] = useState<string | null>(null)
  /** Le fichier a été relu (changé) pendant la saisie du commentaire. */
  const [pickStale, setPickStale] = useState(false)
  const commentRef = useRef(commentText)
  commentRef.current = commentText
  const contentRef = useRef(content)
  contentRef.current = content
  const body = useRef<HTMLDivElement>(null)
  const article = useRef<HTMLElement>(null)
  /** Défilement à rendre après le prochain chargement du contenu. */
  const restoreScroll = useRef<number | null>(memo.file ? memo.scroll : null)

  // État gardé par session : on le retrouve en revenant sur l'onglet ou la session.
  useEffect(() => {
    Object.assign(memo, { cache, open, root, truncated, filter, file, raw })
  }, [memo, cache, open, root, truncated, filter, file, raw])
  useEffect(() => {
    const el = body.current
    return () => {
      if (el) memo.scroll = el.scrollTop
    }
  }, [memo])

  const changedFiles = useMemo(() => (diff?.files ?? []).map((f) => ({ path: f.path, status: f.status })), [diff])
  const changedPaths = useMemo(() => changedFiles.map((f) => f.path), [changedFiles])
  /** Liste du diff dans l'ordre de l'onglet Diff : la revue part dans le même ordre d'où qu'on l'envoie. */
  const sortedDiffFiles = useMemo(() => (diff ? sortFiles(diff.files) : NO_FILES), [diff])

  /** Numéro du dernier appel par dossier (une réponse plus ancienne est ignorée) et appels en cours. */
  const dirSeq = useRef(new Map<string, number>())
  const inFlight = useRef(new Map<string, Promise<FileEntry[] | null>>())
  const again = useRef(new Set<string>())

  const loadDir = useCallback(
    (dir: string): Promise<FileEntry[] | null> => {
      // Au plus un appel en cours par dossier : un rechargement demandé entre-temps est fait après.
      const running = inFlight.current.get(dir)
      if (running) {
        again.current.add(dir)
        return running
      }
      const seq = (dirSeq.current.get(dir) ?? 0) + 1
      dirSeq.current.set(dir, seq)
      const p = (async () => {
        try {
          const r = await call('files.list', { id: session.id, ...(dir ? { path: dir } : {}) })
          if (dirSeq.current.get(dir) !== seq) return null
          setCache((c) => ({ ...c, [dir]: r.entries }))
          setTruncated((t) => {
            const n = new Set(t)
            if (r.truncated) n.add(dir)
            else n.delete(dir)
            return n
          })
          if (!dir) setRoot(r.root)
          setTreeError(null)
          return r.entries
        } catch (e) {
          if (dirSeq.current.get(dir) === seq) setTreeError(failure(e, 'Liste des fichiers indisponible'))
          return null
        } finally {
          inFlight.current.delete(dir)
          if (again.current.delete(dir)) void loadDir(dir)
        }
      })()
      inFlight.current.set(dir, p)
      return p
    },
    [session.id],
  )

  // Racine au premier affichage (ou relue au retour) ; fichier par défaut : le README.
  useEffect(() => {
    void loadDir('').then((entries) => {
      if (entries) setFile((f) => f ?? defaultFile(entries))
    })
  }, [loadDir])

  // Dossiers ouverts vers les fichiers modifiés (une fois par session, à la première liste du diff).
  useEffect(() => {
    if (memo.autoOpened || !diff || !cache['']) return
    memo.autoOpened = true
    const dirs = ancestorDirs(changedPaths)
    if (!dirs.length) return
    void (async () => {
      for (const d of dirs) if (!(d in cache)) await loadDir(d)
      setOpen((o) => new Set([...o, ...dirs]))
    })()
  }, [memo, diff, cache, changedPaths, loadDir])

  // Diff changé : marques relues (anti-rebond d'1 s), seulement pour la racine et les dossiers ouverts.
  const openRef = useRef(open)
  openRef.current = open
  useEffect(() => {
    if (diffVersion === 0) return
    const t = setTimeout(() => {
      for (const d of ['', ...openRef.current]) void loadDir(d)
    }, TREE_REFRESH_MS)
    return () => clearTimeout(t)
  }, [diffVersion, loadDir])

  // Contenu du fichier choisi.
  useEffect(() => {
    if (!file) {
      setContent(null)
      return
    }
    let alive = true
    setViewError(null)
    setContent(null)
    call('files.read', { id: session.id, path: file })
      .then((c) => alive && setContent(c))
      .catch((e: unknown) => alive && setViewError(failure(e, 'Lecture impossible')))
    return () => {
      alive = false
    }
  }, [session.id, file])

  // Fichier affiché modifié par la session : relu, en gardant la position de lecture.
  const changedRef = useRef(changedPaths)
  changedRef.current = changedPaths
  useEffect(() => {
    if (diffVersion === 0 || !file || !changedRef.current.includes(file)) return
    let alive = true
    const t = setTimeout(() => {
      const scroll = body.current?.scrollTop ?? 0
      call('files.read', { id: session.id, path: file })
        .then((c) => {
          if (!alive) return
          restoreScroll.current = scroll
          // Contenu changé pendant une sélection : lignes peut-être décalées.
          if (c.content !== contentRef.current?.content) {
            if (commentRef.current !== null) setPickStale(true)
            else setPick(null)
          }
          setContent(c)
        })
        .catch(() => undefined)
    }, TREE_REFRESH_MS)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [diffVersion])

  const rendered = useMemo(
    () => (content && file && isMarkdown(file) && !raw && content.content != null ? renderMarkdown(content.content) : null),
    [content, file, raw],
  )

  // Autre fichier ou autre affichage : la sélection en cours est abandonnée.
  useEffect(() => {
    setPick(null)
    setCommentText(null)
    setPickStale(false)
  }, [file, raw])

  // Extrait cliqué dans la revue : fichier ouvert puis ligne montrée (une fois par demande, pour cette session).
  useEffect(() => {
    if (!focusFile || focusFile.sessionId !== session.id || focusFile.n <= memo.focusN) return
    memo.focusN = focusFile.n
    if (focusFile.path !== file) openFile(focusFile.path)
    setPendingLine({ path: focusFile.path, line: focusFile.line })
  }, [focusFile?.n])

  // Position de lecture rendue après un rechargement ou un retour sur l'onglet.
  useLayoutEffect(() => {
    if (restoreScroll.current === null || !content || !body.current) return
    body.current.scrollTop = restoreScroll.current
    restoreScroll.current = null
  }, [content, raw])

  // Lien vers un titre d'un autre fichier : on y va une fois le rendu prêt.
  useEffect(() => {
    if (!pendingAnchor || !rendered) return
    document.getElementById(pendingAnchor)?.scrollIntoView({ block: 'start' })
    setPendingAnchor(null)
  }, [rendered, pendingAnchor])

  // Ligne demandée : défilement une fois le contenu là (code : position calculée ; Markdown : premier bloc qui la couvre).
  useLayoutEffect(() => {
    const el = body.current
    // Contenu encore celui du fichier précédent : on attend le bon.
    if (pendingLine === null || !content || content.path !== pendingLine.path || !el) return
    const line = pendingLine.line
    setPendingLine(null)
    if (article.current) {
      const blocks = [...article.current.querySelectorAll<HTMLElement>('[data-source-start]')]
      const hit = blocks.find((b) => Number(b.dataset.sourceEnd) >= line)
      hit?.scrollIntoView({ block: 'center' })
      return
    }
    const gutter = el.querySelector<HTMLElement>('.codeview .gutter')
    if (!gutter || content.content == null) return
    const g = lineGeometry(gutter, lineCount(content.content))
    const y = g.top - el.getBoundingClientRect().top + el.scrollTop + g.padTop + (line - 1) * g.lineHeight
    el.scrollTop = Math.max(0, y - el.clientHeight / 3)
  }, [pendingLine, content, raw])

  /** Sélection (vue code ou Markdown) : bouton « Commenter » placé sous sa fin. */
  const choose = useCallback((span: LineSpan | null, at: SelectionPoint | null) => {
    const el = body.current
    setPickStale(false)
    // Fichier vide : rien à commenter.
    if (!span || !at || !el || !contentRef.current?.content) {
      setPick(null)
      return
    }
    const r = el.getBoundingClientRect()
    setPick({ span, top: at.y - r.top + el.scrollTop + 4, left: Math.max(8, at.x - r.left + el.scrollLeft) })
  }, [])

  function onArticleUp() {
    // Pendant la saisie d'un commentaire, une nouvelle sélection ne remplace pas l'extrait.
    if (commentRef.current !== null) return
    const sel = window.getSelection()
    const a = article.current
    if (!a || !sel || sel.rangeCount === 0 || sel.isCollapsed) return
    const range = sel.getRangeAt(0)
    const span = markdownSelection(a, range)
    if (!span) return
    const rect = range.getBoundingClientRect()
    choose(span, { x: rect.left, y: rect.bottom })
  }

  // Maj+flèches dans le Markdown rendu : même bouton qu'à la souris.
  const articleUpRef = useRef(onArticleUp)
  articleUpRef.current = onArticleUp
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.shiftKey || /^(Arrow|Home|End|Page)/.test(e.key)) articleUpRef.current()
    }
    document.addEventListener('keyup', key)
    return () => document.removeEventListener('keyup', key)
  }, [])

  function onBodyDown(e: MouseEvent<HTMLDivElement>) {
    // Nouvelle sélection : l'ancien bouton disparaît (pas pendant la saisie d'un commentaire).
    if (commentText !== null || (e.target as HTMLElement).closest('.selfloat')) return
    if (!(e.target as HTMLElement).closest('.gutter')) setPick(null)
  }

  function saveComment() {
    if (!pick || !file) return
    review({ type: 'addFile', path: file, line: pick.span.line, lineEnd: pick.span.lineEnd, text: commentText ?? '' })
    setPick(null)
    setCommentText(null)
    setPickStale(false)
    window.getSelection()?.removeAllRanges()
  }

  function cancelComment() {
    setPick(null)
    setCommentText(null)
    setPickStale(false)
  }

  function toggle(r: TreeRow) {
    if (r.kind !== 'dir') {
      openFile(r.path)
      return
    }
    if (r.expanded) {
      setOpen((o) => {
        const n = new Set(o)
        n.delete(r.path)
        return n
      })
      return
    }
    if (!(r.path in cache)) void loadDir(r.path)
    setOpen((o) => new Set(o).add(r.path))
  }

  function openFile(path: string, anchor: string | null = null) {
    restoreScroll.current = null
    setFile(path)
    setRaw(false)
    setPendingAnchor(anchor)
    body.current?.scrollTo({ top: 0 })
  }

  function onArticleClick(e: MouseEvent<HTMLElement>) {
    const a = (e.target as HTMLElement).closest('a')
    if (!a || !file) return
    e.preventDefault()
    const t = classifyLink(a.getAttribute('href'), file)
    if (t.kind === 'external') onLink(t.url)
    else if (t.kind === 'file') openFile(t.path, t.anchor)
    else if (t.kind === 'anchor') document.getElementById(t.id)?.scrollIntoView({ block: 'start' })
  }

  async function mention() {
    if (!file) return
    setMentionError(null)
    const m = mentionFor(file)
    if (!m.ok) {
      setMentionError(`Mention impossible : ${m.error}.`)
      return
    }
    try {
      await call('sessions.input', { id: session.id, data: m.text })
      onMentioned()
    } catch (e) {
      setMentionError(
        errorCode(e) === ErrorCode.MethodNotFound
          ? 'Le démon ne sait pas encore recevoir de texte : mets orchd à jour.'
          : `Mention impossible : ${errorText(e)}`,
      )
    }
  }

  const waiting = awaitingAnswer(session)
  const rows = filter.trim() ? filterFiles(cache, changedFiles, filter) : visibleRows(cache, open, changedPaths)
  const changed = file ? (changedFiles.find((f) => f.path === file)?.status ?? null) : null
  const rootName = root ? root.split('/').filter(Boolean).pop() : null
  const showToc = !!rendered && rendered.outline.length > 1
  const text = content && !content.binary && !content.too_large ? content.content : null
  const language = file ? (isMarkdown(file) ? 'markdown' : languageForPath(file)) : null
  const highlightOk = useMemo(() => (text != null ? withinHighlightLimits(text) : true), [text])
  const tooBigToColor = text != null && ((!rendered && language !== null && !highlightOk) || (rendered !== null && !rendered.highlighted))
  const hereComments = file ? fileComments(draft, file) : []
  const pickError = pick ? fileSelectionError(pick.span.line, pick.span.lineEnd) : null
  const draftFull = activeComments(draft).length >= MAX_COMMENTS

  return (
    <div className={`fpane${showToc ? '' : ' notoc'}`}>
      <nav className="ftree" aria-label="Fichiers de la session">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filtrer les fichiers…"
          aria-label="Filtrer les fichiers"
          aria-describedby={filter ? 'ffilter-hint' : undefined}
        />
        {filter && (
          <span className="hint pad" id="ffilter-hint">
            Dans les dossiers déjà ouverts et les fichiers modifiés.
          </span>
        )}
        {treeError && (
          <p className="inline-err pad" role="alert">
            {treeError}
            <button className="btn sm" onClick={() => void loadDir('')}>
              Réessayer
            </button>
          </p>
        )}
        <ul role="list" className="trows">
          {rows.map((r) => (
            <li key={r.path}>
              <button
                className={`trow${r.kind === 'dir' ? ' dir' : ''}`}
                style={{ paddingLeft: 8 + r.depth * 12 }}
                aria-current={r.path === file}
                aria-expanded={r.kind === 'dir' ? r.expanded : undefined}
                aria-label={`${r.name}${r.kind === 'dir' ? ', dossier' : ''}${r.changed ? `, ${STATUS_LABELS[r.changed]}` : ''}${r.changedInside ? ', contient des fichiers modifiés' : ''}`}
                onClick={() => toggle(r)}
                title={r.path}
              >
                <span className="ic" aria-hidden="true">
                  {icon(r)}
                </span>
                <span className="nm">{r.name}</span>
                {r.changed && (
                  <span className={`mk ${r.changed === '?' ? 'u' : r.changed}`} aria-hidden="true">
                    {r.changed}
                  </span>
                )}
                {!r.changed && r.changedInside && (
                  <span className="mk" aria-hidden="true">
                    •
                  </span>
                )}
              </button>
              {r.kind === 'dir' && r.expanded && truncated.has(r.path) && <span className="hint pad">Dossier tronqué (2 000 entrées au plus).</span>}
            </li>
          ))}
          {filter && rows.length === 0 && <li className="hint pad">Aucun fichier.</li>}
        </ul>
        {truncated.has('') && <p className="hint pad">Racine tronquée (2 000 entrées au plus).</p>}
      </nav>
      <div className="fview">
        <div className="fhead">
          <span className="crumbs" title={root ?? undefined}>
            {rootName ?? '…'}
            {file &&
              file.split('/').map((x, i, a) => (
                <span key={i}>
                  {' / '}
                  {i === a.length - 1 ? <b>{x}</b> : x}
                </span>
              ))}
          </span>
          {changed && <span className={`chip ${changed === 'A' ? 'ok' : 'pend'}`}>{STATUS_LABELS[changed]} dans la session</span>}
          <span className="acts">
            {file && isMarkdown(file) && (
              <div className="seg" role="group" aria-label="Affichage du Markdown">
                <button aria-pressed={!raw} onClick={() => setRaw(false)}>
                  Rendu
                </button>
                <button aria-pressed={raw} onClick={() => setRaw(true)}>
                  Source
                </button>
              </div>
            )}
            {changed && file && (
              <button className="btn sm" onClick={() => onShowDiff(file)}>
                Voir le diff
              </button>
            )}
            <button
              className="btn sm"
              disabled={!file || !session.alive || waiting}
              onClick={() => void mention()}
              title={
                !session.alive
                  ? 'La session ne tourne pas'
                  : waiting
                    ? 'Réponds d’abord à la demande en attente : le texte irait dans son dialogue'
                    : 'Tape « @fichier » dans le message de la session'
              }
            >
              Mentionner à Claude
            </button>
          </span>
          {mentionError && (
            <span className="inline-err" role="alert">
              {mentionError}
            </span>
          )}
          {tooBigToColor && (
            <span className="hint">
              {rendered ? 'Blocs de code non colorés' : 'Coloration désactivée'} : fichier de plus de 200 Kio ou 5 000 lignes.
            </span>
          )}
        </div>
        <div className="fbody" ref={body} tabIndex={0} aria-label={file ? `Contenu de ${file}` : 'Contenu'} onMouseDown={onBodyDown}>
          {!file && <p className="empty">Choisis un fichier à gauche.</p>}
          {viewError && (
            <p className="inline-err pad" role="alert">
              {viewError}
            </p>
          )}
          {file && !content && !viewError && <p className="empty">Chargement…</p>}
          {content?.binary && <p className="empty">Fichier binaire : pas d’aperçu.</p>}
          {content?.too_large && <p className="empty">Fichier trop volumineux pour être affiché (2 Mio au plus).</p>}
          {text != null &&
            (rendered ? (
              // HTML produit par markdown-it sans HTML brut (échappé) ni image chargée ; code coloré par highlight.js (échappé).
              <article
                ref={article}
                className="md"
                onClick={onArticleClick}
                onMouseUp={onArticleUp}
                dangerouslySetInnerHTML={{ __html: rendered.html }}
              />
            ) : (
              <CodeView
                text={text}
                language={language}
                highlight={highlightOk}
                selection={pick?.span ?? null}
                comments={hereComments}
                onSelect={commentText === null ? choose : () => undefined}
              />
            ))}
          {pick && file && (
            <div className="selfloat" style={{ top: pick.top, left: pick.left }}>
              {commentText !== null ? (
                <CommentBox
                  title={`${file}:${linesLabel(pick.span.line, pick.span.lineEnd)}${pickStale ? ' · le fichier a changé depuis la sélection : vérifie les lignes avant d’ajouter' : ''}`}
                  text={commentText}
                  onText={setCommentText}
                  onSave={saveComment}
                  onCancel={cancelComment}
                  label={`Commentaire sur les lignes ${linesLabel(pick.span.line, pick.span.lineEnd)}`}
                  placeholder="Ta remarque sur ces lignes (facultatif)… (Entrée : ajouter, Maj+Entrée : nouvelle ligne, Échap : annuler)"
                />
              ) : pickError ? (
                <span className="inline-err" role="alert">
                  Impossible de commenter : {pickError}.
                </span>
              ) : draftFull ? (
                <span className="inline-err" role="alert">
                  Limite de {MAX_COMMENTS} commentaires atteinte.
                </span>
              ) : (
                <button
                  type="button"
                  className="btn sm pri"
                  // Garder la sélection visible au clic.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setCommentText('')}
                >
                  Commenter {pick.span.lineEnd > pick.span.line ? `les lignes ${linesLabel(pick.span.line, pick.span.lineEnd)}` : `la ligne ${pick.span.line}`}
                </button>
              )}
            </div>
          )}
        </div>
        {hasDraft(draft) && (
          <ReviewBar
            session={session}
            draft={draft}
            review={review}
            files={sortedDiffFiles}
            onSent={onSent}
            onOpenFile={(path, line) => {
              if (path !== file) openFile(path)
              setPendingLine({ path, line })
            }}
          />
        )}
      </div>
      {showToc && rendered && (
        <nav className="toc" aria-label="Sur cette page">
          <span className="lbl">Sur cette page</span>
          {rendered.outline.map((o) => (
            <button key={o.id} className={`l${o.level}`} onClick={() => document.getElementById(o.id)?.scrollIntoView({ block: 'start' })}>
              {o.text}
            </button>
          ))}
        </nav>
      )}
    </div>
  )
}
