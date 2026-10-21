/**
 * Disposition (lot 16), logique pure : zones d'onglets (scission, déplacement,
 * fermeture d'une zone vidée, limite de 4 zones, rectangles, cible de dépôt,
 * sérialisation et validation) et largeur des colonnes.
 */
import { describe, expect, it } from 'vitest'

import {
  activateTab,
  applyDrop,
  canSplit,
  defaultLayout,
  dropRegion,
  isVisible,
  layoutRects,
  loadLayout,
  LAYOUT_KEY,
  MAX_RATIO,
  MIN_RATIO,
  moveTab,
  parseLayout,
  removeTabs,
  saveLayout,
  serializeLayout,
  setRatio,
  splitZone,
  TAB_IDS,
  zoneCount,
  zoneOfTab,
  zonesOf,
  type Layout,
  type TabId,
} from '../src/renderer/src/state/layout'
import {
  clampColumn,
  columnMax,
  COLUMN_BOUNDS,
  COLUMNS_KEY,
  defaultColumns,
  loadColumns,
  MIN_SESSION_WIDTH,
  saveColumns,
} from '../src/renderer/src/state/columnWidth'

function memory(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init))
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m }
}

/** Chaque onglet exactement une fois, aucune zone vide. */
function wellFormed(l: Layout) {
  const all = zonesOf(l).flatMap((z) => z.tabs)
  expect([...all].sort()).toEqual([...TAB_IDS].sort())
  for (const z of zonesOf(l)) {
    expect(z.tabs.length).toBeGreaterThan(0)
    expect(z.tabs).toContain(z.active)
  }
}

const tabsOf = (l: Layout) => zonesOf(l).map((z) => z.tabs)

