import { describe, expect, it } from 'vitest'

import { ValidationError, validateParams } from '../src/main/validate'
import type { FileEntry, PendingRequest } from '../src/shared/protocol'
import { SettingsError, applyPatch, defaultSettings, normalizeSettings, validatePatch } from '../src/shared/settings'
import { ancestorDirs, defaultFile, filterFiles, isMarkdown, mentionFor, parentOf, visibleRows } from '../src/renderer/src/state/fileTree'
import { columnOf, demandSummary, firstPending, kanbanColumns, oneClickAllowed, summaryFits } from '../src/renderer/src/state/kanban'
import { classifyLink, renderMarkdown, resolveRelative, slugify } from '../src/renderer/src/state/markdown'
import { session } from './fixtures'

const ID = '0c69fdc4-b2c9-4511-97c8-bb78d2323d61'
const e = (path: string, kind: FileEntry['kind'] = 'file', changed: FileEntry['changed'] = null): FileEntry => ({
  name: path.split('/').pop()!,
  path,
  kind,
  size: kind === 'dir' ? null : 10,
  changed,
})

describe('arborescence des fichiers', () => {
  const cache = {
    '': [e('docs', 'dir'), e('src', 'dir'), e('README.md'), e('go.mod', 'file', 'M')],
    src: [e('src/auth', 'dir'), e('src/main.go', 'file', 'A')],
    'src/auth': [e('src/auth/oauth.go', 'file', 'M')],
  }

  it('lignes visibles : dossiers ouverts seulement, profondeur, marques', () => {
    const rows = visibleRows(cache, new Set(['src']), ['src/auth/oauth.go', 'src/main.go', 'go.mod'])
    expect(rows.map((r) => `${'  '.repeat(r.depth)}${r.name}${r.kind === 'dir' ? (r.expanded ? '/▾' : '/▸') : ''}${r.changed ?? ''}${r.changedInside ? '•' : ''}${r.kind === 'dir' && !r.loaded ? '(?)' : ''}`)).toEqual([
      'docs/▸(?)',
      'src/▾•',
      '  auth/▸•',
      '  main.goA',
      'README.md',
      'go.modM',
    ])
    expect(visibleRows({}, new Set(), [])).toEqual([])
  })

  it('dossiers à ouvrir vers les fichiers modifiés', () => {
    expect(ancestorDirs(['src/auth/oauth.go', 'docs/a/b.md', 'go.mod'])).toEqual(['docs', 'src', 'docs/a', 'src/auth'])
    expect(parentOf('src/auth/oauth.go')).toBe('src/auth')
    expect(parentOf('go.mod')).toBe('')
  })

  it('filtre : dossiers chargés et fichiers modifiés, sans casse ni accents', () => {
    const r = filterFiles(cache, [{ path: 'docs/Écriture.md', status: '?' }], 'ecri')
    expect(r.map((x) => [x.path, x.changed])).toEqual([['docs/Écriture.md', '?']])
    expect(filterFiles(cache, [], 'O').map((x) => x.path)).toEqual(['go.mod', 'src/auth/oauth.go', 'src/main.go'])
    expect(filterFiles(cache, [], '  ')).toEqual([])
  })

  it('fichier par défaut et Markdown', () => {
    expect(defaultFile(cache[''])).toBe('README.md')
    expect(defaultFile([e('readme.markdown')])).toBe('readme.markdown')
    expect(defaultFile([e('main.go')])).toBeNull()
    expect(isMarkdown('a/B.MD')).toBe(true)
    expect(isMarkdown('a.txt')).toBe(false)
  })
})

