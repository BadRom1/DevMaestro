/**
 * Livraison pilotée par Claude (v0.3, lot 14b) : boutons « Ouvrir une
 * demande de fusion » et « Fusionner dans <branche par défaut> ». Leurs
 * consignes tapées sont des consignes personnalisables du registre
 * (`./prompts`, lot 18 : `deliveryPr`, `deliveryMerge`).
 */

import type { DeliveryMode } from './protocol'

/** Ce que fait chaque bouton de livraison. */
export type DeliveryAction = 'pr' | 'merge'

/** Bouton principal selon le mode du projet. */
export function primaryAction(mode: DeliveryMode): DeliveryAction {
  return mode === 'trunk' ? 'merge' : 'pr'
}

/** Libellé d'un bouton de livraison. */
export function actionLabel(action: DeliveryAction, base: string | null): string {
  return action === 'pr' ? 'Ouvrir une demande de fusion' : `Fusionner dans ${base ?? 'la branche par défaut'}`
}
