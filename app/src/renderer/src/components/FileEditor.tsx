/**
 * Éditeur CodeMirror 6 de l'onglet Fichiers (lot 7). Monté une fois par
 * édition ; le texte se lit et se remplace par la poignée (`handleRef`) :
 * `text()` pour enregistrer, `reset()` pour « Recharger ».
 */
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { useEffect, useRef, type RefObject } from 'react'

import { createEditorState, editorText, readOnlyConf, themeConf, themeFor } from '../state/editorSetup'

export interface EditorHandle {
  /** Texte de l'éditeur, avec les fins de ligne du fichier. */
  text: () => string
  /** Nouveau texte de base (historique vidé, plus de modification). */
  reset: (text: string) => void
  focus: () => void
}

export function FileEditor({
  path,
  text,
  readOnly,
  onDirty,
  onSave,
  handleRef,
}: {
  path: string
  /** Texte de départ (lu au montage seulement). */
  text: string
  readOnly: boolean
  onDirty: (dirty: boolean) => void
  onSave: () => void
  handleRef: RefObject<EditorHandle | null>
}) {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const hooks = useRef({ onDirty, onSave })
  hooks.current = { onDirty, onSave }
  const readOnlyRef = useRef(readOnly)
  readOnlyRef.current = readOnly

  // Montage : un éditeur pour toute l'édition, détruit au démontage.
  useEffect(() => {
    const parent = host.current
    if (!parent) return
    const make = (t: string) =>
      createEditorState(
        t,
        path,
        {
          onDirty: (d) => hooks.current.onDirty(d),
          onSave: () => hooks.current.onSave(),
          label: `Édition de ${path}`,
        },
        { readOnly: readOnlyRef.current },
      )
    const view = new EditorView({ state: make(text), parent })
    viewRef.current = view
    handleRef.current = {
      text: () => editorText(view.state),
      reset: (t) => {
        view.setState(make(t))
        hooks.current.onDirty(false)
      },
      focus: () => view.focus(),
    }
    view.focus()
    // Thème clair / sombre de base suivant le mode affiché (les couleurs, elles, viennent des variables CSS).
    const observer = new MutationObserver(() => view.dispatch({ effects: themeConf.reconfigure(themeFor()) }))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => {
      observer.disconnect()
      handleRef.current = null
      viewRef.current = null
      view.destroy()
    }
  }, [])

  // Lecture seule pendant un enregistrement (le texte envoyé est celui affiché).
  useEffect(() => {
    viewRef.current?.dispatch({ effects: readOnlyConf.reconfigure(EditorState.readOnly.of(readOnly)) })
  }, [readOnly])

  return <div className="feditor" ref={host} data-own-escape="" />
}
