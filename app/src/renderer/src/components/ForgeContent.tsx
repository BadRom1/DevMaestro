/**
 * Contenu venu de la forge, commun aux issues et aux demandes de fusion.
 *
 * Étiquettes (lot 15) : pastilles neutres, distinctes des boutons ; couleur
 * de la forge validée, en point seulement ; nom toujours écrit dans la
 * couleur du texte du thème (jamais la couleur seule).
 *
 * Texte Markdown venu de la forge (corps d'issue, description d'une demande
 * de fusion, commentaire de revue) : contenu **non fiable**. Contrôles et
 * caractères invisibles retirés avant le rendu ; Markdown sans HTML brut ni
 * image chargée ; liens externes ouverts seulement par la confirmation des
 * liens, ancres internes suivies, le reste inerte.
 */
import { useMemo, useRef, type MouseEvent } from 'react'

import type { IssueLabel } from '../../../shared/protocol'
import { useT } from '../i18n'
import { cleanForge, invisibleNote, labelColors, oneLine } from '../state/forge'
import { classifyLink, renderMarkdown } from '../state/markdown'

export function ForgeMarkdown({
  text,
  idPrefix,
  onLink,
  empty,
  what,
  truncated = false,
  className = 'md issue-md',
}: {
  text: string | null | undefined
  /** Préfixe des ancres (unique dans la vue). */
  idPrefix: string
  onLink: (url: string) => void
  /** Par défaut « Aucune description. ». */
  empty?: string
  /** « de la description », « du commentaire » : complète la mention des caractères retirés (défaut : « de la description »). */
  what?: string
  /** Texte coupé par le démon (64 Kio au plus). */
  truncated?: boolean | null
  className?: string
}) {
  const t = useT()
  const ref = useRef<HTMLElement>(null)
  const clean = useMemo(() => cleanForge(text ?? ''), [text])
  const html = useMemo(() => (clean.text.trim() ? renderMarkdown(clean.text, { idPrefix }).html : null), [clean.text, idPrefix])
  const note = invisibleNote(clean.invisible)
  function onClick(e: MouseEvent<HTMLElement>) {
    const a = (e.target as HTMLElement).closest('a')
    if (!a) return
    e.preventDefault()
    const link = classifyLink(a.getAttribute('href'), '')
    if (link.kind === 'external') onLink(link.url)
    else if (link.kind === 'anchor') ref.current?.querySelector(`[id="${idPrefix}-${CSS.escape(link.id)}"]`)?.scrollIntoView({ block: 'start' })
  }
  if (!html) return <p className="hint">{empty ?? t('forge.issues.md.empty')}</p>
  return (
    <>
      {note && (
        <p className="chip pend" role="note">
          {note} {what ?? t('forge.issues.md.whatDescription')}
        </p>
      )}
      {truncated && (
        <p className="ag-cut" role="note">
          {t('forge.issues.md.truncated')}
        </p>
      )}
      {/* HTML produit par markdown-it sans HTML brut (échappé) ni image chargée, comme l'onglet Fichiers. */}
      <article ref={ref} className={className} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
    </>
  )
}

export function IssueLabels({ labels }: { labels: readonly IssueLabel[] | null | undefined }) {
  const t = useT()
  if (!labels?.length) return null
  return (
    <span className="ilabels">
      {labels.map((l, i) => {
        const c = labelColors(l.color)
        const name = oneLine(l.name)
        // Pastille neutre (jamais l'aspect d'un bouton) : la couleur de la forge n'est qu'un point, le nom est écrit.
        return (
          <span key={`${name}-${i}`} className="ilabel" title={t('forge.issues.labelTitle', { name })}>
            <span className="ldot" aria-hidden="true" style={c ? { background: c.background } : undefined} />
            {name}
          </span>
        )
      })}
    </span>
  )
}
