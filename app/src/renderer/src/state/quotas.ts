/**
 * Quotas par profil (5 h et hebdomadaire) : pour chaque fenêtre, la mesure la
 * plus récente parmi les sessions du profil (`metrics.rate_limits`, issue de
 * la statusline). `null` = inconnu, y compris quand l'heure de remise à zéro
 * de la fenêtre est passée (la valeur ne dit plus rien de la fenêtre en cours).
 */
import type { DaemonProfileQuota, DaemonQuotaWindow, Profile, RateLimitWindow, Session } from '../../../shared/protocol'
import { t, type PlainKey } from '../../../shared/i18n'

export interface ProfileQuota {
  profile: string
  fiveHour: RateLimitWindow | null
  sevenDay: RateLimitWindow | null
}

function stamp(s: Session): number {
  const t = Date.parse(s.updated_at ?? s.last_activity ?? '')
  return Number.isNaN(t) ? -Infinity : t
}

/** Mesure exploitable : pourcentage connu, fenêtre pas encore remise à zéro. */
function usable(w: RateLimitWindow | null | undefined, now: number): w is RateLimitWindow {
  if (!w || typeof w.used_pct !== 'number') return false
  if (w.resets_at) {
    const t = Date.parse(w.resets_at)
    if (!Number.isNaN(t) && t <= now) return false // fenêtre écoulée : valeur inconnue
  }
  return true
}

export function quotasByProfile(sessions: Iterable<Session>, profiles: Profile[], now = Date.now()): ProfileQuota[] {
  const names: string[] = profiles.map((p) => p.name)
  const best = new Map<string, { five: [number, RateLimitWindow] | null; seven: [number, RateLimitWindow] | null }>()
  for (const name of names) best.set(name, { five: null, seven: null })
  for (const s of sessions) {
    if (!best.has(s.profile)) {
      names.push(s.profile)
      best.set(s.profile, { five: null, seven: null })
    }
    const b = best.get(s.profile)!
    const rl = s.metrics?.rate_limits
    const t = stamp(s)
    if (usable(rl?.five_hour, now) && (!b.five || t > b.five[0])) b.five = [t, rl.five_hour]
    if (usable(rl?.seven_day, now) && (!b.seven || t > b.seven[0])) b.seven = [t, rl.seven_day]
  }
  return names.map((profile) => {
    const b = best.get(profile)!
    return { profile, fiveHour: b.five?.[1] ?? null, sevenDay: b.seven?.[1] ?? null }
  })
}

/** Seuil « critique » de la jauge (rouge) : aussi celui du « compte au plafond » (lot 15 ter). */
export const QUOTA_CRIT_PCT = 90

/** Niveau de la jauge : normal, chaud (≥ 75 %), critique (≥ `QUOTA_CRIT_PCT`). */
export function meterLevel(pct: number | null | undefined): '' | 'hot' | 'crit' {
  if (typeof pct !== 'number') return ''
  return pct >= QUOTA_CRIT_PCT ? 'crit' : pct >= 75 ? 'hot' : ''
}

/** Origine et date d'une fenêtre affichée (pour l'infobulle). */
export interface WindowMeta {
  source: string | null
  fetchedAt: string | null
}

export interface QuotaView {
  profile: string
  fiveHour: RateLimitWindow | null
  sevenDay: RateLimitWindow | null
  fiveHourMeta: WindowMeta | null
  sevenDayMeta: WindowMeta | null
  /** Origine des valeurs affichées. */
  source: 'usage_api' | 'statusline' | null
  /** Pourquoi une mesure manque (message du démon), pour l'infobulle. */
  error: string | null
  fetchedAt: string | null
}

function fromDaemon(w: DaemonQuotaWindow | null | undefined): RateLimitWindow | null {
  if (!w || typeof w.used_percentage !== 'number' || !Number.isFinite(w.used_percentage)) return null
  return { used_pct: w.used_percentage, resets_at: w.resets_at ?? null }
}

/**
 * Quotas à afficher : ceux du démon (`quotas.get`, disponibles dès le
 * démarrage, avant toute session) quand ils sont exploitables, sinon ceux de
 * la statusline des sessions (démon plus ancien, ou mesure manquante).
 * Profils : ceux de `profiles.list`, puis ceux que seul le démon ou une
 * session connaît.
 */
export function quotaViews(
  sessions: Iterable<Session>,
  profiles: Profile[],
  daemon: Record<string, DaemonProfileQuota> | null,
  now = Date.now(),
): QuotaView[] {
  const fallback = quotasByProfile(sessions, profiles, now)
  const names = fallback.map((q) => q.profile)
  for (const name of Object.keys(daemon ?? {})) if (!names.includes(name)) names.push(name)
  return names.map((profile) => {
    const sl = fallback.find((q) => q.profile === profile)
    const d = daemon?.[profile]
    const five = fromDaemon(d?.five_hour)
    const seven = fromDaemon(d?.seven_day)
    const fiveD = usable(five, now)
    const sevenD = usable(seven, now)
    const fiveHour = fiveD ? five : (sl?.fiveHour ?? null)
    const sevenDay = sevenD ? seven : (sl?.sevenDay ?? null)
    // Origine par fenêtre si le démon la donne, sinon celle du profil.
    const meta = (w: DaemonQuotaWindow | null | undefined, fromDaemon: boolean, shown: unknown): WindowMeta | null => {
      if (!shown) return null
      if (!fromDaemon) return { source: 'statusline', fetchedAt: null }
      return { source: w?.source ?? d?.source ?? null, fetchedAt: w?.fetched_at ?? d?.fetched_at ?? null }
    }
    const fromD = (usable(five, now) || usable(seven, now)) && d?.source ? d.source : null
    const fromSl = !fromD && (sl?.fiveHour || sl?.sevenDay) ? 'statusline' : null
    return {
      profile,
      fiveHour,
      sevenDay,
      fiveHourMeta: meta(d?.five_hour, fiveD, fiveHour),
      sevenDayMeta: meta(d?.seven_day, sevenD, sevenDay),
      source: fromD ?? fromSl,
      error: typeof d?.error === 'string' && d.error.trim() ? d.error.trim() : null,
      fetchedAt: d?.fetched_at ?? null,
    }
  })
}

/** Délai maximal d'attente des valeurs fraîches après « Actualiser ». */
export const QUOTA_REFRESH_MS = 15_000

/**
 * Actualisation terminée ? `quotas.get {refresh: true}` répond tout de suite
 * avec l'instantané courant ; les valeurs fraîches arrivent ensuite par
 * `quotas.updated`. Terminée quand chaque profil attendu a reçu au moins un
 * `quotas.updated` depuis le clic (ou au bout de `QUOTA_REFRESH_MS`, côté composant).
 */
export function refreshSettled(
  before: Record<string, number>,
  now: Record<string, number>,
  profiles: readonly string[],
): boolean {
  return profiles.every((p) => (now[p] ?? 0) > (before[p] ?? 0))
}

const SOURCE_LABELS: Record<string, PlainKey> = {
  usage_api: 'shell.quotas.source.usageApi',
  statusline: 'shell.quotas.source.statusline',
}

export function sourceLabel(s: string | null | undefined): string | null {
  if (!s) return null
  const key = Object.prototype.hasOwnProperty.call(SOURCE_LABELS, s) ? SOURCE_LABELS[s] : undefined
  return key ? t(key) : s
}
