/**
 * Processus principal Electron : une seule fenêtre, client du démon `orchd`,
 * relais vers la page (ADR 0004). La page n'a pas accès à Node : elle passe
 * par l'API minimale du preload et par un `MessagePort` pour le terminal.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

import {
  BrowserWindow,
  MessageChannelMain,
  app,
  ipcMain,
  session,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MessagePortMain,
} from 'electron'

import { Ipc, type CallResult, type PortDown, type RpcFailure } from '../shared/bridge'
import { ErrorCode, RENDERER_METHODS, type MethodName } from '../shared/protocol'
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

client.on('pty', (id, data) => relay.onPty(id, data))
client.on('notification', (n) => {
  if (n.method === 'session.resync') {
    relay.onNotification(n)
    return
  }
  if (n.method === 'session.updated' || n.method === 'session.effect') {
    toPage(Ipc.notification, { method: n.method, params: n.params })
  }
})
client.on('connected', () => relay.onConnected())
client.on('state', (s) => {
  if (s.state !== 'connected') relay.onDisconnected()
  toPage(Ipc.connectionChanged, s)
})

let mainWindow: BrowserWindow | null = null
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

// Une seule fenêtre : la fermer quitte l'app. Le démon et les sessions continuent.
app.on('window-all-closed', () => {
  client.stop()
  app.quit()
})
