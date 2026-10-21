/**
 * Réglages de l'app (propres à l'utilisateur), gardés par le processus
 * principal dans `userData/settings.json` et transmis à la page par IPC.
 *
 * - `normalizeSettings` : lecture tolérante d'un fichier (champ invalide →
 *   valeur par défaut, le reste est gardé).
 * - `validatePatch` : modification venue de la page (non fiable), stricte.
 * - `applyPatch` : réglages + modification validée.
 */

import { MAX_STORED_TEMPLATE, PROMPT_IDS, defaultPrompt, isPromptId, overridesFrom, promptDef, promptProblem, type PromptId, type PromptSettings } from './prompts'
import { DELIVERY_MODES, type DeliveryMode } from './protocol'
import { DEFAULT_WORKTREE_LOCATIONS, branchPrefixProblem, type DefaultWorktreeLocation } from './worktrees'

export type ThemeMode = 'light' | 'dark' | 'system'
export const THEME_MODES: readonly ThemeMode[] = ['light', 'dark', 'system']

export type PaletteName = 'devmaestro' | 'okabe' | 'contraste'
export const PALETTE_NAMES: readonly PaletteName[] = ['devmaestro', 'okabe', 'contraste']

/** Jetons sémantiques personnalisables. */
export type ThemeToken = 'accent' | 'wait' | 'run' | 'done' | 'err' | 'add' | 'del'
export const THEME_TOKENS: readonly ThemeToken[] = ['accent', 'wait', 'run', 'done', 'err', 'add', 'del']

export type ColorOverrides = Partial<Record<ThemeToken, string>>

/** Mode effectivement affiché (« Auto » se résout en l'un des deux). */
export type Scheme = 'light' | 'dark'
export const SCHEMES: readonly Scheme[] = ['light', 'dark']

/** Apparence d'un mode affiché : sa palette et ses couleurs choisies (qui s'y ajoutent). */
export interface SchemeTheme {
  palette: PaletteName
  custom: ColorOverrides
}

export interface ThemeSettings {
  mode: ThemeMode
  /** Utilisé en mode clair, et en « Auto » quand le système est clair. */
  light: SchemeTheme
  /** Utilisé en mode sombre, et en « Auto » quand le système est sombre. */
  dark: SchemeTheme
}

/** Modification du thème : seuls les champs fournis sont remplacés (un mode entier à la fois). */
export interface ThemePatch {
  mode?: ThemeMode
  light?: SchemeTheme
  dark?: SchemeTheme
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
  /** Vue principale : par projet (barre latérale et session) ou par statut (kanban). */
  view: MainView
  /** Worktrees créés avec une session (v0.2, lot 6). */
  worktrees: WorktreeSettings
  /** Interface (v0.3, lot 8). */
  ui: UiSettings
  /** « Accès aux forges » (v0.3, lot 13a, ADR 0006) : désactivé, aucune CLI de forge n'est lancée. */
  forges: { enabled: boolean }
  /** Runners (v0.3, lot 14a). */
  runners: RunnerSettings
  /** Livraison et CI (v0.3, lot 14b). */
  delivery: DeliverySettings
  /** Consignes tapées personnalisées (v0.3, lot 18), globales et par projet. */
  prompts: PromptSettings
}

/**
 * Livraison d'un projet : mode (bouton principal, CI suivie). Ses consignes
 * sont dans `prompts` (lot 18 ; avant : `prTemplate` / `mergeTemplate` ici).
 */
export interface ProjectDelivery {
  mode: DeliveryMode
}

export interface DeliverySettings {
  /** Notification du bureau « CI en échec sur <session> ». */
  notifyCiFailure: boolean
  /** Par projet (même clé que `projectProfiles`). */
  projects: Record<string, ProjectDelivery>
}

/** Livraison effective d'un projet : ses réglages, sinon ceux par défaut (mode « PR »). */
export function projectDelivery(s: DeliverySettings, projectKey: string | null): ProjectDelivery {
  const p = projectKey && Object.prototype.hasOwnProperty.call(s.projects, projectKey) ? s.projects[projectKey] : undefined
  return { mode: p?.mode ?? 'pr' }
}

function isDeliveryMode(v: unknown): v is DeliveryMode {
  return (DELIVERY_MODES as readonly unknown[]).includes(v)
}

/** Livraison d'un projet lue d'un fichier : `null` si illisible (ses anciens modèles sont repris par `promptsFrom`). */
function projectDeliveryFrom(v: unknown): ProjectDelivery | null {
  if (!isObj(v) || !isDeliveryMode(v.mode)) return null
  return { mode: v.mode }
}

