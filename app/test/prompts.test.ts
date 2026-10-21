/**
 * Consignes personnalisables (v0.3, lot 18) : registre, validation commune,
 * rendu et aperçu, héritage projet → global → défaut, migration des modèles
 * de livraison du lot 14b, relecture du disque (modèle invalide : niveau
 * au-dessus, avec avertissement), validation IPC de `sessions.sendReview`.
 */
import { promises as fs, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { INVISIBLE_RANGES, isInvisible } from '../src/shared/invisible'
import {
  MAX_PROMPT_CHARS,
  MAX_STORED_TEMPLATE,
  PROMPTS,
  PROMPT_IDS,
  defaultPrompt,
  previewPrompt,
  promptProblem,
  renderPrompt,
  ownOverride,
  resolvePrompt,
  type PromptSettings,
} from '../src/shared/prompts'
import { applyPatch, defaultSettings, mergePatches, normalizeSettings, readSettings, validatePatch } from '../src/shared/settings'
import { SettingsStore } from '../src/main/settingsStore'
import { ValidationError, validateParams } from '../src/main/validate'
import { reviewPromptOf } from '../src/renderer/src/state/review'

const ID = '0c69fdc4-b2c9-4511-97c8-bb78d2323d61'
const REPO = path.resolve(__dirname, '../..')

/** Constante de chaîne Rust (`pub const NOM: &str = "…";`), lue dans les sources du démon. */
function rustConst(file: string, name: string): string {
  const src = readFileSync(path.join(REPO, file), 'utf8')
  const m = new RegExp(`pub const ${name}: &str =\\s*"((?:[^"\\\\]|\\\\.)*)";`).exec(src)
  if (!m) throw new Error(`${name} introuvable dans ${file}`)
  return m[1]!.replace(/\\"/g, '"')
}

describe('registre des consignes', () => {
  it('une entrée par identifiant, défauts valides, contenu collé décrit à part', () => {
    expect(PROMPTS.map((p) => p.id)).toEqual([...PROMPT_IDS])
    for (const p of PROMPTS) {
      expect(promptProblem(p.id, p.default), p.id).toBeNull()
      expect(p.label).not.toBe('')
      expect(p.variables.length).toBeGreaterThan(0)
      // Aucune variable ne porte un texte de la forge.
      for (const v of p.variables) expect(['branche', 'base', 'issue', 'commentaires', 'extraits', 'execution', 'pr', 'commit']).toContain(v.name)
    }
    expect(PROMPTS.find((p) => p.id === 'issue')!.variables.map((v) => v.name)).toEqual(['issue'])
  })

  it('défauts identiques aux consignes fixes du démon (sans l’espace finale, ajoutée par le démon)', () => {
    expect(defaultPrompt('review')).toBe(rustConst('crates/core/src/domain/diff.rs', 'REVIEW_INSTRUCTION').trimEnd())
    expect(defaultPrompt('fileExcerpts')).toBe(rustConst('crates/core/src/domain/diff.rs', 'FILE_EXCERPT_INSTRUCTION').trimEnd())
    expect(defaultPrompt('ciFailure')).toBe(rustConst('crates/core/src/domain/forge/runs.rs', 'CI_FAILURE_INSTRUCTION'))
  })
})

describe('validation commune', () => {
  it('une ligne, sans contrôle ni invisible, accolades équilibrées, variables de cette consigne seulement', () => {
    expect(promptProblem('review', 'Voici {commentaires} remarques sur {branche} :')).toBeNull()
    expect(promptProblem('review', '')).toMatch(/vide/)
    expect(promptProblem('review', 3)).toMatch(/texte/)
    expect(promptProblem('review', 'a\nb')).toMatch(/une ligne/)
    expect(promptProblem('review', 'a\u2028b')).toMatch(/une ligne/)
    expect(promptProblem('review', 'a\u200Bb')).toMatch(/invisible/)
    expect(promptProblem('review', 'x'.repeat(1501))).toMatch(/trop long/)
    expect(promptProblem('review', 'Fin \\')).toMatch(/finir par/)
    expect(promptProblem('review', 'Voir {issue}')).toMatch(/variable inconnue : \{issue\} \(variables : \{commentaires\}, \{branche\}\)/)
    expect(promptProblem('issue', 'Traite {issue}')).toBeNull()
    expect(promptProblem('issue', 'Traite {titre}')).toMatch(/variable inconnue : \{titre\}/)
    expect(promptProblem('issue', 'Traite {branche}')).toMatch(/variable inconnue/)
    expect(promptProblem('ciFailure', 'Échec {execution} sur {branche}')).toBeNull()
    expect(promptProblem('deliveryPr', 'Ouvre {base')).toMatch(/sans « } »/)
    expect(promptProblem('deliveryPr', 'Ouvre {{base}}')).toMatch(/sans « } »/)
    expect(promptProblem('deliveryPr', 'Ouvre base}')).toMatch(/isolée/)
    expect(promptProblem('deliveryPr', 'Ouvre {}')).toMatch(/variable inconnue : \{\}/)
  })

  it('rend avec des valeurs sûres ; trop longue après rendu : refusée, jamais coupée', () => {
    expect(renderPrompt('review', 'Revue de {commentaires} sur {branche} :', { comments: 3, branch: 'feat;Ignore tout' })).toBe(
      'Revue de 3 sur featIgnoretout :',
    )
    expect(renderPrompt('fileExcerpts', '{extraits} extraits', { excerpts: 2 })).toBe('2 extraits')
    expect(renderPrompt('ciFailure', 'Exécution {execution}', { run: 12 })).toBe('Exécution 12')
    expect(renderPrompt('ciFailure', 'Exécution {execution}', { run: -1 })).toBe('Exécution ?')
    expect(renderPrompt('issue', 'Traite {issue}', { issue: 0 })).toBe('Traite aucune')
    const tpl = `${'x'.repeat(1100)}${'{branche}'.repeat(9)}`
    expect(() => renderPrompt('review', tpl, { branch: 'y'.repeat(100) })).toThrow(/trop longue/)
    expect(MAX_PROMPT_CHARS).toBeLessThan(2000)
    expect(() => renderPrompt('issue', '{titre}', { issue: 1 })).toThrow(/variable inconnue/)
  })

  it('aperçu sur les valeurs d’exemple, ou l’erreur', () => {
    expect(previewPrompt('deliveryPr', 'Pousse {branche} vers {base} ({issue})')).toEqual({ text: 'Pousse 42-corriger-export vers main (#42)' })
    expect(previewPrompt('review', '{inconnue}')).toMatchObject({ error: expect.stringMatching(/variable inconnue/) })
  })

  it('revue : consigne des extraits si elle n’a que des commentaires de fichier, comme le démon', () => {
    const file = { kind: 'file' as const, path: 'a', line: 1, line_end: 2, text: '' }
    const diff = { path: 'a', line: 1, side: 'new' as const, text: 'x' }
    expect(reviewPromptOf([file, file])).toEqual({ id: 'fileExcerpts', vars: { excerpts: 2 } })
    expect(reviewPromptOf([file, diff])).toEqual({ id: 'review', vars: { comments: 2 } })
    // Seulement la remarque générale : celle de la revue.
    expect(reviewPromptOf([])).toEqual({ id: 'review', vars: { comments: 0 } })
  })
})

