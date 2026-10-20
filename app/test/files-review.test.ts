import { describe, expect, it } from 'vitest'

import { ValidationError, validateParams } from '../src/main/validate'
import type { DiffFile } from '../src/shared/protocol'
import {
  HIGHLIGHT_MAX_BYTES,
  HIGHLIGHT_MAX_LINES,
  highlightCode,
  languageForFence,
  languageForPath,
  lineCount,
  withinHighlightLimits,
} from '../src/renderer/src/state/highlight'
import { renderMarkdown } from '../src/renderer/src/state/markdown'
import {
  MAX_COMMENTS,
  MAX_FILE_COMMENT_LINES,
  activeComments,
  buildReview,
  emptyDraft,
  fileComments,
  fileSelectionError,
  hasDraft,
  isFileComment,
  parseRejection,
  rejectedId,
  reviewReducer,
  type ReviewAction,
  type ReviewDraft,
} from '../src/renderer/src/state/review'
import { blocksToLines, offsetsToLines, spanBetween } from '../src/renderer/src/state/sourceSelection'

const ID = '0c69fdc4-b2c9-4511-97c8-bb78d2323d61'
const run = (actions: ReviewAction[], d: ReviewDraft = emptyDraft) => actions.reduce(reviewReducer, d)
const f = (path: string): DiffFile => ({ path, status: 'M', additions: 1, deletions: 1, binary: false })

describe('coloration syntaxique', () => {
  it('langage par extension et par info de bloc, liste fermée', () => {
    expect(languageForPath('crates/core/src/lib.rs')).toBe('rust')
    expect(languageForPath('app/src/App.TSX')).toBe('typescript')
    expect(languageForPath('Cargo.toml')).toBe('ini')
    expect(languageForPath('index.html')).toBe('xml')
    expect(languageForPath('docs/v0.2.md')).toBe('markdown')
    expect(languageForPath('Makefile')).toBeNull()
    expect(languageForPath('a.cobol')).toBeNull()
    expect(languageForFence('rust')).toBe('rust')
    expect(languageForFence('ts title="x"')).toBe('typescript')
    expect(languageForFence('TOML')).toBe('ini')
    expect(languageForFence('sh')).toBe('bash')
    expect(languageForFence('golang')).toBe('go')
    expect(languageForFence('html')).toBe('xml')
    // Enregistrés seulement : pas de détection, pas de langage du paquet complet.
    expect(languageForFence('haskell')).toBeNull()
    expect(languageForFence('')).toBeNull()
  })

  it('noms hérités d’objet (constructor, __proto__, toString…) : inconnus, sans exception', () => {
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'prototype']) {
      expect(languageForPath(`x.${name}`), name).toBeNull()
      expect(languageForFence(name), name).toBeNull()
      expect(highlightCode('x', name), name).toBeNull()
      const { html } = renderMarkdown(`\`\`\`${name}\n<b>x</b>\n\`\`\`\n`)
      expect(html, name).toContain('&lt;b&gt;x&lt;/b&gt;')
    }
  })

  it('langage connu : spans hljs ; inconnu : rien (texte brut)', () => {
    const html = highlightCode('fn main() { let x = 1; }', 'rust')!
    expect(html).toContain('<span class="hljs-keyword">fn</span>')
    expect(html).toContain('hljs-number')
    expect(highlightCode('x', 'haskell')).toBeNull()
    expect(highlightCode('x', null)).toBeNull()
  })

  it('contenu hostile : toujours échappé (code et blocs Markdown)', () => {
    const evil = '<script>alert(1)</script><img src=x onerror=alert(2)>'
    for (const lang of ['xml', 'javascript', 'markdown', 'rust']) {
      const out = highlightCode(evil, lang)!
      expect(out, lang).not.toMatch(/<script|<img/i)
      expect(out, lang).toContain('&lt;')
    }
    for (const info of ['html', 'js', 'inconnu', '']) {
      const { html } = renderMarkdown(`\`\`\`${info}\n${evil}\n\`\`\`\n\nTexte \`<b>x</b>\` et <script>alert(3)</script>\n`)
      expect(html, info).not.toMatch(/<script|<img|<b>/i)
      expect(html, info).toContain('&lt;script&gt;')
    }
  })

  it('blocs de code colorés selon leur info ; inconnu : échappé sans span', () => {
    const { html, highlighted } = renderMarkdown('```rust\nfn a() {}\n```\n\n```zzz\nfn a() {}\n```\n')
    expect(highlighted).toBe(true)
    expect(html).toContain('<span class="hljs-keyword">fn</span>')
    expect(html.split('hljs-keyword').length).toBe(2) // seulement le bloc rust
  })

  it('seuils : 200 Kio et 5 000 lignes', () => {
    expect(lineCount('a\nb\n')).toBe(2)
    expect(lineCount('a\nb')).toBe(2)
    expect(lineCount('')).toBe(0)
    const lines = (n: number) => Array.from({ length: n }, () => 'x').join('\n')
    expect(withinHighlightLimits(lines(HIGHLIGHT_MAX_LINES))).toBe(true)
    expect(withinHighlightLimits(`${lines(HIGHLIGHT_MAX_LINES)}\n`)).toBe(true)
    expect(withinHighlightLimits(lines(HIGHLIGHT_MAX_LINES + 1))).toBe(false)
    expect(withinHighlightLimits('a'.repeat(HIGHLIGHT_MAX_BYTES))).toBe(true)
    expect(withinHighlightLimits('a'.repeat(HIGHLIGHT_MAX_BYTES + 1))).toBe(false)
    // Octets UTF-8, pas caractères : « é » vaut 2 octets.
    expect(withinHighlightLimits('é'.repeat(HIGHLIGHT_MAX_BYTES / 2))).toBe(true)
    expect(withinHighlightLimits('é'.repeat(HIGHLIGHT_MAX_BYTES / 2 + 1))).toBe(false)
    // Document trop gros : blocs non colorés, mais toujours échappés.
    const big = `\`\`\`rust\nfn a() {} <script>\n\`\`\`\n${'ligne\n'.repeat(HIGHLIGHT_MAX_LINES)}`
    const r = renderMarkdown(big)
    expect(r.highlighted).toBe(false)
    expect(r.html).not.toContain('hljs-')
    expect(r.html).toContain('fn a() {} &lt;script&gt;')
  })
})

