/**
 * Lot 15 (retours sur la forge), calculs purs : cases à cocher Markdown
 * (variantes, sûreté, lignes source), noms courts de session et de branche
 * (français, anglais, longueur, coupure au mot, epic), étiquettes du dépôt
 * (lecture tolérante, filtre du sélecteur, paramètres de `forge.issues`),
 * validation IPC de `forge.labels` et de `labels`, taille retenue du panneau.
 */
import { describe, expect, it } from 'vitest'

import { MAX_ISSUE_LABELS, ValidationError, requestTimeoutMs, validateParams, FORGE_TIMEOUT_MS } from '../src/main/validate'
import { FORGE_METHODS, RENDERER_METHODS, type RepoLabel } from '../src/shared/protocol'
import { branchNameProblem, branchTakenError, nextFreeBranch } from '../src/shared/worktrees'
import { openableRunnerFile, readRunnerFiles, riskyRunnerFile } from '../src/shared/runnerFiles'
import {
  DEFAULT_FILTERS,
  MAX_SHORT_BRANCH,
  MAX_SHORT_NAME,
  cutAtWord,
  trimEnd,
  epicPlan,
  issueBranch,
  issueSessionName,
  issuesParams,
  repoLabelsFrom,
} from '../src/renderer/src/state/forge'
import { filterLabels, foldText, moveActive, selectionSummary, toggleLabel } from '../src/renderer/src/state/labelPicker'
import { renderMarkdown } from '../src/renderer/src/state/markdown'
import { DEFAULT_PANEL_SIZE, MIN_PANEL_WIDTH, clampPanelWidth, loadPanelSize, savePanelSize } from '../src/renderer/src/state/panelSize'

const ROOT = '/home/u/projet'
const len = (s: string) => [...s].length

/* ---------- Cases à cocher Markdown ---------- */

describe('Markdown : listes de tâches', () => {
  const boxes = (html: string) => [...html.matchAll(/<input[^>]*>/g)].map((m) => m[0])

  it('« - [ ] », « - [x] », « * [X] », « 1. [ ] » : cases désactivées, cochées pour x / X, marqueur retiré', () => {
    const { html } = renderMarkdown('- [ ] à faire\n- [x] fait\n\n* [X] fait aussi\n\n1. [ ] numérotée\n2. [x] numérotée faite\n')
    expect(boxes(html)).toEqual([
      '<input type="checkbox" class="task-cb" disabled>',
      '<input type="checkbox" class="task-cb" disabled checked>',
      '<input type="checkbox" class="task-cb" disabled checked>',
      '<input type="checkbox" class="task-cb" disabled>',
      '<input type="checkbox" class="task-cb" disabled checked>',
    ])
    expect(html).not.toContain('[ ]')
    expect(html).not.toMatch(/\[[xX]\]/)
    expect(html).toContain('disabled> à faire</li>')
    expect(html).toMatch(/<ul class="task-list"[^>]*>/)
    expect(html).toMatch(/<ol class="task-list"[^>]*>/)
    expect(html.match(/<li class="task-item"/g)).toHaveLength(5)
  })

  it('listes lâches (paragraphes) et imbriquées', () => {
    const { html } = renderMarkdown('- [ ] a\n\n- [x] b\n  - [x] b.1\n  - [ ] b.2\n')
    expect(boxes(html)).toHaveLength(4)
    expect(html).toContain('<p data-source-start="1" data-source-end="1"><input type="checkbox" class="task-cb" disabled> a</p>')
    // Liste imbriquée : marquée elle aussi.
    expect(html.match(/<ul class="task-list"/g)).toHaveLength(2)
  })

  it('pas de case hors d’un marqueur en tête : au milieu, suivi d’une lettre, dans du code, hors liste, liste ordinaire', () => {
    const src = ['- texte [ ] au milieu', '- [ ]x collé', '- `[ ]` en code', '- [y] autre lettre', '', '[ ] hors liste', '', '- élément ordinaire'].join('\n')
    const { html } = renderMarkdown(src)
    expect(boxes(html)).toEqual([])
    expect(html).not.toContain('task-item')
    expect(html).not.toContain('task-list')
    expect(html).toContain('[ ]x collé')
    expect(html).toContain('<code>[ ]</code>')
  })

  it('« - [ ] » sans texte : une case seule', () => {
    expect(boxes(renderMarkdown('- [ ]\n- [x]\n').html)).toHaveLength(2)
  })

  it('sûr : le reste de l’élément reste échappé (html: false), aucune autre balise ni attribut tiré du texte', () => {
    const src = '- [x] <img src=x onerror="alert(1)"> <script>alert(2)</script>\n- [ ] "><input checked onclick=alert(3)>'
    const { html } = renderMarkdown(src)
    // Balises produites : la liste, ses éléments et les deux cases, rien d'autre (le reste est du texte échappé).
    expect(new Set([...html.matchAll(/<([a-z]+)[\s>]/g)].map((m) => m[1]))).toEqual(new Set(['ul', 'li', 'input']))
    expect(html).not.toMatch(/<img|<script|<input(?! type="checkbox" class="task-cb" disabled)/)
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;')
    expect(html).toContain('&lt;input checked onclick=alert(3)&gt;')
    // Seules les deux cases produites par la règle.
    expect(boxes(html)).toEqual(['<input type="checkbox" class="task-cb" disabled checked>', '<input type="checkbox" class="task-cb" disabled>'])
  })

  it('lignes source inchangées sur la liste et ses éléments (commenter une sélection)', () => {
    const src = '# Titre\n\n- [ ] un\n- [x] deux\n  suite\n- [ ] trois\n\nfin\n'
    const { html } = renderMarkdown(src)
    expect(html).toMatch(/<ul class="task-list" data-source-start="3" data-source-end="6">/)
    expect(html).toMatch(/<li class="task-item" data-source-start="3" data-source-end="3">/)
    expect(html).toMatch(/<li class="task-item" data-source-start="4" data-source-end="5">/)
    expect(html).toMatch(/<li class="task-item" data-source-start="6" data-source-end="6">/)
    expect(html).toMatch(/<p data-source-start="8" data-source-end="8">fin<\/p>/)
  })
})

