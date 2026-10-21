/**
 * Sélecteur multiple d'étiquettes (lot 15) : calculs purs, testables sans DOM.
 * Recherche sans accents ni majuscules dans le nom et la description ;
 * étiquettes choisies dans l'ordre du choix ; option active bornée.
 */
import { t } from '../../../shared/i18n'
import type { RepoLabel } from '../../../shared/protocol'

/** Texte comparable : sans accents, minuscules, blancs réduits. */
export function foldText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/** Étiquettes dont le nom ou la description contient la recherche ; celles dont le nom commence par elle d'abord. */
export function filterLabels(labels: readonly RepoLabel[], query: string): RepoLabel[] {
  const q = foldText(query)
  if (!q) return [...labels]
  const starts: RepoLabel[] = []
  const contains: RepoLabel[] = []
  for (const l of labels) {
    const name = foldText(l.name)
    if (name.startsWith(q)) starts.push(l)
    else if (name.includes(q) || foldText(l.description ?? '').includes(q)) contains.push(l)
  }
  return [...starts, ...contains]
}

/** Ajoute ou retire `name` (nouvelle liste), `max` étiquettes au plus. */
export function toggleLabel(selected: readonly string[], name: string, max = Infinity): string[] {
  if (selected.includes(name)) return selected.filter((x) => x !== name)
  return selected.length >= max ? [...selected] : [...selected, name]
}

/** Option active après une flèche (`+1` / `-1`), en boucle ; `-1` sans option. */
export function moveActive(active: number, count: number, delta: 1 | -1): number {
  if (count <= 0) return -1
  if (active < 0 || active >= count) return delta > 0 ? 0 : count - 1
  return (active + delta + count) % count
}

/** Résumé lu par les lecteurs d'écran : « 2 étiquettes choisies : bug, interface ». */
export function selectionSummary(selected: readonly string[]): string {
  if (selected.length === 0) return t('forge.issues.labels.noneSelected')
  return t('forge.issues.labels.selected', { count: selected.length, names: selected.join(', ') })
}