describe('lignes source d’une sélection', () => {
  it('chaque bloc rendu porte ses lignes source (1-based, bornes comprises)', () => {
    const src = ['# Titre', '', 'Premier', 'paragraphe.', '', '- un', '- deux', '', '```rust', 'fn a() {}', '```', '', '> cité'].join('\n')
    const { html } = renderMarkdown(src)
    expect(html).toContain('<h1 data-source-start="1" data-source-end="1" id="h-titre">')
    expect(html).toContain('<p data-source-start="3" data-source-end="4">')
    expect(html).toContain('<ul data-source-start="6" data-source-end="7">')
    expect(html).toContain('<li data-source-start="7" data-source-end="7">')
    expect(html).toMatch(/<code data-source-start="9" data-source-end="11" class="language-rust">/)
    expect(html).toContain('<blockquote data-source-start="13" data-source-end="13">')
  })

  it('Markdown : blocs les plus fins seulement, puis de la première à la dernière ligne', () => {
    // Liste (6-9) autour de deux éléments touchés (7 et 8) : la liste ne compte pas.
    expect(blocksToLines([{ line: 6, lineEnd: 9 }, { line: 7, lineEnd: 7 }, { line: 8, lineEnd: 8 }])).toEqual({ line: 7, lineEnd: 8 })
    // Titre et paragraphe suivant.
    expect(blocksToLines([{ line: 1, lineEnd: 1 }, { line: 3, lineEnd: 4 }])).toEqual({ line: 1, lineEnd: 4 })
    // Citation autour d'un paragraphe aux mêmes lignes : une seule plage.
    expect(blocksToLines([{ line: 5, lineEnd: 6 }, { line: 5, lineEnd: 6 }])).toEqual({ line: 5, lineEnd: 6 })
    expect(blocksToLines([])).toBeNull()
    expect(blocksToLines([{ line: Number.NaN, lineEnd: 3 }])).toBeNull()
  })

  it('code : positions dans le texte → lignes ; fin juste après un saut de ligne exclue', () => {
    const text = 'un\ndeux\ntrois\n'
    expect(offsetsToLines(text, 0, 2)).toEqual({ line: 1, lineEnd: 1 })
    expect(offsetsToLines(text, 1, 5)).toEqual({ line: 1, lineEnd: 2 })
    // Triple-clic sur « deux » : la sélection va jusqu'au début de « trois ».
    expect(offsetsToLines(text, 3, 8)).toEqual({ line: 2, lineEnd: 2 })
    // Sens inverse (sélection vers le haut).
    expect(offsetsToLines(text, 12, 4)).toEqual({ line: 2, lineEnd: 3 })
    // Bornes hors du texte ramenées au texte.
    expect(offsetsToLines(text, -4, 999)).toEqual({ line: 1, lineEnd: 3 })
    // Numéros cliqués (Maj+clic), dans n'importe quel ordre, bornés au fichier.
    expect(spanBetween(9, 4, 20)).toEqual({ line: 4, lineEnd: 9 })
    expect(spanBetween(0, 99, 20)).toEqual({ line: 1, lineEnd: 20 })
  })
})

