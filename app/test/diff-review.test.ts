import { describe, expect, it } from 'vitest'

import { validateParams, ValidationError } from '../src/main/validate'
import type { DiffFile, FileDiff } from '../src/shared/protocol'
import { anchorKey, baseLabel, countLabel, diffRows, skippedCount, sortFiles, stepFile, totals } from '../src/renderer/src/state/diff'
import {
  MAX_COMMENTS,
  MAX_COMMENT_CHARS,
  activeComments,
  buildReview,
  commentsAt,
  emptyDraft,
  findAnchor,
  hasDraft,
  isDiffComment,
  reviewReducer,
  type ReviewAction,
  type ReviewDraft,
} from '../src/renderer/src/state/review'

const ID = '0c69fdc4-b2c9-4511-97c8-bb78d2323d61'

const f = (path: string, status: DiffFile['status'] = 'M', over: Partial<DiffFile> = {}): DiffFile => ({
  path,
  status,
  additions: 1,
  deletions: 1,
  binary: false,
  ...over,
})

describe('liste des fichiers', () => {
  it('ordre naturel par chemin, non suivis à la fin', () => {
    const files = [f('src/b10.ts'), f('notes.md', '?'), f('src/b2.ts'), f('README.md', 'A'), f('src/a/z.ts', 'D'), f('aaa.txt', '?')]
    expect(sortFiles(files).map((x) => x.path)).toEqual(['README.md', 'src/a/z.ts', 'src/b2.ts', 'src/b10.ts', 'aaa.txt', 'notes.md'])
    expect(files[0]!.path).toBe('src/b10.ts') // pas de mutation
  })

  it('navigation bornée, totaux, base', () => {
    const files = sortFiles([f('a'), f('b'), f('c')])
    expect(stepFile(files, 'a', 1)).toBe('b')
    expect(stepFile(files, 'c', 1)).toBe('c')
    expect(stepFile(files, 'a', -1)).toBe('a')
    expect(stepFile(files, 'disparu', 1)).toBe('a')
    expect(stepFile([], null, 1)).toBeNull()
    expect(totals([f('a', 'M', { additions: 3, deletions: 2 }), f('b', 'A', { additions: 5, deletions: 0 })])).toEqual({
      additions: 8,
      deletions: 2,
      unknown: false,
    })
    expect(baseLabel({ ref: 'origin/main', sha: 'a1b2c3d4e5f6', kind: 'merge_base' })).toBe('depuis origin/main (a1b2c3d)')
    expect(baseLabel({ ref: 'HEAD', sha: 'ffffffff00', kind: 'head' })).toBe('depuis le dernier commit HEAD (fffffff)')
    expect(baseLabel(null)).toBe('base inconnue')
  })
})

describe('modèle d’affichage des hunks', () => {
  const fd: FileDiff = {
    binary: false,
    too_large: false,
    hunks: [
      {
        header: '@@ -10,3 +10,4 @@ func main()',
        old_start: 10,
        old_lines: 3,
        new_start: 10,
        new_lines: 4,
        lines: [
          { kind: ' ', old_no: 10, new_no: 10, text: 'a' },
          { kind: '-', old_no: 11, new_no: null, text: 'b' },
          { kind: '+', old_no: null, new_no: 11, text: 'B' },
          { kind: '+', old_no: null, new_no: 12, text: 'C' },
          { kind: ' ', old_no: 12, new_no: 13, text: 'd' },
        ],
      },
      { header: '@@ -40 +41 @@', old_start: 40, old_lines: 1, new_start: 41, new_lines: 1, lines: [{ kind: '-', old_no: 40, new_no: 41, text: 'x' }] },
    ],
  }

  it('en-têtes, genres, numéros et ancres', () => {
    const rows = diffRows(fd)
    expect(rows.map((r) => (r.type === 'hunk' ? `H ${r.header}` : `${r.kind} ${r.oldNo ?? '-'} ${r.newNo ?? '-'} ${r.anchor ? anchorKey(r.anchor) : '∅'} ${r.text}`))).toEqual([
      'H @@ -10,3 +10,4 @@ func main()',
      'ctx 10 10 new:10 a',
      'del 11 - old:11 b',
      'add - 11 new:11 B',
      'add - 12 new:12 C',
      'ctx 12 13 new:13 d',
      'H @@ -40 +41 @@',
      // Ligne supprimée : seul l'ancien numéro compte, même si le démon en donne un nouveau.
      'del 40 - old:40 x',
    ])
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length)
  })

  it('binaire, trop gros, absent : aucune ligne', () => {
    expect(diffRows({ ...fd, binary: true })).toEqual([])
    expect(diffRows({ ...fd, too_large: true })).toEqual([])
    expect(diffRows(null)).toEqual([])
  })
})

