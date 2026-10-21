import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { NotifyDecider, notificationContent, sanitizeNotificationText, BODY_MAX } from '../src/main/notifyLogic'
import { SettingsStore } from '../src/main/settingsStore'
import type { PastSession, ProjectInfo } from '../src/shared/protocol'
import {
  SettingsError,
  applyPatch,
  checkProfileLabel,
  defaultSettings,
  mergePatches,
  normalizeSettings,
  profileLabel,
  validatePatch,
  type ColorOverrides,
  type PaletteName,
} from '../src/shared/settings'
import {
  buildProjectChoices,
  mergeExtraChoices,
  profileKeyOf,
  projectKeyOf,
  resolveDefaultProfile,
  resumeCandidates,
} from '../src/renderer/src/state/newSession'
import { ancestorToResolve, groupByProject, groupPast, missingGroupDir, type PastEntry } from '../src/renderer/src/state/projects'
import { profileTone } from '../src/renderer/src/state/profileTone'
import { BASE, resolveScheme, schemeTokens, themeOverrides, tokenValue } from '../src/renderer/src/state/themeTokens'
import { session } from './fixtures'

const ctx = (over: Partial<{ enabled: boolean; windowFocused: boolean; visibleSessionId: string | null }> = {}) => ({
  enabled: true,
  windowFocused: false,
  visibleSessionId: null,
  ...over,
})

describe('notifications desktop : décision', () => {
  it('une par demande, remplacement par session, rien si coupé ou déjà visible', () => {
    const d = new NotifyDecider()
    expect(d.decide('a', 1, ctx({ enabled: false }))).toEqual({ action: 'skip', reason: 'disabled' })
    expect(d.decide('a', 1, ctx({ windowFocused: true, visibleSessionId: 'a' }))).toEqual({ action: 'skip', reason: 'visible' })
    // Fenêtre au premier plan mais autre session affichée : notifier.
    expect(d.decide('a', 1, ctx({ windowFocused: true, visibleSessionId: 'b' }))).toEqual({ action: 'show', replace: false })
    // Même demande reçue deux fois : une seule notification.
    expect(d.decide('a', 1, ctx())).toEqual({ action: 'skip', reason: 'duplicate' })
    // Nouvelle demande de la même session : remplace la précédente.
    expect(d.decide('a', 2, ctx())).toEqual({ action: 'show', replace: true })
    // Session affichée mais fenêtre sans focus : notifier.
    expect(d.decide('b', 1, ctx({ windowFocused: false, visibleSessionId: 'b' }))).toEqual({ action: 'show', replace: false })
  })

  it('fermeture quand la demande est close ou disparaît', () => {
    const d = new NotifyDecider()
    d.decide('a', 1, ctx())
    expect(d.resolved('a', 2)).toBe(false)
    expect(d.resolved('a', 1)).toBe(true)
    expect(d.resolved('a', 1)).toBe(false)
    d.decide('a', 3, ctx())
    expect(d.stale('a', [3])).toBe(false)
    expect(d.stale('a', [])).toBe(true)
    d.decide('b', 1, ctx())
    expect(d.stale('b', null)).toBe(true) // session retirée
    d.decide('c', 1, ctx())
    d.dismissed('c')
    expect(d.decide('c', 2, ctx())).toEqual({ action: 'show', replace: false })
  })
})

describe('notifications desktop : contenu', () => {
  const s = session({ display_name: 'Refonte OAuth', cwd: '/home/u/code/app', project_root: '/home/u/code/app' })

  it('permission : outil et résumé, titre = nom + projet', () => {
    const c = notificationContent(s, { kind: 'permission', tool_name: 'Bash', tool_input: { command: 'npm test\n  --watch' } })
    expect(c).toEqual({ title: 'Refonte OAuth · app', body: 'Permission : Bash · npm test --watch' })
  })

  it('question, demande sans détail, texte tronqué sur une ligne', () => {
    const q = notificationContent(s, {
      kind: 'question',
      tool_name: 'AskUserQuestion',
      tool_input: {},
      questions: [
        { question: 'Quelle base ?', options: [] },
        { question: 'Et le port ?', options: [] },
      ],
    })
    expect(q.body).toBe('Question : Quelle base ? (+1)')
    expect(notificationContent(null, { kind: 'permission', detailed: false })).toEqual({
      title: 'Session',
      body: 'Claude attend une permission.',
    })
    const long = notificationContent(s, { kind: 'permission', tool_name: 'Bash', tool_input: { command: 'x'.repeat(1000) } })
    expect([...long.body].length).toBe(BODY_MAX)
    expect(long.body.endsWith('…')).toBe(true)
    // Repli sans display_name (démon plus ancien) : branche ; projet omis s'il répète le nom.
    expect(notificationContent(session({ branch: 'app', cwd: '/c/app', project_root: '/c/app' }), { kind: 'question', detailed: false }).title).toBe('app')
  })
})

