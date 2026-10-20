import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/ibm-plex-sans-condensed/500.css'
import '@fontsource/ibm-plex-sans-condensed/600.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@xterm/xterm/css/xterm.css'
import './styles.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { defaultSettings, normalizeSettings, type AppSettings } from '../../shared/settings'
import { api, requestTerminalPort } from './api'
import { App } from './App'
import { SettingsProvider } from './settings'
import { resolveScheme } from './state/themeTokens'
import { applyTheme, legacyThemeMode, systemPrefersLight } from './theme'

/** Réglages du processus principal avant le premier rendu (pas d'éclair de thème). */
async function loadSettings(): Promise<AppSettings> {
  try {
    const r = await Promise.race([
      Promise.resolve(api.settings?.()),
      new Promise<null>((ok) => setTimeout(() => ok(null), 2000)),
    ])
    if (!r) return defaultSettings()
    let s = normalizeSettings(r.settings)
    // Premier lancement après le lot 4 : reprendre le mode choisi alors (stocké dans la page).
    const legacy = r.fresh ? legacyThemeMode() : null
    if (legacy && legacy !== s.theme.mode) {
      s = { ...s, theme: { ...s.theme, mode: legacy } }
      void api.updateSettings({ theme: s.theme })
    }
    return s
  } catch {
    return defaultSettings()
  }
}

requestTerminalPort()
void loadSettings().then((initial) => {
  applyTheme(initial.theme, resolveScheme(initial.theme.mode, systemPrefersLight()))
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <SettingsProvider initial={initial}>
        <App />
      </SettingsProvider>
    </StrictMode>,
  )
})