/* ---------- Noms courts ---------- */

describe('noms courts de session et de branche', () => {
  it('session « #n titre court » : 40 caractères au plus, coupé au mot, sans ponctuation ni mot vide en fin', () => {
    expect(issueSessionName(42, 'Corriger l’export CSV.')).toBe('#42 Corriger l’export CSV')
    const long = issueSessionName(42, 'Ajouter la division et une erreur explicite pour la division par zéro dans le module de calcul')
    expect(long).toBe('#42 Ajouter la division et une erreur')
    expect(len(long)).toBeLessThanOrEqual(MAX_SHORT_NAME)
    // Coupé juste après un mot vide : il est retiré.
    expect(issueSessionName(7, 'Corriger l’affichage des diagnostics de la page des réglages')).toBe('#7 Corriger l’affichage des diagnostics')
    expect(issueSessionName(1234, 'Fix the crash when the user opens the settings dialog twice')).toBe('#1234 Fix the crash when the user opens')
    expect(issueSessionName(5, 'Pourquoi : ça plante ?!')).toBe('#5 Pourquoi : ça plante')
    expect(issueSessionName(5, '   ')).toBe('Issue #5')
    for (const t of ['a'.repeat(200), 'mot '.repeat(50), 'é'.repeat(300), 'Un titre raisonnable']) {
      expect(len(issueSessionName(99999, t)), t.slice(0, 20)).toBeLessThanOrEqual(MAX_SHORT_NAME)
    }
  })

  it('coupure au mot (et coupe nette d’un premier mot trop long)', () => {
    expect(cutAtWord('un deux trois', 9)).toBe('un deux')
    expect(cutAtWord('un deux trois', 13)).toBe('un deux trois')
    expect(cutAtWord('anticonstitutionnellement', 10)).toBe('anticonsti')
    expect(cutAtWord('ligne 1\nligne 2', 40)).toBe('ligne 1 ligne 2')
    expect(cutAtWord('x', 0)).toBe('')
  })

  it('branche : préfixe, numéro, 3 mots significatifs au plus (mots vides français et anglais retirés)', () => {
    expect(issueBranch(42, 'Ajouter la division et une erreur explicite pour la division par zéro', 'romain/')).toBe('romain/42-ajouter-division-erreur')
    expect(issueBranch(42, 'Corriger l’export CSV', 'romain/')).toBe('romain/42-corriger-export-csv')
    expect(issueBranch(12, 'Add a button to the settings for the theme', '')).toBe('12-add-button-settings')
    expect(issueBranch(3, 'Fix the export of the CSV files in the report', 'feat-')).toBe('feat-3-fix-export-csv')
    // Doublons retirés, chiffres gardés.
    expect(issueBranch(8, 'Export export v2 vers CSV', '')).toBe('8-export-v2-vers')
    // Que des mots vides : les premiers mots, plutôt que rien.
    expect(issueBranch(9, 'Le la les', '')).toBe('9-le-la-les')
    expect(issueBranch(10, '', 'p/')).toBe('p/10')
  })

  it('branche : 40 caractères au plus, mots retirés par la fin ; toujours un nom de branche valide', () => {
    const b = issueBranch(4242, 'Internationalisation documentation reconfiguration', 'romain/')
    expect(len(b)).toBeLessThanOrEqual(MAX_SHORT_BRANCH)
    expect(b).toBe('romain/4242-internationalisation')
    expect(issueBranch(1, 'a'.repeat(400), 'p/')).toBe(`p/1-${'a'.repeat(36)}`)
    expect(issueBranch(1, 'abc'.repeat(100), 'p/')).toBe(`p/1-${'abc'.repeat(100).slice(0, 40 - 'p/1-'.length)}`)
    // Préfixe déjà long (jusqu'à 40 caractères) : préfixe et numéro seulement.
    expect(issueBranch(5, 'Un titre', 'x'.repeat(39) + '/')).toBe('x'.repeat(39) + '/5')
    for (const t of ['Éditer le « README » : ça marche ?', '../../x; rm -rf ~', 'é'.repeat(300), 'Fix: `foo` → bar…']) {
      const br = issueBranch(77, t, 'romain/')
      expect(branchNameProblem(br), t).toBeNull()
      expect(len(br), t).toBeLessThanOrEqual(MAX_SHORT_BRANCH)
    }
  })

  it('même règle pour les sessions d’un epic', () => {
    const subs = [{ number: 43, title: 'Fonction division et erreur claire pour b = 0', state: 'open' as const }]
    expect(epicPlan(subs, new Set([43]), 'romain/', new Set())).toEqual([
      { number: 43, title: subs[0]!.title, name: '#43 Fonction division et erreur claire', branch: 'romain/43-fonction-division-erreur', problem: null },
    ])
  })
})

