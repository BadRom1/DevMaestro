import { describe, expect, it } from 'vitest'

import { IntegratedNotifier, integratedContent } from '../src/main/notifyLogic'
import { ValidationError, WORKTREE_TIMEOUT_MS, requestTimeoutMs, validateParams } from '../src/main/validate'
import { buildProjectChoices, resumeCandidates, sessionProjectKey } from '../src/renderer/src/state/newSession'
import { groupByProject } from '../src/renderer/src/state/projects'
import {
  branchDeletable,
  candidate,
  cleanupCount,
  cleanupRows,
  defaultChecked,
  dirtyFiles,
  initialChoices,
  lossesFor,
  noteWork,
  protectedBranches,
  removable,
  removedText,
  worktreeOf,
  worktreeStates,
} from '../src/renderer/src/state/worktrees'
import { describeError, outcomeUncertain } from '../src/renderer/src/state/errors'
import { ErrorCode, type ProjectInfo, type WorktreeInfo } from '../src/shared/protocol'
import {
  SettingsError,
  applyPatch,
  defaultSettings,
  mergePatches,
  normalizeSettings,
  projectWorktreeLocation,
  validatePatch,
} from '../src/shared/settings'
import {
  HASH_PLACEHOLDER,
  branchFromName,
  branchNameProblem,
  branchPrefixProblem,
  cleanupCandidate,
  commonDirHash8,
  managedWorktreesDir,
  rootFromCommonDir,
  worktreePath,
  worktreeSlug,
} from '../src/shared/worktrees'
import { session } from './fixtures'

const ROOT = '/home/u/code/projet'
const COMMON = `${ROOT}/.git`

function wt(over: Partial<WorktreeInfo> = {}): WorktreeInfo {
  return {
    path: `${ROOT}-feat`,
    branch: 'feat',
    head: 'abcdef0123456789',
    main: false,
    locked: false,
    prunable: false,
    exists: true,
    dirty: false,
    // Par défaut : une branche avec du travail à elle, pas encore intégrée.
    ahead: 1,
    integrated: 'no',
    sessions_running: 0,
    managed_by: null,
    ...over,
  }
}

/** Branche intégrée de façon crédible : créée par l'app, fusionnée dans la référence. */
function merged(over: Partial<WorktreeInfo> = {}): WorktreeInfo {
  return wt({ integrated: 'merged', ahead: 0, managed_by: 'devmaestro', ...over })
}

const MAIN = wt({ path: ROOT, branch: 'main', main: true, integrated: null, ahead: null })

