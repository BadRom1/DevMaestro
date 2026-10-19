// Front du banc d'essai : terminaux xterm.js alimentés par les sessions simulées du Rust,
// collecte des mesures brutes (images, écho, file d'écriture, changements de session, octets reçus).
// Les statistiques, la validité et le rapport sont calculés côté Rust (crate bench-core).
// Deux transports : IPC Tauri (webview WebKitGTK) ou WebSocket (mode web, `?transport=ws`).

import { Channel, invoke } from '@tauri-apps/api/core'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import './style.css'

declare const __XTERM_VERSION__: string

type Renderer = 'dom' | 'webgl'

interface Config {
  bench: boolean
  pty: boolean
  quick: boolean
  /** Vrai : les 10 sessions traversent l'IPC (prudent). Faux : seules les affichées (réaliste). */
  hiddenIpc: boolean
  sessions: number
  rateBytesPerS: number
  batchMs: number
  scenarioS: number
  warmupS: number
  repeat: number
  scenarios: string[]
  renderers: Renderer[]
  burstBytes: number
  historyBytes: number
  outDir: string
  timeoutS: number
}

const BURST_AT_MS = 5_000 // après le début de la mesure
const TYPE_EVERY_MS = 200 // frappe simulée
const SWITCH_EVERY_MS = 500 // S3
const IDLE_MS = 3_000 // référence au repos
const GRACE_MS = 2_000 // après la fenêtre : échos et octets encore en vol
const SMALL_MESSAGE = 1024 // seuil Tauri : eval (< 1024 o) ou fetch
// Boîte fixe des terminaux (px CSS) : mêmes colonnes×lignes quel que soit le moteur ou la fenêtre.
const BOX_W = 1200
const BOX_H = 760

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const statusEl = $<HTMLSpanElement>('status')
const container = $<HTMLElement>('terms')
container.style.width = `${BOX_W}px`
container.style.height = `${BOX_H}px`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const setStatus = (s: string) => (statusEl.textContent = s)
const log = (msg: string) => void tx?.invoke('log', { msg }).catch(() => {})

// ---------- Transport : IPC Tauri ou WebSocket, choisi au démarrage ----------

interface Transport {
  invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>
  /** Branche le flux d'une session ; `onData` reçoit les octets bruts. */
  openSession(id: number, onData: (chunk: Uint8Array) => void): Promise<void>
}

function tauriTransport(): Transport {
  return {
    invoke: (cmd, args) => invoke(cmd, args),
    async openSession(id, onData) {
      const ch = new Channel<ArrayBuffer>()
      ch.onmessage = (buf) => onData(new Uint8Array(buf))
      await invoke('open_session', { id, channel: ch })
    },
  }
}

/** Trames binaires : un octet de session puis les octets ; trames texte : `{id, cmd, args}` ↔ `{id, ok, result | error}`. */
async function wsTransport(): Promise<Transport> {
  const ws = new WebSocket(`ws://${location.host}/ws`)
  ws.binaryType = 'arraybuffer'
  const pendingCalls = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  const sessions: ((chunk: Uint8Array) => void)[] = []
  let nextId = 0
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') {
      let r: { id: number | null; ok: boolean; result?: unknown; error?: string } | undefined
      try {
        r = JSON.parse(ev.data)
      } catch {
        r = undefined
      }
      const p = r?.id != null ? pendingCalls.get(r.id) : undefined
      if (!r || !p) {
        // Erreur de protocole : plus aucune réponse n'est fiable, on rejette tout ce qui attend.
        const why = new Error(`protocole WebSocket : ${r?.error ?? 'réponse illisible ou inattendue'}`)
        for (const q of pendingCalls.values()) q.reject(why)
        pendingCalls.clear()
        log(why.message)
        return
      }
      pendingCalls.delete(r.id!)
      if (r.ok) p.resolve(r.result)
      else p.reject(new Error(r.error ?? 'erreur'))
    } else {
      const u = new Uint8Array(ev.data as ArrayBuffer)
      sessions[u[0]]?.(u.subarray(1))
    }
  }
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error(`WebSocket injoignable : ${ws.url}`))
  })
  ws.onclose = () => {
    for (const p of pendingCalls.values()) p.reject(new Error('connexion WebSocket fermée'))
    pendingCalls.clear()
    setStatus('Connexion au banc perdue.')
  }
  const call = <T>(cmd: string, args: Record<string, unknown> = {}) =>
    new Promise<T>((resolve, reject) => {
      const id = ++nextId
      pendingCalls.set(id, { resolve: resolve as (v: unknown) => void, reject })
      ws.send(JSON.stringify({ id, cmd, args }))
    })
  return {
    invoke: call,
    async openSession(id, onData) {
      sessions[id] = onData
      await call('open_session', { id })
    },
  }
}

