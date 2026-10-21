/**
 * Forge, demandes de fusion (v0.3, lot 13b) : validation IPC des nouvelles
 * méthodes, brouillon de revue de la forge séparé de celui pour Claude,
 * aperçu = ce qui est publié, aucun envoi hors de l'étape de confirmation,
 * conflit de tête (brouillon gardé, lignes disparues signalées), libellés de
 * CI et de revue, démon ancien.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { FORGE_TIMEOUT_MS, ValidationError, requestTimeoutMs, validateParams } from '../src/main/validate'
import { ErrorCode, FORGE_METHODS, RENDERER_METHODS, type FileDiff, type ForgeReviewPayload, type MethodName, type Pull, type PullDetail } from '../src/shared/protocol'
import { diffRows } from '../src/renderer/src/state/diff'
import {
  branchPullOf,
  forgeDestination,
  buildForgeReview,
  checkDuration,
  checkRunLabel,
  checksLabel,
  confirmStep,
  createForgeDraftStore,
  emptyForgeDraft,
  forgeDraftKey,
  forgeDraftReducer,
  findForgeAnchor,
  isBanalLine,
  movedLabel,
  publishedText,
  pullFileErrorText,
  reloadForReview,
  onlyRepoPulls,
  publishForgeReview,
  pullDiffFiles,
  pullStateLabel,
  pullsErrorKind,
  pullsParams,
  reviewDecisionLabel,
  supportsForgeReview,
  validHeadSha,
  type ForgeDraft,
  type ForgeDraftAction,
  type PublishState,
} from '../src/renderer/src/state/forgePulls'
import { buildReview, emptyDraft, reviewReducer } from '../src/renderer/src/state/review'

const ROOT = '/w/projet'
const SHA = 'a'.repeat(40)
const SHA2 = 'b'.repeat(40)

function pullDetail(sha: string): PullDetail {
  return {
    number: 12,
    title: 't',
    state: 'open',
    draft: false,
    url: 'https://github.com/o/r/pull/12',
    author: null,
    head: { branch: 'b', sha },
    base: { branch: 'main' },
    updated_at: null,
    additions: 1,
    deletions: 1,
    changed_files: 2,
    review_decision: null,
    checks: null,
    labels: [],
    files: [
      { path: 'src/a.ts', status: 'M', additions: 1, deletions: 1 },
      { path: 'src/b.ts', status: 'M', additions: 1, deletions: 0 },
    ],
    check_runs: [],
    review_threads: [],
  }
}

const NEW_METHODS: MethodName[] = ['forge.pulls', 'forge.pull', 'forge.pullFile', 'forge.pullForBranch', 'forge.submitReview']

function review(extra: Record<string, unknown> = {}) {
  return {
    root: ROOT,
    number: 12,
    expected_head_sha: SHA,
    event: 'comment',
    body: 'Merci',
    comments: [{ path: 'src/a.ts', line: 3, side: 'new', body: 'Ici ?' }],
    ...extra,
  }
}

describe('validation IPC : demandes de fusion', () => {
  it('méthodes autorisées à la page, `enabled` ajouté par le processus principal, délai de 90 s', () => {
    for (const m of NEW_METHODS) {
      expect(RENDERER_METHODS).toContain(m)
      expect(FORGE_METHODS).toContain(m)
      expect(requestTimeoutMs(m, {})).toBe(FORGE_TIMEOUT_MS)
    }
    expect(FORGE_TIMEOUT_MS).toBe(90_000)
  })

  it('forge.pulls : état énuméré (fusionnées comprises), auteur @me ou null, recherche bornée, limite 1..200', () => {
    expect(validateParams('forge.pulls', { root: ROOT, state: 'merged', author: '@me', search: 'export', limit: 50, enabled: true, x: 1 })).toEqual({
      root: ROOT,
      state: 'merged',
      author: '@me',
      search: 'export',
      limit: 50,
    })
    expect(validateParams('forge.pulls', { root: ROOT, author: null })).toEqual({ root: ROOT, author: null })
    const bad = [
      { root: 'relatif' },
      { root: ROOT, state: 'draft' },
      { root: ROOT, author: 'octocat' },
      { root: ROOT, search: 'a'.repeat(257) },
      { root: ROOT, search: 'a\u0007b' },
      { root: ROOT, limit: 0 },
      { root: ROOT, limit: 201 },
      { root: ROOT, refresh: 'oui' },
    ]
    for (const p of bad) expect(() => validateParams('forge.pulls', p), JSON.stringify(p)).toThrow(ValidationError)
  })

  it('forge.pull, forge.pullFile : numéro positif, chemin relatif sans « .. »', () => {
    expect(validateParams('forge.pull', { root: ROOT, number: 3, refresh: true })).toEqual({ root: ROOT, number: 3, refresh: true })
    expect(validateParams('forge.pullFile', { root: ROOT, number: 3, path: 'src/a.ts' })).toEqual({ root: ROOT, number: 3, path: 'src/a.ts' })
    for (const number of [0, -1, 1.5, '3']) expect(() => validateParams('forge.pull', { root: ROOT, number })).toThrow(ValidationError)
    for (const path of ['/etc/passwd', '../a', 'a/../b', 'a//b', './a', '', 'a\0b']) {
      expect(() => validateParams('forge.pullFile', { root: ROOT, number: 3, path }), path).toThrow(ValidationError)
    }
  })

  it('forge.pullForBranch : nom de branche valide', () => {
    expect(validateParams('forge.pullForBranch', { root: ROOT, branch: 'romain/42-export' })).toEqual({ root: ROOT, branch: 'romain/42-export' })
    for (const branch of ['', '-x', 'a..b', 'a b', 'a:b', 7]) {
      expect(() => validateParams('forge.pullForBranch', { root: ROOT, branch }), String(branch)).toThrow(ValidationError)
    }
  })

  it('forge.submitReview : champs connus seulement, sha 40/64 hexadécimal, événement énuméré', () => {
    expect(validateParams('forge.submitReview', { ...review(), enabled: true, url: 'https://evil', comments: [{ path: 'src/a.ts', line: 3, side: 'new', body: 'Ici ?', x: 1 }] })).toEqual(
      review(),
    )
    expect(validateParams('forge.submitReview', review({ expected_head_sha: 'c'.repeat(64) })).expected_head_sha).toBe('c'.repeat(64))
    for (const expected_head_sha of ['A'.repeat(40), 'a'.repeat(39), 'a'.repeat(41), 'g'.repeat(40), undefined]) {
      expect(() => validateParams('forge.submitReview', review({ expected_head_sha })), String(expected_head_sha)).toThrow(ValidationError)
    }
    for (const event of ['merge', 'APPROVE', '', undefined]) {
      expect(() => validateParams('forge.submitReview', review({ event })), String(event)).toThrow(ValidationError)
    }
  })

  it('forge.submitReview : corps ≤ 65 536 caractères, ≤ 100 commentaires, chemins relatifs, commentaire non vide', () => {
    expect(validateParams('forge.submitReview', review({ body: 'é'.repeat(65_536) })).body).toHaveLength(65_536)
    expect(() => validateParams('forge.submitReview', review({ body: 'é'.repeat(65_537) }))).toThrow(ValidationError)
    const c = { path: 'src/a.ts', line: 1, side: 'new', body: 'x' }
    expect(validateParams('forge.submitReview', review({ comments: Array(100).fill(c) })).comments).toHaveLength(100)
    expect(() => validateParams('forge.submitReview', review({ comments: Array(101).fill(c) }))).toThrow(ValidationError)
    const bad = [
      { ...c, path: '/etc/passwd' },
      { ...c, path: '../x' },
      { ...c, line: 0 },
      { ...c, side: 'both' },
      { ...c, body: '   ' },
      { ...c, body: 'x'.repeat(65_537) },
    ]
    for (const b of bad) expect(() => validateParams('forge.submitReview', review({ comments: [b] })), JSON.stringify(b).slice(0, 80)).toThrow(/commentaire 1/)
  })

  it('forge.submitReview : commentaire général obligatoire pour commenter / demander des modifications, facultatif pour approuver', () => {
    for (const event of ['comment', 'request_changes']) {
      expect(() => validateParams('forge.submitReview', review({ event, body: '  ', comments: [] }))).toThrow(/commentaire général obligatoire/)
      // Même avec des commentaires de ligne : GitHub exige le corps.
      expect(() => validateParams('forge.submitReview', review({ event, body: '' }))).toThrow(/commentaire général obligatoire/)
    }
    expect(validateParams('forge.submitReview', review({ event: 'approve', body: '', comments: [] }))).toEqual(review({ event: 'approve', body: '', comments: [] }))
    expect(validateParams('forge.submitReview', { ...review({ event: 'approve' }), body: undefined, comments: undefined })).toEqual(
      review({ event: 'approve', body: '', comments: [] }),
    )
  })
})

/* ---------- Brouillon ---------- */

