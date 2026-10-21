// @vitest-environment jsdom
/**
 * Consignes personnalisables (lot 18) rendues avec React : Réglages →
 * Consignes (édition, aperçu, origine, « Rétablir le défaut », surcharge par
 * projet et « Hériter du global »), et envois réels : la revue du diff et
 * les extraits de fichiers partent avec la consigne personnalisée
 * (`sessions.sendReview {instruction}`), signalée si le démon est ancien.
 */
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { defaultPrompt } from '../../src/shared/prompts'
import type { DiffFile } from '../../src/shared/protocol'
import { defaultSettings, type AppSettings, type SettingsPatch } from '../../src/shared/settings'
import type { ProjectChoice } from '../../src/renderer/src/state/newSession'
import { emptyDraft, type ReviewDraft } from '../../src/renderer/src/state/review'
import { session } from '../fixtures'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const updateSettings = vi.fn(async (_p: SettingsPatch) => ({ ok: false as const, error: { code: -1, message: 'test' } }))
const calls: { method: string; params: Record<string, unknown> }[] = []

type SettingsMod = typeof import('../../src/renderer/src/settings')
let SettingsProvider: SettingsMod['SettingsProvider']
let useSettings: SettingsMod['useSettings']
let SettingsDialog: typeof import('../../src/renderer/src/components/SettingsDialog')['SettingsDialog']
let ReviewBar: typeof import('../../src/renderer/src/components/ReviewBar')['ReviewBar']
let PromptScopeContext: typeof import('../../src/renderer/src/promptScope')['PromptScopeContext']

beforeAll(async () => {
  ;(window as unknown as { devmaestro: object }).devmaestro = {
    updateSettings,
    onZoomChanged: () => () => undefined,
    copyText: async () => true,
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      return { ok: true, result: { sent: true } }
    },
  }
  ;({ SettingsProvider, useSettings } = await import('../../src/renderer/src/settings'))
  ;({ SettingsDialog } = await import('../../src/renderer/src/components/SettingsDialog'))
  ;({ ReviewBar } = await import('../../src/renderer/src/components/ReviewBar'))
  ;({ PromptScopeContext } = await import('../../src/renderer/src/promptScope'))
})

let root: Root | null = null
let host: HTMLElement | null = null
let latest: AppSettings | null = null

beforeEach(() => {
  updateSettings.mockClear()
  calls.length = 0
  latest = null
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
})

function Spy() {
  latest = useSettings().settings
  return null
}

function mount(children: ReactNode, initial: AppSettings = defaultSettings()) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root!.render(createElement(SettingsProvider, { initial, children: [createElement(Spy, { key: 's' }), createElement('div', { key: 'd' }, children)] })))
}

const PROJECT: ProjectChoice = {
  key: 'git:/w/p/.git',
  name: 'projet',
  root: '/w/p',
  profileKey: '/w/p',
  isGit: true,
  dirs: [],
  latest: 0,
  recentProfile: null,
}

function setValue(el: HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLSelectElement.prototype
  act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}

const buttons = (label: string | RegExp) =>
  [...document.querySelectorAll('button')].filter((b) => (typeof label === 'string' ? b.textContent === label : label.test(b.textContent ?? '')))
/** Éditeur d'une consigne (section titrée par son libellé). */
function editor(label: string): HTMLElement {
  const h = [...document.querySelectorAll('.prompt-ed h3')].find((x) => x.textContent === label)
  if (!h) throw new Error(`consigne introuvable : ${label}`)
  return h.closest('section')!
}
const area = (label: string) => editor(label).querySelector('textarea')!
const origin = (label: string) => editor(label).querySelector('.prompt-origin')!.textContent
const preview = (label: string) => editor(label).querySelector('pre')?.textContent

function openPrompts() {
  mount(createElement(SettingsDialog, { profiles: [], projects: [PROJECT], home: '/h', scheme: 'dark', onClose: () => undefined }))
  act(() => buttons('Consignes')[0]!.click())
}

