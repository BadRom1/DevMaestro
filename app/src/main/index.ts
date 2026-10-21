/**
 * Processus principal Electron : une seule fenêtre, client du démon `orchd`,
 * relais vers la page (ADR 0004). La page n'a pas accès à Node : elle passe
 * par l'API minimale du preload et par un `MessagePort` pour le terminal.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

import {
  BrowserWindow,
  MessageChannelMain,
  Notification,
  app,
  clipboard,
  dialog,
  ipcMain,
  session,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MessagePortMain,
} from 'electron'

import { Ipc, type CallResult, type PortDown, type RpcFailure } from '../shared/bridge'
import { validHome } from '../shared/home'
import {
  ErrorCode,
  FORGE_METHODS,
  RENDERER_METHODS,
  type Demand,
  type Effect,
  type MethodName,
  type Session,
  type WorktreeInfo,
  type WorktreesList,
} from '../shared/protocol'
import { SettingsError, runnerConfirmed, stepZoom, type ZoomDirection } from '../shared/settings'
import { managedWorktreesDir, rootFromCommonDir } from '../shared/worktrees'
import { IntegratedNotifier, NotifyDecider, integratedContent, notificationContent } from './notifyLogic'
import { SettingsStore } from './settingsStore'
import { DaemonClient } from './daemon/client'
import { defaultSocketPath } from './daemon/paths'
import { TerminalRelay } from './daemon/relay'
import { RUNNER_STREAM } from './daemon/runnerStream'
import { RpcError } from './daemon/rpc'
import { resolveOrchdBin, spawnDaemon } from './daemon/spawn'
import {
  ValidationError,
  WORKTREE_TIMEOUT_MS,
  requestTimeoutMs,
  validateExternalUrl,
  validateParams,
  validateRendererError,
  validateRunnerConfirm,
  validateRunnerResize,
  validateRunnerView,
  validateView,
  validateZoomDirection,
} from './validate'
import { zoomKey } from './zoom'
import { RendererErrorLog } from './errorLog'
import { frameNavigationAllowed, mainFrameUrlAllowed } from './frameGuard'
import { checkStart, confirmRunner, type GuardDeps } from './runnerGuard'

const log = (msg: string): void => console.log(`[devmaestro] ${msg}`)

// Un seul exemplaire de l'app : un second lancement remet la fenêtre au premier plan.
if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

const dev = !app.isPackaged
const socket = defaultSocketPath()
const orchdBin = resolveOrchdBin({
  env: process.env,
  appPath: app.getAppPath(),
  packaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
})
// Lancée depuis une session DevMaestro ? Le démon refusera la connexion (contrôle du pair).
const insideSession = Boolean(process.env.ORCH_SESSION || process.env.ORCH_SOCKET || process.env.ORCH_TOKEN)

const client = new DaemonClient({
  socketPath: socket,
  clientName: `devmaestro-app ${app.getVersion()}`,
  startDaemon: () => spawnDaemon(orchdBin),
  insideSession,
  log,
})
const relay = new TerminalRelay(client, { log })
/** Terminal d'un runner (lot 14a) : second relais, second canal, une exécution affichée à la fois. */
const runnerRelay = new TerminalRelay(client, { log: (m) => log(`runner : ${m}`), methods: RUNNER_STREAM })
const settings = new SettingsStore(app.getPath('userData'), log)
const settingsLoaded = settings.load()
/** Confirmation des commandes du dépôt (lot 14a) : détection relue au démon, réglages du processus principal. */
const runnerGuard: GuardDeps = {
  request: (method, params) => client.request(method, params),
  isConfirmed: (worktree, fingerprint) => runnerConfirmed(settings.settings, worktree, fingerprint),
  remember: async (worktree, fingerprint) => {
    await settings.confirmRunner(worktree, fingerprint)
  },
}

/* ---------- Notifications desktop ---------- */

/** Dernier état connu de chaque session (titre des notifications). */
const sessionCache = new Map<string, Session>()
const decider = new NotifyDecider()
/** Notification visible par session (gardée en référence : sinon ramassée avec ses gestionnaires). */
const live = new Map<string, Notification>()

