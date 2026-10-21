/**
 * Lot 15 bis : arborescence de la liste des fichiers du lecteur de diff
 * (construction, compactage, agrégats, ordre de parcours, mode retenu) et
 * compteurs du fichier ouvert.
 */
import { describe, expect, it } from 'vitest'

import type { DiffFile, FileDiff } from '../src/shared/protocol'
import { fileCounts } from '../src/renderer/src/state/diff'
import {
  LIST_MODE_KEY,
  ancestorKeys,
  buildDiffTree,
  dirComments,
  firstFile,
  flattenTree,
  loadListMode,
  saveListMode,
  stepVisibleFile,
  treeFileOrder,
  type DirNode,
} from '../src/renderer/src/state/diffTree'

const f = (path: string, additions: number | null = 1, deletions: number | null = 0, status: DiffFile['status'] = 'M'): DiffFile => ({
  path,
  status,
  additions,
  deletions,
  binary: false,
})

const FILES = [
  f('src/a/b/c.ts', 3, 1),
  f('src/a/b/d.ts', 2, 2),
  f('src/x.ts', 1, 0),
  f('README.md', 4, 0),
  f('docs/guide/intro.md', null, null),
  f('src/a/b/new.ts', 5, 0, '?'),
]

const labels = (rows: ReturnType<typeof flattenTree>) => rows.map((r) => `${'  '.repeat(r.depth)}${r.node.label}`)

describe('arbre des fichiers', () => {
  it('dossiers avant fichiers, ordre naturel, chaînes à un seul enfant compactées', () => {
    const rows = flattenTree(buildDiffTree(FILES), new Set())
    expect(labels(rows)).toEqual(['docs/guide', '  intro.md', 'src', '  a/b', '    c.ts', '    d.ts', '    new.ts', '  x.ts', 'README.md'])
    const ab = rows.find((r) => r.node.label === 'a/b')!
    // Clé de repli : le dossier le plus haut de la chaîne ; chemin complet pour l'infobulle.
    expect(ab.node.key).toBe('src/a')
    expect((ab.node as DirNode).path).toBe('src/a/b')
    expect(ab.parent).toBe('src')
    expect([ab.pos, ab.size]).toEqual([1, 2])
  })

  it('un dossier dont le seul enfant est un fichier n’est pas compacté ; la racine non plus', () => {
    const rows = flattenTree(buildDiffTree([f('lib/only.ts')]), new Set())
    expect(labels(rows)).toEqual(['lib', '  only.ts'])
    expect(labels(flattenTree(buildDiffTree([f('top.ts')]), new Set()))).toEqual(['top.ts'])
  })

  it('compteurs agrégés par dossier, « non compté » propagé, commentaires sommés', () => {
    const nodes = buildDiffTree(FILES)
    const src = nodes.find((n) => n.key === 'src') as DirNode
    expect([src.additions, src.deletions, src.unknown]).toEqual([11, 3, false])
    expect(src.paths).toHaveLength(4)
    const docs = nodes.find((n) => n.key === 'docs') as DirNode
    expect(docs.unknown).toBe(true)
    const comments: Record<string, number> = { 'src/x.ts': 2, 'src/a/b/c.ts': 1, 'README.md': 9 }
    expect(dirComments(src, (p) => comments[p] ?? 0)).toBe(3)
  })

  it('dossiers repliés : enfants cachés, ordre de parcours complet inchangé', () => {
    const nodes = buildDiffTree(FILES)
    const rows = flattenTree(nodes, new Set(['src/a']))
    expect(labels(rows.filter((r) => r.visible))).toEqual(['docs/guide', '  intro.md', 'src', '  a/b', '  x.ts', 'README.md'])
    expect(rows.find((r) => r.node.key === 'src/a')!.expanded).toBe(false)
    expect(treeFileOrder(nodes)).toEqual(['docs/guide/intro.md', 'src/a/b/c.ts', 'src/a/b/d.ts', 'src/a/b/new.ts', 'src/x.ts', 'README.md'])
  })

  it('j / k : ordre de l’arbre, fichiers des dossiers repliés sautés, bornés', () => {
    const nodes = buildDiffTree(FILES)
    const open = flattenTree(nodes, new Set())
    expect(stepVisibleFile(open, 'docs/guide/intro.md', 1)).toBe('src/a/b/c.ts')
    expect(stepVisibleFile(open, 'README.md', 1)).toBe('README.md')
    expect(stepVisibleFile(open, 'docs/guide/intro.md', -1)).toBe('docs/guide/intro.md')
    expect(stepVisibleFile(open, null, 1)).toBe('docs/guide/intro.md')
    const folded = flattenTree(nodes, new Set(['src/a']))
    expect(stepVisibleFile(folded, 'docs/guide/intro.md', 1)).toBe('src/x.ts')
    expect(stepVisibleFile(folded, 'src/x.ts', -1)).toBe('docs/guide/intro.md')
    // Fichier courant caché (dossier replié à l'instant) : on repart de sa place.
    expect(stepVisibleFile(folded, 'src/a/b/d.ts', 1)).toBe('src/x.ts')
    expect(stepVisibleFile(folded, 'src/a/b/d.ts', -1)).toBe('docs/guide/intro.md')
    // Tout replié à la racine : premier visible inexistant.
    expect(stepVisibleFile(flattenTree(buildDiffTree([f('a/b.ts')]), new Set(['a'])), null, 1)).toBeNull()
  })

  it('repli stable quand une chaîne compactée se scinde', () => {
    const collapsed = new Set(['src'])
    const before = flattenTree(buildDiffTree([f('src/a/b/c.ts')]), collapsed)
    expect(labels(before)).toEqual(['src/a/b', '  c.ts'])
    expect(before[0]!.expanded).toBe(false)
    // Un fichier apparaît dans « src » : « src » reste replié.
    const after = flattenTree(buildDiffTree([f('src/a/b/c.ts'), f('src/z.ts')]), collapsed)
    expect(labels(after.filter((r) => r.visible))).toEqual(['src'])
  })

  it('premier fichier : celui de la liste, ou le premier de l’arbre', () => {
    const sorted = [f('README.md'), f('src/x.ts')]
    expect(firstFile(sorted, 'list')).toBe('README.md')
    expect(firstFile(sorted, 'tree')).toBe('src/x.ts')
    expect(firstFile([], 'tree')).toBeNull()
  })

  it('ancêtres d’un fichier (pour le révéler)', () => {
    const rows = flattenTree(buildDiffTree(FILES), new Set(['src']))
    expect(ancestorKeys(rows, 'src/a/b/c.ts')).toEqual(['src/a', 'src'])
    expect(ancestorKeys(rows, 'README.md')).toEqual([])
  })
})

