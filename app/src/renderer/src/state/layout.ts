/**
 * Disposition des onglets d'une session en zones (lot 16), à la manière de
 * VS Code : un arbre binaire de scissions dont les feuilles sont des zones,
 * chacune avec ses onglets et son onglet actif. Logique pure (aucun DOM) :
 * scinder, déplacer, fermer une zone vidée, limite de zones, rectangles de
 * mise en page, sérialisation et validation de ce qui est relu du stockage.
 *
 * Chaque onglet existe exactement une fois dans l'arbre ; une zone n'est
 * jamais vide (elle est fermée, sa sœur prend sa place).
 */
import type { KeyValueStorage } from './collapse'

/** Onglets d'une session, dans l'ordre de la disposition par défaut. */
export const TAB_IDS = ['conversation', 'terminal', 'diff', 'commits', 'files', 'agents', 'runners'] as const
export type TabId = (typeof TAB_IDS)[number]

export const TAB_LABELS: Record<TabId, string> = {
  conversation: 'Conversation',
  terminal: 'Terminal',
  diff: 'Diff',
  commits: 'Commits',
  files: 'Fichiers',
  agents: 'Agents',
  runners: 'Lancer',
}

/** Nombre maximal de zones. */
export const MAX_ZONES = 4
/** Bornes du ratio d'une scission (part de la première zone). */
export const MIN_RATIO = 0.15
export const MAX_RATIO = 0.85
/** Pas du clavier sur un séparateur de zones. */
export const RATIO_KEY_STEP = 0.05
/** Clé du stockage (disposition globale, commune à toutes les sessions). */
export const LAYOUT_KEY = 'devmaestro.layout.zones'

export interface Zone {
  kind: 'zone'
  id: string
  tabs: TabId[]
  active: TabId
}

/** Scission : `row` place `a` à gauche de `b`, `column` place `a` au-dessus de `b`. */
export interface Split {
  kind: 'split'
  id: string
  dir: 'row' | 'column'
  /** Part de `a`, entre `MIN_RATIO` et `MAX_RATIO`. */
  ratio: number
  a: LayoutNode
  b: LayoutNode
}

export type LayoutNode = Zone | Split

export interface Layout {
  root: LayoutNode
}

export type SplitSide = 'right' | 'bottom'
/** Cible d'un dépôt dans une zone : scinder (bande droite ou basse) ou y déplacer l'onglet (centre, barre). */
export type DropRegion = SplitSide | 'center'

export function isTabId(v: unknown): v is TabId {
  return typeof v === 'string' && (TAB_IDS as readonly string[]).includes(v)
}

export function defaultLayout(): Layout {
  return { root: { kind: 'zone', id: 'z1', tabs: [...TAB_IDS], active: 'terminal' } }
}

export function clampRatio(r: number): number {
  if (!Number.isFinite(r)) return 0.5
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, r))
}

/** Zones dans l'ordre de lecture (gauche avant droite, haut avant bas). */
export function zonesOf(l: Layout): Zone[] {
  const out: Zone[] = []
  const walk = (n: LayoutNode) => {
    if (n.kind === 'zone') out.push(n)
    else {
      walk(n.a)
      walk(n.b)
    }
  }
  walk(l.root)
  return out
}

export function zoneCount(l: Layout): number {
  return zonesOf(l).length
}

export function zoneById(l: Layout, id: string): Zone | undefined {
  return zonesOf(l).find((z) => z.id === id)
}

export function zoneOfTab(l: Layout, tab: TabId): Zone | undefined {
  return zonesOf(l).find((z) => z.tabs.includes(tab))
}

/** L'onglet est-il affiché (actif dans sa zone) ? */
export function isVisible(l: Layout, tab: TabId): boolean {
  return zoneOfTab(l, tab)?.active === tab
}

function mapNode(n: LayoutNode, f: (z: Zone) => LayoutNode | null): LayoutNode | null {
  if (n.kind === 'zone') return f(n)
  const a = mapNode(n.a, f)
  const b = mapNode(n.b, f)
  // Zone vidée : sa sœur prend la place de la scission.
  if (!a) return b
  if (!b) return a
  return a === n.a && b === n.b ? n : { ...n, a, b }
}

function mapZones(l: Layout, f: (z: Zone) => LayoutNode | null): Layout {
  const root = mapNode(l.root, f)
  return root === l.root ? l : { root: root ?? defaultLayout().root }
}

