/**
 * Fenêtre « Nouvelle session » : projets connus (sessions et transcripts,
 * groupés par dépôt, du plus récent au plus ancien), profil par défaut d'un
 * projet, sessions à reprendre. Calculs purs, testables sans DOM.
 */
import type { PastSession, ProjectInfo, Session } from '../../../shared/protocol'
import { getLocale, t } from '../../../shared/i18n'
import { rootFromCommonDir } from '../../../shared/worktrees'
import { basename, resumeBlock, tildify } from './format'
import { folderName, pastTime } from './projects'

export interface DirChoice {
  path: string
  /** Chemin raccourci (« ~/… »). */
  label: string
  /** Branche vue le plus récemment dans ce dossier. */
  branch: string | null
}

export interface ProjectChoice {
  /** `git:<dossier commun>` ou `dossier:<chemin>`. */
  key: string
  name: string
  /** Racine (dépôt principal ou dossier) : dossier proposé en premier. */
  root: string
  /** Clé du profil par défaut du projet (réglages) : identité du dépôt, pas d'un worktree. */
  profileKey: string
  isGit: boolean
  /** Dossiers où lancer (racine d'abord, puis worktrees connus). */
  dirs: DirChoice[]
  /** Activité la plus récente (ms). */
  latest: number
  /** Profil utilisé le plus récemment dans ce projet. */
  recentProfile: string | null
}

function time(iso: string | null | undefined): number {
  const t = Date.parse(iso ?? '')
  return Number.isNaN(t) ? 0 : t
}

/** Clé de projet d'un dossier : le dépôt (tous worktrees confondus) ou le dossier. */
export function projectKeyOf(cwd: string, info: ProjectInfo | undefined): string {
  if (info?.is_git) return `git:${info.common_dir ?? info.root ?? info.worktree_root ?? cwd}`
  return `dossier:${info?.root || cwd}`
}

/** Clé de projet d'une session : son identité enregistrée (lot 6) d'abord, sinon déduite du dossier. */
export function sessionProjectKey(s: Pick<Session, 'cwd' | 'project_common_dir'>, info: ProjectInfo | undefined): string {
  return s.project_common_dir ? `git:${s.project_common_dir}` : projectKeyOf(s.cwd, info)
}

/**
 * Clé du profil par défaut d'un projet : pour un dépôt, la racine de son
 * worktree principal déduite du dossier commun (`<racine>/.git`), la même
 * quel que soit le worktree d'où on la calcule ; sinon le dossier.
 */
export function profileKeyOf(cwd: string, info: ProjectInfo | undefined): string {
  if (info?.is_git) {
    const common = info.common_dir?.replace(/\/+$/, '')
    if (common && common.endsWith('/.git') && common.length > '/.git'.length) return common.slice(0, -'/.git'.length)
    return info.root ?? common ?? info.worktree_root ?? cwd
  }
  return info?.root || cwd
}

/**
 * Projets connus et projets ajoutés par « Autre dossier… » : un dossier choisi
 * dans un dépôt déjà connu s'ajoute aux dossiers de ce dépôt (le choix du
 * dossier reste cohérent avec ce qui sera lancé) ; un projet nouveau passe en tête.
 */
export function mergeExtraChoices(known: ProjectChoice[], extras: ProjectChoice[]): ProjectChoice[] {
  const out = known.map((c) => ({ ...c, dirs: [...c.dirs] }))
  const fresh: ProjectChoice[] = []
  for (const x of extras) {
    const c = out.find((k) => k.key === x.key) ?? fresh.find((k) => k.key === x.key)
    if (!c) {
      fresh.push({ ...x, dirs: [...x.dirs] })
      continue
    }
    for (const d of x.dirs) if (!c.dirs.some((k) => k.path === d.path)) c.dirs.push(d)
  }
  return [...fresh, ...out]
}

