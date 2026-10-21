/**
 * v0.3, lot 9 (historique des commits), côté front : validation des IPC,
 * libellés de l'onglet Commits, brouillon de revue mêlant commentaires de
 * diff, de fichier et de commit, désignation d'un commentaire de commit refusé.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { RendererErrorLog } from '../src/main/errorLog'
import { MAX_RENDERER_ERROR, ValidationError, validateParams, validateRendererError } from '../src/main/validate'
import { RENDERER_METHODS, type CommitInfo, type CommitsList, type DiffFile } from '../src/shared/protocol'
import {
  commitAriaLabel,
  commitsErrorText,
  countsLabel,
  emptyLabel,
  filesLabel,
  otherRange,
  pickCommit,
  rangeLabel,
  stepCommit,
  toggleRangeLabel,
  noStats,
  hasCounts,
  statsOf,
} from '../src/renderer/src/state/commits'
import {
  activeComments,
  buildReview,
  commitCommentLabel,
  commitComments,
  commitCommentsAt,
  commentsAt,
  editingAt,
  emptyDraft,
  isCommitComment,
  isDiffComment,
  parseRejection,
  rejectedId,
  reviewReducer,
  shortSha,
  type ReviewAction,
  type ReviewDraft,
} from '../src/renderer/src/state/review'

const ID = '0c69fdc4-b2c9-4511-97c8-bb78d2323d61'
const SHA1 = 'b7c8b2317a1d853986572cb527064543b83aeb6c'
const SHA2 = '8bb4aef28b022f06c1d15a3c7b2159af379434a8'
const SHA256 = 'a'.repeat(64)

describe('IPC des commits : validation stricte', () => {
  it('les trois méthodes sont permises à la page', () => {
    for (const m of ['sessions.commits', 'sessions.commitDiff', 'sessions.commitDiffFile'] as const) expect(RENDERER_METHODS).toContain(m)
  })

  it('sessions.commits : id, limit 1 à 500, range branch ou recent (absent ou null : automatique)', () => {
    expect(validateParams('sessions.commits', { id: ID, extra: 1 })).toEqual({ id: ID })
    expect(validateParams('sessions.commits', { id: ID, range: null })).toEqual({ id: ID })
    expect(validateParams('sessions.commits', { id: ID, limit: 500, range: 'recent' })).toEqual({ id: ID, limit: 500, range: 'recent' })
    for (const bad of [
      { id: 'x' },
      { id: ID, limit: 0 },
      { id: ID, limit: 501 },
      { id: ID, limit: 2.5 },
      { id: ID, range: 'all' },
      { id: ID, range: 'Branch' },
    ]) {
      expect(() => validateParams('sessions.commits', bad)).toThrow(ValidationError)
    }
  })

  it('sha : complet, 40 ou 64 caractères hexadécimaux en minuscules', () => {
    expect(validateParams('sessions.commitDiff', { id: ID, sha: SHA1 })).toEqual({ id: ID, sha: SHA1 })
    expect(validateParams('sessions.commitDiff', { id: ID, sha: SHA256 })).toEqual({ id: ID, sha: SHA256 })
    expect(validateParams('sessions.commitDiffFile', { id: ID, sha: SHA1, path: 'src/a.rs', x: 1 })).toEqual({ id: ID, sha: SHA1, path: 'src/a.rs' })
    for (const sha of [SHA1.slice(0, 7), SHA1.toUpperCase(), `${SHA1}0`, 'HEAD~1', 'g'.repeat(40), 'a'.repeat(50), 40, null]) {
      expect(() => validateParams('sessions.commitDiff', { id: ID, sha })).toThrow(/identifiant de commit complet/)
    }
    expect(() => validateParams('sessions.commitDiffFile', { id: ID, sha: SHA1, path: '' })).toThrow(ValidationError)
    expect(() => validateParams('sessions.commitDiffFile', { id: ID, sha: SHA1, path: 'a\0b' })).toThrow(ValidationError)
  })

  it('sendReview : commentaire de commit validé, mêlé aux autres sortes', () => {
    const r = validateParams('sessions.sendReview', {
      id: ID,
      comments: [
        { path: 'a.rs', line: 3, side: 'new', text: 'diff' },
        { kind: 'commit', sha: SHA1, path: 'b.rs', line: 4, side: 'old', text: 'commit', lineText: 'ignoré' },
        { kind: 'file', path: 'c.md', line: 1, line_end: 2 },
      ],
    })
    expect(r.comments).toEqual([
      { path: 'a.rs', line: 3, side: 'new', text: 'diff' },
      { kind: 'commit', sha: SHA1, path: 'b.rs', line: 4, side: 'old', text: 'commit' },
      { kind: 'file', path: 'c.md', line: 1, line_end: 2, text: '' },
    ])
  })

  it.each([
    [{ kind: 'commit', sha: SHA1.slice(0, 12), path: 'a', line: 1, side: 'new', text: 'x' }, /commentaire 1 : « sha »/],
    [{ kind: 'commit', path: 'a', line: 1, side: 'new', text: 'x' }, /commentaire 1 : « sha »/],
    [{ kind: 'commit', sha: SHA1, path: 'a', line: 0, side: 'new', text: 'x' }, /commentaire 1 : « line »/],
    [{ kind: 'commit', sha: SHA1, path: 'a', line: 1, side: 'gauche', text: 'x' }, /commentaire 1 : « side »/],
    [{ kind: 'commit', sha: SHA1, path: 'a', line: 1, side: 'new', text: '  ' }, /commentaire 1 : « text » est vide/],
    [{ kind: 'commit', sha: SHA1, path: 'a', line: 1, side: 'new', text: 'x'.repeat(4001) }, /trop long/],
    [{ kind: 'tag', path: 'a', line: 1, side: 'new', text: 'x' }, /diff, file ou commit/],
  ])('sendReview refuse %o', (c, message) => {
    expect(() => validateParams('sessions.sendReview', { id: ID, comments: [c] })).toThrow(message)
  })
})

function commit(over: Partial<CommitInfo> = {}): CommitInfo {
  return {
    sha: SHA1,
    parents: [SHA2],
    author: 'Élodie',
    date: '2026-10-20T15:15:38+02:00',
    subject: 'Corrige l’export',
    body: '',
    files: 2,
    additions: 12,
    deletions: 3,
    ...over,
  }
}

describe('onglet Commits : libellés', () => {
  const branch: CommitsList = { range: 'branch', base: { ref: 'main', sha: SHA2, kind: 'merge_base' }, head: SHA1, commits: [commit()], truncated: false }
  const recent: CommitsList = { ...branch, range: 'recent', base: { ref: 'HEAD', sha: SHA1, kind: 'head' } }

  it('mode de la liste et bascule vers l’autre', () => {
    expect(rangeLabel(branch, 'romain/export')).toBe('Commits de la branche depuis main')
    expect(toggleRangeLabel(branch, 'romain/export')).toBe('Voir les derniers commits de romain/export')
    expect(rangeLabel(recent, 'main')).toBe('Derniers commits de main')
    expect(rangeLabel(recent, null)).toBe('Derniers commits de HEAD')
    expect(toggleRangeLabel(recent, 'main')).toBe('Voir les commits de la branche depuis HEAD')
    expect(otherRange('branch')).toBe('recent')
    expect(otherRange('recent')).toBe('branch')
  })

  it('liste vide : avant le premier commit, ou branche sans commit propre', () => {
    expect(emptyLabel({ range: 'recent', head: null })).toBe('Aucun commit pour l’instant.')
    expect(emptyLabel({ range: 'branch', head: SHA1 })).toBe('Aucun commit sur la branche depuis la base.')
  })

  it('compteurs, fichiers, sha court', () => {
    expect(countsLabel(commit())).toBe('+12 −3')
    expect(filesLabel(0)).toBe('aucun fichier')
    expect(filesLabel(1)).toBe('1 fichier')
    expect(filesLabel(5)).toBe('5 fichiers')
    expect(shortSha(SHA1)).toBe('b7c8b23')
  })

  it('libellé accessible avec date relative', () => {
    const now = Date.parse('2026-10-20T16:15:38+02:00')
    expect(commitAriaLabel(commit(), now)).toBe('Corrige l’export, par Élodie, il y a 1 h, 2 fichiers, 12 ajouts, 3 suppressions')
    expect(commitAriaLabel(commit({ subject: '', additions: 1, deletions: 0, files: 1, date: '2026-10-19T10:00:00Z' }), now)).toBe(
      '(sans message), par Élodie, hier, 1 fichier, 1 ajout, 0 suppression',
    )
  })

  it('commit gardé après relecture s’il y est encore, sinon le premier ; pas bornés', () => {
    const list = [commit(), commit({ sha: SHA2 })]
    expect(pickCommit(list, SHA2)).toBe(SHA2)
    expect(pickCommit(list, 'c'.repeat(40))).toBe(SHA1)
    expect(pickCommit([], SHA1)).toBeNull()
    expect(stepCommit(list, SHA1, 1)).toBe(SHA2)
    expect(stepCommit(list, SHA2, 1)).toBe(SHA2)
    expect(stepCommit(list, SHA1, -1)).toBe(SHA1)
  })

  it('compteurs non calculés (stats: false, dépôt volumineux) : jamais affichés à 0 ; champ absent = calculés', () => {
    const none = commit({ files: null, additions: null, deletions: null })
    expect(hasCounts(none)).toBe(false)
    expect(hasCounts(commit())).toBe(true)
    expect(countsLabel(none)).toBe(noStats())
    expect(noStats()).toBe('compteurs indisponibles (dépôt volumineux)')
    expect(commitAriaLabel(none, Date.parse('2026-10-20T16:15:38+02:00'))).toBe(
      'Corrige l’export, par Élodie, il y a 1 h, compteurs indisponibles (dépôt volumineux)',
    )
    expect(statsOf({ stats: false })).toBe(false)
    expect(statsOf({ stats: true })).toBe(true)
    expect(statsOf({})).toBe(true)
  })

  it('démon trop ancien : « mets orchd à jour »', () => {
    expect(commitsErrorText(-32601, 'x', 'Historique indisponible')).toBe('Le démon ne sait pas encore lire l’historique des commits : mets orchd à jour.')
    expect(commitsErrorText(-32017, 'la session n’est pas dans un dépôt git', 'Historique indisponible')).toBe(
      'Historique indisponible : la session n’est pas dans un dépôt git',
    )
  })
})

describe('brouillon mixte : diff, fichier et commit', () => {
  const run = (d: ReviewDraft, ...actions: ReviewAction[]) => actions.reduce(reviewReducer, d)
  const files: DiffFile[] = [{ path: 'a.rs', status: 'M', additions: 1, deletions: 0, binary: false }]

  function mixed(): ReviewDraft {
    return run(
      emptyDraft,
      { type: 'edit', sha: SHA2, path: 'z.rs', anchor: { side: 'new', line: 9 }, lineText: 'z' },
      { type: 'editText', text: 'sur le commit 2' },
      { type: 'save' },
      { type: 'edit', path: 'a.rs', anchor: { side: 'new', line: 3 }, lineText: 'a' },
      { type: 'editText', text: 'sur le diff' },
      { type: 'save' },
      { type: 'addFile', path: 'n.md', line: 1, lineEnd: 2, text: '' },
      { type: 'edit', sha: SHA1, path: 'b.rs', anchor: { side: 'old', line: 4 }, lineText: 'b' },
      { type: 'editText', text: 'sur le commit 1' },
      { type: 'save' },
      { type: 'edit', sha: SHA2, path: 'a.rs', anchor: { side: 'new', line: 1 }, lineText: 'a1' },
      { type: 'editText', text: 'encore le commit 2' },
      { type: 'save' },
    )
  }

  it('la boîte d’un commit ne s’ouvre pas sur la même ligne du worktree', () => {
    const d = run(emptyDraft, { type: 'edit', sha: SHA1, path: 'a.rs', anchor: { side: 'new', line: 3 }, lineText: 'a' })
    expect(editingAt(d, 'a.rs', { side: 'new', line: 3 }, SHA1)).toBe(true)
    expect(editingAt(d, 'a.rs', { side: 'new', line: 3 })).toBe(false)
    expect(editingAt(d, 'a.rs', { side: 'new', line: 3 }, SHA2)).toBe(false)
  })

  it('chaque sorte reste à sa place (comptes, lignes, réancrage)', () => {
    const d = mixed()
    expect(activeComments(d)).toHaveLength(5)
    expect(d.comments.filter(isCommitComment)).toHaveLength(3)
    expect(d.comments.filter(isDiffComment)).toHaveLength(1)
    expect(commitComments(d, SHA2).map((c) => c.text)).toEqual(['sur le commit 2', 'encore le commit 2'])
    expect(commitCommentsAt(d, SHA2, 'a.rs', { side: 'new', line: 1 })).toHaveLength(1)
    // Une ligne du worktree n'affiche pas les commentaires d'un commit, et inversement.
    expect(commentsAt(d, 'a.rs', { side: 'new', line: 1 })).toHaveLength(0)
    expect(commitCommentsAt(d, SHA1, 'a.rs', { side: 'new', line: 3 })).toHaveLength(0)
    // Le diff du worktree rechargé ne touche pas aux commentaires de commit.
    const after = reviewReducer(d, { type: 'reanchor', path: 'a.rs', rows: [] })
    expect(after.comments.filter(isCommitComment)).toEqual(d.comments.filter(isCommitComment))
    expect(after.comments.filter(isDiffComment)[0]!.stale).toBe(true)
  })

  it('revue envoyée : diff, puis commits (ordre où ils ont été commentés), puis fichiers', () => {
    const built = buildReview(mixed(), files)!
    expect(built.comments).toEqual([
      { path: 'a.rs', line: 3, side: 'new', text: 'sur le diff' },
      { kind: 'commit', sha: SHA2, path: 'a.rs', line: 1, side: 'new', text: 'encore le commit 2' },
      { kind: 'commit', sha: SHA2, path: 'z.rs', line: 9, side: 'new', text: 'sur le commit 2' },
      { kind: 'commit', sha: SHA1, path: 'b.rs', line: 4, side: 'old', text: 'sur le commit 1' },
      { kind: 'file', path: 'n.md', line: 1, line_end: 2, text: '' },
    ])
    expect(built.dropped).toEqual([])
    // Le diff du worktree n'a plus le fichier : son commentaire ne part pas, ceux des commits si.
    const noDiff = buildReview(mixed(), [])!
    expect(noDiff.comments.filter((c) => 'kind' in c && c.kind === 'commit')).toHaveLength(3)
    expect(noDiff.dropped).toHaveLength(1)
  })

  it('commentaire de commit refusé par le démon : désigné par son rang, retiré seul', () => {
    const d = mixed()
    const built = buildReview(d, files)!
    const r = parseRejection('commentaire 4 : le commit « b7c8b23 » ne fait pas partie de l’historique de la session', undefined)!
    const id = rejectedId(built, r)
    const c = d.comments.find((x) => x.id === id)!
    expect(isCommitComment(c) && c.sha).toBe(SHA1)
    expect(commitCommentLabel(c as Parameters<typeof commitCommentLabel>[0])).toBe('b7c8b23 b.rs:4 (ancienne version)')
    const left = reviewReducer(d, { type: 'delete', id: id! })
    expect(left.comments).toHaveLength(4)
    expect(commitComments(left, SHA1)).toHaveLength(0)
  })

  it('envoyés : retirés, les autres gardés', () => {
    const d = mixed()
    const built = buildReview(d, [])!
    const after = reviewReducer(d, { type: 'sent', ids: built.ids, general: false })
    expect(after.comments.map((c) => c.text)).toEqual(['sur le diff'])
  })
})

describe('styles : pas de collision de classes', () => {
  /**
   * Classes définies seules (`.x { … }`) à plus d'un endroit du premier niveau
   * de styles.css. Deux fonctions qui prennent le même nom se cassent
   * mutuellement (lignes de couleurs des Réglages et liste des commits, lot 9).
   * Seules les extensions volontaires d'un même composant sont admises.
   */
  const ALLOWED = new Set(['.fview', '.fbody', '.kcard', '.hljs-section'])
  it('chaque classe n’a qu’une définition de premier niveau (hors extensions connues)', () => {
    const css = readFileSync(resolve(__dirname, '../src/renderer/src/styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const counts = new Map<string, number>()
    const stack: string[] = []
    let buf = ''
    for (const m of css.matchAll(/[{}]|[^{}]+/g)) {
      const x = m[0]
      if (x === '{') {
        stack.push(buf.trim())
        buf = ''
      } else if (x === '}') {
        const head = stack.pop()!
        if (!head.startsWith('@') && !stack.some((h) => h.startsWith('@'))) {
          for (const sel of head.split(',').map((t) => t.trim())) {
            if (/^\.[\w-]+$/.test(sel)) counts.set(sel, (counts.get(sel) ?? 0) + 1)
          }
        }
        buf = ''
      } else buf = x
    }
    const dup = [...counts].filter(([k, n]) => n > 1 && !ALLOWED.has(k)).map(([k]) => k)
    expect(dup).toEqual([])
    expect(counts.get('.crow')).toBe(1)
    expect(counts.get('.cmt-row')).toBe(1)
  })
})