describe('disposition : opérations', () => {
  it('par défaut : une zone, les sept onglets, Terminal actif', () => {
    const l = defaultLayout()
    expect(zoneCount(l)).toBe(1)
    expect(tabsOf(l)).toEqual([[...TAB_IDS]])
    expect(isVisible(l, 'terminal')).toBe(true)
    wellFormed(l)
  })

  it('scinder à droite : l’onglet quitte sa zone pour une nouvelle zone à droite, de même taille, active', () => {
    const l = splitZone(defaultLayout(), 'diff', 'z1', 'right')
    expect(zoneCount(l)).toBe(2)
    expect(l.root.kind === 'split' && l.root.dir).toBe('row')
    expect(l.root.kind === 'split' && l.root.ratio).toBe(0.5)
    expect(tabsOf(l)[1]).toEqual(['diff'])
    expect(isVisible(l, 'diff')).toBe(true)
    expect(isVisible(l, 'terminal')).toBe(true)
    wellFormed(l)
    const { zones } = layoutRects(l)
    expect(zones.map(({ x, y, w, h }) => [x, y, w, h])).toEqual([
      [0, 0, 0.5, 1],
      [0.5, 0, 0.5, 1],
    ])
  })

  it('scinder en bas : scission verticale, nouvelle zone sous la cible', () => {
    const l = splitZone(splitZone(defaultLayout(), 'diff', 'z1', 'right'), 'files', zoneOfTab(defaultLayout(), 'terminal')!.id, 'bottom')
    expect(zoneCount(l)).toBe(3)
    const { zones } = layoutRects(l)
    const files = zones.find((z) => z.zone.tabs.includes('files'))!
    expect([files.x, files.y, files.w, files.h]).toEqual([0, 0.5, 0.5, 0.5])
    wellFormed(l)
  })

  it('une zone ne se scinde pas avec son unique onglet ; au plus 4 zones', () => {
    let l = splitZone(defaultLayout(), 'diff', 'z1', 'right')
    const diffZone = zoneOfTab(l, 'diff')!.id
    expect(canSplit(l, 'diff', diffZone)).toBe(false)
    expect(splitZone(l, 'diff', diffZone, 'bottom')).toBe(l)
    l = splitZone(l, 'commits', 'z1', 'bottom')
    l = splitZone(l, 'files', 'z1', 'right')
    expect(zoneCount(l)).toBe(4)
    expect(canSplit(l, 'agents', 'z1')).toBe(false)
    expect(splitZone(l, 'agents', 'z1', 'right')).toBe(l)
    // Une scission qui vide la zone d'origine garde le compte : permise à 4 zones.
    expect(canSplit(l, 'files', diffZone)).toBe(true)
    const moved = splitZone(l, 'files', diffZone, 'bottom')
    expect(zoneCount(moved)).toBe(4)
    wellFormed(moved)
  })

  it('déplacer : l’onglet rejoint la zone cible (actif) ; une zone vidée se ferme, sa sœur prend la place', () => {
    const two = splitZone(defaultLayout(), 'diff', 'z1', 'right')
    const back = moveTab(two, 'diff', 'z1')
    expect(zoneCount(back)).toBe(1)
    expect(back.root.kind).toBe('zone')
    expect(isVisible(back, 'diff')).toBe(true)
    wellFormed(back)
    // Déplacer vers sa propre zone : rien.
    expect(moveTab(two, 'terminal', 'z1')).toBe(two)
    // Zone inconnue : rien.
    expect(moveTab(two, 'terminal', 'z9')).toBe(two)
  })

  it('l’onglet actif d’une zone qui le perd devient son premier onglet', () => {
    const two = splitZone(defaultLayout(), 'terminal', 'z1', 'right')
    const z1 = zonesOf(two)[0]!
    expect(z1.active).toBe('conversation')
  })

  it('activer, retirer des onglets indisponibles (zone vidée fermée)', () => {
    const l = splitZone(defaultLayout(), 'runners', 'z1', 'bottom')
    expect(zoneCount(removeTabs(l, ['runners']))).toBe(1)
    expect(removeTabs(defaultLayout(), ['runners']).root).toMatchObject({ tabs: TAB_IDS.filter((t) => t !== 'runners') })
    const a = activateTab(defaultLayout(), 'files')
    expect(isVisible(a, 'files')).toBe(true)
    expect(isVisible(a, 'terminal')).toBe(false)
    expect(activateTab(a, 'files')).toBe(a)
  })

  it('ratio borné', () => {
    const l = splitZone(defaultLayout(), 'diff', 'z1', 'right')
    const id = l.root.kind === 'split' ? l.root.id : ''
    expect((setRatio(l, id, 0.01).root as { ratio: number }).ratio).toBe(MIN_RATIO)
    expect((setRatio(l, id, 2).root as { ratio: number }).ratio).toBe(MAX_RATIO)
    expect((setRatio(l, id, 0.3).root as { ratio: number }).ratio).toBe(0.3)
  })

  it('cible d’un dépôt : bande droite, bande basse, sinon centre', () => {
    expect(dropRegion(90, 50, 100, 100)).toBe('right')
    expect(dropRegion(50, 90, 100, 100)).toBe('bottom')
    expect(dropRegion(50, 50, 100, 100)).toBe('center')
    expect(dropRegion(95, 80, 100, 100)).toBe('right')
    expect(dropRegion(80, 95, 100, 100)).toBe('bottom')
    const l = applyDrop(defaultLayout(), 'diff', 'z1', 'right')
    expect(zoneCount(l)).toBe(2)
    expect(zoneCount(applyDrop(l, 'diff', 'z1', 'center'))).toBe(1)
  })
})

