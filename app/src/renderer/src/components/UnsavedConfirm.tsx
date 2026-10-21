/**
 * Confirmation avant de quitter un fichier modifié non enregistré (lot 7) :
 * changer de fichier, d'onglet, de session ou de vue, ou annuler les
 * modifications. Focus sur « Rester » ; Échap, le fond et × restent aussi.
 */
import { useSyncExternalStore } from 'react'

import { useI18n } from '../i18n'
import { cancelLeave, confirmLeave, pendingLeave, subscribeLeave } from '../state/unsaved'
import { Modal } from './Modal'

export function UnsavedConfirm() {
  const { t, rich } = useI18n()
  const p = useSyncExternalStore(subscribeLeave, pendingLeave)
  if (!p) return null
  return (
    <Modal title={t('files.unsaved.title')} onClose={cancelLeave} width={480}>
      <div className="mb">
        <p>
          {rich('files.unsaved.body', { path: <code className="mono">{p.path}</code>, action: p.action })}
        </p>
      </div>
      <div className="mf">
        <button className="btn" data-autofocus onClick={cancelLeave}>
          {t('files.unsaved.stay')}
        </button>
        <button className="btn danger" onClick={confirmLeave}>
          {t('files.unsaved.discard')}
        </button>
      </div>
    </Modal>
  )
}
