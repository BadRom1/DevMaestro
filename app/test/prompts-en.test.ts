/**
 * Consignes par défaut en anglais (lot 20) : choisies selon la langue de
 * l'interface, mêmes variables et mêmes contraintes que les françaises ;
 * libellés traduits à l'usage ; migration du lot 14b comparée à toutes les
 * versions du défaut ; textes de repli des variables dans la langue courante.
 */
import { afterEach, describe, expect, it } from 'vitest'

import { LOCALES, setLocale } from '../src/shared/i18n'
import {
  MAX_PROMPT_CHARS,
  ORIGIN_LABELS,
  PROMPTS,
  PROMPT_IDS,
  defaultPrompt,
  isDefaultPrompt,
  promptDef,
  promptProblem,
  renderPrompt,
  resolvePrompt,
} from '../src/shared/prompts'
import { readSettings } from '../src/shared/settings'

afterEach(() => setLocale('fr'))

const varsOf = (t: string) => [...t.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]).sort()

describe('consignes par défaut en anglais', () => {
  it('chaque défaut anglais est valide et a les mêmes variables que le français', () => {
    for (const id of PROMPT_IDS) {
      const en = defaultPrompt(id, 'en')
      expect(en, id).not.toBe(defaultPrompt(id, 'fr'))
      expect(promptProblem(id, en), id).toBeNull()
      expect(varsOf(en), id).toEqual(varsOf(defaultPrompt(id, 'fr')))
      // Rendu sur des valeurs longues : toujours tapé en une ligne.
      const out = renderPrompt(id, en, { branch: 'b'.repeat(200), base: 'm'.repeat(200), issue: 1e15, comments: 3, excerpts: 2, run: 1e15, pr: 1e15, commit: 'abcdef1234' })
      expect([...out].length).toBeLessThanOrEqual(MAX_PROMPT_CHARS)
      expect(out).not.toMatch(/^[#/!]/)
    }
  })

  it('la référence française (`PROMPTS[].default`) ne change pas avec la langue', () => {
    const before = PROMPTS.map((p) => p.default)
    setLocale('en')
    expect(PROMPTS.map((p) => p.default)).toEqual(before)
    expect(defaultPrompt('review')).toBe(defaultPrompt('review', 'en'))
    expect(defaultPrompt('review', 'fr')).toBe(before[0])
  })

  it('origine « défaut » : texte de la langue courante ; surcharge jamais traduite', () => {
    setLocale('en')
    const s = { global: { deliveryPr: 'Livre {branche}.' }, projects: {} }
    expect(resolvePrompt(s, 'issue', null)).toEqual({ template: defaultPrompt('issue', 'en'), origin: 'défaut' })
    expect(resolvePrompt(s, 'deliveryPr', null)).toEqual({ template: 'Livre {branche}.', origin: 'global' })
  })

  it('isDefaultPrompt reconnaît toutes les versions du défaut', () => {
    for (const id of PROMPT_IDS) for (const l of LOCALES) expect(isDefaultPrompt(id, defaultPrompt(id, l))).toBe(true)
    expect(isDefaultPrompt('deliveryPr', 'Autre {branche}')).toBe(false)
  })

  it('migration du lot 14b : un ancien modèle égal au défaut anglais n’est pas une surcharge', () => {
    const { settings, warnings } = readSettings({ delivery: { prTemplate: defaultPrompt('deliveryPr', 'en'), mergeTemplate: defaultPrompt('deliveryMerge', 'fr') } })
    expect(warnings).toEqual([])
    expect(settings.prompts).toEqual({ global: {}, projects: {} })
  })

  it('libellés, origines, messages et replis des variables suivent la langue', () => {
    expect(promptDef('review').label).toBe('Revue du diff')
    expect(ORIGIN_LABELS['défaut']).toBe('texte par défaut')
    expect(renderPrompt('deliveryPr', '{branche} {issue}', {})).toBe('la branche courante aucune')
    setLocale('en')
    expect(promptDef('review').label).toBe('Diff review')
    expect(promptDef('deliveryPr').pasted).toBeNull()
    expect(promptDef('issue').variables[0]!.description).toMatch(/^issue number/)
    expect(ORIGIN_LABELS['défaut']).toBe('default text')
    expect(promptProblem('review', '')).toBe('the template is empty')
    expect(promptProblem('review', 'x {titre}')).toBe('unknown variable: {titre} (variables: {commentaires}, {branche})')
    expect(renderPrompt('deliveryPr', '{branche} {base} {issue}', {})).toBe('the current branch the default branch none')
    expect(renderPrompt('aiReviewCommit', '{commit}', {})).toBe('unknown')
  })
})
