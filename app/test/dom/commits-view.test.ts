// @vitest-environment jsdom
/**
 * Onglet « Commits » rendu avec React (démon simulé) : liste et libellé du
 * mode, bascule qui force l'autre mode, relecture sur `session.diff_changed`
 * avec le même mode, fichiers et diff du commit choisi, commentaire de ligne
 * ajouté au brouillon commun, démon trop ancien.
 */
import { act, createElement, useReducer } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CommitDiff, CommitsList, FileDiff, Session } from '../../src/shared/protocol'
import { emptyDraft, reviewReducer, type ReviewDraft } from '../../src/renderer/src/state/review'
import { session } from '../fixtures'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SHA1 = 'b7c8b2317a1d853986572cb527064543b83aeb6c'
const SHA2 = '8bb4aef28b022f06c1d15a3c7b2159af379434a8'

type Calls = { method: string; params: Record<string, unknown> }[]
const calls: Calls = []
let oldDaemon = false
/** Réponse sans compteurs (`stats: false`, dépôt volumineux). */
let noStats = false

function listFor(range: unknown): CommitsList {
  const commits = [
    { sha: SHA1, parents: [SHA2], author: 'Élodie', date: '2026-10-20T15:15:38+02:00', subject: 'Corrige l’export', body: 'Détails\nsur deux lignes', files: 1, additions: 2, deletions: 1 },
    { sha: SHA2, parents: [], author: 'Romain', date: '2026-10-19T10:00:00Z', subject: 'Premier commit', body: '', files: 1, additions: 5, deletions: 0 },
  ]
  return range === 'recent'
    ? { range: 'recent', base: { ref: 'HEAD', sha: SHA1, kind: 'head' }, head: SHA1, commits, truncated: false }
    : { range: 'branch', base: { ref: 'main', sha: SHA2, kind: 'merge_base' }, head: SHA1, commits: commits.slice(0, 1), truncated: false }
}

const commitDiff = (sha: string): CommitDiff => ({
  sha,
  base: { ref: SHA2.slice(0, 7), sha: SHA2, kind: 'parent' },
  files: [{ path: 'src/export.ts', status: 'M', additions: 2, deletions: 1, binary: false }],
  truncated: false,
  skipped_non_utf8: 0,
})

const fileDiff: FileDiff = {
  binary: false,
  too_large: false,
  hunks: [
    {
      header: '@@ -1,2 +1,3 @@',
      old_start: 1,
      old_lines: 2,
      new_start: 1,
      new_lines: 3,
      lines: [
        { kind: ' ', old_no: 1, new_no: 1, text: 'const a = 1' },
        { kind: '-', old_no: 2, new_no: null, text: 'export(a)' },
        { kind: '+', old_no: null, new_no: 2, text: 'exporter(a)' },
      ],
    },
  ],
}

type Mod = typeof import('../../src/renderer/src/components/CommitsView')
let CommitsView: Mod['CommitsView']

beforeAll(async () => {
  // jsdom n'a pas de moteur de mise en page : `PathLabel` mesure avec un ResizeObserver.
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  ;(window as unknown as { devmaestro: object }).devmaestro = {
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      if (oldDaemon) return { ok: false, error: { code: -32601, message: 'méthode inconnue' } }
      if (method === 'sessions.commits') {
        const list = listFor(params.range)
        return {
          ok: true,
          result: noStats
            ? { ...list, stats: false, commits: list.commits.map((c) => ({ ...c, files: null, additions: null, deletions: null })) }
            : list,
        }
      }
      if (method === 'sessions.commitDiff') return { ok: true, result: commitDiff(params.sha as string) }
      if (method === 'sessions.commitDiffFile') return { ok: true, result: fileDiff }
      return { ok: false, error: { code: -32601, message: 'inconnue' } }
    },
  }
  ;({ CommitsView } = await import('../../src/renderer/src/components/CommitsView'))
})

let root: Root | null = null
let host: HTMLElement | null = null
let latestDraft: ReviewDraft = emptyDraft

beforeEach(() => {
  calls.length = 0
  oldDaemon = false
  noStats = false
  latestDraft = emptyDraft
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
})

function Harness({ s, seq }: { s: Session; seq: number }) {
  const [draft, review] = useReducer(reviewReducer, emptyDraft)
  latestDraft = draft
  return createElement(CommitsView, { session: s, seq, draft, review, reviewFiles: [], onSent: () => undefined })
}

async function render(s: Session, seq = 0) {
  if (!root) {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  }
  await act(async () => {
    root!.render(createElement(Harness, { s, seq }))
  })
  // Réponses du démon simulé (promesses) puis effets qui en dépendent.
  for (let i = 0; i < 5; i++) await act(async () => {})
}

const q = <T extends Element = HTMLElement>(sel: string) => host!.querySelector<T>(sel)
const commitsCalls = () => calls.filter((c) => c.method === 'sessions.commits')