function closeNotification(id: string): void {
  const n = live.get(id)
  if (!n) return
  live.delete(id)
  n.close()
}

function focusSession(id: string): void {
  const win = mainWindow
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  toPage(Ipc.selectSession, id)
}

async function notifyWaiting(sessionId: string, requestId: number, demand: Demand): Promise<void> {
  const decision = decider.decide(sessionId, requestId, {
    enabled: settings.settings.notifications.enabled && Notification.isSupported(),
    windowFocused: mainWindow?.isFocused() ?? false,
    visibleSessionId: relay.visible,
  })
  if (decision.action === 'skip') return
  let s = sessionCache.get(sessionId) ?? null
  if (!s) {
    try {
      s = ((await client.request('sessions.get', { id: sessionId })) as { session: Session }).session
      sessionCache.set(sessionId, s)
    } catch {
      /* titre de repli */
    }
  }
  // La demande a pu être close pendant l'attente : ne jamais notifier une demande résolue.
  if (!decider.stillExpected(sessionId, requestId)) return
  if (decision.replace) closeNotification(sessionId)
  const { title, body } = notificationContent(s, demand)
  // Pas de son : les hooks de l'utilisateur (peon-ping) s'en chargent.
  const n = new Notification({ title, body, silent: true, urgency: 'normal' })
  n.on('click', () => {
    decider.dismissed(sessionId)
    live.delete(sessionId)
    focusSession(sessionId)
  })
  n.on('close', () => {
    if (live.get(sessionId) === n) {
      live.delete(sessionId)
      decider.dismissed(sessionId)
    }
  })
  live.set(sessionId, n)
  n.show()
}

/* ---------- Notification « branche intégrée » (lot 6) ---------- */

const integrated = new IntegratedNotifier()
/** Notifications « intégrée » visibles, par worktree (gardées en référence). */
const liveIntegrated = new Map<string, Notification>()
/** `worktrees.list` inconnu du démon (trop ancien) : rien à surveiller. */
let worktreesUnsupported = false

async function listWorktrees(root: string): Promise<WorktreeInfo[] | null> {
  if (worktreesUnsupported) return null
  try {
    const r = (await client.request('worktrees.list', { root }, WORKTREE_TIMEOUT_MS)) as WorktreesList
    return Array.isArray(r?.worktrees) ? r.worktrees : null
  } catch (err) {
    if (err instanceof RpcError && err.code === ErrorCode.MethodNotFound) worktreesUnsupported = true
    return null
  }
}

function showIntegrated(root: string, w: WorktreeInfo): void {
  const { title, body } = integratedContent(root, w)
  liveIntegrated.get(w.path)?.close()
  const n = new Notification({ title, body, silent: true, urgency: 'low' })
  n.on('click', () => {
    liveIntegrated.delete(w.path)
    const win = mainWindow
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    toPage(Ipc.openCleanup, { root, path: w.path })
  })
  n.on('close', () => {
    if (liveIntegrated.get(w.path) === n) liveIntegrated.delete(w.path)
  })
  liveIntegrated.set(w.path, n)
  n.show()
}

/** Worktrees d'un dépôt changés : signaler ceux qui viennent d'être intégrés. */
async function onWorktreesChanged(root: string): Promise<void> {
  const list = await listWorktrees(root)
  if (!list) return
  const enabled = settings.settings.worktrees.notifyIntegrated && Notification.isSupported()
  for (const w of integrated.changed(root, list, enabled)) showIntegrated(root, w)
}

/** Fin de session : le démon ne signale pas toujours le changement de `sessions_running`. */
const endTimers = new Map<string, ReturnType<typeof setTimeout>>()
const END_DEBOUNCE_MS = 1500

function onSessionEnded(s: Session): void {
  const root = rootFromCommonDir(s.project_common_dir)
  if (!root || worktreesUnsupported) return
  clearTimeout(endTimers.get(root))
  endTimers.set(
    root,
    setTimeout(() => {
      endTimers.delete(root)
      void onWorktreesChanged(root)
    }, END_DEBOUNCE_MS),
  )
}

