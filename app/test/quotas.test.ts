import { describe, expect, it } from 'vitest'

import { meterLevel, quotasByProfile } from '../src/renderer/src/state/quotas'
import type { Profile } from '../src/shared/protocol'
import { session } from './fixtures'

const profiles: Profile[] = [
  { name: 'default', config_dir: '/home/u/.claude', sets_config_dir_env: false },
  { name: 'work', config_dir: '/home/u/.claude-work', sets_config_dir_env: true },
]

const NOW = Date.parse('2026-10-19T12:00:00Z')

const rl = (five: number | null, seven: number | null) => ({
  rate_limits: {
    five_hour: five === null ? null : { used_pct: five, resets_at: '2026-10-19T14:30:00Z' },
    seven_day: seven === null ? null : { used_pct: seven, resets_at: '2026-10-20T09:00:00Z' },
  },
})

describe('quotas par profil', () => {
  it('inconnu sans mesure, profils de profiles.list dans l’ordre', () => {
    const q = quotasByProfile([], profiles)
    expect(q).toEqual([
      { profile: 'default', fiveHour: null, sevenDay: null },
      { profile: 'work', fiveHour: null, sevenDay: null },
    ])
  })

  it('mesure la plus récente par fenêtre, séparément par profil', () => {
    const q = quotasByProfile(
      [
        session({ profile: 'default', updated_at: '2026-10-19T10:00:00Z', metrics: rl(10, 30) }),
        session({ profile: 'default', updated_at: '2026-10-19T11:00:00Z', metrics: rl(20, null) }),
        session({ profile: 'work', updated_at: '2026-10-19T12:00:00Z', metrics: rl(50, 60) }),
        session({ profile: 'default', updated_at: '2026-10-19T13:00:00Z', metrics: null }),
      ],
      profiles,
      NOW,
    )
    expect(q[0]!.fiveHour!.used_pct).toBe(20)
    // seven_day null dans la plus récente : on garde la dernière connue.
    expect(q[0]!.sevenDay!.used_pct).toBe(30)
    expect(q[1]!.fiveHour!.used_pct).toBe(50)
    expect(q[1]!.sevenDay!.used_pct).toBe(60)
  })

  it('profil vu seulement dans une session : ajouté', () => {
    const q = quotasByProfile([session({ profile: 'autre', metrics: rl(5, null) })], profiles, NOW)
    expect(q.map((x) => x.profile)).toEqual(['default', 'work', 'autre'])
    expect(q[2]!.sevenDay).toBeNull()
  })

  it('fenêtre dont la remise à zéro est passée : inconnue', () => {
    const s = session({ metrics: rl(40, 70) }) // 5 h : 14:30, hebdo : 20/10 09:00
    const before = quotasByProfile([s], profiles, Date.parse('2026-10-19T14:00:00Z'))
    expect(before[0]!.fiveHour!.used_pct).toBe(40)
    const after = quotasByProfile([s], profiles, Date.parse('2026-10-19T14:31:00Z'))
    expect(after[0]!.fiveHour).toBeNull()
    expect(after[0]!.sevenDay!.used_pct).toBe(70)
    // Une mesure plus ancienne mais encore valable n'est pas masquée par une périmée.
    const fresh = session({
      updated_at: '2026-10-19T09:00:00Z',
      metrics: { rate_limits: { five_hour: { used_pct: 3, resets_at: '2026-10-19T19:00:00Z' }, seven_day: null } },
    })
    expect(quotasByProfile([s, fresh], profiles, Date.parse('2026-10-19T15:00:00Z'))[0]!.fiveHour!.used_pct).toBe(3)
  })

  it('used_pct nul : ignoré', () => {
    const q = quotasByProfile(
      [session({ metrics: { rate_limits: { five_hour: { used_pct: null, resets_at: null }, seven_day: null } } })],
      profiles,
    )
    expect(q[0]!.fiveHour).toBeNull()
  })

  it('niveaux de jauge', () => {
    expect(meterLevel(10)).toBe('')
    expect(meterLevel(75)).toBe('hot')
    expect(meterLevel(90)).toBe('crit')
    expect(meterLevel(null)).toBe('')
  })
})
