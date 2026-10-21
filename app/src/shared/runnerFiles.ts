/**
 * Fichiers pris en compte par l'empreinte d'un runner (`Runner.files`) :
 * lus avec tolérance (absents d'un démon plus ancien), textes du dépôt non
 * fiables (contrôles retirés, longueurs bornées). Partagé entre le processus
 * principal (dialogue de confirmation) et la page (onglet « Lancer »).
 */
import type { RunnerFile, RunnerFileState } from './protocol'

export const RUNNER_FILE_STATES: readonly RunnerFileState[] = ['ok', 'absent', 'outside', 'too_large', 'unresolved']
/** Fichiers gardés au plus (au-delà : ignorés, un avertissement le dit). */
export const MAX_RUNNER_FILES = 64

/** États qui demandent un avertissement : le fichier n'a pas pu être lu en entier. */
export function riskyRunnerFile(f: Pick<RunnerFile, 'state'>): boolean {
  return f.state === 'too_large' || f.state === 'unresolved' || f.state === 'outside'
}

const CONTROLS = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩‎‏]/g

function text(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  const t = v.replace(CONTROLS, '').trim()
  return t ? [...t].slice(0, max).join('') : null
}

/** `files` d'un runner, ou `null` si le démon ne le donne pas. Entrées invalides écartées. */
export function readRunnerFiles(raw: unknown): RunnerFile[] | null {
  if (!Array.isArray(raw)) return null
  const out: RunnerFile[] = []
  for (const x of raw.slice(0, MAX_RUNNER_FILES)) {
    if (typeof x !== 'object' || x === null) continue
    const o = x as Record<string, unknown>
    const path = text(o.path, 1024)
    if (!path) continue
    const state = (RUNNER_FILE_STATES as readonly unknown[]).includes(o.state) ? (o.state as RunnerFileState) : 'unresolved'
    out.push({
      path,
      size: typeof o.size === 'number' && Number.isFinite(o.size) && o.size >= 0 ? Math.trunc(o.size) : null,
      state,
      note: text(o.note, 300),
    })
  }
  return out
}

/** Chemin ouvrable dans l'onglet « Fichiers » : relatif, sans « .. », fichier lu. */
export function openableRunnerFile(f: Pick<RunnerFile, 'path' | 'state'>): boolean {
  if (f.state !== 'ok' && f.state !== 'too_large') return false
  if (f.path.startsWith('/') || f.path.startsWith('~') || /^[a-z][a-z0-9+.-]*:/i.test(f.path)) return false
  return !f.path.split('/').some((p) => p === '..' || p === '')
}
