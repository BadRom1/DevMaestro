/**
 * Accord des plugins (lot 22a, ADR 0007), doublé par le processus principal
 * comme les commandes du dépôt (`runnerGuard`) : la page ne peut ni accepter
 * ni révoquer un plugin par le protocole (`plugins.accept` / `plugins.revoke`
 * absentes de `RENDERER_METHODS`), ni obtenir un panneau ou lancer une
 * action d'un plugin que l'utilisateur n'a pas accepté.
 *
 * - Avant `plugins.panel` / `plugins.action` : `plugins.list` relu ; refus si
 *   l'empreinte actuelle n'est pas celle retenue dans les réglages de l'app
 *   **et** acceptée au démon (`acceptance: "accepted"`). Acceptée :
 *   `expected_fingerprint` est ajouté, et le démon refuse (`-32032`) si son
 *   empreinte relue à l'instant diffère.
 * - « Accepter » (canal `acceptPlugin`) : `plugins.list` relu ; refus si le
 *   manifeste est invalide ou si l'empreinte a changé depuis ce qui a été
 *   montré ; l'accord est retenu chez l'app, puis demandé au démon (en cas
 *   d'échec du démon, l'accord précédent de l'app est rétabli).
 * - « Révoquer » (canal `revokePlugin`) : oublié chez l'app, puis révoqué au démon.
 *
 * Coût : `checkPlugin` lit la liste par un cache (`PluginListCache`, 10 s
 * au plus, vidé par `plugins.changed`, une reconnexion, un accord, une
 * révocation ou un refus du démon) ; la vérification de l'accord chez l'app
 * reste faite à chaque appel. Un fichier du plugin modifié entre-temps est
 * de toute façon refusé par le démon, qui relit l'empreinte à chaque
 * demande (`expected_fingerprint`, `-32032`). « Accepter » relit toujours
 * la liste au démon.
 *
 * Refus produits par l'app : codes du démon (`-32030` à `-32032`), `data.origin = "app"`.
 * Sans Electron : testable avec un faux client.
 */
import { t } from '../shared/i18n'
import { isPluginFingerprint } from '../shared/pluginDocument'
import { ErrorCode } from '../shared/protocol'
import { RpcError } from './daemon/rpc'

const APP_ORIGIN = { origin: 'app' } as const

export interface PluginGuardDeps {
  request(method: string, params: unknown): Promise<unknown>
  /** Liste mise en cache pour `checkPlugin` ; absente : relue à chaque appel. */
  cache?: PluginListCache
  /** Empreinte acceptée dans les réglages de l'app pour ce plugin, ou `undefined`. */
  acceptedFingerprint(name: string): string | undefined
  remember(name: string, fingerprint: string): Promise<void>
  forget(name: string): Promise<void>
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Cache de `plugins.list` pour le garde : une liste partagée par les
 * demandes rapprochées, oubliée après `ttlMs` ou sur `invalidate()`. Une
 * lecture en échec n'est pas gardée.
 */
export class PluginListCache {
  private value: Promise<unknown> | null = null
  private at = 0

  constructor(
    private readonly fetch: () => Promise<unknown>,
    private readonly ttlMs = 10_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get(): Promise<unknown> {
    if (!this.value || this.now() - this.at > this.ttlMs) {
      this.at = this.now()
      const p = this.fetch()
      this.value = p
      p.catch(() => {
        if (this.value === p) this.value = null
      })
    }
    return this.value
  }

  invalidate(): void {
    this.value = null
  }
}

/** Plugin tel que le démon le décrit (cache permis pour `checkPlugin`), valide et avec son empreinte ; sinon refus `-32030`. */
async function readPlugin(deps: PluginGuardDeps, name: string, cached = false): Promise<{ fingerprint: string; acceptance: unknown }> {
  const list = cached && deps.cache ? await deps.cache.get() : await deps.request('plugins.list', {})
  const plugins = isObj(list) && Array.isArray(list.plugins) ? list.plugins : []
  const p = plugins.find((x): x is Record<string, unknown> => isObj(x) && x.name === name)
  if (!p || p.valid !== true || !isPluginFingerprint(p.fingerprint)) {
    throw new RpcError(ErrorCode.PluginUnknown, t('plugins.guard.unknown'), APP_ORIGIN)
  }
  return { fingerprint: p.fingerprint, acceptance: p.acceptance }
}

/**
 * Avant `plugins.panel` / `plugins.action` : refus tant que l'empreinte
 * actuelle n'est pas acceptée chez l'app et au démon ; renvoie l'empreinte
 * à passer en `expected_fingerprint`.
 */
export async function checkPlugin(deps: PluginGuardDeps, name: string): Promise<string> {
  const p = await readPlugin(deps, name, true)
  const mine = deps.acceptedFingerprint(name)
  if (p.acceptance === 'accepted' && mine === p.fingerprint) return p.fingerprint
  const changed = p.acceptance === 'changed' || (mine !== undefined && mine !== p.fingerprint)
  throw new RpcError(ErrorCode.PluginNotAccepted, t(changed ? 'plugins.guard.changed' : 'plugins.guard.notAccepted'), {
    acceptance: typeof p.acceptance === 'string' ? p.acceptance : 'none',
    fingerprint: p.fingerprint,
    ...APP_ORIGIN,
  })
}

/** « Accepter » dans le dialogue : retient le plugin montré, s'il n'a pas changé depuis, puis l'accepte au démon. */
export async function acceptPlugin(deps: PluginGuardDeps, name: string, fingerprint: string): Promise<unknown> {
  const p = await readPlugin(deps, name)
  if (p.fingerprint !== fingerprint) {
    throw new RpcError(ErrorCode.PluginFingerprintMismatch, t('plugins.guard.changedSinceShown'), { fingerprint: p.fingerprint, ...APP_ORIGIN })
  }
  const previous = deps.acceptedFingerprint(name)
  await deps.remember(name, fingerprint)
  try {
    const r = await deps.request('plugins.accept', { name, expected_fingerprint: fingerprint })
    deps.cache?.invalidate()
    return r
  } catch (e) {
    deps.cache?.invalidate()
    // Le démon refuse : l'app ne garde pas un accord que le démon n'a pas.
    if (previous === undefined) await deps.forget(name)
    else await deps.remember(name, previous)
    throw e
  }
}

/** « Révoquer » : oublié chez l'app d'abord (plus rien n'est relayé), puis au démon. */
export async function revokePlugin(deps: PluginGuardDeps, name: string): Promise<unknown> {
  await deps.forget(name)
  try {
    return await deps.request('plugins.revoke', { name })
  } finally {
    deps.cache?.invalidate()
  }
}