function deliveryFrom(v: unknown): DeliverySettings {
  const d = defaultSettings().delivery
  if (!isObj(v)) return d
  const projects: Record<string, ProjectDelivery> = {}
  if (isObj(v.projects)) {
    for (const [k, p] of Object.entries(v.projects)) {
      if (Object.keys(projects).length >= MAX_PROJECT_PROFILES) break
      const pd = projectDeliveryFrom(p)
      if (isProjectKey(k) && pd) projects[k] = pd
    }
  }
  return {
    notifyCiFailure: typeof v.notifyCiFailure === 'boolean' ? v.notifyCiFailure : d.notifyCiFailure,
    projects,
  }
}

/** Anciens champs de modèle de la livraison (lot 14b) → consignes du registre (lot 18). */
const LEGACY_DELIVERY_TEMPLATES = { prTemplate: 'deliveryPr', mergeTemplate: 'deliveryMerge' } as const satisfies Record<string, PromptId>

/**
 * Consignes lues d'un fichier. Migration du lot 14b : les modèles de
 * livraison (`delivery.prTemplate`, `mergeTemplate`, et ceux de
 * `delivery.projects`) deviennent des surcharges `deliveryPr` /
 * `deliveryMerge` s'ils sont valides et différents du défaut, sauf si
 * `prompts` en a déjà une (il l'emporte). Modèle invalide : ignoré, avec un
 * avertissement (le niveau au-dessus s'applique).
 */
function promptsFrom(raw: Record<string, unknown>, warnings: string[]): PromptSettings {
  const p = isObj(raw.prompts) ? raw.prompts : {}
  if (raw.prompts !== undefined && !isObj(raw.prompts)) warnings.push('consignes illisibles : textes par défaut')
  const global = overridesFrom(p.global, null, warnings)
  const projects: Record<string, PromptSettings['projects'][string]> = {}
  if (isObj(p.projects)) {
    for (const [k, o] of Object.entries(p.projects)) {
      if (Object.keys(projects).length >= MAX_PROJECT_PROFILES) break
      if (!isProjectKey(k)) continue
      const ov = overridesFrom(o, k, warnings)
      if (Object.keys(ov).length) projects[k] = ov
    }
  }
  const legacy = (src: Record<string, unknown>, into: PromptSettings['global'], where: string) => {
    for (const [field, id] of Object.entries(LEGACY_DELIVERY_TEMPLATES)) {
      const t = src[field]
      if (t === undefined || t === '' || Object.prototype.hasOwnProperty.call(into, id)) continue
      if (typeof t !== 'string' || t.length > MAX_STORED_TEMPLATE) {
        warnings.push(`ancien modèle « ${promptDef(id).label} » ${where} illisible ou trop long : retiré`)
        continue
      }
      const problem = promptProblem(id, t)
      // Invalide : gardé (montré dans Réglages → Consignes pour être corrigé), jamais utilisé.
      if (problem) warnings.push(`ancien modèle « ${promptDef(id).label} » ${where} invalide (${problem}) : gardé pour correction, non utilisé`)
      if (t !== defaultPrompt(id)) into[id] = t
    }
  }
  const d = raw.delivery
  if (isObj(d)) {
    legacy(d, global, 'global')
    if (isObj(d.projects)) {
      for (const [k, pd] of Object.entries(d.projects)) {
        if (!isProjectKey(k) || !isObj(pd)) continue
        if (!projects[k] && Object.keys(projects).length >= MAX_PROJECT_PROFILES) break
        const ov = { ...(projects[k] ?? {}) }
        legacy(pd, ov, `du projet ${k}`)
        if (Object.keys(ov).length) projects[k] = ov
      }
    }
  }
  return { global, projects }
}

type PromptsPatch = NonNullable<SettingsPatch['prompts']>
type OverridesPatch = Partial<Record<PromptId, string | null>>

function overridesPatch(v: unknown, where: string): OverridesPatch {
  if (!isObj(v)) throw new SettingsError(`« ${where} » doit être un objet`)
  const out: OverridesPatch = {}
  for (const [k, t] of Object.entries(v)) {
    if (!isPromptId(k)) throw new SettingsError(`consigne inconnue : ${where}.${k}`)
    if (t === null) {
      out[k] = null
      continue
    }
    const problem = promptProblem(k, t)
    if (problem) throw new SettingsError(`consigne « ${promptDef(k).label} » : ${problem}`)
    out[k] = t as string
  }
  return out
}

function promptsPatch(v: unknown): PromptsPatch {
  if (!isObj(v)) throw new SettingsError('« prompts » doit être un objet')
  for (const k of Object.keys(v)) {
    if (k !== 'global' && k !== 'projects') throw new SettingsError(`réglage inconnu : prompts.${k}`)
  }
  const out: PromptsPatch = {}
  if (v.global !== undefined) out.global = overridesPatch(v.global, 'prompts.global')
  if (v.projects !== undefined) {
    if (!isObj(v.projects)) throw new SettingsError('« prompts.projects » doit être un objet')
    const entries = Object.entries(v.projects)
    if (entries.length > MAX_PROJECT_PROFILES) throw new SettingsError('trop de projets')
    const pp: Record<string, OverridesPatch | null> = {}
    for (const [k, o] of entries) {
      if (!isProjectKey(k)) throw new SettingsError('projet : chemin absolu attendu')
      pp[k] = o === null ? null : overridesPatch(o, 'prompts.projects')
    }
    out.projects = pp
  }
  return out
}

