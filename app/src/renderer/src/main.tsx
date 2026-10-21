import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/ibm-plex-sans-condensed/500.css'
import '@fontsource/ibm-plex-sans-condensed/600.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@xterm/xterm/css/xterm.css'
import './styles.css'

import { StrictMode, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'

import { defaultSettings, normalizeSettings, type AppSettings } from '../../shared/settings'
import { api, requestTerminalPort } from './api'
import { App } from './App'
import { AppBoundary } from './components/AppBoundary'
import { installErrorReporting, reportRendererError } from './errorReport'
import { SettingsI18nProvider } from './i18n'
import { SettingsProvider } from './settings'
import { resolveScheme } from './state/themeTokens'
import { applyTheme, legacyThemeMode, systemPrefersLight } from './theme'

/** Réglages et langues du système (lot 20), lus du processus principal. */
interface Loaded {
  settings: AppSettings
  systemLocales: string[]
}

function fromResponse(r: Awaited<ReturnType<NonNullable<typeof api.settings>>>): Loaded | null {
  if (!r) return null
  const systemLocales = Array.isArray(r.systemLocales) ? r.systemLocales.filter((l): l is string => typeof l === 'string') : []
  let s = normalizeSettings(r.settings)
  // Premier lancement après le lot 4 : reprendre le mode choisi alors (stocké dans la page).
  const legacy = r.fresh ? legacyThemeMode() : null
  if (legacy && legacy !== s.theme.mode) {
    s = { ...s, theme: { ...s.theme, mode: legacy } }
    void api.updateSettings({ theme: { mode: legacy } })
  }
  return { settings: s, systemLocales }
}

/**
 * Réglages du processus principal avant le premier rendu (pas d'éclair de
 * thème ni de langue). Au-delà de 2 s, la page s'affiche avec les défauts et
 * la réponse tardive est appliquée à son arrivée (`late`), langue comprise.
 */
async function loadSettings(): Promise<{ initial: Loaded; late: Promise<Loaded | null> | null }> {
  const request = Promise.resolve(api.settings?.())
    .then(fromResponse)
    .catch(() => null)
  const first = await Promise.race([request, new Promise<'late'>((ok) => setTimeout(() => ok('late'), 2000))])
  if (first !== 'late') return { initial: first ?? { settings: defaultSettings(), systemLocales: [] }, late: null }
  return { initial: { settings: defaultSettings(), systemLocales: [] }, late: request }
}

/** Langues du système suivies : celles du premier chargement, puis celles d'une réponse tardive. */
function Root({ initial, late }: { initial: Loaded; late: Promise<Loaded | null> | null }) {
  const [systemLocales, setSystemLocales] = useState(initial.systemLocales)
  const lateSettings = useMemo(() => late?.then((l) => l?.settings ?? null) ?? null, [late])
  useEffect(() => {
    void late?.then((l) => l && setSystemLocales(l.systemLocales))
  }, [late])
  return (
    <SettingsProvider initial={initial.settings} late={lateSettings}>
      <SettingsI18nProvider systemLocales={systemLocales}>
        <App />
      </SettingsI18nProvider>
    </SettingsProvider>
  )
}

installErrorReporting()
requestTerminalPort()
void loadSettings().then(({ initial, late }) => {
  applyTheme(initial.settings.theme, resolveScheme(initial.settings.theme.mode, systemPrefersLight()))
  createRoot(document.getElementById('root')!, {
    // Rattrapée par aucun garde-fou (ne devrait plus arriver : `AppBoundary` entoure tout) : au journal.
    // i18n-exempt: journal technique
    onUncaughtError: (error, info) => reportRendererError('erreur d’affichage non rattrapée', error, info.componentStack),
  }).render(
    <StrictMode>
      <AppBoundary>
        <Root initial={initial} late={late} />
      </AppBoundary>
    </StrictMode>,
  )
})