describe('slug et chemin du worktree (même règle que le démon)', () => {
  it('slug : « / » et caractères hors [A-Za-z0-9._-] → « - », 80 caractères au plus', () => {
    expect(worktreeSlug('romain/fix-export')).toBe('romain-fix-export')
    expect(worktreeSlug('feat/été 2026')).toBe('feat--t--2026')
    expect(worktreeSlug('a.b_c-D')).toBe('a.b_c-D')
    expect(worktreeSlug('x'.repeat(100))).toHaveLength(80)
  })

  it('chemin selon l’emplacement', () => {
    const base = { root: ROOT, branch: 'romain/fix' }
    expect(worktreePath({ ...base, location: 'sibling' })).toBe('/home/u/code/projet-romain-fix')
    expect(worktreePath({ ...base, location: 'in_repo' })).toBe('/home/u/code/projet/.worktrees/romain-fix')
    expect(worktreePath({ ...base, location: 'managed', managedDir: '/home/u/.local/share/devmaestro/worktrees', commonDirHash: '1a2b3c4d' })).toBe(
      '/home/u/.local/share/devmaestro/worktrees/projet-1a2b3c4d/romain-fix',
    )
    expect(worktreePath({ ...base, location: 'managed', managedDir: '/d' })).toBe(`/d/projet-${HASH_PLACEHOLDER}/romain-fix`)
    expect(worktreePath({ ...base, location: 'custom', customParent: '/tmp/wt/' })).toBe('/tmp/wt/romain-fix')
    // Données manquantes : pas de chemin.
    expect(worktreePath({ ...base, location: 'custom' })).toBeNull()
    expect(worktreePath({ ...base, location: 'managed', managedDir: null })).toBeNull()
    expect(worktreePath({ root: ROOT, branch: '  ', location: 'sibling' })).toBeNull()
    expect(worktreePath({ root: ROOT, branch: '..', location: 'sibling' })).toBeNull()
    // Dépôt à la racine du système de fichiers.
    expect(worktreePath({ root: '/projet', branch: 'b', location: 'sibling' })).toBe('/projet-b')
  })

  it('empreinte du dossier commun : FNV-1a 64 bits, comme le démon', () => {
    // Valeurs de référence calculées hors de l'app (même algorithme que `common_dir_hash8`).
    expect(commonDirHash8(COMMON)).toBe('955c2fb3')
    expect(commonDirHash8('/home/é/.git')).toBe('821a0009')
    expect(worktreePath({ root: ROOT, branch: 'b', location: 'managed', managedDir: '/d', commonDirHash: commonDirHash8(COMMON) })).toBe(
      '/d/projet-955c2fb3/b',
    )
  })

  it('nom de branche tiré du nom de la session, avec préfixe', () => {
    expect(branchFromName('Corriger l’export CSV', 'romain/')).toBe('romain/corriger-l-export-csv')
    expect(branchFromName('  Été : déjà vu !  ')).toBe('ete-deja-vu')
    expect(branchFromName('!!!')).toBe('')
    expect(branchFromName('a'.repeat(100)).length).toBe(60)
  })

  it('noms de branche refusés', () => {
    expect(branchNameProblem('feat/x')).toBeNull()
    for (const bad of ['', 'a b', '-x', 'a..b', 'a/', '/a', 'a//b', 'x.lock', 'a~1', 'a:b', '.x', 'a/.b', 'a@{1}', 'tab\there']) {
      expect(branchNameProblem(bad), bad).not.toBeNull()
    }
    expect(branchPrefixProblem('')).toBeNull()
    expect(branchPrefixProblem('romain/')).toBeNull()
    expect(branchPrefixProblem('a b')).not.toBeNull()
  })

  it('dossier commun → racine ; dossier des worktrees gérés', () => {
    expect(rootFromCommonDir('/x/y/.git')).toBe('/x/y')
    expect(rootFromCommonDir('/x/y/.git/')).toBe('/x/y')
    expect(rootFromCommonDir('/srv/depot.git')).toBeNull()
    expect(rootFromCommonDir(null)).toBeNull()
    expect(managedWorktreesDir('/data', '/home/u')).toBe('/data/devmaestro/worktrees')
    expect(managedWorktreesDir('relatif', '/home/u')).toBe('/home/u/.local/share/devmaestro/worktrees')
    expect(managedWorktreesDir(undefined, '/home/u/')).toBe('/home/u/.local/share/devmaestro/worktrees')
  })
})

