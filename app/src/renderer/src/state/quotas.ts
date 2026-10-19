/**
 * Quotas par profil (5 h et hebdomadaire) : pour chaque fenêtre, la mesure la
 * plus récente parmi les sessions du profil (`metrics.rate_limits`, issue de
 * la statusline). `null` = inconnu, y compris quand l'heure de remise à zéro
 * de la fenêtre est passée (la valeur ne dit plus rien de la fenêtre en cours).
 */
import type { Profile, RateLimitWindow, Session } from '../../../shared/protocol'

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

/** Niveau de la jauge : normal, chaud (≥ 75 %), critique (≥ 90 %). */
export function meterLevel(pct: number | null | undefined): '' | 'hot' | 'crit' {
  if (typeof pct !== 'number') return ''
  return pct >= 90 ? 'crit' : pct >= 75 ? 'hot' : ''
}