describe('journal des erreurs de la page (IPC)', () => {
  it('texte seulement, caractères de contrôle neutralisés (sauf saut de ligne), borné', () => {
    expect(validateRendererError('a\nb\u001b[31mc\u2028d')).toBe('a\nb [31mc d')
    expect(validateRendererError('x'.repeat(20_000))).toHaveLength(MAX_RENDERER_ERROR)
    for (const bad of [42, null, '', '   ', { message: 'x' }]) expect(() => validateRendererError(bad)).toThrow(ValidationError)
  })
})

describe('journal des erreurs de la page : dédoublonnage et limite', () => {
  it('un même message une fois par minute, 20 messages distincts au plus, puis « n supprimées »', () => {
    const log = new RendererErrorLog(3, 60_000)
    expect(log.accept('a', 0)).toEqual(['erreur de la page : a'])
    expect(log.accept('a', 10)).toEqual([])
    expect(log.accept('b', 20)).toEqual(['erreur de la page : b'])
    expect(log.accept('c', 30)).toEqual(['erreur de la page : c'])
    expect(log.accept('d', 40)).toEqual([])
    expect(log.accept('a', 60_000)).toEqual([
      '2 erreurs de la page supprimées (doublons ou limite de 3 par minute)',
      'erreur de la page : a',
    ])
    expect(log.accept('e', 60_001)).toEqual(['erreur de la page : e'])
  })

  it('une seule suppression : au singulier', () => {
    const log = new RendererErrorLog(20, 1000)
    log.accept('a', 0)
    log.accept('a', 1)
    expect(log.accept('b', 1000)[0]).toBe('1 erreur de la page supprimée (doublons ou limite de 20 par minute)')
  })
})
