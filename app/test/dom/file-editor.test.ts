// @vitest-environment jsdom
/**
 * Lot 7 : éditeur CodeMirror (fins de ligne conservées, modifié / non
 * modifié, Ctrl+S) et onglet Fichiers rendu avec React, démon simulé :
 * « Modifier », enregistrement avec l'empreinte ouverte puis retour en
 * lecture, conflit (« Voir les différences », « Recharger », « Écraser quand
 * même » à seconde confirmation), fichier supprimé, refus du démon, démon
 * d'avant le lot 7, garde avant de changer de fichier.
 */
import { EditorView } from '@codemirror/view'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { FileContent, FileVersion } from '../../src/shared/protocol'
import { createEditorState, editorText } from '../../src/renderer/src/state/editorSetup'
import { emptyDraft } from '../../src/renderer/src/state/review'
import { confirmLeave, guardLeave, pendingLeave, resetUnsaved, unsavedPath } from '../../src/renderer/src/state/unsaved'
import { session } from '../fixtures'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)
const SHA_W = 'f'.repeat(64)
const V = (sha: string, size = 10): FileVersion => ({ size, mtime_ns: 1, sha256: sha })

beforeAll(() => {
  // jsdom n'a pas de mise en page : CodeMirror mesure quand même (valeurs nulles suffisent).
  const zero = () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) })
  const list = () => Object.assign([], { item: () => null }) as unknown as DOMRectList
  Range.prototype.getBoundingClientRect = zero as () => DOMRect
  Range.prototype.getClientRects = list
  Element.prototype.getClientRects = list
  Element.prototype.scrollTo ??= function () {} as Element['scrollTo']
  Element.prototype.scrollIntoView ??= function () {}
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  ;(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame ??= (f: () => void) => setTimeout(f, 0)
})

describe('éditeur CodeMirror', () => {
  const hooks = () => ({ onDirty: vi.fn(), onSave: vi.fn(), label: 'Édition de a' })

  it('CRLF conservés à l’enregistrement ; LF aussi', () => {
    const crlf = 'a\r\nb\r\n'
    expect(editorText(createEditorState(crlf, 'a.txt', hooks()))).toBe(crlf)
    expect(editorText(createEditorState('a\nb\n', 'a.rs', hooks()))).toBe('a\nb\n')
  })

  it('modifié puis revenu au texte d’origine ; nouvelle ligne en CRLF dans un fichier CRLF', () => {
    const h = hooks()
    const parent = document.createElement('div')
    document.body.append(parent)
    const view = new EditorView({ state: createEditorState('a\r\nb', 'a.txt', h), parent })
    view.dispatch({ changes: { from: view.state.doc.length, insert: '\r\nc' } })
    expect(h.onDirty).toHaveBeenLastCalledWith(true)
    expect(editorText(view.state)).toBe('a\r\nb\r\nc')
    view.dispatch({ changes: { from: 3, to: view.state.doc.length } })
    expect(editorText(view.state)).toBe('a\r\nb')
    expect(h.onDirty).toHaveBeenLastCalledWith(false)
    view.destroy()
    parent.remove()
  })

  /** Collage simulé (jsdom n'a pas de ClipboardEvent) : CodeMirror lit `clipboardData`. */
  function paste(view: EditorView, data: string) {
    const ev = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(ev, 'clipboardData', { value: { getData: (t: string) => (t === 'text/plain' ? data : '') } })
    view.contentDOM.dispatchEvent(ev)
  }
  /** Dépôt simulé de texte (pas de fichier). */
  function drop(view: EditorView, data: string) {
    const ev = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(ev, 'dataTransfer', { value: { files: [], getData: (t: string) => (t === 'Text' ? data : '') } })
    view.contentDOM.dispatchEvent(ev)
  }
  function mountView(text: string) {
    const parent = document.createElement('div')
    document.body.append(parent)
    const view = new EditorView({ state: createEditorState(text, 'a.txt', hooks()), parent })
    // Pas de mise en page : la position d'un dépôt est la fin du texte.
    view.posAtCoords = (() => view.state.doc.length) as EditorView['posAtCoords']
    return {
      view,
      done: () => {
        view.destroy()
        parent.remove()
      },
    }
  }

  it('collage de LF dans un fichier CRLF : CRLF partout ; CRLF dans un fichier LF : LF partout', () => {
    const crlf = mountView('a\r\nb\r\n')
    crlf.view.dispatch({ selection: { anchor: crlf.view.state.doc.length } })
    paste(crlf.view, 'x\ny\rz\r\n')
    expect(editorText(crlf.view.state)).toBe('a\r\nb\r\nx\r\ny\r\nz\r\n')
    crlf.done()
    const lf = mountView('a\n')
    lf.view.dispatch({ selection: { anchor: lf.view.state.doc.length } })
    paste(lf.view, 'x\r\ny\rz')
    expect(editorText(lf.view.state)).toBe('a\nx\ny\nz')
    lf.done()
  })

  it('dépôt de texte LF dans un fichier CRLF : CRLF', () => {
    const crlf = mountView('a\r\n')
    drop(crlf.view, 'x\ny')
    expect(editorText(crlf.view.state)).toBe('a\r\nx\r\ny')
    crlf.done()
  })

  it('Ctrl+S : enregistrer (et pas l’enregistrement de la page)', () => {
    const h = hooks()
    const parent = document.createElement('div')
    document.body.append(parent)
    const view = new EditorView({ state: createEditorState('x', 'a.ts', h), parent })
    const ev = new KeyboardEvent('keydown', { key: 's', code: 'KeyS', keyCode: 83, ctrlKey: true, bubbles: true, cancelable: true })
    view.contentDOM.dispatchEvent(ev)
    expect(h.onSave).toHaveBeenCalledOnce()
    expect(ev.defaultPrevented).toBe(true)
    view.destroy()
    parent.remove()
  })
})

