/**
 * Lecteur de diff (lot 15 bis) : liste des fichiers affichée à plat ou en
 * arborescence. Construction de l'arbre (chemins à un seul enfant compactés,
 * `src/a/b`), compteurs agrégés par dossier, lignes visibles selon les
 * dossiers repliés, ordre de parcours de j / k, et mode retenu dans
 * `localStorage` (stockage injecté : testable sans DOM). Calculs purs.
 *
 * Choix : j / k suivent l'ordre visuel de l'arbre et **sautent les fichiers
 * des dossiers repliés** (replier un dossier, c'est le mettre de côté) ; un
 * fichier choisi depuis ailleurs (« Voir le diff », liste de la revue) est
 * révélé en dépliant ses dossiers. Les fichiers non suivis restent dans leur
 * dossier (la règle « non suivis à la fin » de la liste ne survit pas à
 * l'imbrication).
 */
import type { DiffFile } from '../../../shared/protocol'
import type { KeyValueStorage } from './collapse'

export type DiffListMode = 'list' | 'tree'

export const LIST_MODE_KEY = 'devmaestro.diff.listMode'

export function loadListMode(storage: KeyValueStorage | null | undefined): DiffListMode {
  try {
    return storage?.getItem(LIST_MODE_KEY) === 'tree' ? 'tree' : 'list'
  } catch {
    return 'list'
  }
}

export function saveListMode(storage: KeyValueStorage | null | undefined, mode: DiffListMode): void {
  try {
    storage?.setItem(LIST_MODE_KEY, mode)
  } catch {
  }
}

export interface DirNode {
  kind: 'dir'
  /**
   * Clé de repli : chemin du dossier le plus **haut** de la chaîne compactée.
   * Stable quand la chaîne se scinde (un fichier ajouté dans `src`) : le
   * dossier replié reste replié.
   */
  key: string
  /** Chemin complet du dossier le plus profond de la chaîne (infobulle). */
  path: string
  /** Libellé affiché : `src/a/b` pour une chaîne compactée. */
  label: string
  children: TreeNode[]
  /** Somme des ajouts connus. */
  additions: number
  deletions: number
  /** Au moins un fichier non compté (« ? »). */
  unknown: boolean
  /** Chemins des fichiers contenus (récursivement), pour agréger les commentaires. */
  paths: string[]
}

export interface FileNode {
  kind: 'file'
  /** Chemin complet du fichier. */
  key: string
  /** Nom du fichier (dernier segment). */
  label: string
  file: DiffFile
}

export type TreeNode = DirNode | FileNode

const collator = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' })

function byLabel(a: TreeNode, b: TreeNode): number {
  // Dossiers d'abord, puis fichiers, chacun dans l'ordre naturel.
  return Number(a.kind === 'file') - Number(b.kind === 'file') || collator.compare(a.label, b.label) || (a.label < b.label ? -1 : 1)
}

function newDir(key: string, label: string): DirNode {
  return { kind: 'dir', key, path: key, label, children: [], additions: 0, deletions: 0, unknown: false, paths: [] }
}

/** Fusionne les dossiers dont le seul enfant est un dossier, trie, puis calcule les agrégats. */
function finish(dir: DirNode): DirNode {
  let d = dir
  while (d.children.length === 1 && d.children[0]!.kind === 'dir') {
    const only = d.children[0] as DirNode
    d = { ...only, key: d.key, label: `${d.label}/${only.label}` }
  }
  const children = d.children.map((c) => (c.kind === 'dir' ? finish(c) : c)).sort(byLabel)
  const out: DirNode = { ...d, children, additions: 0, deletions: 0, unknown: false, paths: [] }
  for (const c of children) {
    if (c.kind === 'dir') {
      out.additions += c.additions
      out.deletions += c.deletions
      out.unknown ||= c.unknown
      out.paths.push(...c.paths)
    } else {
      out.additions += c.file.additions ?? 0
      out.deletions += c.file.deletions ?? 0
      if (c.file.additions == null || c.file.deletions == null) out.unknown = true
      out.paths.push(c.key)
    }
  }
  return out
}