const FILE: FileDiff = {
  binary: false,
  too_large: false,
  hunks: [
    {
      header: '@@ -1,3 +1,4 @@',
      old_start: 1,
      old_lines: 3,
      new_start: 1,
      new_lines: 4,
      lines: [
        { kind: ' ', old_no: 1, new_no: 1, text: 'un' },
        { kind: '-', old_no: 2, new_no: null, text: 'deux' },
        { kind: '+', old_no: null, new_no: 2, text: 'DEUX' },
        { kind: '+', old_no: null, new_no: 3, text: 'trois' },
        { kind: ' ', old_no: 3, new_no: 4, text: 'quatre' },
      ],
    },
  ],
}
const FILES = [{ path: 'src/a.ts' }, { path: 'src/b.ts' }]

function apply(d: ForgeDraft, ...actions: ForgeDraftAction[]): ForgeDraft {
  return actions.reduce(forgeDraftReducer, d)
}

function comment(d: ForgeDraft, path: string, side: 'new' | 'old', line: number, lineText: string, text: string): ForgeDraft {
  return apply(d, { type: 'edit', path, anchor: { side, line }, lineText }, { type: 'editText', text }, { type: 'save' })
}

describe('brouillon de revue de la forge', () => {
  it('séparé du brouillon pour Claude : autre type, autre magasin, rien ne passe de l’un à l’autre', () => {
    const store = createForgeDraftStore()
    const k = forgeDraftKey(ROOT, 12)
    store.dispatch(k, { type: 'head', sha: SHA })
    store.dispatch(k, { type: 'edit', path: 'src/a.ts', anchor: { side: 'new', line: 2 }, lineText: 'DEUX' })
    store.dispatch(k, { type: 'editText', text: 'Pourquoi en capitales ?' })
    store.dispatch(k, { type: 'save' })
    // Le brouillon pour Claude (par session, réducteur de `review.ts`) n'en sait rien.
    const claude = reviewReducer(emptyDraft, { type: 'general', text: 'Pour Claude' })
    expect(buildReview(claude, [{ path: 'src/a.ts', status: 'M', additions: 1, deletions: 1, binary: false }])).toEqual({
      comments: [],
      ids: [],
      general: 'Pour Claude',
      dropped: [],
    })
    expect(emptyDraft.comments).toEqual([])
    const forge = store.get(k)
    expect(forge.comments).toEqual([{ id: 1, path: 'src/a.ts', side: 'new', line: 2, text: 'Pourquoi en capitales ?', lineText: 'DEUX' }])
    expect(buildForgeReview(forge, 12, FILES).payload.body).toBe('')
    // Un brouillon par demande (et par projet).
    expect(store.get(forgeDraftKey(ROOT, 13))).toBe(emptyForgeDraft)
    expect(store.get(forgeDraftKey('/w/autre', 12))).toBe(emptyForgeDraft)
  })

  it('100 commentaires au plus ; texte vide = boîte fermée sans commentaire', () => {
    let d = apply(emptyForgeDraft, { type: 'head', sha: SHA })
    for (let i = 1; i <= 101; i++) d = comment(d, 'src/a.ts', 'new', i, `l${i}`, `c${i}`)
    expect(d.comments).toHaveLength(100)
    expect(comment(emptyForgeDraft, 'src/a.ts', 'new', 1, 'un', '   ').comments).toEqual([])
  })

  it('tête : adoptée sans commentaire de ligne, gardée sinon (sauf « Recharger »)', () => {
    let d = apply(emptyForgeDraft, { type: 'head', sha: SHA })
    expect(apply(d, { type: 'head', sha: SHA2 }).headSha).toBe(SHA2)
    d = comment(d, 'src/a.ts', 'new', 2, 'DEUX', 'x')
    expect(apply(d, { type: 'head', sha: SHA2 }).headSha).toBe(SHA)
    expect(apply(d, { type: 'head', sha: SHA2, force: true }).headSha).toBe(SHA2)
    expect(validHeadSha('ABCDEF'.repeat(6) + 'abcd')).toBe('abcdef'.repeat(6) + 'abcd')
    expect(validHeadSha('xyz')).toBeNull()
  })
})