/* ---------- Onglet Fichiers, démon simulé ---------- */

type Call = { method: string; params: Record<string, unknown> }
const calls: Call[] = []
/** Contenu servi par `files.read`, par chemin. */
let files: Record<string, FileContent>
/** Réponse de `files.write` : succès, conflit, ou erreur donnée. */
let writeReply: (p: Record<string, unknown>) => { ok: true; result: unknown } | { ok: false; error: { code: number; message: string; data?: unknown } }

const text = (path: string, content: string, version: FileVersion | undefined, extra: Partial<FileContent> = {}): FileContent => ({
  path,
  size: content.length,
  binary: false,
  too_large: false,
  content,
  ...(version !== undefined ? { version } : {}),
  ...extra,
})

type Mod = typeof import('../../src/renderer/src/components/FilesView')
let FilesView: Mod['FilesView']
let UnsavedConfirm: typeof import('../../src/renderer/src/components/UnsavedConfirm')['UnsavedConfirm']

beforeAll(async () => {
  ;(window as unknown as { devmaestro: object }).devmaestro = {
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      if (method === 'files.list') {
        return {
          ok: true,
          result: {
            root: '/p',
            path: '',
            truncated: false,
            entries: Object.keys(files).map((p) => ({ name: p, path: p, kind: 'file', size: 1, changed: null })),
          },
        }
      }
      if (method === 'files.read') {
        if (holdRead) {
          // Lecture retenue : servie plus tard avec le contenu de ce moment-ci.
          const snapshot = files[params.path as string]!
          return new Promise((ok) => (releaseRead = () => ok({ ok: true, result: snapshot })))
        }
        const f = files[params.path as string]
        return f ? { ok: true, result: f } : { ok: false, error: { code: -32602, message: 'fichier introuvable' } }
      }
      if (method === 'files.write') return writeReply(params)
      return { ok: true, result: {} }
    },
  }
  ;({ FilesView } = await import('../../src/renderer/src/components/FilesView'))
  ;({ UnsavedConfirm } = await import('../../src/renderer/src/components/UnsavedConfirm'))
})

let holdRead = false
let releaseRead: (() => void) | null = null
let root: Root | null = null
let host: HTMLElement | null = null

beforeEach(() => {
  calls.length = 0
  files = {
    'README.md': text('README.md', '# Titre\n', V(SHA_A)),
    'a.txt': text('a.txt', 'un\ndeux\n', V(SHA_A)),
    'b.txt': text('b.txt', 'autre\n', V(SHA_A)),
  }
  writeReply = () => ({ ok: true, result: { version: V(SHA_W, 12) } })
  holdRead = false
  releaseRead = null
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
  resetUnsaved()
})

const flush = async () => {
  for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
}

type Props = Parameters<Mod['FilesView']>[0]
let current: { s: ReturnType<typeof session>; over: Partial<Props> } | null = null

