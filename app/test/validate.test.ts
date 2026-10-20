import { describe, expect, it } from 'vitest'

import { ValidationError, validateExternalUrl, validateParams, validateView } from '../src/main/validate'
import { describeError } from '../src/renderer/src/state/errors'

const ID = '0c69fdc4-b2c9-4511-97c8-bb78d2323d61'

describe('validation des paramètres de la page', () => {
  it('nettoie et retire les champs inconnus', () => {
    expect(validateParams('sessions.stop', { id: ID, extra: 1 })).toEqual({ id: ID })
    expect(validateParams('sessions.list', { n: 1 })).toEqual({})
    expect(validateParams('sessions.launch', { cwd: '/p', mode: 'plan', cols: 80, rows: 24, prompt: 'x', truc: 1 })).toEqual({
      cwd: '/p',
      mode: 'plan',
      cols: 80,
      rows: 24,
      prompt: 'x',
    })
  })

  it('refuse identifiants, tailles et énumérations invalides', () => {
    const bad: [Parameters<typeof validateParams>[0], unknown][] = [
      ['sessions.stop', { id: 'pas-un-uuid' }],
      ['sessions.stop', { id: 3 }],
      ['sessions.resize', { id: ID, cols: Number.NaN, rows: 10 }],
      ['sessions.resize', { id: ID, cols: 1001, rows: 10 }],
      ['sessions.resize', { id: ID, cols: 0, rows: 10 }],
      ['sessions.resize', { id: ID, cols: 10.5, rows: 10 }],
      ['sessions.launch', { cwd: 'relatif' }],
      ['sessions.launch', { cwd: '/p', cols: 80 }],
      ['sessions.launch', { cwd: '/p', mode: 'yolo' }],
      ['sessions.launch', { cwd: '/p', prompt: 'x'.repeat(100_001) }],
      ['sessions.setMode', { id: ID, mode: 'bypassPermissions' }],
      ['sessions.answerPermission', { id: ID, request_id: 1.5, decision: 'allow' }],
      ['sessions.answerPermission', { id: ID, request_id: 1, decision: 'oui' }],
      ['sessions.answerQuestion', { id: ID, request_id: 1, answers: { q: 3 } }],
      ['sessions.answerQuestion', { id: ID, request_id: 1, answers: [] }],
      ['sessions.answerQuestion', { id: ID, request_id: 1, answers: {} }],
      ['sessions.resume', { claude_session_id: '../x' }],
      ['transcripts.list', { limit: -1 }],
      ['sessions.get', 'texte'],
    ]
    for (const [m, p] of bad) expect(() => validateParams(m, p), `${m} ${JSON.stringify(p)}`).toThrow(ValidationError)
  })

  it('accepte réponses texte et listes, modes dangereux au lancement (le démon tranche)', () => {
    expect(
      validateParams('sessions.answerQuestion', { id: ID, request_id: 2, answers: { 'A ?': 'oui', 'B ?': ['x', 'y'] } }),
    ).toEqual({ id: ID, request_id: 2, answers: { 'A ?': 'oui', 'B ?': ['x', 'y'] } })
    expect(validateParams('sessions.launch', { cwd: '/p', mode: 'bypassPermissions' }).mode).toBe('bypassPermissions')
    expect(validateParams('sessions.resume', { claude_session_id: ID, cwd: '/p', profile: 'work' })).toEqual({
      claude_session_id: ID,
      cwd: '/p',
      profile: 'work',
    })
  })

  it('sessions.update : titre et couleur, null pour effacer', () => {
    expect(validateParams('sessions.update', { id: ID, title: 'Refonte', extra: 1 })).toEqual({ id: ID, title: 'Refonte' })
    expect(validateParams('sessions.update', { id: ID, title: null })).toEqual({ id: ID, title: null })
    expect(validateParams('sessions.update', { id: ID, color: 'violet' })).toEqual({ id: ID, color: 'violet' })
    expect(validateParams('sessions.update', { id: ID, title: null, color: null })).toEqual({ id: ID, title: null, color: null })
    expect(validateParams('sessions.update', { id: ID, title: 'é'.repeat(80) }).title).toHaveLength(80)
    // 80 émojis : 160 unités UTF-16 mais 80 caractères.
    expect(validateParams('sessions.update', { id: ID, title: '😀'.repeat(80) }).title).toBe('😀'.repeat(80))
    const bad: unknown[] = [
      { id: ID },
      { id: ID, title: undefined },
      { id: ID, title: 'x'.repeat(81) },
      { id: ID, title: '😀'.repeat(81) },
      { id: ID, title: 3 },
      { id: ID, color: 'fuchsia' },
      { id: ID, color: 1 },
      { id: 'x', title: 'a' },
    ]
    for (const p of bad) expect(() => validateParams('sessions.update', p), JSON.stringify(p)).toThrow(ValidationError)
  })

  it('sessions.forget : identifiant seul', () => {
    expect(validateParams('sessions.forget', { id: ID, extra: true })).toEqual({ id: ID })
    expect(() => validateParams('sessions.forget', { id: 'x' })).toThrow(ValidationError)
  })

  it('transcripts.hide / unhide / list (include_hidden)', () => {
    for (const m of ['transcripts.hide', 'transcripts.unhide'] as const) {
      expect(validateParams(m, { profile: 'work', claude_session_id: ID, x: 1 })).toEqual({ profile: 'work', claude_session_id: ID })
      expect(() => validateParams(m, { claude_session_id: ID })).toThrow(ValidationError)
      expect(() => validateParams(m, { profile: 'work', claude_session_id: '../x' })).toThrow(ValidationError)
    }
    expect(validateParams('transcripts.list', { profile: 'p', limit: 100, include_hidden: true })).toEqual({
      profile: 'p',
      limit: 100,
      include_hidden: true,
    })
    expect(() => validateParams('transcripts.list', { include_hidden: 'oui' })).toThrow(ValidationError)
  })

  it('quotas.get : refresh booléen facultatif', () => {
    expect(validateParams('quotas.get', {})).toEqual({})
    expect(validateParams('quotas.get', { refresh: true, x: 1 })).toEqual({ refresh: true })
    expect(() => validateParams('quotas.get', { refresh: 1 })).toThrow(ValidationError)
  })

  it('view : UUID ou null, taille bornée', () => {
    expect(validateView({ id: null })).toEqual({ id: null })
    expect(validateView({ id: ID, cols: 80, rows: 24 })).toEqual({ id: ID, cols: 80, rows: 24 })
    expect(() => validateView({ id: 'x' })).toThrow(ValidationError)
    expect(() => validateView({})).toThrow(ValidationError)
    expect(() => validateView({ id: ID, cols: Number.NaN, rows: 3 })).toThrow(ValidationError)
  })

  it('liens externes : http et https seulement', () => {
    expect(validateExternalUrl('https://exemple.fr/a?b=1')).toBe('https://exemple.fr/a?b=1')
    for (const u of ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://x', 'pas un lien', 42]) {
      expect(() => validateExternalUrl(u)).toThrow(ValidationError)
    }
  })
})

