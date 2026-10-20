/**
 * Sections et groupes repliés de la barre latérale, retenus pour
 * l'utilisateur dans `localStorage` (stockage injecté : testable sans DOM).
 * Stockage indisponible ou valeur illisible : rien n'est replié.
 */

export const COLLAPSE_KEY = 'devmaestro.sidebar.collapsed'
/** Clé de la section « Anciennes sessions ». */
export const PAST_SECTION = 'past'
/** Au-delà, les clés les plus anciennes sont oubliées (projets disparus). */
const MAX_KEYS = 200

export type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem'>

export function loadCollapsed(storage: KeyValueStorage | null | undefined): ReadonlySet<string> {
  try {
    const raw = storage?.getItem(COLLAPSE_KEY)
    if (!raw) return new Set()
    const v: unknown = JSON.parse(raw)
    if (!Array.isArray(v)) return new Set()
    return new Set(v.filter((x): x is string => typeof x === 'string'))
  } catch {
    return new Set()
  }
}

export function saveCollapsed(storage: KeyValueStorage | null | undefined, keys: ReadonlySet<string>): void {
  try {
    storage?.setItem(COLLAPSE_KEY, JSON.stringify([...keys].slice(-MAX_KEYS)))
  } catch {
    /* stockage indisponible ou plein : l'état reste en mémoire */
  }
}

/** Ensemble avec `key` basculé (nouvel objet). */
export function toggleCollapsed(keys: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(keys)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}

/** `localStorage` s'il est accessible (il peut lever une exception). */
export function browserStorage(): KeyValueStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}
