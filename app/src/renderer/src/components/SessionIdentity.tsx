/**
 * Nom et couleur d'une session : pastille de couleur, champ de renommage,
 * sélecteur de couleur. La couleur est décorative : son nom est toujours
 * donné en texte (infobulle, libellé accessible), elle ne porte aucun état.
 */
import { useEffect, useId, useRef, useState } from 'react'

import { MAX_TITLE, SESSION_COLORS, type SessionColor } from '../../../shared/protocol'
import { clampTitle, normalizeTitleInput, titleLength } from '../state/title'
import { COLOR_LABELS } from '../state/format'
import { useT } from '../i18n'

/** Barre verticale de couleur ; rien si aucune couleur. */
export function ColorBar({ color, size = 'sm' }: { color: SessionColor | null; size?: 'sm' | 'lg' }) {
  const t = useT()
  if (!color) return null
  const label = t('shell.color.bar', { color: COLOR_LABELS[color].toLowerCase() })
  return <span className={`cbar ${size} c-${color}`} role="img" aria-label={label} title={label} />
}

/**
 * Champ de renommage : Entrée enregistre, Échap annule, la perte du focus
 * enregistre si le texte a changé. Vide : retour au nom automatique.
 */
export function RenameField({
  initial,
  placeholder,
  onSave,
  onCancel,
}: {
  initial: string
  placeholder: string
  onSave: (title: string | null) => Promise<void>
  onCancel: () => void
}) {
  const t = useT()
  const [value, setValue] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  const inFlight = useRef(false)

  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])

  // Après un échec, le champ (réactivé) reprend le focus pour corriger ou annuler.
  useEffect(() => {
    if (error && !busy) ref.current?.focus()
  }, [error, busy])

  async function commit() {
    if (done.current || inFlight.current) return
    const next = normalizeTitleInput(value)
    if (!next.ok) {
      setError(t('shell.renameFailed', { error: next.error }))
      return
    }
    const before = normalizeTitleInput(initial)
    if (before.ok && before.title === next.title) {
      done.current = true
      onCancel()
      return
    }
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      await onSave(next.title)
      done.current = true
    } catch (e) {
      setError((e as Error).message)
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  function cancel() {
    done.current = true
    onCancel()
  }

  return (
    <span className="rename">
      <input
        ref={ref}
        type="text"
        value={value}
        placeholder={placeholder}
        aria-label={t('shell.rename.label')}
        aria-invalid={error ? true : undefined}
        disabled={busy}
        onChange={(e) => {
          // 80 caractères (points de code) au plus, comme le démon ; `maxLength` compterait en UTF-16.
          setValue(clampTitle(e.target.value))
          setError(null)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            void commit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            cancel()
          }
        }}
        onBlur={() => {
          if (!error) void commit()
        }}
      />
      <span className="hint" aria-live="polite">
        {busy ? t('shell.rename.saving') : `${titleLength(value)}/${MAX_TITLE}`}
      </span>
      {error && (
        <span className="inline-err" role="alert">
          {error}
        </span>
      )}
    </span>
  )
}

/** Bouton « Couleur » et sa palette (8 teintes et « aucune »). */
export function ColorPicker({
  value,
  disabled,
  disabledReason,
  onPick,
}: {
  value: SessionColor | null
  disabled?: boolean
  disabledReason?: string
  onPick: (c: SessionColor | null) => void
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const popId = useId()

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        button.current?.focus()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    root.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus()
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  function pick(c: SessionColor | null) {
    setOpen(false)
    button.current?.focus()
    if (c !== value) onPick(c)
  }

  const current = value ? COLOR_LABELS[value] : t('shell.color.noneLower')
  return (
    <div className="cpick" ref={root}>
      <button
        ref={button}
        className="btn sm ghost"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        disabled={disabled}
        title={disabled ? disabledReason : t('shell.color.current', { color: current.toLowerCase() })}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`swatch ${value ? `c-${value}` : 'none'}`} aria-hidden="true" />
        {t('shell.color.button')}
      </button>
      {open && (
        <div className="cpop" id={popId} role="group" aria-label={t('shell.color.group')}>
          <button className="sw" aria-pressed={value === null} title={t('shell.color.noneTitle')} onClick={() => pick(null)}>
            <span className="swatch none" aria-hidden="true" />
            <span>{t('shell.color.none')}</span>
          </button>
          {SESSION_COLORS.map((c) => (
            <button key={c} className="sw" aria-pressed={value === c} title={COLOR_LABELS[c]} onClick={() => pick(c)}>
              <span className={`swatch c-${c}`} aria-hidden="true" />
              <span>{COLOR_LABELS[c]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