/**
 * À la connexion : référence des dépôts des sessions connues, pour ne pas
 * signaler au démarrage des worktrees intégrés depuis longtemps.
 */
async function baselineWorktrees(): Promise<void> {
  worktreesUnsupported = false
  let sessions: Session[]
  try {
    sessions = ((await client.request('sessions.list', {})) as { sessions: Session[] }).sessions ?? []
  } catch {
    return
  }
  const roots = new Set<string>()
  for (const s of sessions) {
    // Racine du dépôt tirée de l'identité seulement (jamais le chemin d'un worktree lié).
    const root = rootFromCommonDir(s.project_common_dir)
    if (root) roots.add(root)
  }
  for (const root of roots) {
    if (worktreesUnsupported) return
    if (integrated.known(root)) continue
    const list = await listWorktrees(root)
    if (list && !integrated.known(root)) integrated.baseline(root, list)
  }
}

function onEffect(id: string, effect: Effect): void {
  if (effect.type === 'notify_waiting') void notifyWaiting(id, effect.request_id, effect.pending)
  else if (effect.type === 'request_resolved' && decider.resolved(id, effect.request_id)) closeNotification(id)
}

client.on('pty', (id, data) => {
  // Chaque relais ne garde que les octets de sa cible (session ou exécution de runner).
  relay.onPty(id, data)
  runnerRelay.onPty(id, data)
})
client.on('notification', (n) => {
  if (n.method === 'session.resync') {
    relay.onNotification(n)
    return
  }
  if (RUNNER_STREAM.resync.includes(n.method)) {
    runnerRelay.onNotification(n)
    return
  }
  if (n.method === 'session.updated') {
    const s = (n.params as { session?: Session }).session
    if (s?.id) {
      const prev = sessionCache.get(s.id)
      sessionCache.set(s.id, s)
      if (prev?.alive && !s.alive) onSessionEnded(s)
      if (decider.stale(s.id, s.pending.map((p) => p.request_id))) closeNotification(s.id)
    }
  } else if (n.method === 'session.effect') {
    const p = n.params as { id?: string; effect?: Effect }
    if (typeof p.id === 'string' && p.effect) onEffect(p.id, p.effect)
  } else if (n.method === 'session.removed') {
    const id = (n.params as { id?: string }).id
    if (typeof id === 'string') {
      sessionCache.delete(id)
      if (decider.stale(id, null)) closeNotification(id)
    }
  } else if (n.method === 'project.worktrees_changed') {
    const root = (n.params as { root?: unknown }).root
    if (typeof root === 'string' && root.startsWith('/')) void onWorktreesChanged(root)
  }
  if (
    n.method === 'session.updated' ||
    n.method === 'session.effect' ||
    n.method === 'session.removed' ||
    n.method === 'quotas.updated' ||
    n.method === 'session.diff_changed' ||
    n.method === 'session.subagents_changed' ||
    n.method === 'project.worktrees_changed' ||
    n.method === 'conversation.changed' ||
    n.method === 'runners.changed'
  ) {
    toPage(Ipc.notification, { method: n.method, params: n.params })
  }
})
client.on('connected', () => {
  relay.onConnected()
  runnerRelay.onConnected()
  void settingsLoaded.then(() => baselineWorktrees())
})
client.on('state', (s) => {
  if (s.state !== 'connected') {
    relay.onDisconnected()
    runnerRelay.onDisconnected()
  }
  toPage(Ipc.connectionChanged, s)
})

let mainWindow: BrowserWindow | null = null
/** Contenus de la page de la fenêtre (gardé après sa fermeture, pour les réglages envoyés en partant). */
let pageContentsId: number | null = null
let port: MessagePortMain | null = null
let runnerPort: MessagePortMain | null = null

function toPage(channel: string, payload: unknown): void {
  const wc = mainWindow?.webContents
  if (wc && !wc.isDestroyed()) wc.send(channel, payload)
}

/**
 * Taille de l'interface : zoom d'Electron (toute la page, terminal compris),
 * piloté par le réglage `ui.zoom` ; appliquée après chaque changement de
 * réglages et à chaque chargement de la page.
 */