function applyOverrides<T extends Partial<Record<PromptId, string>>>(base: T, patch: OverridesPatch): T {
  const next = { ...base } as Record<string, string>
  for (const [k, t] of Object.entries(patch)) {
    if (t === null || t === undefined) delete next[k]
    else next[k] = t
  }
  return next as T
}

function deliveryPatch(v: unknown): NonNullable<SettingsPatch['delivery']> {
  if (!isObj(v)) throw new SettingsError('« delivery » doit être un objet')
  const out: NonNullable<SettingsPatch['delivery']> = {}
  for (const k of Object.keys(v)) {
    if (!['notifyCiFailure', 'projects'].includes(k)) {
      throw new SettingsError(
        k === 'prTemplate' || k === 'mergeTemplate' ? `« delivery.${k} » : les consignes se règlent dans « prompts »` : `réglage inconnu : delivery.${k}`,
      )
    }
  }
  if (v.notifyCiFailure !== undefined) {
    if (typeof v.notifyCiFailure !== 'boolean') throw new SettingsError('« delivery.notifyCiFailure » doit être un booléen')
    out.notifyCiFailure = v.notifyCiFailure
  }
  if (v.projects !== undefined) {
    if (!isObj(v.projects)) throw new SettingsError('« delivery.projects » doit être un objet')
    const entries = Object.entries(v.projects)
    if (entries.length > MAX_PROJECT_PROFILES) throw new SettingsError('trop de projets')
    const pp: Record<string, ProjectDelivery | null> = {}
    for (const [k, p] of entries) {
      if (!isProjectKey(k)) throw new SettingsError('projet : chemin absolu attendu')
      if (p === null) {
        pp[k] = null
        continue
      }
      if (!isObj(p)) throw new SettingsError(`livraison invalide pour ${k}`)
      for (const f of Object.keys(p)) {
        if (f !== 'mode') throw new SettingsError(`réglage inconnu : delivery.projects.${f}`)
      }
      if (!isDeliveryMode(p.mode)) throw new SettingsError(`« mode » doit valoir ${DELIVERY_MODES.join(' ou ')} pour ${k}`)
      pp[k] = { mode: p.mode }
    }
    out.projects = pp
  }
  return out
}

export interface RunnerSettings {
  /**
   * Commandes acceptées par worktree (chemin absolu → empreintes du démon,
   * `Runner.fingerprint` : commande, dossier, source, corps, verrou). Une
   * commande qui change (fichier du dépôt modifié) redemande confirmation.
   * Écrit **seulement** par le processus principal (après « Lancer » dans
   * le dialogue de confirmation), jamais par une modification de la page.
   */
  confirmed: Record<string, string[]>
}

/** Au plus autant de worktrees retenus ; au-delà, les plus anciens sont oubliés. */
export const MAX_CONFIRMED_WORKTREES = 500
/** Au plus autant de commandes retenues par worktree (les plus anciennes partent). */
export const MAX_CONFIRMED_COMMANDS = 200

const FINGERPRINT_RE = /^[0-9a-f]{64}$/

export function isFingerprint(v: unknown): v is string {
  return typeof v === 'string' && FINGERPRINT_RE.test(v)
}

export interface UiSettings {
  /** Taille de toute l'interface, en pour cent (un des `ZOOM_STEPS`), appliquée par le processus principal. */
  zoom: number
  /** Onglet ouvert par défaut dans le volet d'une session (v0.3, lot 11) ; « Terminal » tant que l'utilisateur n'a pas choisi. */
  sessionTab: SessionTab
}

/** Onglets proposés comme onglet par défaut d'une session. */
export type SessionTab = 'terminal' | 'conversation'
export const SESSION_TABS: readonly SessionTab[] = ['terminal', 'conversation']
export const DEFAULT_SESSION_TAB: SessionTab = 'terminal'

function isSessionTab(v: unknown): v is SessionTab {
  return (SESSION_TABS as readonly unknown[]).includes(v)
}

/** Paliers de la taille de l'interface (pour cent), du plus petit au plus grand. */
export const ZOOM_STEPS: readonly number[] = [80, 90, 100, 110, 125, 150, 175, 200]
export const DEFAULT_ZOOM = 100

export function isZoomStep(v: unknown): v is number {
  return typeof v === 'number' && ZOOM_STEPS.includes(v)
}