describe('mode Liste / Arborescence retenu', () => {
  const mem = () => {
    const m = new Map<string, string>()
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m }
  }
  it('liste par défaut, arborescence retenue, valeur illisible ignorée', () => {
    const s = mem()
    expect(loadListMode(s)).toBe('list')
    saveListMode(s, 'tree')
    expect(s.m.get(LIST_MODE_KEY)).toBe('tree')
    expect(loadListMode(s)).toBe('tree')
    s.m.set(LIST_MODE_KEY, 'n’importe quoi')
    expect(loadListMode(s)).toBe('list')
    expect(loadListMode(null)).toBe('list')
    const broken = {
      getItem: () => {
        throw new Error('refusé')
      },
      setItem: () => {
        throw new Error('refusé')
      },
    }
    expect(loadListMode(broken)).toBe('list')
    expect(() => saveListMode(broken, 'tree')).not.toThrow()
  })
})

describe('compteurs du fichier ouvert', () => {
  const fd: FileDiff = {
    binary: false,
    too_large: false,
    hunks: [
      {
        header: '@@',
        old_start: 1,
        old_lines: 3,
        new_start: 1,
        new_lines: 3,
        lines: [
          { kind: ' ', old_no: 1, new_no: 1, text: 'a' },
          { kind: '-', old_no: 2, new_no: null, text: 'b' },
          { kind: '+', old_no: null, new_no: 2, text: 'c' },
          { kind: '+', old_no: null, new_no: 3, text: 'd' },
        ],
      },
    ],
  }
  it('ceux de la liste s’ils sont connus, sinon comptés dans les hunks', () => {
    expect(fileCounts(f('a', 7, 3), fd)).toEqual({ additions: 7, deletions: 3 })
    expect(fileCounts(f('a', null, null), fd)).toEqual({ additions: 2, deletions: 1 })
    expect(fileCounts(f('a', null, null), null)).toBeNull()
    expect(fileCounts(f('a', null, null), { ...fd, too_large: true })).toBeNull()
  })
})
