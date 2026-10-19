/**
 * Démarrage du démon quand son socket est absent : `orchd daemon`, détaché de
 * l'app (nouveau groupe de processus, sorties fermées) pour qu'il survive à sa
 * fermeture.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

export interface ResolveOptions {
  env: Record<string, string | undefined>
  /** Dossier de l'app (`app.getAppPath()`), pour trouver `../target/debug/orchd` en dev. */
  appPath: string
  /** App empaquetée : seul le binaire livré à côté des ressources est accepté. */
  packaged: boolean
  /** `process.resourcesPath` de l'app empaquetée. */
  resourcesPath?: string
  exists?: (p: string) => boolean
}

/**
 * Binaire `orchd`.
 *
 * - App empaquetée : `<resources>/bin/orchd` uniquement. Ni `PATH` ni
 *   variable d'environnement : un binaire étranger ne doit pas pouvoir se
 *   faire passer pour le démon (il recevrait toutes les sessions).
 * - Développement : `DEVMAESTRO_ORCHD_BIN`, sinon `../target/debug/orchd`
 *   s'il existe, sinon `orchd` cherché dans le `PATH`.
 */
export function resolveOrchdBin(opts: ResolveOptions): string {
  const exists = opts.exists ?? existsSync
  if (opts.packaged) {
    if (!opts.resourcesPath) throw new Error('dossier des ressources inconnu')
    return path.join(opts.resourcesPath, 'bin', 'orchd')
  }
  const fromEnv = opts.env.DEVMAESTRO_ORCHD_BIN
  if (fromEnv) return fromEnv
  const local = path.resolve(opts.appPath, '..', 'target', 'debug', 'orchd')
  if (exists(local)) return local
  return 'orchd'
}

export interface SpawnOutcome {
  bin: string
  /** Pid du démon lancé (absent si le lancement a échoué tout de suite). */
  pid: number | undefined
  /** Erreur asynchrone (binaire introuvable…), si elle survient. */
  error: Promise<Error | null>
}

/** Lance `<bin> daemon` détaché. Le verrou du démon règle une course entre deux lancements. */
export function spawnDaemon(bin: string, env: NodeJS.ProcessEnv = process.env): SpawnOutcome {
  const child = spawn(bin, ['daemon'], { detached: true, stdio: 'ignore', env })
  const error = new Promise<Error | null>((resolve) => {
    child.once('error', (e) => resolve(e))
    child.once('spawn', () => resolve(null))
  })
  child.unref()
  return { bin, pid: child.pid, error }
}
