/**
 * Worktrees d'un projet (v0.2, lot 6) : états affichés, choix par défaut du
 * dialogue « Nettoyer les worktrees », pertes à annoncer avant suppression.
 * Calculs purs, testables sans DOM.
 */
import type { WorktreeInfo, WorktreeRemoved, WorktreesList } from '../../../shared/protocol'
import { collator, t } from '../../../shared/i18n'
import { daemonText } from './errors'
import { cleanupCandidate, hasOwnWork, isIntegrated, protectedBranches } from '../../../shared/worktrees'

export { cleanupCandidate, isIntegrated, protectedBranches }

/**
 * Worktrees vus avec du travail à eux (non intégrés ou en avance), par
 * chemin : une branche `merged` ne compte comme intégrée (badge, coche) que
 * si elle a eu des commits à elle, ou si l'app l'a créée.
 */
export function noteWork(seen: Set<string>, list: readonly WorktreeInfo[]): void {
  for (const w of list) if (hasOwnWork(w)) seen.add(w.path)
}

/** Candidat au nettoyage selon ce qui a été vu (`seen` : voir `noteWork`). */
export function candidate(w: WorktreeInfo, seen: ReadonlySet<string> | undefined): boolean {
  return cleanupCandidate(w, !!seen?.has(w.path))
}

/** Listes connues, par racine de dépôt. */
export type WorktreeLists = Record<string, WorktreesList>

export type WorktreeStateKind = 'integrated' | 'empty' | 'ahead' | 'dirty' | 'running' | 'desktop' | 'missing' | 'locked'

export interface WorktreeState {
  kind: WorktreeStateKind
  /** Libellé (jamais la couleur seule : texte et symbole). */
  label: string
  icon: string
  /** Ton de la pastille (classes `.chip`). */
  tone: 'ok' | 'pend' | 'bad' | 'muted'
}

/** États d'un worktree, dans l'ordre d'affichage. */
export function worktreeStates(w: WorktreeInfo): WorktreeState[] {
  const out: WorktreeState[] = []
  if (isIntegrated(w)) {
    out.push({
      kind: 'integrated',
      label: w.integrated === 'squashed' ? t('sessions.worktree.integratedSquashed') : t('sessions.worktree.integrated'),
      icon: '✓',
      tone: 'ok',
    })
  } else if (w.integrated === 'empty') {
    out.push({ kind: 'empty', label: t('sessions.worktree.empty'), icon: '○', tone: 'muted' })
  } else if (w.integrated === 'no' && (w.ahead ?? 0) > 0) {
    out.push({ kind: 'ahead', label: t('sessions.worktree.ahead', { count: w.ahead! }), icon: '↑', tone: 'pend' })
  } else if (w.integrated === 'no') {
    out.push({ kind: 'ahead', label: t('sessions.worktree.notIntegrated'), icon: '↑', tone: 'pend' })
  }
  if (w.dirty) out.push({ kind: 'dirty', label: t('sessions.worktree.dirty'), icon: '✎', tone: 'bad' })
  if ((w.sessions_running ?? 0) > 0) {
    out.push({
      kind: 'running',
      label: t('sessions.worktree.running', { count: w.sessions_running }),
      icon: '▶',
      tone: 'muted',
    })
  }
  if (w.managed_by === 'claude_desktop') out.push({ kind: 'desktop', label: t('sessions.worktree.desktop'), icon: '◆', tone: 'muted' })
  if (!w.exists) out.push({ kind: 'missing', label: t('sessions.worktree.missing'), icon: '∅', tone: 'muted' })
  if (w.locked) out.push({ kind: 'locked', label: t('sessions.worktree.locked'), icon: '🔒', tone: 'muted' })
  return out
}

/** Le démon refuserait la suppression (principal, session vivante). */
export function removable(w: WorktreeInfo): boolean {
  return !w.main && (w.sessions_running ?? 0) === 0
}

/**
 * Coché par défaut dans le dialogue de nettoyage : candidat au nettoyage
 * (intégré de façon crédible, sans session, hors Claude Desktop) **et** sans
 * modification non commitée (rien ne serait perdu). Une branche neuve
 * (`empty`, ou jamais vue en avance) n'est pas cochée.
 */
export function defaultChecked(w: WorktreeInfo, seen?: ReadonlySet<string>): boolean {
  return removable(w) && candidate(w, seen) && w.dirty !== true && !w.locked
}

/** La branche peut-elle être supprimée avec le worktree (pas la branche par défaut ni la référence) ? */
export function branchDeletable(w: WorktreeInfo, protectedSet: ReadonlySet<string>): boolean {
  return !!w.branch && !protectedSet.has(w.branch)
}

