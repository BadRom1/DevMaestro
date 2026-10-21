/**
 * Lecteur de diff commun aux onglets « Diff » (worktree de la session),
 * « Commits » (diff d'un commit) et aux demandes de fusion de la forge :
 * liste des fichiers à plat ou en arborescence (j / k, flèches, `l` pour
 * « vu »), en-tête du fichier ouvert avec ses compteurs, lignes du diff avec
 * commentaire par ligne et boîte de commentaire.
 */
import {
  Fragment,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'

import { t as tGlobal } from '../../../shared/i18n'
import type { DiffFile, FileDiff } from '../../../shared/protocol'
import { useI18n, useT } from '../i18n'
import { browserStorage } from '../state/collapse'
import { additionsLabel, countLabel, deletionsLabel, fileCounts, statusLabel, stepFile, type DiffRow, type LineAnchor } from '../state/diff'
import {
  ancestorKeys,
  buildDiffTree,
  dirComments,
  firstFile,
  flattenTree,
  loadListMode,
  saveListMode,
  stepVisibleFile,
  type DiffListMode,
  type TreeRow,
} from '../state/diffTree'
import type { ReviewEditing } from '../state/review'
import { PathLabel } from './common'
import { CommentBox } from './ReviewBar'

/**
 * Cible où une lettre est du texte, jamais un raccourci : champ de saisie,
 * zone éditable (éditeur CodeMirror), terminal xterm.
 */
export function typing(t: EventTarget | null): boolean {
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return true
  if (!(t instanceof HTMLElement)) return false
  return t.isContentEditable || t.closest('.cm-editor, .xterm, [contenteditable="true"]') !== null
}

/* ---------- Mode d'affichage (Liste / Arborescence), commun à tous les lecteurs ---------- */

let listMode: DiffListMode | null = null
const listModeSubscribers = new Set<() => void>()

function currentListMode(): DiffListMode {
  listMode ??= loadListMode(browserStorage())
  return listMode
}

/** Mode de la liste des fichiers, retenu dans `localStorage` et partagé par les trois lecteurs. */
export function useListMode(): [DiffListMode, (m: DiffListMode) => void] {
  const mode = useSyncExternalStore(
    (cb) => {
      listModeSubscribers.add(cb)
      return () => listModeSubscribers.delete(cb)
    },
    currentListMode,
  )
  return [
    mode,
    (m) => {
      listMode = m
      saveListMode(browserStorage(), m)
      for (const cb of listModeSubscribers) cb()
    },
  ]
}

/** Oublie le mode lu (tests : relire le stockage). */
export function resetListModeForTests(): void {
  listMode = null
}

/** État de la liste d'un lecteur : mode, lignes de l'arbre et dossiers repliés. */
export interface FileNav {
  mode: DiffListMode
  setMode: (m: DiffListMode) => void
  /** Toutes les lignes de l'arbre (avec leur visibilité) ; vide en mode liste. */
  rows: TreeRow[]
  /** Fichier à choisir par défaut : le premier dans l'ordre affiché. */
  first: string | null
  setExpanded: (key: string, expanded: boolean) => void
}

/**
 * Mode et arbre de la liste des fichiers. Un fichier choisi depuis ailleurs
 * (« Voir le diff », liste de la revue) dans un dossier replié est révélé :
 * ses dossiers sont dépliés. Le repli n'est pas retenu d'un montage à l'autre.
 */
export function useFileNav(files: readonly DiffFile[], selected: string | null): FileNav {
  const [mode, setMode] = useListMode()
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  // Arbre recalculé seulement quand la liste change (pas à chaque frappe dans un commentaire).
  const nodes = useMemo(() => buildDiffTree(files), [files])
  const rows = mode === 'tree' ? flattenTree(nodes, collapsed) : []

  useEffect(() => {
    if (mode !== 'tree' || !selected) return
    const hidden = ancestorKeys(rows, selected).filter((k) => collapsed.has(k))
    if (hidden.length === 0) return
    setCollapsed((s) => {
      const next = new Set(s)
      for (const k of hidden) next.delete(k)
      return next
    })
  // `nodes` : un fichier choisi avant le chargement de sa liste (autre commit) est révélé une fois la liste là.
  }, [selected, mode, nodes])

  return {
    mode,
    setMode,
    rows,
    first: firstFile(files, mode, nodes),
    setExpanded: (key, expanded) =>
      setCollapsed((s) => {
        if (s.has(key) === !expanded) return s
        const next = new Set(s)
        if (expanded) next.delete(key)
        else next.add(key)
        return next
      }),
  }
}

function rowKey(el: Element | null): { kind: 'file' | 'dir'; key: string } | null {
  const row = el?.closest?.('[data-path], [data-dir]')
  if (!row) return null
  const path = row.getAttribute('data-path')
  return path !== null ? { kind: 'file', key: path } : { kind: 'dir', key: row.getAttribute('data-dir') ?? '' }
}

/**
 * Raccourcis du lecteur : `j` / `k` (partout dans le volet, hors saisie)
 * passent au fichier suivant / précédent dans l'ordre affiché (en
 * arborescence : fichiers des dossiers repliés sautés), `l` bascule « vu »
 * sur le fichier ouvert (là où « vu » existe). Dans la liste : flèches haut
 * et bas ; en arborescence, flèche droite (déplier, puis premier enfant) et
 * gauche (replier, puis dossier parent).
 */
export function fileKeys(
  files: readonly DiffFile[],
  selected: string | null,
  select: (path: string) => void,
  listRef: RefObject<HTMLElement | null>,
  opts: { nav?: FileNav; onToggleSeen?: () => void } = {},
): (e: KeyboardEvent<HTMLElement>) => void {
  const tree = opts.nav?.mode === 'tree' ? opts.nav : null
  const focusRow = (kind: 'file' | 'dir', key: string) =>
    listRef.current?.querySelector<HTMLElement>(`[data-${kind === 'file' ? 'path' : 'dir'}="${CSS.escape(key)}"]`)?.focus()

  function move(delta: 1 | -1) {
    const next = tree ? stepVisibleFile(tree.rows, selected, delta) : stepFile(files, selected, delta)
    if (!next) return
    select(next)
    focusRow('file', next)
  }

  /** Flèches dans l'arbre : lignes visibles (dossiers compris), comme le motif ARIA « tree ». */
  function treeArrow(nav: FileNav, key: string, target: EventTarget | null): boolean {
    const visible = nav.rows.filter((r) => r.visible)
    const at = rowKey(target as Element | null)
    const i = at ? visible.findIndex((r) => r.node.kind === at.kind && r.node.key === at.key) : -1
    const row = visible[i]
    const go = (r: TreeRow | undefined) => {
      if (!r) return
      if (r.node.kind === 'file') select(r.node.key)
      focusRow(r.node.kind, r.node.key)
    }
    if (key === 'ArrowDown') go(i < 0 ? visible[0] : visible[i + 1])
    else if (key === 'ArrowUp') go(i < 0 ? visible[0] : visible[i - 1])
    else if (key === 'ArrowRight') {
      if (row?.node.kind !== 'dir') return false
      if (!row.expanded) nav.setExpanded(row.node.key, true)
      else go(visible[i + 1]?.parent === row.node.key ? visible[i + 1] : undefined)
    } else if (key === 'ArrowLeft') {
      if (!row) return false
      if (row.node.kind === 'dir' && row.expanded) nav.setExpanded(row.node.key, false)
      else if (row.parent !== null) focusRow('dir', row.parent)
    } else return false
    return true
  }

  return (e) => {
    if (typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return
    // Flèches : seulement sur une ligne de la liste (pas sur la bascule Liste / Arborescence ni l'en-tête).
    const inList = listRef.current?.contains(e.target as Node) && rowKey(e.target as Element | null) !== null
    if (e.key === 'j') {
      e.preventDefault()
      move(1)
    } else if (e.key === 'k') {
      e.preventDefault()
      move(-1)
    } else if (e.key === 'l' && opts.onToggleSeen) {
      e.preventDefault()
      opts.onToggleSeen()
    } else if (inList && tree && treeArrow(tree, e.key, e.target)) {
      e.preventDefault()
    } else if (inList && !tree && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault()
      move(e.key === 'ArrowDown' ? 1 : -1)
    }
  }
}

function commentsWord(n: number): string {
  return n ? `, ${tGlobal('files.commentsCount', { count: n })}` : ''
}

function fileAria(f: DiffFile, n: number, isSeen: boolean): string {
  return `${f.path}, ${statusLabel(f.status)}, ${additionsLabel(f.additions)}, ${deletionsLabel(f.deletions)}${commentsWord(n)}${isSeen ? `, ${tGlobal('files.reader.seen')}` : ''}`
}

function Counts({ binary, additions, deletions, unknown = false }: { binary?: boolean; additions: number | null; deletions: number | null; unknown?: boolean }) {
  const t = useT()
  if (binary) return <>{t('files.reader.binary')}</>
  return (
    <>
      <span className="plus">
        +{countLabel(additions)}
        {unknown ? '+?' : ''}
      </span>{' '}
      <span className="minus">
        −{countLabel(deletions)}
        {unknown ? '−?' : ''}
      </span>
    </>
  )
}

/** Bascule Liste / Arborescence (choix retenu pour tous les lecteurs). */
function ModeToggle({ nav }: { nav: FileNav }) {
  const t = useT()
  return (
    <div className="seg fmode" role="group" aria-label={t('files.reader.modeLabel')}>
      <button type="button" aria-pressed={nav.mode === 'list'} onClick={() => nav.setMode('list')}>
        {t('files.reader.list')}
      </button>
      <button type="button" aria-pressed={nav.mode === 'tree'} onClick={() => nav.setMode('tree')}>
        {t('files.reader.tree')}
      </button>
    </div>
  )
}

/** Liste des fichiers d'un diff (à plat ou en arborescence ; statut, compteurs, commentaires). */
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
  nav,
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
  /** Mode et arbre (`useFileNav`) ; absent : liste à plat sans bascule. */
  nav?: FileNav
}) {
  const { t, rich } = useI18n()
  const tree = nav?.mode === 'tree' && files.length > 0 ? nav : null
  const visible = tree ? tree.rows.filter((r) => r.visible) : []
  const selectedVisible = visible.some((r) => r.node.kind === 'file' && r.node.key === selected)
  return (
    <div className="files" ref={listRef} aria-label={label}>
      <div className="fhead">{head}</div>
      {nav && <ModeToggle nav={nav} />}
      {files.length === 0 && <p className="hint pad">{empty}</p>}
      {tree ? (
        <ul role="tree" aria-label={label} className="dtree">
          {visible.map((r, i) => {
            // i18n-exempt: valeur CSS (largeur calculée)
            const style = { paddingLeft: `${8 + r.depth * 14}px` }
            const common = {
              // i18n-exempt: rôle ARIA (identifiant technique)
              role: 'treeitem',
              'aria-level': r.depth + 1,
              'aria-setsize': r.size,
              'aria-posinset': r.pos,
              onKeyDown: (e: KeyboardEvent<HTMLLIElement>) => {
                if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
                e.preventDefault()
                e.currentTarget.click()
              },
            } as const
            if (r.node.kind === 'dir') {
              const d = r.node
              const n = dirComments(d, comments)
              const count = d.paths.length
              return (
                <li
                  key={`d:${d.key}`}
                  {...common}
                  className="frow fdir"
                  style={style}
                  data-dir={d.key}
                  tabIndex={!selectedVisible && i === 0 ? 0 : -1}
                  aria-expanded={r.expanded}
                  aria-label={t('files.reader.dirAria', {
                    name: d.label,
                    state: r.expanded ? t('files.reader.expanded') : t('files.reader.collapsed'),
                    files: t('files.filesCount', { count }),
                    additions: additionsLabel(d.additions),
                    deletions: deletionsLabel(d.deletions),
                    unknown: d.unknown ? t('files.reader.someUncounted') : '',
                    comments: commentsWord(n),
                  })}
                  onClick={() => tree.setExpanded(d.key, !r.expanded)}
                >
                  <span className="chev" aria-hidden="true">
                    {r.expanded ? '▾' : '▸'}
                  </span>
                  <span className="n" title={d.path}>
                    {d.label}/
                  </span>
                  <span className="st2" aria-hidden="true">
                    {n > 0 && <span className="ccount">💬{n} </span>}
                    <Counts additions={d.additions} deletions={d.deletions} unknown={d.unknown} />
                  </span>
                </li>
              )
            }
            const f = r.node.file
            const n = comments(f.path)
            const isSeen = !!seen?.[f.path]
            const isSel = f.path === selected
            return (
              <li
                key={`f:${f.path}`}
                {...common}
                className={`frow${isSeen ? ' seen' : ''}`}
                style={style}
                data-path={f.path}
                tabIndex={isSel || (!selectedVisible && i === 0) ? 0 : -1}
                aria-selected={isSel}
                aria-label={fileAria(f, n, isSeen)}
                onClick={() => onSelect(f.path)}
              >
                <span className={`s s-${f.status === '?' ? 'u' : f.status}`} aria-hidden="true">
                  {f.status}
                </span>
                <span className="n" title={f.old_path ? `${f.old_path} → ${f.path}` : f.path}>
                  {r.node.label}
                </span>
                <span className="st2" aria-hidden="true">
                  {n > 0 && <span className="ccount">💬{n} </span>}
                  <Counts binary={f.binary} additions={f.additions} deletions={f.deletions} />
                </span>
              </li>
            )
          })}
        </ul>
      ) : (
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
                  aria-label={fileAria(f, n, isSeen)}
                  onClick={() => onSelect(f.path)}
                >
                  <span className={`s s-${f.status === '?' ? 'u' : f.status}`} aria-hidden="true">
                    {f.status}
                  </span>
                  <PathLabel inline className="n" path={f.path} title={f.old_path ? `${f.old_path} → ${f.path}` : f.path} />
                  <span className="st2" aria-hidden="true">
                    {n > 0 && <span className="ccount">💬{n} </span>}
                    <Counts binary={f.binary} additions={f.additions} deletions={f.deletions} />
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <p className="hint pad">
        {rich('files.reader.navHint', { j: <kbd>j</kbd>, k: <kbd>k</kbd> })}
        {seen && (
          <>
            {' · '}
            {rich('files.reader.seenHint', { l: <kbd>l</kbd> })}
          </>
        )}
        {tree && (
          <>
            {' · '}
            {rich('files.reader.foldHint', { left: <kbd>←</kbd>, right: <kbd>→</kbd> })}
          </>
        )}
      </p>
    </div>
  )
}

/**
 * Compteurs du fichier ouvert, en tête du diff : « +N −M » (ceux de la liste,
 * sinon comptés dans les hunks chargés), « binaire », ou rien tant qu'on ne
 * sait pas.
 */
export function FileHeadCounts({ file, fileDiff }: { file: DiffFile; fileDiff: FileDiff | null | undefined }) {
  const t = useT()
  if (file.binary || fileDiff?.binary) {
    return <span className="fcounts hint">{t('files.reader.binary')}</span>
  }
  const c = fileCounts(file, fileDiff)
  if (!c) return null
  return (
    <span className="fcounts">
      <span className="sr-only">{`${additionsLabel(c.additions)}, ${deletionsLabel(c.deletions)}`}</span>
      <span aria-hidden="true">
        <Counts additions={c.additions} deletions={c.deletions} />
      </span>
    </span>
  )
}

/** Commentaire en attente affiché sous sa ligne. */
export interface LineComment {
  id: number
  line: number
  text: string
}

/** Actions de la boîte de commentaire, communes au brouillon pour Claude et à celui de la forge. */
export type TableAction = { type: 'editText'; text: string } | { type: 'save' } | { type: 'cancel' } | { type: 'delete'; id: number }

/**
 * Lignes du diff d'un fichier, avec « + » pour commenter, commentaires en
 * attente et boîte ouverte. Le brouillon est celui de la revue pour Claude
 * (onglets Diff, Commits) ou celui de la forge (demande de fusion) : jamais
 * les deux à la fois.
 */
export function DiffTable({
  rows,
  draft,
  review,
  full,
  commentsAt,
  editingAt,
  onEdit,
  pendingLabel,
  maxChars,
  readOnly = false,
}: {
  rows: readonly DiffRow[]
  draft: { editing: Pick<ReviewEditing, 'text'> | null }
  review: (a: TableAction) => void
  /** Mention de chaque commentaire en attente (destination). */
  pendingLabel?: string
  /** Longueur maximale d'un commentaire (compteur de la boîte). */
  maxChars?: number
  /** Lecture seule : pas de « + ». */
  readOnly?: boolean
  /** Limite de commentaires atteinte : plus de « + ». */
  full: boolean
  commentsAt: (a: LineAnchor) => readonly LineComment[]
  editingAt: (a: LineAnchor) => boolean
  /** « + » d'une ligne : ouvre la boîte de commentaire. */
  onEdit: (a: LineAnchor, lineText: string) => void
}) {
  const t = useT()
  const pending = pendingLabel ?? t('files.reader.pending')
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
                  {a && !full && !readOnly && (
                    <button
                      type="button"
                      aria-label={t('files.reader.commentLine', { line: a.line, version: a.side === 'new' ? t('files.newVersion') : t('files.oldVersion') })}
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
                  <span className="sr-only">{r.kind === 'add' ? t('files.reader.srAdd') : r.kind === 'del' ? t('files.reader.srDel') : ''}</span>
                  {r.text}
                </td>
              </tr>
              {cms.map((c) => (
                <tr key={`c${c.id}`} className="cm">
                  <td colSpan={4}>
                    <div className="cbox">
                      <div className="who">
                        <span>{pending}</span>
                        <button
                          type="button"
                          className="btn sm ghost"
                          aria-label={t('files.reader.deleteComment', { line: c.line })}
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
                      {...(maxChars ? { max: maxChars } : {})}
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
