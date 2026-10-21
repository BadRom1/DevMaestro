/**
 * Lot 20 : cœur des langues (choix de la langue, repli, pluriels, formats)
 * et alignement des catalogues français et anglais.
 */
import { afterEach, describe, expect, it } from 'vitest'

import {
  CATALOGS,
  NAMESPACES,
  collator,
  dateFormat,
  formatList,
  getLocale,
  interpolate,
  numberFormat,
  resolveLocale,
  setLocale,
  splitVariables,
  supportedLocale,
  t,
  translate,
  variablesOf,
  type Message,
  type Vars,
} from '../src/shared/i18n'
import { describeError, daemonText } from '../src/renderer/src/state/errors'
import { formatReset, formatUsd, modeLabel, relativeTime, shortAgo, COLOR_LABELS } from '../src/renderer/src/state/format'
import { glyphFor } from '../src/renderer/src/state/status'
import { ErrorCode } from '../src/shared/protocol'
import { defaultSettings, normalizeSettings, validatePatch } from '../src/shared/settings'

afterEach(() => setLocale('fr'))

describe('catalogues', () => {
  const kind = (m: Message) => (typeof m === 'string' ? 'texte' : 'pluriel')

  it('mêmes clés en français et en anglais, domaine par domaine', () => {
    for (const [ns, m] of Object.entries(NAMESPACES)) {
      expect(Object.keys(m.en).sort(), ns).toEqual(Object.keys(m.fr).sort())
      for (const k of Object.keys(m.fr)) expect(k.startsWith(`${ns}.`), `${k} hors du domaine ${ns}`).toBe(true)
    }
    const total = Object.values(NAMESPACES).reduce((n, m) => n + Object.keys(m.fr).length, 0)
    expect(Object.keys(CATALOGS.fr)).toHaveLength(total)
    expect(Object.keys(CATALOGS.en).sort()).toEqual(Object.keys(CATALOGS.fr).sort())
  })

  it('mêmes variables, même forme (texte ou pluriel), aucun texte vide', () => {
    const problems: string[] = []
    for (const [k, fr] of Object.entries(CATALOGS.fr)) {
      const en = (CATALOGS.en as Record<string, Message>)[k]!
      if (kind(fr) !== kind(en)) problems.push(`${k} : ${kind(fr)} en français, ${kind(en)} en anglais`)
      const vf = variablesOf(fr).sort()
      const ve = variablesOf(en).sort()
      if (vf.join() !== ve.join()) problems.push(`${k} : {${vf.join('}, {')}} ≠ {${ve.join('}, {')}}`)
      for (const [l, m] of [['fr', fr], ['en', en]] as const) {
        const texts = typeof m === 'string' ? [m] : [m.one, m.other]
        if (texts.some((x) => x.trim() === '')) problems.push(`${k} (${l}) : texte vide`)
      }
    }
    expect(problems).toEqual([])
  })
})

describe('langue effective', () => {
  it('choix explicite, sinon première langue du système prise en charge, sinon français', () => {
    expect(resolveLocale('en', ['fr-FR'])).toBe('en')
    expect(resolveLocale('fr', ['en-US'])).toBe('fr')
    expect(resolveLocale('system', ['en-GB', 'fr-FR'])).toBe('en')
    expect(resolveLocale('system', ['de-DE', 'fr-CA', 'en-US'])).toBe('fr')
    expect(resolveLocale('system', ['de-DE', 'ja'])).toBe('fr')
    expect(resolveLocale('system', [])).toBe('fr')
    expect(resolveLocale(undefined, null)).toBe('fr')
    expect(resolveLocale('xx', ['en_US.UTF-8'])).toBe('en')
    expect(supportedLocale('EN-us')).toBe('en')
    expect(supportedLocale(42)).toBeNull()
  })

  it('réglage ui.language : « system » par défaut, valeur illisible relue comme « system », patch strict', () => {
    expect(defaultSettings().ui.language).toBe('system')
    expect(normalizeSettings({ ui: { language: 'en' } }).ui.language).toBe('en')
    expect(normalizeSettings({ ui: { language: 'de' } }).ui.language).toBe('system')
    expect(validatePatch({ ui: { language: 'fr' } })).toEqual({ ui: { language: 'fr' } })
    expect(() => validatePatch({ ui: { language: 'de' } })).toThrow(/ui\.language/)
  })
})

