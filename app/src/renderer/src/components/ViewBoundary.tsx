/**
 * Garde-fou d'affichage des onglets (Diff, Commits, Fichiers, Agents) et du
 * contenu des dialogues : une erreur de rendu (contenu inattendu…) n'efface
 * plus toute la fenêtre ; l'onglet ou le dialogue affiche « Affichage
 * impossible », propose de réessayer, et l'erreur part au journal du
 * processus principal.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react'

import { reportRendererError } from '../errorReport'

interface State {
  error: Error | null
}

export class ViewBoundary extends Component<{ children: ReactNode; label: string; kind?: 'onglet' | 'dialogue' }, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    const where = this.props.kind === 'dialogue' ? `du dialogue « ${this.props.label} »` : `de l’onglet ${this.props.label}`
    console.error(`[devmaestro] affichage ${where} :`, error, info.componentStack)
    reportRendererError(`affichage ${where}`, error, info.componentStack)
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children
    const dialog = this.props.kind === 'dialogue'
    return (
      <div className={dialog ? 'mb boundary' : 'diffpane empty'} role="alert">
        <b>Affichage impossible</b>
        <span className="hint">
          {dialog ? `Le dialogue « ${this.props.label} »` : `L’onglet ${this.props.label}`} a rencontré une erreur :{' '}
          {this.state.error.message}
        </span>
        <button className="btn sm" autoFocus onClick={() => this.setState({ error: null })}>
          Réessayer
        </button>
      </div>
    )
  }
}