const useWs = new URLSearchParams(location.search).get('transport') === 'ws' || !('__TAURI_INTERNALS__' in window)
let tx!: Transport

// ---------- Tampon circulaire par session (les sessions non affichées n'ont que lui) ----------

class Ring {
  private chunks: Uint8Array[] = []
  private size = 0
  constructor(private cap: number) {}

  push(c: Uint8Array) {
    this.chunks.push(c)
    this.size += c.length
    while (this.chunks.length > 1 && this.size - this.chunks[0].length >= this.cap) {
      this.size -= this.chunks.shift()!.length
    }
  }

  /** Les `cap` derniers octets, d'un seul tenant. */
  snapshot(): Uint8Array {
    const all = new Uint8Array(this.size)
    let off = 0
    for (const c of this.chunks) {
      all.set(c, off)
      off += c.length
    }
    return this.size > this.cap ? all.subarray(this.size - this.cap) : all
  }
}

// ---------- Mesures du passage en cours ----------

interface Burst {
  id: number
  bytes: number
  t0: number
  receivedAt?: number
  drainedAt?: number
  queueMax: number
}

class Metrics {
  /** Fenêtre de mesure : images, file, octets, envois de frappe. */
  recording = false
  /** Les échos envoyés pendant la fenêtre sont encore attendus (jusqu'à la fin du délai de grâce). */
  echoOpen = false
  /** S0 : pas de terminal, l'écho est mesuré à la réception. */
  echoAtReceipt = false
  hidden = false
  start = 0
  frames: number[] = []
  echo: number[] = []
  echoSent = 0
  echoDropped = 0
  queue: [number, number][] = []
  queueMax = 0
  switchMs: number[] = []
  switchSkipped = 0
  bytesWritten = 0
  bytesAcked = 0
  ipcMessages = 0
  ipcSmall = 0
  burst?: Burst
}

interface View {
  session: number
  term: Terminal
  fit: FitAddon
  el: HTMLElement
  written: number
  acked: number
  webgl?: string
}

let cfg: Config
let m = new Metrics()
let rings: Ring[] = []
/** Octets reçus par session depuis le démarrage (flux ordonné : sert au contrôle d'intégrité). */
let received: number[] = []
let views: View[] = []
const viewOf = new Map<number, View>()
const echoT0 = new Map<number, { t0: number; session: number }>()
let echoCounter = 0
let burstCounter = 0
let switching = false
/** Mode réaliste : changement en cours, terminé quand le marqueur `⟦h<id>⟧` est affiché. */
let remoteSwitch: { id: number; t0: number } | undefined
let switchCounter = 0
let idleSink: number[] | null = null
let scenarioLabel = ''
const notes: string[] = []
const errors: string[] = []

const pending = () => views.reduce((n, v) => n + v.written - v.acked, 0)
const afterFrame = (fn: (t: number) => void) => requestAnimationFrame(() => fn(performance.now()))

function noteQueue() {
  const q = pending()
  if (m.recording) m.queueMax = Math.max(m.queueMax, q)
  if (m.burst && m.burst.drainedAt === undefined) m.burst.queueMax = Math.max(m.burst.queueMax, q)
}

