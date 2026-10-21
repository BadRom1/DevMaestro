/**
 * Documents déclaratifs des plugins (v0.3, lot 22a, ADR 0007) : schéma,
 * bornes et nettoyage, **les mêmes que le démon** (contrat du lot 22a,
 * « Documents déclaratifs »). Le démon valide et normalise déjà ; l'app
 * revalide avant tout rendu : un document invalide n'est pas affiché du
 * tout (seul le problème, traduit, l'est).
 *
 * - Champs connus seulement (recopiés ; un champ inconnu est ignoré) ; type
 *   de bloc inconnu, type de valeur faux ou borne dépassée : invalide.
 * - Texte tiers : tabulation → espace ; champs d'une ligne (`title`,
 *   `label`, `key`, `caption`) : sauts de ligne → espace ; contrôles retirés
 *   (sauf `\n` dans `markdown`, `detail` et le texte d'une `notice`) ;
 *   invisibles et caractères de direction retirés (`invisible.ts`).
 * - Bornes en caractères (points de code), comptés après nettoyage.
 *
 * Pur (aucun DOM) : partagé par la page et le processus principal
 * (validation des `args` d'une action).
 */
import { t } from './i18n'
import { INVISIBLE_CLASS } from './invisible'
import type { PluginArgs, PluginArgValue } from './protocol'

/** Nom d'un plugin (nom de son dossier, entre dans le nom du scope systemd). */
export const PLUGIN_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/
/** Identifiant d'une action déclarée dans le manifeste. */
export const PLUGIN_ACTION_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
/** Clé d'un argument d'action, identifiant d'une colonne de tableau. */
export const PLUGIN_KEY_RE = /^[a-z0-9_-]{1,32}$/
/** Empreinte d'un plugin : sha256 en hexadécimal minuscule. */
export const PLUGIN_FINGERPRINT_RE = /^[0-9a-f]{64}$/

export function isPluginName(v: unknown): v is string {
  return typeof v === 'string' && PLUGIN_NAME_RE.test(v)
}

export function isPluginActionId(v: unknown): v is string {
  return typeof v === 'string' && PLUGIN_ACTION_RE.test(v)
}

export function isPluginFingerprint(v: unknown): v is string {
  return typeof v === 'string' && PLUGIN_FINGERPRINT_RE.test(v)
}

export const MAX_ARGS = 16
export const MAX_ARG_STRING = 200
export const MIN_REFRESH_MS = 1000
export const MAX_REFRESH_MS = 60_000
export const MAX_PROPOSE_CHARS = 100_000
/** Contenu collé par `sessions.sendPrompt` : 256 Kio d'UTF-8 au plus (validation du processus principal). */
export const MAX_PROPOSE_BYTES = 256 * 1024

/* ---------- Types normalisés ---------- */

export type NoticeLevel = 'info' | 'warning' | 'error'
export type CellValue = string | number | null

export interface NoticeBlock {
  type: 'notice'
  title?: string
  level: NoticeLevel
  text: string
}
export interface MarkdownBlock {
  type: 'markdown'
  title?: string
  text: string
}
export interface KvBlock {
  type: 'kv'
  title?: string
  items: { key: string; value: string }[]
}
export interface ListBlock {
  type: 'list'
  title?: string
  ordered: boolean
  items: { text: string; detail?: string }[]
}
export interface TableColumn {
  id: string
  label: string
  align: 'start' | 'end'
}
export interface TableBlock {
  type: 'table'
  title?: string
  caption?: string
  columns: TableColumn[]
  rows: Record<string, CellValue>[]
}
export interface TreeNode {
  label: string
  detail?: string
  children: TreeNode[]
}
export interface TreeBlock {
  type: 'tree'
  title?: string
  nodes: TreeNode[]
}
export interface ActionItem {
  id: string
  label: string
  args?: PluginArgs
  primary: boolean
}
export interface ActionsBlock {
  type: 'actions'
  title?: string
  items: ActionItem[]
}
export type PluginBlock = NoticeBlock | MarkdownBlock | KvBlock | ListBlock | TableBlock | TreeBlock | ActionsBlock

export interface PluginDocument {
  title?: string
  refresh_ms?: number
  blocks: PluginBlock[]
}

