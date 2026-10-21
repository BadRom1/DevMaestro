import { useState } from 'react'

import { api } from '../api'
import { useT } from '../i18n'
import { describeError } from '../state/errors'
import { Modal } from './Modal'

/** Confirmation avant d'ouvrir un lien (terminal, fichier Markdown) dans le navigateur. */
export function LinkDialog({ url, onClose }: { url: string; onClose: () => void }) {
  const t = useT()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  async function open() {
    setBusy(true)
    const r = await api.openExternal(url)
    setBusy(false)
    if (r.ok) onClose()
    else setError(describeError(r.error.code, r.error.message, r.error.data))
  }
  return (
    <Modal title={t('forge.issues.link.title')} onClose={onClose} width={560}>
      <div className="mb">
        <p style={{ margin: 0 }}>{t('forge.issues.link.body')}</p>
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
          {t('forge.issues.link.cancel')}
        </button>
        <button className="btn pri" disabled={busy} onClick={() => void open()}>
          {t('forge.issues.link.open')}
        </button>
      </div>
    </Modal>
  )
}
