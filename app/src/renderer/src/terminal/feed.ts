/**
 * Application des messages du canal du terminal à un terminal xterm.js (ou
 * tout objet qui sait `write`). Pur, testable sans DOM.
 *
 * - `reset` (abonnement) : réinitialisation complète (`ESC c`, qui efface
 *   aussi l'historique de la session précédente), puis `ESC[0m ESC[2J ESC[H`
 *   et l'écran `ansi` de l'instantané ;
 * - `reset` (resynchronisation) : `ESC[0m ESC[2J ESC[H` puis l'écran (le
 *   défilement passé est gardé) ;
 * - `data` : octets écrits tels quels, seulement s'ils suivent le dernier
 *   instantané de la session attendue ; l'accusé (contrôle de flux) part une
 *   fois les octets traités par le terminal (rappel de `write`).
 *
 * Tout passe par `write`, dans l'ordre : pas de course avec les écritures en
 * file de xterm.
 */
import type { PortDown } from '../../../shared/bridge'

export interface TerminalSink {
  write(data: string | Uint8Array, done?: () => void): void
  readonly cols?: number
  readonly rows?: number
}

export interface FeedHooks {
  /** Accusé d'un lot écrit (contrôle de flux). */
  ack?: (gen: number, bytes: number) => void
  /**
   * L'instantané n'a pas la taille du terminal (le démon n'a pas pu
   * redimensionner, session arrêtée…) : à appeler **avant** d'écrire l'écran,
   * pour que le terminal prenne la taille de l'instantané.
   */
  sizeMismatch?: (cols: number, rows: number) => void
  /** La page a pris trop de retard : flux suspendu jusqu'au prochain instantané. */
  paused?: () => void
}

export const CLEAR = '\x1b[0m\x1b[2J\x1b[H'
export const FULL_RESET = '\x1bc'

export class TerminalFeed {
  private expected: string | null = null
  private gen = -1

  constructor(
    private readonly term: TerminalSink,
    private readonly hooks: FeedHooks = {},
  ) {}

  /** Session que la page veut afficher : le reste est ignoré. */
  expect(id: string | null): void {
    this.expected = id
  }

  get expectedId(): string | null {
    return this.expected
  }

  /** Applique un message ; renvoie vrai s'il a été pris en compte. */
  handle(msg: PortDown): boolean {
    switch (msg.t) {
      case 'reset': {
        if (msg.id !== this.expected || msg.gen < this.gen) return false
        const { cols, rows } = msg.snapshot
        if (this.term.cols !== undefined && (cols !== this.term.cols || rows !== this.term.rows)) {
          this.hooks.sizeMismatch?.(cols, rows)
        }
        this.term.write((msg.reason === 'subscribe' ? FULL_RESET : '') + CLEAR + msg.snapshot.ansi)
        this.gen = msg.gen
        return true
      }
      case 'data': {
        if (msg.id !== this.expected || msg.gen !== this.gen) {
          // Lot d'un abonnement périmé : acquitté tout de suite (rien à écrire).
          this.hooks.ack?.(msg.gen, msg.bytes.length)
          return false
        }
        const { gen } = msg
        const n = msg.bytes.length
        this.term.write(msg.bytes, () => this.hooks.ack?.(gen, n))
        return true
      }
      case 'paused':
        if (msg.id !== this.expected || msg.gen !== this.gen) return false
        this.hooks.paused?.()
        return true
      case 'none':
        if (msg.gen < this.gen) return false
        this.gen = msg.gen
        if (this.expected === null) this.term.write(FULL_RESET)
        return true
    }
  }
}
