/**
 * Réglages de l'app (propres à l'utilisateur), gardés par le processus
 * principal dans `userData/settings.json` et transmis à la page par IPC.
 *
 * - `normalizeSettings` : lecture tolérante d'un fichier (champ invalide →
 *   valeur par défaut, le reste est gardé).
 * - `validatePatch` : modification venue de la page (non fiable), stricte.
 * - `applyPatch` : réglages + modification validée.
 */

export type ThemeMode = 'light' | 'dark' | 'system'
export const THEME_MODES: readonly ThemeMode[] = ['light', 'dark', 'system']

export type PaletteName = 'devmaestro' | 'okabe' | 'contraste'
export const PALETTE_NAMES: readonly PaletteName[] = ['devmaestro', 'okabe', 'contraste']

/** Jetons sémantiques personnalisables. */
export type ThemeToken = 'accent' | 'wait' | 'run' | 'done' | 'err' | 'add' | 'del'
export const THEME_TOKENS: readonly ThemeToken[] = ['accent', 'wait', 'run', 'done', 'err', 'add', 'del']

export type ColorOverrides = Partial<Record<ThemeToken, string>>

export interface ThemeSettings {
  mode: ThemeMode
  palette: PaletteName
  /** Couleurs choisies par l'utilisateur, par mode (s'ajoutent à la palette). */
  custom: { light: ColorOverrides; dark: ColorOverrides }
}

export interface AppSettings {
  version: 1
  theme: ThemeSettings
  notifications: { enabled: boolean }
  /** Profil par défaut par projet (racine du dépôt ou dossier → nom de profil). */
  projectProfiles: Record<string, string>
  /** Demander confirmation avant de retirer une session ou masquer une ancienne. */
  confirmRemoval: boolean
  /** Libellés choisis par profil (nom technique du démon → libellés) ; absents : valeurs par défaut. */
  profileLabels: Record<string, ProfileLabel>
}

export interface ProfileLabel {
  /** Libellé long (≤ 30 caractères), ex. « Perso ». */
  long: string
  /** Libellé court pour les pastilles (1 à 3 caractères visibles), ex. « P ». */
  short: string
}

export const MAX_LONG_LABEL = 30
export const MAX_SHORT_LABEL = 3

export interface SettingsPatch {
  /** Remplace tout le thème. */
  theme?: ThemeSettings
  notifications?: { enabled: boolean }
  /** Fusionné : `null` retire l'entrée. */
  projectProfiles?: Record<string, string | null>
  confirmRemoval?: boolean
  /** Fusionné : `null` rend les libellés par défaut. */
  profileLabels?: Record<string, ProfileLabel | null>
}

export const MAX_PROJECT_PROFILES = 500
const MAX_PATH = 4096
const MAX_PROFILE = 200

export function defaultSettings(): AppSettings {
  return {
    version: 1,
    theme: { mode: 'system', palette: 'devmaestro', custom: { light: {}, dark: {} } },
    notifications: { enabled: true },
    projectProfiles: {},
    confirmRemoval: true,
    profileLabels: {},
  }
}

const INVISIBLE = /[\p{Cc}\p{Cf}\p{Z}\s]/u

function chars(s: string): number {
  return [...s].length
}

/** Libellés valides (blancs de bord retirés), ou message d'erreur en français. */
export function checkProfileLabel(v: unknown): ProfileLabel | string {
  if (!isObj(v) || typeof v.long !== 'string' || typeof v.short !== 'string') return 'libellés attendus : { long, short }'
  const long = v.long.trim()
  const short = v.short.trim()
  if (long === '' || chars(long) > MAX_LONG_LABEL) return `le libellé long doit compter de 1 à ${MAX_LONG_LABEL} caractères`
  if (/\p{Cc}/u.test(long)) return 'le libellé long ne doit pas contenir de caractère de contrôle'
  if (chars(short) < 1 || chars(short) > MAX_SHORT_LABEL || INVISIBLE.test(short)) {
    return `le libellé court doit compter de 1 à ${MAX_SHORT_LABEL} caractères visibles, sans espace`
  }
  return { long, short }
}

function capitalize(s: string): string {
  const [first, ...rest] = [...s]
  return first ? first.toLocaleUpperCase('fr-FR') + rest.join('') : s
}

