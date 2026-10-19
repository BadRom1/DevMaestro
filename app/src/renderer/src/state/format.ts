/** Mise en forme pour l'interface (français). */

const nf = new Intl.NumberFormat('fr-FR')
const money2 = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function formatNumber(n: number | null | undefined): string {
  return typeof n === 'number' && Number.isFinite(n) ? nf.format(n) : 'inconnu'
}

/** Coût tel que fourni par Claude Code (en dollars). */
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
