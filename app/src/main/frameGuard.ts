/**
 * Navigations des cadres de la fenêtre (lot 14a, aperçu web). Pur : testable
 * sans Electron.
 *
 * - Cadre principal : la page de l'app ne navigue jamais (seul le
 *   rechargement de la même adresse passe) ; une redirection serveur n'est
 *   comparée à l'adresse de la page que pour lui.
 * - **Tout** cadre enfant, à toute profondeur : jamais l'origine de la page
 *   de l'app (en développement, `http://localhost:5173` : une application
 *   affichée dans l'aperçu qui l'embarquerait atteindrait `window.devmaestro`
 *   par `allow-same-origin`), jamais `file:` ; cadre inconnu (`frame` nul) :
 *   refusé.
 * - Cadre enfant direct de la page (l'iframe de l'aperçu) : en plus,
 *   seulement une adresse d'aperçu (`previewUrl`) ou une page vide. Les
 *   navigations de cette iframe vers `blob:` ou `data:` sont refusées : la
 *   règle CSP `frame-src` de la page ne les permet pas non plus, et les
 *   applications courantes (serveurs de Vite, Next, Storybook…) n'en font
 *   pas leur document ; leurs `blob:` (images, workers, téléchargements) ne
 *   sont pas des navigations de l'iframe. Les cadres plus profonds relèvent
 *   de la politique de la page affichée.
 */
import { previewUrl } from '../shared/preview'

export interface FrameNavigation {
  url: string
  isMainFrame: boolean
  /** `false` : Electron ne donne pas le cadre (détruit, inconnu). */
  hasFrame: boolean
  /** Enfant direct du cadre principal (l'iframe de l'aperçu). */
  directChild: boolean
  /** Adresse actuelle de la page de l'app. */
  pageUrl: string
}

/** Origine de la page de l'app, `null` si elle est opaque (`file://`). */
export function originOf(url: string): string | null {
  try {
    const o = new URL(url).origin
    return o === 'null' ? null : o
  } catch {
    return null
  }
}

/** La page elle-même : seul le rechargement de la même adresse. */
export function mainFrameUrlAllowed(pageUrl: string, url: string): boolean {
  const strip = (u: string) => u.split('#')[0]
  return strip(url) === strip(pageUrl)
}

export function frameNavigationAllowed(n: FrameNavigation): boolean {
  if (n.isMainFrame) return mainFrameUrlAllowed(n.pageUrl, n.url)
  if (!n.hasFrame) return false
  if (n.url === 'about:blank' || n.url === 'about:srcdoc') return true
  let u: URL
  try {
    u = new URL(n.url)
  } catch {
    return false
  }
  if (u.protocol === 'file:') return false
  const page = originOf(n.pageUrl)
  if (page && u.origin === page) return false
  // `blob:` de l'origine de la page : `URL` donne l'origine de la page ; déjà refusé ci-dessus.
  if (n.directChild) return previewUrl(n.url, page) !== null
  return true
}
