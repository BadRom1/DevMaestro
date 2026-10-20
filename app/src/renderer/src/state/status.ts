/**
 * Glyphe de statut d'une session : forme **et** couleur (jamais la couleur
 * seule), avec un libellé pour les lecteurs d'écran.
 *
 * | Statut | Forme |
 * |---|---|
 * | à répondre | carré plein « ! » |
 * | en cours, démarrage | anneau qui tourne |
 * | inactive | cercle creux |
 * | arrêtée | rond gris « ✓ » |
 * | erreur | rond rouge « × » |
 */
import type { Session, SessionStatus } from '../../../shared/protocol'

export type GlyphKind = 'waiting' | 'running' | 'idle' | 'stopped' | 'error'

export interface Glyph {
  kind: GlyphKind
  label: string
}

export function glyphFor(status: SessionStatus | null | undefined): Glyph {
  switch (status?.state) {
    case 'waiting':
      return {
        kind: 'waiting',
        label:
          status.wait === 'permission'
            ? 'À répondre : permission'
            : status.wait === 'question'
              ? 'À répondre : question'
              : 'À répondre',
      }
    case 'starting':
      return { kind: 'running', label: 'Démarrage' }
    case 'running':
      return { kind: 'running', label: 'En cours' }
    case 'idle':
      return { kind: 'idle', label: 'Inactive' }
    case 'stopped':
      return { kind: 'stopped', label: 'Arrêtée' }
    case 'error':
      return { kind: 'error', label: 'Erreur' }
    default:
      return { kind: 'idle', label: 'Statut inconnu' }
  }
}

/** Ordre d'affichage dans un projet : ce qui demande l'attention d'abord. */
export const STATUS_ORDER: Record<GlyphKind, number> = {
  waiting: 0,
  running: 1,
  idle: 2,
  error: 3,
  stopped: 4,
}

/**
 * Une demande (permission ou question) attend une réponse : rien ne doit être
 * tapé dans la session (l'Entrée validerait le dialogue de la TUI).
 */
export function awaitingAnswer(s: Pick<Session, 'status' | 'pending'>): boolean {
  return s.status.state === 'waiting' || s.pending.length > 0
}
