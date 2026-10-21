/**
 * Contenu venu de la forge, commun aux issues et aux demandes de fusion.
 *
 * Étiquettes : couleur de la forge validée, texte noir ou blanc lisible,
 * nom toujours écrit (jamais la couleur seule).
 *
 * Texte Markdown venu de la forge (corps d'issue, description d'une demande
 * de fusion, commentaire de revue) : contenu **non fiable**. Contrôles et
 * caractères invisibles retirés avant le rendu ; Markdown sans HTML brut ni
 * image chargée ; liens externes ouverts seulement par la confirmation des
 * liens, ancres internes suivies, le reste inerte.
 */
import { useMemo, useRef, type MouseEvent } from 'react'

import type { IssueLabel } from '../../../shared/protocol'
import { cleanForge, invisibleNote, labelColors, oneLine } from '../state/forge'
import { classifyLink, renderMarkdown } from '../state/markdown'

export function ForgeMarkdown({
  text,
  idPrefix,
  onLink,
  empty = 'Aucune description.',
  what = 'de la description',
  truncated = false,
  className = 'md issue-md',
}: {
  text: string | null | undefined
  /** Préfixe des ancres (unique dans la vue). */
  idPrefix: string
  onLink: (url: string) => void
  empty?: string
  /** « de la description », « du commentaire » : complète la mention des caractères retirés. */
  what?: string
  /** Texte coupé par le démon (64 Kio au plus). */
  truncated?: boolean | null
  className?: string
}) {
  const ref = useRef<HTMLElement>(null)
  const clean = useMemo(() => cleanForge(text ?? ''), [text])
  const html = useMemo(() => (clean.text.trim() ? renderMarkdown(clean.text, { idPrefix }).html : null), [clean.text, idPrefix])
  const note = invisibleNote(clean.invisible)
  function onClick(e: MouseEvent<HTMLElement>) {
    const a = (e.target as HTMLElement).closest('a')
    if (!a) return
    e.preventDefault()
    const t = classifyLink(a.getAttribute('href'), '')
    if (t.kind === 'external') onLink(t.url)
    else if (t.kind === 'anchor') ref.current?.querySelector(`[id="${idPrefix}-${CSS.escape(t.id)}"]`)?.scrollIntoView({ block: 'start' })
  }
  if (!html) return <p className="hint">{empty}</p>
  return (
    <>
      {note && (
        <p className="chip pend" role="note">
          {note} {what}
        </p>
      )}
      {truncated && (
        <p className="ag-cut" role="note">
          Texte coupé par le démon (64 Kio au plus) : la suite est sur la forge.
        </p>
      )}
      {/* HTML produit par markdown-it sans HTML brut (échappé) ni image chargée, comme l'onglet Fichiers. */}
      <article ref={ref} className={className} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
    </>
  )
}

export function IssueLabels({ labels }: { labels: readonly IssueLabel[] | null | undefined }) {
  if (!labels?.length) return null
  return (
    <span className="ilabels">
      {labels.map((l, i) => {
        const c = labelColors(l.color)
        const name = oneLine(l.name)
        return (
          <span
            key={`${name}-${i}`}
            className={`ilabel${c ? ' colored' : ''}`}
            style={c ? { background: c.background, color: c.color, borderColor: c.background } : undefined}
            title={`Étiquette : ${name}`}
          >
            <span className="ldot" aria-hidden="true" />
            {name}
          </span>
        )
      })}
    </span>
  )
}