/** Palier le plus proche d'une valeur lue (fichier abîmé ou d'une autre version) ; hors 80–200 % : 100 %. */
export function snapZoom(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_ZOOM
  if (v < ZOOM_STEPS[0]! || v > ZOOM_STEPS[ZOOM_STEPS.length - 1]!) return DEFAULT_ZOOM
  let best = DEFAULT_ZOOM
  for (const z of ZOOM_STEPS) if (Math.abs(z - v) < Math.abs(best - v)) best = z
  return best
}

export type ZoomDirection = 'in' | 'out' | 'reset'
export const ZOOM_DIRECTIONS: readonly ZoomDirection[] = ['in', 'out', 'reset']

/** Palier suivant (`in`), précédent (`out`) ou 100 % (`reset`) ; reste au bout de l'échelle. */
export function stepZoom(current: number, dir: ZoomDirection): number {
  if (dir === 'reset') return DEFAULT_ZOOM
  const z = snapZoom(current)
  const i = ZOOM_STEPS.indexOf(z)
  const j = dir === 'in' ? Math.min(ZOOM_STEPS.length - 1, i + 1) : Math.max(0, i - 1)
  return ZOOM_STEPS[j]!
}

export interface WorktreeSettings {
  /** Emplacement par défaut des nouveaux worktrees. */
  location: DefaultWorktreeLocation
  /** Emplacement par projet (racine du worktree principal → emplacement), prioritaire. */
  projectLocations: Record<string, DefaultWorktreeLocation>
  /** Préfixe des branches proposées (« romain/ »…), vide par défaut. */
  branchPrefix: string
  /** Notification du bureau quand une branche est intégrée et qu'aucune session ne tourne dans son worktree. */
  notifyIntegrated: boolean
}

export type MainView = 'projet' | 'statut'
export const MAIN_VIEWS: readonly MainView[] = ['projet', 'statut']

export interface ProfileLabel {
  /** Libellé long (≤ 30 caractères), ex. « Perso ». */
  long: string
  /** Libellé court pour les pastilles (1 à 3 caractères visibles), ex. « P ». */
  short: string
}

export const MAX_LONG_LABEL = 30
export const MAX_SHORT_LABEL = 3

export interface SettingsPatch {
  /** Fusionné : `mode`, `light` et `dark` fournis remplacent les actuels. */
  theme?: ThemePatch
  notifications?: { enabled: boolean }
  /** Fusionné : `null` retire l'entrée. */
  projectProfiles?: Record<string, string | null>
  confirmRemoval?: boolean
  /** Fusionné : `null` rend les libellés par défaut. */
  profileLabels?: Record<string, ProfileLabel | null>
  view?: MainView
  /** Champs fournis seulement ; `projectLocations` fusionné (`null` retire l'entrée). */
  worktrees?: {
    location?: DefaultWorktreeLocation
    projectLocations?: Record<string, DefaultWorktreeLocation | null>
    branchPrefix?: string
    notifyIntegrated?: boolean
  }
  ui?: { zoom?: number; sessionTab?: SessionTab }
  forges?: { enabled: boolean }
  /** Champs fournis seulement ; `projects` fusionné (`null` retire l'entrée, une entrée remplace celle du projet). */
  delivery?: {
    notifyCiFailure?: boolean
    projects?: Record<string, ProjectDelivery | null>
  }
  /**
   * Consignes (lot 18), fusionnées consigne par consigne : un modèle remplace
   * la surcharge, `null` la retire (le niveau au-dessus s'applique) ; un
   * projet à `null` perd toutes ses surcharges.
   */
  prompts?: {
    global?: Partial<Record<PromptId, string | null>>
    projects?: Record<string, Partial<Record<PromptId, string | null>> | null>
  }
}

export const MAX_PROJECT_PROFILES = 500
const MAX_PATH = 4096
const MAX_PROFILE = 200

export function defaultSettings(): AppSettings {
  return {
    version: 1,
    theme: {
      mode: 'system',
      light: { palette: 'devmaestro', custom: {} },
      dark: { palette: 'devmaestro', custom: {} },
    },
    notifications: { enabled: true },
    projectProfiles: {},
    confirmRemoval: true,
    profileLabels: {},
    view: 'projet',
    worktrees: { location: 'sibling', projectLocations: {}, branchPrefix: '', notifyIntegrated: true },
    ui: { zoom: DEFAULT_ZOOM, sessionTab: DEFAULT_SESSION_TAB },
    forges: { enabled: true },
    runners: { confirmed: {} },
    delivery: { notifyCiFailure: true, projects: {} },
    prompts: { global: {}, projects: {} },
  }
}

function isLocation(v: unknown): v is DefaultWorktreeLocation {
  return (DEFAULT_WORKTREE_LOCATIONS as readonly unknown[]).includes(v)
}