function run(actions: ReviewAction[], from: ReviewDraft = emptyDraft): ReviewDraft {
  return actions.reduce(reviewReducer, from)
}

const edit = (path: string, side: 'new' | 'old', line: number, lineText = `l${line}`): ReviewAction => ({
  type: 'edit',
  path,
  anchor: { side, line },
  lineText,
})
const say = (text: string): ReviewAction[] => [{ type: 'editText', text }, { type: 'save' }]

describe('commentaires de revue', () => {
  it('ouvrir, saisir (brouillon dans la revue), enregistrer, annuler, supprimer', () => {
    let d = run([edit('a.ts', 'new', 3, 'const a = 1')])
    expect(d.editing).toEqual({ path: 'a.ts', side: 'new', line: 3, lineText: 'const a = 1', text: '' })
    d = run([{ type: 'editText', text: '  Pourquoi ?  ' }], d)
    expect(d.editing?.text).toBe('  Pourquoi ?  ')
    d = run([{ type: 'save' }], d)
    expect(d.editing).toBeNull()
    expect(d.comments).toEqual([{ id: 1, path: 'a.ts', side: 'new', line: 3, text: 'Pourquoi ?', lineText: 'const a = 1' }])
    // Texte vide : simple annulation.
    d = run([edit('a.ts', 'old', 7), ...say('   ')], d)
    expect(d.comments).toHaveLength(1)
    d = run([edit('b.ts', 'old', 7), { type: 'cancel' }], d)
    expect(d.editing).toBeNull()
    d = run([edit('a.ts', 'new', 3, 'const a = 1'), ...say('Autre')], d)
    expect(commentsAt(d, 'a.ts', { side: 'new', line: 3 }).map((c) => c.text)).toEqual(['Pourquoi ?', 'Autre'])
    expect(commentsAt(d, 'a.ts', { side: 'old', line: 3 })).toEqual([])
    d = run([{ type: 'delete', id: 1 }], d)
    expect(d.comments.map((c) => c.id)).toEqual([2])
    expect(run([{ type: 'save' }], emptyDraft)).toBe(emptyDraft) // rien d'ouvert
    expect(hasDraft(d)).toBe(true)
    d = run([{ type: 'clear' }], d)
    expect(hasDraft(d)).toBe(false)
    expect(d.nextId).toBe(3) // les identifiants ne reviennent pas
    expect(hasDraft(run([{ type: 'general', text: 'Bien' }]))).toBe(true)
    expect(hasDraft(run([{ type: 'general', text: '  ' }]))).toBe(false)
    // Un brouillon non enregistré compte aussi.
    expect(hasDraft(run([edit('a', 'new', 1), { type: 'editText', text: 'x' }]))).toBe(true)
  })

  it('limites : 4 000 caractères, 200 commentaires', () => {
    const d = run([edit('a', 'new', 1), { type: 'editText', text: '😀'.repeat(5000) }])
    expect([...d.editing!.text].length).toBe(MAX_COMMENT_CHARS)
    expect([...run([{ type: 'general', text: 'x'.repeat(5000) }]).general].length).toBe(MAX_COMMENT_CHARS)
    let full = emptyDraft
    for (let i = 1; i <= MAX_COMMENTS; i++) full = run([edit('a', 'new', i), ...say(`c${i}`)], full)
    expect(full.comments).toHaveLength(MAX_COMMENTS)
    expect(run([edit('a', 'new', 999)], full)).toBe(full) // plus de boîte au-delà
  })

  it('réancrage : même texte le plus proche, sinon « ligne modifiée » (hors compte)', () => {
    let d = emptyDraft
    d = run([edit('a.ts', 'new', 10, 'foo()'), ...say('sur foo')], d)
    d = run([edit('a.ts', 'old', 4, 'bar()'), ...say('sur bar')], d)
    d = run([edit('a.ts', 'new', 20, 'gone()'), ...say('disparu')], d)
    d = run([edit('a.ts', 'new', 30, 'baz()')], d)
    d = run([{ type: 'editText', text: 'brouillon' }], d)
    const fd: FileDiff = {
      binary: false,
      too_large: false,
      hunks: [
        {
          header: '@@',
          old_start: 1,
          old_lines: 1,
          new_start: 1,
          new_lines: 1,
          lines: [
            { kind: ' ', old_no: 2, new_no: 3, text: 'foo()' }, // loin
            { kind: ' ', old_no: 11, new_no: 12, text: 'foo()' }, // le plus proche de 10
            { kind: '-', old_no: 4, new_no: null, text: 'bar()' }, // inchangé
            { kind: '+', old_no: null, new_no: 33, text: 'baz()' },
          ],
        },
      ],
    }
    const rows = diffRows(fd)
    expect(findAnchor(rows, 'new', 10, 'foo()')).toBe(12)
    const r = run([{ type: 'reanchor', path: 'a.ts', rows }], d)
    expect(r.comments.map((c) => [c.text, c.line, isDiffComment(c) && !!c.stale])).toEqual([
      ['sur foo', 12, false],
      ['sur bar', 4, false],
      ['disparu', 20, true],
    ])
    // La boîte ouverte suit sa ligne et garde son brouillon.
    expect(r.editing).toMatchObject({ line: 33, text: 'brouillon' })
    expect(activeComments(r)).toHaveLength(2)
    // Rien ne change : même objet (pas de rendu inutile).
    expect(run([{ type: 'reanchor', path: 'a.ts', rows }], r)).toBe(r)
    // Autre fichier : ignoré.
    expect(run([{ type: 'reanchor', path: 'b.ts', rows: [] }], r)).toBe(r)
    // Ligne retrouvée plus tard : le commentaire redevient actif.
    const back = run(
      [{ type: 'reanchor', path: 'a.ts', rows: [...rows, { type: 'line', key: 'x', kind: 'add', oldNo: null, newNo: 21, text: 'gone()', anchor: { side: 'new', line: 21 } }] }],
      r,
    )
    expect(back.comments.find((c) => c.text === 'disparu')).toMatchObject({ line: 21, stale: false })
  })

  it('revue envoyée : fichiers du diff, lignes ancrées seulement ; seuls les envoyés sont retirés', () => {
    let d = emptyDraft
    const add = (path: string, side: 'new' | 'old', line: number, text: string) => {
      d = run([edit(path, side, line), ...say(text)], d)
    }
    add('b.ts', 'new', 20, 'b20')
    add('disparu.ts', 'new', 1, 'x')
    add('a.ts', 'new', 5, 'a5')
    add('b.ts', 'old', 20, 'b20 ancien')
    add('b.ts', 'new', 2, 'b2')
    d = { ...d, comments: d.comments.map((c) => (c.text === 'b2' ? { ...c, stale: true } : c)) }
    const files = sortFiles([f('b.ts'), f('a.ts')])
    const withGeneral = run([{ type: 'general', text: '  Bon travail  ' }], d)
    const r = buildReview(withGeneral, files)!
    expect(r.comments).toEqual([
      { path: 'a.ts', line: 5, side: 'new', text: 'a5' },
      { path: 'b.ts', line: 20, side: 'old', text: 'b20 ancien' },
      { path: 'b.ts', line: 20, side: 'new', text: 'b20' },
    ])
    expect(r.general).toBe('Bon travail')
    expect(r.dropped.map((c) => c.text).sort()).toEqual(['b2', 'x'])
    const after = run([{ type: 'sent', ids: r.ids, general: true }], withGeneral)
    expect(after.comments.map((c) => c.text).sort()).toEqual(['b2', 'x'])
    expect(after.general).toBe('')
    expect(buildReview(emptyDraft, files)).toBeNull()
    expect(buildReview(run([{ type: 'general', text: 'Global' }]), files)).toEqual({ comments: [], ids: [], general: 'Global', dropped: [] })
    let only = emptyDraft
    only = run([edit('z', 'new', 1), ...say('z')], only)
    expect(buildReview(only, files)).toBeNull()
  })
})

