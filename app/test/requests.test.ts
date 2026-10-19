import { describe, expect, it } from 'vitest'

import { groupByProject, pastToOffer } from '../src/renderer/src/state/projects'
import { formatUsd, relativeTime, tildify } from '../src/renderer/src/state/format'
import {
  answerability,
  buildAnswers,
  canAllowAlways,
  describeSuggestions,
  emptyDraft,
  summarizeToolInput,
  toggleOption,
} from '../src/renderer/src/state/requests'
import type { Question } from '../src/shared/protocol'
import { session } from './fixtures'

describe('demandes', () => {
  it('résumé de l’outil', () => {
    expect(summarizeToolInput('Bash', { command: 'npm test' })).toBe('npm test')
    expect(summarizeToolInput('Edit', { file_path: '/a/b.ts', old_string: 'x' })).toBe('/a/b.ts')
    expect(summarizeToolInput('Grep', { pattern: 'TODO', path: 'src' })).toBe('TODO dans src')
    expect(summarizeToolInput('Autre', { a: 1 })).toBe('{"a":1}')
  })

  it('suggestions « Toujours » (forme de Claude Code, sur la demande ou à côté)', () => {
    const rules = [
      {
        type: 'addRules',
        rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }],
        behavior: 'allow',
        destination: 'localSettings',
      },
      { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
      { inconnu: true },
    ]
    const onDemand = describeSuggestions({
      request_id: 1,
      pending: { kind: 'permission', tool_name: 'Bash', tool_input: {}, suggestions: rules },
    })
    expect(onDemand).toEqual([
      'autoriser Bash(npm test:*) (réglages locaux du projet)',
      'passer en mode acceptEdits (cette session)',
      '{"inconnu":true}',
    ])
    const beside = describeSuggestions({
      request_id: 1,
      pending: { kind: 'permission', tool_name: 'Bash', tool_input: {} },
      suggestions: [rules[0]],
    })
    expect(beside).toHaveLength(1)
  })

  it('« Toujours » : always_rules du démon en priorité, désactivé si vide', () => {
    const base = { kind: 'permission' as const, tool_name: 'Bash', tool_input: {} }
    const rule = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls' }], behavior: 'allow', destination: 'localSettings' }
    const mode = { type: 'setMode', mode: 'plan', destination: 'session' }
    const req = { request_id: 1, pending: { ...base, suggestions: [rule, mode], always_rules: [rule] } }
    expect(describeSuggestions(req)).toEqual(['autoriser Bash(ls) (réglages locaux du projet)'])
    expect(canAllowAlways(req)).toBe(true)
    expect(canAllowAlways({ request_id: 1, pending: { ...base, suggestions: [mode], always_rules: [] } })).toBe(false)
    // Information absente : on laisse essayer, le démon tranche.
    expect(canAllowAlways({ request_id: 1, pending: base })).toBe(true)
  })

  it('peut-on répondre depuis l’app ?', () => {
    const base = { kind: 'permission' as const, tool_name: 'Bash', tool_input: {} }
    expect(answerability({ request_id: 1, pending: base, answerable: true }).ok).toBe(true)
    expect(answerability({ request_id: 1, pending: base }).ok).toBe(true)
    expect(answerability({ request_id: 1, pending: base, answerable: false }).ok).toBe(false)
    expect(answerability({ request_id: 1, pending: { kind: 'question', detailed: false } }).ok).toBe(false)
  })

  const qs: Question[] = [
    { question: 'Quelle base ?', header: 'Base', multi_select: false, options: [{ label: 'SQLite' }, { label: 'Postgres' }] },
    { question: 'Quelles cibles ?', header: 'Cibles', multi_select: true, options: [{ label: 'Linux' }, { label: 'macOS' }] },
  ]

  it('réponses : libellé, liste, texte libre ; incomplet tant qu’il en manque', () => {
    let d = [emptyDraft(), emptyDraft()]
    expect(buildAnswers(qs, d).complete).toBe(false)
    d = [toggleOption(d[0]!, 'SQLite', false), toggleOption(toggleOption(d[1]!, 'Linux', true), 'macOS', true)]
    expect(buildAnswers(qs, d)).toEqual({
      answers: { 'Quelle base ?': 'SQLite', 'Quelles cibles ?': ['Linux', 'macOS'] },
      complete: true,
    })
    d[1] = toggleOption(d[1]!, 'Linux', true)
    d[1] = { ...d[1], other: ' BSD ' }
    d[0] = { ...d[0]!, other: 'DuckDB' }
    expect(buildAnswers(qs, d).answers).toEqual({ 'Quelle base ?': 'DuckDB', 'Quelles cibles ?': ['macOS', 'BSD'] })
  })
})