describe('publication : aperçu = ce qui est envoyé, rien sans confirmation', () => {
  function draft(): ForgeDraft {
    let d = apply(emptyForgeDraft, { type: 'head', sha: SHA }, { type: 'event', event: 'request_changes' })
    d = comment(d, 'src/b.ts', 'new', 4, 'quatre', '\n  Et ici 👨\u200d💻 ?\n\n')
    d = comment(d, 'src/a.ts', 'old', 2, 'deux', 'Ligne supprimée : pourquoi ?')
    return apply(d, { type: 'general', text: '\r\n\n  Quelques remarques.\u202e\u0007\n  - point\n\n' })
  }

  it('revue construite : ordre des fichiers puis des lignes, textes nettoyés comme le fera le démon', () => {
    const b = buildForgeReview(draft(), 12, FILES)
    expect(b.problem).toBeNull()
    expect(b.payload).toEqual({
      number: 12,
      expected_head_sha: SHA,
      event: 'request_changes',
      // Indentation de la première ligne gardée, contrôles et bidi retirés, ZWJ gardé.
      body: '  Quelques remarques.\n  - point',
      comments: [
        { path: 'src/a.ts', line: 2, side: 'old', body: 'Ligne supprimée : pourquoi ?' },
        { path: 'src/b.ts', line: 4, side: 'new', body: '  Et ici 👨\u200d💻 ?' },
      ],
    })
    expect(b.ids).toEqual([2, 1])
  })

  it('« Publier » envoie exactement l’aperçu figé, une fois ; le brouillon modifié ensuite ne change pas l’envoi', async () => {
    const d = draft()
    const preview = confirmStep(buildForgeReview(d, 12, FILES))!
    expect(preview.phase).toBe('confirm')
    // Modification du brouillon après l'aperçu : l'aperçu affiché, et donc l'envoi, ne bougent pas.
    apply(d, { type: 'general', text: 'autre chose' })
    const shown = structuredClone((preview as Extract<PublishState, { phase: 'confirm' }>).payload)
    const send = vi.fn(async () => ({ url: 'https://github.com/o/r/pull/12#pullrequestreview-1' }))
    const states: PublishState[] = []
    const out = await publishForgeReview(preview, ROOT, { send, toError: () => ({ code: null, message: '' }), describe: (e) => e.message, onState: (s) => states.push(s) })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({ root: ROOT, ...shown })
    expect(states.map((s) => s.phase)).toEqual(['publishing', 'done'])
    expect(out).toEqual({ phase: 'done', url: 'https://github.com/o/r/pull/12#pullrequestreview-1' })
  })

  it('hors de l’étape de confirmation, rien n’est envoyé', async () => {
    const send = vi.fn(async () => ({ url: null }))
    const payload: ForgeReviewPayload = buildForgeReview(draft(), 12, FILES).payload
    const others: PublishState[] = [
      { phase: 'compose' },
      { phase: 'publishing', payload, ids: [] },
      { phase: 'done', url: null },
      { phase: 'conflict', headSha: SHA2 },
      { phase: 'rejected', message: 'x', commentId: null },
      { phase: 'error', message: 'x', uncertain: true },
    ]
    for (const s of others) {
      expect(await publishForgeReview(s, ROOT, { send, toError: () => ({ code: null, message: '' }), describe: () => '', onState: () => undefined })).toBe(s)
    }
    expect(send).not.toHaveBeenCalled()
  })

  it('pas d’aperçu sans tête connue, ni sans commentaire général pour commenter / demander des modifications ; approuver sans texte est permis', () => {
    expect(confirmStep(buildForgeReview(emptyForgeDraft, 12, FILES))).toBeNull()
    const head = apply(emptyForgeDraft, { type: 'head', sha: SHA })
    expect(buildForgeReview(head, 12, FILES).problem).toMatch(/commentaire général obligatoire/)
    // Des commentaires de ligne ne suffisent pas (GitHub exige le corps).
    expect(buildForgeReview(comment(head, 'src/a.ts', 'new', 2, 'DEUX', 'x'), 12, FILES).problem).toMatch(/commentaire général obligatoire/)
    expect(buildForgeReview(apply(head, { type: 'event', event: 'request_changes' }, { type: 'general', text: '\n\u202e\n' }), 12, FILES).problem).toMatch(
      /commentaire général obligatoire/,
    )
    const ok = confirmStep(buildForgeReview(apply(head, { type: 'event', event: 'approve' }), 12, FILES))
    expect(ok).toMatchObject({ phase: 'confirm', payload: { event: 'approve', body: '', comments: [] } })
  })

  it('refus du démon : commentaire désigné ; délai dépassé : résultat incertain', async () => {
    const preview = confirmStep(buildForgeReview(draft(), 12, FILES))!
    const run = (err: { code: number; message: string; data?: unknown }) =>
      publishForgeReview(preview, ROOT, {
        send: async () => {
          throw err
        },
        toError: (e) => e as { code: number; message: string },
        describe: (e) => e.message,
        onState: () => undefined,
      })
    expect(await run({ code: ErrorCode.InvalidParams, message: 'commentaire 2 : ligne absente du diff' })).toEqual({
      phase: 'rejected',
      message: 'commentaire 2 : ligne absente du diff',
      commentId: 1,
    })
    expect(await run({ code: ErrorCode.Timeout, message: 'délai' })).toEqual({ phase: 'error', message: 'délai', uncertain: true })
    expect(await run({ code: ErrorCode.Internal, message: 'gh : 502' })).toEqual({ phase: 'error', message: 'gh : 502', uncertain: false })
  })
})

