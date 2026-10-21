/**
 * Édition d'un fichier dans l'onglet Fichiers (lot 7) : état pur, sans
 * CodeMirror ni appel au démon (le composant fait les appels et envoie ici
 * leurs résultats).
 *
 * `null` : lecture. Sinon, la version ouverte (`base`, `version`) et une
 * phase : `editing` → `saving` (`files.write` avec l'empreinte ouverte) →
 * lecture si l'écriture passe, `conflict` si le fichier a changé depuis son
 * ouverture. Depuis le conflit : « Recharger » (nouvelle base, modifications
 * perdues, édition continuée), « Écraser quand même » → `confirmOverwrite`
 * (seconde confirmation) → `overwriting` (`files.write` avec l'empreinte
 * actuelle) → lecture, ou nouveau conflit si le fichier a encore changé.
 */
import { t } from '../../../shared/i18n'
import type { FileContent, FileVersion } from '../../../shared/protocol'
import { daemonText } from './errors'

export type EditPhase = 'editing' | 'saving' | 'conflict' | 'confirmOverwrite' | 'overwriting'

export interface EditConflict {
  /**
   * Version actuelle sur le disque : connue (donnée par le démon ou relue),
   * `null` si le fichier n'existe plus, `undefined` tant qu'elle n'est pas connue.
   */
  version: FileVersion | null | undefined
  /** Contenu actuel (relu pour « Voir les différences ») ; `null` tant qu'il n'est pas lu ou s'il n'est pas lisible en texte. */
  content: string | null
  /** Relecture impossible (message affiché). */
  loadError: string | null
}

export interface EditState {
  path: string
  /** Texte de la version ouverte. */
  base: string
  version: FileVersion
  /** Le texte de l'éditeur diffère de `base`. */
  dirty: boolean
  phase: EditPhase
  conflict: EditConflict | null
  /** Dernière erreur d'enregistrement (hors conflit). */
  error: string | null
  /** Le fichier a changé sur le disque depuis son ouverture (vu par une relecture). */
  diskChanged: boolean
}

export type Edit = EditState | null

export type EditAction =
  | { type: 'begin'; path: string; content: string; version: FileVersion }
  | { type: 'change'; dirty: boolean }
  | { type: 'save' }
  | { type: 'saved' }
  | { type: 'conflict'; version: FileVersion | null | undefined }
  | { type: 'currentLoaded'; content: string | null; version: FileVersion | null | undefined }
  | { type: 'currentFailed'; error: string }
  | { type: 'askOverwrite' }
  | { type: 'cancelOverwrite' }
  | { type: 'overwrite' }
  | { type: 'failed'; error: string }
  | { type: 'reload'; content: string; version: FileVersion }
  | { type: 'diskSeen'; sha256: string | null }
  | { type: 'cancel' }

/**
 * Fichier modifiable : texte entier lu, avec son empreinte (démon du lot 7),
 * pas un lien, et `editable` du démon s'il le donne (sinon déduit du reste).
 */
export function canEdit(c: FileContent | null, isSymlink: boolean): boolean {
  if (!c || c.editable === false) return false
  return !c.binary && !c.too_large && c.content != null && isVersion(c.version) && !isSymlink
}

/**
 * Raison affichée sur un « Modifier » désactivé : le démon sait éditer
 * (`version` présente) mais refuse ce fichier ; `null` : pas de bouton.
 */
export function notEditableReason(c: FileContent | null): string | null {
  if (!c || c.editable !== false || c.version === undefined) return null
  const reason = c.not_editable_reason?.trim()
  return reason ? daemonText(reason) : t('files.edit.notEditable')
}

/** Forme d'une empreinte de fichier (venue du démon : vérifiée avant usage). */
export function isVersion(v: unknown): v is FileVersion {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return typeof o.sha256 === 'string' && /^[0-9a-f]{64}$/.test(o.sha256) && typeof o.size === 'number'
}

/**
 * Version actuelle donnée par un conflit (`data: {version}`) : la version,
 * `null` si le démon dit que le fichier n'existe plus, `undefined` si les
 * données sont absentes ou mal formées.
 */
export function conflictVersion(data: unknown): FileVersion | null | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const v = (data as Record<string, unknown>).version
  if (v === null) return null
  return isVersion(v) ? v : undefined
}