/** Réglages des worktrees lus d'un fichier : champ invalide → valeur par défaut. */
function worktreesFrom(v: unknown): WorktreeSettings {
  const d = defaultSettings().worktrees
  if (!isObj(v)) return d
  const projectLocations: Record<string, DefaultWorktreeLocation> = {}
  if (isObj(v.projectLocations)) {
    for (const [k, l] of Object.entries(v.projectLocations)) {
      if (Object.keys(projectLocations).length >= MAX_PROJECT_PROFILES) break
      if (isProjectKey(k) && isLocation(l)) projectLocations[k] = l
    }
  }
  return {
    location: isLocation(v.location) ? v.location : d.location,
    projectLocations,
    branchPrefix: typeof v.branchPrefix === 'string' && branchPrefixProblem(v.branchPrefix) === null ? v.branchPrefix : d.branchPrefix,
    notifyIntegrated: typeof v.notifyIntegrated === 'boolean' ? v.notifyIntegrated : d.notifyIntegrated,
  }
}

/** Emplacement des worktrees d'un projet : celui du projet, sinon le réglage global. */
export function projectWorktreeLocation(s: WorktreeSettings, projectKey: string | null): DefaultWorktreeLocation {
  return (projectKey ? s.projectLocations[projectKey] : undefined) ?? s.location
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

function isPalette(v: unknown): v is PaletteName {
  return (PALETTE_NAMES as readonly unknown[]).includes(v)
}

function isMode(v: unknown): v is ThemeMode {
  return (THEME_MODES as readonly unknown[]).includes(v)
}

/**
 * Thème lu d'un fichier : champ invalide → valeur par défaut. Ancien format
 * (une palette pour tous les modes, `custom: { light, dark }`) : la palette est
 * reprise dans les deux modes, chacun avec ses couleurs.
 */
function themeFrom(v: unknown): ThemeSettings {
  const d = defaultSettings().theme
  if (!isObj(v)) return d
  const mode = isMode(v.mode) ? v.mode : d.mode
  const legacyPalette = isPalette(v.palette) ? v.palette : d.light.palette
  const legacyCustom = isObj(v.custom) ? v.custom : {}
  const scheme = (k: Scheme): SchemeTheme => {
    const s = v[k]
    if (isObj(s)) return { palette: isPalette(s.palette) ? s.palette : d[k].palette, custom: overrides(s.custom, false, '') }
    return { palette: legacyPalette, custom: overrides(legacyCustom[k], false, '') }
  }
  return { mode, light: scheme('light'), dark: scheme('dark') }
}

/** Modification du thème venue de la page : stricte, ancien format refusé. */
function themePatch(v: unknown): ThemePatch {
  if (!isObj(v)) throw new SettingsError('« theme » doit être un objet')
  for (const k of Object.keys(v)) {
    if (!['mode', 'light', 'dark'].includes(k)) throw new SettingsError(`réglage inconnu : theme.${k}`)
  }
  const out: ThemePatch = {}
  if (v.mode !== undefined) {
    if (!isMode(v.mode)) throw new SettingsError('« theme.mode » doit valoir light, dark ou system')
    out.mode = v.mode
  }
  for (const k of SCHEMES) {
    const s = v[k]
    if (s === undefined) continue
    if (!isObj(s)) throw new SettingsError(`« theme.${k} » doit être un objet`)
    for (const f of Object.keys(s)) {
      if (!['palette', 'custom'].includes(f)) throw new SettingsError(`réglage inconnu : theme.${k}.${f}`)
    }
    if (!isPalette(s.palette)) throw new SettingsError(`« theme.${k}.palette » inconnue`)
    out[k] = { palette: s.palette, custom: overrides(s.custom, true, `theme.${k}.custom`) }
  }
  return out
}

/** Taille maximale d'un thème importé (texte JSON). */
export const MAX_THEME_IMPORT = 64 * 1024

/** Thème importé : les deux modes, et le mode choisi s'il est fourni (sinon l'actuel est gardé). */
export interface ThemeImport {
  mode?: ThemeMode
  light: SchemeTheme
  dark: SchemeTheme
}

/**
 * Thème collé ou lu d'un fichier (« Importer un thème (JSON) »), validé aussi
 * strictement qu'une modification venue de la page : format de « Copier le
 * thème » (`{mode?, light, dark}`), ou ancien format à palette unique
 * (`{mode?, palette, custom?: {light?, dark?}}`), repris dans les deux modes.
 * Lève `SettingsError` avec un message précis, en français.
 */
export function parseThemeImport(text: string): ThemeImport {
  if (typeof text !== 'string' || text.trim() === '') throw new SettingsError('aucun thème à importer')
  if (text.length > MAX_THEME_IMPORT) throw new SettingsError(`thème trop long (${Math.round(MAX_THEME_IMPORT / 1024)} Kio au plus)`)
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    throw new SettingsError(`JSON invalide : ${(e as Error).message}`)
  }
  if (!isObj(raw)) throw new SettingsError('le thème doit être un objet JSON')
  const legacy = 'palette' in raw || 'custom' in raw
  const modern = 'light' in raw || 'dark' in raw
  if (legacy && modern) throw new SettingsError('format mélangé : « palette »/« custom » (ancien format) et « light »/« dark » ensemble')
  if (legacy) {
    for (const k of Object.keys(raw)) {
      if (!['mode', 'palette', 'custom'].includes(k)) throw new SettingsError(`champ inconnu : ${k}`)
    }
    if (!isPalette(raw.palette)) throw new SettingsError(`« palette » inconnue (attendu : ${PALETTE_NAMES.join(', ')})`)
    const custom = raw.custom === undefined ? {} : raw.custom
    if (!isObj(custom)) throw new SettingsError('« custom » doit être un objet ({ light, dark })')
    for (const k of Object.keys(custom)) {
      if (!(SCHEMES as readonly string[]).includes(k)) throw new SettingsError(`champ inconnu : custom.${k}`)
    }
    const p = themePatch({
      ...(raw.mode !== undefined ? { mode: raw.mode } : {}),
      light: { palette: raw.palette, custom: custom.light ?? {} },
      dark: { palette: raw.palette, custom: custom.dark ?? {} },
    })
    return p as ThemeImport
  }
  for (const k of SCHEMES) {
    if (raw[k] === undefined) throw new SettingsError(`« ${k} » manquant (attendu : { mode, light, dark })`)
  }
  for (const k of SCHEMES) {
    const s = raw[k]
    if (isObj(s) && s.custom === undefined) throw new SettingsError(`« theme.${k}.custom » manquant`)
  }
  return themePatch(raw) as ThemeImport
}

