/**
 * Portée des consignes d'une session (lot 18) : clé du projet (pour les
 * consignes propres au projet) et capacité du démon à taper une consigne de
 * revue personnalisée (`hello.capabilities.review_instruction`). Fournie par
 * le volet de la session, lue par la barre de revue (onglets Diff, Fichiers
 * et Commits).
 */
import { createContext, useContext } from 'react'

export interface PromptScope {
  projectKey: string | null
  /** `true` : le démon tape `instruction` ; `false` : démon ancien ; `null` : inconnu (pas connecté). */
  reviewInstruction: boolean | null
}

export const PromptScopeContext = createContext<PromptScope>({ projectKey: null, reviewInstruction: null })

export function usePromptScope(): PromptScope {
  return useContext(PromptScopeContext)
}