describe('textes', () => {
  it('français au départ, langue courante changée à chaud', () => {
    expect(getLocale()).toBe('fr')
    expect(t('common.status.idle')).toBe('Inactive')
    setLocale('en')
    expect(t('common.status.idle')).toBe('Idle')
    expect(glyphFor({ state: 'stopped' } as never).label).toBe('Stopped')
  })

  it('variables typées par clé : manquante, en trop ou inconnue refusée à la compilation (pnpm typecheck)', () => {
    expect(t('format.minutesAgo', { n: 3 })).toBe('il y a 3 min')
    // @ts-expect-error variable manquante
    expect(t('format.minutesAgo')).toBe('il y a {n} min')
    // @ts-expect-error variable inconnue
    t('format.minutesAgo', { m: 3 })
    // @ts-expect-error texte sans variable
    t('common.status.idle', { n: 1 })
    // Pluriel : `count` attendu.
    expect(typeof t).toBe('function')
  })

  it('interpolation : variable absente laissée telle quelle, nombres insérés bruts', () => {
    expect(interpolate('{a} et {b}', { a: 1234 })).toBe('1234 et {b}')
    expect(splitVariables('a {x} b')).toEqual([{ text: 'a ' }, { name: 'x' }, { text: ' b' }])
  })

  it('pluriels selon la langue (français : 0 et 1 au singulier)', () => {
    // Clé ajoutée pour le test : hors du typage des clés.
    const tr = translate as unknown as (l: 'fr' | 'en', k: string, v?: Vars) => string
    const m = { one: '{count} fichier', other: '{count} fichiers' }
    const cat = CATALOGS.fr as Record<string, Message>
    cat['common.__test'] = m
    try {
      expect(tr('fr', 'common.__test', { count: 0 })).toBe('0 fichier')
      expect(tr('fr', 'common.__test', { count: 1 })).toBe('1 fichier')
      expect(tr('fr', 'common.__test', { count: 2 })).toBe('2 fichiers')
      // Repli sur le français pour une clé absente en anglais ; anglais : 0 au pluriel.
      expect(tr('en', 'common.__test', { count: 0 })).toBe('0 fichiers')
      ;(CATALOGS.en as Record<string, Message>)['common.__test'] = { one: '{count} file', other: '{count} files' }
      expect(tr('en', 'common.__test', { count: 0 })).toBe('0 files')
      expect(tr('en', 'common.__test', { count: 1 })).toBe('1 file')
      expect(tr('fr', 'common.__test', { count: 1_000_000 })).toBe('1000000 fichiers')
    } finally {
      delete cat['common.__test']
      delete (CATALOGS.en as Record<string, Message>)['common.__test']
    }
  })

  it('nombres et dates selon la langue', () => {
    expect(numberFormat(undefined, 'fr').format(1234.5)).toBe('1\u202f234,5')
    expect(numberFormat(undefined, 'en').format(1234.5)).toBe('1,234.5')
    const d = new Date(2026, 9, 21, 14, 5)
    expect(dateFormat({ hour: '2-digit', minute: '2-digit' }, 'fr').format(d)).toBe('14:05')
    expect(dateFormat({ hour: '2-digit', minute: '2-digit' }, 'en').format(d)).toBe('02:05 PM')
    expect(formatList(['a', 'b', 'c'], 'fr')).toBe('a, b et c')
    expect(formatList(['a', 'b', 'c'], 'en')).toBe('a, b, and c')
    expect(['b10', 'B2', 'a'].sort(collator('fr').compare)).toEqual(['a', 'B2', 'b10'])
  })

  it('formats de l’interface : français inchangé, anglais à chaud', () => {
    const now = Date.parse('2026-10-21T12:00:00Z')
    expect(relativeTime('2026-10-21T11:55:00Z', now)).toBe('il y a 5 min')
    expect(shortAgo('2026-10-21T11:55:00Z', now)).toBe('5 min')
    expect(formatUsd(1.5)).toBe('1,50 $')
    expect(modeLabel('acceptEdits')).toBe('Accepter les modifs')
    expect(COLOR_LABELS.bleu).toBe('Bleu')
    setLocale('en')
    expect(relativeTime('2026-10-21T11:55:00Z', now)).toBe('5 min ago')
    expect(relativeTime('2026-10-20T11:55:00Z', now)).toBe('yesterday')
    expect(shortAgo('2026-10-21T11:55:00Z', now)).toBe('5 min')
    expect(formatUsd(1.5)).toBe('$1.50')
    expect(modeLabel('acceptEdits')).toBe('Accept edits')
    expect(COLOR_LABELS.bleu).toBe('Blue')
    expect(Object.keys(COLOR_LABELS)).toContain('rose')
    const reset = new Date(now + 3_600_000)
    expect(formatReset(reset.toISOString(), now)).toMatch(/^\d\d:\d\d (AM|PM)$/)
  })
})