interface Seen {
  cwd: string
  /** Identité de projet enregistrée par le démon (sessions seulement). */
  commonDir: string | null
  at: number
  /** `null` : profil d'origine inconnu (ancienne session vue par plusieurs profils). */
  profile: string | null
  branch: string | null
  missing: boolean
}

/** Ancienne session telle que proposée (`PastEntry`) ; `profiles` absent : seul `profile` la voit. */
export type PastLike = PastSession & { profile: string; profiles?: string[] }

/** Profils qui voient une ancienne session. */
export function pastProfiles(p: PastLike): string[] {
  return p.profiles?.length ? p.profiles : [p.profile]
}

export function buildProjectChoices(args: {
  sessions: Session[]
  past: PastLike[]
  projects: Record<string, ProjectInfo>
  home: string | null
}): ProjectChoice[] {
  const { projects, home } = args
  const seen: Seen[] = [
    ...args.sessions.map((s) => ({
      cwd: s.cwd,
      commonDir: s.project_common_dir || null,
      at: time(s.last_activity ?? s.created_at),
      profile: s.profile,
      branch: s.branch,
      missing: s.resume_blocker === 'cwd_missing' || (s.resume_blocker === undefined && projects[s.cwd]?.exists === false),
    })),
    ...args.past.flatMap((p) =>
      p.cwd
        ? [
            {
              cwd: p.cwd,
              commonDir: null,
              at: pastTime(p),
              // Vue par plusieurs profils (`projects/` partagé) : profil d'origine inconnu.
              profile: pastProfiles(p).length > 1 ? null : p.profile,
              branch: p.git_branch,
              missing: typeof p.cwd_exists === 'boolean' ? !p.cwd_exists : projects[p.cwd]?.exists === false,
            },
          ]
        : [],
    ),
  ]
  const byKey = new Map<string, ProjectChoice & { dirAt: Map<string, { at: number; branch: string | null }> }>()
  for (const x of seen) {
    const info = projects[x.cwd]
    const key = x.commonDir ? `git:${x.commonDir}` : projectKeyOf(x.cwd, info)
    const isGit = !!info?.is_git || !!x.commonDir
    // Dossier non résolu (worktree supprimé) mais identité connue : racine déduite du dossier commun.
    const identityRoot = !info?.is_git && x.commonDir ? rootFromCommonDir(x.commonDir) : null
    const root = identityRoot ?? (isGit ? (info?.root ?? info?.worktree_root ?? x.cwd) : info?.root || x.cwd)
    let c = byKey.get(key)
    if (!c) {
      c = {
        key,
        name: isGit ? (info?.name ?? basename(root)) : folderName(root, home),
        root,
        profileKey: identityRoot ?? profileKeyOf(x.cwd, info),
        isGit,
        dirs: [],
        latest: 0,
        recentProfile: null,
        dirAt: new Map(),
      }
      byKey.set(key, c)
    }
    if (x.at >= c.latest) {
      c.latest = x.at
      if (x.profile) c.recentProfile = x.profile
    }
    // Un dossier disparu (worktree supprimé) n'est pas proposé pour lancer.
    if (x.missing) continue
    const dir = isGit ? (info?.worktree_root ?? x.cwd) : x.cwd
    const prev = c.dirAt.get(dir)
    if (!prev || x.at >= prev.at) c.dirAt.set(dir, { at: x.at, branch: x.branch ?? prev?.branch ?? null })
  }
  const out: ProjectChoice[] = []
  for (const c of byKey.values()) {
    const entries = [...c.dirAt.entries()].sort((a, b) => b[1].at - a[1].at)
    const dirs: DirChoice[] = entries.map(([path, v]) => ({ path, label: tildify(path, home), branch: v.branch }))
    // La racine d'abord (même sans session dedans), puis les worktrees par activité.
    const i = dirs.findIndex((d) => d.path === c.root)
    if (i > 0) dirs.unshift(dirs.splice(i, 1)[0]!)
    else if (i < 0 && !(c.root in projects && projects[c.root]?.exists === false)) {
      dirs.unshift({ path: c.root, label: tildify(c.root, home), branch: null })
    }
    const { dirAt: _d, ...rest } = c
    out.push({ ...rest, dirs })
  }
  return out.sort((a, b) => b.latest - a.latest || a.name.localeCompare(b.name, getLocale()))
}

