/**
 * Contrat entre la page et le processus principal.
 *
 * - API exposée par le preload (`window.devmaestro`, via `contextBridge`) :
 *   appels JSON-RPC filtrés, notifications du démon, état de la connexion,
 *   choix de la session affichée.
 * - Canal du terminal (`MessagePort`) : octets de la session affichée vers la
 *   page (binaire), touches vers le démon. Un seul canal ordonné porte aussi
 *   l'instantané d'écran, pour qu'il arrive toujours avant les octets qui le
 *   suivent.
 */
import type { Methods, MethodName, Notification, Snapshot } from './protocol'
import type { AppSettings, SettingsPatch } from './settings'

export type ConnectionState =
  | { state: 'connecting'; attempt: number; detail?: string }
  | { state: 'starting-daemon'; bin: string }
  | { state: 'connected'; server: string; version: string; pid: number }
  | { state: 'disconnected'; error: string; retryInMs: number }
  | { state: 'incompatible'; error: string }
  /** Le démon ferme la connexion sans répondre : contrôle du pair (app lancée depuis une session). */
  | { state: 'refused'; error: string; retryInMs: number }

export interface RpcFailure {
  code: number
  message: string
}

export type CallResult<M extends MethodName> =
  | { ok: true; result: Methods[M]['result'] }
  | { ok: false; error: RpcFailure }

export interface ViewRequest {
  /** Session à afficher, `null` pour n'en afficher aucune. */
  id: string | null
  /** Taille du terminal de la page, envoyée au démon avant l'abonnement. */
  cols?: number
  rows?: number
}

export interface DevMaestroApi {
  call<M extends MethodName>(method: M, params: Methods[M]['params']): Promise<CallResult<M>>
  /** Choisit la session dont le terminal est transmis à la page. */
  view(req: ViewRequest): Promise<{ ok: true } | { ok: false; error: RpcFailure }>
  onNotification(cb: (n: Notification) => void): () => void
  onConnection(cb: (s: ConnectionState) => void): () => void
  connection(): Promise<ConnectionState>
  /** Demande un nouveau canal de terminal (reçu par `window` en `message`). */
  requestTerminalPort(): void
  /** Ouvre un lien http(s) dans le navigateur (après confirmation dans l'app). */
  openExternal(url: string): Promise<{ ok: true } | { ok: false; error: RpcFailure }>
  /** Dossier personnel de l'utilisateur (lecture seule), `null` si inconnu. */
  home(): Promise<string | null>
  /** Réglages de l'app (gardés par le processus principal). `fresh` : aucun fichier encore. */
  settings(): Promise<{ settings: AppSettings; fresh: boolean } | null>
  /** Modifie les réglages (validés par le processus principal) ; renvoie les réglages à jour. */
  updateSettings(patch: SettingsPatch): Promise<{ ok: true; settings: AppSettings } | { ok: false; error: RpcFailure }>
  /** Sélecteur de dossier du système ; `null` si annulé. */
  pickFolder(): Promise<string | null>
  /**
   * Envoi sans réponse des réglages pas encore enregistrés, à la fermeture de
   * la page (le processus principal les écrit avant de quitter).
   */
  flushSettings(patch: SettingsPatch): void
  /** Copie un texte dans le presse-papiers. */
  copyText(text: string): Promise<boolean>
  /** Une notification desktop a été cliquée : afficher cette session. */
  onSelectSession(cb: (id: string) => void): () => void
}

/** Messages du canal du terminal, processus principal → page. */
export type PortDown =
  /** Efface le terminal et redessine l'écran (abonnement ou resynchronisation). */
  | { t: 'reset'; id: string; gen: number; snapshot: Snapshot; reason: 'subscribe' | 'resync' }
  /** Octets bruts du terminal, par lots. */
  | { t: 'data'; id: string; gen: number; bytes: Uint8Array }
  /** Plus aucune session affichée. */
  | { t: 'none'; gen: number }
  /**
   * La page a pris trop de retard (contrôle de flux) : des octets sont
   * abandonnés ; un nouvel instantané suivra quand elle aura rattrapé.
   */
  | { t: 'paused'; id: string; gen: number }

/** Messages du canal du terminal, page → processus principal. */
export type PortUp =
  | { t: 'input'; id: string; data: Uint8Array }
  /** Octets d'un lot `data` effectivement écrits dans xterm (accusé). */
  | { t: 'ack'; gen: number; bytes: number }

/** Type du message `window.postMessage` qui transmet le port à la page. */
export const PORT_MESSAGE = 'devmaestro:terminal-port'

/** Canaux IPC (préfixés, pour ne rien exposer d'autre). */
export const Ipc = {
  call: 'devmaestro:call',
  view: 'devmaestro:view',
  connection: 'devmaestro:connection',
  notification: 'devmaestro:notification',
  connectionChanged: 'devmaestro:connection-changed',
  requestPort: 'devmaestro:request-port',
  port: 'devmaestro:port',
  openExternal: 'devmaestro:open-external',
  home: 'devmaestro:home',
  settingsGet: 'devmaestro:settings-get',
  settingsSet: 'devmaestro:settings-set',
  settingsFlush: 'devmaestro:settings-flush',
  pickFolder: 'devmaestro:pick-folder',
  copyText: 'devmaestro:copy-text',
  selectSession: 'devmaestro:select-session',
} as const
