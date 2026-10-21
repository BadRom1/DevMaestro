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
import type { Methods, MethodName, Notification, RunnerFile, Snapshot } from './protocol'
import type { AppSettings, SettingsPatch, ZoomDirection } from './settings'

export type ConnectionState =
  | { state: 'connecting'; attempt: number; detail?: string }
  | { state: 'starting-daemon'; bin: string }
  | {
      state: 'connected'
      server: string
      version: string
      pid: number
      /**
       * Fonctions annoncées par le `hello` du démon (`capabilities`), booléens
       * seulement ; absent d'un démon plus ancien.
       */
      capabilities?: Readonly<Record<string, boolean>>
    }
  | { state: 'disconnected'; error: string; retryInMs: number }
  | { state: 'incompatible'; error: string }
  /** Le démon ferme la connexion sans répondre : contrôle du pair (app lancée depuis une session). */
  | { state: 'refused'; error: string; retryInMs: number }

export interface RpcFailure {
  code: number
  message: string
  /** Détails structurés du démon (ex. extrait refusé : `{index, path, line, line_end}`). */
  data?: unknown
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

/**
 * Commande du dépôt à faire accepter (lot 14a) : `data` d'un refus
 * `RunnerConfirmationRequired` de `runners.start`, telle que le processus
 * principal l'a relue au démon.
 */
export interface RunnerConfirmation {
  worktree: string
  runner_id: string
  label: string
  command: string[]
  cwd: string
  source: string
  /** Contenu exécuté (texte du dépôt, non fiable), `null` si le démon n'en donne pas. */
  body: string | null
  /** Extrait `body` coupé par le démon. */
  body_truncated: boolean
  /** Fichiers pris en compte par l'empreinte ; `null` : le démon ne les donne pas. */
  files: RunnerFile[] | null
  /** Empreinte du démon (`Runner.fingerprint`) : renvoyée telle quelle par `confirmRunner`. */
  fingerprint: string
}

/** Terminal d'un runner à afficher (lot 14a) : exécution et sa session, ou aucun. */
export type RunnerViewRequest =
  | { session_id: string; process_id: string; cols?: number; rows?: number }
  | { session_id: null; process_id: null }

export interface DevMaestroApi {
  call<M extends MethodName>(method: M, params: Methods[M]['params']): Promise<CallResult<M>>
  /** Choisit la session dont le terminal est transmis à la page. */
  view(req: ViewRequest): Promise<{ ok: true } | { ok: false; error: RpcFailure }>
  onNotification(cb: (n: Notification) => void): () => void
  onConnection(cb: (s: ConnectionState) => void): () => void
  connection(): Promise<ConnectionState>
  /** Demande un nouveau canal de terminal (reçu par `window` en `message`). */
  requestTerminalPort(): void
  /** Choisit l'exécution de runner dont le terminal est transmis à la page (second canal). */
  viewRunner(req: RunnerViewRequest): Promise<{ ok: true } | { ok: false; error: RpcFailure }>
  /**
   * « Lancer » dans le dialogue de confirmation : le processus principal
   * retient la commande montrée (empreinte) pour ce worktree, si elle n'a pas
   * changé depuis.
   */
  confirmRunner(req: { session_id: string; runner_id: string; fingerprint: string }): Promise<{ ok: true } | { ok: false; error: RpcFailure }>
  /** Taille du terminal des runners (exécution affichée seulement). */
  resizeRunner(req: { process_id: string; cols: number; rows: number }): void
  /** Demande un nouveau canal pour le terminal des runners (message `RUNNER_PORT_MESSAGE`). */
  requestRunnerPort(): void
  /**
   * L'aperçu web (iframe) a voulu ouvrir une fenêtre : jamais ouverte par
   * Electron, le lien est proposé à la page qui demande confirmation.
   */
  onPreviewPopup(cb: (url: string) => void): () => void
  /** Ouvre un lien http(s) dans le navigateur (après confirmation dans l'app). */
  openExternal(url: string): Promise<{ ok: true } | { ok: false; error: RpcFailure }>
  /** Dossier personnel de l'utilisateur (lecture seule), `null` si inconnu. */
  home(): Promise<string | null>
  /**
   * Réglages de l'app (gardés par le processus principal). `fresh` : aucun fichier encore.
   * `systemLocales` (lot 20) : langues du système par ordre de préférence (absent : processus principal plus ancien).
   */
  settings(): Promise<{ settings: AppSettings; fresh: boolean; systemLocales?: string[] } | null>
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
  /** Dossier des worktrees gérés par l'app (`$XDG_DATA_HOME/devmaestro/worktrees`), `null` si inconnu. */
  worktreesDir(): Promise<string | null>
  /** Notification « branche intégrée » cliquée : ouvrir le nettoyage des worktrees de ce dépôt. */
  onOpenCleanup(cb: (req: { root: string; path: string | null }) => void): () => void
  /** Taille de l'interface d'un palier (Ctrl + molette) ; renvoie la nouvelle taille (pour cent), `null` si refusé. */
  zoomStep(dir: ZoomDirection): Promise<number | null>
  /** Taille de l'interface changée par le processus principal (raccourci clavier ou molette), en pour cent. */
  onZoomChanged(cb: (zoom: number) => void): () => void
  /** Erreur de la page (non rattrapée, ou rattrapée par un garde-fou d'affichage) pour le journal du processus principal. */
  logError(text: string): void
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
/** Même chose pour le canal du terminal des runners (lot 14a). */
export const RUNNER_PORT_MESSAGE = 'devmaestro:runner-port'

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
  worktreesDir: 'devmaestro:worktrees-dir',
  openCleanup: 'devmaestro:open-cleanup',
  zoomStep: 'devmaestro:zoom-step',
  zoomChanged: 'devmaestro:zoom-changed',
  rendererError: 'devmaestro:renderer-error',
  viewRunner: 'devmaestro:view-runner',
  resizeRunner: 'devmaestro:resize-runner',
  confirmRunner: 'devmaestro:confirm-runner',
  requestRunnerPort: 'devmaestro:request-runner-port',
  runnerPort: 'devmaestro:runner-port',
  previewPopup: 'devmaestro:preview-popup',
} as const