describe('réglages : validation et fusion', () => {
  it('lecture tolérante : champ invalide → défaut, le reste est gardé', () => {
    const s = normalizeSettings({
      theme: { mode: 'dark', palette: 'inconnue', custom: { light: { accent: '#ABCDEF', wait: 'rouge', foo: '#000000' }, dark: 3 } },
      notifications: { enabled: false },
      projectProfiles: { '/p': 'work', relatif: 'x', '/q': '' },
      confirmRemoval: 'oui',
      profileLabels: { default: { long: ' Perso ', short: 'P' }, work: { long: '', short: 'W' } },
    })
    expect(s.theme).toEqual({
      mode: 'dark',
      light: { palette: 'devmaestro', custom: { accent: '#abcdef' } },
      dark: { palette: 'devmaestro', custom: {} },
    })
    expect(s.notifications.enabled).toBe(false)
    expect(s.projectProfiles).toEqual({ '/p': 'work' })
    expect(s.confirmRemoval).toBe(true)
    expect(s.profileLabels).toEqual({ default: { long: 'Perso', short: 'P' } })
    expect(normalizeSettings('pas un objet')).toEqual(defaultSettings())
  })

  it('modification stricte depuis la page', () => {
    const bad: unknown[] = [
      null,
      { inconnu: 1 },
      { theme: { mode: 'violet' } },
      { theme: { light: { palette: 'okabe', custom: { accent: '#fff' } } } },
      { theme: { light: { palette: 'okabe', custom: { zzz: '#ffffff' } } } },
      { notifications: { enabled: 'oui' } },
      { projectProfiles: { relatif: 'work' } },
      { projectProfiles: { '/p': '' } },
      { confirmRemoval: 1 },
      { profileLabels: { work: { long: 'x'.repeat(31), short: 'W' } } },
      { profileLabels: { work: { long: 'Travail', short: 'WORK' } } },
      { profileLabels: { work: { long: 'Travail', short: 'W W' } } },
      { profileLabels: { work: { long: 'Travail', short: '​' } } },
    ]
    for (const p of bad) expect(() => validatePatch(p), JSON.stringify(p)).toThrow(SettingsError)
    const p = validatePatch({
      theme: { mode: 'light', light: { palette: 'okabe', custom: { err: '#FF0000' } } },
      projectProfiles: { '/p': 'work', '/q': null },
      profileLabels: { work: { long: ' Travail ', short: 'Tr' }, default: null },
    })
    expect(p.theme?.light?.custom).toEqual({ err: '#ff0000' })
    expect(p.profileLabels).toEqual({ work: { long: 'Travail', short: 'Tr' }, default: null })
    let s = applyPatch({ ...defaultSettings(), projectProfiles: { '/q': 'default' }, profileLabels: { default: { long: 'Perso', short: 'P' } } }, p)
    expect(s.projectProfiles).toEqual({ '/p': 'work' })
    expect(s.profileLabels).toEqual({ work: { long: 'Travail', short: 'Tr' } })
    s = applyPatch(s, { notifications: { enabled: false } })
    expect(s.notifications.enabled).toBe(false)
    expect(mergePatches({ projectProfiles: { '/a': 'x' }, confirmRemoval: true }, { projectProfiles: { '/b': null }, confirmRemoval: false })).toEqual({
      projectProfiles: { '/a': 'x', '/b': null },
      confirmRemoval: false,
    })
  })

  it('libellés de profil : défauts et validation', () => {
    expect(profileLabel('default', {})).toEqual({ long: 'Défaut', short: 'D' })
    expect(profileLabel('work', {})).toEqual({ long: 'Work', short: 'W' })
    expect(profileLabel('équipe', undefined)).toEqual({ long: 'Équipe', short: 'É' })
    expect(profileLabel('default', { default: { long: 'Perso', short: 'P' } })).toEqual({ long: 'Perso', short: 'P' })
    expect(checkProfileLabel({ long: 'Perso', short: '😀' })).toEqual({ long: 'Perso', short: '😀' })
    expect(typeof checkProfileLabel({ long: 'Perso', short: '' })).toBe('string')
    expect(typeof checkProfileLabel({ long: 'a\tb', short: 'A' })).toBe('string')
  })
})