describe('disposition : sérialisation et validation', () => {
  const four = (() => {
    let l = splitZone(defaultLayout(), 'diff', 'z1', 'right')
    l = splitZone(l, 'commits', 'z1', 'bottom')
    l = splitZone(l, 'files', zoneOfTab(l, 'diff')!.id, 'bottom')
    return activateTab(l, 'agents')
  })()

  it('aller-retour : même structure, mêmes onglets actifs', () => {
    const s = memory()
    saveLayout(s, four)
    const back = loadLayout(s)
    expect(tabsOf(back)).toEqual(tabsOf(four))
    expect(zonesOf(back).map((z) => z.active)).toEqual(zonesOf(four).map((z) => z.active))
    expect(serializeLayout(back)).toBe(serializeLayout(four))
  })

  it('absente ou illisible : disposition par défaut', () => {
    expect(loadLayout(null)).toEqual(defaultLayout())
    expect(loadLayout(memory())).toEqual(defaultLayout())
    expect(loadLayout(memory({ [LAYOUT_KEY]: '{pas du json' }))).toEqual(defaultLayout())
    expect(loadLayout(memory({ [LAYOUT_KEY]: '[]' }))).toEqual(defaultLayout())
    const throwing = { getItem: () => { throw new Error('refusé') }, setItem: () => { throw new Error('refusé') } }
    expect(loadLayout(throwing)).toEqual(defaultLayout())
    expect(() => saveLayout(throwing, four)).not.toThrow()
  })

  const zone = (tabs: unknown[], active?: unknown) => ({ kind: 'zone', tabs, active })
  const split = (a: unknown, b: unknown, ratio: unknown = 0.5, dir: unknown = 'row') => ({ kind: 'split', dir, ratio, a, b })
  const rest = TAB_IDS.filter((t) => t !== 'diff')

  it.each([
    ['onglet inconnu', { root: zone([...TAB_IDS, 'pirate']) }],
    ['onglet en double', { root: split(zone([...TAB_IDS]), zone(['diff'])) }],
    ['zone vide', { root: split(zone([...TAB_IDS]), zone([])) }],
    ['ratio hors bornes', { root: split(zone(rest), zone(['diff']), 0.99) }],
    ['ratio non numérique', { root: split(zone(rest), zone(['diff']), '0.5') }],
    ['sens inconnu', { root: split(zone(rest), zone(['diff']), 0.5, 'diagonal') }],
    ['type inconnu', { root: { kind: 'onglets', tabs: [...TAB_IDS] } }],
    [
      'plus de 4 zones',
      { root: split(split(zone(['conversation', 'terminal']), zone(['diff'])), split(split(zone(['commits']), zone(['files'])), zone(['agents', 'runners']))) },
    ],
  ])('invalide (%s) : ignorée', (_why, raw) => {
    expect(parseLayout(raw)).toBeNull()
    expect(loadLayout(memory({ [LAYOUT_KEY]: JSON.stringify(raw) }))).toEqual(defaultLayout())
  })

  it('onglet absent (nouvelle version) : ajouté à la première zone ; onglet actif inconnu : premier de sa zone', () => {
    const raw = { root: split(zone(['terminal', 'diff'], 'fantôme'), zone(['files'])) }
    const l = parseLayout(raw)!
    wellFormed(l)
    expect(zonesOf(l)[0]!.tabs.slice(0, 2)).toEqual(['terminal', 'diff'])
    expect(zonesOf(l)[0]!.active).toBe('terminal')
    expect(zonesOf(l)[1]!.tabs).toEqual(['files'])
    // Identifiants renumérotés.
    expect(zonesOf(l).map((z) => z.id)).toEqual(['z1', 'z2'])
  })

  it('les opérations gardent chaque onglet une seule fois (suite aléatoire)', () => {
    let l = defaultLayout()
    let seed = 7
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n)
    for (let i = 0; i < 300; i++) {
      const tab = TAB_IDS[rnd(TAB_IDS.length)] as TabId
      const zs = zonesOf(l)
      const target = zs[rnd(zs.length)]!.id
      const op = rnd(3)
      l = op === 0 ? splitZone(l, tab, target, 'right') : op === 1 ? splitZone(l, tab, target, 'bottom') : moveTab(l, tab, target)
      wellFormed(l)
      expect(zoneCount(l)).toBeLessThanOrEqual(4)
      expect(parseLayout(JSON.parse(serializeLayout(l)))).not.toBeNull()
    }
  })
})

describe('colonnes', () => {
  it('bornées : minimum, maximum, place laissée à la session', () => {
    expect(clampColumn('sidebar', 10)).toBe(COLUMN_BOUNDS.sidebar.min)
    expect(clampColumn('sidebar', 5000)).toBe(COLUMN_BOUNDS.sidebar.max)
    expect(clampColumn('sidebar', 300.4)).toBe(300)
    expect(clampColumn('sidebar', Number.NaN)).toBe(COLUMN_BOUNDS.sidebar.def)
    expect(columnMax('sidebar', 900)).toBe(900 - MIN_SESSION_WIDTH)
    expect(clampColumn('sidebar', 500, 900)).toBe(900 - MIN_SESSION_WIDTH)
    // Fenêtre trop étroite : jamais sous le minimum.
    expect(columnMax('kanban', 500)).toBe(COLUMN_BOUNDS.kanban.min)
  })

  it('mémorisées ; illisibles ou hors bornes : largeur par défaut', () => {
    const s = memory()
    saveColumns(s, { sidebar: 320, kanban: 500 })
    expect(loadColumns(s)).toEqual({ sidebar: 320, kanban: 500 })
    expect(loadColumns(memory({ [COLUMNS_KEY]: '{"sidebar": 9999, "kanban": "large"}' }))).toEqual(defaultColumns())
    expect(loadColumns(memory({ [COLUMNS_KEY]: 'nope' }))).toEqual(defaultColumns())
    expect(loadColumns(null)).toEqual(defaultColumns())
  })
})
