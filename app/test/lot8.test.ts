/**
 * v0.3, lot 8 (finitions d'interface) : taille de l'interface (réglage,
 * migration, raccourcis, molette), import de thème, zone des demandes
 * réduite / rouverte, règles CSS de mise en page (dialogues, formulaires,
 * zone des demandes) qu'aucun moteur de mise en page ne vérifie ici.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { zoomKey, zoomShortcut, type KeyInput } from '../src/main/zoom'
import { ValidationError, validateZoomDirection } from '../src/main/validate'
import {
  DEFAULT_ZOOM,
  SettingsError,
  ZOOM_STEPS,
  applyPatch,
  defaultSettings,
  mergePatches,
  normalizeSettings,
  parseThemeImport,
  snapZoom,
  stepZoom,
  validatePatch,
  type ThemeSettings,
} from '../src/shared/settings'
import { dockReduced, pruneDock, reduceDock, requestKey, showDock } from '../src/renderer/src/state/askDock'
import { themeJson } from '../src/renderer/src/state/themeTokens'
import { WHEEL_ZOOM_INTERVAL_MS, WheelZoom } from '../src/renderer/src/state/wheelZoom'

describe('taille de l’interface : réglage', () => {
  it('par défaut 100 %, paliers de 80 à 200 %', () => {
    expect(defaultSettings().ui).toEqual({ zoom: 100, sessionTab: 'terminal', language: 'system' })
    expect(ZOOM_STEPS[0]).toBe(80)
    expect(ZOOM_STEPS[ZOOM_STEPS.length - 1]).toBe(200)
    expect([...ZOOM_STEPS].sort((a, b) => a - b)).toEqual([...ZOOM_STEPS])
  })

  it('migration : un fichier d’avant le lot 8 (sans « ui ») garde le reste et prend 100 %', () => {
    const s = normalizeSettings({ version: 1, view: 'statut', confirmRemoval: false })
    expect(s.ui.zoom).toBe(DEFAULT_ZOOM)
    expect(s.view).toBe('statut')
    expect(s.confirmRemoval).toBe(false)
  })

  it('lecture tolérante : valeur abîmée → 100 %, valeur entre deux paliers → le plus proche', () => {
    expect(normalizeSettings({ ui: { zoom: 150 } }).ui.zoom).toBe(150)
    expect(normalizeSettings({ ui: { zoom: '150' } }).ui.zoom).toBe(100)
    expect(normalizeSettings({ ui: { zoom: 1.5 } }).ui.zoom).toBe(100)
    expect(normalizeSettings({ ui: { zoom: 400 } }).ui.zoom).toBe(100)
    expect(normalizeSettings({ ui: { zoom: Number.NaN } }).ui.zoom).toBe(100)
    expect(normalizeSettings({ ui: 'grand' }).ui.zoom).toBe(100)
    expect(normalizeSettings({ ui: { zoom: 133 } }).ui.zoom).toBe(125)
    expect(normalizeSettings({ ui: { zoom: 112 } }).ui.zoom).toBe(110)
    expect(snapZoom(80)).toBe(80)
    expect(snapZoom(200)).toBe(200)
  })

  it('modification venue de la page : stricte (paliers seulement, champ inconnu refusé)', () => {
    expect(validatePatch({ ui: { zoom: 125 } })).toEqual({ ui: { zoom: 125 } })
    expect(() => validatePatch({ ui: { zoom: 130 } })).toThrow(SettingsError)
    expect(() => validatePatch({ ui: { zoom: '125' } })).toThrow(/ui\.zoom/)
    expect(() => validatePatch({ ui: { zoom: 125, police: 'grande' } })).toThrow(/ui\.police/)
    expect(() => validatePatch({ ui: 125 })).toThrow(/« ui »/)
  })

  it('application et fusion : la taille ne touche à rien d’autre, la dernière l’emporte', () => {
    const s = applyPatch(defaultSettings(), { ui: { zoom: 175 } })
    expect(s.ui.zoom).toBe(175)
    expect(s.theme).toEqual(defaultSettings().theme)
    expect(mergePatches({ ui: { zoom: 110 }, view: 'statut' }, { ui: { zoom: 150 } })).toEqual({ ui: { zoom: 150 }, view: 'statut' })
  })

  it('paliers : un de plus, un de moins, 100 % ; reste au bout de l’échelle', () => {
    expect(stepZoom(100, 'in')).toBe(110)
    expect(stepZoom(110, 'out')).toBe(100)
    expect(stepZoom(200, 'in')).toBe(200)
    expect(stepZoom(80, 'out')).toBe(80)
    expect(stepZoom(175, 'reset')).toBe(100)
    expect(stepZoom(133, 'in')).toBe(150)
  })
})

describe('taille de l’interface : raccourcis (processus principal)', () => {
  const key = (k: Partial<KeyInput>): KeyInput => ({ type: 'keyDown', key: '', code: '', control: true, meta: false, alt: false, ...k })

  it('Ctrl + = / + / − / 0, pavé numérique compris', () => {
    expect(zoomShortcut(key({ key: '=', code: 'Equal' }), 'linux')).toBe('in')
    expect(zoomShortcut(key({ key: '+', code: 'Equal' }), 'linux')).toBe('in')
    expect(zoomShortcut(key({ key: '+', code: 'NumpadAdd' }), 'linux')).toBe('in')
    expect(zoomShortcut(key({ key: '-', code: 'Minus' }), 'linux')).toBe('out')
    expect(zoomShortcut(key({ key: '-', code: 'NumpadSubtract' }), 'linux')).toBe('out')
    expect(zoomShortcut(key({ key: '0', code: 'Digit0' }), 'linux')).toBe('reset')
    expect(zoomShortcut(key({ key: '0', code: 'Numpad0' }), 'linux')).toBe('reset')
  })

  it('AZERTY : « - » sur la touche du 6, « à » sur celle du 0', () => {
    expect(zoomShortcut(key({ key: '-', code: 'Digit6' }), 'linux')).toBe('out')
    expect(zoomShortcut(key({ key: 'à', code: 'Digit0' }), 'linux')).toBe('reset')
  })

  it('rien sans Ctrl, avec Alt, au relâchement, ou pour une autre touche', () => {
    expect(zoomShortcut(key({ key: '=', control: false }), 'linux')).toBeNull()
    expect(zoomShortcut(key({ key: '=', alt: true }), 'linux')).toBeNull()
    expect(zoomShortcut(key({ key: '=', type: 'keyUp' }), 'linux')).toBeNull()
    expect(zoomShortcut(key({ key: 'c', code: 'KeyC' }), 'linux')).toBeNull()
    expect(zoomShortcut(key({ key: '6', code: 'Digit6' }), 'linux')).toBeNull()
  })

  it('macOS : Cmd au lieu de Ctrl', () => {
    expect(zoomShortcut(key({ key: '=', control: false, meta: true }), 'darwin')).toBe('in')
    expect(zoomShortcut(key({ key: '=' }), 'darwin')).toBeNull()
  })

  it('touche maintenue : interceptée (jamais envoyée au terminal) mais un seul palier par appui', () => {
    expect(zoomKey(key({ key: '=' }), 'linux')).toEqual({ intercept: true, step: 'in' })
    expect(zoomKey(key({ key: '=', isAutoRepeat: true }), 'linux')).toEqual({ intercept: true, step: null })
    expect(zoomKey(key({ key: 'c' }), 'linux')).toBeNull()
  })

  it('IPC de la molette : direction validée', () => {
    expect(validateZoomDirection('in')).toBe('in')
    expect(validateZoomDirection('reset')).toBe('reset')
    expect(() => validateZoomDirection('max')).toThrow(ValidationError)
    expect(() => validateZoomDirection(2)).toThrow(ValidationError)
  })
})

describe('taille de l’interface : Ctrl + molette', () => {
  it('vers le haut : plus grand ; vers le bas : plus petit ; sans Ctrl : rien', () => {
    expect(new WheelZoom().step({ ctrlKey: true, deltaY: -100 }, 0)).toBe('in')
    expect(new WheelZoom().step({ ctrlKey: true, deltaY: 3 }, 0)).toBe('out')
    expect(new WheelZoom().step({ ctrlKey: false, deltaY: -100 }, 0)).toBeNull()
    expect(new WheelZoom().step({ ctrlKey: true, deltaY: 0 }, 0)).toBeNull()
  })

  it('un palier au plus par intervalle (pavé tactile)', () => {
    const w = new WheelZoom()
    expect(w.step({ ctrlKey: true, deltaY: -1 }, 1000)).toBe('in')
    expect(w.step({ ctrlKey: true, deltaY: -1 }, 1000 + WHEEL_ZOOM_INTERVAL_MS - 1)).toBeNull()
    expect(w.step({ ctrlKey: true, deltaY: -1 }, 1000 + WHEEL_ZOOM_INTERVAL_MS)).toBe('in')
  })
})

describe('import de thème (JSON)', () => {
  const theme: ThemeSettings = {
    mode: 'dark',
    light: { palette: 'okabe', custom: { wait: '#111111' } },
    dark: { palette: 'contraste', custom: {} },
  }

  it('relit ce que « Copier le thème (JSON) » produit', () => {
    expect(parseThemeImport(themeJson(theme))).toEqual(theme)
  })

  it('couleurs normalisées en minuscules ; mode facultatif', () => {
    const t = parseThemeImport(JSON.stringify({ light: { palette: 'devmaestro', custom: { accent: '#ABCDEF' } }, dark: theme.dark }))
    expect(t.mode).toBeUndefined()
    expect(t.light.custom).toEqual({ accent: '#abcdef' })
  })

  it('ancien format (une palette pour les deux modes) : repris dans chaque mode', () => {
    expect(parseThemeImport(JSON.stringify({ mode: 'light', palette: 'okabe', custom: { dark: { err: '#010203' } } }))).toEqual({
      mode: 'light',
      light: { palette: 'okabe', custom: {} },
      dark: { palette: 'okabe', custom: { err: '#010203' } },
    })
    expect(parseThemeImport('{"palette":"contraste"}')).toEqual({
      light: { palette: 'contraste', custom: {} },
      dark: { palette: 'contraste', custom: {} },
    })
  })

  it.each([
    ['', /aucun thème/],
    ['   ', /aucun thème/],
    ['{ mode: dark }', /JSON invalide/],
    ['[1, 2]', /objet JSON/],
    ['"sombre"', /objet JSON/],
    ['{"mode":"dark","light":{"palette":"okabe","custom":{}}}', /« dark » manquant/],
    ['{"light":{"palette":"okabe"},"dark":{"palette":"okabe","custom":{}}}', /theme\.light\.custom » manquant/],
    ['{"light":{"palette":"violet","custom":{}},"dark":{"palette":"okabe","custom":{}}}', /theme\.light\.palette » inconnue/],
    ['{"light":{"palette":"okabe","custom":{"wait":"orange"}},"dark":{"palette":"okabe","custom":{}}}', /couleur invalide pour wait/],
    ['{"light":{"palette":"okabe","custom":{"fond":"#000000"}},"dark":{"palette":"okabe","custom":{}}}', /jeton de couleur inconnu : fond/],
    ['{"mode":"auto","light":{"palette":"okabe","custom":{}},"dark":{"palette":"okabe","custom":{}}}', /theme\.mode/],
    ['{"light":{"palette":"okabe","custom":{}},"dark":{"palette":"okabe","custom":{}},"police":"x"}', /réglage inconnu : theme\.police/],
    ['{"light":{"palette":"okabe","custom":{},"x":1},"dark":{"palette":"okabe","custom":{}}}', /theme\.light\.x/],
    ['{"palette":"violet"}', /« palette » inconnue/],
    ['{"palette":"okabe","custom":{"sepia":{}}}', /custom\.sepia/],
    ['{"palette":"okabe","custom":null}', /« custom » doit être un objet/],
    ['{"palette":"okabe","custom":[]}', /« custom » doit être un objet/],
    ['{"palette":"okabe","custom":{"light":{"wait":"#12"}}}', /couleur invalide pour wait/],
    ['{"palette":"okabe","zoom":2}', /champ inconnu : zoom/],
    ['{"palette":"okabe","light":{"palette":"okabe","custom":{}}}', /format mélangé/],
  ])('refuse %s avec un message précis', (text, message) => {
    expect(() => parseThemeImport(text)).toThrow(SettingsError)
    expect(() => parseThemeImport(text)).toThrow(message)
  })

  it('refuse un texte trop long avant de le lire', () => {
    const big = JSON.stringify({ ...theme, pad: 'x'.repeat(70 * 1024) })
    expect(() => parseThemeImport(big)).toThrow(/trop long/)
  })

  it('le thème importé est une modification valide des réglages', () => {
    const t = parseThemeImport(themeJson(theme))
    expect(applyPatch(defaultSettings(), validatePatch({ theme: t })).theme).toEqual(theme)
  })
})

describe('zone des demandes : réduite, rouverte', () => {
  const s = 'sess-a'
  const k1 = requestKey(s, 1)
  const k2 = requestKey(s, 2)

  it('ouverte par défaut, fermée sans demande', () => {
    expect(dockReduced(new Set(), [k1])).toBe(false)
    expect(dockReduced(new Set([k1]), [])).toBe(false)
  })

  it('« Réduire » puis « Afficher »', () => {
    const r = reduceDock(new Set(), [k1])
    expect(dockReduced(r, [k1])).toBe(true)
    expect(dockReduced(showDock(r, [k1]), [k1])).toBe(false)
  })

  it('une nouvelle demande rouvre la zone ; la précédente reste réduite pour elle-même', () => {
    const r = reduceDock(new Set(), [k1])
    expect(dockReduced(r, [k1, k2])).toBe(false)
    expect(r.has(k1)).toBe(true)
    expect(dockReduced(r, [k1])).toBe(true)
  })

  it('seules les demandes affichées sont gardées : closes, sessions quittées ou oubliées purgées', () => {
    const other = requestKey('sess-b', 1)
    const r = reduceDock(reduceDock(new Set(), [k1, k2]), [other])
    const p = pruneDock(r, [k2])
    expect([...p]).toEqual([k2])
    expect(pruneDock(p, [k2])).toBe(p)
    expect(pruneDock(p, [])).toEqual(new Set())
  })

  it('sans changement, le même ensemble (pas de rendu inutile)', () => {
    const r = reduceDock(new Set(), [k1])
    expect(reduceDock(r, [k1])).toBe(r)
    const empty = new Set<string>()
    expect(showDock(empty, [k1])).toBe(empty)
  })
})

describe('mise en page (règles CSS)', () => {
  const css = readFileSync(resolve(__dirname, '../src/renderer/src/styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  function decl(selector: string): Map<string, string> {
    const out = new Map<string, string>()
    const re = /([^{}]+)\{([^{}]*)\}/g
    for (let m = re.exec(css); m; m = re.exec(css)) {
      const selectors = m[1]!.split(',').map((x) => x.trim().replace(/\s+/g, ' '))
      if (!selectors.includes(selector)) continue
      for (const d of m[2]!.split(';')) {
        const i = d.indexOf(':')
        if (i > 0) out.set(d.slice(0, i).trim(), d.slice(i + 1).trim())
      }
    }
    return out
  }

  it('dialogue : la fenêtre ne défile pas (coins arrondis), seul le corps défile', () => {
    expect(decl('.modal').get('overflow')).toBe('hidden')
    expect(decl('.modal').get('flex-direction')).toBe('column')
    expect(decl('.modal .mb').get('overflow')).toBe('auto')
    expect(decl('.modal .mb').get('min-height')).toBe('0')
    expect(decl('.modal > form').get('min-height')).toBe('0')
    expect(decl('.modal > [role="tabpanel"]').get('min-height')).toBe('0')
  })

  it('formulaires : champs empilés depuis le haut, contrôles de même hauteur', () => {
    expect(decl('.field').get('align-content')).toBe('start')
    expect(decl('.field select').get('height')).toBe('var(--ctl-h)')
    expect(decl('.field input:not([type="checkbox"]):not([type="radio"]):not([type="color"]):not([type="file"])').get('height')).toBe('var(--ctl-h)')
  })

  it('zone des demandes vide : présente (région annoncée) avec une hauteur nulle, jamais display: none', () => {
    const empty = decl('.asks:empty')
    expect(empty.get('display')).toBeUndefined()
    expect(empty.get('height')).toBe('0')
  })

  it('zone des demandes : deuxième rangée du volet, plus de panneau flottant', () => {
    expect(decl('.sess > .term-panel').get('grid-template-rows')).toBe('minmax(0, 1fr) auto')
    const asks = decl('.asks')
    expect(asks.get('grid-area')).toBe('2 / 1')
    expect(asks.has('bottom')).toBe(false)
    expect(asks.get('position')).not.toBe('absolute')
    expect(decl('.asks-list').get('overflow')).toBe('auto')
    expect(decl('.asks-list[hidden]').get('display')).toBe('none')
  })
})