function applyZoom(): void {
  const wc = mainWindow?.webContents
  if (!wc || wc.isDestroyed()) return
  const factor = settings.settings.ui.zoom / 100
  if (Math.abs(wc.getZoomFactor() - factor) > 1e-6) wc.setZoomFactor(factor)
}

/** Un palier de plus, de moins, ou 100 % : appliqué tout de suite, signalé à la page, puis enregistré. */
async function changeZoom(dir: ZoomDirection): Promise<number> {
  await settingsLoaded
  const next = stepZoom(settings.settings.ui.zoom, dir)
  if (next === settings.settings.ui.zoom) return next
  // `update` change la valeur en mémoire avant d'écrire le fichier.
  const saving = settings.update({ ui: { zoom: next } })
  applyZoom()
  toPage(Ipc.zoomChanged, next)
  await saving.catch((err: unknown) => log(`taille de l’interface non enregistrée : ${(err as Error).message}`))
  return next
}

/** Canal d'un relais vers la page : touches et accusés montent, écran et octets descendent. */
function openPort(win: BrowserWindow, r: TerminalRelay, channel: string): MessagePortMain {
  const { port1, port2 } = new MessageChannelMain()
  port1.on('message', (e) => {
    const m = e.data as Record<string, unknown> | null
    if (!m || typeof m !== 'object') return
    if (m.t === 'input' && typeof m.id === 'string' && m.data instanceof Uint8Array) {
      r.input(m.id, m.data)
    } else if (m.t === 'ack' && Number.isInteger(m.gen) && Number.isInteger(m.bytes)) {
      r.ack(m.gen as number, m.bytes as number)
    }
  })
  port1.start()
  r.setSink({ post: (msg: PortDown) => port1.postMessage(msg) })
  win.webContents.postMessage(channel, null, [port2])
  return port1
}

/** Nouveau canal du terminal pour la page ; l'ancien est fermé. */
function openTerminalPort(win: BrowserWindow): void {
  port?.close()
  port = openPort(win, relay, Ipc.port)
}

/** Nouveau canal du terminal des runners ; l'ancien est fermé. */
function openRunnerPort(win: BrowserWindow): void {
  runnerPort?.close()
  runnerPort = openPort(win, runnerRelay, Ipc.runnerPort)
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 560,
    show: false,
    title: 'DevMaestro',
    backgroundColor: '#0f1218',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      devTools: dev,
      zoomFactor: settings.settings.ui.zoom / 100,
    },
  })
  pageContentsId = win.webContents.id
  // Raccourcis de taille gardés ici : la page (terminal compris) et le menu par défaut ne les reçoivent pas.
  win.webContents.on('before-input-event', (e, input) => {
    const key = zoomKey(input)
    if (!key) return
    e.preventDefault()
    if (key.step) void changeZoom(key.step)
  })
  win.webContents.on('did-finish-load', () => void settingsLoaded.then(applyZoom))
  // La page refuse de se décharger (fichier modifié non enregistré, lot 7) : dialogue natif, en français.
  win.webContents.on('will-prevent-unload', (e) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      title: 'Modifications non enregistrées',
      message: 'Un fichier modifié n’est pas enregistré.',
      detail: 'Si tu quittes maintenant, tes modifications seront perdues.',
      buttons: ['Rester', 'Quitter sans enregistrer'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })
    // `preventDefault` ici ignore le refus de la page : la fenêtre se ferme (ou se recharge).
    if (choice === 1) e.preventDefault()
  })
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
    relay.setSink(null)
    runnerRelay.setSink(null)
    port?.close()
    port = null
    runnerPort?.close()
    runnerPort = null
  })
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (dev && devUrl) void win.loadURL(devUrl)
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  return win
}