describe('onglet Commits', () => {
  // Chaque test a sa session : l'état de l'onglet est gardé par session.
  const fresh = () => session({ branch: 'romain/export', alive: true })

  it('liste, libellé du mode, premier commit choisi, ses fichiers et son diff', async () => {
    const s = fresh()
    await render(s)
    expect(commitsCalls()).toEqual([{ method: 'sessions.commits', params: { id: s.id } }])
    expect(q('.clist .lbl')!.textContent).toBe('Commits de la branche depuis main')
    const row = q('.cmt-row')!
    expect(row.getAttribute('aria-current')).toBe('true')
    expect(row.textContent).toContain('Corrige l’export')
    expect(row.textContent).toContain('b7c8b23')
    expect(row.textContent).toContain('Élodie')
    expect(q('.cbody summary')!.textContent).toBe('Message complet')
    expect(calls.some((c) => c.method === 'sessions.commitDiff' && c.params.sha === SHA1)).toBe(true)
    expect(calls.some((c) => c.method === 'sessions.commitDiffFile' && c.params.path === 'src/export.ts')).toBe(true)
    expect(q('.dhead .path')!.textContent).toBe('src/export.ts')
    expect(host!.querySelectorAll('table.code tr.add')).toHaveLength(1)
  })

  it('la bascule force l’autre mode, gardé pour la relecture sur session.diff_changed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const s = fresh()
      await render(s, 0)
      const toggle = [...host!.querySelectorAll('button')].find((b) => b.textContent === 'Voir les derniers commits de romain/export')!
      await act(async () => toggle.click())
      for (let i = 0; i < 5; i++) await act(async () => {})
      expect(commitsCalls().at(-1)!.params).toEqual({ id: s.id, range: 'recent' })
      expect(q('.clist .lbl')!.textContent).toBe('Derniers commits de romain/export')
      expect(host!.querySelectorAll('.cmt-row')).toHaveLength(2)

      const before = commitsCalls().length
      await render(s, 1)
      expect(commitsCalls()).toHaveLength(before)
      await act(async () => {
        vi.advanceTimersByTime(450)
      })
      for (let i = 0; i < 5; i++) await act(async () => {})
      expect(commitsCalls()).toHaveLength(before + 1)
      expect(commitsCalls().at(-1)!.params).toEqual({ id: s.id, range: 'recent' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('« + » sur une ligne : commentaire de commit dans le brouillon commun', async () => {
    await render(fresh())
    const plus = q<HTMLButtonElement>('button[aria-label="Commenter la ligne 2 (nouvelle version)"]')!
    await act(async () => plus.click())
    const box = q<HTMLTextAreaElement>('.cbox textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'Pourquoi renommer ?')
      box.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(latestDraft.comments).toEqual([
      { kind: 'commit', id: 1, sha: SHA1, path: 'src/export.ts', side: 'new', line: 2, text: 'Pourquoi renommer ?', lineText: 'exporter(a)' },
    ])
    expect(q('.fcomments summary')!.textContent).toBe('1 commentaire de commit dans la revue')
    expect(q('.fcomments .mono')!.textContent).toBe('b7c8b23 src/export.ts:2')
    expect(q('.cmt-row')!.textContent).toContain('💬1')
  })

  it('démon trop ancien : « mets orchd à jour »', async () => {
    oldDaemon = true
    await render(fresh())
    expect(q('[role="alert"]')!.textContent).toContain('mets orchd à jour')
  })

  it('retour sur l’onglet : liste affichée tout de suite (cache), défilements retrouvés, puis relecture', async () => {
    const s = fresh()
    await render(s)
    const list = q('.clist')!
    const diff = q('.dscroll')!
    await act(async () => {
      list.scrollTop = 80
      list.dispatchEvent(new Event('scroll'))
      diff.scrollTop = 50
      diff.dispatchEvent(new Event('scroll'))
    })
    act(() => root!.unmount())
    root = null
    host!.remove()
    const before = commitsCalls().length

    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    act(() => root!.render(createElement(Harness, { s, seq: 0 })))
    // Avant toute réponse du démon : la dernière liste est déjà là, avec son défilement.
    expect(host.querySelectorAll('.cmt-row')).toHaveLength(1)
    expect(q('.clist')!.scrollTop).toBe(80)
    for (let i = 0; i < 5; i++) await act(async () => {})
    expect(commitsCalls()).toHaveLength(before + 1)
    expect(q('.dscroll')!.scrollTop).toBe(50)
  })

  it('compteurs non calculés (stats: false) : « compteurs indisponibles », jamais 0', async () => {
    noStats = true
    await render(fresh())
    const row = q('.cmt-row')!
    expect(row.textContent).toContain('compteurs indisponibles')
    expect(row.textContent).not.toContain('+0')
    expect(row.getAttribute('aria-label')).toContain('compteurs indisponibles (dépôt volumineux)')
    expect(q('.clist .fhead')!.textContent).toContain('compteurs indisponibles (dépôt volumineux)')
  })
})