describe('conflit de tête : brouillon gardé, lignes disparues signalées', () => {
  it('-32023 → conflit avec la nouvelle tête ; le brouillon ne bouge pas', async () => {
    const store = createForgeDraftStore()
    const k = forgeDraftKey(ROOT, 12)
    store.dispatch(k, { type: 'head', sha: SHA })
    for (const a of [
      { type: 'edit', path: 'src/a.ts', anchor: { side: 'new', line: 3 }, lineText: 'trois' },
      { type: 'editText', text: 'À revoir' },
      { type: 'save' },
      { type: 'general', text: 'Remarques' },
    ] as ForgeDraftAction[])
      store.dispatch(k, a)
    const before = store.get(k)
    const preview = confirmStep(buildForgeReview(before, 12, FILES))!
    const out = await publishForgeReview(preview, ROOT, {
      send: async () => {
        throw { code: ErrorCode.PullChanged, message: 'la demande de fusion a changé depuis son ouverture', data: { head_sha: SHA2 } }
      },
      toError: (e) => e as { code: number; message: string; data: unknown },
      describe: (e) => e.message,
      onState: () => undefined,
    })
    expect(out).toEqual({ phase: 'conflict', headSha: SHA2 })
    expect(store.get(k)).toBe(before)
  })

  /** Nouvelle tête : une ligne ajoutée au début, « DEUX » réécrite, « } » déplacée. */
  const MOVED: FileDiff = {
    ...FILE,
    hunks: [
      {
        ...FILE.hunks[0]!,
        lines: [
          { kind: '+', old_no: null, new_no: 1, text: 'zéro' },
          { kind: ' ', old_no: 1, new_no: 2, text: 'un' },
          { kind: '+', old_no: null, new_no: 3, text: 'Deux' },
          { kind: '+', old_no: null, new_no: 4, text: 'trois' },
          { kind: '+', old_no: null, new_no: 6, text: '}' },
        ],
      },
    ],
  }

  function conflicted(): ForgeDraft {
    let d = apply(emptyForgeDraft, { type: 'head', sha: SHA }, { type: 'general', text: 'g' })
    d = comment(d, 'src/a.ts', 'new', 3, 'trois', 'Déplacée')
    d = comment(d, 'src/a.ts', 'new', 2, 'DEUX', 'Disparue')
    d = comment(d, 'src/a.ts', 'new', 5, '}', 'Accolade')
    d = comment(d, 'src/b.ts', 'new', 1, 'x', 'Fichier retiré')
    return d
  }

  it('« Recharger » : tout est signalé puis seules les lignes retrouvées reviennent ; déplacement affiché ; ligne banale non replacée ailleurs', async () => {
    const d0 = conflicted()
    const fetched: [string, boolean][] = []
    const out = await reloadForReview(d0, {
      fetchPull: async () => ({ ...pullDetail(SHA2), files: [{ path: 'src/a.ts', status: 'M', additions: 4, deletions: 1 }] }),
      fetchFile: async (p, refresh) => {
        fetched.push([p, refresh])
        return MOVED
      },
    })
    // src/b.ts n'est plus dans la demande : pas relu ; src/a.ts relu une fois, sans cache.
    expect(fetched).toEqual([['src/a.ts', true]])
    const d = apply(d0, out.action)
    expect(d.headSha).toBe(SHA2)
    expect(d.comments.map((c) => [c.text, c.line, !!c.stale, movedLabel(c)])).toEqual([
      ['Déplacée', 4, false, 'ligne 3 → 4'],
      ['Disparue', 2, true, null],
      // « } » n'est plus à la ligne 5 : jamais replacé sur une autre « } » (ligne 6).
      ['Accolade', 5, true, null],
      ['Fichier retiré', 1, true, null],
    ])
    const b = buildForgeReview(d, 12, [{ path: 'src/a.ts' }])
    expect(b.payload.expected_head_sha).toBe(SHA2)
    expect(b.payload.comments).toEqual([{ path: 'src/a.ts', line: 4, side: 'new', body: 'Déplacée' }])
    expect(b.dropped.map((c) => c.text)).toEqual(['Disparue', 'Accolade', 'Fichier retiré'])
  })

  it('« Recharger » : panne au 2e fichier → rien n’est appliqué, l’ancienne tête est gardée', async () => {
    let d = conflicted()
    d = comment(d, 'src/b.ts', 'new', 4, 'quatre', 'Autre')
    const fetched: [string, boolean][] = []
    const run = reloadForReview(d, {
      fetchPull: async () => pullDetail(SHA2),
      fetchFile: async (p, refresh) => {
        fetched.push([p, refresh])
        if (p === 'src/b.ts') throw new Error('gh : 502')
        return MOVED
      },
    })
    await expect(run).rejects.toThrow('gh : 502')
    // Sans cache pour le premier fichier seulement.
    expect(fetched).toEqual([
      ['src/a.ts', true],
      ['src/b.ts', false],
    ])
    expect(d.headSha).toBe(SHA)
    expect(d.comments.every((c) => !c.stale)).toBe(true)
  })

  it('ligne banale : retrouvée seulement à la même place ; une ligne ordinaire suit son texte', () => {
    expect(isBanalLine('}')).toBe(true)
    expect(isBanalLine('  ')).toBe(true)
    expect(isBanalLine('});')).toBe(true)
    expect(isBanalLine('return x')).toBe(false)
    const rows = diffRows(MOVED)
    expect(findForgeAnchor(rows, 'new', 6, '}')).toBe(6)
    expect(findForgeAnchor(rows, 'new', 5, '}')).toBeNull()
    expect(findForgeAnchor(rows, 'new', 3, 'trois')).toBe(4)
  })

  it('revue publiée : commentaires publiés et commentaire général retirés, les signalés restent', () => {
    let d = apply(emptyForgeDraft, { type: 'head', sha: SHA }, { type: 'general', text: 'g' })
    d = comment(d, 'src/a.ts', 'new', 2, 'DEUX', 'a')
    d = comment(d, 'src/x.ts', 'new', 2, 'y', 'b')
    d = apply(d, { type: 'files', paths: ['src/a.ts'] }, { type: 'published', ids: [1] })
    expect(d.general).toBe('')
    expect(d.comments.map((c) => c.text)).toEqual(['b'])
  })
})

