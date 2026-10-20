// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'

import { codeSelection, markdownSelection, textOffset } from '../../src/renderer/src/state/domSelection'
import { highlightCode } from '../../src/renderer/src/state/highlight'
import { renderMarkdown } from '../../src/renderer/src/state/markdown'

/** Monte du HTML dans un élément du document. */
function mount(tag: string, html: string): HTMLElement {
  const el = document.createElement(tag)
  el.innerHTML = html
  document.body.replaceChildren(el)
  return el
}

/** Nœud texte qui contient `needle` (premier trouvé). */
function textNode(root: Node, needle: string): Text {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent?.includes(needle)) return n as Text
  throw new Error(`texte introuvable : ${needle}`)
}

/** Sélection de `from` (début) à `to` (fin, comprise). */
function select(root: Node, from: string, to: string): Range {
  const a = textNode(root, from)
  const b = textNode(root, to)
  const r = document.createRange()
  r.setStart(a, a.textContent!.indexOf(from))
  r.setEnd(b, b.textContent!.indexOf(to) + to.length)
  return r
}

const SRC = [
  '# Titre', // 1
  '', // 2
  'Un paragraphe', // 3
  'sur deux lignes.', // 4
  '', // 5
  '- premier', // 6
  '- second', // 7
  '- troisième', // 8
  '', // 9
  '```rust', // 10
  'fn main() {', // 11
  '    let x = 1;', // 12
  '}', // 13
  '```', // 14
].join('\n')

describe('Markdown rendu → lignes source (vrai rendu)', () => {
  const article = () => mount('article', renderMarkdown(SRC).html)

  it('titre seul, puis titre et paragraphe', () => {
    const a = article()
    expect(markdownSelection(a, select(a, 'Titre', 'Titre'))).toEqual({ line: 1, lineEnd: 1 })
    expect(markdownSelection(a, select(a, 'itre', 'paragraphe'))).toEqual({ line: 1, lineEnd: 4 })
  })

  it('élément de liste : pas toute la liste', () => {
    const a = article()
    expect(markdownSelection(a, select(a, 'second', 'second'))).toEqual({ line: 7, lineEnd: 7 })
    expect(markdownSelection(a, select(a, 'emier', 'troisi'))).toEqual({ line: 6, lineEnd: 8 })
  })

  it('bloc de code coloré : lignes du bloc entier', () => {
    const a = article()
    expect(a.querySelector('code .hljs-keyword')).not.toBeNull()
    expect(markdownSelection(a, select(a, 'main', 'let'))).toEqual({ line: 10, lineEnd: 14 })
  })

  it('sélection qui finit au tout début du bloc suivant : ce bloc ne compte pas', () => {
    const a = article()
    const r = select(a, 'Un paragraphe', 'lignes.')
    const next = textNode(a, 'premier')
    r.setEnd(next, 0)
    expect(markdownSelection(a, r)).toEqual({ line: 3, lineEnd: 4 })
  })

  it('sélection vide ou hors de l’article : rien', () => {
    const a = article()
    const r = document.createRange()
    r.setStart(textNode(a, 'Titre'), 0)
    expect(markdownSelection(a, r)).toBeNull()
  })
})

describe('code coloré → lignes (positions du texte brut)', () => {
  const text = 'fn a() {\n    "x<y>"\n}\n// fin\n'

  it('textOffset suit le texte du fichier, pas le HTML', () => {
    const html = highlightCode(text, 'rust')!
    expect(html).toContain('&lt;y&gt;')
    const code = mount('code', html)
    expect(code.textContent).toBe(text)
    const n = textNode(code, 'x<y>')
    expect(textOffset(code, n, n.textContent!.indexOf('<'))).toBe(text.indexOf('<'))
  })

  it('sélection dans le code → lignes ; fin au début de ligne exclue', () => {
    const code = mount('code', highlightCode(text, 'rust')!)
    expect(codeSelection(code, text, select(code, 'x<', '}'))).toEqual({ line: 2, lineEnd: 3 })
    const r = select(code, 'fn', 'fn')
    r.setEnd(textNode(code, '"x<y>"'), 0)
    // Le nœud de la chaîne commence après l'indentation : la ligne 2 est touchée.
    expect(codeSelection(code, text, r)?.line).toBe(1)
    const r2 = document.createRange()
    r2.setStart(textNode(code, 'fn'), 0)
    expect(codeSelection(code, text, r2)).toBeNull() // vide
    expect(codeSelection(code, '', select(code, 'fn', 'fn'))).toBeNull() // fichier vide
  })
})
