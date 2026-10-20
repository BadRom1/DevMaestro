import { describe, expect, it } from 'vitest'

import type { PastSession, ProjectInfo } from '../src/shared/protocol'
import { COLLAPSE_KEY, loadCollapsed, saveCollapsed, toggleCollapsed, type KeyValueStorage } from '../src/renderer/src/state/collapse'
import { validHome } from '../src/shared/home'
import {
  RESOLVING_GROUP,
  folderName,
  groupByProject,
  groupPast,
  pastToOffer,
  type PastEntry,
} from '../src/renderer/src/state/projects'
import { initialState, needsResolve, reducer } from '../src/renderer/src/state/store'
import { tildify } from '../src/renderer/src/state/format'
import { session } from './fixtures'

const HOME = '/home/u'

function past(id: string, cwd: string | null, last: string, over: Partial<PastSession> = {}): PastEntry {
  return {
    claude_session_id: id,
    transcript_path: null,
    cwd,
    git_branch: null,
    first_prompt: null,
    title: null,
    first_timestamp: null,
    last_timestamp: last,
    message_count: 1,
    profile: 'default',
    ...over,
  }
}

const repo = (root: string, path = root): ProjectInfo => ({
  path,
  is_git: true,
  root,
  worktree_root: path,
  common_dir: `${root}/.git`,
  branch: 'main',
  name: root.split('/').pop()!,
})
const plain = (path: string): ProjectInfo => ({
  path,
  is_git: false,
  root: path,
  worktree_root: null,
  common_dir: null,
  branch: null,
  name: null,
})

describe('anciennes sessions groupées par origine', () => {
  const projects: Record<string, ProjectInfo> = {
    '/home/u/code/app': repo('/home/u/code/app'),
    '/home/u/code/app-wt': repo('/home/u/code/app', '/home/u/code/app-wt'),
    '/home/u/notes': plain('/home/u/notes'),
    [HOME]: plain(HOME),
  }

  it('dépôt (worktrees confondus), dossier, dossier personnel, dossier inconnu', () => {
    const groups = groupPast(
      [
        past('a', '/home/u/code/app', '2026-10-19T10:00:00Z', { git_branch: 'main' }),
        past('b', '/home/u/code/app-wt', '2026-10-19T12:00:00Z', { git_branch: 'feat' }),
        past('c', '/home/u/notes', '2026-10-19T11:00:00Z'),
        past('d', HOME, '2026-10-18T09:00:00Z'),
        past('e', null, '2026-10-17T09:00:00Z'),
      ],
      projects,
      HOME,
    )
    expect(groups.map((g) => [g.name, g.root, g.isGit, g.entries.map((e) => e.claude_session_id)])).toEqual([
      ['app', '/home/u/code/app', true, ['b', 'a']],
      ['notes', '/home/u/notes', false, ['c']],
      ['~', HOME, false, ['d']],
      ['Dossier inconnu', null, false, ['e']],
    ])
  })

  it('dossier pas encore résolu : groupe d’attente, puis son vrai groupe (jamais un groupe de dossier provisoire)', () => {
    const entries = [
      past('a', '/home/u/code/app-wt', '2026-10-19T10:00:00Z'),
      past('b', '/home/u/code/app', '2026-10-19T09:00:00Z'),
    ]
    const before = groupPast(entries, { '/home/u/code/app': repo('/home/u/code/app') }, HOME)
    expect(before.map((g) => [g.key, g.name, g.root, g.entries.map((e) => e.claude_session_id)])).toEqual([
      [RESOLVING_GROUP, 'Résolution…', null, ['a']],
      ['git:/home/u/code/app/.git', 'app', '/home/u/code/app', ['b']],
    ])
    const after = groupPast(entries, projects, HOME)
    expect(after.map((g) => [g.key, g.entries.map((e) => e.claude_session_id)])).toEqual([
      ['git:/home/u/code/app/.git', ['a', 'b']],
    ])
    // Échec de résolution (repli hors dépôt) : groupe de dossier.
    const failed = groupPast([past('c', '/disparu', '2026-10-19T10:00:00Z')], { '/disparu': plain('/disparu') }, HOME)
    expect(failed[0]).toMatchObject({ key: 'dossier:/disparu', name: 'disparu' })
  })

  it('tri par activité la plus récente, `last_activity` prioritaire, inconnu en dernier', () => {
    const groups = groupPast(
      [
        past('vieux', '/home/u/notes', '2026-01-01T00:00:00Z'),
        past('recent', '/home/u/notes', '2026-01-01T00:00:00Z', { last_activity: '2026-10-20T00:00:00Z' }),
        past('sans-date', '/home/u/notes', ''),
        past('autre', '/home/u/code/app', '2026-06-01T00:00:00Z'),
      ],
      projects,
      HOME,
    )
    expect(groups.map((g) => g.name)).toEqual(['notes', 'app'])
    expect(groups[0]!.entries.map((e) => e.claude_session_id)).toEqual(['recent', 'vieux', 'sans-date'])
  })

  it('une ancienne session déjà connue du démon n’est pas proposée deux fois', () => {
    const known = session({ claude_session_id: 'k' })
    const offer = pastToOffer(
      {
        default: [past('k', '/p', '2026-10-19T10:00:00Z'), past('a', '/p', '2026-10-18T10:00:00Z')],
        work: [past('b', '/p', '2026-10-19T09:00:00Z', { last_activity: '2026-10-20T09:00:00Z' })],
      },
      [known],
    )
    expect(offer.map((p) => [p.claude_session_id, p.profile])).toEqual([
      ['b', 'work'],
      ['a', 'default'],
    ])
  })
})

