// @vitest-environment jsdom
/**
 * Lot 15 bis, lecteur de diff rendu avec React (démon simulé) : bascule
 * Liste / Arborescence retenue, dossiers repliables au clavier, j / k dans
 * l'ordre de l'arbre, `l` pour « vu », raccourcis ignorés dans un champ de
 * saisie (et dans un éditeur ou un terminal), compteur « +N −M » du fichier
 * ouvert, et j / k dans l'onglet Commits après un clic sur un commit.
 */
import { act, createElement, useReducer, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { CommitDiff, CommitsList, DiffFile, FileDiff, Session } from '../../src/shared/protocol'
import { emptyDraft, reviewReducer } from '../../src/renderer/src/state/review'
import { LIST_MODE_KEY } from '../../src/renderer/src/state/diffTree'
import { session } from '../fixtures'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SHA1 = 'b7c8b2317a1d853986572cb527064543b83aeb6c'
const SHA2 = '8bb4aef28b022f06c1d15a3c7b2159af379434a8'

const FILES: DiffFile[] = [
  { path: 'src/a/b/c.ts', status: 'M', additions: 3, deletions: 1, binary: false },
  { path: 'src/a/b/d.ts', status: 'M', additions: 2, deletions: 2, binary: false },
  { path: 'src/x.ts', status: 'A', additions: null, deletions: null, binary: false },
  { path: 'README.md', status: 'M', additions: 4, deletions: 0, binary: false },
]

/** Diff de fichier : 2 ajouts, 1 suppression (comptés quand la liste n'a pas de compteurs). */
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
        { kind: '+', old_no: null, new_no: 3, text: 'fin(a)' },
      ],
    },
  ],
}

const commits: CommitsList = {
  range: 'branch',
  base: { ref: 'main', sha: SHA2, kind: 'merge_base' },
  head: SHA1,
  commits: [
    { sha: SHA1, parents: [SHA2], author: 'Élodie', date: '2026-10-20T15:15:38+02:00', subject: 'Corrige l’export', body: '', files: 2, additions: 3, deletions: 1 },
    { sha: SHA2, parents: [], author: 'Romain', date: '2026-10-19T10:00:00Z', subject: 'Premier commit', body: '', files: 2, additions: 2, deletions: 0 },
  ],
  truncated: false,
}

const commitDiffs: Record<string, CommitDiff> = {}
const commitDiff: CommitDiff = {
  sha: SHA1,
  base: { ref: SHA2.slice(0, 7), sha: SHA2, kind: 'parent' },
  files: [
    { path: 'src/one.ts', status: 'M', additions: 1, deletions: 1, binary: false },
    { path: 'src/two.ts', status: 'M', additions: null, deletions: null, binary: false },
  ],
  truncated: false,
  skipped_non_utf8: 0,
}
commitDiffs[SHA1] = commitDiff
commitDiffs[SHA2] = {
  sha: SHA2,
  base: { ref: 'vide', sha: '', kind: 'root' },
  files: [
    { path: 'lib/four.ts', status: 'A', additions: 1, deletions: 0, binary: false },
    { path: 'src/three.ts', status: 'A', additions: 1, deletions: 0, binary: false },
  ],
  truncated: false,
  skipped_non_utf8: 0,
}

type DiffViewMod = typeof import('../../src/renderer/src/components/DiffView')
type CommitsMod = typeof import('../../src/renderer/src/components/CommitsView')
type ReaderMod = typeof import('../../src/renderer/src/components/DiffReader')
let DiffView: DiffViewMod['DiffView']
let CommitsView: CommitsMod['CommitsView']
let resetListModeForTests: ReaderMod['resetListModeForTests']
const calls: { method: string; params: Record<string, unknown> }[] = []

