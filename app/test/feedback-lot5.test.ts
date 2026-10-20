import { describe, expect, it } from 'vitest'

import type { PastSession, ProjectInfo } from '../src/shared/protocol'
import { defaultSettings, type ThemeMode, type ThemeSettings } from '../src/shared/settings'
import { groupByProject, groupPast, mergeMovedGroups, type PastEntry } from '../src/renderer/src/state/projects'
import { BASE_NEUTRALS, resolveScheme } from '../src/renderer/src/state/themeTokens'
import { terminalTheme, terminalThemeFrom } from '../src/renderer/src/theme'
import { session } from './fixtures'

const NL = '/home/romain/workplace/next-level.run'
const missing = (path: string): ProjectInfo => ({
  path,
  is_git: false,
  root: null,
  worktree_root: null,
  common_dir: null,
  branch: null,
  name: path.split('/').pop()!,
  exists: false,
  inferred: false,
})
const present = (path: string): ProjectInfo => ({ ...missing(path), root: path, exists: true })
const repo = (root: string): ProjectInfo => ({
  path: root,
  is_git: true,
  root,
  worktree_root: root,
  common_dir: `${root}/.git`,
  branch: 'main',
  name: root.split('/').pop()!,
  exists: true,
})

function past(id: string, cwd: string, last: string, branch: string | null = 'main'): PastEntry {
  const p: PastSession = {
    claude_session_id: id,
    transcript_path: null,
    cwd,
    git_branch: branch,
    first_prompt: null,
    title: null,
    first_timestamp: null,
    last_timestamp: last,
    message_count: 1,
  }
  return { ...p, profile: 'default' }
}

describe('projet déplacé : groupe disparu fusionné avec le dépôt du même nom', () => {
  it('sans branche connue (pas la preuve d’un dépôt git) : pas de fusion', () => {
    const projects: Record<string, ProjectInfo> = {
      [`${NL}/planner`]: missing(`${NL}/planner`),
      [NL]: present(NL),
      '/home/romain/code/planner': repo('/home/romain/code/planner'),
    }
    const groups = groupPast(
      [past('old', `${NL}/planner`, '2026-10-21T00:00:00Z', null), past('new', '/home/romain/code/planner', '2026-10-20T00:00:00Z')],
      projects,
      '/home/romain',
    )
    expect(groups.map((g) => [g.name, g.missing])).toEqual([
      ['planner', true],
      ['planner', false],
    ])
    const live = groupByProject(
      [session({ cwd: `${NL}/planner`, project_root: null, branch: null }), session({ cwd: '/home/romain/code/planner', project_root: '/home/romain/code/planner' })],
      projects,
      '/home/romain',
    )
    expect(live).toHaveLength(2)
  })

  const base: Record<string, ProjectInfo> = {
    [`${NL}/planner`]: missing(`${NL}/planner`),
    [`${NL}/planner/wt`]: missing(`${NL}/planner/wt`),
    [NL]: present(NL),
    '/home/romain/code/planner': repo('/home/romain/code/planner'),
  }

  it('un seul dépôt du même nom : fusion (sessions courantes et anciennes)', () => {
    const groups = groupPast(
      [past('old', `${NL}/planner/wt`, '2026-10-21T00:00:00Z'), past('new', '/home/romain/code/planner', '2026-10-20T00:00:00Z')],
      base,
      '/home/romain',
    )
    expect(groups.map((g) => [g.name, g.isGit, g.missing, g.entries.map((e) => e.claude_session_id)])).toEqual([
      ['planner', true, false, ['old', 'new']],
    ])
    expect(groups[0]!.latest).toBe(Date.parse('2026-10-21T00:00:00Z'))
    const live = groupByProject(
      [
        session({ cwd: `${NL}/planner`, project_root: null, status: { state: 'waiting', wait: 'permission' } }),
        session({ cwd: '/home/romain/code/planner', project_root: '/home/romain/code/planner' }),
      ],
      base,
      '/home/romain',
    )
    expect(live.map((g) => [g.name, g.isGit, g.sessions.length, g.waiting])).toEqual([['planner', true, 2, 1]])
  })

  it('deux dépôts du même nom : pas de fusion', () => {
    const projects = { ...base, '/srv/planner': repo('/srv/planner') }
    const groups = groupPast(
      [
        past('old', `${NL}/planner/wt`, '2026-10-21T00:00:00Z'),
        past('a', '/home/romain/code/planner', '2026-10-20T00:00:00Z'),
        past('b', '/srv/planner', '2026-10-19T00:00:00Z'),
      ],
      projects,
      '/home/romain',
    )
    expect(groups.map((g) => [g.name, g.missing])).toEqual([
      ['planner', true],
      ['planner', false],
      ['planner', false],
    ])
  })

  it('aucun dépôt du même nom : groupe à part', () => {
    const groups = groupPast([past('old', `${NL}/planner/wt`, '2026-10-21T00:00:00Z')], base, '/home/romain')
    expect(groups.map((g) => [g.key, g.missing])).toEqual([[`dossier:${NL}/planner`, true]])
    // Un dossier (pas un dépôt) du même nom ne compte pas.
    const g = mergeMovedGroups(
      [
        { name: 'x', missing: true, isGit: false, n: 1 },
        { name: 'x', missing: false, isGit: false, n: 2 },
      ],
      () => {
        throw new Error('pas de fusion attendue')
      },
      () => true,
    )
    expect(g).toHaveLength(2)
  })
})

