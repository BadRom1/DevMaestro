import { describe, expect, it } from 'vitest'

import { STATUS_ORDER, glyphFor } from '../src/renderer/src/state/status'

describe('glyphes de statut', () => {
  it('chaque état a une forme et un libellé français', () => {
    expect(glyphFor({ state: 'waiting', wait: 'permission' })).toEqual({ kind: 'waiting', label: 'À répondre : permission' })
    expect(glyphFor({ state: 'waiting', wait: 'question' }).label).toBe('À répondre : question')
    expect(glyphFor({ state: 'waiting' }).label).toBe('À répondre')
    expect(glyphFor({ state: 'starting' })).toEqual({ kind: 'running', label: 'Démarrage' })
    expect(glyphFor({ state: 'running' })).toEqual({ kind: 'running', label: 'En cours' })
    expect(glyphFor({ state: 'idle' })).toEqual({ kind: 'idle', label: 'Inactive' })
    expect(glyphFor({ state: 'stopped', reason: 'stopped_by_app' })).toEqual({ kind: 'stopped', label: 'Arrêtée' })
    expect(glyphFor({ state: 'error' })).toEqual({ kind: 'error', label: 'Erreur' })
  })

  it('statut inconnu : cercle creux', () => {
    expect(glyphFor(null).kind).toBe('idle')
    expect(glyphFor({ state: 'bizarre' as never }).label).toBe('Statut inconnu')
  })

  it('à répondre en tête', () => {
    const kinds = Object.entries(STATUS_ORDER).sort((a, b) => a[1] - b[1]).map(([k]) => k)
    expect(kinds[0]).toBe('waiting')
    expect(kinds.at(-1)).toBe('stopped')
  })
})
