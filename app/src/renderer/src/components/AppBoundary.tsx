/**
 * Garde-fou de dernier recours, autour de toute l'interface : une erreur
 * d'affichage non rattrapée plus bas ne laisse plus une fenêtre blanche. Il
 * affiche l'erreur et propose de recharger l'interface : les sessions vivent
 * dans le démon et les réglages sont gardés par le processus principal, rien
 * n'est perdu.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react'

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
    console.error('[devmaestro] erreur d’affichage :', error, info.componentStack)
    reportRendererError('erreur d’affichage (interface entière)', error, info.componentStack)
  }

  private reload = (): void => (this.props.reload ?? (() => window.location.reload()))()

  /** Thème par défaut et taille 100 %, puis rechargement : sort d'un réglage enregistré qui ferait planter l'affichage. */
  private resetAppearance = async (): Promise<void> => {
    try {
      await api?.updateSettings?.({ theme: defaultSettings().theme, ui: { zoom: DEFAULT_ZOOM } })
    } catch (e) {
      reportRendererError('réinitialisation de l’apparence', e)
    }
    this.reload()
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div className="app-crash" role="alert">
        <h1>Une erreur d’affichage est survenue</h1>
        <p className="mono">{this.state.error.message}</p>
        <p className="hint">
          Les sessions continuent de tourner dans le démon et tes réglages sont enregistrés : recharger l’interface ne perd rien.
        </p>
        <div className="row-inline">
          <button className="btn pri" autoFocus onClick={this.reload}>
            Recharger l’interface
          </button>
          <button
            className="btn"
            title="Thème par défaut (modes, palettes, couleurs) et taille du texte à 100 %, puis rechargement"
            onClick={() => void this.resetAppearance()}
          >
            Réinitialiser l’apparence
          </button>
        </div>
        <p className="hint">« Réinitialiser l’apparence » si l’erreur revient à chaque démarrage (thème ou taille du texte en cause).</p>
      </div>
    )
  }
}
