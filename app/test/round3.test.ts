import { describe, expect, it } from 'vitest'

import type { DaemonProfileQuota, Profile, ProjectInfo } from '../src/shared/protocol'
import { daemonSaysFolderExists, folderMissing, formatCompact, resumeBlock } from '../src/renderer/src/state/format'
import { groupByProject, groupPast, pastFolderMissing, type PastEntry } from '../src/renderer/src/state/projects'
import { quotaViews, refreshSettled } from '../src/renderer/src/state/quotas'
import { initialState, needsResolve, reducer } from '../src/renderer/src/state/store'
import { session } from './fixtures'

describe('nombres compacts', () => {
  it('tailles de contexte et tokens', () => {
    expect(formatCompact(1_000_000)).toBe('1M')
    expect(formatCompact(200_000)).toBe('200k')
    expect(formatCompact(122_000)).toBe('122k')
    expect(formatCompact(1_100_000)).toBe('1,1M')
    expect(formatCompact(840_000)).toBe('840k')
    expect(formatCompact(1_234)).toBe('1,2k')
    expect(formatCompact(1_000)).toBe('1k')
    expect(formatCompact(999)).toBe('999')
    expect(formatCompact(0)).toBe('0')
    expect(formatCompact(25_400_000)).toBe('25M')
    // Arrondi à la frontière : jamais « 1000k ».
    expect(formatCompact(999_600)).toBe('1M')
    expect(formatCompact(9_960)).toBe('10k')
    expect(formatCompact(999.6)).toBe('1k')
    expect(formatCompact(999.4)).toBe('999')
    expect(formatCompact(-0.3)).toBe('0')
    expect(formatCompact(-0)).toBe('0')
    expect(formatCompact(-0.5)).toBe('-1')
    expect(formatCompact(-1_500)).toBe('-1,5k')
    expect(formatCompact(Number.POSITIVE_INFINITY)).toBe('inconnu')
    expect(formatCompact(Number.NEGATIVE_INFINITY)).toBe('inconnu')
    expect(formatCompact(null)).toBe('inconnu')
    expect(formatCompact(Number.NaN)).toBe('inconnu')
  })
})

const repoInferred: ProjectInfo = {
  path: '/home/u/code/app--feat',
  is_git: true,
  root: '/home/u/code/app',
  worktree_root: null,
  common_dir: '/home/u/code/app/.git',
  branch: null,
  name: 'app',
  exists: false,
  inferred: true,
}
const repo: ProjectInfo = { ...repoInferred, path: '/home/u/code/app', worktree_root: '/home/u/code/app', exists: true, inferred: false }

function past(id: string, cwd: string, over: Partial<PastEntry> = {}): PastEntry {
  return {
    claude_session_id: id,
    transcript_path: null,
    cwd,
    git_branch: 'feat',
    first_prompt: null,
    title: null,
    first_timestamp: null,
    last_timestamp: '2026-10-19T10:00:00Z',
    message_count: 1,
    profile: 'default',
    profiles: ['default'],
    ...over,
  }
}

