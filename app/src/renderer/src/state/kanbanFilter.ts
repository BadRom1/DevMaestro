/**
 * Vue par statut : filtre par projet (mêmes groupes que la barre latérale,
 * `groupByProject`) et volet de session ouvert à côté du kanban.
 *
 * Le filtre choisi est retenu dans `localStorage` (stockage injecté : testable
 * sans DOM) avec le nom du projet, pour l'afficher encore quand ce projet n'a
 * plus de session.
 */
import type { Session } from '../../../shared/protocol'
import type { KeyValueStorage } from './collapse'
import type { ProjectGroup } from './projects'

export const PROJECT_FILTER_KEY = 'devmaestro.kanban.project'
export const KANBAN_PANE_KEY = 'devmaestro.kanban.pane'

/** Projet choisi (`null` : tous les projets). */
export interface ProjectFilter {
  key: string
  name: string
}

export interface ProjectOption {
  key: string
  label: string
  count: number
}

/**
 * Choix du sélecteur : un par groupe de la barre latérale, dans le même ordre,
 * avec le nombre de sessions. Deux projets du même nom sont distingués par
 * leur dossier. Le projet retenu sans session garde une option (0).
 */
export function projectOptions(groups: readonly ProjectGroup[], filter: ProjectFilter | null): ProjectOption[] {
  const names = new Map<string, number>()
  for (const g of groups) names.set(g.name, (names.get(g.name) ?? 0) + 1)
  const opts = groups.map((g) => ({
    key: g.key,
    label: (names.get(g.name) ?? 0) > 1 ? `${g.name} — ${g.root}` : g.name,
    count: g.sessions.length,
  }))
  if (filter && !groups.some((g) => g.key === filter.key)) opts.push({ key: filter.key, label: filter.name, count: 0 })
  return opts
}

/**
 * Sessions affichées : toutes, ou celles du groupe choisi (appartenance au
 * groupe, pas une clé recalculée : un projet déplacé rejoint un groupe d'une
 * autre clé). Projet sans session : liste vide, le filtre est gardé.
 */
export function filterSessions(
  sessions: readonly Session[],
  groups: readonly ProjectGroup[],
  filter: ProjectFilter | null,
): readonly Session[] {
  if (!filter) return sessions
  return groups.find((g) => g.key === filter.key)?.sessions ?? []
}

/** Filtre à jour du nom actuel du groupe (renommage, dossier résolu). */
export function filterFor(groups: readonly ProjectGroup[], key: string | null): ProjectFilter | null {
  if (key === null) return null
  const g = groups.find((x) => x.key === key)
  return g ? { key: g.key, name: g.name } : null
}

export function loadProjectFilter(storage: KeyValueStorage | null | undefined): ProjectFilter | null {
  try {
    const raw = storage?.getItem(PROJECT_FILTER_KEY)
    if (!raw) return null
    const v: unknown = JSON.parse(raw)
    if (!v || typeof v !== 'object') return null
    const { key, name } = v as Record<string, unknown>
    if (typeof key !== 'string' || key === '') return null
    return { key, name: typeof name === 'string' && name !== '' ? name : key }
  } catch {
    return null
  }
}

export function saveProjectFilter(storage: KeyValueStorage | null | undefined, filter: ProjectFilter | null): void {
  try {
    storage?.setItem(PROJECT_FILTER_KEY, filter ? JSON.stringify({ key: filter.key, name: filter.name }) : '')
  } catch {
    // Stockage indisponible : le choix vaut pour cette fenêtre seulement.
  }
}

/** Volet de session ouvert dans la vue par statut (retenu d'une ouverture à l'autre). */
export function loadPaneOpen(storage: KeyValueStorage | null | undefined): boolean {
  try {
    return storage?.getItem(KANBAN_PANE_KEY) === '1'
  } catch {
    return false
  }
}

export function savePaneOpen(storage: KeyValueStorage | null | undefined, open: boolean): void {
  try {
    storage?.setItem(KANBAN_PANE_KEY, open ? '1' : '')
  } catch {
    // Stockage indisponible : rien à retenir.
  }
}

/**
 * Le volet est-il affiché ? Ouvert, une session choisie qui existe encore,
 * et choisie par l'utilisateur (`explicit` : clic, notification, lancement ;
 * pas la sélection par défaut du démarrage : le choix « ouvert » retenu ne
 * rouvre pas le volet tout seul sur une session que l'utilisateur n'a pas
 * demandée).
 * Choix assumé : un filtre qui masque la carte choisie **ne ferme pas** le
 * volet (le filtre trie les cartes, il ne décide pas de la session suivie ;
 * fermer ferait perdre une revue ou une saisie en cours au moindre changement
 * de filtre). Seule la disparition de la session (oubliée) le masque.
 */
export function paneVisible(open: boolean, selected: Pick<Session, 'id'> | null, explicit = true): boolean {
  return open && explicit && selected !== null
}

/** La carte de cette session est-elle mise en évidence ? */
export function cardSelected(id: string, open: boolean, selectedId: string | null): boolean {
  return open && selectedId === id
}