export class SettingsError extends Error {
  override name = 'SettingsError'
}

/** Lecture tolérante (fichier de réglages, éventuellement d'une autre version). */
export function normalizeSettings(raw: unknown): AppSettings {
  return readSettings(raw).settings
}

/**
 * Lecture tolérante, avec les avertissements à journaliser (aujourd'hui :
 * consignes invalides ignorées, lot 18).
 */
export function readSettings(raw: unknown): { settings: AppSettings; warnings: string[] } {
  const d = defaultSettings()
  if (!isObj(raw)) return { settings: d, warnings: [] }
  const warnings: string[] = []
  const profiles: Record<string, string> = {}
  if (isObj(raw.projectProfiles)) {
    for (const [k, v] of Object.entries(raw.projectProfiles)) {
      if (Object.keys(profiles).length >= MAX_PROJECT_PROFILES) break
      if (isProjectKey(k) && isProfileName(v)) profiles[k] = v
    }
  }
  const settings: AppSettings = {
    version: 1,
    theme: themeFrom(raw.theme),
    notifications: {
      enabled: isObj(raw.notifications) && typeof raw.notifications.enabled === 'boolean' ? raw.notifications.enabled : true,
    },
    projectProfiles: profiles,
    confirmRemoval: typeof raw.confirmRemoval === 'boolean' ? raw.confirmRemoval : d.confirmRemoval,
    profileLabels: labelsFrom(raw.profileLabels),
    view: (MAIN_VIEWS as readonly unknown[]).includes(raw.view) ? (raw.view as MainView) : d.view,
    worktrees: worktreesFrom(raw.worktrees),
    ui: {
      zoom: isObj(raw.ui) ? snapZoom(raw.ui.zoom) : DEFAULT_ZOOM,
      sessionTab: isObj(raw.ui) && isSessionTab(raw.ui.sessionTab) ? raw.ui.sessionTab : DEFAULT_SESSION_TAB,
    },
    forges: {
      enabled: isObj(raw.forges) && typeof raw.forges.enabled === 'boolean' ? raw.forges.enabled : d.forges.enabled,
    },
    runners: runnersFrom(raw.runners),
    delivery: deliveryFrom(raw.delivery),
    prompts: promptsFrom(raw, warnings),
  }
  return { settings, warnings }
}

/** Réglages des runners lus d'un fichier : entrées invalides ignorées. */
function runnersFrom(v: unknown): RunnerSettings {
  const confirmed: Record<string, string[]> = {}
  if (isObj(v) && isObj(v.confirmed)) {
    for (const [k, c] of Object.entries(v.confirmed)) {
      if (Object.keys(confirmed).length >= MAX_CONFIRMED_WORKTREES) break
      // Ancien format (`true` par worktree, sans empreinte) : oublié, la confirmation sera redemandée.
      if (!isProjectKey(k) || !Array.isArray(c)) continue
      const fps = [...new Set(c.filter(isFingerprint))].slice(-MAX_CONFIRMED_COMMANDS)
      if (fps.length > 0) confirmed[k] = fps
    }
  }
  return { confirmed }
}

/** Cette commande (empreinte) a-t-elle déjà été acceptée dans ce worktree ? */
export function runnerConfirmed(s: Pick<AppSettings, 'runners'>, worktree: string | null | undefined, fingerprint: string): boolean {
  return !!worktree && Object.prototype.hasOwnProperty.call(s.runners.confirmed, worktree) && s.runners.confirmed[worktree]!.includes(fingerprint)
}