describe('dossier disparu (worktree supprimé)', () => {
  const projects = { '/home/u/code/app--feat': repoInferred, '/home/u/code/app': repo }

  it('ancienne session : dans le groupe du dépôt déduit, pas un groupe nommé d’après le worktree', () => {
    const groups = groupPast([past('a', '/home/u/code/app--feat'), past('b', '/home/u/code/app')], projects, '/home/u')
    expect(groups.map((g) => [g.name, g.entries.map((e) => e.claude_session_id)])).toEqual([['app', ['a', 'b']]])
    expect(pastFolderMissing(past('a', '/home/u/code/app--feat'), projects)).toBe(true)
    expect(pastFolderMissing(past('b', '/home/u/code/app'), projects)).toBe(false)
    // `cwd_exists` du démon suffit, même avant la résolution.
    expect(pastFolderMissing(past('c', '/x', { cwd_exists: false }), {})).toBe(true)
    expect(pastFolderMissing(past('d', '/x'), {})).toBe(false)
  })

  it('hors dépôt : groupé sous l’ancêtre retenu par le démon', () => {
    const info: ProjectInfo = { path: '/home/u/tmp/x', is_git: false, root: '/home/u/tmp', worktree_root: null, common_dir: null, branch: null, name: null, exists: false, inferred: true }
    const [g] = groupPast([past('a', '/home/u/tmp/x')], { '/home/u/tmp/x': info }, '/home/u')
    expect(g).toMatchObject({ key: 'dossier:/home/u/tmp', name: 'tmp' })
  })

  it('racine absente (dossier disparu sans ancêtre retenu) : pas d’erreur', () => {
    const gone: ProjectInfo = { path: '/tmp/x/y', is_git: false, root: null, worktree_root: null, common_dir: null, branch: null, name: 'y', exists: false, inferred: false }
    const [g] = groupPast([past('a', '/tmp/x/y')], { '/tmp/x/y': gone }, '/home/u')
    expect(g).toMatchObject({ key: 'dossier:/tmp/x/y', name: 'y' })
    const gitNoRoot: ProjectInfo = { ...gone, is_git: true, common_dir: '/r/.git', name: null }
    const [h] = groupPast([past('b', '/tmp/x/y')], { '/tmp/x/y': gitNoRoot }, '/home/u')
    expect(h).toMatchObject({ key: 'git:/r/.git', name: 'y', root: '/tmp/x/y' })
    expect(groupByProject([session({ cwd: '/tmp/x/y', project_root: null })], { '/tmp/x/y': gone }, null)[0]).toMatchObject({ key: '/tmp/x/y' })
  })

  it('session courante : même groupe que le dépôt', () => {
    const a = session({ cwd: '/home/u/code/app--feat', project_root: '/home/u/code/app--feat' })
    const b = session({ cwd: '/home/u/code/app', project_root: '/home/u/code/app' })
    const groups = groupByProject([a, b], projects, '/home/u')
    expect(groups).toHaveLength(1)
    expect(groups[0]!.name).toBe('app')
  })

  it('raison de la reprise impossible', () => {
    const stopped = { alive: false, cwd: '/p/x' }
    expect(resumeBlock({ ...stopped, resumable: false, resume_blocker: 'cwd_missing' })?.short).toBe('dossier supprimé (worktree ?)')
    expect(resumeBlock({ ...stopped, resumable: false, resume_blocker: 'transcript_missing' })?.short).toBe('pas de transcript')
    expect(resumeBlock({ ...stopped, resumable: false })?.short).toBe('pas de transcript')
    expect(resumeBlock({ ...stopped, resumable: true }, { exists: false })?.long).toMatch(/^Le dossier de la session n’existe plus.*: \/p\/x\./)
    expect(resumeBlock({ ...stopped })).toBeNull() // démon plus ancien : reprise proposée
    expect(resumeBlock({ ...stopped, alive: true, resumable: false })).toBeNull()
    // Démon sans `resume_blocker` : le cache de projects.resolve.
    expect(folderMissing({}, { exists: false })).toBe(true)
    expect(folderMissing({}, undefined)).toBe(false)
  })
})

describe('quotas du démon', () => {
  const profiles: Profile[] = [
    { name: 'default', config_dir: '/h/.claude', sets_config_dir_env: false },
    { name: 'work', config_dir: '/h/.claude-work', sets_config_dir_env: true },
  ]
  const NOW = Date.parse('2026-10-19T12:00:00Z')
  const q = (five: number | null, seven: number | null, over: Partial<DaemonProfileQuota> = {}): DaemonProfileQuota => ({
    five_hour: five === null ? null : { used_percentage: five, resets_at: '2026-10-19T14:00:00Z' },
    seven_day: seven === null ? null : { used_percentage: seven, resets_at: '2026-10-22T09:00:00Z' },
    source: 'usage_api',
    fetched_at: '2026-10-19T11:59:00Z',
    error: null,
    ...over,
  })

  it('dès le démarrage, sans aucune session', () => {
    const v = quotaViews([], profiles, { default: q(12, 40), work: q(null, null, { source: null, error: 'jeton expiré' }) }, NOW)
    expect(v).toEqual([
      {
        profile: 'default',
        fiveHour: { used_pct: 12, resets_at: '2026-10-19T14:00:00Z' },
        sevenDay: { used_pct: 40, resets_at: '2026-10-22T09:00:00Z' },
        fiveHourMeta: { source: 'usage_api', fetchedAt: '2026-10-19T11:59:00Z' },
        sevenDayMeta: { source: 'usage_api', fetchedAt: '2026-10-19T11:59:00Z' },
        source: 'usage_api',
        error: null,
        fetchedAt: '2026-10-19T11:59:00Z',
      },
      {
        profile: 'work',
        fiveHour: null,
        sevenDay: null,
        fiveHourMeta: null,
        sevenDayMeta: null,
        source: null,
        error: 'jeton expiré',
        fetchedAt: '2026-10-19T11:59:00Z',
      },
    ])
  })

  it('repli sur la statusline : démon plus ancien, mesure manquante ou fenêtre écoulée', () => {
    const s = session({
      profile: 'work',
      updated_at: '2026-10-19T11:00:00Z',
      metrics: {
        rate_limits: {
          five_hour: { used_pct: 55, resets_at: '2026-10-19T15:00:00Z' },
          seven_day: { used_pct: 70, resets_at: '2026-10-23T00:00:00Z' },
        },
      },
    })
    const old = quotaViews([s], profiles, null, NOW)
    expect(old[1]).toMatchObject({ fiveHour: { used_pct: 55 }, source: 'statusline', error: null })
    const expired = q(99, 41)
    expired.five_hour!.resets_at = '2026-10-19T11:00:00Z'
    const mixed = quotaViews([s], profiles, { work: expired }, NOW)
    expect(mixed[1]).toMatchObject({
      fiveHour: { used_pct: 55 },
      sevenDay: { used_pct: 41 },
      fiveHourMeta: { source: 'statusline', fetchedAt: null },
      sevenDayMeta: { source: 'usage_api' },
      source: 'usage_api',
    })
    // Profil connu du démon seulement : ajouté à la fin.
    expect(quotaViews([], [], { autre: q(1, 2) }, NOW).map((x) => x.profile)).toEqual(['autre'])
  })

  it('store : quotas.updated fusionne par profil, rapport invalide ignoré', () => {
    let st = reducer(initialState, { type: 'quotas', report: { profiles: { default: q(1, 2), work: q(3, 4) } } })
    st = reducer(st, { type: 'quotas', report: { profiles: { work: q(5, 6) } } })
    expect(st.quotas?.default?.five_hour?.used_percentage).toBe(1)
    expect(st.quotas?.work?.five_hour?.used_percentage).toBe(5)
    expect(reducer(st, { type: 'quotas', report: {} as never })).toBe(st)
  })
})