/** Plateforme d'affichage effective (Wayland natif ou X11/XWayland), pour le journal. */
function logDisplayPlatform(): void {
  const env = `XDG_SESSION_TYPE=${process.env.XDG_SESSION_TYPE ?? '∅'}, WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY ?? '∅'}, DISPLAY=${process.env.DISPLAY ?? '∅'}`
  const explicit = app.commandLine.getSwitchValue('ozone-platform') || null
  // Chromium transmet la plateforme choisie à ses processus enfants (GPU) par
  // `--ozone-platform=…` : c'est le constat le plus fiable sans API dédiée.
  let fromGpu: string | null = null
  for (const m of app.getAppMetrics()) {
    if (m.type !== 'GPU') continue
    try {
      // Chromium réécrit son titre de processus : les arguments peuvent être
      // séparés par des espaces plutôt que par des octets nuls.
      const cmdline = readFileSync(`/proc/${m.pid}/cmdline`, 'utf8')
      const match = /--ozone-platform=([\w-]+)/.exec(cmdline)
      if (match) fromGpu = match[1]!
    } catch {
      /* /proc indisponible : on garde l'indice de l'environnement */
    }
  }
  log(
    `plateforme d'affichage : ${fromGpu ?? explicit ?? 'inconnue'}` +
      `${fromGpu ? ' (processus GPU)' : explicit ? ' (option --ozone-platform)' : ''} ; ${env}`,
  )
}

/** Navigation d'un cadre de `contents` : règle de `frameGuard`, journalisée quand elle refuse. */
function guardFrame(
  contents: Electron.WebContents,
  ev: { url: string; isMainFrame: boolean; frame: Electron.WebFrameMain | null; preventDefault(): void },
  what: string,
): void {
  const allowed = frameNavigationAllowed({
    url: ev.url,
    isMainFrame: ev.isMainFrame,
    hasFrame: ev.frame !== null,
    directChild: ev.frame?.parent?.frameTreeNodeId === contents.mainFrame.frameTreeNodeId,
    pageUrl: contents.getURL(),
  })
  if (allowed) return
  if (!ev.isMainFrame) log(`${what} d'un cadre refusée : ${ev.url.slice(0, 200)}`)
  ev.preventDefault()
}

/** Dernière fenêtre demandée par l'aperçu et proposée à la page (une par seconde au plus). */
let lastPopup = 0

function hardenSessions(): void {
  // Aucune permission web (caméra, notifications web, géolocalisation…) pour la page.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  app.on('web-contents-created', (_e, contents) => {
    // La page ne navigue jamais (seul le rechargement de la même adresse passe).
    contents.on('will-navigate', (ev) => {
      if (!mainFrameUrlAllowed(contents.getURL(), ev.url)) ev.preventDefault()
    })
    // Redirection serveur : comparée à l'adresse de la page pour le cadre principal seulement
    // (les 302 de l'aperçu passent), règle des cadres pour les autres.
    contents.on('will-redirect', (ev) => guardFrame(contents, ev, 'redirection'))
    contents.on('will-attach-webview', (ev) => ev.preventDefault())
    // Cadres enfants, à toute profondeur (le cadre principal est vu par `will-navigate`).
    contents.on('will-frame-navigate', (ev) => {
      if (!ev.isMainFrame) guardFrame(contents, ev, 'navigation')
    })
    // Jamais de nouvelle fenêtre Electron. La page de l'app n'en ouvre pas (ses liens passent par
    // `openExternal`) : une demande vient de l'aperçu web ; son lien http(s) est proposé à la page,
    // qui demande confirmation avant de l'ouvrir dans le navigateur.
    contents.setWindowOpenHandler((details) => {
      if (contents === mainWindow?.webContents) {
        try {
          const url = validateExternalUrl(details.url)
          const now = Date.now()
          if (now - lastPopup >= 1000) {
            lastPopup = now
            toPage(Ipc.previewPopup, url)
          }
        } catch {
          /* lien non http(s) : refusé sans rien proposer */
        }
      }
      return { action: 'deny' }
    })
  })
}

/** L'appel vient-il du cadre principal de notre fenêtre ? */
function trusted(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const wc = mainWindow?.webContents
  return !!wc && e.sender === wc && e.senderFrame === wc.mainFrame
}

const UNTRUSTED: { ok: false; error: RpcFailure } = {
  ok: false,
  error: { code: ErrorCode.InvalidRequest, message: 'appelant inconnu' },
}

