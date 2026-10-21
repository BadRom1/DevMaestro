/**
 * Confirmation dans l'app d'une action qui retire une entrée de la liste
 * (« Retirer de la liste », « Masquer »). Le focus va sur « Annuler » et,
 * à la fermeture, revient à l'élément qui avait le focus à l'ouverture
 * (le déclencheur) ; si celui-ci a disparu, à la barre latérale.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

import { errorText } from '../api'
import { useT } from '../i18n'

function restoreFocus(prev: Element | null): void {
  if (prev instanceof HTMLElement && prev !== document.body && prev.isConnected && !prev.hasAttribute('disabled')) {
    prev.focus()
    return
  }
  document.querySelector<HTMLElement>('nav.side')?.focus()
}

export function ConfirmBar({
  message,
  confirmLabel,
  busyLabel,
  errorPrefix,
  onConfirm,
  onCancel,
}: {
  message: ReactNode
  confirmLabel: string
  busyLabel: string
  errorPrefix: string
  onConfirm: () => Promise<void>
  onCancel: () => void
}) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const opener = useRef<Element | null>(null)

  // Avant de déplacer le focus : on retient le déclencheur, rendu à la fermeture.
  useLayoutEffect(() => {
    opener.current = document.activeElement
    cancelRef.current?.focus()
    return () => {
      const prev = opener.current
      // Après le démontage : le déclencheur peut réapparaître au même rendu.
      queueMicrotask(() => {
        const a = document.activeElement
        if (!a || a === document.body) restoreFocus(prev)
      })
    }
  }, [])

  useEffect(() => {
    if (error && !busy) cancelRef.current?.focus()
  }, [error, busy])

  async function confirm() {
    setBusy(true)
    setError(null)
    try {
      await onConfirm()
    } catch (e) {
      setError(t('sessions.confirm.error', { prefix: errorPrefix, error: errorText(e) }))
      setBusy(false)
    }
  }

  return (
    <div
      className="forget"
      role="group"
      aria-label={t('sessions.confirm.label')}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onCancel()
        }
      }}
    >
      <span>{message}</span>
      <span className="row">
        <button className="btn sm danger" disabled={busy} onClick={() => void confirm()}>
          {busy ? busyLabel : confirmLabel}
        </button>
        <button ref={cancelRef} className="btn sm ghost" disabled={busy} onClick={onCancel}>
          {t('sessions.confirm.cancel')}
        </button>
      </span>
      {error && (
        <span className="inline-err" role="alert">
          {error}
        </span>
      )}
    </div>
  )
}

/** « Retirer de la liste » une session arrêtée (`sessions.forget`). */
export function ForgetConfirm(props: { name: string; onConfirm: () => Promise<void>; onCancel: () => void }) {
  const t = useT()
  return (
    <ConfirmBar
      message={
        <>
          {t('sessions.forget.question', { name: props.name })}{' '}
          <span className="muted">{t('sessions.forget.detail')}</span>
        </>
      }
      confirmLabel={t('sessions.forget.confirm')}
      busyLabel={t('sessions.forget.busy')}
      errorPrefix={t('sessions.forget.error')}
      onConfirm={props.onConfirm}
      onCancel={props.onCancel}
    />
  )
}

/** « Masquer » une ancienne session (`transcripts.hide`). */
export function HideConfirm(props: { name: string; onConfirm: () => Promise<void>; onCancel: () => void }) {
  const t = useT()
  return (
    <ConfirmBar
      message={
        <>
          {t('sessions.hide.question', { name: props.name })} <span className="muted">{t('sessions.hide.detail')}</span>
        </>
      }
      confirmLabel={t('sessions.hide.confirm')}
      busyLabel={t('sessions.hide.busy')}
      errorPrefix={t('sessions.hide.error')}
      onConfirm={props.onConfirm}
      onCancel={props.onCancel}
    />
  )
}