/* ---------- Étiquettes du dépôt ---------- */

describe('étiquettes du dépôt et sélecteur', () => {
  const LABELS: RepoLabel[] = [
    { name: 'bug', color: 'd73a4a', description: 'Quelque chose ne marche pas' },
    { name: 'démon', color: 'fbca04', description: 'orchd (Rust)' },
    { name: 'documentation', color: '0075ca', description: null },
    { name: 'interface', color: '1d76db', description: 'Front Electron' },
  ]

  it('lecture tolérante de forge.labels : noms nettoyés, vides et doublons écartés, triés', () => {
    const r = repoLabelsFrom({
      labels: [
        { name: 'zèbre‮', color: 'ffffff', description: 'ligne\nsuivante' },
        { name: 'bug', color: 'd73a4a', description: '' },
        { name: 'bug', color: '000000' },
        { name: '   ' },
        { name: 3 },
        null,
        { name: 'x'.repeat(129) },
        { name: 'Accessibilité', color: 42 },
      ],
    })
    expect(r).toEqual([
      { name: 'Accessibilité', color: null, description: null },
      { name: 'bug', color: 'd73a4a', description: null },
      { name: 'zèbre', color: 'ffffff', description: 'ligne suivante' },
    ])
    expect(repoLabelsFrom(null)).toEqual([])
    expect(repoLabelsFrom({ labels: 'bug' })).toEqual([])
  })

  it('filtre : sans accents ni majuscules, nom puis description ; le début du nom d’abord', () => {
    expect(foldText('  Démon  RUST ')).toBe('demon rust')
    expect(filterLabels(LABELS, '').map((l) => l.name)).toEqual(['bug', 'démon', 'documentation', 'interface'])
    expect(filterLabels(LABELS, 'DEMON').map((l) => l.name)).toEqual(['démon'])
    expect(filterLabels(LABELS, 'rust').map((l) => l.name)).toEqual(['démon'])
    // « do » : « documentation » commence par lui, « démon »… non ; « bug » ne le contient pas.
    expect(filterLabels(LABELS, 'do').map((l) => l.name)).toEqual(['documentation'])
    // « i » : « interface » commence par lui, puis ceux qui le contiennent (nom ou description), dans l'ordre.
    expect(filterLabels(LABELS, 'i').map((l) => l.name)).toEqual(['interface', 'documentation'])
    expect(filterLabels(LABELS, 'inexistante')).toEqual([])
  })

  it('ajout, retrait, plafond ; option active en boucle ; résumé annoncé', () => {
    expect(toggleLabel([], 'bug')).toEqual(['bug'])
    expect(toggleLabel(['bug', 'démon'], 'bug')).toEqual(['démon'])
    expect(toggleLabel(['a', 'b'], 'c', 2)).toEqual(['a', 'b'])
    expect(toggleLabel(['a', 'b'], 'a', 2)).toEqual(['b'])
    expect(moveActive(-1, 3, 1)).toBe(0)
    expect(moveActive(-1, 3, -1)).toBe(2)
    expect(moveActive(2, 3, 1)).toBe(0)
    expect(moveActive(0, 3, -1)).toBe(2)
    expect(moveActive(0, 0, 1)).toBe(-1)
    expect(selectionSummary([])).toBe('Aucune étiquette choisie')
    expect(selectionSummary(['bug'])).toBe('1 étiquette choisie : bug')
    expect(selectionSummary(['bug', 'démon'])).toBe('2 étiquettes choisies : bug, démon')
  })

  it('paramètres de forge.issues : une étiquette en `label` (tous les démons), plusieurs en `labels` ; saisie libre sinon', () => {
    expect(issuesParams(ROOT, { ...DEFAULT_FILTERS, labels: ['bug'] })).toEqual({ root: ROOT, state: 'open', label: 'bug', limit: 50 })
    expect(issuesParams(ROOT, { ...DEFAULT_FILTERS, labels: ['bug', ' démon ', 'bug', ''] })).toEqual({
      root: ROOT,
      state: 'open',
      labels: ['bug', 'démon'],
      limit: 50,
    })
    // Étiquettes choisies prioritaires sur une saisie libre restée là.
    expect(issuesParams(ROOT, { ...DEFAULT_FILTERS, labels: ['a', 'b'], label: 'c' }).labels).toEqual(['a', 'b'])
    expect(issuesParams(ROOT, { ...DEFAULT_FILTERS, label: ' bug ' })).toEqual({ root: ROOT, state: 'open', label: 'bug', limit: 50 })
    const many = Array.from({ length: 30 }, (_, i) => `l${i}`)
    const p = issuesParams(ROOT, { ...DEFAULT_FILTERS, labels: many })
    expect(p.labels).toHaveLength(MAX_ISSUE_LABELS)
    expect(() => validateParams('forge.issues', p)).not.toThrow()
  })
})