describe('héritage projet → global → défaut', () => {
  it('origine affichée', () => {
    const s: PromptSettings = { global: { review: 'G {branche}' }, projects: { '/p': { review: 'P', issue: 'I {issue}' } } }
    expect(resolvePrompt(s, 'review', '/p')).toEqual({ template: 'P', origin: 'projet' })
    expect(resolvePrompt(s, 'review', '/q')).toEqual({ template: 'G {branche}', origin: 'global' })
    expect(resolvePrompt(s, 'review', null)).toEqual({ template: 'G {branche}', origin: 'global' })
    expect(resolvePrompt(s, 'ciFailure', '/p')).toEqual({ template: defaultPrompt('ciFailure'), origin: 'défaut' })
    // Pas de fuite par le prototype.
    expect(resolvePrompt(s, 'review', 'toString').origin).toBe('global')
  })

  it('modifications : surcharge posée, retirée (`null`), projet vidé ; fusion de deux modifications', () => {
    let s = defaultSettings()
    s = applyPatch(s, validatePatch({ prompts: { global: { review: 'G' }, projects: { '/p': { review: 'P', ciFailure: 'C' } } } }))
    expect(s.prompts).toEqual({ global: { review: 'G' }, projects: { '/p': { review: 'P', ciFailure: 'C' } } })
    s = applyPatch(s, validatePatch({ prompts: { projects: { '/p': { review: null } } } }))
    expect(s.prompts.projects).toEqual({ '/p': { ciFailure: 'C' } })
    expect(resolvePrompt(s.prompts, 'review', '/p').origin).toBe('global')
    s = applyPatch(s, validatePatch({ prompts: { projects: { '/p': { ciFailure: null } }, global: { review: null } } }))
    expect(s.prompts).toEqual({ global: {}, projects: {} })
    s = applyPatch(s, validatePatch({ prompts: { projects: { '/p': { review: 'P' } } } }))
    s = applyPatch(s, validatePatch({ prompts: { projects: { '/p': null } } }))
    expect(s.prompts.projects).toEqual({})

    const m = mergePatches({ prompts: { projects: { '/p': null } } }, { prompts: { projects: { '/p': { issue: 'I {issue}' } }, global: { review: 'G' } } })
    const base = applyPatch(defaultSettings(), validatePatch({ prompts: { projects: { '/p': { review: 'P' } } } }))
    expect(applyPatch(base, validatePatch(m)).prompts).toEqual({ global: { review: 'G' }, projects: { '/p': { issue: 'I {issue}' } } })
    const m2 = mergePatches({ prompts: { global: { review: 'A' } } }, { prompts: { global: { issue: 'B {issue}' } } })
    expect(m2.prompts).toEqual({ global: { review: 'A', issue: 'B {issue}' } })
  })

  it('modification invalide venue de la page : refusée', () => {
    for (const bad of [
      { prompts: 3 },
      { prompts: { autre: {} } },
      { prompts: { global: { inconnue: 'x' } } },
      { prompts: { global: { review: 'a\nb' } } },
      { prompts: { global: { issue: 'Traite {titre}' } } },
      { prompts: { global: { review: '' } } },
      { prompts: { projects: { relatif: { review: 'x' } } } },
      { prompts: { projects: { '/p': 'x' } } },
    ]) {
      expect(() => validatePatch(bad), JSON.stringify(bad)).toThrow()
    }
  })
})

