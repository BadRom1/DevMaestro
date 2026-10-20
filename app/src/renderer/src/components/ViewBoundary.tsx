/**
 * Garde-fou d'affichage des onglets Diff, Fichiers et Agents : une erreur de
 * rendu (contenu inattendu…) n'efface plus toute la fenêtre ; l'onglet affiche
 * « Affichage impossible » et propose de réessayer.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react'

interface State {
  error: Error | null
}

export class ViewBoundary extends Component<{ children: ReactNode; label: string }, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(`[devmaestro] affichage de l’onglet ${this.props.label} :`, error, info.componentStack)
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div className="diffpane empty" role="alert">
        <b>Affichage impossible</b>
        <span className="hint">
          L’onglet {this.props.label} a rencontré une erreur : {this.state.error.message}
        </span>
        <button className="btn sm" onClick={() => this.setState({ error: null })}>
          Réessayer
        </button>
      </div>
    )
  }
}