function render(over: Partial<Props> = {}) {
  const s = current!.s
  current!.over = { ...current!.over, ...over }
  act(() =>
    root!.render(
      createElement('div', null, [
        createElement(FilesView, {
          key: 'f',
          session: s,
          diff: null,
          reviewFiles: [],
          diffVersion: 0,
          draft: emptyDraft,
          review: () => undefined,
          onSent: () => undefined,
          onMentioned: () => undefined,
          onShowDiff: () => undefined,
          onLink: () => undefined,
          ...current!.over,
        }),
        createElement(UnsavedConfirm, { key: 'u' }),
      ]),
    ),
  )
}

async function mount(over: Partial<Props> = {}) {
  const s = session()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  current = { s, over }
  render()
  await flush()
  return s
}

const button = (label: string | RegExp): HTMLButtonElement | undefined =>
  [...document.querySelectorAll('button')].find((b) => (typeof label === 'string' ? b.textContent?.trim() === label : label.test(b.textContent ?? '')))
const click = async (label: string | RegExp) => {
  const b = button(label)
  if (!b) throw new Error(`bouton absent : ${String(label)}`)
  act(() => b.click())
  await flush()
}
const editorView = () => EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!)!
const typeAtEnd = (s: string) => act(() => editorView().dispatch({ changes: { from: editorView().state.doc.length, insert: s } }))

async function openA(over: Partial<Props> = {}) {
  const s = await mount(over)
  await click(/·a\.txt$/)
  return s
}

