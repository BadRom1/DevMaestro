// Les définitions de langage de highlight.js n'ont pas de types par sous-chemin.
declare module 'highlight.js/lib/languages/*' {
  import type { LanguageFn } from 'highlight.js'
  const language: LanguageFn
  export default language
}
