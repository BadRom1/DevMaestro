/**
 * Rendu natif d'un document de plugin (lot 22a), déjà revalidé par
 * `parsePluginDocument` : aucun HTML ni script venu du plugin, seulement
 * des composants de l'app et ses jetons CSS. Le texte du plugin est un
 * contenu tiers : direction isolée (`unicode-bidi: isolate`), Markdown sans
 * HTML brut ni image chargée, liens http(s) par la confirmation des liens.
 *
 * - Tableau : en-têtes de colonnes, tri par un bouton dans l'en-tête
 *   (`aria-sort`), donc au clavier.
 * - Arbre : `role="tree"` / `treeitem`, focus itinérant, flèches (haut, bas,
 *   droite : déplier ou premier enfant, gauche : replier ou parent),
 *   Début, Fin, Entrée.
 */
import { useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactElement } from 'react'

import { collator } from '../../../shared/i18n'
import type {
  ActionItem,
  CellValue,
  KvBlock,
  ListBlock,
  MarkdownBlock,
  NoticeBlock,
  PluginBlock,
  PluginDocument,
  TableBlock,
  TreeBlock,
  TreeNode,
} from '../../../shared/pluginDocument'
import { useI18n } from '../i18n'
import { classifyLink, renderMarkdown } from '../state/markdown'

export function PluginDocumentView({
  doc,
  onAction,
  busy,
  onLink,
}: {
  doc: PluginDocument
  onAction: (item: ActionItem) => void
  /** Requête en cours : boutons d'action désactivés. */
  busy: boolean
  onLink: (url: string) => void
}) {
  return (
    <div className="pdoc">
      {doc.title !== undefined && <h3 className="pd-title">{doc.title}</h3>}
      {doc.blocks.map((b, i) => (
        <section key={i} className={`pd-block pd-${b.type}`}>
          {b.title !== undefined && <h4 className="pd-btitle">{b.title}</h4>}
          <Block block={b} onAction={onAction} busy={busy} onLink={onLink} />
        </section>
      ))}
    </div>
  )
}

function Block({ block, onAction, busy, onLink }: { block: PluginBlock; onAction: (item: ActionItem) => void; busy: boolean; onLink: (url: string) => void }) {
  switch (block.type) {
    case 'notice':
      return <Notice block={block} />
    case 'markdown':
      return <Markdown block={block} onLink={onLink} />
    case 'kv':
      return <Kv block={block} />
    case 'list':
      return <List block={block} />
    case 'table':
      return <Table block={block} />
    case 'tree':
      return <Tree block={block} />
    case 'actions':
      return <Actions items={block.items} title={block.title} onAction={onAction} busy={busy} />
  }
}

const NOTICE_ICON: Record<NoticeBlock['level'], string> = { info: 'ℹ', warning: '⚠', error: '✖' }

function Notice({ block }: { block: NoticeBlock }) {
  const { t } = useI18n()
  const label = block.level === 'info' ? t('plugins.notice.info') : block.level === 'warning' ? t('plugins.notice.warning') : t('plugins.notice.error')
  return (
    <div className={`pd-notice ${block.level}`} role="note">
      <span className="pd-icon" aria-hidden="true">
        {NOTICE_ICON[block.level]}
      </span>
      <strong className="pd-level">{label}</strong>
      <span className="pd-text">{block.text}</span>
    </div>
  )
}

function Markdown({ block, onLink }: { block: MarkdownBlock; onLink: (url: string) => void }) {
  const prefix = useId().replace(/[^A-Za-z0-9_-]/g, '-')
  const ref = useRef<HTMLElement>(null)
  // `html: false` : le HTML brut est échappé, montré comme du texte ; images jamais chargées.
  const html = useMemo(() => renderMarkdown(block.text, { idPrefix: `pd${prefix}` }).html, [block.text, prefix])
  function onClick(e: MouseEvent<HTMLElement>) {
    const a = (e.target as HTMLElement).closest('a')
    if (!a) return
    e.preventDefault()
    const link = classifyLink(a.getAttribute('href'), '')
    if (link.kind === 'external') onLink(link.url)
    else if (link.kind === 'anchor') ref.current?.querySelector(`[id="pd${prefix}-${CSS.escape(link.id)}"]`)?.scrollIntoView({ block: 'start' })
  }
  return <article ref={ref} className="md pd-md" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
}

