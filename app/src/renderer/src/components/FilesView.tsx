/**
 * Onglet « Fichiers » (maquette) : arborescence de la session chargée à la
 * demande (fichiers modifiés marqués, dossiers ouverts vers eux), filtre,
 * lecteur Markdown avec sommaire ou code coloré en lecture seule, « Mentionner
 * à Claude » et « Voir le diff ». Une sélection de lignes (code) ou de blocs
 * (Markdown rendu) s'ajoute au brouillon de revue de la session, le même que
 * celui de l'onglet Diff, et part avec « Envoyer la revue ».
 *
 * « Modifier » (lot 7) : éditeur CodeMirror à la place de la lecture, avec
 * « Enregistrer » (Ctrl+S, `files.write` avec l'empreinte de la version
 * ouverte), bandeau de conflit si le fichier a changé depuis son ouverture,
 * « Annuler les modifications », et retour en lecture après l'enregistrement.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent } from 'react'

import { ErrorCode, type DiffFile, type DiffSummary, type FileContent, type FileEntry, type Session } from '../../../shared/protocol'
import { t as tGlobal } from '../../../shared/i18n'
import { CallError, call, errorCode, errorText } from '../api'
import { useI18n } from '../i18n'
import { awaitingAnswer } from '../state/status'
import { outcomeUncertain } from '../state/errors'
import { canEdit, conflictVersion, editReducer, editable, eolStyle, expectedFor, isVersion, normalizeEol, notEditableReason, type EditState } from '../state/fileEdit'
import { guardLeave, setUnsaved, subscribeLeave, unsavedVersion } from '../state/unsaved'
import { statusLabel } from '../state/diff'
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
import { EditDiffDialog } from './EditDiffDialog'
import { FileEditor, type EditorHandle } from './FileEditor'

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

/** Erreur de `files.*` : démon trop ancien (méthode inconnue), ou « <what> : <détail> » (langue courante). */
function failure(e: unknown, what: string): string {
  return errorCode(e) === ErrorCode.MethodNotFound ? tGlobal('files.view.oldDaemonList') : tGlobal('files.errorWith', { what, text: errorText(e) })
}

function icon(r: Pick<TreeRow, 'kind' | 'path' | 'expanded'>): string {
  if (r.kind === 'dir') return r.expanded ? '▾' : '▸'
  if (r.kind === 'symlink') return '↪'
  return isMarkdown(r.path) ? '¶' : '·'
}