describe('onglet Fichiers : édition', () => {
  it('Modifier → saisie (indicateur) → Enregistrer avec l’empreinte ouverte → retour en lecture avec le contenu enregistré', async () => {
    const s = await openA()
    await click('Modifier')
    expect(document.querySelector('.cm-editor')).not.toBeNull()
    expect(document.body.textContent).not.toContain('Modifié, non enregistré')
    typeAtEnd('trois\n')
    await flush()
    expect(document.body.textContent).toContain('Modifié, non enregistré')
    expect(unsavedPath(s.id)).toBe('a.txt')
    await click('Enregistrer')
    const w = calls.find((c) => c.method === 'files.write')!
    expect(w.params).toEqual({ id: s.id, path: 'a.txt', content: 'un\ndeux\ntrois\n', expected: { sha256: SHA_A } })
    expect(document.querySelector('.cm-editor')).toBeNull()
    expect(document.querySelector('.codeview code')?.textContent).toBe('un\ndeux\ntrois\n')
    expect(unsavedPath(s.id)).toBeNull()
    // Nouvelle édition : la version enregistrée est la version ouverte.
    await click('Modifier')
    typeAtEnd('x')
    await click('Enregistrer')
    expect(calls.filter((c) => c.method === 'files.write')[1]!.params.expected).toEqual({ sha256: SHA_W })
  })

  it('Enregistrer sans modification : retour en lecture sans écrire', async () => {
    await openA()
    await click('Modifier')
    await click('Enregistrer')
    expect(calls.some((c) => c.method === 'files.write')).toBe(false)
    expect(document.querySelector('.cm-editor')).toBeNull()
  })

  it('conflit : bandeau, différences, écrasement après seconde confirmation avec l’empreinte actuelle', async () => {
    await openA()
    await click('Modifier')
    typeAtEnd('moi\n')
    files['a.txt'] = text('a.txt', 'un\ndeux\nclaude\n', V(SHA_B))
    writeReply = (p) =>
      (p.expected as { sha256: string }).sha256 === SHA_B
        ? { ok: true, result: { version: V(SHA_W) } }
        : { ok: false, error: { code: -32021, message: 'le fichier a été modifié depuis son ouverture', data: { version: V(SHA_B) } } }
    await click('Enregistrer')
    expect(document.body.textContent).toContain('Le fichier a été modifié (sans doute par Claude) depuis son ouverture')
    // Texte gardé dans l'éditeur.
    expect(editorView().state.doc.toString()).toBe('un\ndeux\nmoi\n')

    await click('Voir les différences')
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('claude')
    await click('Si j’écrase')
    expect(dialog.textContent).toContain('moi')
    await click('Fermer')
    expect(document.querySelector('[role="dialog"]')).toBeNull()

    await click('Écraser quand même')
    expect(calls.filter((c) => c.method === 'files.write')).toHaveLength(1)
    await click('Écraser')
    const ws = calls.filter((c) => c.method === 'files.write')
    expect(ws).toHaveLength(2)
    expect(ws[1]!.params.expected).toEqual({ sha256: SHA_B })
    expect(document.querySelector('.cm-editor')).toBeNull()
  })

  it('conflit puis Recharger : version actuelle dans l’éditeur, plus de modification', async () => {
    const s = await openA()
    await click('Modifier')
    typeAtEnd('moi\n')
    files['a.txt'] = text('a.txt', 'nouveau\n', V(SHA_B))
    writeReply = () => ({ ok: false, error: { code: -32021, message: 'conflit', data: { version: V(SHA_B) } } })
    await click('Enregistrer')
    await click(/^Recharger/)
    expect(editorView().state.doc.toString()).toBe('nouveau\n')
    expect(unsavedPath(s.id)).toBeNull()
    typeAtEnd('x')
    writeReply = () => ({ ok: true, result: { version: V(SHA_W) } })
    await click('Enregistrer')
    expect(calls.filter((c) => c.method === 'files.write').pop()!.params.expected).toEqual({ sha256: SHA_B })
  })

  it('fichier supprimé depuis l’ouverture : « Le recréer » (expected null) après confirmation', async () => {
    await openA()
    await click('Modifier')
    typeAtEnd('moi\n')
    writeReply = (p) =>
      p.expected === null ? { ok: true, result: { version: V(SHA_W) } } : { ok: false, error: { code: -32021, message: 'conflit', data: { version: null } } }
    await click('Enregistrer')
    expect(document.body.textContent).toContain('Le fichier a été supprimé depuis son ouverture')
    expect(button('Voir les différences')).toBeUndefined()
    await click('Le recréer')
    expect(calls.filter((c) => c.method === 'files.write')).toHaveLength(1)
    expect(document.body.textContent).toContain('Recréer le fichier avec ta version ?')
    await click('Le recréer')
    expect(calls.filter((c) => c.method === 'files.write').pop()!.params.expected).toBeNull()
    expect(document.querySelector('.cm-editor')).toBeNull()
  })

  it('changer de fichier avec des modifications : confirmation ; « Rester » garde l’édition', async () => {
    await openA()
    await click('Modifier')
    typeAtEnd('moi\n')
    await click(/·b\.txt$/)
    expect(pendingLeave()?.path).toBe('a.txt')
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Modifications non enregistrées')
    await click('Rester')
    expect(document.querySelector('.cm-editor')).not.toBeNull()
    await click(/·b\.txt$/)
    await click('Abandonner mes modifications')
    expect(document.querySelector('.cm-editor')).toBeNull()
    expect(document.querySelector('.codeview code')?.textContent).toBe('autre\n')
  })

  it('Annuler les modifications : confirmation s’il y en a, puis lecture', async () => {
    await openA()
    await click('Modifier')
    typeAtEnd('moi\n')
    await click('Annuler les modifications')
    await click('Abandonner mes modifications')
    expect(document.querySelector('.cm-editor')).toBeNull()
    expect(document.querySelector('.codeview code')?.textContent).toBe('un\ndeux\n')
  })

  it('refus du démon : « Modifier » désactivé avec la raison ; démon d’avant : pas de bouton', async () => {
    files['a.txt'] = text('a.txt', 'un\n', V(SHA_A), { editable: false, not_editable_reason: 'fichier en lecture seule' })
    files['b.txt'] = text('b.txt', 'autre\n', undefined)
    await openA()
    const b = button('Modifier')!
    expect(b.disabled).toBe(true)
    expect(b.title).toBe('fichier en lecture seule')
    await click(/·b\.txt$/)
    expect(button('Modifier')).toBeUndefined()
  })

  it('erreur d’écriture : message affiché, édition gardée', async () => {
    await openA()
    await click('Modifier')
    typeAtEnd('moi\n')
    writeReply = () => ({ ok: false, error: { code: -32602, message: 'fichier trop gros (2 Mio au plus)' } })
    await click('Enregistrer')
    expect(document.querySelector('.ebanner.bad')?.textContent).toContain('fichier trop gros (2 Mio au plus)')
    expect(editorView().state.doc.toString()).toBe('un\ndeux\nmoi\n')
  })
})