describe('Réglages → Consignes', () => {
  it('liste chaque consigne avec son texte par défaut, ce qui est collé et l’aperçu', () => {
    openPrompts()
    expect([...document.querySelectorAll('.prompt-ed h3')].map((h) => h.textContent)).toEqual([
      'Revue du diff',
      'Extraits de fichiers',
      'Issue',
      'Livraison : demande de fusion',
      'Livraison : fusion directe',
      'Échec de CI',
    ])
    expect(area('Issue').value).toBe(defaultPrompt('issue'))
    expect(origin('Issue')).toBe('Origine : texte par défaut')
    expect(editor('Issue').textContent).toMatch(/Collé ensuite, comme donnée .* le titre et le corps de l’issue/)
    expect(editor('Livraison : demande de fusion').textContent).toMatch(/Rien n’est collé/)
    expect(preview('Livraison : demande de fusion')).toMatch(/pousse la branche 42-corriger-export puis ouvre une demande de fusion vers main/)
    expect(buttons('Rétablir le défaut')).toHaveLength(0)
  })

  it('édition globale : aperçu rendu, enregistrée si valide, puis « Rétablir le défaut »', () => {
    openPrompts()
    setValue(area('Revue du diff'), 'Applique mes {commentaires} remarques sur {branche} :')
    expect(preview('Revue du diff')).toBe('Applique mes 3 remarques sur 42-corriger-export :')
    expect(latest!.prompts.global).toEqual({ review: 'Applique mes {commentaires} remarques sur {branche} :' })
    expect(origin('Revue du diff')).toBe('Origine : réglage global')
    // Invalide : erreur affichée, rien d'enregistré.
    setValue(area('Revue du diff'), 'Voir {titre}')
    expect(editor('Revue du diff').querySelector('[role="alert"]')!.textContent).toMatch(/variable inconnue : \{titre\}/)
    expect(area('Revue du diff').getAttribute('aria-invalid')).toBe('true')
    expect(latest!.prompts.global.review).toBe('Applique mes {commentaires} remarques sur {branche} :')
    act(() => editor('Revue du diff').querySelector<HTMLButtonElement>('button')!.click())
    expect(latest!.prompts.global).toEqual({})
    expect(area('Revue du diff').value).toBe(defaultPrompt('review'))
    expect(origin('Revue du diff')).toBe('Origine : texte par défaut')
  })

  it('surcharge par projet : hérite du global, puis propre au projet, puis « Hériter du global »', () => {
    const initial = { ...defaultSettings(), prompts: { global: { issue: 'Traite {issue} (global).' }, projects: {} } }
    mount(createElement(SettingsDialog, { profiles: [], projects: [PROJECT], home: '/h', scheme: 'dark', onClose: () => undefined }), initial)
    act(() => buttons('Consignes')[0]!.click())
    setValue(document.querySelector<HTMLSelectElement>('[aria-label="Portée des consignes"]')!, '/w/p')
    expect(area('Issue').value).toBe('Traite {issue} (global).')
    expect(origin('Issue')).toBe('Origine : réglage global')
    expect(buttons('Hériter du global')).toHaveLength(0)
    setValue(area('Issue'), 'Traite {issue} pour ce projet.')
    expect(latest!.prompts).toEqual({ global: { issue: 'Traite {issue} (global).' }, projects: { '/w/p': { issue: 'Traite {issue} pour ce projet.' } } })
    expect(origin('Issue')).toBe('Origine : propre au projet')
    expect(preview('Issue')).toBe('Traite #42 pour ce projet.')
    act(() => buttons('Hériter du global')[0]!.click())
    expect(latest!.prompts.projects).toEqual({})
    expect(area('Issue').value).toBe('Traite {issue} (global).')
    // Retour au global : la surcharge globale est toujours là.
    setValue(document.querySelector<HTMLSelectElement>('[aria-label="Portée des consignes"]')!, '')
    expect(origin('Issue')).toBe('Origine : réglage global')
  })
})

