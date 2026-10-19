/**
 * Preload (bac à sable) : expose à la page une API minimale et typée par
 * `contextBridge`, et lui transmet le `MessagePort` du terminal (qu'un
 * `contextBridge` ne sait pas passer) par `window.postMessage`.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

import { Ipc, PORT_MESSAGE, type ConnectionState, type DevMaestroApi } from '../shared/bridge'
import type { Notification } from '../shared/protocol'

ipcRenderer.on(Ipc.port, (e: IpcRendererEvent) => {
  // Même fenêtre : la page reçoit le port dans `event.ports`. Cible : notre
  // propre origine (« * » pour file://, dont l'origine est opaque).
  if (e.ports.length !== 1) return
  const origin = window.location.protocol === 'file:' ? '*' : window.location.origin
  window.postMessage({ type: PORT_MESSAGE }, origin, e.ports)
})

const api: DevMaestroApi = {
  call: (method, params) => ipcRenderer.invoke(Ipc.call, method, params),
  view: (req) => ipcRenderer.invoke(Ipc.view, { id: req.id, cols: req.cols, rows: req.rows }),
  connection: () => ipcRenderer.invoke(Ipc.connection) as Promise<ConnectionState>,
  onNotification(cb) {
    const h = (_e: IpcRendererEvent, n: Notification) => cb(n)
    ipcRenderer.on(Ipc.notification, h)
    return () => void ipcRenderer.removeListener(Ipc.notification, h)
  },
  onConnection(cb) {
    const h = (_e: IpcRendererEvent, s: ConnectionState) => cb(s)
    ipcRenderer.on(Ipc.connectionChanged, h)
    return () => void ipcRenderer.removeListener(Ipc.connectionChanged, h)
  },
  requestTerminalPort: () => ipcRenderer.send(Ipc.requestPort),
  openExternal: (url) => ipcRenderer.invoke(Ipc.openExternal, String(url)),
}

contextBridge.exposeInMainWorld('devmaestro', api)