describe('onglet Fichiers : corrections après relecture', () => {
  const ctrlS = () => new KeyboardEvent('keydown', { key: 's', code: 'KeyS', keyCode: 83, ctrlKey: true, bubbles: true, cancelable: true })

  it('Ctrl+S dans l’éditeur : un seul enregistrement, rien ne remonte au document', async () => {
    await openA()
    await click('Modifier')
    typeAtEnd('x')
    const outside = vi.fn()
    document.addEventListener('keydown', outside)
    const ev = ctrlS()
    act(() => void editorView().contentDOM.dispatchEvent(ev))
    await flush()
    document.removeEventListener('keydown', outside)
    expect(calls.filter((c) => c.method === 'files.write')).toHaveLength(1)
    expect(ev.defaultPrevented).toBe(true)
    expect(outside).not.toHaveBeenCalled()
  })

  it('Ctrl+S avec le focus sur un bouton de la barre de l’éditeur : enregistre, jamais transmis ailleurs', async () => {
    await openA()
    await click('Modifier')
    typeAtEnd('x')
    const b = button('Annuler les modifications')!
    act(() => b.focus())
    const outside = vi.fn()
    document.addEventListener('keydown', outside)
    const ev = ctrlS()
    act(() => void b.dispatchEvent(ev))
    await flush()
    document.removeEventListener('keydown', outside)
    expect(calls.filter((c) => c.method === 'files.write')).toHaveLength(1)
    expect(ev.defaultPrevented).toBe(true)
    expect(outside).not.toHaveBeenCalled()
    expect(document.querySelector('.cm-editor')).toBeNull()
  })

  it('collage LF dans un fichier CRLF ouvert : enregistré en CRLF', async () => {
    files['a.txt'] = text('a.txt', 'un\r\ndeux\r\n', V(SHA_A))
    await openA()
    await click('Modifier')
    const view = editorView()
    act(() => view.dispatch({ selection: { anchor: view.state.doc.length } }))
    const ev = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(ev, 'clipboardData', { value: { getData: (t: string) => (t === 'text/plain' ? 'trois\nquatre\n' : '') } })
    act(() => void view.contentDOM.dispatchEvent(ev))
    await flush()
    await click('Enregistrer')
    expect(calls.find((c) => c.method === 'files.write')!.params.content).toBe('un\r\ndeux\r\ntrois\r\nquatre\r\n')
  })

  it('« Mentionner à Claude » et « Envoyer la revue » désactivés pendant une édition modifiée', async () => {
    await openA({ draft: { ...emptyDraft, general: 'remarque' } })
    await click('Modifier')
    expect(button('Mentionner à Claude')!.title).not.toMatch(/Enregistre ou annule/)
    typeAtEnd('x')
    await flush()
    expect(button('Mentionner à Claude')!.disabled).toBe(true)
    const send = button(/^Envoyer la revue/)!
    expect(send.disabled).toBe(true)
    expect(send.title).toMatch(/Enregistre ou annule/)
    act(() => send.click())
    await flush()
    expect(calls.some((c) => c.method === 'sessions.input' || c.method === 'sessions.sendReview')).toBe(false)
  })

  it('modifications oubliées par le registre alors que la vue reste montée : réinscrites', async () => {
    const s = await openA()
    await click('Modifier')
    typeAtEnd('x')
    await flush()
    expect(unsavedPath(s.id)).toBe('a.txt')
    // Navigation confirmée qui ne démonte pas la vue.
    act(() => {
      guardLeave(s.id, 'test', () => undefined)
      confirmLeave()
    })
    await flush()
    expect(unsavedPath(s.id)).toBe('a.txt')
  })

  it('lecture partie avant un enregistrement réussi : ignorée (pas de contenu périmé)', async () => {
    const s = await openA()
    await click('Modifier')
    typeAtEnd('trois\n')
    // Le fichier est dans le diff : la relecture part 1 s après `session.diff_changed`, et reste en attente.
    holdRead = true
    render({ diff: { base: null, files: [{ path: 'a.txt', status: 'M', additions: 1, deletions: 0, binary: false }], truncated: false, skipped_non_utf8: 0 } as unknown as Props['diff'], diffVersion: 1 })
    await act(async () => new Promise((r) => setTimeout(r, 1100)))
    expect(releaseRead).not.toBeNull()
    holdRead = false
    await click('Enregistrer')
    expect(document.querySelector('.codeview code')?.textContent).toBe('un\ndeux\ntrois\n')
    act(() => releaseRead!())
    await flush()
    expect(document.querySelector('.codeview code')?.textContent).toBe('un\ndeux\ntrois\n')
    expect(s.id).toBeTruthy()
  })
})