/** Active `tab` dans sa zone. */
export function activateTab(l: Layout, tab: TabId): Layout {
  const z = zoneOfTab(l, tab)
  if (!z || z.active === tab) return l
  return mapZones(l, (n) => (n.id === z.id ? { ...n, active: tab } : n))
}

/** Retire des onglets (zone vidée fermée). L'onglet actif d'une zone qui le perd devient son premier onglet. */
export function removeTabs(l: Layout, tabs: readonly TabId[]): Layout {
  if (!tabs.some((t) => zoneOfTab(l, t))) return l
  return mapZones(l, (z) => {
    if (!z.tabs.some((t) => tabs.includes(t))) return z
    const left = z.tabs.filter((t) => !tabs.includes(t))
    if (left.length === 0) return null
    return { ...z, tabs: left, active: left.includes(z.active) ? z.active : left[0]! }
  })
}

function nextId(l: Layout, prefix: 'z' | 's'): string {
  const used = new Set<string>()
  const walk = (n: LayoutNode) => {
    used.add(n.id)
    if (n.kind === 'split') {
      walk(n.a)
      walk(n.b)
    }
  }
  walk(l.root)
  let i = 1
  while (used.has(`${prefix}${i}`)) i++
  return `${prefix}${i}`
}

/** Scinder `target` en y plaçant `tab` à droite ou en bas est-il permis ? */
export function canSplit(l: Layout, tab: TabId, targetId: string): boolean {
  const source = zoneOfTab(l, tab)
  const target = zoneById(l, targetId)
  if (!source || !target) return false
  // Une zone ne se scinde pas avec son unique onglet.
  if (source.id === target.id && source.tabs.length === 1) return false
  const emptied = source.tabs.length === 1
  return zoneCount(l) - (emptied ? 1 : 0) + 1 <= MAX_ZONES
}

/**
 * Scinde la zone `targetId` : `tab` quitte sa zone (fermée si elle se vide)
 * pour une nouvelle zone à droite ou en bas de la cible, de même taille.
 * Refusé (disposition inchangée) au-delà de `MAX_ZONES`.
 */
export function splitZone(l: Layout, tab: TabId, targetId: string, side: SplitSide): Layout {
  if (!canSplit(l, tab, targetId)) return l
  const zid = nextId(l, 'z')
  const sid = nextId(l, 's')
  const without = removeTabs(l, [tab])
  return mapZones(without, (z) => {
    if (z.id !== targetId) return z
    return {
      kind: 'split',
      id: sid,
      dir: side === 'right' ? 'row' : 'column',
      ratio: 0.5,
      a: z,
      b: { kind: 'zone', id: zid, tabs: [tab], active: tab },
    }
  })
}

/** Déplace `tab` dans la zone `targetId` (en dernier, actif) ; sa zone d'origine se ferme si elle se vide. */
export function moveTab(l: Layout, tab: TabId, targetId: string): Layout {
  const source = zoneOfTab(l, tab)
  const target = zoneById(l, targetId)
  if (!source || !target || source.id === target.id) return l
  const without = removeTabs(l, [tab])
  return mapZones(without, (z) => (z.id === targetId ? { ...z, tabs: [...z.tabs, tab], active: tab } : z))
}