describe('compteurs absents et liste tronquée', () => {
  it('« ? » pour un fichier non compté', () => {
    expect(countLabel(null)).toBe('?')
    expect(countLabel(0)).toBe('0')
    expect(totals([f('a', 'M', { additions: 2, deletions: 1 }), f('b', '?', { additions: null, deletions: null })])).toEqual({
      additions: 2,
      deletions: 1,
      unknown: true,
    })
    expect(skippedCount(['a', 'b'])).toBe(2)
    expect(skippedCount(3)).toBe(3)
    expect(skippedCount(null)).toBe(0)
  })

  it('clés des lignes tirées des numéros, stables entre deux rechargements', () => {
    const one: FileDiff = {
      binary: false,
      too_large: false,
      hunks: [{ header: '@@', old_start: 5, old_lines: 1, new_start: 5, new_lines: 2, lines: [{ kind: '+', old_no: null, new_no: 6, text: 'x' }] }],
    }
    const two: FileDiff = {
      ...one,
      hunks: [
        { header: '@@', old_start: 1, old_lines: 1, new_start: 1, new_lines: 1, lines: [{ kind: '-', old_no: 1, new_no: null, text: 'y' }] },
        ...one.hunks,
      ],
    }
    const k1 = diffRows(one).find((r) => r.type === 'line')!.key
    const k2 = diffRows(two).filter((r) => r.type === 'line')[1]!.key
    expect(k1).toBe('add::6')
    expect(k2).toBe(k1)
  })
})

