/**
 * Langage de l'éditeur (CodeMirror 6, lot 7) d'après le chemin du fichier :
 * mêmes langages que la coloration en lecture (`languageForPath`), avec des
 * précisions par extension (TSX, TOML ou INI, HTML ou XML). Tout est dans le
 * paquet de l'app (aucun chargement dynamique).
 */
import { css } from '@codemirror/lang-css'
import { go } from '@codemirror/lang-go'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { rust } from '@codemirror/lang-rust'
import { sql } from '@codemirror/lang-sql'
import { xml } from '@codemirror/lang-xml'
import { yaml } from '@codemirror/lang-yaml'
import { StreamLanguage } from '@codemirror/language'
import { diff } from '@codemirror/legacy-modes/mode/diff'
import { properties } from '@codemirror/legacy-modes/mode/properties'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { toml } from '@codemirror/legacy-modes/mode/toml'
import type { Extension } from '@codemirror/state'

import { languageForPath } from './highlight'

function extension(path: string): string {
  const name = path.split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
}

/** Nom du langage de l'éditeur pour un chemin (`null` : texte brut). */
export function editorLanguageName(path: string): string | null {
  const lang = languageForPath(path)
  const ext = extension(path)
  switch (lang) {
    case 'typescript':
      return ext === 'tsx' ? 'tsx' : 'typescript'
    case 'javascript':
      return ext === 'jsx' ? 'jsx' : 'javascript'
    case 'ini':
      return ext === 'toml' ? 'toml' : 'ini'
    case 'xml':
      return ext === 'html' || ext === 'htm' || ext === 'xhtml' ? 'html' : 'xml'
    default:
      return lang
  }
}

/** Extension CodeMirror du langage d'un chemin (vide : texte brut). */
export function editorLanguage(path: string): Extension {
  switch (editorLanguageName(path)) {
    case 'rust':
      return rust()
    case 'typescript':
      return javascript({ typescript: true })
    case 'tsx':
      return javascript({ typescript: true, jsx: true })
    case 'javascript':
      return javascript()
    case 'jsx':
      return javascript({ jsx: true })
    case 'json':
      return json()
    case 'toml':
      return StreamLanguage.define(toml)
    case 'ini':
      return StreamLanguage.define(properties)
    case 'yaml':
      return yaml()
    case 'bash':
      return StreamLanguage.define(shell)
    case 'python':
      return python()
    case 'go':
      return go()
    case 'sql':
      return sql()
    case 'css':
      return css()
    case 'html':
      return html()
    case 'xml':
      return xml()
    case 'markdown':
      return markdown()
    case 'diff':
      return StreamLanguage.define(diff)
    default:
      return []
  }
}