describe('réglages sur disque', () => {
  let dir: string
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('premier lancement, écriture atomique en 0600, relecture', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'dm-settings-'))
    const st = new SettingsStore(path.join(dir, 'userData'))
    expect(await st.load()).toEqual(defaultSettings())
    expect(st.fresh).toBe(true)
    await st.update({ notifications: { enabled: false } })
    await st.update({ confirmRemoval: false })
    const file = path.join(dir, 'userData', 'settings.json')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readdirSync(path.join(dir, 'userData'))).toEqual(['settings.json']) // aucun fichier temporaire laissé
    const again = new SettingsStore(path.join(dir, 'userData'))
    const s = await again.load()
    expect(again.fresh).toBe(false)
    expect(s.notifications.enabled).toBe(false)
    expect(s.confirmRemoval).toBe(false)
    expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(1)
  })

  it('fichier illisible : valeurs par défaut ; modification refusée : rien d’écrit', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'dm-settings-'))
    writeFileSync(path.join(dir, 'settings.json'), '{pas du json', { mode: 0o644 })
    const logs: string[] = []
    const st = new SettingsStore(dir, (m) => logs.push(m))
    expect(await st.load()).toEqual(defaultSettings())
    expect(logs[0]).toMatch(/réglages illisibles/)
    await expect(st.update({ theme: 'sombre' })).rejects.toThrow(SettingsError)
    expect(readFileSync(path.join(dir, 'settings.json'), 'utf8')).toBe('{pas du json')
    await st.update({ confirmRemoval: false })
    expect(statSync(path.join(dir, 'settings.json')).mode & 0o777).toBe(0o600)
  })
})

describe('thème : palette et couleurs par mode', () => {
  const t = (light: PaletteName, dark: PaletteName, lc: ColorOverrides = {}, dc: ColorOverrides = {}) => ({
    light: { palette: light, custom: lc },
    dark: { palette: dark, custom: dc },
  })
  const lc = { accent: '#123456' }
  const dc = { err: '#ff00ff' }

  it('palette puis couleurs choisies, mode par mode', () => {
    expect(themeOverrides(t('devmaestro', 'devmaestro'), 'dark')).toEqual({})
    expect(themeOverrides(t('okabe', 'okabe', lc, dc), 'light')).toMatchObject({ accent: '#123456', run: '#00785a' })
    expect(themeOverrides(t('okabe', 'okabe', lc, dc), 'dark')).toMatchObject({ accent: '#cc79a7', err: '#ff00ff' })
    expect(tokenValue(t('devmaestro', 'devmaestro', lc, dc), 'dark', 'accent')).toBe(BASE.dark.accent)
    expect(tokenValue(t('devmaestro', 'devmaestro', lc, dc), 'light', 'accent')).toBe('#123456')
    const hc = schemeTokens(t('devmaestro', 'contraste'), 'dark')
    expect(hc).toMatchObject({ bg: '#000000', fg: '#ffffff', accent: '#ffd400' })
    expect(schemeTokens(t('contraste', 'devmaestro'), 'dark').bg).toBe('#0f1218')
    expect(schemeTokens(t('devmaestro', 'contraste'), 'light').bg).toBe('#eef1f6')
    expect(resolveScheme('system', true)).toBe('light')
    expect(resolveScheme('system', false)).toBe('dark')
    expect(resolveScheme('dark', true)).toBe('dark')
  })

  it('teinte de profil stable', () => {
    const profiles = [{ name: 'default' }, { name: 'work' }]
    expect(profileTone('default', profiles)).toBe(0)
    expect(profileTone('work', profiles)).toBe(1)
    expect(profileTone('autre', profiles)).toBe(profileTone('autre', []))
  })
})

const info = (path: string, root: string, over: Partial<ProjectInfo> = {}): ProjectInfo => ({
  path,
  is_git: true,
  root,
  worktree_root: path,
  common_dir: `${root}/.git`,
  branch: 'main',
  name: root.split('/').pop()!,
  exists: true,
  ...over,
})