describe('erreurs du démon', () => {
  it('français : comme avant (explication, détail du démon entre parenthèses)', () => {
    expect(describeError(ErrorCode.InvalidState, 'la session ne tourne pas')).toBe(
      'action impossible dans l’état actuel de la session (la session ne tourne pas)',
    )
    expect(describeError(-32016, 'Le dossier de la session n’existe plus (worktree supprimé ?) : /tmp/x')).toBe(
      'Le dossier de la session n’existe plus (worktree supprimé ?) : /tmp/x',
    )
    expect(describeError(-32602, 'base inconnue : « main »')).toBe('base inconnue : « main »')
    expect(describeError(ErrorCode.Disconnected, 'socket fermé')).toBe('démon non connecté')
  })

  it('anglais : traduit par le code, détail du démon marqué « en français »', () => {
    setLocale('en')
    expect(describeError(ErrorCode.InvalidState, 'la session ne tourne pas')).toBe(
      'action not possible in the session’s current state (orchd, in French: la session ne tourne pas)',
    )
    expect(describeError(ErrorCode.WorktreeBusy, '')).toBe('a session is running in this worktree: stop it first')
    expect(describeError(-32016, 'Le dossier de la session n’existe plus (worktree supprimé ?) : /tmp/x')).toBe(
      'the session folder no longer exists (worktree deleted?): /tmp/x',
    )
    // -32015, -32016 sans chemin : la phrase française du démon n'apporte rien de plus.
    expect(describeError(-32016, 'Le dossier de la session n’existe plus (worktree supprimé ?)')).toBe(
      'the session folder no longer exists (worktree deleted?)',
    )
    expect(describeError(-32015, 'Claude Code n’a pas de transcript pour cette session.')).toBe(
      'Claude Code has no transcript for this session: it cannot be resumed (remove it from the list)',
    )
    expect(describeError(ErrorCode.Timeout, 'délai de 10 s dépassé')).toBe('the daemon did not answer in time')
    // Code sans traduction : message du démon en repli, marqué.
    expect(describeError(-32602, 'base inconnue : « main »')).toBe('orchd message (in French): base inconnue : « main »')
    // Erreur produite par l'app : jamais marquée.
    expect(describeError(-32602, 'parameters refused by the app', { origin: 'app' })).toBe('parameters refused by the app')
    expect(daemonText('  la branche existe déjà ')).toBe('orchd message (in French): la branche existe déjà')
    setLocale('fr')
    expect(daemonText('la branche existe déjà')).toBe('la branche existe déjà')
  })
})