describe('sessions courantes hors dépôt', () => {
  it('groupées par dossier, « ~ » pour le dossier personnel', () => {
    const a = session({ cwd: HOME, project_root: HOME })
    const b = session({ cwd: '/home/u/notes', project_root: '/home/u/notes' })
    const groups = groupByProject([a, b], { [HOME]: plain(HOME), '/home/u/notes': plain('/home/u/notes') }, HOME)
    // Groupes courants : ordre par nom, stable (« ~ » trié avant les lettres).
    expect(groups.map((g) => [g.key, g.name]).sort()).toEqual([
      ['/home/u', '~'],
      ['/home/u/notes', 'notes'],
    ])
    expect(folderName(HOME, HOME)).toBe('~')
    expect(folderName('/home/u/a', HOME)).toBe('a')
    expect(folderName(HOME, null)).toBe('u')
  })
})

function memory(initial: Record<string, string> = {}): KeyValueStorage & { data: Record<string, string> } {
  const data = { ...initial }
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) }
}

describe('sections repliées', () => {
  it('bascule, enregistre et relit', () => {
    const st = memory()
    let keys = loadCollapsed(st)
    expect(keys.size).toBe(0)
    keys = toggleCollapsed(keys, 'past')
    keys = toggleCollapsed(keys, 'proj:/a')
    saveCollapsed(st, keys)
    expect([...loadCollapsed(st)]).toEqual(['past', 'proj:/a'])
    const back = toggleCollapsed(keys, 'past')
    expect(back.has('past')).toBe(false)
    expect(keys.has('past')).toBe(true) // pas de mutation
  })

  it('stockage absent, illisible ou qui lève : rien de replié, pas d’exception', () => {
    expect(loadCollapsed(null).size).toBe(0)
    expect(loadCollapsed(memory({ [COLLAPSE_KEY]: '{pas du json' })).size).toBe(0)
    expect(loadCollapsed(memory({ [COLLAPSE_KEY]: '{"a":1}' })).size).toBe(0)
    expect([...loadCollapsed(memory({ [COLLAPSE_KEY]: '["a",3,null]' }))]).toEqual(['a'])
    const throwing: KeyValueStorage = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    }
    expect(loadCollapsed(throwing).size).toBe(0)
    expect(() => saveCollapsed(throwing, new Set(['a']))).not.toThrow()
  })
})

describe('session retirée', () => {
  it('disparaît de l’état et de la sélection', () => {
    const a = session({ alive: false })
    const b = session()
    let st = reducer(initialState, { type: 'sessions', sessions: [a, b] })
    st = reducer(st, { type: 'select', id: a.id })
    st = reducer(st, { type: 'session.effect', id: a.id, effect: { type: 'possibly_stale', request_ids: [1] } })
    st = reducer(st, { type: 'session.removed', id: a.id })
    expect(Object.keys(st.sessions)).toEqual([b.id])
    expect(st.selectedId).toBeNull()
    expect(st.stale[a.id]).toBeUndefined()
    // Inconnue (déjà retirée localement) : rien ne change.
    expect(reducer(st, { type: 'session.removed', id: a.id })).toBe(st)
  })
})