beforeAll(async () => {
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  const g = globalThis as { CSS?: { escape?: (s: string) => string } }
  g.CSS ??= {}
  g.CSS.escape ??= (s: string) => s.replace(/["\\]/g, '\\$&')
  ;(window as unknown as { devmaestro: object }).devmaestro = {
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      if (method === 'sessions.diffFile' || method === 'sessions.commitDiffFile') return { ok: true, result: fileDiff }
      if (method === 'sessions.commits') return { ok: true, result: commits }
      if (method === 'sessions.commitDiff') return { ok: true, result: commitDiffs[params.sha as string] }
      return { ok: false, error: { code: -32601, message: 'inconnue' } }
    },
  }
  ;({ DiffView } = await import('../../src/renderer/src/components/DiffView'))
  ;({ CommitsView } = await import('../../src/renderer/src/components/CommitsView'))
  ;({ resetListModeForTests } = await import('../../src/renderer/src/components/DiffReader'))
})

let root: Root | null = null
let host: HTMLElement | null = null
let seenLog: [string, boolean][] = []

beforeEach(() => {
  calls.length = 0
  seenLog = []
  localStorage.clear()
  resetListModeForTests()
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
})

function DiffHarness({ s }: { s: Session }) {
  const [draft, review] = useReducer(reviewReducer, emptyDraft)
  const [seen, setSeen] = useState<Record<string, boolean>>({})
  return createElement(DiffView, {
    session: s,
    diff: { summary: { base: { ref: 'main', sha: SHA2, kind: 'merge_base' }, files: FILES }, loading: false, error: null, version: 1, reload: () => {} },
    reviewFiles: FILES,
    draft,
    review,
    seen,
    onSeen: (path: string, value: boolean) => {
      seenLog.push([path, value])
      setSeen((m) => ({ ...m, [path]: value }))
    },
    onSent: () => {},
  })
}

function CommitsHarness({ s, focus = null }: { s: Session; focus?: { sessionId: string; sha: string; path: string; n: number } | null }) {
  const [draft, review] = useReducer(reviewReducer, emptyDraft)
  return createElement(CommitsView, { session: s, seq: 0, draft, review, reviewFiles: [], onSent: () => {}, focusCommit: focus })
}

async function render(el: ReturnType<typeof createElement>) {
  if (!root) {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  }
  await act(async () => root!.render(el))
  for (let i = 0; i < 5; i++) await act(async () => {})
}

const q = <T extends Element = HTMLElement>(sel: string) => host!.querySelector<T>(sel)
const qa = (sel: string) => [...host!.querySelectorAll<HTMLElement>(sel)]
const buttonNamed = (name: string) => qa('button').find((b) => b.textContent === name)!

async function key(target: Element, k: string) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
  })
  for (let i = 0; i < 3; i++) await act(async () => {})
}

const current = () => q('.dhead .path')!.textContent

describe('lecteur de diff : liste et arborescence', () => {
  it('bascule Liste / Arborescence retenue ; dossiers compactés avec agrégats', async () => {
    await render(createElement(DiffHarness, { s: session() }))
    expect(q('[role="tree"]')).toBeNull()
    expect(buttonNamed('Liste').getAttribute('aria-pressed')).toBe('true')
    await act(async () => buttonNamed('Arborescence').click())
    expect(localStorage.getItem(LIST_MODE_KEY)).toBe('tree')
    expect(buttonNamed('Arborescence').getAttribute('aria-pressed')).toBe('true')
    const items = qa('[role="treeitem"]')
    expect(items.map((i) => i.querySelector('.n')!.textContent)).toEqual(['src/', 'a/b/', 'c.ts', 'd.ts', 'x.ts', 'README.md'])
    const ab = items[1]!
    expect(ab.getAttribute('aria-expanded')).toBe('true')
    expect(ab.getAttribute('aria-level')).toBe('2')
    expect(ab.textContent).toContain('+5')
    expect(ab.textContent).toContain('−3')
    // Compteur inconnu dans « src » : signalé par du texte, pas par la couleur.
    expect(items[0]!.textContent).toContain('+5+?')
    expect(items[0]!.getAttribute('aria-label')).toContain('au moins un fichier non compté')

    // Remonté : le mode est relu depuis le stockage.
    act(() => root!.unmount())
    host!.remove()
    root = null
    resetListModeForTests()
    await render(createElement(DiffHarness, { s: session() }))
    expect(q('[role="tree"]')).not.toBeNull()
  })

  it('flèches gauche / droite replient et déplient ; j / k sautent les dossiers repliés', async () => {
    localStorage.setItem(LIST_MODE_KEY, 'tree')
    await render(createElement(DiffHarness, { s: session() }))
    // Sans clic : premier fichier de l'arbre (README.md, premier de la liste à plat, y est le dernier).
    expect(current()).toBe('src/a/b/c.ts')
    const first = q('[data-path="src/a/b/c.ts"]')!
    await key(first, 'j')
    expect(current()).toBe('src/a/b/d.ts')
    expect(document.activeElement?.getAttribute('data-path')).toBe('src/a/b/d.ts')

    const ab = q('[data-dir="src/a"]')!
    await key(ab, 'ArrowLeft')
    expect(q('[data-dir="src/a"]')!.getAttribute('aria-expanded')).toBe('false')
    expect(q('[data-path="src/a/b/c.ts"]')).toBeNull()
    // Fichier courant caché : j passe au suivant visible, k au précédent visible.
    await key(q('[data-dir="src/a"]')!, 'j')
    expect(current()).toBe('src/x.ts')
    await key(q('[data-path="src/x.ts"]')!, 'k')
    expect(current()).toBe('src/x.ts')

    await key(q('[data-dir="src/a"]')!, 'ArrowRight')
    expect(q('[data-dir="src/a"]')!.getAttribute('aria-expanded')).toBe('true')
    await key(q('[data-path="src/x.ts"]')!, 'k')
    expect(current()).toBe('src/a/b/d.ts')
    // Gauche sur un fichier : focus sur son dossier.
    await key(q('[data-path="src/a/b/d.ts"]')!, 'ArrowLeft')
    expect(document.activeElement?.getAttribute('data-dir')).toBe('src/a')
  })

  it('flèches sur la bascule Liste / Arborescence : aucun fichier ne change', async () => {
    await render(createElement(DiffHarness, { s: session() }))
    const before = current()
    await key(buttonNamed('Liste'), 'ArrowDown')
    expect(current()).toBe(before)
    await key(buttonNamed('Arborescence'), 'ArrowDown')
    expect(current()).toBe(before)
    await act(async () => buttonNamed('Arborescence').click())
    const inTree = current()
    await key(buttonNamed('Arborescence'), 'ArrowDown')
    expect(current()).toBe(inTree)
    await key(buttonNamed('Arborescence'), 'ArrowRight')
    expect(current()).toBe(inTree)
    expect(qa('[aria-expanded="false"]')).toHaveLength(0)
  })

  it('« l » bascule « vu » sur le fichier ouvert ; l’aide l’annonce', async () => {
    await render(createElement(DiffHarness, { s: session() }))
    expect(q('.files .hint.pad:last-child')!.textContent).toContain('l : vu / non vu')
    const row = q('[data-path="README.md"]')!
    await act(async () => row.click())
    await key(row, 'l')
    expect(seenLog).toEqual([['README.md', true]])
    expect(q<HTMLInputElement>('.dhead input[type="checkbox"]')!.checked).toBe(true)
    expect(q('[data-path="README.md"]')!.classList.contains('seen')).toBe(true)
    await key(row, 'l')
    expect(seenLog.at(-1)).toEqual(['README.md', false])
  })

  it('raccourcis ignorés dans un champ de saisie, un éditeur ou un terminal', async () => {
    await render(createElement(DiffHarness, { s: session() }))
    const before = current()
    const plus = q<HTMLButtonElement>('button[aria-label="Commenter la ligne 2 (nouvelle version)"]')!
    await act(async () => plus.click())
    const box = q<HTMLTextAreaElement>('.cbox textarea')!
    await key(box, 'j')
    await key(box, 'l')
    expect(current()).toBe(before)
    expect(seenLog).toEqual([])

    for (const cls of ['cm-editor', 'xterm']) {
      const outer = document.createElement('div')
      outer.className = cls
      const inner = document.createElement('div')
      inner.tabIndex = 0
      outer.append(inner)
      q('.dscroll')!.append(outer)
      await key(inner, 'j')
      expect(current()).toBe(before)
      outer.remove()
    }
  })

  it('compteur « +N −M » du fichier ouvert : de la liste, ou compté dans les hunks', async () => {
    await render(createElement(DiffHarness, { s: session() }))
    await act(async () => q('[data-path="src/a/b/c.ts"]')!.click())
    for (let i = 0; i < 3; i++) await act(async () => {})
    expect(q('.dhead .fcounts [aria-hidden="true"]')!.textContent).toBe('+3 −1')
    expect(q('.dhead .fcounts .sr-only')!.textContent).toBe('3 ajouts, 1 suppression')
    await act(async () => q('[data-path="src/x.ts"]')!.click())
    for (let i = 0; i < 3; i++) await act(async () => {})
    expect(q('.dhead .fcounts [aria-hidden="true"]')!.textContent).toBe('+2 −1')
  })
})

