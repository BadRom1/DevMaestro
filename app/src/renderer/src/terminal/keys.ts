/**
 * Touches que le terminal traduit lui-même avant xterm.
 *
 * Maj+Entrée : un terminal envoie `\r` comme pour Entrée, et Claude Code
 * validerait le message. Claude Code insère un retour à la ligne sur
 * Alt+Entrée (`ESC` puis `CR`), vérifié avec le vrai CLI (2.1.304) : on
 * envoie donc cette séquence.
 */
export const NEWLINE_SEQUENCE = '\x1b\r'

type KeyLike = Pick<KeyboardEvent, 'type' | 'key' | 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey' | 'isComposing'>

/** Séquence à envoyer à la place de la touche, ou `null` pour laisser xterm faire. */
export function keyOverride(e: KeyLike): string | null {
  if (e.type !== 'keydown' || e.isComposing) return null
  if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) return NEWLINE_SEQUENCE
  return null
}

/** Vrai si xterm doit ignorer l'événement (sa touche a été traduite au `keydown`). */
export function swallowedByOverride(e: KeyLike): boolean {
  return e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !e.isComposing
}