/** « Supprimer aussi la branche » coché par défaut : branche intégrée ou sans commit à elle. */
export function defaultDeleteBranch(w: WorktreeInfo, protectedSet: ReadonlySet<string> = new Set()): boolean {
  return branchDeletable(w, protectedSet) && (isIntegrated(w) || w.integrated === 'empty')
}

export interface CleanupChoice {
  remove: boolean
  deleteBranch: boolean
}

/** Choix initiaux du dialogue (par chemin) ; `focus` : worktree visé par « Nettoyer… », coché s'il est supprimable. */
export function initialChoices(
  list: readonly WorktreeInfo[],
  focus: string | null = null,
  opts: { seen?: ReadonlySet<string>; protectedSet?: ReadonlySet<string> } = {},
): Record<string, CleanupChoice> {
  const out: Record<string, CleanupChoice> = {}
  for (const w of list) {
    if (w.main) continue
    const focused = focus === w.path && removable(w) && w.managed_by !== 'claude_desktop' && w.dirty !== true
    out[w.path] = { remove: defaultChecked(w, opts.seen) || focused, deleteBranch: defaultDeleteBranch(w, opts.protectedSet) }
  }
  return out
}

/** Worktrees listés dans le dialogue : tous sauf le principal, intégrés d'abord puis par branche. */
export function cleanupRows(list: readonly WorktreeInfo[], seen?: ReadonlySet<string>): WorktreeInfo[] {
  return list
    .filter((w) => !w.main)
    .sort(
      (a, b) =>
        Number(candidate(b, seen)) - Number(candidate(a, seen)) ||
        collator().compare(a.branch ?? a.path, b.branch ?? b.path),
    )
}

/**
 * Ce qui sera perdu en supprimant ce worktree (phrases dans la langue courante) : vide
 * si rien (branche intégrée, aucune modification). `force` : suppression
 * forcée (modifications non commitées perdues, branche supprimée même non
 * intégrée).
 */
export function lossesFor(w: WorktreeInfo, deleteBranch: boolean, force = false): string[] {
  const out: string[] = []
  if (w.dirty) {
    out.push(
      force
        ? t('sessions.worktree.lossDirtyForce')
        : t('sessions.worktree.lossDirty'),
    )
  }
  // `empty` : branche créée par le démon, encore sur son commit de départ (aucun commit à elle ; supprimée par `-D`).
  if (deleteBranch && w.branch && !isIntegrated(w) && w.integrated !== 'empty' && (w.ahead ?? 0) > 0) {
    out.push(
      force
        ? t('sessions.worktree.lossCommitsForce', { count: w.ahead!, branch: w.branch })
        : t('sessions.worktree.lossCommits', { count: w.ahead!, branch: w.branch }),
    )
  }
  return out
}

/** Worktree (le plus profond) qui contient `cwd`, ou `undefined`. */
export function worktreeOf(cwd: string, list: readonly WorktreeInfo[] | undefined): WorktreeInfo | undefined {
  let best: WorktreeInfo | undefined
  for (const w of list ?? []) {
    const p = w.path.replace(/\/+$/, '')
    if ((cwd === p || cwd.startsWith(p + '/')) && (!best || p.length > best.path.length)) best = w
  }
  return best
}

/** Nombre de worktrees candidats au nettoyage d'un dépôt. */
export function cleanupCount(list: WorktreesList | undefined, seen?: ReadonlySet<string>): number {
  return (list?.worktrees ?? []).filter((w) => candidate(w, seen)).length
}

/** Résultat d'une suppression, pour la ligne du dialogue (le démon fait foi pour la branche). */
export function removedText(r: Pick<WorktreeRemoved, 'branch' | 'branch_deleted' | 'branch_error'> | null | undefined, branch: string | null): string {
  const b = r?.branch ?? branch
  if (r?.branch_deleted === true) return b ? t('sessions.worktree.removedBranch', { branch: b }) : t('sessions.worktree.removedBranchAnon')
  if (r?.branch_deleted === false) {
    // Raison donnée par le démon (sortie de git) : texte libre, montré tel quel.
    const reason = r.branch_error?.trim()
    return t('sessions.worktree.removedBranchKept', { reason: reason ? daemonText(reason) : t('sessions.worktree.unknownReason') })
  }
  return t('sessions.worktree.removed')
}

/** Liste courte des fichiers modifiés donnée par le démon avec -32020 (`data`), si elle est lisible. */
export function dirtyFiles(data: unknown): string[] {
  const pick = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 20) : [])
  if (Array.isArray(data)) return pick(data)
  if (data && typeof data === 'object') return pick((data as { files?: unknown }).files)
  return []
}