export function setRatio(l: Layout, splitId: string, ratio: number): Layout {
  const r = clampRatio(ratio)
  const walk = (n: LayoutNode): LayoutNode => {
    if (n.kind === 'zone') return n
    if (n.id === splitId) return n.ratio === r ? n : { ...n, ratio: r }
    const a = walk(n.a)
    const b = walk(n.b)
    return a === n.a && b === n.b ? n : { ...n, a, b }
  }
  const root = walk(l.root)
  return root === l.root ? l : { root }
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface ZoneRect extends Rect {
  zone: Zone
}

export interface SplitRect extends Rect {
  split: Split
}

/** Rectangles des zones et des scissions, en fractions (0 à 1) du conteneur. */
export function layoutRects(l: Layout): { zones: ZoneRect[]; splits: SplitRect[] } {
  const zones: ZoneRect[] = []
  const splits: SplitRect[] = []
  const walk = (n: LayoutNode, r: Rect) => {
    if (n.kind === 'zone') {
      zones.push({ zone: n, ...r })
      return
    }
    splits.push({ split: n, ...r })
    if (n.dir === 'row') {
      walk(n.a, { ...r, w: r.w * n.ratio })
      walk(n.b, { ...r, x: r.x + r.w * n.ratio, w: r.w * (1 - n.ratio) })
    } else {
      walk(n.a, { ...r, h: r.h * n.ratio })
      walk(n.b, { ...r, y: r.y + r.h * n.ratio, h: r.h * (1 - n.ratio) })
    }
  }
  walk(l.root, { x: 0, y: 0, w: 1, h: 1 })
  return { zones, splits }
}

/**
 * Cible d'un dépôt selon la position du pointeur dans le corps d'une zone
 * (en pixels, depuis son coin haut gauche) : bande droite ou basse (30 %) :
 * scinder ; ailleurs : déplacer.
 */
export function dropRegion(x: number, y: number, w: number, h: number): DropRegion {
  const rx = w > 0 ? x / w : 0
  const ry = h > 0 ? y / h : 0
  if (rx >= 0.7 && rx - 0.7 >= ry - 0.7) return 'right'
  if (ry >= 0.7) return 'bottom'
  return 'center'
}

/** Applique un dépôt de `tab` dans la zone `targetId`. */
export function applyDrop(l: Layout, tab: TabId, targetId: string, region: DropRegion): Layout {
  return region === 'center' ? moveTab(l, tab, targetId) : splitZone(l, tab, targetId, region)
}

/* ---------- Sérialisation et validation ---------- */

type Raw = Record<string, unknown>

function isObj(v: unknown): v is Raw {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Lit une disposition relue du stockage. Structure illisible, onglet inconnu
 * ou en double, zone vide, plus de `MAX_ZONES` zones, ratio hors bornes :
 * `null`. Un onglet absent (ajouté par une version suivante) rejoint la
 * première zone ; un onglet actif inconnu de sa zone devient son premier.
 * Les identifiants sont renumérotés.
 */
export function parseLayout(raw: unknown): Layout | null {
  if (!isObj(raw)) return null
  const seen = new Set<TabId>()
  let zones = 0
  let splits = 0
  let ok = true
  const walk = (n: unknown, depth: number): LayoutNode | null => {
    if (!ok || depth > MAX_ZONES || !isObj(n)) return (ok = false), null
    if (n.kind === 'zone') {
      if (!Array.isArray(n.tabs) || n.tabs.length === 0) return (ok = false), null
      const tabs: TabId[] = []
      for (const t of n.tabs) {
        if (!isTabId(t) || seen.has(t)) return (ok = false), null
        seen.add(t)
        tabs.push(t)
      }
      if (++zones > MAX_ZONES) return (ok = false), null
      return { kind: 'zone', id: `z${zones}`, tabs, active: isTabId(n.active) && tabs.includes(n.active) ? n.active : tabs[0]! }
    }
    if (n.kind === 'split') {
      if (n.dir !== 'row' && n.dir !== 'column') return (ok = false), null
      if (typeof n.ratio !== 'number' || !Number.isFinite(n.ratio) || n.ratio < MIN_RATIO || n.ratio > MAX_RATIO) return (ok = false), null
      const id = `s${++splits}`
      const a = walk(n.a, depth + 1)
      const b = walk(n.b, depth + 1)
      if (!a || !b) return (ok = false), null
      return { kind: 'split', id, dir: n.dir, ratio: n.ratio, a, b }
    }
    return (ok = false), null
  }
  const root = walk(raw.root, 0)
  if (!ok || !root) return null
  const missing = TAB_IDS.filter((t) => !seen.has(t))
  if (missing.length === 0) return { root }
  let added = false
  const filled = mapNode(root, (z) => {
    if (added) return z
    added = true
    return { ...z, tabs: [...z.tabs, ...missing] }
  })
  return { root: filled! }
}

export function serializeLayout(l: Layout): string {
  const strip = (n: LayoutNode): unknown =>
    n.kind === 'zone'
      ? { kind: 'zone', tabs: n.tabs, active: n.active }
      : { kind: 'split', dir: n.dir, ratio: Math.round(n.ratio * 1000) / 1000, a: strip(n.a), b: strip(n.b) }
  return JSON.stringify({ root: strip(l.root) })
}

/** Disposition retenue ; absente, illisible ou invalide : disposition par défaut. */
export function loadLayout(storage: KeyValueStorage | null | undefined): Layout {
  try {
    const raw = storage?.getItem(LAYOUT_KEY)
    if (!raw) return defaultLayout()
    return parseLayout(JSON.parse(raw)) ?? defaultLayout()
  } catch {
    return defaultLayout()
  }
}

export function saveLayout(storage: KeyValueStorage | null | undefined, l: Layout): void {
  try {
    storage?.setItem(LAYOUT_KEY, serializeLayout(l))
  } catch {
  }
}