describe('projets et format', () => {
  it('regroupe par dossier commun git, à répondre en tête', () => {
    const a = session({ cwd: '/r/app', status: { state: 'idle' } })
    const b = session({ cwd: '/r/app-wt', branch: 'feat', status: { state: 'waiting', wait: 'question' } })
    const c = session({ cwd: '/autre', project_root: '/autre' })
    const groups = groupByProject([a, b, c], {
      '/r/app': { path: '/r/app', is_git: true, root: '/r/app', worktree_root: '/r/app', common_dir: '/r/app/.git', branch: 'main', name: 'app' },
      '/r/app-wt': { path: '/r/app-wt', is_git: true, root: '/r/app', worktree_root: '/r/app-wt', common_dir: '/r/app/.git', branch: 'feat', name: 'app' },
    })
    expect(groups.map((g) => g.name)).toEqual(['app', 'autre'])
    expect(groups[0]!.sessions.map((s) => s.id)).toEqual([b.id, a.id])
    expect(groups[0]!.waiting).toBe(1)
  })

  it('anciennes sessions : sans celles déjà connues du démon, plus récentes d’abord', () => {
    const known = session({ claude_session_id: 'k' })
    const p = (id: string, t: string) => ({
      claude_session_id: id, transcript_path: null, cwd: '/x', git_branch: null, first_prompt: null,
      title: null, first_timestamp: null, last_timestamp: t, message_count: 1,
    })
    const offer = pastToOffer({ default: [p('k', '2026-10-19T10:00:00Z'), p('a', '2026-10-18T10:00:00Z')], work: [p('b', '2026-10-19T09:00:00Z')] }, [known])
    expect(offer.map((o) => [o.claude_session_id, o.profile])).toEqual([['b', 'work'], ['a', 'default']])
  })

  it('format français', () => {
    const now = Date.parse('2026-10-19T12:00:00Z')
    expect(relativeTime('2026-10-19T11:59:40Z', now)).toBe("à l'instant")
    expect(relativeTime('2026-10-19T11:55:00Z', now)).toBe('il y a 5 min')
    expect(relativeTime('2026-10-19T09:00:00Z', now)).toBe('il y a 3 h')
    expect(relativeTime('2026-10-18T09:00:00Z', now)).toBe('hier')
    expect(relativeTime(null, now)).toBe('inconnue')
    expect(formatUsd(0.2234)).toMatch(/^0,22\s\$$/)
    expect(formatUsd(null)).toBe('inconnu')
    expect(tildify('/home/u/code', '/home/u')).toBe('~/code')
    expect(tildify('/home/uu/code', '/home/u')).toBe('/home/uu/code')
  })
})

describe('repli de projet', () => {
  it('dossier non résolu : regroupé sous sa racine connue', async () => {
    const { fallbackProject } = await import('../src/renderer/src/state/projects')
    const s = session({ cwd: '/disparu/sous', project_root: '/disparu' })
    const info = fallbackProject(s)
    expect(info).toMatchObject({ is_git: false, root: '/disparu', common_dir: null })
    expect(groupByProject([s], { [s.cwd]: info })[0]).toMatchObject({ key: '/disparu', name: 'disparu' })
  })
})