/** Arbre des fichiers (nœuds de la racine). */
export function buildDiffTree(files: readonly DiffFile[]): TreeNode[] {
  const root = newDir('', '')
  const dirs = new Map<string, DirNode>([['', root]])
  for (const f of files) {
    const parts = f.path.split('/').filter(Boolean)
    if (parts.length === 0) continue
    let parent = root
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts.slice(0, i + 1).join('/')
      let d = dirs.get(key)
      if (!d) {
        d = newDir(key, parts[i]!)
        dirs.set(key, d)
        parent.children.push(d)
      }
      parent = d
    }
    parent.children.push({ kind: 'file', key: f.path, label: parts[parts.length - 1]!, file: f })
  }
  // La racine elle-même n'est jamais compactée : ses enfants le sont.
  return root.children.map((c) => (c.kind === 'dir' ? finish(c) : c)).sort(byLabel)
}

/**
 * Fichier choisi par défaut : le premier de la liste à plat, ou le premier
 * de l'arbre en arborescence (sinon j ne mènerait nulle part depuis un
 * fichier affiché en dernier).
 */
export function firstFile(files: readonly DiffFile[], mode: DiffListMode, nodes?: readonly TreeNode[]): string | null {
  if (mode === 'list') return files[0]?.path ?? null
  return treeFileOrder(nodes ?? buildDiffTree(files))[0] ?? null
}

/** Commentaires de revue sur les fichiers d'un dossier. */
export function dirComments(dir: DirNode, commentsOf: (path: string) => number): number {
  let n = 0
  for (const p of dir.paths) n += commentsOf(p)
  return n
}

export interface TreeRow {
  node: TreeNode
  /** Profondeur (0 : racine), pour `aria-level` (profondeur + 1) et le retrait. */
  depth: number
  /** Clé du dossier parent (`null` à la racine). */
  parent: string | null
  /** Position parmi les frères (à partir de 1) et nombre de frères (`aria-posinset`, `aria-setsize`). */
  pos: number
  size: number
  /** Dossier déplié. */
  expanded: boolean
  /** Ligne affichée : aucun dossier ancêtre replié. */
  visible: boolean
}

/** Toutes les lignes de l'arbre dans l'ordre visuel, avec leur visibilité selon les dossiers repliés. */
export function flattenTree(nodes: readonly TreeNode[], collapsed: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = []
  const walk = (list: readonly TreeNode[], depth: number, parent: string | null, visible: boolean) => {
    list.forEach((node, i) => {
      const expanded = node.kind === 'dir' && !collapsed.has(node.key)
      rows.push({ node, depth, parent, pos: i + 1, size: list.length, expanded, visible })
      if (node.kind === 'dir') walk(node.children, depth + 1, node.key, visible && expanded)
    })
  }
  walk(nodes, 0, null, true)
  return rows
}

/** Chemins des fichiers dans l'ordre de l'arbre (dossiers repliés compris). */
export function treeFileOrder(nodes: readonly TreeNode[]): string[] {
  return flattenTree(nodes, new Set())
    .filter((r) => r.node.kind === 'file')
    .map((r) => r.node.key)
}

/**
 * Fichier suivant ou précédent visible (j / k en arborescence), borné, sans
 * boucle. Le fichier courant peut être caché (dossier replié à l'instant) :
 * on part de sa place dans l'ordre complet. Fichier inconnu : le premier
 * visible.
 */
export function stepVisibleFile(rows: readonly TreeRow[], current: string | null, delta: 1 | -1): string | null {
  const files = rows.filter((r) => r.node.kind === 'file')
  const i = files.findIndex((r) => r.node.key === current)
  if (i < 0) return files.find((r) => r.visible)?.node.key ?? null
  for (let j = i + delta; j >= 0 && j < files.length; j += delta) {
    if (files[j]!.visible) return files[j]!.node.key
  }
  return current
}

/** Clés des dossiers ancêtres d'un fichier (du parent à la racine). */
export function ancestorKeys(rows: readonly TreeRow[], path: string): string[] {
  const parentOf = new Map<string, string | null>()
  for (const r of rows) parentOf.set(`${r.node.kind}:${r.node.key}`, r.parent)
  const out: string[] = []
  let p = parentOf.get(`file:${path}`) ?? null
  while (p !== null) {
    out.push(p)
    p = parentOf.get(`dir:${p}`) ?? null
  }
  return out
}