export type ProfileSource = 'project' | 'recent' | 'global'

/**
 * Profil proposé pour un projet : celui réglé pour le projet (Réglages ›
 * Général), sinon le dernier utilisé dans ce projet, sinon `default` (ou le
 * premier profil). Un profil qui n'existe plus est ignoré.
 */
export function resolveDefaultProfile(args: {
  projectRoot: string | null
  projectProfiles: Record<string, string>
  profiles: readonly string[]
  recent: string | null
}): { profile: string; source: ProfileSource } {
  const { projectRoot, projectProfiles, profiles, recent } = args
  const exists = (p: string | null | undefined): p is string => !!p && profiles.includes(p)
  const set = projectRoot ? projectProfiles[projectRoot] : undefined
  if (exists(set)) return { profile: set, source: 'project' }
  if (exists(recent)) return { profile: recent, source: 'recent' }
  return { profile: profiles.includes('default') ? 'default' : (profiles[0] ?? 'default'), source: 'global' }
}

/**
 * Profil par défaut pour reprendre une ancienne session : `preferred` (profil
 * du projet) s'il voit la conversation, sinon le premier profil qui la voit.
 */
export function pastResumeProfile(p: PastLike, preferred: string | null): string {
  const seen = pastProfiles(p)
  return preferred && seen.includes(preferred) ? preferred : (seen[0] ?? p.profile)
}

export type ResumeCandidate =
  | { kind: 'session'; key: string; session: Session; label: string; at: number; branch: string | null; profile: string }
  | {
      kind: 'past'
      key: string
      past: PastLike
      label: string
      at: number
      branch: string | null
      /** Profil proposé par défaut (voir `pastResumeProfile`). */
      profile: string
      /** Profils qui voient la conversation : un seul, c'est son origine ; plusieurs, origine inconnue. */
      profiles: string[]
    }

/**
 * Sessions d'un projet qu'on peut reprendre : sessions arrêtées du démon
 * reprenables, et anciennes sessions des transcripts dont le dossier existe.
 */
export function resumeCandidates(args: {
  projectKey: string
  sessions: Session[]
  past: PastLike[]
  projects: Record<string, ProjectInfo>
  label: (x: Session | PastSession) => string
}): ResumeCandidate[] {
  const { projectKey, projects } = args
  const out: ResumeCandidate[] = []
  for (const s of args.sessions) {
    if (s.alive || sessionProjectKey(s, projects[s.cwd]) !== projectKey) continue
    if (resumeBlock(s, projects[s.cwd])) continue
    out.push({
      kind: 'session',
      key: `s:${s.id}`,
      session: s,
      label: args.label(s),
      at: time(s.last_activity ?? s.created_at),
      branch: s.branch,
      profile: s.profile,
    })
  }
  for (const p of args.past) {
    if (!p.cwd || projectKeyOf(p.cwd, projects[p.cwd]) !== projectKey) continue
    if (p.cwd_exists === false || (p.cwd_exists === undefined && projects[p.cwd]?.exists === false)) continue
    out.push({
      kind: 'past',
      key: `p:${p.claude_session_id}`,
      past: p,
      label: args.label(p),
      at: pastTime(p),
      branch: p.git_branch,
      profile: p.profile,
      profiles: pastProfiles(p),
    })
  }
  return out.sort((a, b) => b.at - a.at)
}

/** Alias de modèles de Claude Code (le CLI choisit la version) ; vide = celui du profil. */
export function modelAliases(): readonly { value: string; label: string }[] {
  return [
    { value: '', label: t('sessions.new.modelDefault') },
    { value: 'opus', label: 'Opus' },
    { value: 'sonnet', label: 'Sonnet' },
    { value: 'haiku', label: 'Haiku' },
  ]
}
