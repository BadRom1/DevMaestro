import { useState } from 'react'

import { api } from '../api'
import { describeError } from '../state/errors'
import { Modal } from './Modal'

/** Confirmation avant d'ouvrir un lien (terminal, fichier Markdown) dans le navigateur. */
export function LinkDialog({ url, onClose }: { url: string; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  async function open() {
    setBusy(true)
    const r = await api.openExternal(url)
    setBusy(false)
    if (r.ok) onClose()
    else setError(describeError(r.error.code, r.error.message))
  }
  return (
    <Modal title="Ouvrir le lien ?" onClose={onClose} width={560}>
      <div className="mb">
        <p style={{ margin: 0 }}>Ce lien mène hors de DevMaestro. L’ouvrir dans ton navigateur ?</p>
        <code className="mono" style={{ overflowWrap: 'anywhere' }}>
          {url}
        </code>
      </div>
      <div className="mf">
        {error ? (
          <span className="err" role="alert">
            {error}
          </span>
        ) : (
          <span style={{ marginRight: 'auto' }} />
        )}
        <button className="btn ghost" onClick={onClose} data-autofocus>
          Annuler
        </button>
        <button className="btn pri" disabled={busy} onClick={() => void open()}>
          Ouvrir
        </button>
      </div>
    </Modal>
  )
}
