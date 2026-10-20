/** Nombre de teintes de profil (`.p0` à `.p3` dans `styles.css`). */
export const PROFILE_TONES = 4

/**
 * Teinte stable d'un profil : son rang dans `profiles.list`, sinon un hachage
 * de son nom. Décorative : la lettre du badge et le libellé portent l'information.
 */
export function profileTone(profile: string, profiles: { name: string }[]): number {
  const i = profiles.findIndex((p) => p.name === profile)
  if (i >= 0) return i % PROFILE_TONES
  let h = 0
  for (const c of profile) h = (h * 31 + c.codePointAt(0)!) >>> 0
  return h % PROFILE_TONES
}