describe('dossier personnel', () => {
  it('validé : chemin absolu, sans barre finale ni caractère nul', () => {
    expect(validHome('/home/u')).toBe('/home/u')
    expect(validHome('/home/u/')).toBe('/home/u')
    expect(validHome('/')).toBe('/')
    for (const v of [null, undefined, 3, '', 'home/u', '/a\0b', '/' + 'x'.repeat(5000)]) expect(validHome(v)).toBeNull()
  })

  it('« ~ » seulement pour le dossier personnel lui-même et ses descendants', () => {
    expect(tildify('/home/u', '/home/u')).toBe('~')
    expect(tildify('/home/u/code', '/home/u')).toBe('~/code')
    expect(tildify('/home/user2', '/home/u')).toBe('/home/user2')
    expect(tildify('/home/u', null)).toBe('/home/u')
    expect(folderName('/home/user2', '/home/u')).toBe('user2')
  })
})

describe('masquer une ancienne session', () => {
  it('retirée tout de suite, et les entrées masquées ne sont jamais proposées', () => {
    let st = reducer(initialState, {
      type: 'past',
      profile: 'default',
      sessions: [past('a', '/p', '2026-10-19T10:00:00Z'), past('b', '/p', '2026-10-19T09:00:00Z'), { ...past('h', '/p', '2026-10-19T08:00:00Z'), hidden: true }],
    })
    expect(st.past.default!.map((p) => p.claude_session_id)).toEqual(['a', 'b'])
    st = reducer(st, { type: 'past.hidden', profile: 'default', claude_session_id: 'a' })
    expect(st.past.default!.map((p) => p.claude_session_id)).toEqual(['b'])
    expect(reducer(st, { type: 'past.hidden', profile: 'autre', claude_session_id: 'b' })).toBe(st)
  })

  it('une session retirée de la liste ne revient pas dans « Anciennes sessions »', () => {
    const s = session({ alive: false, claude_session_id: 'k' })
    let st = reducer(initialState, { type: 'sessions', sessions: [s] })
    st = reducer(st, { type: 'past', profile: 'default', sessions: [past('k', '/p', '2026-10-19T10:00:00Z'), past('x', '/p', '2026-10-19T09:00:00Z')] })
    expect(pastToOffer(st.past, Object.values(st.sessions)).map((p) => p.claude_session_id)).toEqual(['x'])
    st = reducer(st, { type: 'session.removed', id: s.id })
    expect(pastToOffer(st.past, Object.values(st.sessions)).map((p) => p.claude_session_id)).toEqual(['x'])
  })
})

describe('résolution des dossiers', () => {
  it('un échec est provisoire : nouvel essai après le délai ou à la reconnexion', () => {
    const fb = plain('/disparu')
    expect(needsResolve(initialState, '/disparu', 0)).toBe(true)
    let st = reducer(initialState, { type: 'project.failed', cwd: '/disparu', fallback: fb, retryAt: 60_000 })
    expect(st.projects['/disparu']).toBe(fb)
    expect(needsResolve(st, '/disparu', 59_999)).toBe(false)
    expect(needsResolve(st, '/disparu', 60_000)).toBe(true)
    // Reconnexion : tout de suite.
    st = reducer(st, { type: 'connection', state: { state: 'connected', server: 'orchd', version: '0', pid: 1 } })
    expect(needsResolve(st, '/disparu', 1)).toBe(true)
    // Réussite : plus de nouvel essai.
    st = reducer(st, { type: 'project', cwd: '/disparu', info: repo('/disparu') })
    expect(needsResolve(st, '/disparu', 1e12)).toBe(false)
    expect(st.projectRetry).toEqual({})
  })

  it('un repli ne remplace pas une résolution déjà réussie', () => {
    const ok = repo('/r')
    let st = reducer(initialState, { type: 'project', cwd: '/r', info: ok })
    st = reducer(st, { type: 'project.failed', cwd: '/r', fallback: plain('/r'), retryAt: 10 })
    expect(st.projects['/r']).toBe(ok)
  })
})
