/**
 * Slash commands (lot 17), logique pure : requête, filtre et classement,
 * complétion, touches, relecture de la réponse du démon, copie de la liste
 * intégrée, capacités du `hello`, validation IPC.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { helloCapabilities } from '../src/main/daemon/client'
import { ValidationError, validateParams } from '../src/main/validate'
import { RENDERER_METHODS, type SlashCommand } from '../src/shared/protocol'
import builtinJson from '../src/shared/builtinCommands.json'
import { setLocale } from '../src/shared/i18n'
import { BUILTIN_COMMANDS_EN } from '../src/shared/i18n/catalog/conversation'
import {
  BUILTIN_COMMANDS,
  BUILTIN_VERSION,
  commandTexts,
  completeCommand,
  conflictLabel,
  listNote,
  isExactCommand,
  normalizeCommands,
  popupKey,
  rankCommands,
  slashQuery,
  sourceLabel,
  suggestionsLabel,
} from '../src/renderer/src/state/slashCommands'

const ID = '0c69fdc4-b2c9-4511-97c8-bb78d2323d61'

const cmd = (name: string, source: SlashCommand['source'], extra: Partial<SlashCommand> = {}): SlashCommand => ({
  name,
  source,
  kind: 'command',
  ...extra,
})

describe('liste intégrée', () => {
  it('est la copie exacte de celle du démon', () => {
    const crate = readFileSync(fileURLToPath(new URL('../../crates/core/src/domain/builtin_commands.json', import.meta.url)), 'utf8')
    expect(JSON.parse(crate)).toEqual(builtinJson)
  })

  it('porte la version de référence, des noms uniques et les commandes interactives', () => {
    expect(BUILTIN_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
    const names = BUILTIN_COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])])
    expect(new Set(names).size).toBe(names.length)
    expect(BUILTIN_COMMANDS.every((c) => c.source === 'builtin' && !!c.description)).toBe(true)
    expect(BUILTIN_COMMANDS.find((c) => c.name === 'model')?.interactive).toBe(true)
    expect(BUILTIN_COMMANDS.find((c) => c.name === 'config')?.interactive).toBe(true)
    expect(BUILTIN_COMMANDS.find((c) => c.name === 'permissions')?.interactive).toBe(true)
    expect(BUILTIN_COMMANDS.find((c) => c.name === 'compact')?.interactive).toBeUndefined()
    expect(BUILTIN_COMMANDS.find((c) => c.name === 'debug')?.kind).toBe('skill')
  })
})

describe('requête', () => {
  it('seulement en tête du champ, curseur dans le premier mot', () => {
    expect(slashQuery('/comp', 5)).toEqual({ query: 'comp', end: 5 })
    expect(slashQuery('/', 1)).toEqual({ query: '', end: 1 })
    expect(slashQuery('/review 42', 4)).toEqual({ query: 'review', end: 7 })
    expect(slashQuery('/review 42', 8)).toBeNull()
    expect(slashQuery('/review 42', 0)).toBeNull()
    expect(slashQuery('texte /compact', 14)).toBeNull()
    expect(slashQuery(' /compact', 9)).toBeNull()
    expect(slashQuery('/a\nb', 2)).toEqual({ query: 'a', end: 2 })
    expect(slashQuery('/a\nb', 4)).toBeNull()
    expect(slashQuery('/plan', null)).toEqual({ query: 'plan', end: 5 })
  })
})

describe('filtre et classement', () => {
  const list = [
    cmd('compact', 'builtin'),
    cmd('config', 'builtin'),
    cmd('clear', 'builtin', { aliases: ['reset', 'new'] }),
    cmd('front:test', 'user'),
    cmd('test', 'plugin', { plugin: 'p' }),
    cmd('contest', 'project'),
    cmd('forge:grill', 'plugin', { plugin: 'forge', kind: 'skill' }),
    cmd('Revue', 'user'),
    cmd('compact', 'user', { conflict: 'builtin' }),
  ]
  const names = (q: string) => rankCommands(list, q).map((c) => `${c.name}/${c.source}`)

  it('exact, préfixe, segment, alias, sous-chaîne ; sans casse ; rien de masqué', () => {
    expect(names('test')).toEqual(['test/plugin', 'front:test/user', 'contest/project'])
    // La reprise marquée d'une intégrée est gardée, après l'originale.
    expect(names('compact')).toEqual(['compact/builtin', 'compact/user'])
    expect(names('co')).toEqual(['compact/builtin', 'config/builtin', 'contest/project', 'compact/user'])
    expect(names('RESET')).toEqual(['clear/builtin'])
    expect(names('re')).toEqual(['Revue/user', 'clear/builtin'])
    expect(names('grill')).toEqual(['forge:grill/plugin'])
    expect(names('zzz')).toEqual([])
  })

  it('requête vide : tout, par source (intégrée, projet, utilisateur, plugin) puis nom, reprises à la fin ; bornée', () => {
    expect(names('')).toEqual([
      'clear/builtin',
      'compact/builtin',
      'config/builtin',
      'contest/project',
      'Revue/user',
      'front:test/user',
      'forge:grill/plugin',
      'test/plugin',
      'compact/user',
    ])
    const many = Array.from({ length: 80 }, (_, i) => cmd(`c${i}`, 'user'))
    expect(rankCommands(many, '')).toHaveLength(50)
  })
})

describe('complétion', () => {
  it('ajoute un espace si la commande attend des arguments, garde la suite', () => {
    const q = slashQuery('/rev', 4)!
    expect(completeCommand('/rev', q, cmd('review', 'user', { argument_hint: '[n]' }))).toEqual({ value: '/review ', caret: 8 })
    expect(completeCommand('/co', slashQuery('/co', 3)!, cmd('compact', 'builtin'))).toEqual({ value: '/compact', caret: 8 })
    const q2 = slashQuery('/rev 42', 2)!
    expect(completeCommand('/rev 42', q2, cmd('review', 'user'))).toEqual({ value: '/review 42', caret: 8 })
    expect(isExactCommand(slashQuery('/compact', 8)!, cmd('compact', 'builtin'))).toBe(true)
    expect(isExactCommand(slashQuery('/comp', 5)!, cmd('compact', 'builtin'))).toBe(false)
    // Un alias exact vaut le nom : Entrée envoie.
    expect(isExactCommand(slashQuery('/reset', 6)!, cmd('clear', 'builtin', { aliases: ['reset', 'new'] }))).toBe(true)
  })
})

describe('touches de la liste', () => {
  it('↑ / ↓ en boucle, Tab et Entrée complètent, Entrée envoie si exact, Échap ferme', () => {
    expect(popupKey({ key: 'ArrowDown' }, 3, 2, false)).toEqual({ type: 'move', index: 0 })
    expect(popupKey({ key: 'ArrowUp' }, 3, 0, false)).toEqual({ type: 'move', index: 2 })
    expect(popupKey({ key: 'Tab' }, 3, 0, true)).toEqual({ type: 'complete' })
    expect(popupKey({ key: 'Enter' }, 3, 0, false)).toEqual({ type: 'complete' })
    expect(popupKey({ key: 'Enter' }, 3, 0, true)).toEqual({ type: 'send' })
    expect(popupKey({ key: 'Escape' }, 3, 0, false)).toEqual({ type: 'close' })
    expect(popupKey({ key: 'Enter', shiftKey: true }, 3, 0, false)).toBeNull()
    expect(popupKey({ key: 'Tab', shiftKey: true }, 3, 0, false)).toBeNull()
    expect(popupKey({ key: 'ArrowDown', ctrlKey: true }, 3, 0, false)).toBeNull()
    expect(popupKey({ key: 'a' }, 3, 0, false)).toBeNull()
    expect(popupKey({ key: 'ArrowDown' }, 0, 0, false)).toBeNull()
  })
})

describe('réponse du démon', () => {
  it('garde les entrées valides, borne les champs', () => {
    const got = normalizeCommands({
      commands: [
        { name: 'ok', source: 'user', kind: 'skill', description: 'd'.repeat(600), argument_hint: '[x]', interactive: true, plugin: 'p', aliases: ['a', 'b c', 3], conflict: 'builtin' },
        { name: 'z', source: 'project', conflict: 'autre' },
        { name: 'a b', source: 'user' },
        { name: 'x', source: 'ailleurs' },
        { name: 'y', source: 'project', kind: 'autre', description: 7 },
        'pas un objet',
      ],
    })
    expect(got).toEqual([
      { name: 'ok', source: 'user', kind: 'skill', description: 'd'.repeat(512), argument_hint: '[x]', aliases: ['a'], interactive: true, plugin: 'p', conflict: 'builtin' },
      { name: 'z', source: 'project', kind: 'command' },
      { name: 'y', source: 'project', kind: 'command' },
    ])
    expect(normalizeCommands({})).toBeNull()
    expect(normalizeCommands(null)).toBeNull()
  })

  it('libellés', () => {
    expect(sourceLabel(cmd('a', 'builtin'))).toBe('intégrée')
    expect(sourceLabel(cmd('a', 'project'))).toBe('projet')
    expect(sourceLabel(cmd('a', 'user', { kind: 'skill' }))).toBe('utilisateur, skill')
    expect(sourceLabel(cmd('f:a', 'plugin', { plugin: 'forge' }))).toBe('plugin forge')
    expect(conflictLabel(cmd('compact', 'project', { conflict: 'builtin' }))).toBe('même nom qu’une commande intégrée')
    expect(conflictLabel(cmd('f:a', 'user', { conflict: 'plugin' }))).toBe('même nom qu’une commande de plugin')
    expect(conflictLabel(cmd('a', 'user'))).toBeNull()
    expect(listNote(false, 0)).toBeNull()
    expect(listNote(true, 0)).toMatch(/^Liste incomplète/)
    expect(listNote(false, 1)).toMatch(/^1 fichier ignoré/)
    expect(listNote(true, 3)).toMatch(/certains n’ont pas été lus\. 3 fichiers ignorés/)
    expect(suggestionsLabel(0)).toBe('Aucune commande ne correspond.')
    expect(suggestionsLabel(1)).toBe('1 commande proposée.')
    expect(suggestionsLabel(4)).toBe('4 commandes proposées.')
  })
})

describe('capacités et validation IPC', () => {
  it('capacités du hello : booléens sous des noms sûrs', () => {
    expect(helloCapabilities({ slash_commands: true, runners: false, x: 'oui', 'a-b': true })).toEqual({ slash_commands: true, runners: false })
    expect(helloCapabilities(undefined)).toBeUndefined()
    expect(helloCapabilities([true])).toBeUndefined()
  })

  it('commands.list : identifiant de session seulement', () => {
    expect(RENDERER_METHODS).toContain('commands.list')
    expect(validateParams('commands.list', { id: ID, extra: 1 })).toEqual({ id: ID })
    expect(() => validateParams('commands.list', {})).toThrow(ValidationError)
    expect(() => validateParams('commands.list', { id: '../x' })).toThrow(ValidationError)
  })
})

describe('descriptions anglaises des commandes intégrées (lot 20)', () => {
  afterEach(() => setLocale('fr'))

  it('une par commande intégrée, et seulement pour elles', () => {
    const names = BUILTIN_COMMANDS.map((c) => c.name)
    expect(Object.keys(BUILTIN_COMMANDS_EN).sort()).toEqual([...names].sort())
    for (const c of BUILTIN_COMMANDS) expect(BUILTIN_COMMANDS_EN[c.name]!.description.trim()).not.toBe('')
  })

  it('choisies selon la langue, jamais pour les commandes du disque', () => {
    const compact = BUILTIN_COMMANDS.find((c) => c.name === 'compact')!
    const user = cmd('compact', 'user', { description: 'Ma commande', argument_hint: '[x]' })
    expect(commandTexts(compact)).toEqual({ description: compact.description, argument_hint: compact.argument_hint })
    setLocale('en')
    expect(commandTexts(compact)).toEqual({
      description: 'Free up context by summarizing the conversation',
      argument_hint: '[summary instructions]',
    })
    expect(commandTexts(user)).toEqual({ description: 'Ma commande', argument_hint: '[x]' })
    expect(sourceLabel(compact)).toBe('built-in')
  })
})
