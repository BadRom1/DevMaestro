/**
 * Emplacement du socket du démon, mêmes règles que `crates/core/src/paths.rs` :
 * `$XDG_RUNTIME_DIR/devmaestro/orchd.sock` si la variable est un chemin absolu,
 * sinon `$TMPDIR/devmaestro-<uid>/orchd.sock` (TMPDIR absolu), sinon
 * `/tmp/devmaestro-<uid>/orchd.sock`.
 */
import path from 'node:path'

export const APP_DIR = 'devmaestro'
export const SOCKET_NAME = 'orchd.sock'

export type EnvGetter = (key: string) => string | undefined

export function runtimeDir(get: EnvGetter, uid: number): string {
  const xdg = get('XDG_RUNTIME_DIR')
  if (xdg && path.isAbsolute(xdg)) return path.join(xdg, APP_DIR)
  const tmpVar = get('TMPDIR')
  const tmp = tmpVar && path.isAbsolute(tmpVar) ? tmpVar : '/tmp'
  return path.join(tmp, `${APP_DIR}-${uid}`)
}

export function socketPath(get: EnvGetter, uid: number): string {
  return path.join(runtimeDir(get, uid), SOCKET_NAME)
}

/** Chemin du socket pour le processus courant. */
export function defaultSocketPath(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0
  return socketPath((k) => process.env[k], uid)
}
