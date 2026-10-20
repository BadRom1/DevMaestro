/** Mise en forme pour l'interface (français). */
import { SESSION_COLORS, type PastSession, type ProjectInfo, type Session, type SessionColor } from '../../../shared/protocol'

const nf = new Intl.NumberFormat('fr-FR')
const money2 = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function formatNumber(n: number | null | undefined): string {
  return typeof n === 'number' && Number.isFinite(n) ? nf.format(n) : 'inconnu'
}

/** Coût tel que fourni par Claude Code (en dollars). */
const compact1 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 })

/**
 * Nombre compact (tailles de contexte, tokens) : « 840 », « 1,2k », « 122k »,
 * « 1M », « 1,1M », « 25M ». Une décimale (virgule) sous 10, aucune au-delà.
 */
export function formatCompact(n: number | null | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 'inconnu'
  const a = Math.abs(n)
  // Signe seulement si la valeur arrondie n'est pas nulle (jamais « -0 »).
  const sign = n < 0 && a >= 0.5 ? '-' : ''
  if (a < 999.5) return sign + nf.format(Math.round(a))
  const scaled = (v: number) => (v < 10 ? Math.round(v * 10) / 10 : Math.round(v))
  const k = scaled(a / 1000)
  if (k < 1000) return `${sign}${compact1.format(k)}k`
  const m = scaled(a / 1_000_000)
  return `${sign}${compact1.format(m)}M`
}

export function formatUsd(n: number | null | undefined): string {
  return typeof n === 'number' && Number.isFinite(n) ? `${money2.format(n)} $` : 'inconnu'
}

export function formatPct(n: number | null | undefined): string {
  return typeof n === 'number' && Number.isFinite(n) ? `${Math.round(n)} %` : 'inconnu'
}

function parse(iso: string | null | undefined): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : t
}

/** « à l'instant », « il y a 5 min », « il y a 2 h », « hier », « il y a 3 j ». */
export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  const t = parse(iso)
  if (t === null) return 'inconnue'
  const min = Math.floor((now - t) / 60_000)
  if (min < 1) return "à l'instant"
  if (min < 60) return `il y a ${min} min`
  const h = Math.floor(min / 60)
  if (h < 24) return `il y a ${h} h`
  const d = Math.floor(h / 24)
  return d === 1 ? 'hier' : `il y a ${d} j`
}

/** Version courte pour la barre latérale : « 5 min », « 2 h », « hier ». */
export function shortAgo(iso: string | null | undefined, now = Date.now()): string {
  const r = relativeTime(iso, now)
  return r.startsWith('il y a ') ? r.slice('il y a '.length) : r === 'inconnue' ? '—' : r
}

/** Heure de remise à zéro d'un quota : « 14:30 » le jour même, sinon « lun. 09:00 ». */
export function formatReset(iso: string | null | undefined, now = Date.now()): string | null {
  const t = parse(iso)
  if (t === null) return null
  const d = new Date(t)
  const time = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
  if (new Date(now).toDateString() === d.toDateString()) return time
  return `${d.toLocaleDateString('fr-FR', { weekday: 'short' })} ${time}`
}

export const MODE_LABELS: Record<string, string> = {
  default: 'Par défaut',
  manual: 'Par défaut',
  acceptEdits: 'Accepter les modifs',
  plan: 'Plan',
  auto: 'Auto',
  dontAsk: 'Ne rien demander',
  bypassPermissions: 'Sans permissions',
}

export function modeLabel(mode: string | null | undefined): string {
  if (!mode) return 'inconnu'
  return MODE_LABELS[mode] ?? mode
}

/** Remplace le dossier personnel par « ~ ». */
export function tildify(p: string, home: string | null): string {
  if (home && (p === home || p.startsWith(home + '/'))) return '~' + p.slice(home.length)
  return p
}

export function basename(p: string): string {
  const parts = p.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? p
}

const ELLIPSIS = '…'

/**
 * Tronque un chemin **par le début** pour qu'il tienne en `max` caractères :
 * « ~/workplace/perso/Orchestrateur » → « …/perso/Orchestrateur ». On retire
 * des segments entiers tant que possible ; si le dernier segment seul est trop
 * long, il est coupé par le début (« …rateur »). Le résultat compte au plus
 * `max` caractères (points de code), ellipse comprise.
 */