function Kv({ block }: { block: KvBlock }) {
  return (
    <dl className="pd-kv">
      {block.items.map((it, i) => (
        <div key={i} className="pd-kv-row">
          <dt>{it.key}</dt>
          <dd>{it.value}</dd>
        </div>
      ))}
    </dl>
  )
}

function List({ block }: { block: ListBlock }) {
  const { t } = useI18n()
  if (block.items.length === 0) return <p className="hint">{t('plugins.list.empty')}</p>
  const items = block.items.map((it, i) => (
    <li key={i}>
      <span className="pd-text">{it.text}</span>
      {it.detail !== undefined && <span className="pd-detail">{it.detail}</span>}
    </li>
  ))
  return block.ordered ? <ol className="pd-list">{items}</ol> : <ul className="pd-list">{items}</ul>
}

type Sort = { col: string; dir: 'ascending' | 'descending' } | null

/** Ordre des cellules : nombres avant textes, `null` en dernier (dans les deux sens). */
function compareCells(a: CellValue, b: CellValue, cmp: Intl.Collator): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'number') return -1
  if (typeof b === 'number') return 1
  return cmp.compare(a, b)
}

function Table({ block }: { block: TableBlock }) {
  const { t, locale } = useI18n()
  const [sort, setSort] = useState<Sort>(null)
  const rows = useMemo(() => {
    if (!sort) return block.rows
    const cmp = collator(locale)
    const sign = sort.dir === 'ascending' ? 1 : -1
    return block.rows
      .map((r, i) => ({ r, i }))
      .sort((x, y) => {
        const a = x.r[sort.col] ?? null
        const b = y.r[sort.col] ?? null
        if (a === null || b === null) return compareCells(a, b, cmp) || x.i - y.i
        return sign * compareCells(a, b, cmp) || x.i - y.i
      })
      .map((x) => x.r)
  }, [block.rows, sort, locale])
  function toggle(col: string) {
    setSort((s) => (s?.col === col ? { col, dir: s.dir === 'ascending' ? 'descending' : 'ascending' } : { col, dir: 'ascending' }))
  }
  return (
    <div className="pd-table-wrap">
      <table className="pd-table">
        {block.caption !== undefined && <caption>{block.caption}</caption>}
        <thead>
          <tr>
            {block.columns.map((c) => (
              <th key={c.id} scope="col" className={c.align === 'end' ? 'end' : undefined} aria-sort={sort?.col === c.id ? sort.dir : 'none'}>
                <button type="button" className="pd-sort" title={t('plugins.table.sortBy', { label: c.label })} onClick={() => toggle(c.id)}>
                  <span className="pd-text">{c.label}</span>
                  <span className="pd-sort-mark" aria-hidden="true">
                    {sort?.col === c.id ? (sort.dir === 'ascending' ? '▲' : '▼') : '↕'}
                  </span>
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {block.columns.map((c) => {
                const v = r[c.id] ?? null
                return (
                  <td key={c.id} className={c.align === 'end' ? 'end' : undefined}>
                    {v === null ? '' : typeof v === 'number' ? v.toLocaleString(locale) : v}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p className="hint">{t('plugins.table.empty')}</p>}
    </div>
  )
}

interface FlatNode {
  key: string
  node: TreeNode
  level: number
  parent: string | null
}

function Tree({ block }: { block: TreeBlock }) {
  const { t } = useI18n()
  /** Nœuds dépliés (chemin « 0.2.1 ») ; au départ, les racines. */
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(block.nodes.map((_, i) => String(i))))
  const [focus, setFocus] = useState<string>('0')
  const box = useRef<HTMLUListElement>(null)
  const visible = useMemo(() => {
    const out: FlatNode[] = []
    const walk = (nodes: TreeNode[], prefix: string, level: number, parent: string | null) => {
      nodes.forEach((n, i) => {
        const key = prefix ? `${prefix}.${i}` : String(i)
        out.push({ key, node: n, level, parent })
        if (n.children.length > 0 && open.has(key)) walk(n.children, key, level + 1, key)
      })
    }
    walk(block.nodes, '', 1, null)
    return out
  }, [block.nodes, open])
  if (block.nodes.length === 0) return <p className="hint">{t('plugins.tree.empty')}</p>
  const current = visible.some((v) => v.key === focus) ? focus : visible[0]!.key

  function move(key: string) {
    setFocus(key)
    box.current?.querySelector<HTMLElement>(`[data-key="${key}"]`)?.focus()
  }
  function toggle(key: string, value?: boolean) {
    setOpen((s) => {
      const n = new Set(s)
      if (value ?? !n.has(key)) n.add(key)
      else n.delete(key)
      return n
    })
  }
  function onKey(e: KeyboardEvent<HTMLLIElement>, f: FlatNode) {
    e.stopPropagation()
    const i = visible.findIndex((v) => v.key === f.key)
    const hasKids = f.node.children.length > 0
    const expanded = hasKids && open.has(f.key)
    let handled = true
    if (e.key === 'ArrowDown') visible[i + 1] && move(visible[i + 1]!.key)
    else if (e.key === 'ArrowUp') visible[i - 1] && move(visible[i - 1]!.key)
    else if (e.key === 'Home') move(visible[0]!.key)
    else if (e.key === 'End') move(visible[visible.length - 1]!.key)
    else if (e.key === 'ArrowRight') {
      if (hasKids && !expanded) toggle(f.key, true)
      else if (expanded) move(`${f.key}.0`)
    } else if (e.key === 'ArrowLeft') {
      if (expanded) toggle(f.key, false)
      else if (f.parent) move(f.parent)
    } else if (e.key === 'Enter' || e.key === ' ') {
      if (hasKids) toggle(f.key)
    } else handled = false
    if (handled) e.preventDefault()
  }

  /** Arbre imbriqué (rôles `group`), à partir de la liste des nœuds visibles. */
  const render = (parent: string | null): ReactElement[] =>
    visible
      .filter((v) => v.parent === parent)
      .map((f) => {
        const hasKids = f.node.children.length > 0
        const expanded = hasKids && open.has(f.key)
        return (
          <li
            key={f.key}
            role="treeitem"
            data-key={f.key}
            aria-level={f.level}
            aria-expanded={hasKids ? expanded : undefined}
            aria-selected={f.key === current}
            tabIndex={f.key === current ? 0 : -1}
            onKeyDown={(e) => {
              if (e.target === e.currentTarget) onKey(e, f)
            }}
            onFocus={(e) => {
              if (e.target === e.currentTarget) setFocus(f.key)
            }}
            onClick={(e) => {
              e.stopPropagation()
              setFocus(f.key)
              if (hasKids) toggle(f.key)
            }}
          >
            <span className="pd-node">
              <span className="pd-twisty" aria-hidden="true">
                {hasKids ? (expanded ? '▾' : '▸') : '·'}
              </span>
              <span className="pd-text">{f.node.label}</span>
              {f.node.detail !== undefined && <span className="pd-detail">{f.node.detail}</span>}
            </span>
            {expanded && <ul role="group">{render(f.key)}</ul>}
          </li>
        )
      })

  return (
    <ul className="pd-tree" role="tree" aria-label={block.title ?? t('plugins.tree.label')} ref={box}>
      {render(null)}
    </ul>
  )
}

function Actions({ items, title, onAction, busy }: { items: ActionItem[]; title?: string; onAction: (item: ActionItem) => void; busy: boolean }) {
  const { t } = useI18n()
  return (
    <div className="pd-actions" role="group" aria-label={title ?? t('plugins.panel.actionsLabel')}>
      {items.map((it, i) => (
        <button key={`${it.id}-${i}`} type="button" className={`btn sm${it.primary ? ' pri' : ''}`} disabled={busy} onClick={() => onAction(it)}>
          <span className="pd-text">{it.label}</span>
        </button>
      ))}
    </div>
  )
}
