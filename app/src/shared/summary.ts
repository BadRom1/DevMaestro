/**
 * Résumé lisible de l'entrée d'un outil de Claude Code (commande, fichier,
 * URL…), partagé par la page (cartes de demande) et le processus principal
 * (notifications desktop).
 */

export function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

export function truncate(s: string, max = 400): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

/** Résumé lisible de l'entrée d'un outil (commande, fichier, URL…). */
export function summarizeToolInput(tool: string, input: unknown): string {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  switch (tool) {
    case 'Bash':
      return truncate(str(o.command) ?? JSON.stringify(input))
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'Read':
    case 'NotebookEdit':
      return str(o.file_path) ?? str(o.notebook_path) ?? truncate(JSON.stringify(input))
    case 'WebFetch':
      return str(o.url) ?? truncate(JSON.stringify(input))
    case 'WebSearch':
      return str(o.query) ?? truncate(JSON.stringify(input))
    case 'Glob':
    case 'Grep': {
      const p = str(o.pattern)
      const path = str(o.path)
      return p ? (path ? `${p} dans ${path}` : p) : truncate(JSON.stringify(input))
    }
    default:
      return input === undefined ? '' : truncate(JSON.stringify(input))
  }
}
