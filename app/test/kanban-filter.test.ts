import { describe, expect, it } from 'vitest'

import type { Session } from '../src/shared/protocol'
import type { KeyValueStorage } from '../src/renderer/src/state/collapse'
import {
  KANBAN_PANE_KEY,
  PROJECT_FILTER_KEY,
  cardSelected,
  filterFor,
  filterSessions,
  loadPaneOpen,
  loadProjectFilter,
  paneVisible,
  projectOptions,
  savePaneOpen,
  saveProjectFilter,
} from '../src/renderer/src/state/kanbanFilter'
import type { ProjectGroup } from '../src/renderer/src/state/projects'

const s = (id: string) => ({ id }) as Session
const group = (key: string, name: string, ids: string[], root = `/w/${name}`): ProjectGroup => ({
  key,
  name,
  root,
  isGit: true,
  sessions: ids.map(s),
  waiting: 0,
  missing: false,
})

const all = [s('a1'), s('a2'), s('b1'), s('c1')]
const groups = [group('/w/a/.git', 'alpha', ['a1', 'a2']), group('/w/b/.git', 'beta', ['b1']), group('/w/c', 'c', ['c1'])]

function memory(init: Record<string, string> = {}): KeyValueStorage & { data: Record<string, string> } {
  const data = { ...init }
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) }
}
const broken: KeyValueStorage = {
  getItem: () => {
    throw new Error('refusé')
  },
  setItem: () => {
    throw new Error('refusé')
  },
}

describe('filtre par projet de la vue par statut', () => {
  it('sans filtre : toutes les sessions', () => {
    expect(filterSessions(all, groups, null)).toBe(all)
  })

  it('un projet : les sessions de son groupe (appartenance au groupe)', () => {
    expect(filterSessions(all, groups, { key: '/w/a/.git', name: 'alpha' }).map((x) => x.id)).toEqual(['a1', 'a2'])
    // Un groupe fusionné (projet déplacé) garde des sessions d'une autre clé : elles suivent le groupe.
    const merged = [group('/w/a/.git', 'alpha', ['a1', 'old'])]
    expect(filterSessions([...all, s('old')], merged, { key: '/w/a/.git', name: 'alpha' }).map((x) => x.id)).toEqual(['a1', 'old'])
  })

  it('projet sans session : liste vide, filtre gardé avec son option à 0', () => {
    const gone = { key: '/w/z/.git', name: 'zeta' }
    expect(filterSessions(all, groups, gone)).toEqual([])
    expect(projectOptions(groups, gone).at(-1)).toEqual({ key: '/w/z/.git', label: 'zeta', count: 0 })
    expect(filterFor(groups, '/w/z/.git')).toBeNull()
  })

  it('options : ordre et noms de la barre latérale, nombre de sessions, homonymes distingués', () => {
    expect(projectOptions(groups, null)).toEqual([
      { key: '/w/a/.git', label: 'alpha', count: 2 },
      { key: '/w/b/.git', label: 'beta', count: 1 },
      { key: '/w/c', label: 'c', count: 1 },
    ])
    const twins = [group('k1', 'app', ['x'], '/w/un/app'), group('k2', 'app', ['y'], '/w/deux/app')]
    expect(projectOptions(twins, null).map((o) => o.label)).toEqual(['app — /w/un/app', 'app — /w/deux/app'])
    // Le projet retenu présent n'est pas ajouté deux fois.
    expect(projectOptions(groups, { key: '/w/b/.git', name: 'beta' })).toHaveLength(3)
  })

  it('filterFor reprend le nom actuel du groupe', () => {
    expect(filterFor(groups, '/w/b/.git')).toEqual({ key: '/w/b/.git', name: 'beta' })
    expect(filterFor(groups, null)).toBeNull()
  })

  it('mémorisation : aller-retour, valeurs illisibles et stockage indisponible', () => {
    const st = memory()
    saveProjectFilter(st, { key: '/w/a/.git', name: 'alpha' })
    expect(loadProjectFilter(st)).toEqual({ key: '/w/a/.git', name: 'alpha' })
    saveProjectFilter(st, null)
    expect(loadProjectFilter(st)).toBeNull()
    for (const raw of ['{', '42', '[]', '{"key":3}', '{"key":""}', 'null']) {
      expect(loadProjectFilter(memory({ [PROJECT_FILTER_KEY]: raw }))).toBeNull()
    }
    expect(loadProjectFilter(memory({ [PROJECT_FILTER_KEY]: '{"key":"/k"}' }))).toEqual({ key: '/k', name: '/k' })
    expect(loadProjectFilter(broken)).toBeNull()
    expect(loadProjectFilter(null)).toBeNull()
    expect(() => saveProjectFilter(broken, { key: 'k', name: 'n' })).not.toThrow()
  })
})

describe('volet de session dans la vue par statut', () => {
  it('ouverture retenue ; stockage indisponible : fermé', () => {
    const st = memory()
    expect(loadPaneOpen(st)).toBe(false)
    savePaneOpen(st, true)
    expect(st.data[KANBAN_PANE_KEY]).toBe('1')
    expect(loadPaneOpen(st)).toBe(true)
    savePaneOpen(st, false)
    expect(loadPaneOpen(st)).toBe(false)
    expect(loadPaneOpen(broken)).toBe(false)
    expect(() => savePaneOpen(broken, true)).not.toThrow()
  })

  it('affiché si ouvert et une session choisie existe ; fermé : jamais', () => {
    expect(paneVisible(true, s('a1'))).toBe(true)
    expect(paneVisible(false, s('a1'))).toBe(false)
    // Session oubliée (plus de sélection) : volet masqué, le choix « ouvert » reste.
    expect(paneVisible(true, null)).toBe(false)
  })

  it('choix « ouvert » retenu : le volet ne s’ouvre que sur une session choisie par l’utilisateur', () => {
    // Démarrage : sélection par défaut (pas un choix) → volet fermé malgré le choix retenu.
    expect(paneVisible(true, s('a1'), false)).toBe(false)
    // Clic sur une carte, notification, lancement : choix explicite → volet affiché.
    expect(paneVisible(true, s('a1'), true)).toBe(true)
    expect(paneVisible(false, s('a1'), true)).toBe(false)
  })

  it('carte mise en évidence : la session du volet ouvert seulement', () => {
    expect(cardSelected('a1', true, 'a1')).toBe(true)
    expect(cardSelected('a1', false, 'a1')).toBe(false)
    expect(cardSelected('a2', true, 'a1')).toBe(false)
  })
})