/** Réglages avec cette commande acceptée dans ce worktree (processus principal seulement). */
export function withRunnerConfirmed(s: AppSettings, worktree: string, fingerprint: string): AppSettings {
  if (!isProjectKey(worktree) || !isFingerprint(fingerprint)) throw new SettingsError('confirmation de runner invalide')
  const confirmed = { ...s.runners.confirmed }
  const prev = (confirmed[worktree] ?? []).filter((f) => f !== fingerprint)
  delete confirmed[worktree]
  // Réinsérée à la fin : les worktrees les moins récents partent les premiers.
  confirmed[worktree] = [...prev, fingerprint].slice(-MAX_CONFIRMED_COMMANDS)
  const keys = Object.keys(confirmed)
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_CONFIRMED_WORKTREES))) delete confirmed[k]
  return { ...s, runners: { confirmed } }
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
    if (!['theme', 'notifications', 'projectProfiles', 'confirmRemoval', 'profileLabels', 'view', 'worktrees', 'ui', 'forges', 'delivery', 'prompts'].includes(k)) {
      throw new SettingsError(k === 'runners' ? 'les commandes acceptées ne se modifient pas depuis la page' : `réglage inconnu : ${k}`)
    }
  }
  if (raw.theme !== undefined) out.theme = themePatch(raw.theme)
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
  if (raw.view !== undefined) {
    if (!(MAIN_VIEWS as readonly unknown[]).includes(raw.view)) throw new SettingsError('« view » doit valoir projet ou statut')
    out.view = raw.view as MainView
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
  if (raw.worktrees !== undefined) out.worktrees = worktreesPatch(raw.worktrees)
  if (raw.ui !== undefined) out.ui = uiPatch(raw.ui)
  if (raw.forges !== undefined) {
    if (!isObj(raw.forges) || Object.keys(raw.forges).some((k) => k !== 'enabled') || typeof raw.forges.enabled !== 'boolean') {
      throw new SettingsError('« forges.enabled » doit être un booléen')
    }
    out.forges = { enabled: raw.forges.enabled }
  }
  if (raw.delivery !== undefined) out.delivery = deliveryPatch(raw.delivery)
  if (raw.prompts !== undefined) out.prompts = promptsPatch(raw.prompts)
  return out
}

function uiPatch(v: unknown): NonNullable<SettingsPatch['ui']> {
  if (!isObj(v)) throw new SettingsError('« ui » doit être un objet')
  for (const k of Object.keys(v)) {
    if (k !== 'zoom' && k !== 'sessionTab') throw new SettingsError(`réglage inconnu : ui.${k}`)
  }
  const out: NonNullable<SettingsPatch['ui']> = {}
  if (v.zoom !== undefined) {
    if (!isZoomStep(v.zoom)) throw new SettingsError(`« ui.zoom » doit valoir ${ZOOM_STEPS.join(', ')} (pour cent)`)
    out.zoom = v.zoom
  }
  if (v.sessionTab !== undefined) {
    if (!isSessionTab(v.sessionTab)) throw new SettingsError(`« ui.sessionTab » doit valoir ${SESSION_TABS.join(' ou ')}`)
    out.sessionTab = v.sessionTab
  }
  return out
}

function worktreesPatch(v: unknown): NonNullable<SettingsPatch['worktrees']> {
  if (!isObj(v)) throw new SettingsError('« worktrees » doit être un objet')
  const out: NonNullable<SettingsPatch['worktrees']> = {}
  for (const k of Object.keys(v)) {
    if (!['location', 'projectLocations', 'branchPrefix', 'notifyIntegrated'].includes(k)) {
      throw new SettingsError(`réglage inconnu : worktrees.${k}`)
    }
  }
  if (v.location !== undefined) {
    if (!isLocation(v.location)) throw new SettingsError('« worktrees.location » doit valoir sibling, in_repo ou managed')
    out.location = v.location
  }
  if (v.branchPrefix !== undefined) {
    if (typeof v.branchPrefix !== 'string') throw new SettingsError('« worktrees.branchPrefix » doit être une chaîne')
    const problem = branchPrefixProblem(v.branchPrefix)
    if (problem) throw new SettingsError(problem)
    out.branchPrefix = v.branchPrefix
  }
  if (v.notifyIntegrated !== undefined) {
    if (typeof v.notifyIntegrated !== 'boolean') throw new SettingsError('« worktrees.notifyIntegrated » doit être un booléen')
    out.notifyIntegrated = v.notifyIntegrated
  }
  if (v.projectLocations !== undefined) {
    if (!isObj(v.projectLocations)) throw new SettingsError('« worktrees.projectLocations » doit être un objet')
    const entries = Object.entries(v.projectLocations)
    if (entries.length > MAX_PROJECT_PROFILES) throw new SettingsError('trop de projets')
    const pl: Record<string, DefaultWorktreeLocation | null> = {}
    for (const [k, l] of entries) {
      if (!isProjectKey(k)) throw new SettingsError('projet : chemin absolu attendu')
      if (l !== null && !isLocation(l)) throw new SettingsError(`emplacement invalide pour ${k}`)
      pl[k] = l
    }
    out.projectLocations = pl
  }
  return out
}

