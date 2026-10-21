/**
 * Regroupement des sessions par projet (dépôt git) pour la barre latérale.
 * Identifiant d'un projet : le dossier commun git (`common_dir`), partagé par
 * tous ses worktrees ; à défaut la racine, à défaut le dossier de la session.
 */
import type { PastSession, ProjectInfo, Session } from '../../../shared/protocol'
import { rootFromCommonDir } from '../../../shared/worktrees'
import { basename, tildify } from './format'
import { STATUS_ORDER, glyphFor } from './status'

export interface ProjectGroup {
  key: string
  name: string
  root: string
  isGit: boolean
  sessions: Session[]
  waiting: number
  /** Le dossier du groupe a disparu (déplacé ou supprimé). */
  missing: boolean
}

function parentDir(p: string): string | null {
  const t = p.replace(/\/+$/, '')
  const i = t.lastIndexOf('/')
  if (i <= 0) return t === '' || t === '/' ? null : '/'
  return t.slice(0, i)
}

/** Dossier disparu sans dépôt retrouvé par le démon (ni ancêtre retenu) ? */
function orphanMissing(info: ProjectInfo | undefined): boolean {
  return !!info && info.exists === false && !info.is_git && !(info.inferred && info.root)
}

/**
 * Pour un dossier disparu sans dépôt retrouvé : le plus haut ancêtre disparu
 * juste sous le dossier existant le plus proche (ex. `…/planner` pour
 * `…/planner/wonderful-elbakyan-3dac24` quand tout `planner` a été déplacé).
 * On remonte tant que le parent est connu comme disparu (`projects.resolve`
 * mis en cache) ; un parent pas encore résolu arrête la remontée (voir
 * `ancestorToResolve`). `null` si le dossier n'est pas dans ce cas.
 */
export function missingGroupDir(cwd: string, projects: Record<string, ProjectInfo>): string | null {
  if (!orphanMissing(projects[cwd])) return null
  let dir = cwd
  for (let parent = parentDir(dir); parent && projects[parent]?.exists === false; parent = parentDir(dir)) {
    dir = parent
  }
  return dir
}

/**
 * Projet déplacé : un groupe de dossier disparu (sans dépôt retrouvé) rejoint
 * le dépôt existant du même nom quand ses entrées montrent que c'était un
 * dépôt git (`wasGit` : une branche est connue pour au moins une entrée) ET
 * qu'**un seul** dépôt existant porte ce nom. Ses entrées gardent leur pastille
 * « dossier supprimé ». Sinon le groupe reste à part.
 */
export function mergeMovedGroups<G extends { name: string; missing: boolean; isGit: boolean }>(
  groups: G[],
  merge: (into: G, from: G) => void,
  wasGit: (g: G) => boolean,
): G[] {
  const targets = groups.filter((g) => !g.missing && g.isGit)
  const merged = new Set<G>()
  for (const g of groups) {
    if (!g.missing || g.isGit || !wasGit(g)) continue
    const same = targets.filter((t) => t.name === g.name)
    if (same.length !== 1) continue
    merge(same[0]!, g)
    merged.add(g)
  }
  return merged.size ? groups.filter((g) => !merged.has(g)) : groups
}

/** Prochain ancêtre à résoudre pour situer un dossier disparu, ou `null`. */
export function ancestorToResolve(cwd: string, projects: Record<string, ProjectInfo>): string | null {
  const top = missingGroupDir(cwd, projects)
  if (!top) return null
  const parent = parentDir(top)
  return parent && !projects[parent] ? parent : null
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
    // Identité enregistrée par le démon (lot 6) d'abord : une session d'un
    // worktree supprimé reste sous son projet, quel que soit l'emplacement.
    const identity = s.project_common_dir || null
    const gone = identity ? null : missingGroupDir(s.cwd, projects)
    const key = identity ?? gone ?? projectKey(s, info)
    let g = groups.get(key)
    if (!g) {
      const known = info?.is_git && info.root ? info.root : null
      const root = identity
        ? (known ?? rootFromCommonDir(identity) ?? s.project_root ?? s.cwd)
        : (gone ?? info?.root ?? s.project_root ?? s.cwd)
      const isGit = identity ? true : (info?.is_git ?? false)
      // Hors dépôt : groupe par dossier, nommé comme lui (« ~ » pour le dossier personnel).
      const name = isGit ? (info?.name ?? basename(root)) : folderName(root, home)
      g = { key, root, name, isGit, sessions: [], waiting: 0, missing: !!gone }
      groups.set(key, g)
    } else if (identity && info?.is_git && info.root && g.root !== info.root) {
      // Groupe ouvert par une session au dossier disparu : la racine résolue fait foi.
      g.root = info.root
      g.name = info.name ?? basename(info.root)
    }
    g.sessions.push(s)
    if (s.status.state === 'waiting') g.waiting++
  }
  const list = mergeMovedGroups([...groups.values()], (into, from) => {
    into.sessions.push(...from.sessions)
    into.waiting += from.waiting
  }, (g) => g.sessions.some((s) => !!s.branch))
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
  /**
   * Profil proposé par défaut pour la reprendre : le premier (dans l'ordre des
   * profils) dont `transcripts.list` la renvoie. Ce n'est pas son profil
   * d'origine quand plusieurs profils la voient (`projects/` partagé).
   */
  profile: string
  /** Profils dont `transcripts.list` renvoie cette conversation (au moins un). */
  profiles: string[]
}

