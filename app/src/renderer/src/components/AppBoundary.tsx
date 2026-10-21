/**
 * Garde-fou de dernier recours, autour de toute l'interface : une erreur
 * d'affichage non rattrapée plus bas ne laisse plus une fenêtre blanche. Il
 * affiche l'erreur et propose de recharger l'interface : les sessions vivent
 * dans le démon et les réglages sont gardés par le processus principal, rien
 * n'est perdu.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react'

import { t } from '../../../shared/i18n'
import { DEFAULT_ZOOM, defaultSettings } from '../../../shared/settings'
import { api } from '../api'
import { reportRendererError } from '../errorReport'

interface State {
  error: Error | null
}

export class AppBoundary extends Component<{ children: ReactNode; reload?: () => void }, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // i18n-exempt: journal technique
    console.error('[devmaestro] erreur d’affichage :', error, info.componentStack)
    // i18n-exempt: journal technique
    reportRendererError('erreur d’affichage (interface entière)', error, info.componentStack)
  }

  private reload = (): void => (this.props.reload ?? (() => window.location.reload()))()

  /** Thème par défaut et taille 100 %, puis rechargement : sort d'un réglage enregistré qui ferait planter l'affichage. */
  private resetAppearance = async (): Promise<void> => {
    try {
      await api?.updateSettings?.({ theme: defaultSettings().theme, ui: { zoom: DEFAULT_ZOOM } })
    } catch (e) {
      // i18n-exempt: journal technique
      reportRendererError('réinitialisation de l’apparence', e)
    }
    this.reload()
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children
    // Composant de classe au-dessus des fournisseurs : langue globale (celle du dernier rendu).
    return (
      <div className="app-crash" role="alert">
        <h1>{t('shell.appBoundary.title')}</h1>
        <p className="mono">{this.state.error.message}</p>
        <p className="hint">{t('shell.appBoundary.hint')}</p>
        <div className="row-inline">
          <button className="btn pri" autoFocus onClick={this.reload}>
            {t('shell.appBoundary.reload')}
          </button>
          <button
            className="btn"
            title={t('shell.appBoundary.resetTitle')}
            onClick={() => void this.resetAppearance()}
          >
            {t('shell.appBoundary.reset')}
          </button>
        </div>
        <p className="hint">{t('shell.appBoundary.resetHint')}</p>
      </div>
    )
  }
}
