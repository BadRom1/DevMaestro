import { describe, expect, it } from 'vitest'

import { clampTitle, normalizeTitleInput, titleLength } from '../src/renderer/src/state/title'

describe('titre de session saisi', () => {
  it('retire les blancs de bord ; vide = pas de titre', () => {
    expect(normalizeTitleInput('  Refonte  ')).toEqual({ ok: true, title: 'Refonte' })
    expect(normalizeTitleInput('')).toEqual({ ok: true, title: null })
    expect(normalizeTitleInput('   ')).toEqual({ ok: true, title: null })
  })

  it('seulement des caractères invisibles ou de format : pas de titre', () => {
    for (const t of ['​', '​‍﻿', '⁠  ', 'ㅤ', '‮⁦']) {
      expect(normalizeTitleInput(t), JSON.stringify(t)).toEqual({ ok: true, title: null })
    }
  })

  it('retire les contrôles bidirectionnels', () => {
    expect(normalizeTitleInput('a‮b⁦c⁩‏d؜')).toEqual({ ok: true, title: 'abcd' })
    // Un joint de largeur nulle dans un émoji composé reste.
    expect(normalizeTitleInput('👩‍💻 dev')).toEqual({ ok: true, title: '👩‍💻 dev' })
  })

  it('refuse les caractères de contrôle, comme le démon', () => {
    expect(normalizeTitleInput('a\tb').ok).toBe(false)
    expect(normalizeTitleInput('a\u0007').ok).toBe(false)
  })

  it('80 caractères au plus, comptés en points de code', () => {
    expect(normalizeTitleInput('😀'.repeat(80))).toEqual({ ok: true, title: '😀'.repeat(80) })
    const r = normalizeTitleInput('😀'.repeat(81))
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toBe('titre trop long : 81 caractères, 80 au plus')
    // Les contrôles bidi retirés ne comptent pas.
    expect(normalizeTitleInput('x'.repeat(80) + '‮').ok).toBe(true)
  })

  it('coupe la saisie à 80 points de code sans casser une paire de substitution', () => {
    expect(titleLength(clampTitle('😀'.repeat(90)))).toBe(80)
    expect(clampTitle('😀'.repeat(90))).toBe('😀'.repeat(80))
    expect(clampTitle('abc')).toBe('abc')
  })
})
