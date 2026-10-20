/**
 * Regroupement des sessions par projet (dépôt git) pour la barre latérale.
 * Identifiant d'un projet : le dossier commun git (`common_dir`), partagé par
 * tous ses worktrees ; à défaut la racine, à défaut le dossier de la session.
 */
import type { PastSession, ProjectInfo, Session } from '../../../shared/protocol'
import { basename, tildify } from './format'
import { STATUS_ORDER, glyphFor } from './status'

export interface ProjectGroup {
  key: string
  name: string
  root: string
  isGit: boolean
  sessions: Session[]
  waiting: number
}

export function projectKey(s: Pick<Session, 'cwd' | 'project_root'>, info: ProjectInfo | undefined): string {
  return info?.common_dir ?? info?.root ?? s.project_root ?? s.cwd
}

function time(iso: string | null | undefined): number {
  const t = Date.parse(iso ?? '')
  return Number.isNaN(t) ? 0 : t
}

/**
 * Projet de repli quand `projects.resolve` échoue (dossier disparu…) : mis en
 * cache pour ne pas redemander à chaque mise à jour de la session.
 */
/** Nom d'un dossier hors dépôt : « ~ » pour le dossier personnel, sinon son nom. */
export function folderName(path: string, home: string | null): string {
  return tildify(path, home) === '~' ? '~' : basename(path)
}

export function fallbackProject(s: Pick<Session, 'cwd' | 'project_root'>): ProjectInfo {
  const root = s.project_root ?? s.cwd
  return { path: s.cwd, is_git: false, root, worktree_root: null, common_dir: null, branch: null, name: null }
}

export function groupByProject(
  sessions: Session[],
  projects: Record<string, ProjectInfo>,
  home: string | null = null,
): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>()
  for (const s of sessions) {
    const info = projects[s.cwd]
    const key = projectKey(s, info)
    let g = groups.get(key)
    if (!g) {
      const root = info?.root ?? s.project_root ?? s.cwd
      const isGit = info?.is_git ?? false
      // Hors dépôt : groupe par dossier, nommé comme lui (« ~ » pour le dossier personnel).
      const name = isGit ? (info?.name ?? basename(root)) : folderName(root, home)
      g = { key, root, name, isGit, sessions: [], waiting: 0 }
      groups.set(key, g)
    }
    g.sessions.push(s)
    if (s.status.state === 'waiting') g.waiting++
  }
  const list = [...groups.values()]
  for (const g of list) {
    g.sessions.sort(
      (a, b) =>
        STATUS_ORDER[glyphFor(a.status).kind] - STATUS_ORDER[glyphFor(b.status).kind] ||
        time(b.last_activity ?? b.created_at) - time(a.last_activity ?? a.created_at),
    )
  }
  // Ordre stable : par nom de projet.
  return list.sort((a, b) => a.name.localeCompare(b.name, 'fr') || a.key.localeCompare(b.key))
}

/** Sessions dans l'ordre de la barre latérale (pour « N à répondre »). */
export function sidebarOrder(groups: ProjectGroup[]): Session[] {
  return groups.flatMap((g) => g.sessions)
}

export interface PastEntry extends PastSession {
  profile: string
}

/** Dernière activité d'une ancienne session (ms depuis l'époque, 0 si inconnue). */
export function pastTime(p: Pick<PastSession, 'last_activity' | 'last_timestamp'>): number {
  return time(p.last_activity ?? p.last_timestamp)
}

/** Groupe d'attente des anciennes sessions dont le dossier n'est pas encore résolu. */
export const RESOLVING_GROUP = 'resolving'

export interface PastGroup {
  key: string
  name: string
  /** Dossier à afficher sous le nom (racine du dépôt ou dossier), `null` si inconnu. */
  root: string | null
  isGit: boolean
  entries: PastEntry[]
  /** Activité la plus récente du groupe. */
  latest: number
}

/**
 * Anciennes sessions groupées par origine : par dépôt git (dossier commun,
 * tous worktrees confondus) quand le dossier est résolu dans un dépôt, sinon
 * par dossier. Groupes et entrées du plus récent au plus ancien. Un dossier
 * pas encore résolu va dans un groupe d'attente « Résolution… » (jamais dans
 * un groupe de dossier qui disparaîtrait à la résolution).
 */
export function groupPast(entries: PastEntry[], projects: Record<string, ProjectInfo>, home: string | null): PastGroup[] {
  const groups = new Map<string, PastGroup>()
  for (const p of entries) {
    let key: string
    let name: string
    let root: string | null
    let isGit = false
    const info = p.cwd ? projects[p.cwd] : undefined
    if (!p.cwd) {
      key = 'dossier:?'
      name = 'Dossier inconnu'
      root = null
    } else if (!info) {
      key = RESOLVING_GROUP
      name = 'Résolution…'
      root = null
    } else if (info?.is_git) {
      key = `git:${info.common_dir ?? info.root}`
      root = info.root
      name = info.name ?? basename(info.root)
      isGit = true
    } else {
      key = `dossier:${p.cwd}`
      root = p.cwd
      name = folderName(p.cwd, home)
    }
    let g = groups.get(key)
    if (!g) {
      g = { key, name, root, isGit, entries: [], latest: 0 }
      groups.set(key, g)
    }
    g.entries.push(p)
    g.latest = Math.max(g.latest, pastTime(p))
  }
  const list = [...groups.values()]
  for (const g of list) g.entries.sort((a, b) => pastTime(b) - pastTime(a))
  return list.sort((a, b) => b.latest - a.latest || a.name.localeCompare(b.name, 'fr') || a.key.localeCompare(b.key))
}

/**
 * Anciennes sessions à proposer : celles des transcripts que le démon ne
 * connaît pas déjà, de la plus récente à la plus ancienne.
 */
export function pastToOffer(past: Record<string, PastSession[]>, sessions: Session[], limit = 20): PastEntry[] {
  const known = new Set(sessions.map((s) => s.claude_session_id).filter(Boolean))
  const all: PastEntry[] = []
  for (const [profile, list] of Object.entries(past)) {
    for (const p of list) if (!known.has(p.claude_session_id)) all.push({ ...p, profile })
  }
  all.sort((a, b) => pastTime(b) - pastTime(a))
  return all.slice(0, limit)
}