/* ---------- Validation IPC ---------- */

describe('validation IPC : forge.labels et labels de forge.issues', () => {
  it('forge.labels : autorisée pour la page, méthode de forge (`enabled` ajouté par le processus principal), délai de la forge', () => {
    expect(RENDERER_METHODS).toContain('forge.labels')
    expect(FORGE_METHODS).toContain('forge.labels')
    expect(validateParams('forge.labels', { root: ROOT, enabled: true, x: 1 })).toEqual({ root: ROOT })
    expect(validateParams('forge.labels', { root: ROOT, refresh: true })).toEqual({ root: ROOT, refresh: true })
    expect(() => validateParams('forge.labels', { root: 'relatif' })).toThrow(ValidationError)
    expect(() => validateParams('forge.labels', { root: ROOT, refresh: 1 })).toThrow(ValidationError)
    expect(requestTimeoutMs('forge.labels', { root: ROOT })).toBe(FORGE_TIMEOUT_MS)
  })

  it('labels : tableau de noms non vides, 128 caractères au plus, sans contrôle, 20 au plus ; avec ou sans label', () => {
    expect(validateParams('forge.issues', { root: ROOT, labels: ['bug', 'démon'] })).toEqual({ root: ROOT, labels: ['bug', 'démon'] })
    expect(validateParams('forge.issues', { root: ROOT, labels: [] })).toEqual({ root: ROOT, labels: [] })
    expect(validateParams('forge.issues', { root: ROOT, label: 'a', labels: ['b'] })).toEqual({ root: ROOT, label: 'a', labels: ['b'] })
    expect(validateParams('forge.issues', { root: ROOT, labels: ['é'.repeat(128)] }).labels).toEqual(['é'.repeat(128)])
    const bad: unknown[] = [
      'bug',
      { 0: 'bug' },
      [3],
      [null],
      [''],
      ['  '],
      ['x'.repeat(129)],
      ['a\nb'],
      ['a\u0000'],
      Array.from({ length: MAX_ISSUE_LABELS + 1 }, (_, i) => `l${i}`),
    ]
    for (const labels of bad) {
      expect(() => validateParams('forge.issues', { root: ROOT, labels }), JSON.stringify(labels).slice(0, 60)).toThrow(ValidationError)
    }
    expect(() => validateParams('forge.issues', { root: ROOT, labels: ['ok', ''] })).toThrow(/labels\[1\]/)
  })
})