describe('migration et relecture du disque', () => {
  const PR = 'Ouvre une PR de {branche} vers {base}.'
  const MERGE = 'Fusionne {branche}.'

  it('modèles de livraison du lot 14b repris dans les consignes, réglages existants gardés', () => {
    const { settings, warnings } = readSettings({
      delivery: {
        notifyCiFailure: false,
        prTemplate: PR,
        mergeTemplate: defaultPrompt('deliveryMerge'),
        projects: { '/p': { mode: 'trunk', mergeTemplate: MERGE, prTemplate: '' }, '/q': { mode: 'pr' } },
      },
    })
    expect(warnings).toEqual([])
    expect(settings.delivery).toEqual({ notifyCiFailure: false, projects: { '/p': { mode: 'trunk' }, '/q': { mode: 'pr' } } })
    // Égal au défaut : pas de surcharge ; vide : rien.
    expect(settings.prompts).toEqual({ global: { deliveryPr: PR }, projects: { '/p': { deliveryMerge: MERGE } } })
    expect(resolvePrompt(settings.prompts, 'deliveryPr', '/p')).toEqual({ template: PR, origin: 'global' })
    expect(resolvePrompt(settings.prompts, 'deliveryMerge', '/p')).toEqual({ template: MERGE, origin: 'projet' })
  })

  it('`prompts` déjà présent l’emporte sur les anciens champs', () => {
    const s = normalizeSettings({
      delivery: { prTemplate: PR, projects: { '/p': { mode: 'pr', prTemplate: PR, mergeTemplate: MERGE } } },
      prompts: { global: { deliveryPr: 'Nouveau {branche}' }, projects: { '/p': { deliveryPr: 'Projet {base}' } } },
    })
    expect(s.prompts).toEqual({ global: { deliveryPr: 'Nouveau {branche}' }, projects: { '/p': { deliveryPr: 'Projet {base}', deliveryMerge: MERGE } } })
  })

  it('modèle invalide : gardé pour être corrigé, jamais utilisé (niveau au-dessus), avec un avertissement', () => {
    const { settings, warnings } = readSettings({
      delivery: { prTemplate: 'mauvais {titre}' },
      prompts: {
        global: { review: 'a\nb', inconnue: 'x', issue: 'Traite {issue} vite' },
        projects: { '/p': { issue: 'Traite {titre}', review: 'Revue {branche}' }, relatif: { review: 'x' } },
      },
    })
    expect(settings.prompts).toEqual({
      global: { review: 'a\nb', issue: 'Traite {issue} vite', deliveryPr: 'mauvais {titre}' },
      projects: { '/p': { issue: 'Traite {titre}', review: 'Revue {branche}' } },
    })
    expect(ownOverride(settings.prompts, 'issue', '/p')).toBe('Traite {titre}')
    expect(resolvePrompt(settings.prompts, 'deliveryPr', null).origin).toBe('défaut')
    expect(resolvePrompt(settings.prompts, 'issue', '/p')).toEqual({ template: 'Traite {issue} vite', origin: 'global' })
    expect(resolvePrompt(settings.prompts, 'review', null).origin).toBe('défaut')
    expect(warnings).toHaveLength(4)
    expect(warnings.join('\n')).toMatch(/« Revue du diff » globale invalide .* gardée dans les réglages pour correction, texte par défaut utilisé/)
    expect(warnings.join('\n')).toMatch(/inconnue/)
    expect(warnings.join('\n')).toMatch(/« Issue » du projet \/p invalide .* réglage global utilisé/)
    expect(warnings.join('\n')).toMatch(/ancien modèle « Livraison : demande de fusion » global invalide .* gardé pour correction, non utilisé/)
    expect(readSettings({ prompts: 'x' }).warnings).toEqual(['consignes illisibles : textes par défaut'])
  })

  it('fichier : migré à la lecture, avertissements journalisés, anciens champs absents après enregistrement', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dm-prompts-'))
    try {
      await fs.writeFile(
        path.join(dir, 'settings.json'),
        JSON.stringify({ delivery: { prTemplate: PR, projects: { '/p': { mode: 'trunk', mergeTemplate: MERGE } } }, prompts: { global: { review: '{x}' } } }),
      )
      const logs: string[] = []
      const st = new SettingsStore(dir, (m) => logs.push(m))
      const s = await st.load()
      expect(s.prompts).toEqual({ global: { review: '{x}', deliveryPr: PR }, projects: { '/p': { deliveryMerge: MERGE } } })
      expect(resolvePrompt(s.prompts, 'review', null).origin).toBe('défaut')
      expect(logs).toHaveLength(1)
      expect(logs[0]).toMatch(/^réglages : consigne « Revue du diff » globale invalide/)
      await st.update({ prompts: { global: { issue: 'Traite {issue}.' } } })
      const raw = JSON.parse(await fs.readFile(path.join(dir, 'settings.json'), 'utf8'))
      expect(raw.delivery).toEqual({ notifyCiFailure: true, projects: { '/p': { mode: 'trunk' } } })
      const again = await new SettingsStore(dir).load()
      // Le texte invalide survit à l'enregistrement (visible dans les réglages, jamais utilisé).
      expect(again.prompts).toEqual({ global: { review: '{x}', deliveryPr: PR, issue: 'Traite {issue}.' }, projects: { '/p': { deliveryMerge: MERGE } } })
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe('validation IPC : consigne de `sessions.sendReview`', () => {
  const comments = [{ path: 'a.rs', line: 1, side: 'new', text: 'x' }]
  it('facultative ; une ligne, 2 000 caractères au plus', () => {
    expect(validateParams('sessions.sendReview', { id: ID, comments }).instruction).toBeUndefined()
    expect(validateParams('sessions.sendReview', { id: ID, comments, instruction: 'Applique :' }).instruction).toBe('Applique :')
    for (const bad of ['', 'a\nb', 'a\u001bb', 'x'.repeat(2001), 3]) {
      expect(() => validateParams('sessions.sendReview', { id: ID, comments, instruction: bad }), String(bad)).toThrow(ValidationError)
    }
  })
})

describe('longueur au pire cas', () => {
  it('un modèle accepté se rend toujours en une consigne tapée, même avec des branches de 100 caractères', () => {
    const tpl = `${'x'.repeat(1100)}${' {branche}'.repeat(9)}`
    expect(promptProblem('review', tpl)).toMatch(/trop longue une fois les variables remplacées/)
    const ok = `${'x'.repeat(1400)} {branche} {base}`
    expect(promptProblem('deliveryPr', ok)).toBeNull()
    expect([...renderPrompt('deliveryPr', ok, { branch: 'b'.repeat(500), base: 'c'.repeat(500) })].length).toBeLessThanOrEqual(MAX_PROMPT_CHARS)
  })
})

describe('corrections après critique', () => {
  it('liste des invisibles identique à `invisible()` du démon ; sélecteurs de variante refusés', () => {
    const src = readFileSync(path.join(REPO, 'crates/core/src/domain/forge.rs'), 'utf8')
    const body = /pub fn invisible\(c: char\) -> bool \{([\s\S]*?)\n\}/.exec(src)![1]!
    const rust = [...body.matchAll(/'\\u\{([0-9A-Fa-f]+)\}'(?:\.\.='\\u\{([0-9A-Fa-f]+)\}')?/g)].map((m) => [
      parseInt(m[1]!, 16),
      parseInt(m[2] ?? m[1]!, 16),
    ])
    expect(rust.length).toBeGreaterThan(5)
    expect(rust).toEqual(INVISIBLE_RANGES.map(([a, b]) => [a, b]))
    for (const c of ['\uFE0F', '\uFE00', '\u{E0100}', '\u{E01EF}', '\u00AD', '\u180E', '\u206F']) {
      expect(promptProblem('deliveryPr', `Livre${c} {branche}`), c.codePointAt(0)!.toString(16)).toMatch(/invisible/)
      expect(isInvisible(c)).toBe(true)
    }
    expect(promptProblem('deliveryPr', 'Livre \u{E01F0} {branche}')).toBeNull()
  })

  it('pas de « # », « / », « ! » ni {issue} en tête (la TUI les interpréterait)', () => {
    for (const t of ['# Traite {issue}', ' /compact', '!rm -rf', '{issue} à traiter']) expect(promptProblem('issue', t), t).toMatch(/commencer par/)
    expect(promptProblem('issue', 'Traite {issue} #urgent')).toBeNull()
  })

  it('chaîne immense refusée sans être découpée ; relue du disque : retirée au-delà de la borne', () => {
    expect(promptProblem('review', 'x'.repeat(1_000_000))).toMatch(/trop long/)
    const big = readSettings(JSON.parse(JSON.stringify({ prompts: { global: { review: 'x'.repeat(1501), issue: 'y'.repeat(MAX_STORED_TEMPLATE + 1) } } })))
    // 1 501 caractères : gardé (montré pour correction) mais non utilisé ; au-delà de la borne : retiré.
    expect(big.settings.prompts.global).toEqual({ review: 'x'.repeat(1501) })
    expect(resolvePrompt(big.settings.prompts, 'review', null).origin).toBe('défaut')
    expect(big.warnings.join('\n')).toMatch(/trop longue : retirée/)
  })

  it('`__proto__` et `constructor` d’un vrai JSON relu : ignorés, sans pollution', () => {
    const raw = JSON.parse(
      '{"prompts":{"__proto__":{"global":{"review":"P"}},"global":{"__proto__":"x","constructor":"y","review":"Revue :"},"projects":{"__proto__":{"review":"Q"},"constructor":{"review":"R"},"/p":{"__proto__":{"issue":"Z"},"issue":"Traite {issue}."}}}}',
    )
    const { settings, warnings } = readSettings(raw)
    expect(settings.prompts).toEqual({ global: { review: 'Revue :' }, projects: { '/p': { issue: 'Traite {issue}.' } } })
    expect(Object.getPrototypeOf(settings.prompts.global)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>).review).toBeUndefined()
    expect(resolvePrompt(settings.prompts, 'review', '__proto__')).toEqual({ template: 'Revue :', origin: 'global' })
    expect(resolvePrompt(settings.prompts, 'review', 'constructor').origin).toBe('global')
    expect(warnings.join('\n')).toMatch(/inconnue globale : « __proto__ »/)
  })
})