describe('Réglages → Consignes : texte invalide', () => {
  it('modèle invalide relu du disque (ancien modèle 14b) : montré avec son erreur, non utilisé, retirable', () => {
    const initial = { ...defaultSettings(), prompts: { global: { deliveryPr: 'Ouvre {titre}' }, projects: {} } }
    mount(createElement(SettingsDialog, { profiles: [], projects: [PROJECT], home: '/h', scheme: 'dark', onClose: () => undefined }), initial)
    act(() => buttons('Consignes')[0]!.click())
    const label = 'Livraison : demande de fusion'
    expect(area(label).value).toBe('Ouvre {titre}')
    expect(editor(label).querySelector('[role="alert"]')!.textContent).toMatch(/Texte enregistré invalide, non utilisé \(le texte par défaut s’applique\) : variable inconnue/)
    expect(origin(label)).toBe('Origine : texte par défaut')
    act(() => editor(label).querySelector<HTMLButtonElement>('button')!.click())
    expect(latest!.prompts.global).toEqual({})
    expect(area(label).value).toBe(defaultPrompt('deliveryPr'))
    expect(editor(label).querySelector('[role="alert"]')).toBeNull()
  })

  it('texte tapé invalide : « Non enregistré » persistant ; Entrée sans saut de ligne', () => {
    openPrompts()
    setValue(area('Issue'), '# Traite {issue}')
    expect(editor('Issue').querySelector('[role="alert"]')!.textContent).toMatch(/^Non enregistré : .*commencer par/)
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    act(() => {
      area('Issue').dispatchEvent(ev)
    })
    expect(ev.defaultPrevented).toBe(true)
    expect(latest!.prompts.global).toEqual({})
  })
})

describe('envoi de la revue avec la consigne personnalisée', () => {
  const FILES: DiffFile[] = [{ path: 'src/a.rs', status: 'M', additions: 1, deletions: 0, binary: false }]
  const S = session({ branch: 'feat/x', status: { state: 'idle' } })

  function renderBar(draft: ReviewDraft, prompts: AppSettings['prompts'], reviewInstruction: boolean | null) {
    const bar = createElement(ReviewBar, { session: S, draft, review: () => undefined, files: FILES, onSent: () => undefined })
    mount(createElement(PromptScopeContext.Provider, { value: { projectKey: '/w/p', reviewInstruction }, children: bar }), { ...defaultSettings(), prompts })
  }

  async function send() {
    await act(async () => buttons(/^Envoyer la revue à Claude/)[0]!.click())
  }

  it('revue du diff : consigne du projet rendue, envoyée dans `instruction`', async () => {
    const draft: ReviewDraft = { ...emptyDraft, comments: [{ id: 1, path: 'src/a.rs', side: 'new', line: 3, text: 'renomme', lineText: 'x' }], nextId: 2 }
    renderBar(draft, { global: { review: 'Global :' }, projects: { '/w/p': { review: 'Applique mes {commentaires} remarques sur {branche} :' } } }, true)
    expect(document.querySelector('.review-instr')!.textContent).toBe('Consigne : Applique mes 1 remarques sur feat/x :')
    await send()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('sessions.sendReview')
    expect(calls[0]!.params).toMatchObject({ id: S.id, instruction: 'Applique mes 1 remarques sur feat/x :' })
  })

  it('extraits de fichiers seuls : consigne des extraits (globale ici)', async () => {
    const draft: ReviewDraft = {
      ...emptyDraft,
      comments: [
        { kind: 'file', id: 1, path: 'src/b.rs', line: 1, lineEnd: 4, text: '' },
        { kind: 'file', id: 2, path: 'src/c.rs', line: 2, lineEnd: 2, text: 'ici' },
      ],
      nextId: 3,
    }
    renderBar(draft, { global: { fileExcerpts: 'Lis ces {extraits} extraits :' }, projects: {} }, true)
    await send()
    expect(calls[0]!.params.instruction).toBe('Lis ces 2 extraits :')
  })

  it('démon ancien (sans `review_instruction`) : signalé, la consigne part quand même (ignorée par lui)', async () => {
    const draft: ReviewDraft = { ...emptyDraft, general: 'Bien.' }
    renderBar(draft, { global: { review: 'Ma revue :' }, projects: {} }, false)
    expect(document.querySelector('.review-instr')!.textContent).toMatch(/Démon ancien : la consigne par défaut du démon sera tapée/)
    await send()
    expect(calls[0]!.params).toMatchObject({ general: 'Bien.', instruction: 'Ma revue :' })
  })
})
