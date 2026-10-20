/**
 * Réglages dans la page : copie locale appliquée tout de suite (aperçu
 * immédiat des couleurs), enregistrée par le processus principal après un
 * court délai (les sélecteurs de couleur envoient beaucoup d'événements).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import {
  applyPatch,
  isZoomStep,
  mergePatches,
  profileLabel,
  validatePatch,
  type AppSettings,
  type ProfileLabel,
  type SettingsPatch,
} from '../../shared/settings'
import { api } from './api'
import { describeError } from './state/errors'

const SAVE_DELAY_MS = 250

interface SettingsApi {
  settings: AppSettings
  update: (patch: SettingsPatch) => void
  /** Dernière erreur d'enregistrement (en français), ou `null`. */
  saveError: string | null
  label: (profile: string) => ProfileLabel
}

const Ctx = createContext<SettingsApi | null>(null)

export function SettingsProvider({ initial, children }: { initial: AppSettings; children: ReactNode }) {
  const [settings, setSettings] = useState(initial)
  const [saveError, setSaveError] = useState<string | null>(null)
  const pending = useRef<SettingsPatch | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Numéro du dernier envoi : une réponse plus ancienne n'écrase pas une plus récente. */
  const seq = useRef(0)

  const flush = useCallback(async () => {
    timer.current = null
    const patch = pending.current
    pending.current = null
    if (!patch) return
    const mine = ++seq.current
    try {
      const r = await api.updateSettings(patch)
      if (!r.ok) setSaveError(`Réglages non enregistrés : ${describeError(r.error.code, r.error.message)}`)
      else {
        setSaveError(null)
        // Modification plus récente en attente ou envoyée depuis : on garde la copie locale.
        if (!pending.current && mine === seq.current) setSettings(r.settings)
      }
    } catch (e) {
      setSaveError(`Réglages non enregistrés : ${(e as Error).message}`)
    }
  }, [])

  const update = useCallback(
    (raw: SettingsPatch) => {
      let patch: SettingsPatch
      try {
        patch = validatePatch(raw)
      } catch (e) {
        setSaveError((e as Error).message)
        return
      }
      setSettings((s) => applyPatch(s, patch))
      pending.current = pending.current ? mergePatches(pending.current, patch) : patch
      if (timer.current) clearTimeout(timer.current)
      // Taille de l'interface : appliquée par le processus principal, donc envoyée sans attendre.
      if (patch.ui) void flush()
      else timer.current = setTimeout(() => void flush(), SAVE_DELAY_MS)
    },
    [flush],
  )

  // Taille changée par le processus principal (Ctrl + / Ctrl − / Ctrl 0, Ctrl + molette) : copie locale à jour,
  // sans renvoyer de modification (le processus principal l'a déjà enregistrée).
  useEffect(
    () =>
      api.onZoomChanged?.((zoom) => {
        if (!isZoomStep(zoom)) return
        if (pending.current?.ui) {
          const { ui: _ui, ...rest } = pending.current
          pending.current = Object.keys(rest).length > 0 ? rest : null
        }
        setSettings((s) => (s.ui.zoom === zoom ? s : { ...s, ui: { ...s.ui, zoom } }))
      }),
    [],
  )

  // Fermeture de la page : ce qui attend part par un message sans réponse, que
  // le processus principal écrit avant de quitter (une réponse n'arriverait plus).
  useEffect(() => {
    const onHide = () => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
      const patch = pending.current
      pending.current = null
      if (patch) api.flushSettings?.(patch)
    }
    window.addEventListener('beforeunload', onHide)
    window.addEventListener('pagehide', onHide)
    return () => {
      window.removeEventListener('beforeunload', onHide)
      window.removeEventListener('pagehide', onHide)
    }
  }, [])

  const value = useMemo<SettingsApi>(
    () => ({ settings, update, saveError, label: (p) => profileLabel(p, settings.profileLabels) }),
    [settings, update, saveError],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useSettings(): SettingsApi {
  const v = useContext(Ctx)
  if (!v) throw new Error('useSettings hors de SettingsProvider')
  return v
}