/* ---------- Taille retenue du panneau ---------- */

describe('panneau Forge : taille retenue', () => {
  function memory(init: Record<string, string> = {}) {
    const data = new Map(Object.entries(init))
    return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) }
  }
  const KEY = 'devmaestro.forge.panel'

  it('par défaut : toute la largeur, pas agrandi ; stockage absent, illisible ou qui lève : défaut', () => {
    expect(loadPanelSize(memory(), KEY)).toEqual(DEFAULT_PANEL_SIZE)
    expect(DEFAULT_PANEL_SIZE).toEqual({ width: null, maximized: false })
    expect(loadPanelSize(null, KEY)).toEqual(DEFAULT_PANEL_SIZE)
    expect(loadPanelSize(memory({ [KEY]: '{oups' }), KEY)).toEqual(DEFAULT_PANEL_SIZE)
    expect(loadPanelSize(memory({ [KEY]: '42' }), KEY)).toEqual(DEFAULT_PANEL_SIZE)
    const throwing = { getItem: () => { throw new Error('refusé') }, setItem: () => { throw new Error('refusé') } }
    expect(loadPanelSize(throwing, KEY)).toEqual(DEFAULT_PANEL_SIZE)
    expect(() => savePanelSize(throwing, KEY, { width: 900, maximized: true })).not.toThrow()
  })

  it('aller-retour ; largeur invalide ou sous le minimum ignorée', () => {
    const m = memory()
    savePanelSize(m, KEY, { width: 900, maximized: true })
    expect(loadPanelSize(m, KEY)).toEqual({ width: 900, maximized: true })
    savePanelSize(m, KEY, { width: null, maximized: false })
    expect(loadPanelSize(m, KEY)).toEqual({ width: null, maximized: false })
    expect(loadPanelSize(memory({ [KEY]: JSON.stringify({ width: 100, maximized: 'oui' }) }), KEY)).toEqual({ width: null, maximized: false })
    expect(loadPanelSize(memory({ [KEY]: JSON.stringify({ width: 'grand' }) }), KEY)).toEqual({ width: null, maximized: false })
  })

  it('bornes : minimum, et toute la largeur (null) dès qu’on atteint la largeur disponible', () => {
    expect(clampPanelWidth(100, 1500)).toBe(MIN_PANEL_WIDTH)
    expect(clampPanelWidth(900.4, 1500)).toBe(900)
    expect(clampPanelWidth(1500, 1500)).toBeNull()
    expect(clampPanelWidth(5000, 1500)).toBeNull()
    expect(clampPanelWidth(Number.NaN, 1500)).toBeNull()
    // Fenêtre plus étroite que le minimum : toute la largeur.
    expect(clampPanelWidth(700, 400)).toBeNull()
  })
})

/* ---------- Corrections après relecture ---------- */

