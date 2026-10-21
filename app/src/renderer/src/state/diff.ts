/**
 * Onglet « Diff » : ordre des fichiers et modèle d'affichage des hunks
 * (numéros de ligne, genre de ligne, ancre de commentaire). Calculs purs.
 */
import type { DiffBase, DiffFile, DiffStatus, FileDiff, ReviewSide } from '../../../shared/protocol'

export const STATUS_LABELS: Record<DiffStatus, string> = {
  A: 'ajouté',
  M: 'modifié',
  D: 'supprimé',
  R: 'renommé',
  '?': 'non suivi',
}

const collator = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' })

/**
 * Ordre de la liste : fichiers suivis par chemin (dossiers et noms dans
 * l'ordre naturel, « 2 » avant « 10 »), puis les fichiers non suivis.
 */
export function sortFiles(files: readonly DiffFile[]): DiffFile[] {
  return [...files].sort(
    (a, b) => Number(a.status === '?') - Number(b.status === '?') || collator.compare(a.path, b.path) || (a.path < b.path ? -1 : 1),
  )
}

/** Ancre d'un commentaire : la ligne côté nouvelle version, ou côté ancienne pour une ligne supprimée. */
export interface LineAnchor {
  side: ReviewSide
  line: number
}

export function anchorKey(a: LineAnchor): string {
  return `${a.side}:${a.line}`
}

export type DiffRow =
  | { type: 'hunk'; key: string; header: string }
  | {
      type: 'line'
      key: string
      kind: 'add' | 'del' | 'ctx'
      oldNo: number | null
      newNo: number | null
      text: string
      /** `null` si la ligne n'a pas de numéro utilisable (ne devrait pas arriver). */
      anchor: LineAnchor | null
    }

/** Lignes à afficher pour un fichier : un en-tête par hunk, puis ses lignes. */
export function diffRows(fd: FileDiff | null | undefined): DiffRow[] {
  if (!fd || fd.binary || fd.too_large) return []
  const rows: DiffRow[] = []
  fd.hunks.forEach((h, hi) => {
    // Clés tirées des numéros de ligne (stables d'un rechargement à l'autre), pas des positions.
    rows.push({ type: 'hunk', key: `@${h.old_start},${h.new_start}:${hi}`, header: h.header })
    h.lines.forEach((l, li) => {
      const kind = l.kind === '+' ? 'add' : l.kind === '-' ? 'del' : 'ctx'
      const anchor: LineAnchor | null =
        kind === 'del'
          ? l.old_no != null
            ? { side: 'old', line: l.old_no }
            : null
          : l.new_no != null
            ? { side: 'new', line: l.new_no }
            : null
      const oldNo = kind === 'add' ? null : l.old_no
      const newNo = kind === 'del' ? null : l.new_no
      rows.push({
        type: 'line',
        key: oldNo == null && newNo == null ? `?${hi}:${li}` : `${kind}:${oldNo ?? ''}:${newNo ?? ''}`,
        kind,
        oldNo,
        newNo,
        text: l.text,
        anchor,
      })
    })
  })
  return rows
}

/** « depuis origin/main (a1b2c3d) », ou « depuis HEAD (…) » sans branche par défaut. */
export function baseLabel(base: DiffBase | null | undefined): string {
  if (!base) return 'base inconnue'
  const sha = base.sha ? ` (${base.sha.slice(0, 7)})` : ''
  return base.kind === 'head' ? `depuis le dernier commit ${base.ref || 'HEAD'}${sha}` : `depuis ${base.ref}${sha}`
}

/** Totaux des compteurs connus ; `unknown` : au moins un fichier non compté (« ? »). */
export function totals(files: readonly DiffFile[]): { additions: number; deletions: number; unknown: boolean } {
  const t = { additions: 0, deletions: 0, unknown: false }
  for (const f of files) {
    t.additions += f.additions ?? 0
    t.deletions += f.deletions ?? 0
    if (f.additions == null || f.deletions == null) t.unknown = true
  }
  return t
}

/** Compteur d'un fichier : nombre, ou « ? » s'il n'a pas été compté. */
export function countLabel(n: number | null | undefined): string {
  return typeof n === 'number' ? String(n) : '?'
}

/**
 * « 1 ajout », « 0 suppression », « 12 ajouts » (en français, 0 et 1 au
 * singulier) ; nombre inconnu : « nombre inconnu d'ajouts ».
 */
export function linesLabel(n: number | null | undefined, word: 'ajout' | 'suppression'): string {
  if (typeof n !== 'number') return `nombre inconnu ${word === 'ajout' ? 'd’ajouts' : 'de suppressions'}`
  return `${n} ${word}${n > 1 ? 's' : ''}`
}

/** Nombre de fichiers ignorés car non UTF-8 (liste ou nombre selon le démon). */
export function skippedCount(v: unknown): number {
  if (Array.isArray(v)) return v.length
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
}

/** Fichier suivant ou précédent dans la liste (bornée, pas de boucle). */
export function stepFile(files: readonly DiffFile[], current: string | null, delta: 1 | -1): string | null {
  if (files.length === 0) return null
  const i = files.findIndex((f) => f.path === current)
  if (i < 0) return files[0]!.path
  return files[Math.max(0, Math.min(files.length - 1, i + delta))]!.path
}

/**
 * Ajouts et suppressions du fichier ouvert (en tête du diff) : les compteurs
 * de la liste s'ils sont connus, sinon comptés dans les hunks chargés ;
 * `null` quand ni l'un ni l'autre n'est disponible (fichier binaire, trop
 * volumineux ou pas encore chargé).
 */
export function fileCounts(
  file: Pick<DiffFile, 'additions' | 'deletions'>,
  fd: FileDiff | null | undefined,
): { additions: number; deletions: number } | null {
  if (typeof file.additions === 'number' && typeof file.deletions === 'number') return { additions: file.additions, deletions: file.deletions }
  if (!fd || fd.binary || fd.too_large) return null
  const out = { additions: 0, deletions: 0 }
  for (const h of fd.hunks) {
    for (const l of h.lines) {
      if (l.kind === '+') out.additions++
      else if (l.kind === '-') out.deletions++
    }
  }
  return out
}
