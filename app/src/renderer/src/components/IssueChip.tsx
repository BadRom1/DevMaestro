/** « #42 » d'une session liée à une issue : bouton vers le détail, ou texte si la forge est masquée. */
export function IssueChip({ issue, onOpen }: { issue: { number: number; title: string }; onOpen?: () => void }) {
  const title = `Issue #${issue.number}${issue.title ? ` : ${issue.title}` : ''}`
  if (!onOpen) {
    return (
      <span className="chip issue-chip mono" title={title}>
        #{issue.number}
      </span>
    )
  }
  return (
    <button type="button" className="chip issue-chip mono" title={`${title} (voir le détail)`} aria-label={`${title}, voir le détail`} onClick={onOpen}>
      #{issue.number}
    </button>
  )
}
