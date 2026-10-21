/**
 * Worktrees (v0.2, lot 6) : règles pures partagées par le processus principal
 * (validation) et la page (dialogue « Nouvelle session ») : nom de branche
 * proposé, slug du dossier et chemin calculé, mêmes règles que le démon
 * (docs/v0.2.md, « Contrat du lot 6 »).
 */
import { t } from './i18n'
import type { WorktreeInfo } from './protocol'

export type WorktreeLocation = 'sibling' | 'in_repo' | 'managed' | 'custom'
/** Emplacements réglables (global ou par projet) : `custom` se choisit à la création seulement. */
export type DefaultWorktreeLocation = Exclude<WorktreeLocation, 'custom'>
export const WORKTREE_LOCATIONS: readonly WorktreeLocation[] = ['sibling', 'in_repo', 'managed', 'custom']
export const DEFAULT_WORKTREE_LOCATIONS: readonly DefaultWorktreeLocation[] = ['sibling', 'in_repo', 'managed']

/** Libellés des emplacements, lus à l'usage dans la langue courante (accesseurs). */
export const LOCATION_LABELS: Readonly<Record<WorktreeLocation, string>> = {
  get sibling() {
    return t('sessions.location.sibling')
  },
  get in_repo() {
    return t('sessions.location.inRepo')
  },
  get managed() {
    return t('sessions.location.managed')
  },
  get custom() {
    return t('sessions.location.custom')
  },
}

/** Longueur maximale du slug d'un dossier de worktree (règle du démon). */
export const MAX_WORKTREE_SLUG = 80
/** Longueur maximale d'un nom de branche accepté par l'app. */
export const MAX_BRANCH = 200
/** Longueur maximale du préfixe de branche (réglage). */
export const MAX_BRANCH_PREFIX = 40
/** Longueur maximale de la partie tirée du nom de la session. */
const MAX_BRANCH_FROM_NAME = 60

/**
 * Slug du dossier d'un worktree, comme le démon : `/` → `-`, tout caractère
 * hors `[A-Za-z0-9._-]` → `-` (un par caractère), 80 caractères au plus.
 */
export function worktreeSlug(branch: string): string {
  return [...branch]
    .map((c) => (/^[A-Za-z0-9._-]$/.test(c) ? c : '-'))
    .slice(0, MAX_WORKTREE_SLUG)
    .join('')
}

/**
 * Nom de branche proposé depuis le nom de la session : minuscules, accents
 * retirés, suite de caractères hors `[a-z0-9]` → un `-`, tirets de bord
 * retirés, 60 caractères au plus ; précédé du préfixe réglé (« romain/ »…).
 * Vide si le nom ne donne rien.
 */
export function branchFromName(name: string, prefix = ''): string {
  const base = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_BRANCH_FROM_NAME)
    .replace(/-+$/g, '')
  return base ? `${prefix}${base}` : ''
}

/**
 * Nom de branche acceptable (sous-ensemble prudent de `git check-ref-format
 * --branch`, que le démon applique de toute façon) : `null` si valide, sinon
 * la raison dans la langue courante (page et processus principal).
 */
export function branchNameProblem(name: string): string | null {
  if (name.trim() === '') return t('sessions.branch.empty')
  if ([...name].length > MAX_BRANCH) return t('sessions.branch.tooLong', { max: MAX_BRANCH })
  if (/[\u0000- \u007f~^:?*[\\]/.test(name)) return t('sessions.branch.badChar')
  if (name.startsWith('-')) return t('sessions.branch.dash')
  if (name.startsWith('/') || name.endsWith('/') || name.includes('//')) return t('sessions.branch.slash')
  if (name.includes('..') || name.includes('@{') || name === '@') return t('sessions.branch.dots')
  if (name.endsWith('.') || name.endsWith('.lock')) return t('sessions.branch.end')
  if (name.split('/').some((part) => part.startsWith('.'))) return t('sessions.branch.partDot')
  return null
}

/**
 * Branche libre proposée quand `branch` est déjà prise (extraite dans un
 * autre worktree, dossier existant) : la même avec un suffixe `-2`, `-3`…,
 * valide et non prise ; `null` au-delà de `-99`.
 */
export function nextFreeBranch(branch: string, taken: (b: string) => boolean): string | null {
  const b = branch.trim().replace(/[-/.]+$/, '')
  if (!b) return null
  for (let n = 2; n < 100; n++) {
    const c = `${b}-${n}`
    if (!branchNameProblem(c) && !taken(c)) return c
  }
  return null
}

/** Refus du lancement parce que la branche ou son dossier est déjà pris (message du démon ou de git). */
export function branchTakenError(message: string): boolean {
  // i18n-exempt: motifs des messages du démon (en français) et de git
  return /est déjà extraite|le dossier existe déjà|already exists|already checked out|is already used by worktree/i.test(message)
}

/** Préfixe de branche (réglage) : vide, ou un début de nom de branche valide (« romain/ », « feat- »). */
export function branchPrefixProblem(prefix: string): string | null {
  if (prefix === '') return null
  if ([...prefix].length > MAX_BRANCH_PREFIX) return t('sessions.branch.prefixTooLong', { max: MAX_BRANCH_PREFIX })
  // Un préfixe suivi d'un nom simple doit donner une branche valide.
  return branchNameProblem(`${prefix}x`) ? t('sessions.branch.prefixBadChar') : null
}

function trimSlash(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, '') : p
}

function parentOf(p: string): string {
  const t = trimSlash(p)
  const i = t.lastIndexOf('/')
  return i <= 0 ? '/' : t.slice(0, i)
}

function baseName(p: string): string {
  const parts = trimSlash(p).split('/').filter(Boolean)
  return parts[parts.length - 1] ?? p
}