describe('regroupement par identité de projet', () => {
  const repo: ProjectInfo = {
    path: ROOT,
    is_git: true,
    root: ROOT,
    worktree_root: ROOT,
    common_dir: COMMON,
    branch: 'main',
    name: 'projet',
    exists: true,
  }

  it('une session d’un worktree supprimé (emplacement « sibling ») reste sous son projet', () => {
    const alive = session({ cwd: ROOT })
    const gone = session({
      cwd: '/home/u/code/projet-fix-export',
      project_root: '/home/u/code/projet-fix-export',
      alive: false,
      status: { state: 'stopped' },
      resume_blocker: 'cwd_missing',
      project_common_dir: COMMON,
    })
    // Le démon ne retrouve pas de dépôt pour ce dossier disparu (déduction actuelle).
    const lost: ProjectInfo = {
      path: gone.cwd,
      is_git: false,
      root: null,
      worktree_root: null,
      common_dir: null,
      branch: null,
      name: 'projet-fix-export',
      exists: false,
      inferred: false,
    }
    const groups = groupByProject([alive, gone], { [ROOT]: repo, [gone.cwd]: lost })
    expect(groups).toHaveLength(1)
    expect(groups[0]!).toMatchObject({ key: COMMON, root: ROOT, name: 'projet', isGit: true, missing: false })
    expect(groups[0]!.sessions.map((s) => s.id).sort()).toEqual([alive.id, gone.id].sort())
  })

  it('identité seule (aucune résolution) : racine déduite du dossier commun', () => {
    const s = session({ cwd: '/ailleurs/wt', project_root: '/ailleurs/wt', project_common_dir: COMMON })
    const [g] = groupByProject([s], {})
    expect(g).toMatchObject({ key: COMMON, root: ROOT, name: 'projet', isGit: true })
  })

  it('sans identité (démon plus ancien) : déduction actuelle inchangée', () => {
    const s = session({ cwd: ROOT })
    const [g] = groupByProject([s], { [ROOT]: repo })
    expect(g).toMatchObject({ key: COMMON, root: ROOT })
  })

  it('« Nouvelle session » : même projet, dossier disparu non proposé, reprise rattachée', () => {
    const alive = session({ cwd: ROOT })
    const gone = session({
      cwd: '/home/u/code/projet-old',
      alive: false,
      status: { state: 'stopped' },
      resume_blocker: 'cwd_missing',
      project_common_dir: COMMON,
    })
    const choices = buildProjectChoices({ sessions: [alive, gone], past: [], projects: { [ROOT]: repo }, home: null })
    expect(choices).toHaveLength(1)
    expect(choices[0]!.key).toBe(`git:${COMMON}`)
    expect(choices[0]!.dirs.map((d) => d.path)).toEqual([ROOT])
    expect(sessionProjectKey(gone, undefined)).toBe(`git:${COMMON}`)
    const stopped = session({ cwd: '/home/u/code/projet-wt', alive: false, status: { state: 'stopped' }, resumable: true, resume_blocker: null, project_common_dir: COMMON })
    const c = resumeCandidates({ projectKey: `git:${COMMON}`, sessions: [stopped], past: [], projects: {}, label: () => 'x' })
    expect(c.map((x) => x.key)).toEqual([`s:${stopped.id}`])
  })
})