// Boucle d'images : intervalles entre deux requestAnimationFrame + profondeur de la file de xterm.
let lastFrame = 0
function frame(t: number) {
  if (lastFrame) {
    const dt = t - lastFrame
    if (m.recording) m.frames.push(dt)
    idleSink?.push(dt)
  }
  lastFrame = t
  if (m.recording) m.queue.push([t - m.start, pending()])
  noteQueue()
  requestAnimationFrame(frame)
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && m.recording) {
    m.hidden = true
    notes.push(`Fenêtre cachée pendant ${scenarioLabel} : passage invalide (WebKit ralentit les fenêtres cachées).`)
  }
})

// ---------- Écriture dans xterm, avec suivi de la file et des marqueurs ----------

const MARK_START = [0xe2, 0x9f, 0xa6] // « ⟦ » en UTF-8
const decoder = new TextDecoder()
type Marker = { kind: string; id: number }

function findMarkers(c: Uint8Array): Marker[] {
  let found = false
  for (let i = c.indexOf(MARK_START[0]); i >= 0 && i < c.length - 2; i = c.indexOf(MARK_START[0], i + 1)) {
    if (c[i + 1] === MARK_START[1] && c[i + 2] === MARK_START[2]) {
      found = true
      break
    }
  }
  if (!found) return []
  return [...decoder.decode(c).matchAll(/⟦([kbh])(\d+)⟧/g)].map((x) => ({ kind: x[1], id: Number(x[2]) }))
}

function writeTracked(v: View, data: Uint8Array | string, done?: () => void) {
  const n = data.length
  const mm = m
  const rec = m.recording
  v.written += n
  if (rec) mm.bytesWritten += n
  noteQueue() // le pic de la file se voit ici, même si les images sont gelées
  v.term.write(data, () => {
    v.acked += n
    if (rec && mm === m) mm.bytesAcked += n
    done?.()
  })
}

function writeLive(v: View, chunk: Uint8Array) {
  const markers = findMarkers(chunk)
  const now = performance.now()
  for (const k of markers) if (k.kind === 'b' && m.burst?.id === k.id) m.burst.receivedAt = now
  writeTracked(v, chunk, markers.length ? () => afterFrame((t) => onMarkersShown(markers, t)) : undefined)
}

function onMarkersShown(markers: Marker[], t: number) {
  for (const k of markers) {
    if (k.kind === 'k') recordEcho(k.id, t)
    else if (k.kind === 'h') {
      if (remoteSwitch?.id === k.id) {
        if (m.recording) m.switchMs.push(t - remoteSwitch.t0)
        remoteSwitch = undefined
        switching = false
      }
    } else if (m.burst?.id === k.id) m.burst.drainedAt = t
  }
}

function recordEcho(id: number, t: number) {
  const e = echoT0.get(id)
  if (!e) return
  echoT0.delete(id)
  if (m.echoOpen) m.echo.push(t - e.t0)
}

function onData(session: number, chunk: Uint8Array) {
  received[session] += chunk.length
  if (m.recording) {
    m.ipcMessages++
    if (chunk.length < SMALL_MESSAGE) m.ipcSmall++
  }
  rings[session].push(chunk)
  const v = viewOf.get(session)
  if (v) writeLive(v, chunk)
  else if (m.echoAtReceipt) {
    const now = performance.now()
    for (const k of findMarkers(chunk)) if (k.kind === 'k') recordEcho(k.id, now)
  }
}

// ---------- Terminaux ----------

function disposeViews() {
  for (const v of views) v.term.dispose()
  views = []
  viewOf.clear()
  container.replaceChildren()
}