function past(id: string, cwd: string | null, last: string, over: Partial<PastSession> = {}): PastEntry {
  return {
    claude_session_id: id,
    transcript_path: null,
    cwd,
    git_branch: null,
    first_prompt: null,
    title: null,
    first_timestamp: null,
    last_timestamp: last,
    message_count: 1,
    profile: 'default',
    profiles: ['default'],
    ...over,
  }
}

describe('nouvelle session : projets proposés', () => {
  const projects: Record<string, ProjectInfo> = {
    '/h/code/app': info('/h/code/app', '/h/code/app'),
    '/h/code/app-feat': info('/h/code/app-feat', '/h/code/app', { branch: 'feat' }),
    '/h/code/app-gone': info('/h/code/app-gone', '/h/code/app', { exists: false }),
    '/h/notes': { path: '/h/notes', is_git: false, root: '/h/notes', worktree_root: null, common_dir: null, branch: null, name: null, exists: true },
  }

  it('groupés par dépôt, du plus récent au plus ancien ; racine d’abord, dossiers disparus exclus', () => {
    const sessions = [
      session({ cwd: '/h/code/app-feat', branch: 'feat', profile: 'work', last_activity: '2026-10-20T10:00:00Z' }),
      session({ cwd: '/h/notes', branch: null, last_activity: '2026-10-19T10:00:00Z' }),
    ]
    const choices = buildProjectChoices({
      sessions,
      past: [past('x', '/h/code/app-gone', '2026-10-18T00:00:00Z'), past('y', '/h/code/app', '2026-10-17T00:00:00Z', { git_branch: 'main' })],
      projects,
      home: '/h',
    })
    expect(choices.map((c) => [c.name, c.root, c.dirs.map((d) => d.label), c.recentProfile])).toEqual([
      ['app', '/h/code/app', ['~/code/app', '~/code/app-feat'], 'work'],
      ['notes', '/h/notes', ['~/notes'], 'default'],
    ])
    expect(choices[0]!.dirs[1]!.branch).toBe('feat')
    expect(projectKeyOf('/h/code/app-feat', projects['/h/code/app-feat'])).toBe('git:/h/code/app/.git')
  })

  it('profil par défaut : réglage du projet, sinon dernier utilisé, sinon « default »', () => {
    const profiles = ['default', 'work']
    expect(resolveDefaultProfile({ projectRoot: '/p', projectProfiles: { '/p': 'work' }, profiles, recent: 'default' })).toEqual({
      profile: 'work',
      source: 'project',
    })
    expect(resolveDefaultProfile({ projectRoot: '/p', projectProfiles: { '/p': 'disparu' }, profiles, recent: 'work' })).toEqual({
      profile: 'work',
      source: 'recent',
    })
    expect(resolveDefaultProfile({ projectRoot: null, projectProfiles: {}, profiles, recent: null })).toEqual({
      profile: 'default',
      source: 'global',
    })
    expect(resolveDefaultProfile({ projectRoot: '/p', projectProfiles: {}, profiles: ['work'], recent: 'x' }).profile).toBe('work')
  })

  it('sessions à reprendre : arrêtées reprenables et anciennes au dossier existant, du projet seulement', () => {
    const stopped = session({ cwd: '/h/code/app', alive: false, resumable: true, resume_blocker: null, last_activity: '2026-10-20T00:00:00Z' })
    const blocked = session({ cwd: '/h/code/app', alive: false, resumable: false, resume_blocker: 'transcript_missing' })
    const running = session({ cwd: '/h/code/app', alive: true })
    const list = resumeCandidates({
      projectKey: 'git:/h/code/app/.git',
      sessions: [stopped, blocked, running],
      past: [
        past('p1', '/h/code/app-feat', '2026-10-19T00:00:00Z'),
        past('p2', '/h/code/app-gone', '2026-10-21T00:00:00Z'),
        past('p3', '/h/notes', '2026-10-21T00:00:00Z'),
        past('p4', '/h/code/app', '2026-10-21T00:00:00Z', { cwd_exists: false }),
      ],
      projects,
      label: (x) => ('id' in x ? x.id.slice(0, 4) : x.claude_session_id),
    })
    expect(list.map((c) => c.key)).toEqual([`s:${stopped.id}`, 'p:p1'])
  })
})

