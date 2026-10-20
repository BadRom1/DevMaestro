/**
 * Confirmation dans l'app d'une action qui retire une entrée de la liste
 * (« Retirer de la liste », « Masquer »). Le focus va sur « Annuler » et,
 * à la fermeture, revient à l'élément qui avait le focus à l'ouverture
 * (le déclencheur) ; si celui-ci a disparu, à la barre latérale.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

import { errorText } from '../api'

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
      setError(`${errorPrefix} : ${errorText(e)}`)
      setBusy(false)
    }
  }

  return (
    <div
      className="forget"
      role="group"
      aria-label="Confirmation"
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
          Annuler
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
  return (
    <ConfirmBar
      message={
        <>
          Retirer « {props.name} » de la liste ?{' '}
          <span className="muted">
            Elle ne réapparaîtra pas dans « Anciennes sessions » ; les fichiers de Claude Code ne sont pas touchés.
          </span>
        </>
      }
      confirmLabel="Retirer"
      busyLabel="Retrait…"
      errorPrefix="Retrait impossible"
      onConfirm={props.onConfirm}
      onCancel={props.onCancel}
    />
  )
}

/** « Masquer » une ancienne session (`transcripts.hide`). */
export function HideConfirm(props: { name: string; onConfirm: () => Promise<void>; onCancel: () => void }) {
  return (
    <ConfirmBar
      message={
        <>
          Masquer « {props.name} » ? <span className="muted">Le transcript de Claude Code n’est pas supprimé.</span>
        </>
      }
      confirmLabel="Masquer"
      busyLabel="Masquage…"
      errorPrefix="Masquage impossible"
      onConfirm={props.onConfirm}
      onCancel={props.onCancel}
    />
  )
}