function buildLayout(sessions: number[], renderer: Renderer): View[] {
  disposeViews()
  container.className = sessions.length > 1 ? 'grid' : 'single'
  for (const session of sessions) {
    const el = document.createElement('div')
    el.className = 'cell'
    container.append(el)
    const term = new Terminal({
      scrollback: 5000,
      fontSize: sessions.length > 1 ? 11 : 13,
      fontFamily: 'monospace',
      theme: { background: '#1e1e2e', foreground: '#cdd6f4' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    fit.fit()
    const v: View = { session, term, fit, el, written: 0, acked: 0 }
    if (renderer === 'webgl') v.webgl = loadWebgl(v)
    if (cfg.pty && !cfg.bench && session === 0) {
      term.onData((data) => void tx.invoke('pty_write', { data }))
      term.onResize(({ cols, rows }) => void tx.invoke('pty_resize', { cols, rows }))
      void tx.invoke('pty_resize', { cols: term.cols, rows: term.rows })
    }
    views.push(v)
    viewOf.set(session, v)
  }
  return views
}

function loadWebgl(v: View): string {
  try {
    const addon = new WebglAddon()
    addon.onContextLoss(() => {
      v.webgl = `contexte perdu à ${((performance.now() - m.start) / 1000).toFixed(1)} s`
      log(`WebGL : ${v.webgl}`)
      addon.dispose()
    })
    v.term.loadAddon(addon)
    return 'ok'
  } catch (e) {
    log(`WebGL indisponible : ${e}`)
    return `échec : ${e}`
  }
}

function webglStatus(): string | undefined {
  const s = views.map((v) => v.webgl).filter((x): x is string => !!x)
  if (!s.length) return undefined
  const bad = s.filter((x) => x !== 'ok')
  return bad.length ? `${bad[0]} (${bad.length}/${s.length} terminaux)` : 'ok'
}

// ---------- Actions ----------

function typeKey(session: number) {
  const id = ++echoCounter
  echoT0.set(id, { t0: performance.now(), session })
  if (m.recording) m.echoSent++
  void tx.invoke('echo', { session, id })
}

/** Les échos en vol vers une session qu'on quitte ne seront jamais affichés : comptés à part. */
function dropEchoes(session: number) {
  for (const [id, e] of echoT0) {
    if (e.session === session) {
      echoT0.delete(id)
      m.echoDropped++
    }
  }
}

function startBurst(session: number) {
  const id = ++burstCounter
  m.burst = { id, bytes: cfg.burstBytes, t0: performance.now(), queueMax: 0 }
  void tx.invoke('burst', { session, id })
}

/** Affiche une autre session dans la vue : RIS dans la file de xterm, puis rejeu de l'historique. */
function switchTo(v: View, next: number) {
  switching = true
  const t0 = performance.now()
  if (!cfg.hiddenIpc) return switchRemote(v, next, t0)
  dropEchoes(v.session)
  viewOf.delete(v.session)
  v.session = next
  viewOf.set(next, v)
  const history = rings[next].snapshot()
  writeTracked(v, '\x1bc')
  writeTracked(v, history, () =>
    afterFrame((t) => {
      if (m.recording) m.switchMs.push(t - t0)
      switching = false
    }),
  )
}

/**
 * Mode réaliste : la session cible ne traversait pas l'IPC. Le Rust envoie son historique (1 Mo,
 * chemin `fetch`), son premier lot direct puis `⟦h<id>⟧` ; on mesure jusqu'à l'image qui suit.
 */
function switchRemote(v: View, next: number, t0: number) {
  dropEchoes(v.session)
  const from = v.session
  viewOf.delete(from)
  v.session = next
  viewOf.set(next, v)
  writeTracked(v, '\x1bc')
  const id = ++switchCounter
  remoteSwitch = { id, t0 }
  void tx.invoke('switch_stream', { from, to: next, id })
}

// ---------- Mode banc d'essai ----------

async function recordIdle(): Promise<number[]> {
  buildLayout([0], 'dom')
  const sink: number[] = []
  idleSink = sink
  await sleep(IDLE_MS)
  idleSink = null
  return sink
}

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0)

async function runScenario(id: string, renderer: Renderer | 'none', round: number) {
  const label = renderer === 'webgl' ? 'WebGL' : renderer === 'dom' ? 'DOM' : 'témoin sans terminal'
  const mode = cfg.hiddenIpc ? 'prudent' : 'réaliste'
  scenarioLabel = `${id} · ${label} · passage ${round + 1}/${cfg.repeat}`
  m = new Metrics()
  echoT0.clear()
  switching = false
  remoteSwitch = undefined
  const timers: number[] = []
  const t0 = performance.now()
  const total = cfg.warmupS + cfg.scenarioS
  const tick = () => {
    const s = (performance.now() - t0) / 1000
    const phase = s < cfg.warmupS ? ' (échauffement)' : s > total ? ' (fin)' : ''
    setStatus(`${scenarioLabel} · ${mode} · ${Math.min(s, total).toFixed(0)} s / ${total} s${phase} — banc d'essai en cours, garder la fenêtre visible`)
  }
  const statusTimer = window.setInterval(tick, 500)
  let error: string | undefined
  let start: number[] = []
  let end: number[] = []
  // Octets reçus par la page à l'envoi de mark_start / mark_end (avant toute réponse) :
  // l'intégrité ne dépend pas de l'ordre réponse / données du transport.
  let recvStart: number[] = []
  let recvEnd: number[] = []
  let deliverLag: number | null = null
  try {
    tick()
    const sessions = id === 'S0' ? [] : id === 'S4' ? rings.map((_, i) => i) : [0]
    buildLayout(sessions, renderer === 'none' ? 'dom' : renderer)
    // Mode réaliste : seules les sessions affichées (S0 : une seule) traversent l'IPC.
    await tx.invoke('set_streamed', { sessions: id === 'S0' ? [0] : sessions })
    m.echoAtReceipt = id === 'S0'
    if (id === 'S3') await tx.invoke('prefill')

    await sleep(cfg.warmupS * 1000)
    recvStart = [...received]
    start = await tx.invoke<number[]>('mark_start')
    m.recording = true
    m.echoOpen = true
    m.start = performance.now()
    const target = () => views[0]?.session ?? 0
    timers.push(window.setInterval(() => typeKey(target()), TYPE_EVERY_MS))
    if (id === 'S2') timers.push(window.setTimeout(() => startBurst(target()), BURST_AT_MS))
    if (id === 'S3') {
      let next = 1
      timers.push(
        window.setInterval(() => {
          if (switching) {
            m.switchSkipped++
            return
          }
          switchTo(views[0], next)
          next = (next + 1) % rings.length
        }, SWITCH_EVERY_MS),
      )
    }
    await sleep(cfg.scenarioS * 1000)
    m.recording = false
    timers.forEach(clearInterval)
    recvEnd = [...received]
    const tEnd = performance.now()
    end = await tx.invoke<number[]>('mark_end')
    // Délai de grâce : échos et octets de la fenêtre encore en vol.
    while (performance.now() - tEnd < GRACE_MS) {
      const allIn = end.every((b, i) => received[i] >= b)
      if (allIn && deliverLag === null) deliverLag = performance.now() - tEnd
      if (allIn && echoT0.size === 0) break
      await sleep(20)
    }
  } catch (e) {
    error = String(e)
    errors.push(`${scenarioLabel} : ${error}`)
    log(`erreur pendant ${scenarioLabel} : ${error}`)
  } finally {
    m.recording = false
    timers.forEach(clearInterval)
    clearInterval(statusTimer)
  }

  // Échos jamais vus : borne basse de leur latence.
  const tDown = performance.now()
  const lost = [...echoT0.values()].map((e) => tDown - e.t0)
  echoT0.clear()
  m.echoOpen = false
  // Reçus par la page pendant la fenêtre (à l'envoi des marques), bornés aux envoyés de la session.
  const delivered =
    end.length && start.length && recvEnd.length
      ? sum(end.map((b, i) => Math.min(Math.max(0, recvEnd[i] - recvStart[i]), Math.max(0, b - start[i]))))
      : 0
  const scr = screenInfo()

  const b = m.burst
  const rel = (t?: number) => (b && t !== undefined ? t - b.t0 : null)
  const raw = {
    scenario: id,
    renderer,
    round,
    error,
    webgl: webglStatus(),
    hidden: m.hidden,
    visibleTerminals: views.length,
    measuredMs: cfg.scenarioS * 1000,
    frameIntervalsMs: m.frames,
    echoMs: m.echo,
    echoLostMs: lost,
    echoSent: m.echoSent,
    echoDroppedOnSwitch: m.echoDropped,
    queueSamples: m.queue,
    queueMaxBytes: m.queueMax,
    burst: b && {
      bytes: b.bytes,
      receivedMs: rel(b.receivedAt),
      drainedMs: rel(b.drainedAt),
      queueDrainMs: b.receivedAt !== undefined && b.drainedAt !== undefined ? b.drainedAt - b.receivedAt : null,
      queueMaxBytes: b.queueMax,
    },
    switchMs: m.switchMs,
    switchSkipped: m.switchSkipped,
    deliveredBytes: delivered,
    deliverLagMs: deliverLag,
    bytesWritten: m.bytesWritten,
    bytesAcked: m.bytesAcked,
    ipcMessages: m.ipcMessages,
    ipcSmallMessages: m.ipcSmall,
    terminalSize: views[0] ? `${views[0].term.cols}×${views[0].term.rows}` : undefined,
    boxFits: views.length ? scr.terminalBoxFits : undefined,
    fullscreen: scr.fullscreen,
  }
  try {
    await tx.invoke('finish_scenario', { raw })
  } catch (e) {
    errors.push(`${scenarioLabel} : rapport du passage refusé : ${e}`)
  }
}

function probeGpu(): { renderer?: string; vendor?: string } {
  try {
    const gl = document.createElement('canvas').getContext('webgl2') ?? document.createElement('canvas').getContext('webgl')
    if (!gl) return { renderer: 'WebGL indisponible' }
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    return {
      renderer: String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER)),
      vendor: String(gl.getParameter(ext ? ext.UNMASKED_VENDOR_WEBGL : gl.VENDOR)),
    }
  } catch (e) {
    return { renderer: `erreur : ${e}` }
  }
}