function failure(err: unknown): { ok: false; error: RpcFailure } {
  if (err instanceof ValidationError) {
    return { ok: false, error: { code: ErrorCode.InvalidParams, message: `paramètres refusés par l'app : ${err.message}` } }
  }
  const r = err instanceof RpcError ? err : new RpcError(ErrorCode.Internal, (err as Error).message)
  return { ok: false, error: { code: r.code, message: r.message, ...(r.data !== undefined ? { data: r.data } : {}) } }
}

function registerIpc(): void {
  const allowed = new Set<string>(RENDERER_METHODS)
  ipcMain.handle(Ipc.call, async (e, method: unknown, params: unknown): Promise<CallResult<MethodName>> => {
    if (!trusted(e)) return UNTRUSTED
    if (typeof method !== 'string' || !allowed.has(method)) {
      return { ok: false, error: { code: ErrorCode.MethodNotFound, message: `méthode non autorisée : ${String(method)}` } }
    }
    try {
      const clean = validateParams(method as MethodName, params)
      // Réglage « Accès aux forges » : pris des réglages du processus principal, jamais de la page.
      if (FORGE_METHODS.includes(method as MethodName)) {
        await settingsLoaded
        clean.enabled = settings.settings.forges.enabled
      }
      // Commande du dépôt : lancée seulement si l'utilisateur l'a acceptée dans ce worktree (lot 14a).
      if (method === 'runners.start') {
        await settingsLoaded
        // Le démon refuse (-32024) si sa détection au lancement n'a plus cette empreinte.
        clean.expected_fingerprint = await checkStart(runnerGuard, clean.id as string, clean.runner_id as string)
      }
      const result = await client.request(method, clean, requestTimeoutMs(method as MethodName, clean))
      if (method === 'sessions.resize') relay.noteSize(clean.id as string, clean.cols as number, clean.rows as number)
      return { ok: true, result } as CallResult<MethodName>
    } catch (err) {
      return failure(err)
    }
  })
  ipcMain.handle(Ipc.view, async (e, req: unknown) => {
    if (!trusted(e)) return UNTRUSTED
    try {
      await relay.view(validateView(req))
      return { ok: true }
    } catch (err) {
      return failure(err)
    }
  })
  ipcMain.handle(Ipc.viewRunner, async (e, req: unknown) => {
    if (!trusted(e)) return UNTRUSTED
    try {
      const r = validateRunnerView(req)
      await runnerRelay.view(
        r.process_id === null ? { id: null } : { id: r.process_id, owner: r.session_id, cols: r.cols, rows: r.rows },
      )
      return { ok: true }
    } catch (err) {
      return failure(err)
    }
  })
  ipcMain.handle(Ipc.confirmRunner, async (e, req: unknown) => {
    if (!trusted(e)) return UNTRUSTED
    try {
      const r = validateRunnerConfirm(req)
      await settingsLoaded
      await confirmRunner(runnerGuard, r.session_id, r.runner_id, r.fingerprint)
      return { ok: true }
    } catch (err) {
      return failure(err)
    }
  })
  ipcMain.on(Ipc.resizeRunner, (e, req: unknown) => {
    if (!trusted(e)) return
    try {
      const r = validateRunnerResize(req)
      runnerRelay.resize(r.process_id, r.cols, r.rows)
    } catch {
      /* taille refusée : ignorée */
    }
  })
  ipcMain.on(Ipc.requestRunnerPort, (e) => {
    if (mainWindow && trusted(e)) openRunnerPort(mainWindow)
  })
  ipcMain.handle(Ipc.connection, (e) => (trusted(e) ? client.state : null))
  ipcMain.handle(Ipc.home, (e) => (trusted(e) ? validHome(homedir()) : null))
  ipcMain.handle(Ipc.worktreesDir, (e) => (trusted(e) ? managedWorktreesDir(process.env.XDG_DATA_HOME, homedir()) : null))
  ipcMain.handle(Ipc.settingsGet, async (e) => {
    if (!trusted(e)) return null
    await settingsLoaded
    return { settings: settings.settings, fresh: settings.fresh }
  })
  ipcMain.handle(Ipc.settingsSet, async (e, patch: unknown) => {
    if (!trusted(e)) return UNTRUSTED
    await settingsLoaded
    try {
      // `update` change la valeur en mémoire avant d'écrire : la taille est appliquée sans attendre le disque.
      const saving = settings.update(patch)
      applyZoom()
      return { ok: true, settings: await saving }
    } catch (err) {
      if (err instanceof SettingsError) {
        return { ok: false, error: { code: ErrorCode.InvalidParams, message: `réglages refusés : ${err.message}` } }
      }
      return failure(err)
    }
  })
  // Fermeture de la page : réglages en attente, appliqués tout de suite (écriture attendue avant de quitter).
  ipcMain.on(Ipc.settingsFlush, (e, patch: unknown) => {
    // La fenêtre peut être en train de se fermer : on reconnaît sa page par l'identifiant de ses contenus.
    if (!trusted(e) && !(pageContentsId !== null && e.sender.id === pageContentsId && e.senderFrame?.parent == null)) return
    void settingsLoaded.then(() =>
      settings
        .update(patch)
        .then(() => applyZoom())
        .catch((err: unknown) => log(`réglages de fermeture non enregistrés : ${(err as Error).message}`)),
    )
  })
  // Erreurs de la page : au journal, dédoublonnées et limitées (une boucle d'erreurs ne le noie pas).
  const pageErrors = new RendererErrorLog()
  ipcMain.on(Ipc.rendererError, (e, text: unknown) => {
    if (!trusted(e)) return
    let clean: string
    try {
      clean = validateRendererError(text)
    } catch {
      return
    }
    for (const line of pageErrors.accept(clean, Date.now())) log(line)
  })
  ipcMain.handle(Ipc.zoomStep, async (e, dir: unknown) => {
    if (!trusted(e)) return null
    try {
      return await changeZoom(validateZoomDirection(dir))
    } catch {
      return null
    }
  })
  ipcMain.handle(Ipc.pickFolder, async (e) => {
    if (!trusted(e) || !mainWindow) return null
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Dossier de la session',
      properties: ['openDirectory', 'dontAddToRecent'],
    })
    const p = r.canceled ? null : (r.filePaths[0] ?? null)
    // Chemin absolu, sans caractère nul (le démon vérifie qu'il existe).
    return p && path.isAbsolute(p) && !p.includes('\0') && p.length <= 4096 ? p : null
  })
  ipcMain.handle(Ipc.copyText, (e, text: unknown) => {
    if (!trusted(e) || typeof text !== 'string' || text.length > 100_000) return false
    clipboard.writeText(text)
    return true
  })
  ipcMain.handle(Ipc.openExternal, async (e, url: unknown) => {
    if (!trusted(e)) return UNTRUSTED
    try {
      await shell.openExternal(validateExternalUrl(url))
      return { ok: true }
    } catch (err) {
      return failure(err)
    }
  })
  ipcMain.on(Ipc.requestPort, (e) => {
    if (mainWindow && trusted(e)) openTerminalPort(mainWindow)
  })
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

void app.whenReady().then(async () => {
  log(`Electron ${process.versions.electron}, Chromium ${process.versions.chrome}, socket ${socket}, orchd « ${orchdBin} »`)
  hardenSessions()
  registerIpc()
  client.start()
  // Réglages lus avant la fenêtre : la page s'affiche directement à la bonne taille.
  await settingsLoaded
  mainWindow = createWindow()
  // Le processus GPU tourne une fois la première image prête.
  mainWindow.once('ready-to-show', () => setTimeout(logDisplayPlatform, 300))
})

// Avant de quitter : terminer l'écriture des réglages (une seule fois).
let settingsFlushed = false
app.on('before-quit', (e) => {
  if (settingsFlushed) return
  e.preventDefault()
  settingsFlushed = true
  // Les réglages envoyés à la fermeture de la page passent d'abord par `settingsLoaded`.
  void settingsLoaded
    .then(() => new Promise((ok) => setImmediate(ok)))
    .then(() => settings.flush())
    .finally(() => app.quit())
})

// Une seule fenêtre : la fermer quitte l'app. Le démon et les sessions continuent.
app.on('window-all-closed', () => {
  client.stop()
  app.quit()
})