describe('noms courts : parenthèses et graphèmes (M1, M3)', () => {
  it('un fermant qui ferme quelque chose est gardé ; ouvrants orphelins et fermants seuls retirés', () => {
    expect(issueSessionName(5, 'Corriger le login (SSO)')).toBe('#5 Corriger le login (SSO)')
    expect(issueSessionName(5, 'Tableau [bêta].')).toBe('#5 Tableau [bêta]')
    expect(issueSessionName(5, 'Renommer « Fichiers »')).toBe('#5 Renommer « Fichiers »')
    expect(issueSessionName(5, 'Afficher "Aucun résultat"')).toBe('#5 Afficher "Aucun résultat"')
    expect(trimEnd('Corriger le login (')).toBe('Corriger le login')
    expect(trimEnd('Fin)')).toBe('Fin')
    expect(trimEnd('dit "oui')).toBe('dit "oui')
    expect(trimEnd('dit oui"')).toBe('dit oui')
    // Coupé au milieu de la parenthèse : l'ouvrant reste, sans fermant inventé.
    expect(issueSessionName(5, 'Corriger la connexion unique (SSO avec le fournisseur Okta de test)')).toBe('#5 Corriger la connexion unique (SSO')
  })

  it('jamais au milieu d’un graphème : drapeau, teinte de peau, lettre et accent combinant', () => {
    // Les jointures (ZWJ) et sélecteurs de variante sont retirés par le nettoyage de la forge ; restent ces graphèmes à 2 points de code.
    const flag = '🇫🇷'
    const thumb = '👍🏽'
    expect(cutAtWord(`${'a'.repeat(30)}${flag}${flag}`, 31)).toBe('a'.repeat(30))
    expect(cutAtWord(`${'a'.repeat(30)}${flag}${flag}`, 33)).toBe(`${'a'.repeat(30)}${flag}`)
    expect(cutAtWord(`${'a'.repeat(30)}${thumb}`, 31)).toBe('a'.repeat(30))
    expect(cutAtWord('éééé'.normalize('NFD'), 3)).toBe('é'.normalize('NFD'))
    const name = issueSessionName(1, flag.repeat(40))
    expect([...name].length).toBeLessThanOrEqual(MAX_SHORT_NAME)
    expect([...name.slice(3)].length % 2).toBe(0)
  })
})

describe('branche déjà prise : suffixe proposé (M2)', () => {
  it('la même avec -2, -3… libre et valide', () => {
    const taken = new Set(['romain/42-export-csv-2'])
    expect(nextFreeBranch('romain/42-export-csv', (b) => taken.has(b))).toBe('romain/42-export-csv-3')
    expect(nextFreeBranch('feat-8', () => false)).toBe('feat-8-2')
    expect(nextFreeBranch('romain/', () => false)).toBe('romain-2')
    expect(nextFreeBranch('', () => false)).toBeNull()
    expect(nextFreeBranch('x', () => true)).toBeNull()
  })

  it('messages du démon et de git reconnus ; les autres non', () => {
    expect(branchTakenError('la branche « romain/42 » est déjà extraite dans /w/r-42')).toBe(true)
    expect(branchTakenError('le dossier existe déjà : /w/r-42')).toBe(true)
    expect(branchTakenError("fatal: a branch named 'x' already exists")).toBe(true)
    expect(branchTakenError("fatal: 'x' is already checked out at '/w'")).toBe(true)
    expect(branchTakenError('base inconnue : « origin/dev »')).toBe(false)
  })
})

describe('fichiers de l’empreinte d’un runner', () => {
  it('lecture tolérante ; avertissement et « Voir » selon l’état et le chemin', () => {
    expect(readRunnerFiles(undefined)).toBeNull()
    expect(readRunnerFiles([])).toEqual([])
    const f = readRunnerFiles([{ path: ' a.sh ', size: -1, state: 'ok', note: '' }, { path: '/etc/passwd', state: 'outside' }])!
    expect(f).toEqual([
      { path: 'a.sh', size: null, state: 'ok', note: null },
      { path: '/etc/passwd', size: null, state: 'outside', note: null },
    ])
    expect(f.map(riskyRunnerFile)).toEqual([false, true])
    expect(openableRunnerFile({ path: 'scripts/dev.sh', state: 'ok' })).toBe(true)
    expect(openableRunnerFile({ path: 'big.bin', state: 'too_large' })).toBe(true)
    for (const path of ['/etc/passwd', '../x', 'a/../../b', '~/x', 'file:x', 'a//b']) expect(openableRunnerFile({ path, state: 'ok' }), path).toBe(false)
    expect(openableRunnerFile({ path: 'a', state: 'absent' })).toBe(false)
    expect(openableRunnerFile({ path: 'a', state: 'unresolved' })).toBe(false)
  })
})