export function applyPatch(s: AppSettings, p: SettingsPatch): AppSettings {
  const next: AppSettings = { ...s }
  if (p.theme) next.theme = { ...s.theme, ...p.theme }
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
  if (p.view !== undefined) next.view = p.view
  if (p.profileLabels) {
    const pl = { ...s.profileLabels }
    for (const [k, v] of Object.entries(p.profileLabels)) {
      if (v === null) delete pl[k]
      else pl[k] = v
    }
    next.profileLabels = pl
  }
  if (p.worktrees) {
    const { projectLocations, ...rest } = p.worktrees
    const w: WorktreeSettings = { ...s.worktrees, ...rest, projectLocations: { ...s.worktrees.projectLocations } }
    if (projectLocations) {
      for (const [k, v] of Object.entries(projectLocations)) {
        if (v === null) delete w.projectLocations[k]
        else w.projectLocations[k] = v
      }
      const keys = Object.keys(w.projectLocations)
      for (const k of keys.slice(0, Math.max(0, keys.length - MAX_PROJECT_PROFILES))) delete w.projectLocations[k]
    }
    next.worktrees = w
  }
  if (p.ui) next.ui = { ...s.ui, ...p.ui }
  if (p.forges) next.forges = { ...p.forges }
  if (p.delivery) {
    const { projects, ...rest } = p.delivery
    const d: DeliverySettings = { ...s.delivery, ...rest, projects: { ...s.delivery.projects } }
    if (projects) {
      for (const [k, v] of Object.entries(projects)) {
        if (v === null) delete d.projects[k]
        else d.projects[k] = v
      }
      const keys = Object.keys(d.projects)
      for (const k of keys.slice(0, Math.max(0, keys.length - MAX_PROJECT_PROFILES))) delete d.projects[k]
    }
    next.delivery = d
  }
  if (p.prompts) {
    const global = p.prompts.global ? applyOverrides(s.prompts.global, p.prompts.global) : s.prompts.global
    const projects = { ...s.prompts.projects }
    for (const [k, o] of Object.entries(p.prompts.projects ?? {})) {
      const ov = o === null ? {} : applyOverrides(projects[k] ?? {}, o)
      delete projects[k]
      if (Object.keys(ov).length) projects[k] = ov
    }
    const keys = Object.keys(projects)
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_PROJECT_PROFILES))) delete projects[k]
    next.prompts = { global, projects }
  }
  return next
}

/** Deux modifications successives en une seule (la seconde l'emporte). */
export function mergePatches(a: SettingsPatch, b: SettingsPatch): SettingsPatch {
  const out: SettingsPatch = { ...a, ...b }
  if (a.theme && b.theme) out.theme = { ...a.theme, ...b.theme }
  if (a.projectProfiles && b.projectProfiles) out.projectProfiles = { ...a.projectProfiles, ...b.projectProfiles }
  if (a.profileLabels && b.profileLabels) out.profileLabels = { ...a.profileLabels, ...b.profileLabels }
  if (a.ui && b.ui) out.ui = { ...a.ui, ...b.ui }
  if (a.delivery && b.delivery) {
    out.delivery = { ...a.delivery, ...b.delivery }
    if (a.delivery.projects && b.delivery.projects) out.delivery.projects = { ...a.delivery.projects, ...b.delivery.projects }
  }
  if (a.prompts && b.prompts) {
    const projects: Record<string, OverridesPatch | null> = { ...a.prompts.projects }
    for (const [k, o] of Object.entries(b.prompts.projects ?? {})) {
      const prev = projects[k]
      if (o === null || prev === undefined) projects[k] = o
      // Projet vidé puis modifié : toutes ses surcharges retirées, sauf celles de la seconde.
      else if (prev === null) projects[k] = { ...Object.fromEntries(PROMPT_IDS.map((id) => [id, null])), ...o }
      else projects[k] = { ...prev, ...o }
    }
    out.prompts = {
      ...(a.prompts.global || b.prompts.global ? { global: { ...a.prompts.global, ...b.prompts.global } } : {}),
      ...(a.prompts.projects || b.prompts.projects ? { projects } : {}),
    }
  }
  if (a.worktrees && b.worktrees) {
    out.worktrees = { ...a.worktrees, ...b.worktrees }
    if (a.worktrees.projectLocations && b.worktrees.projectLocations) {
      out.worktrees.projectLocations = { ...a.worktrees.projectLocations, ...b.worktrees.projectLocations }
    }
  }
  return out
}
