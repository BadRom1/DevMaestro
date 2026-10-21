/**
 * Aperçu web des runners (lot 14a, architecture § « Aperçu web ») : une
 * iframe dans la page, limitée aux serveurs de la machine.
 *
 * Seules les adresses `http://localhost:<port>`, `http://127.0.0.1:<port>`
 * et `http://[::1]:<port>` sont affichées. Le nom d'hôte est comparé
 * **après** analyse par `URL` (forme normalisée), jamais par préfixe de
 * texte : ni `localhost.evil.com`, ni `127.0.0.1.nip.io`, ni
 * `http://localhost@evil.com`.
 *
 * IPv6 : Chromium refuse une adresse IPv6 entre crochets dans une source CSP
 * (« contains an invalid source: 'http://[::1]:*'. It will be ignored »,
 * vérifié avec l'Electron de l'app). La règle `frame-src` ne nomme donc que
 * `localhost` et `127.0.0.1`, et l'aperçu d'une adresse `[::1]` passe par
 * `localhost` (même port, même chemin), que Chromium résout aussi vers `::1`
 * (un serveur qui n'écoute qu'en IPv6 s'affiche).
 */

/** Hôtes acceptés, sous leur forme normalisée par `URL` (IPv6 entre crochets). */
export const PREVIEW_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '[::1]']

/** Sources de la règle CSP `frame-src` de la fenêtre (sans `[::1]`, refusé par Chromium : voir plus haut). */
export const PREVIEW_FRAME_SOURCES: readonly string[] = ['http://localhost:*', 'http://127.0.0.1:*']

export const MAX_PREVIEW_URL = 2048

/**
 * Adresse à charger dans l'aperçu (forme normalisée, `[::1]` → `localhost`), ou `null`.
 *
 * - `http:` seulement (pas de `https:` : la règle CSP ne le permet pas),
 *   sans identifiants (`user:pass@`) ; port explicite ou implicite (80) ;
 * - `pageOrigin` : origine de la page de l'app. En développement, la page
 *   est servie par `http://localhost:<port>` : une iframe de **même
 *   origine** avec `allow-scripts allow-same-origin` pourrait atteindre la
 *   page (et son API) ; cette origine est donc refusée.
 */
export function previewUrl(raw: unknown, pageOrigin: string | null = null): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_PREVIEW_URL) return null
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return null
  }
  if (u.protocol !== 'http:') return null
  if (u.username !== '' || u.password !== '') return null
  if (!PREVIEW_HOSTS.includes(u.hostname)) return null
  // `[::1]` : affiché par `localhost` (la règle CSP ne peut pas nommer une adresse IPv6).
  if (u.hostname === '[::1]') u.hostname = 'localhost'
  if (pageOrigin && pageOrigin !== 'null' && u.origin === pageOrigin) return null
  return u.href
}

/** Adresse lisible d'une URL d'aperçu (`localhost:5173`, `localhost` pour le port 80), pour les boutons. */
export function previewLabel(url: string): string {
  try {
    const u = new URL(url)
    return `${u.host}${u.pathname === '/' ? '' : u.pathname}`
  } catch {
    return url
  }
}