/** « Ctrl+X » en touches de clavier (aide de l'éditeur). */
function ctrlKey(k: string) {
  return (
    <>
      {/* i18n-exempt: nom de touche */}
      <kbd>Ctrl</kbd>+<kbd>{k}</kbd>
    </>
  )
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
  reviewFiles,
  diffVersion,
  onMentioned,
  onShowDiff,
  onLink,
  draft,
  review,
  onSent,
  focusFile,
  onOpenCommit,
}: {
  session: Session
  /** Commentaire de commit cliqué dans la liste de la revue : onglet Commits. */
  onOpenCommit?: (sha: string, path: string) => void
  /** Brouillon de revue de la session (partagé avec l'onglet Diff). */
  draft: ReviewDraft
  review: (a: ReviewAction) => void
  /** Revue envoyée : retour au terminal. */
  onSent: () => void
  /** Fichier et ligne à montrer (extrait cliqué dans la revue) ; `n` augmente à chaque demande. */
  focusFile?: { sessionId: string; path: string; line: number; n: number } | null
  /** Liste du diff (fichiers modifiés), si chargée. */
  diff: DiffSummary | null
  /** Liste du diff triée (ordre de l'onglet Diff), commune aux barres de revue de tous les onglets. */
  reviewFiles: readonly DiffFile[]
  /** Change à chaque nouvelle liste du diff : marques rafraîchies. */
  diffVersion: number
  /** Mention envoyée : retour au terminal. */
  onMentioned: () => void
  onShowDiff: (path: string) => void
  /** Lien http(s) : confirmation puis navigateur (dialogue existant). */
  onLink: (url: string) => void
}) {
  const { t, rich } = useI18n()
  /** « Mentionner » et « Envoyer la revue » ramènent au terminal : pas pendant une édition modifiée. */
  const unsavedBlocks = t('files.view.unsavedBlocks')
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
  /** Édition en cours (`null` : lecture). */
  const [edit, dispatchEdit] = useReducer(editReducer, null)
  const editRef = useRef<EditState | null>(edit)
  editRef.current = edit
  const editor = useRef<EditorHandle | null>(null)
  /** « Voir les différences » ouvert, avec mon texte au moment de l'ouverture. */
  const [diffOf, setDiffOf] = useState<{ mine: string } | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  /**
   * Écritures réussies : une lecture partie avant la dernière (relecture
   * après `session.diff_changed`) est périmée et ignorée.
   */
  const writeGen = useRef(0)

  // Modifications non enregistrées déclarées aux gardes (changement d'onglet, de session, fermeture) ;
  // réinscrites si le registre les a oubliées alors que la vue reste montée.
  const registry = useSyncExternalStore(subscribeLeave, unsavedVersion)
  useEffect(() => {
    setUnsaved(session.id, edit?.dirty ? edit.path : null)
  }, [session.id, edit?.dirty, edit?.path, registry])
  // Vue démontée : l'éditeur et son texte disparaissent avec elle.
  useEffect(() => () => setUnsaved(session.id, null), [session.id])

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
          setTruncated((prev) => {
            const n = new Set(prev)
            if (r.truncated) n.add(dir)
            else n.delete(dir)
            return n
          })
          if (!dir) setRoot(r.root)
          setTreeError(null)
          return r.entries
        } catch (e) {
          if (dirSeq.current.get(dir) === seq) setTreeError(failure(e, tGlobal('files.view.listUnavailable')))
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
    const timer = setTimeout(() => {
      for (const d of ['', ...openRef.current]) void loadDir(d)
    }, TREE_REFRESH_MS)
    return () => clearTimeout(timer)
  }, [diffVersion, loadDir])

  // Contenu du fichier choisi.
  useEffect(() => {
    if (!file) {
      setContent(null)
      return
    }
    let alive = true
    const gen = writeGen.current
    setViewError(null)
    setContent(null)
    call('files.read', { id: session.id, path: file })
      .then((c) => alive && gen === writeGen.current && setContent(c))
      .catch((e: unknown) => alive && setViewError(failure(e, tGlobal('files.view.readFailed'))))
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
    const timer = setTimeout(() => {
      const scroll = body.current?.scrollTop ?? 0
      const gen = writeGen.current
      call('files.read', { id: session.id, path: file })
        .then((c) => {
          // Partie avant un enregistrement : contenu périmé.
          if (!alive || gen !== writeGen.current) return
          // En édition : le texte en cours reste ; on signale seulement que le fichier a changé sur le disque.
          if (editRef.current?.path === file) {
            dispatchEdit({ type: 'diskSeen', sha256: isVersion(c.version) ? c.version.sha256 : null })
            return
          }
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
      clearTimeout(timer)
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

  // Autre fichier : l'édition (déjà confirmée par la garde) s'arrête.
  useEffect(() => {
    if (editRef.current && editRef.current.path !== file) dispatchEdit({ type: 'cancel' })
    setDiffOf(null)
  }, [file])

  // Extrait cliqué dans la revue : fichier ouvert puis ligne montrée (une fois par demande, pour cette session).
  useEffect(() => {
    if (!focusFile || focusFile.sessionId !== session.id || focusFile.n <= memo.focusN) return
    memo.focusN = focusFile.n
    const target = { path: focusFile.path, line: focusFile.line }
    if (focusFile.path !== file) openFile(focusFile.path, null, () => setPendingLine(target))
    else setPendingLine(target)
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

  /**
   * Ouvre un fichier (arbre, lien Markdown, extrait de la revue) ; `then` est
   * appelé une fois le fichier choisi. En édition, quitter le fichier demande
   * confirmation s'il y a des modifications non enregistrées.
   */
  function openFile(path: string, anchor: string | null = null, then?: () => void) {
    if (path === file && editRef.current) {
      then?.()
      return
    }
    guardLeave(session.id, t('files.leave.openOther'), () => {
      if (editRef.current) dispatchEdit({ type: 'cancel' })
      restoreScroll.current = null
      setFile(path)
      setRaw(false)
      setPendingAnchor(anchor)
      body.current?.scrollTo({ top: 0 })
      then?.()
    })
  }

  /** « Modifier » : la version affichée devient la version ouverte (Markdown : en source). */
  function beginEdit() {
    if (!file || !content || content.content == null || !isVersion(content.version)) return
    setPick(null)
    setCommentText(null)
    if (isMarkdown(file)) setRaw(true)
    dispatchEdit({ type: 'begin', path: file, content: content.content, version: content.version })
  }

  /** Version actuelle relue pour un conflit (diff et « Écraser quand même »). */
  function loadCurrent(path: string) {
    call('files.read', { id: session.id, path })
      .then((c) => {
        if (!mounted.current || editRef.current?.path !== path) return
        dispatchEdit({
          type: 'currentLoaded',
          content: c.binary || c.too_large ? null : c.content,
          version: isVersion(c.version) ? c.version : undefined,
        })
      })
      .catch((e: unknown) => {
        if (mounted.current && editRef.current?.path === path) dispatchEdit({ type: 'currentFailed', error: t('files.view.currentUnreadable', { text: errorText(e) }) })
      })
  }

  /** « Enregistrer » (Ctrl+S) ou, après la seconde confirmation, « Écraser quand même ». */
  async function save(overwrite = false) {
    const e = editRef.current
    const h = editor.current
    if (!e || !h) return
    if (overwrite ? e.phase !== 'confirmOverwrite' : !editable(e)) return
    // Rien de changé : retour en lecture, sans écrire.
    if (!overwrite && !e.dirty && !e.conflict) {
      dispatchEdit({ type: 'cancel' })
      return
    }
    const expected = expectedFor({ ...e, phase: overwrite ? 'overwriting' : 'saving' })
    if (expected === undefined) return
    dispatchEdit({ type: overwrite ? 'overwrite' : 'save' })
    // Par sécurité : fins de ligne du fichier ouvert (le collage et le dépôt sont déjà ramenés à ce style).
    const text = normalizeEol(h.text(), eolStyle(e.base) === 'crlf' ? 'crlf' : 'lf')
    try {
      const r = await call('files.write', { id: session.id, path: e.path, content: text, expected })
      writeGen.current++
      if (!mounted.current) return
      setContent((c) =>
        c && c.path === e.path ? { ...c, content: text, size: isVersion(r?.version) ? r.version.size : c.size, version: isVersion(r?.version) ? r.version : null } : c,
      )
      dispatchEdit({ type: 'saved' })
      requestAnimationFrame(() => body.current?.focus())
    } catch (err) {
      if (!mounted.current) return
      const code = errorCode(err)
      if (code === ErrorCode.FileChanged) {
        const current = conflictVersion(err instanceof CallError ? err.failure.data : undefined)
        dispatchEdit({ type: 'conflict', version: current })
        // Fichier supprimé : rien à relire.
        if (current !== null) loadCurrent(e.path)
      } else if (code === ErrorCode.MethodNotFound) {
        dispatchEdit({ type: 'failed', error: t('files.view.oldDaemonWrite') })
      } else if (outcomeUncertain(code)) {
        dispatchEdit({
          type: 'failed',
          error: t('files.view.saveUncertain', { text: errorText(err) }),
        })
      } else {
        dispatchEdit({ type: 'failed', error: t('files.view.saveFailed', { text: errorText(err) }) })
      }
    }
  }

  /** « Recharger (perdre mes modifications) » : la version actuelle devient la version ouverte. */
  async function reload() {
    const e = editRef.current
    if (!e || !editable(e)) return
    try {
      const c = await call('files.read', { id: session.id, path: e.path })
      if (!mounted.current || editRef.current?.path !== e.path) return
      setContent(c)
      if (!canEdit(c, false) || c.content == null || !isVersion(c.version) || eolStyle(c.content) === 'mixed') {
        // Plus modifiable ici (binaire, trop gros…) : retour en lecture.
        dispatchEdit({ type: 'cancel' })
        return
      }
      editor.current?.reset(c.content)
      dispatchEdit({ type: 'reload', content: c.content, version: c.version })
      editor.current?.focus()
    } catch (err) {
      if (mounted.current) dispatchEdit({ type: 'currentFailed', error: t('files.view.reloadFailed', { text: errorText(err) }) })
    }
  }

  /**
   * Ctrl+S (Cmd+S) pendant l'édition, focus hors de l'éditeur (barre, bandeau) :
   * enregistre ; jamais transmis plus loin (dans l'éditeur, CodeMirror l'a déjà traité).
   */
  function onViewKeyDown(ev: ReactKeyboardEvent<HTMLDivElement>) {
    if (!edit || !(ev.ctrlKey || ev.metaKey) || ev.altKey || ev.shiftKey || ev.key.toLowerCase() !== 's') return
    ev.stopPropagation()
    if (ev.defaultPrevented) return
    ev.preventDefault()
    void save()
  }

  /** Fichier supprimé depuis son ouverture, « Fermer » : modifications abandonnées (confirmation), plus d'aperçu. */
  function closeDeleted() {
    guardLeave(session.id, t('files.leave.closeDeleted'), () => {
      dispatchEdit({ type: 'cancel' })
      setContent(null)
      setViewError(t('files.view.deletedSinceOpen'))
    })
  }

  /** « Annuler les modifications » : retour en lecture (confirmation s'il y a des modifications). */
  function cancelEdit() {
    guardLeave(session.id, t('files.leave.cancelEdit'), () => {
      dispatchEdit({ type: 'cancel' })
      requestAnimationFrame(() => body.current?.focus())
    })
  }

  function onArticleClick(e: MouseEvent<HTMLElement>) {
    const a = (e.target as HTMLElement).closest('a')
    if (!a || !file) return
    e.preventDefault()
    const link = classifyLink(a.getAttribute('href'), file)
    if (link.kind === 'external') onLink(link.url)
    else if (link.kind === 'file') openFile(link.path, link.anchor)
    else if (link.kind === 'anchor') document.getElementById(link.id)?.scrollIntoView({ block: 'start' })
  }

  async function mention() {
    if (!file) return
    setMentionError(null)
    const m = mentionFor(file)
    if (!m.ok) {
      setMentionError(t('files.view.mentionRefused', { error: m.error }))
      return
    }
    try {
      await call('sessions.input', { id: session.id, data: m.text })
      onMentioned()
    } catch (e) {
      setMentionError(
        errorCode(e) === ErrorCode.MethodNotFound
          ? t('files.view.oldDaemonInput')
          : t('files.view.mentionFailed', { text: errorText(e) }),
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
  const parentDir = file && file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : ''
  const isSymlink = !!file && (cache[parentDir]?.some((e) => e.path === file && e.kind === 'symlink') ?? false)
  const editPossible = !edit && content?.path === file && canEdit(content, isSymlink)
  const refused = !edit && content?.path === file ? notEditableReason(content) : null
  const mixedEol = editPossible && content?.content != null && eolStyle(content.content) === 'mixed'
  const busy = edit?.phase === 'saving' || edit?.phase === 'overwriting'

  return (
    <div className={`fpane${showToc ? '' : ' notoc'}`}>
      <nav className="ftree" aria-label={t('files.view.treeLabel')}>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t('files.view.filterPlaceholder')}
          aria-label={t('files.view.filterLabel')}
          aria-describedby={filter ? 'ffilter-hint' : undefined}
        />
        {filter && (
          <span className="hint pad" id="ffilter-hint">
            {t('files.view.filterHint')}
          </span>
        )}
        {treeError && (
          <p className="inline-err pad" role="alert">
            {treeError}
            <button className="btn sm" onClick={() => void loadDir('')}>
              {t('files.retry')}
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
                aria-label={`${r.name}${r.kind === 'dir' ? t('files.tree.dirSuffix') : ''}${r.changed ? `, ${statusLabel(r.changed)}` : ''}${r.changedInside ? t('files.tree.changedInsideSuffix') : ''}`}
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
              {r.kind === 'dir' && r.expanded && truncated.has(r.path) && <span className="hint pad">{t('files.tree.dirTruncated')}</span>}
            </li>
          ))}
          {filter && rows.length === 0 && <li className="hint pad">{t('files.tree.noFile')}</li>}
        </ul>
        {truncated.has('') && <p className="hint pad">{t('files.tree.rootTruncated')}</p>}
      </nav>
      <div className="fview" onKeyDown={onViewKeyDown}>
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
          {changed && <span className={`chip ${changed === 'A' ? 'ok' : 'pend'}`}>{t('files.view.changedInSession', { status: statusLabel(changed) })}</span>}
          <span className="acts">
            {file && isMarkdown(file) && (
              <div className="seg" role="group" aria-label={t('files.view.markdownMode')}>
                <button aria-pressed={!raw} onClick={() => setRaw(false)} disabled={!!edit} title={edit ? t('files.view.markdownSourceWhileEditing') : undefined}>
                  {t('files.view.rendered')}
                </button>
                <button aria-pressed={raw} onClick={() => setRaw(true)} disabled={!!edit}>
                  {t('files.view.source')}
                </button>
              </div>
            )}
            {changed && file && (
              <button className="btn sm" onClick={() => onShowDiff(file)}>
                {t('files.view.showDiff')}
              </button>
            )}
            {editPossible && (
              <button
                className="btn sm"
                disabled={mixedEol}
                onClick={beginEdit}
                title={mixedEol ? t('files.view.mixedEol') : t('files.view.editTitle')}
              >
                {t('files.view.edit')}
              </button>
            )}
            {refused && (
              <button className="btn sm" disabled title={refused} aria-label={t('files.view.editRefused', { reason: refused })}>
                {t('files.view.edit')}
              </button>
            )}
            {edit && (
              <>
                {edit.dirty && (
                  <span className="chip pend" role="status">
                    {t('files.view.dirty')}
                  </span>
                )}
                <button className="btn sm ghost" onClick={cancelEdit} disabled={busy}>
                  {t('files.view.cancelEdit')}
                </button>
                {edit.phase !== 'conflict' && edit.phase !== 'confirmOverwrite' && (
                  <button className="btn sm pri" onClick={() => void save()} disabled={busy} aria-keyshortcuts="Control+S" title={t('files.view.saveTitle')}>
                    {busy ? t('files.view.saving') : t('files.view.save')}
                  </button>
                )}
              </>
            )}
            <button
              className="btn sm"
              disabled={!file || !session.alive || waiting || !!edit?.dirty}
              onClick={() => void mention()}
              title={
                edit?.dirty
                  ? unsavedBlocks
                  : !session.alive
                  ? t('files.view.notRunning')
                  : waiting
                    ? t('files.view.answerFirst')
                    : t('files.view.mentionTitle')
              }
            >
              {t('files.view.mention')}
            </button>
          </span>
          {mentionError && (
            <span className="inline-err" role="alert">
              {mentionError}
            </span>
          )}
          {!edit && tooBigToColor && (
            <span className="hint">
              {t('files.view.tooBigToColor', { what: rendered ? t('files.view.codeBlocksNotColored') : t('files.view.coloringOff') })}
            </span>
          )}
        </div>
        <div className="fbody" ref={body} tabIndex={0} aria-label={file ? t('files.view.contentOf', { path: file }) : t('files.view.content')} onMouseDown={onBodyDown}>
          {!file && <p className="empty">{t('files.view.pickFile')}</p>}
          {viewError && (
            <p className="inline-err pad" role="alert">
              {viewError}
            </p>
          )}
          {file && !content && !viewError && <p className="empty">{t('files.loading')}</p>}
          {content?.binary && <p className="empty">{t('files.view.binary')}</p>}
          {content?.too_large && <p className="empty">{t('files.view.tooLarge')}</p>}
          {edit && file && edit.path === file ? (
            <div className="fedit">
              {edit.phase === 'editing' && edit.diskChanged && (
                <p className="ebanner info" role="status">
                  {t('files.view.diskChanged')}
                </p>
              )}
              {edit.error && (
                <p className="ebanner bad" role="alert">
                  {edit.error}
                </p>
              )}
              {(edit.phase === 'conflict' || edit.phase === 'confirmOverwrite' || edit.phase === 'overwriting') && edit.conflict && (
                <div className="ebanner warn" role="alert">
                  <p>
                    <b>
                      {edit.conflict.version === null
                        ? t('files.view.deletedSinceOpen')
                        : t('files.view.modifiedSinceOpen')}
                    </b>{' '}
                    {t('files.view.notSaved')}
                  </p>
                  {edit.conflict.loadError && <p className="inline-err">{edit.conflict.loadError}</p>}
                  {edit.phase === 'conflict' && edit.conflict.version === null ? (
                    <div className="eacts">
                      <button className="btn sm" onClick={() => dispatchEdit({ type: 'askOverwrite' })}>
                        {t('files.view.recreate')}
                      </button>
                      <button className="btn sm" onClick={closeDeleted}>
                        {t('files.close')}
                      </button>
                    </div>
                  ) : edit.phase === 'conflict' ? (
                    <div className="eacts">
                      <button className="btn sm" onClick={() => setDiffOf({ mine: editor.current?.text() ?? '' })}>
                        {t('files.view.showDifferences')}
                      </button>
                      <button className="btn sm" onClick={() => void reload()}>
                        {t('files.view.reloadLose')}
                      </button>
                      <button
                        className="btn sm danger"
                        disabled={edit.conflict.version === undefined}
                        title={edit.conflict.version === undefined ? t('files.view.currentUnknown') : undefined}
                        onClick={() => dispatchEdit({ type: 'askOverwrite' })}
                      >
                        {t('files.view.overwriteAnyway')}
                      </button>
                    </div>
                  ) : (
                    <div className="eacts">
                      <span>
                        {edit.conflict.version === null
                          ? t('files.view.confirmRecreate')
                          : t('files.view.confirmOverwrite')}
                      </span>
                      <button className="btn sm" autoFocus disabled={edit.phase === 'overwriting'} onClick={() => dispatchEdit({ type: 'cancelOverwrite' })}>
                        {t('files.cancel')}
                      </button>
                      <button className="btn sm danger" disabled={edit.phase === 'overwriting'} onClick={() => void save(true)}>
                        {edit.conflict.version === null
                          ? edit.phase === 'overwriting'
                            ? t('files.view.creating')
                            : t('files.view.recreate')
                          : edit.phase === 'overwriting'
                            ? t('files.view.overwriting')
                            : t('files.view.overwrite')}
                      </button>
                    </div>
                  )}
                </div>
              )}
              <FileEditor
                key={edit.path}
                path={edit.path}
                text={edit.base}
                readOnly={!editable(edit)}
                onDirty={(dirty) => dispatchEdit({ type: 'change', dirty })}
                onSave={() => void save()}
                handleRef={editor}
              />
              <p className="hint ehint">
                {rich('files.view.editorHint', {
                  save: ctrlKey('S'),
                  find: ctrlKey('F'),
                  undo: ctrlKey('Z'),
                  redo: ctrlKey('Y'),
                  esc: <kbd>{t('files.key.esc')}</kbd>,
                  // i18n-exempt: nom de touche
                  tab: <kbd>Tab</kbd>,
                })}
              </p>
            </div>
          ) : text != null &&
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
          {pick && file && !edit && (
            <div className="selfloat" style={{ top: pick.top, left: pick.left }}>
              {commentText !== null ? (
                <CommentBox
                  title={`${file}:${linesLabel(pick.span.line, pick.span.lineEnd)}${pickStale ? t('files.view.pickStaleSuffix') : ''}`}
                  text={commentText}
                  onText={setCommentText}
                  onSave={saveComment}
                  onCancel={cancelComment}
                  label={t('files.view.commentOnLines', { lines: linesLabel(pick.span.line, pick.span.lineEnd) })}
                  placeholder={t('files.view.pickPlaceholder')}
                />
              ) : pickError ? (
                <span className="inline-err" role="alert">
                  {t('files.view.cantComment', { error: pickError })}
                </span>
              ) : draftFull ? (
                <span className="inline-err" role="alert">
                  {t('files.review.limit', { max: MAX_COMMENTS })}
                </span>
              ) : (
                <button
                  type="button"
                  className="btn sm pri"
                  // Garder la sélection visible au clic.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setCommentText('')}
                >
                  {pick.span.lineEnd > pick.span.line
                    ? t('files.view.commentLines', { lines: linesLabel(pick.span.line, pick.span.lineEnd) })
                    : t('files.view.commentLine', { line: pick.span.line })}
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
            files={reviewFiles}
            onSent={onSent}
            blockedReason={edit?.dirty ? unsavedBlocks : null}
            onOpenFile={(path, line) => {
              if (path !== file) openFile(path, null, () => setPendingLine({ path, line }))
              else setPendingLine({ path, line })
            }}
            {...(onOpenCommit ? { onOpenCommit } : {})}
          />
        )}
      </div>
      {diffOf && edit && (
        <EditDiffDialog
          path={edit.path}
          base={edit.base}
          current={edit.conflict?.content ?? null}
          currentError={edit.conflict?.loadError ?? null}
          mine={diffOf.mine}
          onClose={() => setDiffOf(null)}
        />
      )}
      {showToc && rendered && (
        <nav className="toc" aria-label={t('files.view.toc')}>
          <span className="lbl">{t('files.view.toc')}</span>
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
