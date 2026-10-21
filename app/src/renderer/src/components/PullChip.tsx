/**
 * « PR #n » et état de la CI dans l'en-tête d'une session (v0.3, lot 13b) :
 * demande de fusion ouverte dont la tête est la branche de la session
 * (`forge.pullForBranch`), relue toutes les 60 s tant que la session est
 * affichée (et la fenêtre visible). Forge indisponible, aucune demande ou
 * démon ancien : rien n'est affiché.
 */
import { useEffect, useState } from 'react'

import { call, errorCode } from '../api'
import { useT } from '../i18n'
import { BRANCH_PULL_REFRESH_MS, branchPullOf, checksLabel, pullsErrorKind, type BranchPull } from '../state/forgePulls'
import { branchNameProblem } from '../../../shared/worktrees'
import { ForgeBadge } from './PullsPanel'

/** Démon sans `forge.pullForBranch` (constaté une fois par connexion) : plus d'appel. */
let unsupported = false

/** Nouvelle connexion au démon : il peut avoir été mis à jour. */
export function resetBranchPullSupport(): void {
  unsupported = false
}

export function useBranchPull(root: string | null, branch: string | null, enabled: boolean): BranchPull | null {
  const [pull, setPull] = useState<BranchPull | null>(null)
  useEffect(() => {
    setPull(null)
    if (!enabled || !root || !root.startsWith('/') || !branch || branchNameProblem(branch) || unsupported) return
    let alive = true
    const load = async () => {
      if (unsupported) return
      try {
        const r = await call('forge.pullForBranch', { root, branch })
        if (alive) setPull(branchPullOf(r))
      } catch (e) {
        const kind = pullsErrorKind(errorCode(e))
        if (kind === 'old-daemon') unsupported = true
        // Forge indisponible, démon ancien : rien à afficher ; autre échec passager : dernier état gardé.
        if (alive && kind !== 'other') setPull(null)
      }
    }
    void load()
    const timer = setInterval(() => {
      if (!document.hidden) void load()
    }, BRANCH_PULL_REFRESH_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [root, branch, enabled])
  return pull
}

export function PullChip({ pull, onOpen }: { pull: BranchPull; onOpen?: () => void }) {
  const t = useT()
  const ci = checksLabel(pull.checks)
  const head = pull.title ? t('forge.pulls.chip.titleWith', { number: pull.number, title: pull.title }) : t('forge.pulls.chip.title', { number: pull.number })
  const title = `${head}${pull.draft ? t('forge.pulls.chip.draft') : ''} · ${ci.label}`
  const body = (
    <>
      {/* i18n-exempt: abréviation « PR » gardée dans les deux langues */}
      <span className="mono">PR #{pull.number}</span>
      <ForgeBadge b={ci} className="sm" />
    </>
  )
  if (!onOpen) {
    return (
      <span className="chip pull-chip" title={title}>
        {body}
      </span>
    )
  }
  return (
    <button type="button" className="chip pull-chip" title={t('forge.pulls.chip.openTitle', { title })} aria-label={t('forge.pulls.chip.openAria', { title })} onClick={onOpen}>
      {body}
    </button>
  )
}