describe('messages d’erreur du démon', () => {
  it('codes du lot 3 en français, avec le détail du démon', () => {
    expect(describeError(-32005, 'mode refusé')).toMatch(/^mode dangereux refusé .*\(mode refusé\)$/)
    expect(describeError(-32010, '')).toBe('demande déjà close (répondue dans le terminal, ou tour terminé)')
    expect(describeError(-32013, 'x')).toMatch(/^« Toujours » impossible/)
    expect(describeError(-32014, 'x')).toMatch(/^changement de mode impossible/)
    expect(describeError(-32012, 'x')).toMatch(/réponds dans le terminal/)
    expect(describeError(-32011, 'x')).toMatch(/mauvais type/)
    expect(describeError(-32602, 'paramètres invalides')).toBe('paramètres invalides')
    expect(describeError(-32015, '')).toMatch(/^Claude Code n’a pas de transcript pour cette session/)
    expect(describeError(-32015, 'Claude Code n’a pas de transcript pour cette session.')).toBe('Claude Code n’a pas de transcript pour cette session.')
    expect(describeError(-32016, 'Le dossier de la session n’existe plus (worktree supprimé ?) : /p/x')).toBe(
      'Le dossier de la session n’existe plus (worktree supprimé ?) : /p/x',
    )
    expect(describeError(-32016, '')).toBe('le dossier de la session n’existe plus (worktree supprimé ?)')
    expect(describeError(-32601, 'méthode inconnue')).toMatch(/^méthode inconnue du démon \(démon trop ancien/)
  })
})
