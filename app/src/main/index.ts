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
import { ErrorCode, RENDERER_METHODS, type Demand, type Effect, type MethodName, type Session } from '../shared/protocol'
import { SettingsError } from '../shared/settings'
import { NotifyDecider, notificationContent } from './notifyLogic'
import { SettingsStore } from './settingsStore'
import { DaemonClient } from './daemon/client'
import { defaultSocketPath } from './daemon/paths'
import { TerminalRelay } from './daemon/relay'
import { RpcError } from './daemon/rpc'
import { resolveOrchdBin, spawnDaemon } from './daemon/spawn'
import { ValidationError, validateExternalUrl, validateParams, validateView } from './validate'

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
const settings = new SettingsStore(app.getPath('userData'), log)
const settingsLoaded = settings.load()

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

function onEffect(id: string, effect: Effect): void {
  if (effect.type === 'notify_waiting') void notifyWaiting(id, effect.request_id, effect.pending)
  else if (effect.type === 'request_resolved' && decider.resolved(id, effect.request_id)) closeNotification(id)
}

client.on('pty', (id, data) => relay.onPty(id, data))
client.on('notification', (n) => {
  if (n.method === 'session.resync') {
    relay.onNotification(n)
    return
  }
  if (n.method === 'session.updated') {
    const s = (n.params as { session?: Session }).session
    if (s?.id) {
      sessionCache.set(s.id, s)
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
  }
  if (n.method === 'session.updated' || n.method === 'session.effect' || n.method === 'session.removed' || n.method === 'quotas.updated') {
    toPage(Ipc.notification, { method: n.method, params: n.params })
  }
})
client.on('connected', () => relay.onConnected())
client.on('state', (s) => {
  if (s.state !== 'connected') relay.onDisconnected()
  toPage(Ipc.connectionChanged, s)
})

let mainWindow: BrowserWindow | null = null
/** Contenus de la page de la fenêtre (gardé après sa fermeture, pour les réglages envoyés en partant). */
let pageContentsId: number | null = null
let port: MessagePortMain | null = null

function toPage(channel: string, payload: unknown): void {
  const wc = mainWindow?.webContents
  if (wc && !wc.isDestroyed()) wc.send(channel, payload)
}

/** Nouveau canal du terminal pour la page ; l'ancien est fermé. */
function openTerminalPort(win: BrowserWindow): void {
  port?.close()
  const { port1, port2 } = new MessageChannelMain()
  port = port1
  port1.on('message', (e) => {
    const m = e.data as Record<string, unknown> | null
    if (!m || typeof m !== 'object') return
    if (m.t === 'input' && typeof m.id === 'string' && m.data instanceof Uint8Array) {
      relay.input(m.id, m.data)
    } else if (m.t === 'ack' && Number.isInteger(m.gen) && Number.isInteger(m.bytes)) {
      relay.ack(m.gen as number, m.bytes as number)
    }
  })
  port1.start()
  relay.setSink({ post: (msg: PortDown) => port1.postMessage(msg) })
  win.webContents.postMessage(Ipc.port, null, [port2])
}

/**
 * La page est une application d'une seule page : elle ne navigue jamais.
 * Seul le rechargement de la même adresse (développement, Ctrl+R) passe.
 */
function rendererUrlAllowed(contents: Electron.WebContents, url: string): boolean {
  const strip = (u: string) => u.split('#')[0]
  return strip(url) === strip(contents.getURL())
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
    },
  })
  pageContentsId = win.webContents.id
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
    relay.setSink(null)
    port?.close()
    port = null
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

function hardenSessions(): void {
  // Aucune permission web (caméra, notifications web, géolocalisation…) pour la page.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-navigate', (ev, url) => {
      if (!rendererUrlAllowed(contents, url)) ev.preventDefault()
    })
    contents.on('will-redirect', (ev, url) => {
      if (!rendererUrlAllowed(contents, url)) ev.preventDefault()
    })
    contents.on('will-attach-webview', (ev) => ev.preventDefault())
    // Jamais de nouvelle fenêtre : les liens passent par `openExternal`, après confirmation dans l'app.
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
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
  return { ok: false, error: { code: r.code, message: r.message } }
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
      const result = await client.request(method, clean)
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
  ipcMain.handle(Ipc.connection, (e) => (trusted(e) ? client.state : null))
  ipcMain.handle(Ipc.home, (e) => (trusted(e) ? validHome(homedir()) : null))
  ipcMain.handle(Ipc.settingsGet, async (e) => {
    if (!trusted(e)) return null
    await settingsLoaded
    return { settings: settings.settings, fresh: settings.fresh }
  })
  ipcMain.handle(Ipc.settingsSet, async (e, patch: unknown) => {
    if (!trusted(e)) return UNTRUSTED
    await settingsLoaded
    try {
      return { ok: true, settings: await settings.update(patch) }
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
      settings.update(patch).catch((err: unknown) => log(`réglages de fermeture non enregistrés : ${(err as Error).message}`)),
    )
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

void app.whenReady().then(() => {
  log(`Electron ${process.versions.electron}, Chromium ${process.versions.chrome}, socket ${socket}, orchd « ${orchdBin} »`)
  hardenSessions()
  registerIpc()
  client.start()
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