/** Écran et fenêtre vus par la page ; la boîte des terminaux tient-elle dans la fenêtre ? */
function screenInfo() {
  const r = container.getBoundingClientRect()
  const fullscreen =
    matchMedia('(display-mode: fullscreen)').matches ||
    (window.innerWidth === screen.width && window.innerHeight === screen.height)
  return {
    screen: `${screen.width}×${screen.height} px CSS, fenêtre à (${window.screenX}, ${window.screenY})`,
    screenX: window.screenX,
    screenY: window.screenY,
    screenWidth: screen.width,
    screenHeight: screen.height,
    fullscreen,
    terminalBox: `${BOX_W}×${BOX_H} px CSS (S4 : 2 × 5 dans la même boîte)`,
    terminalBoxFits: r.right <= window.innerWidth && r.bottom <= window.innerHeight,
  }
}

async function bench() {
  try {
    const gpu = probeGpu()
    log(`GPU WebGL : ${gpu.vendor} / ${gpu.renderer}`)
    setStatus(`Référence au repos (${IDLE_MS / 1000} s) — banc d'essai en cours, garder la fenêtre visible`)
    const idle = await recordIdle()
    await tx.invoke('register_env', {
      env: {
        userAgent: navigator.userAgent,
        xtermVersion: __XTERM_VERSION__,
        webglRenderer: gpu.renderer,
        webglVendor: gpu.vendor,
        devicePixelRatio: window.devicePixelRatio,
        windowInner: `${window.innerWidth}×${window.innerHeight}`,
        idleFrameIntervalsMs: idle,
        ...screenInfo(),
      },
    })
    await tx.invoke('set_streaming', { on: true })
    const others = cfg.scenarios.filter((s) => s !== 'S0')
    for (let round = 0; round < cfg.repeat; round++) {
      // Ordre des moteurs alterné d'une répétition à l'autre.
      const order = round % 2 === 0 ? cfg.renderers : [...cfg.renderers].reverse()
      if (cfg.scenarios.includes('S0')) await runScenario('S0', 'none', round)
      for (const renderer of order) for (const id of others) await runScenario(id, renderer, round)
    }
  } catch (e) {
    errors.push(`banc : ${e}`)
    log(`erreur : ${e}`)
  }
  await tx.invoke('set_streaming', { on: false }).catch(() => {})
  disposeViews()
  setStatus('Terminé, écriture du rapport…')
  await tx.invoke('finish_bench', { notes, errors })
}

