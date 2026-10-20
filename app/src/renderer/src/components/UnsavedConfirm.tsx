/**
 * Confirmation avant de quitter un fichier modifié non enregistré (lot 7) :
 * changer de fichier, d'onglet, de session ou de vue, ou annuler les
 * modifications. Focus sur « Rester » ; Échap, le fond et × restent aussi.
 */
import { useSyncExternalStore } from 'react'

import { cancelLeave, confirmLeave, pendingLeave, subscribeLeave } from '../state/unsaved'
import { Modal } from './Modal'

export function UnsavedConfirm() {
  const p = useSyncExternalStore(subscribeLeave, pendingLeave)
  if (!p) return null
  return (
    <Modal title="Modifications non enregistrées" onClose={cancelLeave} width={480}>
      <div className="mb">
        <p>
          Les modifications de <code className="mono">{p.path}</code> ne sont pas enregistrées. Pour {p.action}, il faut les abandonner.
        </p>
      </div>
      <div className="mf">
        <button className="btn" data-autofocus onClick={cancelLeave}>
          Rester
        </button>
        <button className="btn danger" onClick={confirmLeave}>
          Abandonner mes modifications
        </button>
      </div>
    </Modal>
  )
}
