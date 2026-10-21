import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'

import { DEV_CSP, PROD_CSP } from './src/shared/csp'

/**
 * `index.html` porte la politique stricte de production dans une balise
 * `<meta>` (visible sans outillage). Le serveur de développement la remplace
 * par `DEV_CSP` ; la construction vérifie qu'elle est identique à `PROD_CSP`
 * (une seule source de vérité, pas de divergence silencieuse).
 */
const CSP_META = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"\s*\/?>/

function csp(): Plugin {
  let serve = false
  return {
    name: 'devmaestro-csp',
    configResolved(config) {
      serve = config.command === 'serve'
    },
    transformIndexHtml(html) {
      const m = CSP_META.exec(html)
      if (!m) throw new Error('index.html : balise <meta> Content-Security-Policy absente')
      if (serve) return html.replace(CSP_META, `<meta http-equiv="Content-Security-Policy" content="${DEV_CSP}" />`)
      if (m[1] !== PROD_CSP) throw new Error('index.html : la CSP diffère de PROD_CSP (electron.vite.config.ts)')
      return html
    },
  }
}

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [react(), csp()],
    build: {
      // Pas de module chargé depuis le réseau, pas d'inlining en data: pour les polices.
      assetsInlineLimit: 0,
    },
  },
})