describe('lecteur Markdown', () => {
  it('sommaire : titres 1 à 4, identifiants uniques et lisibles', () => {
    const r = renderMarkdown('# Démarrer\n\ntexte\n\n## Tests `go test`\n\n## Tests `go test`\n\n##### trop profond\n')
    expect(r.outline).toEqual([
      { level: 1, text: 'Démarrer', id: 'h-demarrer' },
      { level: 2, text: 'Tests go test', id: 'h-tests-go-test' },
      { level: 2, text: 'Tests go test', id: 'h-tests-go-test-1' },
    ])
    expect(r.html).toMatch(/<h1 data-source-start="\d+" data-source-end="\d+" id="h-demarrer">Démarrer<\/h1>/)
    expect(slugify('  ')).toBe('section')
  })

  it('aucun HTML brut, aucun lien javascript:, images remplacées par leur texte', () => {
    const r = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[clic](javascript:alert(1))\n\n![logo du projet](https://exemple.fr/logo.png)')
    expect(r.html).not.toMatch(/<script|<img|<[^>]*\sonerror=|href="javascript/i)
    expect(r.html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(r.html).toContain('&lt;script&gt;')
    expect(r.html).toContain('<span class="img-alt" title="https://exemple.fr/logo.png">[image : logo du projet]</span>')
  })

  it('liens : fichier .md relatif, http(s), ancre, le reste inerte', () => {
    expect(classifyLink('docs/architecture.md', 'README.md')).toEqual({ kind: 'file', path: 'docs/architecture.md', anchor: null })
    expect(classifyLink('../README.md#Démarrer', 'docs/architecture.md')).toEqual({ kind: 'file', path: 'README.md', anchor: 'h-demarrer' })
    expect(classifyLink('./adr/0001%20go.md', 'docs/a.md')).toEqual({ kind: 'file', path: 'docs/adr/0001 go.md', anchor: null })
    expect(classifyLink('https://exemple.fr/a?b=1', 'README.md')).toEqual({ kind: 'external', url: 'https://exemple.fr/a?b=1' })
    expect(classifyLink('#tests', 'README.md')).toEqual({ kind: 'anchor', id: 'h-tests' })
    for (const h of ['../../hors.md', '/etc/passwd.md', 'mailto:a@b.c', 'file:///x.md', 'src/main.go', 'javascript:alert(1)', '', '#', null]) {
      expect(classifyLink(h, 'docs/a.md'), String(h)).toEqual({ kind: 'inert' })
    }
    expect(resolveRelative('a/b/c.md', '../../d.md')).toBe('d.md')
    expect(resolveRelative('a.md', '../d.md')).toBeNull()
  })
})

const perm = (id: number, since: string, command = 'npm test'): PendingRequest => ({
  request_id: id,
  answerable: true,
  pending: { kind: 'permission', tool_name: 'Bash', tool_input: { command } },
  since,
})

describe('vue par statut', () => {
  it('colonnes : erreur et arrêtée ensemble ; démarrage avec « en cours »', () => {
    expect(columnOf(session({ status: { state: 'error' } }))).toBe('stopped')
    expect(columnOf(session({ status: { state: 'stopped' } }))).toBe('stopped')
    expect(columnOf(session({ status: { state: 'starting' } }))).toBe('running')
    expect(columnOf(session({ status: { state: 'idle' } }))).toBe('idle')
    expect(columnOf(session({ status: { state: 'waiting', wait: 'question' } }))).toBe('waiting')
  })

  it('tri : demande la plus ancienne d’abord, sinon activité la plus récente d’abord', () => {
    const w1 = session({ status: { state: 'waiting' }, pending: [perm(1, '2026-10-20T10:05:00Z')] })
    const w2 = session({ status: { state: 'waiting' }, pending: [perm(2, '2026-10-20T10:00:00Z'), perm(3, '2026-10-20T11:00:00Z')] })
    const r1 = session({ status: { state: 'running' }, last_activity: '2026-10-20T09:00:00Z' })
    const r2 = session({ status: { state: 'running' }, last_activity: '2026-10-20T12:00:00Z' })
    const s1 = session({ status: { state: 'error' }, last_activity: '2026-10-19T09:00:00Z' })
    const c = kanbanColumns([w1, r1, s1, w2, r2])
    expect(c.waiting.map((s) => s.id)).toEqual([w2.id, w1.id])
    expect(c.running.map((s) => s.id)).toEqual([r2.id, r1.id])
    expect(c.stopped.map((s) => s.id)).toEqual([s1.id])
    expect(c.idle).toEqual([])
    expect(firstPending(w2)?.request_id).toBe(2)
    expect(firstPending(r1)).toBeNull()
  })

  it('texte court des demandes', () => {
    expect(demandSummary(perm(1, '').pending)).toBe('Bash · npm test')
    expect(demandSummary(perm(1, '', 'x\n'.repeat(200)).pending, 20)).toHaveLength(20)
    expect(
      demandSummary({ kind: 'question', tool_name: 'AskUserQuestion', tool_input: {}, questions: [{ question: 'SQLite ?', options: [] }, { question: 'b', options: [] }] }),
    ).toBe('SQLite ? (+1)')
    expect(demandSummary({ kind: 'permission', detailed: false })).toBe('Permission (détails dans le terminal)')
  })

  it('vue retenue dans les réglages', () => {
    expect(defaultSettings().view).toBe('projet')
    expect(normalizeSettings({ view: 'statut' }).view).toBe('statut')
    expect(normalizeSettings({ view: 'kanban' }).view).toBe('projet')
    expect(applyPatch(defaultSettings(), validatePatch({ view: 'statut' })).view).toBe('statut')
    expect(() => validatePatch({ view: 'x' })).toThrow(SettingsError)
  })
})

describe('validation : fichiers et saisie', () => {
  it('files.list, files.read, sessions.input', () => {
    expect(validateParams('files.list', { id: ID })).toEqual({ id: ID })
    expect(validateParams('files.list', { id: ID, path: '' })).toEqual({ id: ID })
    expect(validateParams('files.list', { id: ID, path: 'src' })).toEqual({ id: ID, path: 'src' })
    expect(validateParams('files.read', { id: ID, path: 'README.md' })).toEqual({ id: ID, path: 'README.md' })
    expect(validateParams('sessions.input', { id: ID, data: '@README.md ' })).toEqual({ id: ID, data: '@README.md ' })
    for (const [m, p] of [
      ['files.read', { id: ID }],
      ['files.read', { id: ID, path: 'a\0b' }],
      ['files.list', { id: 'x' }],
      ['sessions.input', { id: ID, data: '' }],
    ] as const) {
      expect(() => validateParams(m, p)).toThrow(ValidationError)
    }
  })
})

describe('revue des lots 3 et 4', () => {
  it('mention : chemins simples seulement, refus en français sinon', () => {
    expect(mentionFor('docs/architecture.md')).toEqual({ ok: true, text: '@docs/architecture.md ' })
    for (const p of ['mon fichier.md', 'a@b.md', 'a\tb', 'a‮b.md', 'a​b', 'x\u0007']) {
      const r = mentionFor(p)
      expect(r.ok, p).toBe(false)
      expect(!r.ok && r.error).toMatch(/^(le chemin contient|le nom du fichier contient)/)
    }
    expect(mentionFor('').ok).toBe(false)
  })

  it('identifiants de titres toujours libres ; ancres mal encodées inertes', () => {
    const r = renderMarkdown('# A\n\n# A-1\n\n# A\n\n# A')
    expect(r.outline.map((o) => o.id)).toEqual(['h-a', 'h-a-1', 'h-a-2', 'h-a-3'])
    expect(new Set(r.outline.map((o) => o.id)).size).toBe(4)
    expect(classifyLink('#%E0%A4%A', 'a.md')).toEqual({ kind: 'inert' })
    expect(classifyLink('b.md#%E0%A4%A', 'a.md')).toEqual({ kind: 'file', path: 'b.md', anchor: null })
    expect(classifyLink('%E0%A4%A.md', 'a.md')).toEqual({ kind: 'inert' })
  })

  it('kanban : un clic seulement pour une demande lisible en entier et à jour', () => {
    const s = session({ status: { state: 'waiting', wait: 'permission' } })
    const ok = perm(1, '2026-10-20T10:00:00Z', 'npm test')
    expect(oneClickAllowed(s, ok, [])).toBe(true)
    expect(oneClickAllowed(s, ok, [1])).toBe(false) // peut-être obsolète
    expect(oneClickAllowed({ ...s, possibly_stale: true }, ok, [])).toBe(false)
    expect(oneClickAllowed(s, { ...ok, answerable: false }, [])).toBe(false)
    expect(oneClickAllowed(s, perm(2, '', 'rm -rf build\nnpm publish'), [])).toBe(false) // multiligne aplatie
    expect(oneClickAllowed(s, perm(3, '', 'x'.repeat(200)), [])).toBe(false) // coupée
    expect(oneClickAllowed(s, { ...ok, pending: { kind: 'permission', detailed: false } }, [])).toBe(false)
    const q: PendingRequest = {
      request_id: 4,
      answerable: true,
      pending: { kind: 'question', tool_name: 'AskUserQuestion', tool_input: {}, questions: [{ question: 'A ?', options: [] }] },
    }
    expect(oneClickAllowed(s, q, [])).toBe(false) // une question s'ouvre toujours
    expect(summaryFits(ok.pending)).toBe(true)
  })
})
