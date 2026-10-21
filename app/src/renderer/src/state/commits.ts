/**
 * Onglet « Commits » (v0.3, lot 9) : libellés et état gardé par session.
 * Calculs purs, testables sans DOM.
 */
import { ErrorCode, type CommitInfo, type CommitRange, type CommitsList } from '../../../shared/protocol'
import { dateFormat, t } from '../../../shared/i18n'
import { relativeTime } from './format'

/** Message d'une erreur de `sessions.commits*` (méthode inconnue : démon trop ancien). */
export function commitsErrorText(code: number | null, text: string, what: string): string {
  return code === ErrorCode.MethodNotFound ? t('files.commits.oldDaemon') : t('files.errorWith', { what, text })
}

export function otherRange(r: CommitRange): CommitRange {
  return r === 'branch' ? 'recent' : 'branch'
}

function baseName(list: Pick<CommitsList, 'base'>): string {
  const b = list.base
  if (!b) return t('files.commits.theBase')
  return b.ref || b.sha.slice(0, 7) || t('files.commits.theBase')
}

/** « Commits de la branche depuis main » ou « Derniers commits de feature/x ». */
export function rangeLabel(list: Pick<CommitsList, 'range' | 'base'>, branch: string | null | undefined): string {
  return list.range === 'branch'
    ? t('files.commits.rangeBranch', { base: baseName(list) })
    : t('files.commits.rangeRecent', { branch: branch || 'HEAD' })
}

/** Libellé du bouton qui force l'autre mode. */
export function toggleRangeLabel(list: Pick<CommitsList, 'range' | 'base'>, branch: string | null | undefined): string {
  return list.range === 'branch'
    ? t('files.commits.toggleRecent', { branch: branch || 'HEAD' })
    : t('files.commits.toggleBranch', { base: baseName(list) })
}

/** Liste vide : pourquoi. */
export function emptyLabel(list: Pick<CommitsList, 'range' | 'head'>): string {
  if (list.head === null) return t('files.commits.emptyNoHead')
  return list.range === 'branch' ? t('files.commits.emptyBranch') : t('files.commits.empty')
}

/** « compteurs indisponibles (dépôt volumineux) », dans la langue courante. */
export function noStats(): string {
  return t('files.commits.noStats')
}

/** Le démon a-t-il calculé les compteurs ? (champ absent : ancien démon, oui). */
export function statsOf(list: Pick<CommitsList, 'stats'>): boolean {
  return list.stats !== false
}

/** Compteurs d'un commit connus (jamais affichés à 0 quand le démon ne les a pas calculés). */
export function hasCounts(
  c: Pick<CommitInfo, 'files' | 'additions' | 'deletions'>,
): c is Pick<CommitInfo, 'files' | 'additions' | 'deletions'> & { files: number; additions: number; deletions: number } {
  return typeof c.files === 'number' && typeof c.additions === 'number' && typeof c.deletions === 'number'
}

/** « 3 fichiers », « 1 fichier », « aucun fichier ». */
export function filesLabel(n: number): string {
  return n === 0 ? t('files.commits.noFiles') : t('files.filesCount', { count: n })
}

/** « +12 −3 » (signe moins typographique), ou « compteurs indisponibles (dépôt volumineux) ». */
export function countsLabel(c: Pick<CommitInfo, 'files' | 'additions' | 'deletions'>): string {
  return hasCounts(c) ? `+${c.additions} −${c.deletions}` : noStats()
}

/** Libellé accessible d'un commit de la liste. */
export function commitAriaLabel(c: CommitInfo, now = Date.now()): string {
  const head = t('files.commits.ariaHead', {
    subject: c.subject || t('files.commits.noMessage'),
    author: c.author || t('files.commits.unknownAuthor'),
    when: relativeTime(c.date, now),
  })
  if (!hasCounts(c)) return `${head}, ${noStats()}`
  return `${head}, ${filesLabel(c.files)}, ${t('files.additions', { count: c.additions })}, ${t('files.deletions', { count: c.deletions })}`
}

/** Date complète (infobulle) : « 20/10/2026 15:15 ». */
export function fullDate(iso: string): string {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return iso
  return dateFormat({ dateStyle: 'short', timeStyle: 'short' }).format(new Date(ms))
}

/** Commit suivant ou précédent (borné). */
export function stepCommit(commits: readonly CommitInfo[], current: string | null, delta: 1 | -1): string | null {
  if (commits.length === 0) return null
  const i = commits.findIndex((c) => c.sha === current)
  if (i < 0) return commits[0]!.sha
  return commits[Math.max(0, Math.min(commits.length - 1, i + delta))]!.sha
}

/** État de l'onglet gardé par session (hors du composant). */
export interface CommitsMemory {
  /** Mode forcé par l'utilisateur ; `null` : choix automatique du démon. */
  range: CommitRange | null
  sha: string | null
  path: string | null
  listScroll: number
  diffScroll: number
  /** Messages complets dépliés. */
  open: Set<string>
  /** Dernière demande d'ouverture traitée (liste de la revue). */
  focusN: number
}

const memory = new Map<string, CommitsMemory>()

export function commitsMemoryFor(id: string): CommitsMemory {
  let m = memory.get(id)
  if (!m) {
    m = { range: null, sha: null, path: null, listScroll: 0, diffScroll: 0, open: new Set(), focusN: 0 }
    memory.set(id, m)
  }
  return m
}

export function forgetCommitsMemory(id: string): void {
  memory.delete(id)
}

/** Commit à montrer après une (re)lecture de la liste : le choisi s'il y est encore, sinon le premier. */
export function pickCommit(commits: readonly CommitInfo[], wanted: string | null): string | null {
  if (wanted && commits.some((c) => c.sha === wanted)) return wanted
  return commits[0]?.sha ?? null
}