/* ---------- Nettoyage du texte tiers ---------- */

const INVISIBLE = new RegExp(INVISIBLE_CLASS, 'gu')
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g
// eslint-disable-next-line no-control-regex
const CONTROLS_BUT_NL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g

export type TextKind = 'line' | 'multiline' | 'plain'

/**
 * Texte tiers nettoyé : `line` (champ d'une ligne : sauts de ligne → espace),
 * `multiline` (`\n` gardé), `plain` (tous les contrôles retirés).
 */
export function cleanPluginText(s: string, kind: TextKind): string {
  let v = s.replace(/\t/g, ' ')
  if (kind === 'line') v = v.replace(/\r\n|\r|\n/g, ' ')
  v = v.replace(kind === 'multiline' ? CONTROLS_BUT_NL : CONTROLS, '')
  return v.replace(INVISIBLE, '')
}

const REVEAL = new RegExp(`${INVISIBLE_CLASS}|[\\p{Cc}\\p{Cf}]`, 'gu')

/**
 * Texte du manifeste à faire relire (commande, fichiers, configuration,
 * nom) : caractères invisibles, de direction et de contrôle rendus
 * **visibles** (`⟨U+202E⟩`), pour que l'utilisateur voie ce qui sera exécuté.
 */
export function revealInvisible(s: string): string {
  return s.replace(REVEAL, (c) => `⟨U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}⟩`)
}

/* ---------- Validation ---------- */

class DocProblem extends Error {}

type Raw = Record<string, unknown>

