/**
 * Sélecteur multiple d'étiquettes (lot 15) : liste déroulante filtrable des
 * étiquettes du dépôt, choisies en pastilles retirables.
 *
 * Accessibilité (motif « combobox » ARIA 1.2) : champ `role="combobox"`,
 * liste `role="listbox"` à choix multiple, option active désignée par
 * `aria-activedescendant` ; flèches haut et bas, Entrée choisit ou retire,
 * Échap ferme la liste (sans fermer la fenêtre), Retour arrière sur un champ
 * vide retire la dernière pastille. Le choix en cours est annoncé.
 *
 * Contenu venu de la forge (nom, description, couleur) : nettoyé à la
 * lecture (`repoLabelsFrom`), couleur validée (`labelColors`) ; le nom est
 * toujours écrit, la couleur n'est qu'un point.
 */
import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'

import type { RepoLabel } from '../../../shared/protocol'
import { useT } from '../i18n'
import { labelColors } from '../state/forge'
import { filterLabels, moveActive, selectionSummary, toggleLabel } from '../state/labelPicker'

function Dot({ color }: { color: string | null | undefined }) {
  const c = labelColors(color)
  return <span className="ldot" aria-hidden="true" style={c ? { background: c.background } : undefined} />
}

export function LabelPicker({
  labels,
  selected,
  onChange,
  max = 20,
  label,
  loading = false,
}: {
  /** Étiquettes du dépôt (nettoyées). */
  labels: readonly RepoLabel[]
  selected: readonly string[]
  onChange: (next: string[]) => void
  max?: number
  /** Par défaut « Étiquettes ». */
  label?: string
  /** Liste du dépôt en cours de lecture. */
  loading?: boolean
}) {
  const t = useT()
  const uid = useId()
  const input = useRef<HTMLInputElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const shown = useMemo(() => filterLabels(labels, query), [labels, query])
  const byName = useMemo(() => new Map(labels.map((l) => [l.name, l])), [labels])
  const activeIndex = open && active >= 0 && active < shown.length ? active : -1
  const optionId = (i: number) => `${uid}-o${i}`

  function show(at = 0) {
    setOpen(true)
    setActive(shown.length ? Math.min(at, shown.length - 1) : -1)
  }
  function toggle(name: string) {
    onChange(toggleLabel(selected, name, max))
    if (query) {
      setQuery('')
      setActive(Math.max(0, labels.findIndex((l) => l.name === name)))
    }
    input.current?.focus()
  }
  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        e.preventDefault()
        const delta = e.key === 'ArrowDown' ? 1 : -1
        if (!open) show(delta > 0 ? 0 : shown.length - 1)
        else setActive((a) => moveActive(a, shown.length, delta))
        return
      }
      case 'Enter':
        if (open && activeIndex >= 0) {
          e.preventDefault()
          toggle(shown[activeIndex]!.name)
        } else if (!open) {
          e.preventDefault()
          show()
        }
        return
      case 'Escape':
        if (open) {
          e.preventDefault()
          setOpen(false)
          setActive(-1)
        }
        return
      case 'Backspace':
        if (query === '' && selected.length > 0) {
          e.preventDefault()
          onChange(selected.slice(0, -1))
        }
        return
    }
  }

  const full = selected.length >= max
  return (
    <div
      className="field lpick"
      ref={root}
      // Liste ouverte : Échap la ferme, la fenêtre reste ouverte.
      data-own-escape={open ? '' : undefined}
      onBlur={(e) => {
        if (!root.current?.contains(e.relatedTarget as Node | null)) {
          setOpen(false)
          setActive(-1)
        }
      }}
    >
      <span className="lbl" id={`${uid}-l`}>
        {label ?? t('forge.issues.labels.label')}
      </span>
      <div
        className="lpick-box"
        onMouseDown={(e) => {
          // Clic dans la boîte, hors pastille : le champ prend le focus et la liste s'ouvre.
          if (e.target !== e.currentTarget) return
          e.preventDefault()
          input.current?.focus()
          show()
        }}
      >
        {selected.map((name) => (
          <span key={name} className="lchip">
            <Dot color={byName.get(name)?.color} />
            <span className="lchip-n">{name}</span>
            <button type="button" className="lchip-x" aria-label={t('forge.issues.labels.removeLabel', { name })} title={t('forge.issues.labels.removeTitle', { name })} onClick={() => {
                onChange(selected.filter((x) => x !== name))
                // Le bouton disparaît : le focus revient au champ.
                input.current?.focus()
              }}>
              ×
            </button>
          </span>
        ))}
        <input
          ref={input}
          role="combobox"
          aria-expanded={open}
          // Seulement quand la liste existe (ARIA : la cible doit être dans le document).
          aria-controls={open && shown.length > 0 ? `${uid}-lb` : undefined}
          aria-autocomplete="list"
          aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
          aria-labelledby={`${uid}-l`}
          aria-describedby={`${uid}-s`}
          value={query}
          maxLength={128}
          placeholder={selected.length ? t('forge.issues.labels.add') : t('forge.issues.labels.all')}
          onChange={(e) => {
            setQuery(e.target.value)
            setOpen(true)
            setActive(0)
          }}
          onMouseDown={() => !open && show()}
          onKeyDown={onKey}
        />
      </div>
      <span id={`${uid}-s`} className="sr-only" aria-live="polite">
        {selectionSummary(selected)}
      </span>
      {open && (
        // Clic dans la liste (barre de défilement comprise) : le champ garde le focus, la liste reste ouverte.
        <div className="lpick-pop" onMouseDown={(e) => e.preventDefault()}>
          {labels.length === 0 && (
            <p className="hint lpick-empty" role="status">
              {loading ? t('forge.issues.labels.loading') : t('forge.issues.labels.emptyRepo')}
            </p>
          )}
          {labels.length > 0 && shown.length === 0 && <p className="hint lpick-empty">{t('forge.issues.labels.noMatch')}</p>}
          {full && <p className="hint lpick-empty">{t('forge.issues.labels.full', { count: max })}</p>}
          <ul role="listbox" id={`${uid}-lb`} aria-multiselectable="true" aria-labelledby={`${uid}-l`} hidden={shown.length === 0}>
            {shown.map((l, i) => {
              const on = selected.includes(l.name)
              return (
                <li
                  key={l.name}
                  id={optionId(i)}
                  role="option"
                  aria-selected={on}
                  aria-disabled={!on && full ? true : undefined}
                  className={`lopt${i === activeIndex ? ' active' : ''}`}
                  // Le focus reste dans le champ.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => toggle(l.name)}
                  onMouseMove={() => i !== active && setActive(i)}
                >
                  <span className="lopt-check" aria-hidden="true">
                    {on ? '✓' : ''}
                  </span>
                  <Dot color={l.color} />
                  <span className="lopt-n">{l.name}</span>
                  {l.description && <span className="lopt-d">{l.description}</span>}
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}