describe('CI, revue, état : glyphe et texte', () => {
  it('états de la CI', () => {
    const c = (state: string, extra = {}) => checksLabel({ state, total: 7, passed: 5, failed: 2, pending: 0, ...extra } as never)
    expect(c('success')).toMatchObject({ glyph: '✓', text: 'CI réussie', tone: 'ok' })
    expect(c('success').label).toBe('CI réussie : 5 vérifications réussies sur 7')
    expect(c('failure')).toMatchObject({ glyph: '✗', text: 'CI en échec (2/7)', tone: 'bad', label: 'CI en échec : 2 vérifications en échec sur 7' })
    expect(c('pending', { pending: 1 })).toMatchObject({ glyph: '◷', text: 'CI en cours', tone: 'pend', label: 'CI en cours : 1 vérification en attente sur 7' })
    expect(c('none', { total: 0 })).toMatchObject({ glyph: '–', text: 'pas de CI' })
    expect(checksLabel(null)).toMatchObject({ glyph: '?', text: 'CI inconnue' })
    expect(c('weird')).toMatchObject({ glyph: '?', text: 'CI inconnue' })
  })

  it('vérifications, décisions de revue, états de la demande, durées', () => {
    expect(['success', 'failure', 'pending', 'skipped', 'cancelled', 'x'].map((s) => `${checkRunLabel(s).glyph} ${checkRunLabel(s).text}`)).toEqual([
      '✓ réussie',
      '✗ échec',
      '◷ en cours',
      '↷ ignorée',
      '⊘ annulée',
      '? inconnue',
    ])
    expect(reviewDecisionLabel('approved')?.text).toBe('approuvée')
    expect(reviewDecisionLabel('changes_requested')?.text).toBe('modifications demandées')
    expect(reviewDecisionLabel('review_required')?.text).toBe('revue attendue')
    expect(reviewDecisionLabel(null)).toBeNull()
    expect(pullStateLabel('open').text).toBe('ouverte')
    expect(pullStateLabel('open', true).text).toBe('brouillon')
    expect(pullStateLabel('merged').text).toBe('fusionnée')
    expect(pullStateLabel('closed').text).toBe('fermée')
    expect(checkDuration('2026-10-21T10:00:00Z', '2026-10-21T10:00:42Z')).toBe('42 s')
    expect(checkDuration('2026-10-21T10:00:00Z', '2026-10-21T10:03:05Z')).toBe('3 min 05 s')
    expect(checkDuration('2026-10-21T10:00:00Z', null, Date.parse('2026-10-21T11:02:00Z'))).toBe('1 h 02 min')
    expect(checkDuration(null, null)).toBeNull()
  })

  it('destination du brouillon de la forge', () => {
    expect(forgeDestination()).toBe('Publiée sur GitHub, visible par tous')
  })
})