describe('dialogue de nettoyage : choix par défaut', () => {
  it('intégrées crédibles sans session cochées ; Claude Desktop, modifiées, en cours, non intégrées, neuves non cochées', () => {
    const list = [
      MAIN,
      merged({ path: '/a', branch: 'merged' }),
      wt({ path: '/b', branch: 'squashed', integrated: 'squashed', ahead: 2 }),
      merged({ path: '/c', branch: 'desktop', managed_by: 'claude_desktop' }),
      merged({ path: '/d', branch: 'dirty', dirty: true }),
      merged({ path: '/e', branch: 'running', sessions_running: 1 }),
      wt({ path: '/f', branch: 'ahead', ahead: 3 }),
      wt({ path: '/g', branch: 'neuve', integrated: 'empty', ahead: 0, managed_by: 'devmaestro' }),
    ]
    const c = initialChoices(list)
    expect(Object.keys(c).sort()).toEqual(['/a', '/b', '/c', '/d', '/e', '/f', '/g'])
    expect(Object.entries(c).filter(([, v]) => v.remove).map(([k]) => k)).toEqual(['/a', '/b'])
    // « Supprimer aussi la branche » : cochée pour une branche intégrée, ou sans commit à elle.
    expect(c['/a']!.deleteBranch).toBe(true)
    expect(c['/c']!.deleteBranch).toBe(true)
    expect(c['/f']!.deleteBranch).toBe(false)
    expect(c['/g']!.deleteBranch).toBe(true)
    expect(defaultChecked(MAIN)).toBe(false)
  })

  it('branche neuve jamais vue en avance : ni coche ni badge ; vue en avance puis intégrée : cochée', () => {
    // `merged` sans commit à elle, pas créée par l'app (démon plus ancien, ou branche faite à la main).
    const fresh = merged({ path: '/n', branch: 'n', managed_by: null })
    expect(defaultChecked(fresh)).toBe(false)
    expect(candidate(fresh, undefined)).toBe(false)
    expect(cleanupCount({ default_branch: 'main', worktrees: [MAIN, fresh] })).toBe(0)
    const seen = new Set<string>()
    noteWork(seen, [wt({ path: '/n', branch: 'n', ahead: 2, managed_by: null })])
    expect(defaultChecked(fresh, seen)).toBe(true)
    expect(cleanupCount({ default_branch: 'main', worktrees: [MAIN, fresh] }, seen)).toBe(1)
    // `empty` (le démon distingue la branche neuve créée par l'app) : jamais intégrée, mais supprimable.
    const empty = wt({ path: '/e', integrated: 'empty', ahead: 0, managed_by: 'devmaestro' })
    expect(candidate(empty, seen)).toBe(false)
    expect(removable(empty)).toBe(true)
    expect(worktreeStates(empty).map((s) => s.label)).toEqual(['aucun commit'])
  })

  it('branche par défaut et de référence : jamais proposées à la suppression', () => {
    const p = protectedBranches({ default_branch: 'main', reference: 'origin/develop' })
    expect([...p].sort()).toEqual(['develop', 'main', 'origin/develop'])
    const onMain = merged({ path: '/m', branch: 'main' })
    expect(branchDeletable(onMain, p)).toBe(false)
    expect(initialChoices([onMain], null, { protectedSet: p })['/m']!.deleteBranch).toBe(false)
    expect(branchDeletable(merged({ branch: 'feat' }), p)).toBe(true)
  })

  it('worktree visé par « Nettoyer… » coché, jamais s’il est modifié ou occupé', () => {
    const list = [wt({ path: '/f', ahead: 1 }), wt({ path: '/d', dirty: true })]
    expect(initialChoices(list, '/f')['/f']!.remove).toBe(true)
    expect(initialChoices(list, '/d')['/d']!.remove).toBe(false)
  })

  it('lignes, états et pertes annoncées', () => {
    const rows = cleanupRows([wt({ path: '/z', branch: 'z' }), MAIN, merged({ path: '/a', branch: 'a' })])
    expect(rows.map((w) => w.path)).toEqual(['/a', '/z'])
    expect(worktreeStates(wt({ ahead: 2, dirty: true, sessions_running: 1 })).map((s) => s.label)).toEqual([
      'en avance de 2 commits',
      'modifications non commitées',
      'session en cours',
    ])
    expect(worktreeStates(merged({ managed_by: 'claude_desktop' })).map((s) => s.kind)).toEqual(['integrated', 'desktop'])
    expect(lossesFor(merged(), true)).toEqual([])
    expect(lossesFor(merged({ dirty: true }), false)[0]).toMatch(/refusée/)
    expect(lossesFor(merged({ dirty: true }), false, true)[0]).toMatch(/perdus/)
    expect(lossesFor(wt({ ahead: 1 }), true, true)).toEqual(['1 commit non intégré de feat seront perdus'])
    expect(lossesFor(wt({ ahead: 1 }), false, true)).toEqual([])
  })

  it('résultat de la suppression : la réponse du démon fait foi pour la branche', () => {
    expect(removedText({ branch: 'feat', branch_deleted: true, branch_error: null }, 'feat')).toBe(
      '✓ Worktree supprimé, branche feat supprimée',
    )
    expect(removedText({ branch: 'feat', branch_deleted: false, branch_error: "error: the branch 'feat' is not fully merged" }, 'feat')).toBe(
      "✓ Worktree supprimé ; branche non supprimée : error: the branch 'feat' is not fully merged",
    )
    expect(removedText({ branch: 'feat', branch_deleted: false, branch_error: null }, 'feat')).toMatch(/non supprimée : raison inconnue/)
    expect(removedText({ branch: 'feat', branch_deleted: null, branch_error: null }, 'feat')).toBe('✓ Worktree supprimé')
    // Démon plus ancien (réponse sans ces champs) : jamais « branche supprimée » par supposition.
    expect(removedText(null, 'feat')).toBe('✓ Worktree supprimé')
  })

  it('candidats, worktree d’un dossier, fichiers de -32020, résultat incertain', () => {
    expect(cleanupCandidate(merged())).toBe(true)
    expect(cleanupCandidate(merged({ sessions_running: 1 }))).toBe(false)
    expect(cleanupCandidate(merged({ managed_by: 'claude_desktop' }))).toBe(false)
    expect(cleanupCount({ default_branch: 'main', worktrees: [MAIN, merged(), wt({ path: '/x' })] })).toBe(1)
    const list = [MAIN, wt({ path: `${ROOT}/.worktrees/x` })]
    expect(worktreeOf(`${ROOT}/.worktrees/x/src`, list)?.path).toBe(`${ROOT}/.worktrees/x`)
    expect(worktreeOf(`${ROOT}/src`, list)?.path).toBe(ROOT)
    expect(worktreeOf('/ailleurs', list)).toBeUndefined()
    expect(dirtyFiles({ files: ['a.ts', 3, 'b.ts'] })).toEqual(['a.ts', 'b.ts'])
    expect(dirtyFiles(['c'])).toEqual(['c'])
    expect(dirtyFiles(null)).toEqual([])
    expect(describeError(-32020, 'x')).toMatch(/modifications non commitées/)
    expect(describeError(-32019, '')).toMatch(/session tourne/)
    expect(outcomeUncertain(ErrorCode.Timeout)).toBe(true)
    expect(outcomeUncertain(ErrorCode.Disconnected)).toBe(true)
    expect(outcomeUncertain(ErrorCode.InvalidParams)).toBe(false)
    expect(outcomeUncertain(null)).toBe(false)
  })
})

