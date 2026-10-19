/**
 * Intégration du client du processus principal avec le vrai `orchd` et le
 * faux `claude` (`cargo build -p devmaestro-core --features test-support` à la
 * racine). Aucune fenêtre : `DaemonClient` et `TerminalRelay` n'importent pas
 * Electron. Dossiers XDG et `HOME` temporaires, socket dans `/tmp` (sun_path).
 *
 * Ignoré (avec un avertissement) si les binaires sont absents.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { PortDown } from '../src/shared/bridge'
import type { Session } from '../src/shared/protocol'
import { DaemonClient } from '../src/main/daemon/client'
import { TerminalRelay } from '../src/main/daemon/relay'
import type { RpcNotification } from '../src/main/daemon/rpc'
import { spawnDaemon } from '../src/main/daemon/spawn'

const ROOT = path.resolve(__dirname, '../..')
const ORCHD = process.env.DEVMAESTRO_ORCHD_BIN ?? path.join(ROOT, 'target/debug/orchd')
const FAKE = path.join(ROOT, 'target/debug/devmaestro-fake-claude')
const available = existsSync(ORCHD) && existsSync(FAKE)
if (!available) console.warn(`[intégration] ignorée : ${ORCHD} ou ${FAKE} absent (cargo build --features test-support)`)

async function waitFor<T>(what: string, f: () => T | undefined | null | false, timeoutMs = 10_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = f()
    if (v) return v
    if (Date.now() - start > timeoutMs) throw new Error(`délai dépassé : ${what}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe.skipIf(!available)('client du démon contre le vrai orchd', () => {
  let tmp: string
  let run: string
  let client: DaemonClient
  let relay: TerminalRelay
  // Pids des démons lancés (connus dès le lancement, même si `beforeAll` échoue ensuite).
  const spawned: number[] = []
  const notes: RpcNotification[] = []
  const port: PortDown[] = []
  let screen = ''
  const decoder = new TextDecoder()
  let session: Session

  const latest = (id: string): Session | undefined =>
    notes
      .filter((n) => n.method === 'session.updated' && (n.params as { session: Session }).session.id === id)
      .map((n) => (n.params as { session: Session }).session)
      .at(-1)

  beforeAll(async () => {
    tmp = realpathSync(mkdtempSync('/tmp/dm-app-'))
    run = mkdtempSync('/tmp/dmr')
    const home = path.join(tmp, 'home')
    mkdirSync(path.join(home, '.claude'), { recursive: true })
    writeFileSync(path.join(home, '.claude/settings.json'), '{}')
    mkdirSync(path.join(tmp, 'projet'))
    const env = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: home,
      XDG_RUNTIME_DIR: run,
      XDG_DATA_HOME: path.join(tmp, 'data'),
      XDG_STATE_HOME: path.join(tmp, 'state'),
      XDG_CONFIG_HOME: path.join(tmp, 'config'),
      DEVMAESTRO_CLAUDE_BIN: FAKE,
      FAKE_CLAUDE_LOG: path.join(tmp, 'fake.log'),
    }
    client = new DaemonClient({
      socketPath: path.join(run, 'devmaestro/orchd.sock'),
      clientName: 'test-integration',
      // Le démon est absent : le client le lance, détaché (chemin réel de l'app).
      startDaemon: () => {
        const o = spawnDaemon(ORCHD, env)
        if (o.pid) spawned.push(o.pid)
        return o
      },
      backoffInitialMs: 50,
      backoffMaxMs: 300,
    })
    relay = new TerminalRelay(client, { minBatchBytes: 1024, maxDelayMs: 16 })
    relay.setSink({
      post: (m) => {
        port.push(m)
        if (m.t === 'data') screen += decoder.decode(m.bytes, { stream: true })
        if (m.t === 'reset') screen += m.snapshot.text
      },
    })
    client.on('notification', (n) => {
      notes.push(n)
      relay.onNotification(n)
    })
    client.on('pty', (id, d) => relay.onPty(id, d))
    client.on('connected', () => relay.onConnected())
    client.start()
    const hello = await client.waitConnected(15_000)
    if (!spawned.includes(hello.pid)) spawned.push(hello.pid)
    expect(hello.server).toBe('orchd')
    expect(hello.protocol).toBe(1)
  }, 30_000)

  afterAll(async () => {
    client?.stop()
    for (const pid of spawned) {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        continue // déjà sorti
      }
      try {
        await waitFor('arrêt du démon', () => {
          try {
            process.kill(pid, 0)
            return false
          } catch {
            return true
          }
        }, 8_000)
      } catch {
        process.kill(pid, 'SIGKILL')
      }
    }
    if (tmp) rmSync(tmp, { recursive: true, force: true })
    if (run) rmSync(run, { recursive: true, force: true })
  }, 20_000)

  it('lance une session et reçoit ses mises à jour', async () => {
    const profiles = await client.request<{ profiles: { name: string }[] }>('profiles.list')
    expect(profiles.profiles.map((p) => p.name)).toContain('default')
    const r = await client.request<{ session: Session }>('sessions.launch', {
      cwd: path.join(tmp, 'projet'),
      cols: 100,
      rows: 30,
    })
    session = r.session
    expect(session.id).toMatch(/^[0-9a-f-]{36}$/)
    const s = await waitFor('session active', () => {
      const l = latest(session.id)
      return l && ['running', 'idle'].includes(l.status.state) && l
    })
    expect(s.alive).toBe(true)
  })

  it('abonnement : instantané puis flux ; écho des touches (trames 0x03)', async () => {
    await relay.view({ id: session.id, cols: 100, rows: 30 })
    const reset = port.find((m) => m.t === 'reset')
    expect(reset).toMatchObject({ t: 'reset', id: session.id, reason: 'subscribe' })
    expect(reset && reset.t === 'reset' && reset.snapshot.cols).toBe(100)
    relay.input(session.id, new TextEncoder().encode('bonjour-écho'))
    await waitFor('écho', () => screen.includes('bonjour-écho'))
    expect(port.filter((m) => m.t === 'data').every((m) => m.t === 'data' && m.id === session.id)).toBe(true)
    // Efface la ligne tapée (Ctrl+U n'est pas géré : on finit le tour).
    relay.input(session.id, new TextEncoder().encode('\r'))
    await waitFor('fin du tour', () => latest(session.id)?.status.state === 'idle' && screen.includes('Réponse à'), 15_000)
  })

  it('permission bloquante : « Toujours » depuis l’app', async () => {
    relay.input(session.id, new TextEncoder().encode('/perm Bash\r'))
    const s = await waitFor('permission en attente', () => {
      const l = latest(session.id)
      return l?.status.state === 'waiting' && l.pending.find((p) => p.pending.kind === 'permission' && p.answerable) && l
    })
    const req = s.pending.find((p) => p.pending.kind === 'permission')!
    expect(req.pending).toMatchObject({ kind: 'permission', tool_name: 'Bash' })
    const d = req.pending as { always_rules?: unknown[]; suggestions?: unknown[] }
    expect(d.suggestions?.length).toBe(2)
    expect(d.always_rules?.length).toBe(1)
    await client.request('sessions.answerPermission', {
      id: session.id,
      request_id: req.request_id,
      decision: 'allow_always',
    })
    await waitFor('autorisé par l’app', () => screen.includes('autorisé par l\'app (règles ajoutées : 1)'))
    await waitFor('demande résolue', () => latest(session.id)?.pending.length === 0)
    expect(
      notes.some(
        (n) =>
          n.method === 'session.effect' &&
          (n.params as { effect: { type: string } }).effect.type === 'request_resolved',
      ),
    ).toBe(true)
  })

  it('question : réponses depuis l’app', async () => {
    relay.input(session.id, new TextEncoder().encode('/ask\r'))
    const s = await waitFor('question en attente', () => {
      const l = latest(session.id)
      return l?.status.state === 'waiting' && l.pending.find((p) => p.pending.kind === 'question' && p.answerable) && l
    })
    const req = s.pending.find((p) => p.pending.kind === 'question')!
    expect('questions' in req.pending && req.pending.questions.map((q) => q.multi_select)).toEqual([false, true])
    await client.request('sessions.answerQuestion', {
      id: session.id,
      request_id: req.request_id,
      answers: { 'Tu préfères A ou B ?': 'B', 'Quelles couleurs ?': ['Rouge', 'Vert'] },
    })
    await waitFor('réponses reçues', () => screen.includes('Réponses (app)'))
  })

  it('changement de mode : Shift+Tab envoyés, mode confirmé par le hook suivant', async () => {
    await waitFor('session inactive', () => latest(session.id)?.status.state === 'idle')
    const before = latest(session.id)!.mode
    expect(before === 'default' || before === 'manual').toBe(true)
    const r = await client.request<{ sent: number }>('sessions.setMode', { id: session.id, mode: 'plan' })
    expect(r.sent).toBe(2) // default → acceptEdits → plan
    // La confirmation vient du `permission_mode` du hook suivant : un tour suffit.
    relay.input(session.id, new TextEncoder().encode('/perm Read\r'))
    await waitFor('mode plan confirmé', () => latest(session.id)?.mode === 'plan')
    const s = await waitFor('permission en attente', () => {
      const l = latest(session.id)
      return l?.pending.find((p) => p.answerable) && l
    })
    await client.request('sessions.answerPermission', {
      id: session.id,
      request_id: s.pending[0]!.request_id,
      decision: 'deny',
      message: 'pas maintenant',
    })
    await waitFor('refus affiché', () => screen.includes('refusé par l\'app : pas maintenant'))
  })

  it('arrêt : alive passe à faux', async () => {
    await client.request('sessions.stop', { id: session.id })
    await waitFor('session arrêtée', () => latest(session.id)?.alive === false, 10_000)
  })
})
