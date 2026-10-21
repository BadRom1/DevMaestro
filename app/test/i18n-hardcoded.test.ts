/**
 * Lot 20 : plus de texte affiché en dur dans l'interface. Le détecteur
 * (`i18n-scan.ts`) signale le texte JSX, les attributs affichés et les
 * phrases françaises du code ; tout ce qui reste est justifié (commentaire
 * `i18n-exempt: …` ou `i18n-exceptions.ts`).
 */
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { I18N_EXCEPTIONS } from './i18n-exceptions'
import { MIN_REASON, scanFile, scanSource, scannedFiles, type Finding } from './i18n-scan'

const APP = path.resolve(__dirname, '..')

function covered(f: Finding, used: Set<number>): boolean {
  const i = I18N_EXCEPTIONS.findIndex(
    (e) => e.file === f.file && (e.text === '*' || (typeof e.text === 'string' ? e.text === f.text : e.text.test(f.text))),
  )
  if (i < 0) return false
  used.add(i)
  return true
}

describe('détecteur de chaînes en dur', () => {
  it('signale texte JSX, attributs affichés, littéraux enfants et phrases françaises', () => {
    const src = [
      "const a = <p title=\"Fermer\" aria-label={ok ? 'Oui' : 'Non'}>Bonjour {n} fichiers</p>",
      "const b = <p>{t('x.y')} {x === 'mot' ? 1 : 2}</p>",
      "const c = `Échec de l’envoi : ${e}`",
      "const d = 'chemin/vers/fichier.ts'",
      '// i18n-exempt: nom du produit',
      'const e = <h1>DevMaestro</h1>',
      "setError('la session est arrêtée')",
    ].join('\n')
    const got = scanSource('x.tsx', src).map((f) => `${f.line}:${f.kind}:${f.text}`)
    expect(got).toEqual([
      '1:jsx-attr:Fermer',
      '1:jsx-attr:Oui',
      '1:jsx-attr:Non',
      '1:jsx-text:Bonjour',
      '1:jsx-text:fichiers',
      '3:french:Échec de l’envoi : …',
      '7:french:la session est arrêtée',
    ])
  })

  it('aucune chaîne affichée en dur hors exceptions justifiées', () => {
    const used = new Set<number>()
    const left: string[] = []
    // Pendant une migration : `I18N_FILES='Sidebar|TopBar' pnpm vitest run test/i18n-hardcoded.test.ts` restreint aux fichiers visés.
    const only = process.env.I18N_FILES ? new RegExp(process.env.I18N_FILES) : null
    for (const file of scannedFiles(APP)) {
      if (only && !only.test(file)) continue
      for (const f of scanFile(APP, file)) if (!covered(f, used)) left.push(`${f.file}:${f.line} [${f.kind}] ${f.text}`)
    }
    expect(left.slice(0, 300), `${left.length} chaînes en dur`).toEqual([])
    if (only) return
    const stale = I18N_EXCEPTIONS.filter((_, i) => !used.has(i)).map((e) => `${e.file} ${String(e.text)}`)
    expect(stale, 'exceptions qui ne servent plus').toEqual([])
  })

  it('chaque exception a une raison', () => {
    for (const e of I18N_EXCEPTIONS) expect(e.reason.trim().length, `${e.file} ${String(e.text)}`).toBeGreaterThanOrEqual(MIN_REASON)
  })
})