function join(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${trimSlash(dir)}/${name}`
}

/**
 * Racine du worktree principal déduite du dossier commun (`<racine>/.git`),
 * ou `null` (dépôt nu, dossier commun ailleurs).
 */
export function rootFromCommonDir(commonDir: string | null | undefined): string | null {
  const c = commonDir ? trimSlash(commonDir) : ''
  return c.endsWith('/.git') && c.length > '/.git'.length ? c.slice(0, -'/.git'.length) : null
}

export interface WorktreePathInput {
  location: WorktreeLocation
  /** Racine du worktree principal du dépôt. */
  root: string
  branch: string
  /** `managed` : dossier des worktrees gérés (`$XDG_DATA_HOME/devmaestro/worktrees`). */
  managedDir?: string | null
  /** `managed` : 8 premiers caractères de l'empreinte du dossier commun (`commonDirHash8`). */
  commonDirHash?: string | null
  /** `custom` : dossier parent choisi. */
  customParent?: string | null
}

/**
 * 8 premiers caractères hexadécimaux de l'empreinte FNV-1a 64 bits du dossier
 * commun (octets UTF-8 du chemin), comme `common_dir_hash8` du démon.
 */
export function commonDirHash8(commonDir: string): string {
  let h = 0xcbf29ce484222325n
  for (const b of new TextEncoder().encode(commonDir)) {
    h ^= BigInt(b)
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return h.toString(16).padStart(16, '0').slice(0, 8)
}

/** Marque de l'empreinte quand le dossier commun est inconnu. */
export const HASH_PLACEHOLDER = '<empreinte>'

/**
 * Chemin du nouveau worktree, comme le démon le calcule :
 * - `sibling` : `<parent du dépôt>/<nom du dépôt>-<slug>` ;
 * - `in_repo` : `<racine>/.worktrees/<slug>` ;
 * - `managed` : `<dossier géré>/<nom du dépôt>-<empreinte>/<slug>` ;
 * - `custom` : `<dossier choisi>/<slug>`.
 * `null` si une donnée manque (branche vide, dossier géré ou parent inconnu).
 */
export function worktreePath(x: WorktreePathInput): string | null {
  const slug = worktreeSlug(x.branch.trim())
  // Le démon refuse un slug vide ou fait seulement de points.
  if (!slug || /^\.+$/.test(slug) || !x.root.startsWith('/')) return null
  const repo = baseName(x.root)
  switch (x.location) {
    case 'sibling':
      return join(parentOf(x.root), `${repo}-${slug}`)
    case 'in_repo':
      return join(join(x.root, '.worktrees'), slug)
    case 'managed':
      if (!x.managedDir?.startsWith('/')) return null
      return join(join(x.managedDir, `${repo}-${x.commonDirHash || HASH_PLACEHOLDER}`), slug)
    case 'custom':
      if (!x.customParent?.startsWith('/')) return null
      return join(x.customParent, slug)
  }
}

/** Branche intégrée à la branche de référence (fusionnée, ou contenu déjà repris). */
export function isIntegrated(w: Pick<WorktreeInfo, 'integrated'>): boolean {
  return w.integrated === 'merged' || w.integrated === 'squashed'
}

/** La branche a-t-elle du travail à elle (non intégrée, ou des commits absents de la référence) ? */
export function hasOwnWork(w: Pick<WorktreeInfo, 'integrated' | 'ahead'>): boolean {
  return w.integrated === 'no' || (w.ahead ?? 0) > 0
}

/**
 * Worktree à proposer au nettoyage (badge « intégrée », notification, coche
 * par défaut) : pas le principal, branche intégrée, aucune session vivante
 * dedans, pas géré par Claude Desktop (que le démon ne voit pas tourner), et
 * dont l'intégration est crédible : créé par l'app (le démon distingue la
 * branche neuve sans commit, `empty`), en avance maintenant (`squashed`), ou
 * vu auparavant avec du travail à lui (`seenWork`). Une branche neuve, encore
 * ancêtre de la référence faute de commit, n'est donc pas « intégrée ».
 */
export function cleanupCandidate(
  w: Pick<WorktreeInfo, 'main' | 'integrated' | 'sessions_running' | 'managed_by' | 'ahead'>,
  seenWork = false,
): boolean {
  if (w.main || !isIntegrated(w) || (w.sessions_running ?? 0) !== 0 || w.managed_by === 'claude_desktop') return false
  return w.managed_by === 'devmaestro' || seenWork || (w.ahead ?? 0) > 0
}

/**
 * Branches que le démon refuse de supprimer (`delete_branch` → -32602) : la
 * branche par défaut et la branche de référence (nom local, sans « origin/ »).
 */
export function protectedBranches(list: { default_branch?: string | null; reference?: string | null } | undefined): Set<string> {
  const out = new Set<string>()
  if (list?.default_branch) out.add(list.default_branch)
  if (list?.reference) {
    out.add(list.reference)
    out.add(list.reference.replace(/^origin\//, ''))
  }
  return out
}

/**
 * Dossier des worktrees gérés par l'app : `$XDG_DATA_HOME/devmaestro/worktrees`
 * (`~/.local/share` si la variable manque ou n'est pas absolue, règle XDG).
 */
export function managedWorktreesDir(xdgDataHome: string | undefined, home: string): string | null {
  const ok = (p: string | undefined): p is string => !!p && p.startsWith('/') && !p.includes('\0') && p.length <= 4000
  const base = ok(xdgDataHome) ? xdgDataHome : ok(home) ? join(home, '.local/share') : null
  return base ? join(join(base, 'devmaestro'), 'worktrees') : null
}