describe('dossier déplacé ou supprimé sans dépôt retrouvé', () => {
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
  const NL = '/home/romain/workplace/next-level.run'
  const WT = `${NL}/planner/wonderful-elbakyan-3dac24`

  it('tout « planner » a disparu : groupe « planner », worktrees et dossier lui-même ensemble', () => {
    let projects: Record<string, ProjectInfo> = { [WT]: missing(WT) }
    // Le parent n'est pas encore résolu : on le demande.
    expect(ancestorToResolve(WT, projects)).toBe(`${NL}/planner`)
    projects = { ...projects, [`${NL}/planner`]: missing(`${NL}/planner`) }
    expect(ancestorToResolve(WT, projects)).toBe(NL)
    projects = { ...projects, [NL]: present(NL), [`${NL}/planner/autre`]: missing(`${NL}/planner/autre`) }
    expect(ancestorToResolve(WT, projects)).toBeNull()
    expect(missingGroupDir(WT, projects)).toBe(`${NL}/planner`)
    const groups = groupPast(
      [
        past('a', WT, '2026-10-19T10:00:00Z'),
        past('b', `${NL}/planner`, '2026-10-18T10:00:00Z'),
        past('c', `${NL}/planner/autre`, '2026-10-17T10:00:00Z'),
      ],
      projects,
      '/home/romain',
    )
    expect(groups.map((g) => [g.key, g.name, g.root, g.missing, g.entries.map((e) => e.claude_session_id)])).toEqual([
      [`dossier:${NL}/planner`, 'planner', `${NL}/planner`, true, ['a', 'b', 'c']],
    ])
    // Sessions courantes : même règle.
    const live = groupByProject([session({ cwd: WT, project_root: null }), session({ cwd: `${NL}/planner`, project_root: null })], projects, '/home/romain')
    expect(live.map((g) => [g.name, g.missing, g.sessions.length])).toEqual([['planner', true, 2]])
  })

  it('seule la feuille a disparu : le groupe reste la feuille', () => {
    const projects = { [WT]: missing(WT), [`${NL}/planner`]: present(`${NL}/planner`) }
    expect(ancestorToResolve(WT, projects)).toBeNull()
    expect(missingGroupDir(WT, projects)).toBe(WT)
    const [g] = groupPast([past('a', WT, '2026-10-19T10:00:00Z')], projects, '/home/romain')
    expect(g).toMatchObject({ key: `dossier:${WT}`, name: 'wonderful-elbakyan-3dac24', missing: true })
  })

  it('dépôt retrouvé ou ancêtre retenu par le démon : règle inchangée', () => {
    const inferred: ProjectInfo = { ...missing(WT), is_git: true, root: `${NL}/app`, common_dir: `${NL}/app/.git`, name: 'app', inferred: true }
    expect(missingGroupDir(WT, { [WT]: inferred })).toBeNull()
    const kept: ProjectInfo = { ...missing(WT), root: NL, inferred: true }
    expect(missingGroupDir(WT, { [WT]: kept })).toBeNull()
    expect(missingGroupDir('/existe', { '/existe': present('/existe') })).toBeNull()
  })
})

