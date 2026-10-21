/**
 * Domaine « forge » (lot 20) : clés préfixées par `forge.`. Un fichier par
 * partie dans `forge/` (tickets, pull requests, revue assistée, livraison),
 * réunis ici.
 */
import { defineMessages } from '../core'
import { delivery } from './forge/delivery'
import { issues } from './forge/issues'
import { pulls } from './forge/pulls'
import { review } from './forge/review'

export const forge = defineMessages({
  fr: { ...issues.fr, ...pulls.fr, ...review.fr, ...delivery.fr },
  en: { ...issues.en, ...pulls.en, ...review.en, ...delivery.en },
})