describe('brouillon de revue mixte : diff et fichiers', () => {
  const diffComment = (path: string, line: number, text: string): ReviewAction[] => [
    { type: 'edit', path, anchor: { side: 'new', line }, lineText: `l${line}` },
    { type: 'editText', text },
    { type: 'save' },
  ]

  it('commentaire de fichier : texte facultatif, au plus 400 lignes', () => {
    let d = run([{ type: 'addFile', path: 'src/a.rs', line: 3, lineEnd: 5, text: '  ' }])
    expect(d.comments).toEqual([{ kind: 'file', id: 1, path: 'src/a.rs', line: 3, lineEnd: 5, text: '' }])
    expect(hasDraft(d)).toBe(true)
    expect(fileSelectionError(1, MAX_FILE_COMMENT_LINES)).toBeNull()
    expect(fileSelectionError(1, MAX_FILE_COMMENT_LINES + 1)).toMatch(/400 lignes au plus/)
    expect(fileSelectionError(5, 4)).not.toBeNull()
    expect(fileSelectionError(0, 1)).not.toBeNull()
    // Refusés : rien ne change.
    expect(run([{ type: 'addFile', path: 'a', line: 1, lineEnd: 401, text: 'x' }], d)).toBe(d)
    expect(run([{ type: 'addFile', path: '', line: 1, lineEnd: 1, text: 'x' }], d)).toBe(d)
    d = run([{ type: 'addFile', path: 'a', line: 1, lineEnd: 400, text: 'x'.repeat(5000) }], d)
    expect([...d.comments[1]!.text].length).toBe(4000)
    expect(run([{ type: 'delete', id: 1 }], d).comments.map((c) => c.id)).toEqual([2])
  })

  it('compte commun, limite de 200 toutes sortes confondues', () => {
    let d = run(diffComment('a.ts', 1, 'diff'))
    d = run([{ type: 'addFile', path: 'README.md', line: 2, lineEnd: 2, text: '' }], d)
    expect(activeComments(d)).toHaveLength(2)
    let full = d
    for (let i = 0; full.comments.length < MAX_COMMENTS; i++) full = run([{ type: 'addFile', path: 'x', line: i + 1, lineEnd: i + 1, text: '' }], full)
    expect(run([{ type: 'addFile', path: 'x', line: 999, lineEnd: 999, text: '' }], full)).toBe(full)
    expect(run([{ type: 'edit', path: 'a.ts', anchor: { side: 'new', line: 9 }, lineText: 'z' }], full)).toBe(full)
  })

  it('réancrage du diff : les commentaires de fichier ne bougent pas', () => {
    let d = run(diffComment('a.ts', 4, 'diff'))
    d = run([{ type: 'addFile', path: 'a.ts', line: 4, lineEnd: 6, text: 'fichier' }], d)
    const r = run([{ type: 'reanchor', path: 'a.ts', rows: [] }], d)
    expect(r.comments.find(isFileComment)).toEqual(d.comments.find(isFileComment))
    // Le commentaire de diff devient « ligne modifiée », l'extrait reste compté.
    expect(activeComments(r).map((c) => c.text)).toEqual(['fichier'])
  })

  it('revue envoyée : diff d’abord (ordre du diff), puis fichiers par chemin et ligne ; un seul envoi', () => {
    let d = emptyDraft
    d = run([{ type: 'addFile', path: 'z.md', line: 10, lineEnd: 12, text: 'z' }], d)
    d = run(diffComment('b.ts', 3, 'b3'), d)
    d = run([{ type: 'addFile', path: 'docs/a.md', line: 7, lineEnd: 7, text: '' }], d)
    d = run(diffComment('hors-diff.ts', 1, 'perdu'), d)
    d = run([{ type: 'addFile', path: 'docs/a.md', line: 2, lineEnd: 4, text: 'a2' }], d)
    expect(fileComments(d).map((c) => `${c.path}:${c.line}`)).toEqual(['docs/a.md:2', 'docs/a.md:7', 'z.md:10'])
    const built = buildReview(d, [f('b.ts')])!
    expect(built.comments).toEqual([
      { path: 'b.ts', line: 3, side: 'new', text: 'b3' },
      { kind: 'file', path: 'docs/a.md', line: 2, line_end: 4, text: 'a2' },
      { kind: 'file', path: 'docs/a.md', line: 7, line_end: 7, text: '' },
      { kind: 'file', path: 'z.md', line: 10, line_end: 12, text: 'z' },
    ])
    // Seuls les commentaires de diff hors liste restent en avertissement.
    expect(built.dropped.map((c) => c.text)).toEqual(['perdu'])
    const after = run([{ type: 'sent', ids: built.ids, general: false }], d)
    expect(after.comments.map((c) => c.text)).toEqual(['perdu'])
    // Fichiers seuls, sans diff chargé : envoyables.
    const onlyFiles = run([{ type: 'addFile', path: 'a', line: 1, lineEnd: 1, text: '' }])
    expect(buildReview(onlyFiles, [])?.comments).toEqual([{ kind: 'file', path: 'a', line: 1, line_end: 1, text: '' }])
    // La revue construite passe la validation IPC telle quelle.
    expect(validateParams('sessions.sendReview', { id: ID, comments: built.comments }).comments).toEqual(built.comments)
  })
})