describe('liste, fichiers, démon ancien', () => {
  const pull = (n: number, url: string): Pull =>
    ({ number: n, title: 't', state: 'open', draft: false, url, author: null, head: { branch: 'b', sha: SHA }, base: { branch: 'main' } }) as Pull

  it('paramètres de forge.pulls et demandes d’autres dépôts écartées', () => {
    expect(pullsParams(ROOT, { state: 'merged', search: '  x  ', mine: true }, true)).toEqual({
      root: ROOT,
      state: 'merged',
      search: 'x',
      author: '@me',
      limit: 50,
      refresh: true,
    })
    const r = onlyRepoPulls([pull(1, 'https://github.com/o/r/pull/1'), pull(2, 'https://github.com/x/y/pull/2'), pull(3, 'https://github.com/o/r/issues/3')], {
      host: 'github.com',
      repo: 'o/r',
    })
    expect(r.pulls.map((p) => p.number)).toEqual([1])
    expect(r.dropped).toBe(2)
  })

  it('statuts des fichiers ramenés aux lettres de git', () => {
    expect(
      pullDiffFiles([
        { path: 'a', status: 'added', additions: 1, deletions: 0 },
        { path: 'b', status: 'removed', additions: 0, deletions: 2 },
        { path: 'c', old_path: 'z', status: 'renamed', additions: 0, deletions: 0 },
        { path: 'd', status: 'M', additions: null, deletions: null },
        { path: 'e', status: '???', additions: 1, deletions: 1 },
      ]).map((f) => f.status),
    ).toEqual(['A', 'D', 'R', 'M', 'M'])
  })

  it('démon ancien : méthode inconnue distinguée de la forge indisponible ; pas de revue sans la capacité', () => {
    expect(pullsErrorKind(ErrorCode.MethodNotFound)).toBe('old-daemon')
    expect(pullsErrorKind(ErrorCode.ForgeUnavailable)).toBe('unavailable')
    expect(pullsErrorKind(ErrorCode.Internal)).toBe('other')
    expect(supportsForgeReview({ capabilities: undefined })).toBe(false)
    expect(supportsForgeReview({ capabilities: { review_comments: false, checks: false } })).toBe(false)
    expect(supportsForgeReview({ capabilities: { review_comments: true, checks: true } })).toBe(true)
  })

  it('demande de la branche d’une session lue avec tolérance', () => {
    expect(branchPullOf(null)).toBeNull()
    expect(branchPullOf({ number: 'x' })).toBeNull()
    expect(branchPullOf({ number: 4, state: 'merged' })).toBeNull()
    expect(branchPullOf({ number: 4, title: 'A\u202eB', url: 'https://github.com/o/r/pull/4', checks: null })).toEqual({
      number: 4,
      title: 'AB',
      url: 'https://github.com/o/r/pull/4',
      draft: false,
      checks: null,
    })
  })
})

