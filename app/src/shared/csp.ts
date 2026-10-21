/**
 * Politique de sécurité du contenu de la page, injectée dans `index.html`
 * (voir `electron.vite.config.ts`).
 *
 * - En production (fichiers locaux) : rien hors de l'app, aucun script en
 *   ligne, aucune connexion réseau. `style-src 'unsafe-inline'` reste
 *   nécessaire : xterm.js insère ses propres éléments `<style>` (barre de
 *   défilement, dimensions des cellules).
 * - En développement : le serveur Vite sert la page et pousse les mises à
 *   jour par WebSocket ; le préambule de React Refresh est un script en ligne.
 * - `frame-src` (lot 14a) : l'aperçu web des runners, seulement les serveurs
 *   de la machine en http (`localhost`, `127.0.0.1`, tout port ; `[::1]`
 *   passe par `localhost`, Chromium refusant une source CSP IPv6).
 *   Rien d'autre n'est relâché : `connect-src` reste fermé, la page ne parle
 *   pas à ces serveurs, elle les affiche dans une iframe isolée.
 */
import { PREVIEW_FRAME_SOURCES } from './preview'

export const FRAME_SRC = `frame-src ${PREVIEW_FRAME_SOURCES.join(' ')}`

export const PROD_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  FRAME_SRC,
  "object-src 'none'",
].join('; ')

export const DEV_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self' ws://localhost:* ws://127.0.0.1:*",
  "base-uri 'none'",
  "form-action 'none'",
  FRAME_SRC,
  "object-src 'none'",
].join('; ')
