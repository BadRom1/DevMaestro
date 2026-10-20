/**
 * Onglet « Commits » (v0.3, lot 9) : libellés et état gardé par session.
 * Calculs purs, testables sans DOM.
 */
import { ErrorCode, type CommitInfo, type CommitRange, type CommitsList } from '../../../shared/protocol'
import { relativeTime } from './format'

export const OLD_DAEMON_COMMITS = 'Le démon ne sait pas encore lire l’historique des commits : mets orchd à jour.'

/** Message d'une erreur de `sessions.commits*` (méthode inconnue : démon trop ancien). */
export function commitsErrorText(code: number | null, text: string, what: string): string {
  return code === ErrorCode.MethodNotFound ? OLD_DAEMON_COMMITS : `${what} : ${text}`
}

export function otherRange(r: CommitRange): CommitRange {
  return r === 'branch' ? 'recent' : 'branch'
}

function baseName(list: Pick<CommitsList, 'base'>): string {
  const b = list.base
  if (!b) return 'la base'
  return b.ref || b.sha.slice(0, 7) || 'la base'
}

/** « Commits de la branche depuis main » ou « Derniers commits de feature/x ». */
export function rangeLabel(list: Pick<CommitsList, 'range' | 'base'>, branch: string | null | undefined): string {
  return list.range === 'branch' ? `Commits de la branche depuis ${baseName(list)}` : `Derniers commits de ${branch || 'HEAD'}`
}

/** Libellé du bouton qui force l'autre mode. */
export function toggleRangeLabel(list: Pick<CommitsList, 'range' | 'base'>, branch: string | null | undefined): string {
  return list.range === 'branch' ? `Voir les derniers commits de ${branch || 'HEAD'}` : `Voir les commits de la branche depuis ${baseName(list)}`
}

/** Liste vide : pourquoi. */
export function emptyLabel(list: Pick<CommitsList, 'range' | 'head'>): string {
  if (list.head === null) return 'Aucun commit pour l’instant.'
  return list.range === 'branch' ? 'Aucun commit sur la branche depuis la base.' : 'Aucun commit.'
}

export const NO_STATS = 'compteurs indisponibles (dépôt volumineux)'

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
  return n === 0 ? 'aucun fichier' : `${n} fichier${n > 1 ? 's' : ''}`
}

/** « +12 −3 » (signe moins typographique), ou « compteurs indisponibles (dépôt volumineux) ». */
export function countsLabel(c: Pick<CommitInfo, 'files' | 'additions' | 'deletions'>): string {
  return hasCounts(c) ? `+${c.additions} −${c.deletions}` : NO_STATS
}

/** Libellé accessible d'un commit de la liste. */
export function commitAriaLabel(c: CommitInfo, now = Date.now()): string {
  const head = `${c.subject || '(sans message)'}, par ${c.author || 'auteur inconnu'}, ${relativeTime(c.date, now)}`
  if (!hasCounts(c)) return `${head}, ${NO_STATS}`
  return `${head}, ${filesLabel(c.files)}, ${c.additions} ajout${c.additions > 1 ? 's' : ''}, ${c.deletions} suppression${c.deletions > 1 ? 's' : ''}`
}

/** Date complète (infobulle) : « 20/10/2026 15:15 ». */
export function fullDate(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return iso
  return new Date(t).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })
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