describe('validation IPC des worktrees', () => {
  const ID = { cwd: ROOT }
  it('sessions.launch : worktree nettoyé', () => {
    expect(validateParams('sessions.launch', { ...ID, worktree: { branch: 'feat/x', location: 'sibling', extra: 1 } })).toEqual({
      cwd: ROOT,
      worktree: { branch: 'feat/x', location: 'sibling' },
    })
    expect(
      validateParams('sessions.launch', { ...ID, worktree: { branch: 'b', base: 'origin/main', location: 'custom', path: '/tmp/wt/b' } }),
    ).toEqual({ cwd: ROOT, worktree: { branch: 'b', base: 'origin/main', location: 'custom', path: '/tmp/wt/b' } })
  })

  it('sessions.launch : worktree refusé', () => {
    const bad = [
      'x',
      [],
      { location: 'sibling' },
      { branch: '', location: 'sibling' },
      { branch: 'a b', location: 'sibling' },
      { branch: '-x', location: 'sibling' },
      { branch: 'b', location: 'ailleurs' },
      { branch: 'b', location: 'custom' },
      { branch: 'b', location: 'custom', path: 'relatif' },
      { branch: 'b', location: 'sibling', path: '/tmp/x' },
      { branch: 'b', base: 'a..b', location: 'sibling' },
      { branch: 'x'.repeat(500), location: 'sibling' },
    ]
    for (const w of bad) expect(() => validateParams('sessions.launch', { ...ID, worktree: w }), JSON.stringify(w)).toThrow(ValidationError)
  })

  it('worktrees.list et worktrees.remove', () => {
    expect(validateParams('worktrees.list', { root: ROOT, x: 1 })).toEqual({ root: ROOT })
    expect(() => validateParams('worktrees.list', { root: 'rel' })).toThrow(ValidationError)
    expect(() => validateParams('worktrees.list', {})).toThrow(ValidationError)
    const ok = { root: ROOT, path: '/tmp/wt', delete_branch: true, force: false }
    expect(validateParams('worktrees.remove', { ...ok, extra: 1 })).toEqual(ok)
    expect(() => validateParams('worktrees.remove', { ...ok, force: 'oui' })).toThrow(ValidationError)
    expect(() => validateParams('worktrees.remove', { ...ok, delete_branch: undefined })).toThrow(ValidationError)
    expect(() => validateParams('worktrees.remove', { ...ok, path: 'x\0' })).toThrow(ValidationError)
  })
})