/**
 * Libellés d'un profil : ceux choisis dans les réglages, sinon « Défaut » pour
 * `default` et le nom du démon avec une majuscule pour les autres ; le libellé
 * court par défaut est la première lettre (majuscule) du libellé long.
 */
export function profileLabel(name: string, labels: Record<string, ProfileLabel> | undefined): ProfileLabel {
  const set = labels?.[name]
  const long = set?.long ?? (name === 'default' ? 'Défaut' : capitalize(name))
  const firstVisible = [...long].find((c) => !INVISIBLE.test(c)) ?? '?'
  return { long, short: set?.short ?? firstVisible.toLocaleUpperCase('fr-FR') }
}

const HEX = /^#[0-9a-f]{6}$/i

export function isHexColor(v: unknown): v is string {
  return typeof v === 'string' && HEX.test(v)
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isProjectKey(k: string): boolean {
  return k.startsWith('/') && k.length <= MAX_PATH && !k.includes('\0')
}

function isProfileName(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '' && v.length <= MAX_PROFILE
}

/** Couleurs valides seulement (minuscules), jetons inconnus retirés. */
function overrides(v: unknown, strict: boolean, where: string): ColorOverrides {
  if (!isObj(v)) {
    if (strict) throw new SettingsError(`« ${where} » doit être un objet`)
    return {}
  }
  const out: ColorOverrides = {}
  for (const [k, c] of Object.entries(v)) {
    if (!(THEME_TOKENS as readonly string[]).includes(k)) {
      if (strict) throw new SettingsError(`jeton de couleur inconnu : ${k}`)
      continue
    }
    if (!isHexColor(c)) {
      if (strict) throw new SettingsError(`couleur invalide pour ${k} (attendu : #rrggbb)`)
      continue
    }
    out[k as ThemeToken] = c.toLowerCase()
  }
  return out
}

function theme(v: unknown, strict: boolean): ThemeSettings {
  const d = defaultSettings().theme
  if (!isObj(v)) {
    if (strict) throw new SettingsError('« theme » doit être un objet')
    return d
  }
  const mode = (THEME_MODES as readonly unknown[]).includes(v.mode) ? (v.mode as ThemeMode) : null
  const palette = (PALETTE_NAMES as readonly unknown[]).includes(v.palette) ? (v.palette as PaletteName) : null
  if (strict && !mode) throw new SettingsError('« theme.mode » doit valoir light, dark ou system')
  if (strict && !palette) throw new SettingsError('« theme.palette » inconnue')
  const custom = isObj(v.custom) ? v.custom : strict ? null : {}
  if (!custom) throw new SettingsError('« theme.custom » doit être un objet')
  return {
    mode: mode ?? d.mode,
    palette: palette ?? d.palette,
    custom: {
      light: custom.light === undefined && !strict ? {} : overrides(custom.light ?? {}, strict, 'theme.custom.light'),
      dark: custom.dark === undefined && !strict ? {} : overrides(custom.dark ?? {}, strict, 'theme.custom.dark'),
    },
  }
}

export class SettingsError extends Error {
  override name = 'SettingsError'
}

/** Lecture tolérante (fichier de réglages, éventuellement d'une autre version). */
export function normalizeSettings(raw: unknown): AppSettings {
  const d = defaultSettings()
  if (!isObj(raw)) return d
  const profiles: Record<string, string> = {}
  if (isObj(raw.projectProfiles)) {
    for (const [k, v] of Object.entries(raw.projectProfiles)) {
      if (Object.keys(profiles).length >= MAX_PROJECT_PROFILES) break
      if (isProjectKey(k) && isProfileName(v)) profiles[k] = v
    }
  }
  return {
    version: 1,
    theme: theme(raw.theme, false),
    notifications: {
      enabled: isObj(raw.notifications) && typeof raw.notifications.enabled === 'boolean' ? raw.notifications.enabled : true,
    },
    projectProfiles: profiles,
    confirmRemoval: typeof raw.confirmRemoval === 'boolean' ? raw.confirmRemoval : d.confirmRemoval,
    profileLabels: labelsFrom(raw.profileLabels),
  }
}

function labelsFrom(v: unknown): Record<string, ProfileLabel> {
  const out: Record<string, ProfileLabel> = {}
  if (!isObj(v)) return out
  for (const [k, l] of Object.entries(v)) {
    if (Object.keys(out).length >= MAX_PROJECT_PROFILES) break
    const c = checkProfileLabel(l)
    if (isProfileName(k) && typeof c !== 'string') out[k] = c
  }
  return out
}

/** Modification venue de la page : stricte, champs inconnus refusés. */
export function validatePatch(raw: unknown): SettingsPatch {
  if (!isObj(raw)) throw new SettingsError('modification des réglages : objet attendu')
  const out: SettingsPatch = {}
  for (const k of Object.keys(raw)) {
    if (!['theme', 'notifications', 'projectProfiles', 'confirmRemoval', 'profileLabels'].includes(k)) {
      throw new SettingsError(`réglage inconnu : ${k}`)
    }
  }
  if (raw.theme !== undefined) out.theme = theme(raw.theme, true)
  if (raw.notifications !== undefined) {
    if (!isObj(raw.notifications) || typeof raw.notifications.enabled !== 'boolean') {
      throw new SettingsError('« notifications.enabled » doit être un booléen')
    }
    out.notifications = { enabled: raw.notifications.enabled }
  }
  if (raw.projectProfiles !== undefined) {
    if (!isObj(raw.projectProfiles)) throw new SettingsError('« projectProfiles » doit être un objet')
    const entries = Object.entries(raw.projectProfiles)
    if (entries.length > MAX_PROJECT_PROFILES) throw new SettingsError('trop de projets')
    const pp: Record<string, string | null> = {}
    for (const [k, v] of entries) {
      if (!isProjectKey(k)) throw new SettingsError('projet : chemin absolu attendu')
      if (v !== null && !isProfileName(v)) throw new SettingsError(`profil invalide pour ${k}`)
      pp[k] = v
    }
    out.projectProfiles = pp
  }
  if (raw.confirmRemoval !== undefined) {
    if (typeof raw.confirmRemoval !== 'boolean') throw new SettingsError('« confirmRemoval » doit être un booléen')
    out.confirmRemoval = raw.confirmRemoval
  }
  if (raw.profileLabels !== undefined) {
    if (!isObj(raw.profileLabels)) throw new SettingsError('« profileLabels » doit être un objet')
    const pl: Record<string, ProfileLabel | null> = {}
    for (const [k, v] of Object.entries(raw.profileLabels)) {
      if (!isProfileName(k)) throw new SettingsError('nom de profil invalide')
      if (v === null) {
        pl[k] = null
        continue
      }
      const c = checkProfileLabel(v)
      if (typeof c === 'string') throw new SettingsError(`profil ${k} : ${c}`)
      pl[k] = c
    }
    out.profileLabels = pl
  }
  return out
}

export function applyPatch(s: AppSettings, p: SettingsPatch): AppSettings {
  const next: AppSettings = { ...s }
  if (p.theme) next.theme = p.theme
  if (p.notifications) next.notifications = { ...p.notifications }
  if (p.projectProfiles) {
    const pp = { ...s.projectProfiles }
    for (const [k, v] of Object.entries(p.projectProfiles)) {
      if (v === null) delete pp[k]
      else pp[k] = v
    }
    // Au-delà de la limite, les plus anciennes entrées sont oubliées.
    const keys = Object.keys(pp)
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_PROJECT_PROFILES))) delete pp[k]
    next.projectProfiles = pp
  }
  if (p.confirmRemoval !== undefined) next.confirmRemoval = p.confirmRemoval
  if (p.profileLabels) {
    const pl = { ...s.profileLabels }
    for (const [k, v] of Object.entries(p.profileLabels)) {
      if (v === null) delete pl[k]
      else pl[k] = v
    }
    next.profileLabels = pl
  }
  return next
}

/** Deux modifications successives en une seule (la seconde l'emporte). */
export function mergePatches(a: SettingsPatch, b: SettingsPatch): SettingsPatch {
  const out: SettingsPatch = { ...a, ...b }
  if (a.projectProfiles && b.projectProfiles) out.projectProfiles = { ...a.projectProfiles, ...b.projectProfiles }
  if (a.profileLabels && b.profileLabels) out.profileLabels = { ...a.profileLabels, ...b.profileLabels }
  return out
}