describe('le démon fait foi sur l’existence du dossier', () => {
  it('worktree recréé : plus de « dossier supprimé » malgré le cache', () => {
    expect(folderMissing({ resume_blocker: null }, { exists: false })).toBe(false)
    expect(folderMissing({ resume_blocker: 'transcript_missing' }, { exists: false })).toBe(false)
    expect(folderMissing({ resume_blocker: 'cwd_missing' }, { exists: true })).toBe(true)
    expect(resumeBlock({ alive: false, cwd: '/p', resumable: true, resume_blocker: null }, { exists: false })).toBeNull()
    expect(daemonSaysFolderExists({ resume_blocker: null })).toBe(true)
    expect(daemonSaysFolderExists({ resume_blocker: 'cwd_missing' })).toBe(false)
    expect(daemonSaysFolderExists({})).toBeUndefined()
    const cache = { '/w': { ...repoInferred, path: '/w' } }
    expect(pastFolderMissing(past('a', '/w', { cwd_exists: true }), cache)).toBe(false)
    expect(pastFolderMissing(past('a', '/w', { cwd_exists: null }), cache)).toBe(true)
  })

  it('redemande un dossier « disparu » quand le démon le voit, une seule fois par désaccord', () => {
    const st = reducer(initialState, { type: 'project', cwd: '/w', info: { ...repoInferred, path: '/w' } })
    expect(needsResolve(st, '/w', 0)).toBe(false)
    expect(needsResolve(st, '/w', 0, { daemonSaysExists: false })).toBe(false)
    expect(needsResolve(st, '/w', 0, { daemonSaysExists: true })).toBe(true)
    expect(needsResolve(st, '/w', 0, { daemonSaysExists: true, rechecked: true })).toBe(false)
  })

  it('à la reconnexion, les dossiers disparus sont redemandés', () => {
    let st = reducer(initialState, { type: 'project', cwd: '/w', info: { ...repoInferred, path: '/w' } })
    st = reducer(st, { type: 'project', cwd: '/ok', info: repo })
    st = reducer(st, { type: 'connection', state: { state: 'connected', server: 'orchd', version: '0', pid: 1 } })
    expect(needsResolve(st, '/w', 1)).toBe(true)
    expect(needsResolve(st, '/ok', 1)).toBe(false)
    // Toujours disparu : on n'insiste pas.
    st = reducer(st, { type: 'project', cwd: '/w', info: { ...repoInferred, path: '/w' } })
    expect(needsResolve(st, '/w', 1e12)).toBe(false)
  })
})

describe('actualisation des quotas', () => {
  it('terminée quand chaque profil a reçu un quotas.updated depuis le clic', () => {
    expect(refreshSettled({ a: 1 }, { a: 1, b: 0 }, ['a', 'b'])).toBe(false)
    expect(refreshSettled({ a: 1 }, { a: 2 }, ['a', 'b'])).toBe(false)
    expect(refreshSettled({ a: 1 }, { a: 2, b: 1 }, ['a', 'b'])).toBe(true)
    expect(refreshSettled({}, {}, [])).toBe(true)
  })

  it('seules les notifications comptent (pas la réponse immédiate de quotas.get)', () => {
    const report = { profiles: { a: { five_hour: null, seven_day: null, source: null, fetched_at: null, error: null } } }
    let st = reducer(initialState, { type: 'quotas', report })
    expect(st.quotasSeq).toEqual({})
    st = reducer(st, { type: 'quotas', report, notified: true })
    st = reducer(st, { type: 'quotas', report, notified: true })
    expect(st.quotasSeq).toEqual({ a: 2 })
  })
})