describe('réglages des worktrees', () => {
  it('lecture tolérante', () => {
    expect(normalizeSettings({}).worktrees).toEqual(defaultSettings().worktrees)
    const s = normalizeSettings({
      worktrees: {
        location: 'in_repo',
        branchPrefix: 'a b',
        notifyIntegrated: false,
        projectLocations: { [ROOT]: 'managed', rel: 'sibling', '/x': 'custom' },
      },
    })
    expect(s.worktrees).toEqual({ location: 'in_repo', branchPrefix: '', notifyIntegrated: false, projectLocations: { [ROOT]: 'managed' } })
  })

  it('modification stricte, fusion par projet', () => {
    expect(() => validatePatch({ worktrees: { location: 'custom' } })).toThrow(SettingsError)
    expect(() => validatePatch({ worktrees: { branchPrefix: '../' } })).toThrow(SettingsError)
    expect(() => validatePatch({ worktrees: { truc: 1 } })).toThrow(SettingsError)
    expect(() => validatePatch({ worktrees: { projectLocations: { rel: 'sibling' } } })).toThrow(SettingsError)
    let s = applyPatch(defaultSettings(), validatePatch({ worktrees: { branchPrefix: 'romain/', projectLocations: { [ROOT]: 'in_repo' } } }))
    expect(s.worktrees).toMatchObject({ location: 'sibling', branchPrefix: 'romain/', projectLocations: { [ROOT]: 'in_repo' } })
    expect(projectWorktreeLocation(s.worktrees, ROOT)).toBe('in_repo')
    expect(projectWorktreeLocation(s.worktrees, '/autre')).toBe('sibling')
    s = applyPatch(s, validatePatch({ worktrees: { projectLocations: { [ROOT]: null } } }))
    expect(s.worktrees.projectLocations).toEqual({})
    expect(s.worktrees.branchPrefix).toBe('romain/')
    const m = mergePatches(
      { worktrees: { projectLocations: { '/a': 'managed' } } },
      { worktrees: { notifyIntegrated: false, projectLocations: { '/b': 'in_repo' } } },
    )
    expect(m.worktrees).toEqual({ notifyIntegrated: false, projectLocations: { '/a': 'managed', '/b': 'in_repo' } })
  })
})