export function truncateStart(path: string, max: number): string {
  const chars = [...path]
  if (chars.length <= max) return path
  if (max <= 0) return ''
  if (max === 1) return ELLIPSIS
  // Chaque position de « / » après le début : on garde la fin à partir de là.
  for (let i = 1; i < chars.length; i++) {
    if (chars[i] !== '/') continue
    const rest = chars.length - i
    if (rest + 1 <= max) return ELLIPSIS + chars.slice(i).join('')
  }
  // Même le dernier segment ne tient pas : coupe brute.
  return ELLIPSIS + chars.slice(chars.length - (max - 1)).join('')
}

/** Nom affiché d'une session : celui du démon, sinon un repli équivalent (démon plus ancien). */
export function sessionDisplayName(
  s: Pick<Session, 'id' | 'display_name' | 'title' | 'metrics' | 'branch' | 'cwd'>,
): string {
  const pick = (v: string | null | undefined) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)
  return (
    pick(s.display_name) ??
    pick(s.title) ??
    pick(s.metrics?.session_name) ??
    // Démon sans `display_name` : la branche ou le dossier parlent plus qu'un identifiant.
    pick(s.branch) ??
    pick(basename(s.cwd)) ??
    s.id.slice(0, 8)
  )
}

/** Nom affiché d'une ancienne session. */
export function pastDisplayName(
  p: Pick<PastSession, 'claude_session_id' | 'display_name' | 'title' | 'first_prompt'>,
): string {
  const pick = (v: string | null | undefined) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)
  return pick(p.display_name) ?? pick(p.title) ?? pick(p.first_prompt) ?? p.claude_session_id.slice(0, 8)
}

/** Le démon connaît-il le nommage des sessions (`display_name`, `sessions.update`) ? */
export function supportsNaming(s: Session): boolean {
  return typeof s.display_name === 'string'
}

export const COLOR_LABELS: Record<SessionColor, string> = {
  gris: 'Gris',
  bleu: 'Bleu',
  vert: 'Vert',
  jaune: 'Jaune',
  orange: 'Orange',
  rouge: 'Rouge',
  violet: 'Violet',
  rose: 'Rose',
}

/** Couleur connue de la palette, ou `null` (valeur absente ou inattendue). */
export function sessionColor(s: Pick<Session, 'color'>): SessionColor | null {
  const c = s.color
  return typeof c === 'string' && (SESSION_COLORS as readonly string[]).includes(c) ? c : null
}

/** Le dossier de la session a-t-il disparu (worktree supprimé…) ? */
export function folderMissing(
  s: Pick<Session, 'resume_blocker'>,
  project: Pick<ProjectInfo, 'exists'> | undefined,
): boolean {
  // Le démon fait foi quand il donne le champ (un worktree recréé n'est plus « supprimé ») ;
  // sinon, la résolution mise en cache.
  if (s.resume_blocker !== undefined) return s.resume_blocker === 'cwd_missing'
  return project?.exists === false
}

/** Le démon dit-il que le dossier de la session existe ? (`undefined` : il ne le dit pas.) */
export function daemonSaysFolderExists(s: Pick<Session, 'resume_blocker'>): boolean | undefined {
  return s.resume_blocker === undefined ? undefined : s.resume_blocker !== 'cwd_missing'
}

export interface ResumeBlock {
  /** Pour une pastille : « pas de transcript », « dossier supprimé (worktree ?) ». */
  short: string
  /** Pour une infobulle. */
  long: string
}

/**
 * Pourquoi une session arrêtée ne peut pas être reprise, ou `null` (reprise
 * possible, ou inconnu avec un démon plus ancien : la reprise reste proposée).
 */
export function resumeBlock(
  s: Pick<Session, 'alive' | 'resumable' | 'resume_blocker' | 'cwd'>,
  project?: Pick<ProjectInfo, 'exists'>,
): ResumeBlock | null {
  if (s.alive) return null
  if (folderMissing(s, project)) {
    return {
      short: 'dossier supprimé (worktree ?)',
      long: `Le dossier de la session n’existe plus (worktree supprimé ?) : ${s.cwd}. Elle ne peut pas être reprise.`,
    }
  }
  if (s.resume_blocker === 'transcript_missing' || s.resumable === false) {
    return {
      short: 'pas de transcript',
      long: 'Claude Code n’a pas de transcript pour cette session (aucun échange enregistré) : elle ne peut pas être reprise.',
    }
  }
  return null
}