// ---------- Mode manuel ----------

function manual() {
  $('toolbar').hidden = false
  const layoutSel = $<HTMLSelectElement>('layout')
  const rendererSel = $<HTMLSelectElement>('renderer')
  const typing = $<HTMLInputElement>('typing')
  const apply = () => {
    const sessions = layoutSel.value === 'grid' ? rings.map((_, i) => i) : [0]
    buildLayout(sessions, rendererSel.value as Renderer)
    void tx.invoke('set_streamed', { sessions })
    m = new Metrics()
    m.recording = true
    m.echoOpen = true
    m.start = performance.now()
  }
  layoutSel.onchange = rendererSel.onchange = apply
  $('burst').onclick = () => startBurst(views[0].session)
  $('switch').onclick = () => !switching && switchTo(views[0], (views[0].session + 1) % rings.length)
  setInterval(() => typing.checked && !cfg.pty && typeKey(views[0].session), TYPE_EVERY_MS)
  setInterval(() => {
    const f = m.frames.slice(-120).sort((a, b) => a - b)
    const p95 = f.length ? f[Math.floor(0.95 * (f.length - 1))] : 0
    const e = m.echo.slice(-20)
    const echo = e.length ? sum(e) / e.length : 0
    const b = m.burst
    const burst = b ? ` · pic : ${b.drainedAt ? `${(b.drainedAt - b.t0).toFixed(0)} ms` : 'en cours'}` : ''
    const gl = webglStatus()
    setStatus(
      `Manuel · session ${views[0].session} · images p95 ${p95.toFixed(1)} ms · écho ${echo.toFixed(1)} ms · ` +
        `file ${(pending() / 1000).toFixed(0)} Ko${burst}${gl ? ` · WebGL ${gl}` : ''}` +
        (switching ? ' · changement…' : m.switchMs.length ? ` · changement ${m.switchMs.at(-1)!.toFixed(0)} ms` : ''),
    )
    // Garde la mémoire bornée en mode manuel.
    if (m.frames.length > 10_000) m.frames.splice(0, 5_000)
    if (m.queue.length > 10_000) m.queue.splice(0, 5_000)
    if (m.echo.length > 1_000) m.echo.splice(0, 500)
    if (echoT0.size > 1_000) echoT0.clear()
  }, 500)
  window.addEventListener('resize', () => views.forEach((v) => v.fit.fit()))
  apply()
  void tx.invoke('set_streaming', { on: true })
}

// ---------- Démarrage ----------

async function main() {
  tx = useWs ? await wsTransport() : tauriTransport()
  if (useWs) document.title = 'Prototype n° 2 — Chrome + xterm.js (mode web)'
  cfg = await tx.invoke<Config>('get_config')
  rings = Array.from({ length: cfg.sessions }, () => new Ring(cfg.historyBytes))
  received = new Array(cfg.sessions).fill(0)
  for (let i = 0; i < cfg.sessions; i++) await tx.openSession(i, (chunk) => onData(i, chunk))
  requestAnimationFrame(frame)
  if (cfg.bench) await bench()
  else manual()
}

main().catch((e) => {
  setStatus(`Erreur : ${e}`)
  log(`erreur au démarrage : ${e}`)
})