describe('notification « branche intégrée »', () => {
  it('une seule fois par worktree et par état ; l’existant au démarrage n’est pas signalé', () => {
    const n = new IntegratedNotifier()
    const old = merged({ path: '/old', branch: 'old' })
    n.baseline(ROOT, [MAIN, old, wt({ path: '/w', branch: 'w' })])
    expect(n.known(ROOT)).toBe(true)
    // Rien de neuf : l'ancien intégré n'est pas signalé.
    expect(n.changed(ROOT, [MAIN, old, wt({ path: '/w', branch: 'w' })], true)).toEqual([])
    // /w devient intégré, sans session : signalé une fois.
    const done = merged({ path: '/w', branch: 'w', managed_by: null })
    expect(n.changed(ROOT, [MAIN, old, done], true).map((w) => w.path)).toEqual(['/w'])
    expect(n.changed(ROOT, [MAIN, old, done], true)).toEqual([])
    // Autre état d'intégration : nouvel état, signalé une fois.
    expect(n.changed(ROOT, [MAIN, old, wt({ path: '/w', branch: 'w', integrated: 'squashed', ahead: 1 })], true)).toHaveLength(1)
    // Nouveaux commits (non intégrée) puis de nouveau intégrée : réarmé.
    n.changed(ROOT, [MAIN, wt({ path: '/w', branch: 'w' })], true)
    expect(n.changed(ROOT, [MAIN, done], true)).toHaveLength(1)
  })

  it('branche neuve jamais vue en avance : ni notification ni coche', () => {
    const n = new IntegratedNotifier()
    n.baseline(ROOT, [MAIN])
    // Créée hors de l'app (ou démon plus ancien), sans commit : `merged`, `ahead: 0`.
    const fresh = merged({ path: '/neuve', branch: 'neuve', managed_by: null })
    expect(n.changed(ROOT, [MAIN, fresh], true)).toEqual([])
    expect(defaultChecked(fresh)).toBe(false)
    // Créée par l'app : le démon la donne `empty`, jamais intégrée.
    const empty = wt({ path: '/vide', branch: 'vide', integrated: 'empty', ahead: 0, managed_by: 'devmaestro' })
    expect(n.changed(ROOT, [MAIN, empty], true)).toEqual([])
    expect(defaultChecked(empty)).toBe(false)
    // La même branche avec des commits, puis intégrée : signalée.
    n.changed(ROOT, [MAIN, wt({ path: '/neuve', branch: 'neuve', managed_by: null })], true)
    expect(n.changed(ROOT, [MAIN, fresh], true)).toHaveLength(1)
  })

  it('attend la fin des sessions ; jamais pour Claude Desktop ; coupée : rien, sans rattrapage', () => {
    const n = new IntegratedNotifier()
    n.baseline(ROOT, [MAIN])
    expect(n.changed(ROOT, [merged({ path: '/r', sessions_running: 1 })], true)).toEqual([])
    expect(n.changed(ROOT, [merged({ path: '/r' })], true)).toHaveLength(1)
    expect(n.changed(ROOT, [merged({ path: '/d', managed_by: 'claude_desktop' })], true)).toEqual([])
    expect(n.changed(ROOT, [merged({ path: '/q' })], false)).toEqual([])
    expect(n.changed(ROOT, [merged({ path: '/q' })], true)).toEqual([])
  })

  it('dépôt jamais vu : la première liste sert de référence, sans rafale', () => {
    const n = new IntegratedNotifier()
    expect(n.changed('/autre', [merged({ path: '/n1' }), merged({ path: '/n2' })], true)).toEqual([])
    expect(n.known('/autre')).toBe(true)
    // Supprimé puis recréé et intégré : de nouveau signalé.
    expect(n.changed('/autre', [], true)).toEqual([])
    expect(n.changed('/autre', [merged({ path: '/n1' })], true)).toHaveLength(1)
  })

  it('état inconnu passager (`null`) : pas de doublon ensuite', () => {
    const n = new IntegratedNotifier()
    n.baseline(ROOT, [MAIN])
    expect(n.changed(ROOT, [merged({ path: '/p' })], true)).toHaveLength(1)
    expect(n.changed(ROOT, [merged({ path: '/p', integrated: null })], true)).toEqual([])
    expect(n.changed(ROOT, [merged({ path: '/p' })], true)).toEqual([])
  })

  it('délai de 120 s pour les opérations de worktree', () => {
    expect(requestTimeoutMs('worktrees.list', { root: ROOT })).toBe(WORKTREE_TIMEOUT_MS)
    expect(requestTimeoutMs('worktrees.remove', {})).toBe(120_000)
    expect(requestTimeoutMs('sessions.launch', { cwd: ROOT, worktree: { branch: 'b', location: 'sibling' } })).toBe(120_000)
    expect(requestTimeoutMs('sessions.launch', { cwd: ROOT })).toBeUndefined()
    expect(requestTimeoutMs('sessions.list', {})).toBeUndefined()
  })

  it('texte', () => {
    expect(integratedContent(ROOT, { branch: 'feat/<x>', path: '/p' })).toEqual({
      title: 'La branche feat/&lt;x&gt; est intégrée : nettoyer le worktree ?',
      body: 'projet · /p',
    })
  })
})