/** Empreinte attendue par le prochain `files.write` (`undefined` : rien à envoyer dans cette phase). */
export function expectedFor(e: Edit): { sha256: string } | null | undefined {
  if (!e) return undefined
  if (e.phase === 'saving') return { sha256: e.version.sha256 }
  if (e.phase === 'overwriting') {
    const v = e.conflict?.version
    if (v === undefined) return undefined
    return v === null ? null : { sha256: v.sha256 }
  }
  return undefined
}

/** « Écraser quand même » possible : version actuelle connue (ou fichier disparu). */
export function canOverwrite(e: Edit): boolean {
  return !!e && e.phase === 'conflict' && e.conflict !== null && e.conflict.version !== undefined
}

/** Saisie possible (pas pendant un enregistrement ni une seconde confirmation). */
export function editable(e: Edit): boolean {
  return !!e && (e.phase === 'editing' || e.phase === 'conflict')
}

export function editReducer(e: Edit, a: EditAction): Edit {
  if (a.type === 'begin') {
    return {
      path: a.path,
      base: a.content,
      version: a.version,
      dirty: false,
      phase: 'editing',
      conflict: null,
      error: null,
      diskChanged: false,
    }
  }
  if (!e) return e
  switch (a.type) {
    case 'change':
      return e.dirty === a.dirty ? e : { ...e, dirty: a.dirty }
    case 'save':
      // Un enregistrement depuis le conflit refait la même vérification (et retombe en conflit si besoin).
      return e.phase === 'editing' || e.phase === 'conflict' ? { ...e, phase: 'saving', error: null } : e
    case 'saved':
      // Écrit : retour en lecture (le composant affiche le contenu enregistré).
      return e.phase === 'saving' || e.phase === 'overwriting' ? null : e
    case 'conflict':
      if (e.phase !== 'saving' && e.phase !== 'overwriting') return e
      return { ...e, phase: 'conflict', error: null, conflict: { version: a.version, content: null, loadError: null } }
    case 'currentLoaded': {
      if (!e.conflict) return e
      // Version relue plus précise que celle du conflit (ou seule connue).
      const version = a.version !== undefined ? a.version : e.conflict.version
      return { ...e, conflict: { version, content: a.content, loadError: null } }
    }
    case 'currentFailed':
      return e.conflict ? { ...e, conflict: { ...e.conflict, loadError: a.error } } : e
    case 'askOverwrite':
      return canOverwrite(e) ? { ...e, phase: 'confirmOverwrite' } : e
    case 'cancelOverwrite':
      return e.phase === 'confirmOverwrite' ? { ...e, phase: 'conflict' } : e
    case 'overwrite':
      return e.phase === 'confirmOverwrite' ? { ...e, phase: 'overwriting', error: null } : e
    case 'failed':
      if (e.phase === 'saving') return { ...e, phase: e.conflict ? 'conflict' : 'editing', error: a.error }
      if (e.phase === 'overwriting') return { ...e, phase: 'conflict', error: a.error }
      return e
    case 'reload':
      // Version actuelle prise comme nouvelle base : modifications perdues, édition continuée.
      return {
        path: e.path,
        base: a.content,
        version: a.version,
        dirty: false,
        phase: 'editing',
        conflict: null,
        error: null,
        diskChanged: false,
      }
    case 'diskSeen': {
      const changed = a.sha256 !== e.version.sha256
      return changed === e.diskChanged ? e : { ...e, diskChanged: changed }
    }
    case 'cancel':
      return null
  }
}

/** Fins de ligne d'un texte : seules `lf` et `crlf` se conservent telles quelles dans l'éditeur. */
export type EolStyle = 'lf' | 'crlf' | 'mixed'

export function eolStyle(text: string): EolStyle {
  if (!text.includes('\r')) return 'lf'
  const crlf = text.split('\r\n').length - 1
  const lf = text.split('\n').length - 1
  const cr = text.split('\r').length - 1
  return crlf === lf && crlf === cr ? 'crlf' : 'mixed'
}

/** Fins de ligne ramenées au style du fichier (`\r\n?` ou `\n` → `\r\n` en CRLF ; `\r\n?` → `\n` en LF). */
export function normalizeEol(text: string, style: 'lf' | 'crlf'): string {
  return style === 'crlf' ? text.replace(/\r\n?|\n/g, '\r\n') : text.replace(/\r\n?/g, '\n')
}