function isObj(v: unknown): v is Raw {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function fail(problem: string): never {
  throw new DocProblem(problem)
}

function obj(v: unknown, path: string): Raw {
  if (!isObj(v)) fail(t('plugins.doc.notObject', { path }))
  return v
}

function text(v: unknown, path: string, max: number, kind: TextKind): string {
  if (typeof v !== 'string') fail(t('plugins.doc.notText', { path }))
  // Borne grossière avant le nettoyage (une chaîne immense n'est pas découpée en points de code).
  if (v.length > max * 4) fail(t('plugins.doc.tooLong', { path, max }))
  const clean = cleanPluginText(v, kind)
  if ([...clean].length > max) fail(t('plugins.doc.tooLong', { path, max }))
  return clean
}

/** Champ facultatif : absent ou `null` → `undefined`. */
function optText(v: unknown, path: string, max: number, kind: TextKind): string | undefined {
  return v === undefined || v === null ? undefined : text(v, path, max, kind)
}

function optBool(v: unknown, path: string): boolean {
  if (v === undefined || v === null) return false
  if (typeof v !== 'boolean') fail(t('plugins.doc.notBool', { path }))
  return v
}

function arr(v: unknown, path: string, min: number, max: number): unknown[] {
  if (!Array.isArray(v)) fail(t('plugins.doc.notList', { path }))
  if (v.length < min || v.length > max) fail(t('plugins.doc.count', { path, min, max }))
  return v
}

/**
 * Arguments d'une action (document ou appel de la page) : objet de
 * `MAX_ARGS` clés au plus (`PLUGIN_KEY_RE`), valeurs chaîne (200 caractères
 * au plus), nombre fini ou booléen. Renvoie les arguments recopiés, ou le
 * problème (texte traduit).
 */
export function checkPluginArgs(v: unknown, path = 'args'): PluginArgs | string {
  try {
    return argsOf(v, path)
  } catch (e) {
    if (e instanceof DocProblem) return e.message
    throw e
  }
}

function argsOf(v: unknown, path: string): PluginArgs {
  const o = obj(v, path)
  const entries = Object.entries(o)
  if (entries.length > MAX_ARGS) fail(t('plugins.doc.tooManyArgs', { path, max: MAX_ARGS }))
  const out: PluginArgs = {}
  for (const [k, x] of entries) {
    if (!PLUGIN_KEY_RE.test(k)) fail(t('plugins.doc.badKey', { path }))
    let value: PluginArgValue
    if (typeof x === 'string') {
      if ([...x].length > MAX_ARG_STRING) fail(t('plugins.doc.tooLong', { path: `${path}.${k}`, max: MAX_ARG_STRING }))
      value = x
    } else if (typeof x === 'number') {
      if (!Number.isFinite(x)) fail(t('plugins.doc.badArg', { path: `${path}.${k}` }))
      value = x
    } else if (typeof x === 'boolean') {
      value = x
    } else {
      fail(t('plugins.doc.badArg', { path: `${path}.${k}` }))
    }
    out[k] = value
  }
  return out
}

const MAX_TREE_DEPTH = 8
const MAX_TREE_NODES = 2000

function block(raw: unknown, path: string, actions: ReadonlySet<string>): PluginBlock {
  const b = obj(raw, path)
  const title = optText(b.title, `${path}.title`, 200, 'line')
  const head = title === undefined ? {} : { title }
  switch (b.type) {
    case 'notice': {
      const level = b.level
      if (level !== 'info' && level !== 'warning' && level !== 'error') fail(t('plugins.doc.badLevel', { path: `${path}.level` }))
      return { type: 'notice', ...head, level, text: text(b.text, `${path}.text`, 2000, 'multiline') }
    }
    case 'markdown':
      return { type: 'markdown', ...head, text: text(b.text, `${path}.text`, 20_000, 'multiline') }
    case 'kv':
      return {
        type: 'kv',
        ...head,
        items: arr(b.items, `${path}.items`, 1, 100).map((it, i) => {
          const p = `${path}.items[${i}]`
          const o = obj(it, p)
          return { key: text(o.key, `${p}.key`, 200, 'line'), value: text(o.value, `${p}.value`, 2000, 'plain') }
        }),
      }
    case 'list':
      return {
        type: 'list',
        ...head,
        ordered: optBool(b.ordered, `${path}.ordered`),
        items: arr(b.items, `${path}.items`, 0, 500).map((it, i) => {
          const p = `${path}.items[${i}]`
          const o = obj(it, p)
          const detail = optText(o.detail, `${p}.detail`, 2000, 'multiline')
          return { text: text(o.text, `${p}.text`, 2000, 'plain'), ...(detail === undefined ? {} : { detail }) }
        }),
      }
    case 'table': {
      const seen = new Set<string>()
      const columns = arr(b.columns, `${path}.columns`, 1, 12).map((c, i): TableColumn => {
        const p = `${path}.columns[${i}]`
        const o = obj(c, p)
        if (typeof o.id !== 'string' || !PLUGIN_KEY_RE.test(o.id)) fail(t('plugins.doc.badColumnId', { path: `${p}.id` }))
        if (seen.has(o.id)) fail(t('plugins.doc.duplicateColumn', { path: `${p}.id` }))
        seen.add(o.id)
        const align = o.align === undefined || o.align === null ? 'start' : o.align
        if (align !== 'start' && align !== 'end') fail(t('plugins.doc.badAlign', { path: `${p}.align` }))
        return { id: o.id, label: text(o.label, `${p}.label`, 200, 'line'), align }
      })
      const rows = arr(b.rows, `${path}.rows`, 0, 1000).map((r, i) => {
        const p = `${path}.rows[${i}]`
        const o = obj(r, p)
        const row: Record<string, CellValue> = {}
        for (const c of columns) {
          const v = Object.prototype.hasOwnProperty.call(o, c.id) ? o[c.id] : null
          if (v === null || v === undefined) row[c.id] = null
          else if (typeof v === 'string') row[c.id] = text(v, `${p}.${c.id}`, 2000, 'plain')
          else if (typeof v === 'number' && Number.isFinite(v)) row[c.id] = v
          else fail(t('plugins.doc.badCell', { path: `${p}.${c.id}` }))
        }
        return row
      })
      const caption = optText(b.caption, `${path}.caption`, 200, 'line')
      return { type: 'table', ...head, ...(caption === undefined ? {} : { caption }), columns, rows }
    }
    case 'tree': {
      let count = 0
      const node = (raw: unknown, p: string, depth: number): TreeNode => {
        if (depth > MAX_TREE_DEPTH) fail(t('plugins.doc.treeTooDeep', { path: p, max: MAX_TREE_DEPTH }))
        if (++count > MAX_TREE_NODES) fail(t('plugins.doc.treeTooBig', { path, max: MAX_TREE_NODES }))
        const o = obj(raw, p)
        const detail = optText(o.detail, `${p}.detail`, 2000, 'multiline')
        const kids = o.children === undefined || o.children === null ? [] : arr(o.children, `${p}.children`, 0, MAX_TREE_NODES)
        return {
          label: text(o.label, `${p}.label`, 500, 'line'),
          ...(detail === undefined ? {} : { detail }),
          children: kids.map((k, i) => node(k, `${p}.children[${i}]`, depth + 1)),
        }
      }
      return { type: 'tree', ...head, nodes: arr(b.nodes, `${path}.nodes`, 0, MAX_TREE_NODES).map((n, i) => node(n, `${path}.nodes[${i}]`, 1)) }
    }
    case 'actions':
      return {
        type: 'actions',
        ...head,
        items: arr(b.items, `${path}.items`, 1, 10).map((it, i): ActionItem => {
          const p = `${path}.items[${i}]`
          const o = obj(it, p)
          if (!isPluginActionId(o.id) || !actions.has(o.id)) fail(t('plugins.doc.undeclaredAction', { path: `${p}.id` }))
          const args = o.args === undefined || o.args === null ? undefined : argsOf(o.args, `${p}.args`)
          return {
            id: o.id,
            label: text(o.label, `${p}.label`, 100, 'line'),
            ...(args === undefined ? {} : { args }),
            primary: optBool(o.primary, `${p}.primary`),
          }
        }),
      }
    default:
      fail(t('plugins.doc.unknownBlock', { path: `${path}.type` }))
  }
}

/**
 * Document d'un plugin revalidé et normalisé. `actions` : identifiants des
 * actions déclarées dans le manifeste (un bouton d'une autre action rend le
 * document invalide).
 */
export function parsePluginDocument(raw: unknown, actions: readonly string[]): { ok: true; document: PluginDocument } | { ok: false; problem: string } {
  try {
    const d = obj(raw, 'document')
    const title = optText(d.title, 'title', 200, 'line')
    let refresh: number | undefined
    if (d.refresh_ms !== undefined && d.refresh_ms !== null) {
      const r = d.refresh_ms
      if (typeof r !== 'number' || !Number.isInteger(r) || r < MIN_REFRESH_MS || r > MAX_REFRESH_MS) {
        fail(t('plugins.doc.badRefresh', { min: MIN_REFRESH_MS, max: MAX_REFRESH_MS }))
      }
      refresh = r
    }
    const set = new Set(actions)
    const blocks = arr(d.blocks, 'blocks', 1, 50).map((b, i) => block(b, `blocks[${i}]`, set))
    return {
      ok: true,
      document: { ...(title === undefined ? {} : { title }), ...(refresh === undefined ? {} : { refresh_ms: refresh }), blocks },
    }
  } catch (e) {
    if (e instanceof DocProblem) return { ok: false, problem: e.message }
    throw e
  }
}

/**
 * Contenu proposé par une action (`propose.content`) : Markdown nettoyé
 * (invisibles et contrôles retirés, `\n` gardé), 100 000 caractères et
 * 256 Kio d'UTF-8 au plus (limite du collage par `sessions.sendPrompt`).
 */
export function parseProposeContent(raw: unknown): { ok: true; content: string } | { ok: false; problem: string } {
  if (!isObj(raw) || typeof raw.content !== 'string') return { ok: false, problem: t('plugins.doc.notText', { path: 'propose.content' }) }
  if (raw.content.length > MAX_PROPOSE_CHARS * 4) return { ok: false, problem: t('plugins.doc.tooLong', { path: 'propose.content', max: MAX_PROPOSE_CHARS }) }
  const content = cleanPluginText(raw.content, 'multiline')
  if ([...content].length > MAX_PROPOSE_CHARS) return { ok: false, problem: t('plugins.doc.tooLong', { path: 'propose.content', max: MAX_PROPOSE_CHARS }) }
  if (new TextEncoder().encode(content).length > MAX_PROPOSE_BYTES) return { ok: false, problem: t('plugins.doc.tooBig', { path: 'propose.content' }) }
  if (content.trim() === '') return { ok: false, problem: t('plugins.doc.empty', { path: 'propose.content' }) }
  return { ok: true, content }
}
