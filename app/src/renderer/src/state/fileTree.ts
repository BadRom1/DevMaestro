/**
 * Onglet « Fichiers » : arborescence chargée à la demande (un dossier à la
 * fois), dossiers ouverts vers les fichiers modifiés, filtre. Calculs purs.
 */
import { getLocale, t } from '../../../shared/i18n'
import type { DiffStatus, FileEntry } from '../../../shared/protocol'

/**
 * Tri des chemins dans la langue de l'interface, avec les mêmes options
 * qu'avant le lot 20 (pas `collator()` : sa sensibilité « base » confondrait
 * `README` et `readme`). Instances mises en cache par langue et options.
 */
const pathCollators = new Map<string, Intl.Collator>()
function pathCollator(numeric: boolean): Intl.Collator {
  const k = `${getLocale()}|${numeric}`
  let c = pathCollators.get(k)
  if (!c) {
    c = new Intl.Collator(getLocale(), numeric ? { numeric: true } : undefined)
    pathCollators.set(k, c)
  }
  return c
}

/** Contenu des dossiers déjà chargés, par chemin (`''` : racine). */
export type DirCache = Record<string, FileEntry[]>

export interface TreeRow {
  path: string
  name: string
  kind: FileEntry['kind']
  depth: number
  changed: DiffStatus | null
  /** Dossier contenant au moins un fichier modifié (d'après la liste du diff). */
  changedInside: boolean
  expanded: boolean
  /** Dossier dont le contenu est déjà chargé. */
  loaded: boolean
}

export function parentOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

/** Dossiers à ouvrir pour montrer ces fichiers (ancêtres, du plus haut au plus profond). */
export function ancestorDirs(paths: readonly string[]): string[] {
  const out = new Set<string>()
  for (const p of paths) {
    const parts = p.split('/').filter(Boolean)
    for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join('/'))
  }
  return [...out].sort((a, b) => a.split('/').length - b.split('/').length || pathCollator(false).compare(a, b))
}

/** Lignes visibles de l'arbre : racine puis, récursivement, les dossiers ouverts. */
export function visibleRows(cache: DirCache, open: ReadonlySet<string>, changedPaths: readonly string[]): TreeRow[] {
  const dirsWithChanges = new Set(ancestorDirs(changedPaths))
  const rows: TreeRow[] = []
  const walk = (dir: string, depth: number) => {
    for (const e of cache[dir] ?? []) {
      const isDir = e.kind === 'dir'
      const expanded = isDir && open.has(e.path)
      rows.push({
        path: e.path,
        name: e.name,
        kind: e.kind,
        depth,
        changed: e.changed,
        changedInside: isDir && dirsWithChanges.has(e.path),
        expanded,
        loaded: isDir && e.path in cache,
      })
      if (expanded) walk(e.path, depth + 1)
    }
  }
  walk('', 0)
  return rows
}

/**
 * Filtre : fichiers des dossiers déjà chargés et fichiers modifiés dont le
 * chemin contient le texte (sans tenir compte de la casse ni des accents),
 * à plat, triés par chemin.
 */
export function filterFiles(cache: DirCache, changed: readonly { path: string; status: DiffStatus }[], query: string): TreeRow[] {
  const norm = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
  const q = norm(query.trim())
  if (!q) return []
  const byPath = new Map<string, TreeRow>()
  for (const entries of Object.values(cache)) {
    for (const e of entries) {
      if (e.kind === 'dir' || !norm(e.path).includes(q)) continue
      byPath.set(e.path, { path: e.path, name: e.path, kind: e.kind, depth: 0, changed: e.changed, changedInside: false, expanded: false, loaded: false })
    }
  }
  for (const c of changed) {
    if (byPath.has(c.path) || !norm(c.path).includes(q)) continue
    byPath.set(c.path, { path: c.path, name: c.path, kind: 'file', depth: 0, changed: c.status, changedInside: false, expanded: false, loaded: false })
  }
  return [...byPath.values()].sort((a, b) => pathCollator(true).compare(a.path, b.path))
}

/** Fichier ouvert par défaut : le README de la racine s'il existe. */
export function defaultFile(root: readonly FileEntry[] | undefined): string | null {
  const readme = (root ?? []).find((e) => e.kind !== 'dir' && /^readme(\.(md|markdown|txt))?$/i.test(e.name))
  return readme?.path ?? null
}

export function isMarkdown(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path)
}

/**
 * Texte tapé par « Mentionner à Claude » : `@chemin ` (sans Entrée). Claude Code
 * ne documente pas de guillemets pour les mentions : un chemin avec un espace
 * ou un « @ » est refusé (message en français), comme un nom avec des
 * caractères de contrôle ou de format (message dans la langue courante).
 */
export function mentionFor(path: string): { ok: true; text: string } | { ok: false; error: string } {
  if (!path) return { ok: false, error: t('files.mention.noFile') }
  if (/[\p{Cc}\p{Cf}]/u.test(path)) return { ok: false, error: t('files.mention.controlChars') }
  if (/[\s@]/u.test(path)) {
    return {
      ok: false,
      error: t('files.mention.spaceOrAt'),
    }
  }
  return { ok: true, text: `@${path} ` }
}