describe('onglet Commits : raccourcis', () => {
  it('j / k marchent après un clic sur un commit (focus dans la liste des commits)', async () => {
    await render(createElement(CommitsHarness, { s: session({ branch: 'romain/export', alive: true }) }))
    expect(current()).toBe('src/one.ts')
    const row = q<HTMLButtonElement>('.cmt-row')!
    await act(async () => {
      row.focus()
      row.click()
    })
    expect(document.activeElement).toBe(row)
    await key(row, 'j')
    expect(current()).toBe('src/two.ts')
    // Compteurs inconnus dans la liste : comptés dans les hunks.
    expect(q('.dhead .fcounts [aria-hidden="true"]')!.textContent).toBe('+2 −1')
    await key(document.activeElement!, 'k')
    expect(current()).toBe('src/one.ts')
    // Pas de « vu » dans Commits : « l » ne fait rien et l'aide ne l'annonce pas.
    const html = host!.innerHTML
    await key(document.activeElement!, 'l')
    expect(current()).toBe('src/one.ts')
    expect(host!.innerHTML).toBe(html)
    expect(q('.seen')).toBeNull()
    expect(q('.dhead input[type="checkbox"]')).toBeNull()
    expect(q('.files .hint.pad:last-child')!.textContent).not.toContain('vu')
  })

  it('fichier d’un autre commit choisi depuis ailleurs : révélé une fois la liste chargée', async () => {
    localStorage.setItem(LIST_MODE_KEY, 'tree')
    const s = session({ branch: 'romain/export', alive: true })
    await render(createElement(CommitsHarness, { s }))
    expect(current()).toBe('src/one.ts')
    await key(q('[data-dir="src"]')!, 'ArrowLeft')
    expect(q('[data-dir="src"]')!.getAttribute('aria-expanded')).toBe('false')
    await render(createElement(CommitsHarness, { s, focus: { sessionId: s.id, sha: SHA2, path: 'src/three.ts', n: 1 } }))
    expect(current()).toBe('src/three.ts')
    expect(q('[data-dir="src"]')!.getAttribute('aria-expanded')).toBe('true')
    expect(q('[data-path="src/three.ts"]')!.getAttribute('aria-selected')).toBe('true')
  })
})