/* ---------- Nettoyage du texte de l'utilisateur : même règle que le démon ---------- */

/** Fixture partagée avec le démon (chemin relatif au dépôt). */
const CLEANING_FIXTURE = resolve(__dirname, '../../crates/core/tests/fixtures/forge/user-text-cleaning.json')

function fixtureCases(): { input: string; expected: string }[] {
  const raw = JSON.parse(readFileSync(CLEANING_FIXTURE, 'utf8')) as unknown
  const list = Array.isArray(raw) ? raw : Array.isArray((raw as { cases?: unknown }).cases) ? (raw as { cases: unknown[] }).cases : [raw]
  return list as { input: string; expected: string }[]
}

describe('texte publié : nettoyage identique à celui du démon', () => {
  it('fixture partagée crates/core/tests/fixtures/forge/user-text-cleaning.json', () => {
    const cases = fixtureCases()
    expect(cases.length).toBeGreaterThan(0)
    for (const c of cases) expect(publishedText(c.input), JSON.stringify(c.input)).toBe(c.expected)
  })

  it('règle : contrôles (sauf \\n, \\t) et bidi retirés ; ZWJ, sélecteurs de variation, indentation gardés ; lignes vides de bord retirées', () => {
    expect(publishedText('\u0007a\u0000b\u001bc\u009b')).toBe('abc')
    expect(publishedText('a\u202eb\u2066c\u2069d\u200ee\u200ff\u061cg')).toBe('abcdefg')
    expect(publishedText('👩\u200d💻 ❤\ufe0f')).toBe('👩\u200d💻 ❤\ufe0f')
    expect(publishedText('\n \n\tif x:\n\t\tpass\n\n \n')).toBe('\tif x:\n\t\tpass')
    expect(publishedText('a\r\nb\rc')).toBe('a\nb\nc')
    expect(publishedText(' \n\u202e\t\n')).toBe('')
  })
})

describe('diff trop gros pour GitHub', () => {
  it('message explicite', () => {
    expect(pullFileErrorText('gh : HTTP 406: Sorry, the diff exceeded the maximum number of lines (20000)')).toBe(
      'diff trop gros pour être affiché par GitHub : vois ce fichier sur la forge',
    )
    expect(pullFileErrorText('gh : 502')).toBe('Diff du fichier indisponible : gh : 502')
  })
})