describe('mode affiché : une seule résolution, à chaque transition', () => {
  const MODES: ThemeMode[] = ['system', 'light', 'dark']
  it.each([true, false])('système clair = %s', (systemLight) => {
    const expected = (m: ThemeMode) => (m === 'system' ? (systemLight ? 'light' : 'dark') : m)
    // Toutes les transitions Auto ↔ Clair ↔ Sombre, dans les deux sens.
    for (const from of MODES) {
      for (const to of MODES) {
        expect(resolveScheme(from, systemLight)).toBe(expected(from))
        const scheme = resolveScheme(to, systemLight)
        expect(scheme).toBe(expected(to))
        // Le terminal prend le fond du mode d'arrivée, pas celui de départ.
        const theme: ThemeSettings = { ...defaultSettings().theme, mode: to }
        expect(terminalTheme(theme, scheme).background).toBe(BASE_NEUTRALS[scheme].sunk)
      }
    }
  })

  it('séquence signalée : Auto (sombre) → Sombre → Clair → Sombre → Auto, puis Clair → Auto', () => {
    const seq: ThemeMode[] = ['system', 'dark', 'light', 'dark', 'system', 'light', 'system']
    const bg = seq.map((m) => terminalTheme({ ...defaultSettings().theme, mode: m }, resolveScheme(m, false)).background)
    expect(bg).toEqual(['#0b0d12', '#0b0d12', '#f7f8fb', '#0b0d12', '#0b0d12', '#f7f8fb', '#0b0d12'])
  })
})

describe('couleurs du terminal tirées des jetons', () => {
  it('lit les nouveaux jetons (palette, contraste élevé, couleurs choisies)', () => {
    const t = terminalThemeFrom({ sunk: '#101010', fg: '#eeeeee', accent: '#ff8800' }, 'dark')
    expect(t).toMatchObject({ background: '#101010', foreground: '#eeeeee', cursor: '#eeeeee', cursorAccent: '#101010', selectionBackground: '#ff88004d' })
    expect(terminalThemeFrom({ sunk: '#ffffff', fg: '#000000', accent: '#0033cc' }, 'light').selectionBackground).toBe('#0033cc38')
    const hc = terminalTheme({ mode: 'dark', palette: 'contraste', custom: { light: {}, dark: {} } }, 'dark')
    expect(hc.background).toBe('#000000')
    expect(hc.foreground).toBe('#ffffff')
    const custom = terminalTheme({ mode: 'light', palette: 'devmaestro', custom: { light: { accent: '#123456' }, dark: {} } }, 'light')
    expect(custom.selectionBackground).toBe('#12345638')
  })
})