describe('extrait refusé par le démon', () => {
  const built = {
    comments: [
      { path: 'b.ts', line: 3, side: 'new' as const, text: 'b3' },
      { kind: 'file' as const, path: 'docs/a.md', line: 2, line_end: 4, text: '' },
      { kind: 'file' as const, path: 'z.md', line: 10, line_end: 12, text: 'z' },
    ],
    ids: [7, 8, 9],
  }

  it('par le rang du message (« commentaire N », 1-based)', () => {
    const r = parseRejection('commentaire 3 : lignes 10-12 hors de « z.md » (4 ligne(s))', undefined)!
    expect(r.index).toBe(2)
    expect(rejectedId(built, r)).toBe(9)
    // Message de la validation de l'app.
    expect(rejectedId(built, parseRejection("paramètres refusés par l'app : commentaire 2 : « line_end » …", null)!)).toBe(8)
  })

  it('par data {index, path, line, line_end}, vérifié contre l’extrait', () => {
    // index 0-based cohérent avec le chemin.
    expect(rejectedId(built, parseRejection('refusé', { index: 1, path: 'docs/a.md', line: 2, line_end: 4 })!)).toBe(8)
    // index 1-based : le chemin tranche.
    expect(rejectedId(built, parseRejection('refusé', { index: 3, path: 'z.md', line: 10, line_end: 12 })!)).toBe(9)
    // Sans index : chemin et lignes.
    expect(rejectedId(built, parseRejection('refusé', { path: 'z.md', line: 10, line_end: 12 })!)).toBe(9)
    // Rien d'exploitable.
    expect(parseRejection('session inconnue', { autre: 1 })).toBeNull()
    expect(rejectedId(built, parseRejection('refusé', { path: 'absent.md', line: 1 })!)).toBeNull()
  })
})

describe('validation IPC des commentaires de fichier', () => {
  it('accepte, nettoie et refuse', () => {
    const ok = (c: unknown) => validateParams('sessions.sendReview', { id: ID, comments: [c] }).comments
    expect(ok({ kind: 'file', path: 'src/a.rs', line: 3, line_end: 5, text: 'r', extrait: 'ignoré' })).toEqual([
      { kind: 'file', path: 'src/a.rs', line: 3, line_end: 5, text: 'r' },
    ])
    // `line_end` absent : une ligne ; `text` absent ou vide : extrait sans remarque.
    expect(ok({ kind: 'file', path: 'a', line: 2 })).toEqual([{ kind: 'file', path: 'a', line: 2, line_end: 2, text: '' }])
    expect(ok({ kind: 'file', path: 'a', line: 1, line_end: 400, text: '' })).toHaveLength(1)
    // `kind: "diff"` explicite : commentaire de diff, `kind` retiré.
    expect(ok({ kind: 'diff', path: 'a', line: 1, side: 'new', text: 'x' })).toEqual([{ path: 'a', line: 1, side: 'new', text: 'x' }])
    const bad = [
      { kind: 'file', path: 'a', line: 3, line_end: 2 },
      { kind: 'file', path: 'a', line: 1, line_end: 401 },
      { kind: 'file', path: 'a', line: 0, line_end: 1 },
      { kind: 'file', path: '', line: 1 },
      { kind: 'file', path: 'a\0b', line: 1 },
      { kind: 'file', path: 'a', line: 1, text: 'x'.repeat(4001) },
      { kind: 'file', path: 'a', line: 1, text: 3 },
      { kind: 'autre', path: 'a', line: 1, side: 'new', text: 'x' },
      // Un commentaire de diff garde ses règles (texte non vide).
      { kind: 'diff', path: 'a', line: 1, side: 'new', text: '' },
    ]
    for (const c of bad) expect(() => ok(c), JSON.stringify(c)).toThrow(ValidationError)
    expect(() => ok({ kind: 'file', path: 'a', line: 3, line_end: 2 })).toThrow(/commentaire 1/)
  })
})