describe('revue du lot 5', () => {
  it('« Autre dossier… » dans un dépôt connu : le dossier rejoint ce dépôt, un projet nouveau passe en tête', () => {
    const base = {
      name: 'app',
      root: '/h/app',
      profileKey: '/h/app',
      isGit: true,
      latest: 1,
      recentProfile: null,
    }
    const known = [
      { ...base, key: 'git:/h/app/.git', dirs: [{ path: '/h/app', label: '~/app', branch: 'main' }] },
      { ...base, key: 'dossier:/h/notes', name: 'notes', root: '/h/notes', profileKey: '/h/notes', isGit: false, dirs: [{ path: '/h/notes', label: '~/notes', branch: null }] },
    ]
    const wt = { ...base, key: 'git:/h/app/.git', dirs: [{ path: '/h/app-wt', label: '~/app-wt', branch: 'feat' }] }
    const other = { ...base, key: 'dossier:/tmp/x', name: 'x', root: '/tmp/x', profileKey: '/tmp/x', isGit: false, dirs: [{ path: '/tmp/x', label: '/tmp/x', branch: null }] }
    const merged = mergeExtraChoices(known, [wt, wt, other])
    expect(merged.map((c) => [c.key, c.dirs.map((d) => d.path)])).toEqual([
      ['dossier:/tmp/x', ['/tmp/x']],
      ['git:/h/app/.git', ['/h/app', '/h/app-wt']],
      ['dossier:/h/notes', ['/h/notes']],
    ])
    expect(known[0]!.dirs).toHaveLength(1) // pas de mutation
  })

  it('profil par défaut : même clé depuis le dépôt principal ou un worktree', () => {
    const main = info('/h/code/app', '/h/code/app')
    const wt = info('/h/code/app-feat', '/h/code/app-feat', { common_dir: '/h/code/app/.git' })
    expect(profileKeyOf('/h/code/app', main)).toBe('/h/code/app')
    expect(profileKeyOf('/h/code/app-feat', wt)).toBe('/h/code/app')
    expect(profileKeyOf('/h/notes', undefined)).toBe('/h/notes')
    const choices = buildProjectChoices({
      sessions: [session({ cwd: '/h/code/app-feat', last_activity: '2026-10-20T00:00:00Z' })],
      past: [],
      projects: { '/h/code/app-feat': wt },
      home: '/h',
    })
    expect(choices[0]!.profileKey).toBe('/h/code/app')
  })

  it('notification : rien pour une demande close pendant l’attente du titre', () => {
    const d = new NotifyDecider()
    expect(d.decide('a', 1, ctx()).action).toBe('show')
    expect(d.stillExpected('a', 1)).toBe(true)
    d.resolved('a', 1)
    expect(d.stillExpected('a', 1)).toBe(false)
    d.decide('a', 2, ctx())
    d.decide('a', 3, ctx()) // remplacée avant d'être montrée
    expect(d.stillExpected('a', 2)).toBe(false)
    expect(d.stillExpected('a', 3)).toBe(true)
  })

  it('notification : texte assaini (contrôles, bidi, balisage de libnotify)', () => {
    const c = notificationContent(session({ display_name: 'Nom‮<b>x</b>', cwd: '/c/p', project_root: '/c/p' }), {
      kind: 'question',
      tool_name: 'AskUserQuestion',
      tool_input: {},
      questions: [{ question: 'A\u0007 & <i>B</i>​⁦ ?\n\nsuite', options: [] }],
    })
    expect(c.title).toBe('Nom &lt;b&gt;x&lt;/b&gt; · p')
    expect(c.body).toBe('Question : A &amp; &lt;i&gt;B&lt;/i&gt; ? suite')
    expect(sanitizeNotificationText('a'.repeat(10), 5)).toBe('aaaa…')
  })
})

describe('réglages sur disque : erreurs et fermeture', () => {
  let dir: string
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('un échec d’écriture remonte à l’appelant sans bloquer les écritures suivantes', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'dm-settings-'))
    const logs: string[] = []
    const st = new SettingsStore(dir, (m) => logs.push(m))
    await st.load()
    const w = st as unknown as { write: (s: unknown) => Promise<void> }
    const real = w.write.bind(st)
    let fail = true
    w.write = async (s) => {
      if (fail) {
        fail = false
        throw new Error('disque plein')
      }
      return real(s)
    }
    await expect(st.update({ confirmRemoval: false })).rejects.toThrow('disque plein')
    expect(st.settings.confirmRemoval).toBe(false) // gardé en mémoire
    expect(logs.some((l) => l.includes('disque plein'))).toBe(true)
    await st.update({ notifications: { enabled: false } })
    const disk = JSON.parse(readFileSync(path.join(dir, 'settings.json'), 'utf8'))
    expect(disk.confirmRemoval).toBe(false)
    expect(disk.notifications.enabled).toBe(false)
  })

  it('fermeture : une modification envoyée sans attendre est écrite avant de quitter', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'dm-settings-'))
    const st = new SettingsStore(dir)
    await st.load()
    // Comme le message de fermeture de la page : on n'attend pas `update`…
    void st.update({ theme: { mode: 'dark', dark: { palette: 'okabe', custom: {} } } })
    expect(st.pending).toBe(true)
    // … puis `before-quit` attend la fin des écritures.
    await st.flush()
    expect(st.pending).toBe(false)
    expect(JSON.parse(readFileSync(path.join(dir, 'settings.json'), 'utf8')).theme.dark.palette).toBe('okabe')
    // `flush` ne rejette jamais, même après un échec.
    const w = st as unknown as { write: (s: unknown) => Promise<void> }
    w.write = async () => {
      throw new Error('non')
    }
    void st.update({ confirmRemoval: false }).catch(() => undefined)
    await expect(st.flush()).resolves.toBeUndefined()
  })
})