/**
 * Masque une ancienne session pour chaque profil donné (tous tentés, même si
 * l'un échoue) : `hidden` liste ceux où le démon l'a masquée, `failed` les
 * autres avec l'erreur. Le store ne doit retirer la conversation que des
 * profils de `hidden`, pour refléter exactement l'état du démon.
 */
export async function hideForProfiles(
  profiles: readonly string[],
  hide: (profile: string) => Promise<unknown>,
): Promise<{ hidden: string[]; failed: { profile: string; error: unknown }[] }> {
  const results = await Promise.allSettled(profiles.map((profile) => hide(profile)))
  const hidden: string[] = []
  const failed: { profile: string; error: unknown }[] = []
  results.forEach((r, i) => {
    const profile = profiles[i]!
    if (r.status === 'fulfilled') hidden.push(profile)
    else failed.push({ profile, error: r.reason })
  })
  return { hidden, failed }
}

/** Profil d'origine connu : un seul profil voit la conversation (sinon `null`, origine inconnue). */
export function pastOrigin(p: Pick<PastEntry, 'profile' | 'profiles'>): string | null {
  return p.profiles.length <= 1 ? p.profile : null
}

/**
 * Fusion des entrées d'une même conversation vues par plusieurs profils : la
 * plus récente sert de base, les champs qui lui manquent sont pris aux autres.
 */
function mergePast(entries: PastSession[]): PastSession {
  const [base, ...rest] = [...entries].sort((a, b) => pastTime(b) - pastTime(a))
  const out: Record<string, unknown> = { ...base }
  for (const e of rest) {
    for (const [k, v] of Object.entries(e)) if ((out[k] === null || out[k] === undefined) && v !== null && v !== undefined) out[k] = v
  }
  const counts = entries.map((e) => e.message_count).filter((n): n is number => typeof n === 'number')
  if (counts.length) out.message_count = Math.max(...counts)
  return out as unknown as PastSession
}

/** Dernière activité d'une ancienne session (ms depuis l'époque, 0 si inconnue). */
export function pastTime(p: Pick<PastSession, 'last_activity' | 'last_timestamp'>): number {
  return time(p.last_activity ?? p.last_timestamp)
}

/** Le dossier d'une ancienne session a-t-il disparu (worktree supprimé…) ? */
export function pastFolderMissing(p: Pick<PastSession, 'cwd' | 'cwd_exists'>, projects: Record<string, ProjectInfo>): boolean {
  // `cwd_exists` du démon fait foi quand il est donné ; sinon, la résolution mise en cache.
  if (typeof p.cwd_exists === 'boolean') return !p.cwd_exists
  return !!p.cwd && projects[p.cwd]?.exists === false
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
  /** Le dossier du groupe a disparu (déplacé ou supprimé, sans dépôt retrouvé). */
  missing: boolean
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
    let missing = false
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
      const top = info.root ?? info.worktree_root ?? p.cwd
      key = `git:${info.common_dir ?? top}`
      root = top
      name = info.name ?? basename(top)
      isGit = true
    } else {
      // Hors dépôt : le dossier ; pour un dossier disparu, l'ancêtre retenu par le
      // démon, sinon le plus haut ancêtre disparu (voir `missingGroupDir`).
      const gone = missingGroupDir(p.cwd, projects)
      if (gone) missing = true
      const dir = gone ?? (info.root || p.cwd)
      key = `dossier:${dir}`
      root = dir
      name = folderName(dir, home)
    }
    let g = groups.get(key)
    if (!g) {
      g = { key, name, root, isGit, entries: [], latest: 0, missing }
      groups.set(key, g)
    }
    g.entries.push(p)
    g.latest = Math.max(g.latest, pastTime(p))
  }
  const list = mergeMovedGroups([...groups.values()], (into, from) => {
    into.entries.push(...from.entries)
    into.latest = Math.max(into.latest, from.latest)
  }, (g) => g.entries.some((e) => !!e.git_branch))
  for (const g of list) g.entries.sort((a, b) => pastTime(b) - pastTime(a))
  return list.sort((a, b) => b.latest - a.latest || a.name.localeCompare(b.name, 'fr') || a.key.localeCompare(b.key))
}

/**
 * Anciennes sessions à proposer : celles des transcripts que le démon ne
 * connaît pas déjà, de la plus récente à la plus ancienne, chaque
 * conversation une seule fois (par `claude_session_id`) même quand plusieurs
 * profils la voient (dossier `projects/` partagé entre les profils).
 */
export function pastToOffer(
  past: Record<string, PastSession[]>,
  sessions: Session[],
  limit = 20,
  /** Ordre des profils (`profiles.list`) : `profiles` y est trié, `profile` (le premier) est donc déterministe. */
  order: readonly string[] = [],
): PastEntry[] {
  const known = new Set(sessions.map((s) => s.claude_session_id).filter(Boolean))
  const byId = new Map<string, { profiles: string[]; entries: PastSession[] }>()
  for (const [profile, list] of Object.entries(past)) {
    for (const p of list) {
      if (known.has(p.claude_session_id)) continue
      let g = byId.get(p.claude_session_id)
      if (!g) {
        g = { profiles: [], entries: [] }
        byId.set(p.claude_session_id, g)
      }
      if (!g.profiles.includes(profile)) g.profiles.push(profile)
      g.entries.push(p)
    }
  }
  const rank = (n: string) => {
    const i = order.indexOf(n)
    return i < 0 ? order.length : i
  }
  const all: PastEntry[] = [...byId.values()].map((g) => {
    const profiles = [...g.profiles].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    return { ...mergePast(g.entries), profile: profiles[0]!, profiles }
  })
  all.sort((a, b) => pastTime(b) - pastTime(a))
  return all.slice(0, limit)
}
