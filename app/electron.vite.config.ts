import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'

/**
 * Politique de sécurité du contenu de la page, injectée dans `index.html`.
 *
 * - En production (fichiers locaux) : rien hors de l'app, aucun script en
 *   ligne, aucune connexion réseau. `style-src 'unsafe-inline'` reste
 *   nécessaire : xterm.js insère ses propres éléments `<style>` (barre de
 *   défilement, dimensions des cellules).
 * - En développement : le serveur Vite sert la page et pousse les mises à
 *   jour par WebSocket ; le préambule de React Refresh est un script en ligne.
 */
const PROD_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "object-src 'none'",
].join('; ')

const DEV_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self' ws://localhost:* ws://127.0.0.1:*",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "object-src 'none'",
].join('; ')

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
