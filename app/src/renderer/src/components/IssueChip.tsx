import { useT } from '../i18n'

/** « #42 » d'une session liée à une issue : bouton vers le détail, ou texte si la forge est masquée. */
export function IssueChip({ issue, onOpen }: { issue: { number: number; title: string }; onOpen?: () => void }) {
  const t = useT()
  const title = issue.title ? t('forge.issues.chip.titleWith', { number: issue.number, title: issue.title }) : t('forge.issues.chip.title', { number: issue.number })
  if (!onOpen) {
    return (
      <span className="chip issue-chip mono" title={title}>
        #{issue.number}
      </span>
    )
  }
  return (
    <button
      type="button"
      className="chip issue-chip mono"
      title={t('forge.issues.chip.openTitle', { title })}
      aria-label={t('forge.issues.chip.openLabel', { title })}
      onClick={onOpen}
    >
      #{issue.number}
    </button>
  )
}