describe('validation des paramètres du diff', () => {
  it('diff, diffFile, sendReview', () => {
    expect(validateParams('sessions.diff', { id: ID, x: 1 })).toEqual({ id: ID })
    expect(validateParams('sessions.diffFile', { id: ID, path: 'src/a.ts' })).toEqual({ id: ID, path: 'src/a.ts' })
    expect(
      validateParams('sessions.sendReview', {
        id: ID,
        comments: [{ path: 'a.ts', line: 3, side: 'old', text: 'ok', extra: 1 }],
        general: 'g',
      }),
    ).toEqual({ id: ID, comments: [{ path: 'a.ts', line: 3, side: 'old', text: 'ok' }], general: 'g' })
    expect(validateParams('sessions.sendReview', { id: ID, comments: [], general: 'seul' })).toEqual({ id: ID, comments: [], general: 'seul' })
    // 4 000 caractères (points de code), pas unités UTF-16.
    expect(validateParams('sessions.sendReview', { id: ID, comments: [{ path: 'a', line: 1, side: 'new', text: '😀'.repeat(4000) }] }).comments).toHaveLength(1)
    const bad: [Parameters<typeof validateParams>[0], unknown][] = [
      ['sessions.diffFile', { id: ID, path: '' }],
      ['sessions.diffFile', { id: ID, path: 'a\0b' }],
      ['sessions.sendReview', { id: ID, comments: [] }],
      ['sessions.sendReview', { id: ID, comments: 'x' }],
      ['sessions.sendReview', { id: ID, comments: [{ path: 'a', line: 0, side: 'new', text: 'x' }] }],
      ['sessions.sendReview', { id: ID, comments: [{ path: 'a', line: 1, side: 'gauche', text: 'x' }] }],
      ['sessions.sendReview', { id: ID, comments: [{ path: 'a', line: 1, side: 'new', text: ' ' }] }],
      ['sessions.sendReview', { id: ID, comments: Array.from({ length: 201 }, () => ({ path: 'a', line: 1, side: 'new', text: 'x' })) }],
      ['sessions.sendReview', { id: ID, comments: [{ path: 'a', line: 1, side: 'new', text: 'x'.repeat(4001) }] }],
      ['sessions.sendReview', { id: ID, comments: [], general: 'x'.repeat(4001) }],
    ]
    for (const [m, p] of bad) expect(() => validateParams(m, p), JSON.stringify(p).slice(0, 80)).toThrow(ValidationError)
  })
})
