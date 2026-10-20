/**
 * Erreurs de la page vers le journal du processus principal : au plus
 * `max` messages distincts par fenêtre de `windowMs`, un même message une
 * seule fois par fenêtre. Ce qui est écarté est compté et signalé
 * (« n erreurs de la page supprimées ») au premier message de la fenêtre
 * suivante. Sans Electron : testable seul.
 */
export class RendererErrorLog {
  private start = Number.NEGATIVE_INFINITY
  private seen = new Set<string>()
  private suppressed = 0

  constructor(
    private readonly max = 20,
    private readonly windowMs = 60_000,
  ) {}

  /** Lignes à journaliser pour ce message (aucune s'il est écarté). */
  accept(text: string, now: number): string[] {
    const out: string[] = []
    if (now - this.start >= this.windowMs) {
      if (this.suppressed > 0) {
        out.push(`${this.suppressed} erreur${this.suppressed > 1 ? 's' : ''} de la page supprimée${this.suppressed > 1 ? 's' : ''} (doublons ou limite de ${this.max} par minute)`)
      }
      this.start = now
      this.seen = new Set()
      this.suppressed = 0
    }
    if (this.seen.has(text) || this.seen.size >= this.max) {
      this.suppressed++
      return out
    }
    this.seen.add(text)
    out.push(`erreur de la page : ${text}`)
    return out
  }
}
