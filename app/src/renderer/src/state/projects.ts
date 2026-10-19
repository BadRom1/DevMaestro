/**
 * Regroupement des sessions par projet (dépôt git) pour la barre latérale.
 * Identifiant d'un projet : le dossier commun git (`common_dir`), partagé par
 * tous ses worktrees ; à défaut la racine, à défaut le dossier de la session.
 */
import type { PastSession, ProjectInfo, Session } from '../../../shared/protocol'
import { basename } from './format'
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
export function fallbackProject(s: Pick<Session, 'cwd' | 'project_root'>): ProjectInfo {
  const root = s.project_root ?? s.cwd
  return { path: s.cwd, is_git: false, root, worktree_root: null, common_dir: null, branch: null, name: null }
}

export function groupByProject(sessions: Session[], projects: Record<string, ProjectInfo>): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>()
  for (const s of sessions) {
    const info = projects[s.cwd]
    const key = projectKey(s, info)
    let g = groups.get(key)
    if (!g) {
      const root = info?.root ?? s.project_root ?? s.cwd
      g = { key, root, name: info?.name ?? basename(root), isGit: info?.is_git ?? false, sessions: [], waiting: 0 }
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
  all.sort((a, b) => time(b.last_timestamp) - time(a.last_timestamp))
  return all.slice(0, limit)
}
