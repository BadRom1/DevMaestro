/**
 * Plugins dans la page (lot 22a) : liste `plugins.list` du démon et accords
 * retenus par le processus principal, tenus hors des composants (Réglages →
 * Plugins, onglets de session, Réglages → Consignes). Rien n'est demandé
 * tant que le démon n'annonce pas la capacité `plugins` : sans elle, aucune
 * interface de plugin et aucun appel `plugins.*`.
 */
import { useSyncExternalStore } from 'react'

import type { Locale } from '../../shared/i18n'
import { isPluginFingerprint, isPluginName } from '../../shared/pluginDocument'
import type { LocalizedText, PluginInfo } from '../../shared/protocol'
import { api, call, errorText } from './api'

export interface PluginsState {
  /** Capacité `plugins` du démon connecté. */
  enabled: boolean
  status: 'idle' | 'loading' | 'ready' | 'error'
  dir: string | null
  plugins: PluginInfo[]
  /** Accords retenus par le processus principal (nom → empreinte). */
  accepted: Record<string, string>
  error: string | null
}

const IDLE: PluginsState = { enabled: false, status: 'idle', dir: null, plugins: [], accepted: {}, error: null }

let state: PluginsState = IDLE
const listeners = new Set<() => void>()
let loading = false
let again = false
/** Génération : un changement de capacité invalide les réponses en vol. */
let gen = 0

function set(next: PluginsState): void {
  state = next
  for (const l of listeners) l()
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Liste du démon, champs attendus seulement. Un dossier au nom invalide
 * (majuscules, espaces, invisibles…) reste montré, comme plugin invalide
 * avec ses erreurs : jamais acceptable, jamais d'onglet.
 */
function readList(raw: unknown): { dir: string | null; plugins: PluginInfo[] } {
  if (!isObj(raw)) return { dir: null, plugins: [] }
  const plugins = (Array.isArray(raw.plugins) ? raw.plugins : [])
    .filter((p): p is PluginInfo => isObj(p) && typeof p.name === 'string' && p.name.length > 0)
    .slice(0, 64)
    .map((p): PluginInfo => {
      const named = isPluginName(p.name)
      return {
      ...p,
      name: p.name.slice(0, 256),
      valid: named && p.valid === true,
      errors: Array.isArray(p.errors) ? p.errors.filter((e): e is string => typeof e === 'string') : [],
      permissions: Array.isArray(p.permissions) ? p.permissions.filter((e): e is string => typeof e === 'string') : [],
      actions: Array.isArray(p.actions) ? p.actions.filter((a) => isObj(a) && typeof a.id === 'string') : [],
      fingerprint: named && isPluginFingerprint(p.fingerprint) ? p.fingerprint : null,
      acceptance: named && (p.acceptance === 'accepted' || p.acceptance === 'changed') ? p.acceptance : 'none',
      process: isObj(p.process) ? p.process : { state: 'stopped' as const },
      }
    })
  return { dir: typeof raw.dir === 'string' ? raw.dir : null, plugins }
}

/** Relit la liste et les accords de l'app ; une demande pendant un chargement en relance un après. */
export async function reloadPlugins(): Promise<void> {
  if (!state.enabled) return
  if (loading) {
    again = true
    return
  }
  loading = true
  const mine = gen
  if (state.status !== 'ready') set({ ...state, status: 'loading', error: null })
  try {
    const [list, s] = await Promise.all([call('plugins.list', {}), api.settings().catch(() => null)])
    if (mine !== gen) return
    const accepted = s?.settings?.plugins?.accepted ?? {}
    set({ ...state, status: 'ready', ...readList(list), accepted: { ...accepted }, error: null })
  } catch (e) {
    if (mine === gen) set({ ...state, status: 'error', error: errorText(e) })
  } finally {
    loading = false
    if (again && mine === gen) {
      again = false
      void reloadPlugins()
    }
  }
}

/** Capacité `plugins` du démon connecté : sans elle, tout est vidé et rien n'est demandé. */
export function setPluginsEnabled(enabled: boolean): void {
  if (enabled === state.enabled && (enabled ? state.status !== 'idle' : true)) return
  gen++
  loading = false
  again = false
  set(enabled ? { ...IDLE, enabled: true } : IDLE)
  if (enabled) void reloadPlugins()
}

export function getPlugins(): PluginsState {
  return state
}

export function usePlugins(): PluginsState {
  return useSyncExternalStore(subscribe, () => state)
}

/** Libellé d'un manifeste dans la langue de l'interface. */
export function localized(text: LocalizedText | undefined | null, locale: Locale): string | null {
  if (!isObj(text)) return null
  const v = text[locale] ?? text.fr
  return typeof v === 'string' && v.trim() !== '' ? v : null
}

/** Plugin actif : manifeste valide, accepté au démon **et** chez l'app avec son empreinte actuelle. */
export function isActivePlugin(p: PluginInfo, accepted: Record<string, string>): boolean {
  return (
    p.valid &&
    p.acceptance === 'accepted' &&
    p.fingerprint !== null &&
    Object.prototype.hasOwnProperty.call(accepted, p.name) &&
    accepted[p.name] === p.fingerprint
  )
}

export function activePlugins(s: PluginsState): PluginInfo[] {
  return s.enabled ? s.plugins.filter((p) => isActivePlugin(p, s.accepted)) : []
}

/** Remise à zéro (tests). */
export function resetPluginsStore(): void {
  gen++
  loading = false
  again = false
  set(IDLE)
}
