/**
 * Vue code : le `<code>` doit reprendre la police et la hauteur de ligne de son `<pre>`.
 *
 * Sinon il garde celle du navigateur (`font-family: monospace`, DejaVu Sans Mono
 * sous Linux) dont la ligne de base diffère de JetBrains Mono : hors échelle 1
 * (écran HiDPI, zoom), chaque ligne de code mesure 20,5 à 20,8 px au lieu de 20
 * et le code glisse sous les numéros (mesuré dans Chromium : +10 px à la ligne 18
 * en échelle 2, +240 px à la ligne 300 en échelle 1,25). Sans moteur de mise en
 * page (jsdom n'en a pas, et Vitest ne charge pas le CSS), on vérifie la règle.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const css = readFileSync(resolve(__dirname, '../src/renderer/src/styles.css'), 'utf8')

/** Déclarations (propriété → valeur) de la règle au sélecteur exact `selector`. */
function declarations(selector: string): Map<string, string> {
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const re = /([^{}]+)\{([^{}]*)\}/g
  for (let m = re.exec(flat); m; m = re.exec(flat)) {
    const selectors = m[1]!.split(',').map((x) => x.trim().replace(/\s+/g, ' '))
    if (!selectors.includes(selector)) continue
    return new Map(
      m[2]!
        .split(';')
        .map((d) => d.split(':').map((x) => x.trim()))
        .filter((d): d is [string, string] => d.length === 2 && d[0] !== '')
        .map(([k, v]) => [k, v]),
    )
  }
  return new Map()
}

describe('vue code : alignement des numéros et du code', () => {
  it('le <code> (coloré ou brut) hérite de la police et de la hauteur de ligne du <pre>', () => {
    const d = declarations('.codeview pre code')
    expect(d.get('font')).toBe('inherit')
    expect(d.get('line-height')).toBe('inherit')
    expect(d.get('display')).toBe('inline')
  })

  it('les deux colonnes partagent police, taille et hauteur de ligne', () => {
    const pre = declarations('.codeview pre')
    expect(pre.get('font-family')).toBe('var(--f-mono)')
    expect(pre.get('line-height')).toBe('var(--lh)')
    // Aucune règle de colonne ne redéfinit la police ou la hauteur de ligne d'un seul côté.
    for (const side of ['.codeview .gutter', '.codeview .code']) {
      const d = declarations(side)
      for (const k of ['font', 'font-family', 'font-size', 'line-height']) expect(d.has(k), `${side} ${k}`).toBe(false)
    }
  })
})
