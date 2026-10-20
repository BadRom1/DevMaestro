import { describe, expect, it } from 'vitest'

import { pastDisplayName, sessionColor, sessionDisplayName, supportsNaming, truncateStart } from '../src/renderer/src/state/format'
import { session } from './fixtures'

const len = (s: string) => [...s].length

describe('troncature d’un chemin par le début', () => {
  const p = '~/workplace/perso/Orchestrateur'

  it('laisse intact un chemin qui tient', () => {
    expect(truncateStart(p, p.length)).toBe(p)
    expect(truncateStart(p, 200)).toBe(p)
    expect(truncateStart('/', 1)).toBe('/')
  })

  it('retire des segments entiers en tête', () => {
    expect(truncateStart(p, 30)).toBe('…/perso/Orchestrateur')
    expect(truncateStart(p, 21)).toBe('…/perso/Orchestrateur')
    expect(truncateStart(p, 20)).toBe('…/Orchestrateur')
    expect(truncateStart('/home/romain/workplace/perso/Orchestrateur', 25)).toBe('…/perso/Orchestrateur')
  })

  it('coupe le dernier segment s’il ne tient pas seul', () => {
    expect(truncateStart(p, 10)).toBe('…estrateur')
    expect(truncateStart(p, 2)).toBe('…r')
    expect(truncateStart(p, 1)).toBe('…')
    expect(truncateStart(p, 0)).toBe('')
  })

  it('ne dépasse jamais le budget', () => {
    const paths = [p, '/a/b/c/d', '/très/long/chemin/avec/des/accents/éèà', '~/x', 'sans-barre-oblique-du-tout']
    for (const path of paths) {
      for (let max = 0; max <= len(path) + 2; max++) {
        const r = truncateStart(path, max)
        expect(len(r)).toBeLessThanOrEqual(Math.max(max, 0))
        if (len(path) <= max) expect(r).toBe(path)
        else if (max > 0) expect(r.startsWith('…')).toBe(true)
      }
    }
  })

  it('compte en caractères, pas en unités UTF-16', () => {
    expect(truncateStart('/a/😀😀', 4)).toBe('…/😀😀')
  })
})

describe('nom affiché d’une session', () => {
  it('prend celui du démon', () => {
    expect(sessionDisplayName(session({ display_name: 'Refonte', title: null }))).toBe('Refonte')
  })

  it('se replie avec un démon plus ancien', () => {
    const s = session({ metrics: { session_name: 'nom-claude' } })
    expect(supportsNaming(s)).toBe(false)
    expect(sessionDisplayName(s)).toBe('nom-claude')
    expect(sessionDisplayName({ ...s, title: '  Mon titre ' })).toBe('Mon titre')
    expect(sessionDisplayName(session({ branch: 'feat/x' }))).toBe('feat/x')
    expect(sessionDisplayName(session({ branch: null, cwd: '/home/u/code/outil' }))).toBe('outil')
    expect(sessionDisplayName(session({ id: 'abcdef12-0000-4000-8000-000000000000', branch: null, cwd: '' }))).toBe('abcdef12')
    expect(supportsNaming(session({ display_name: 'x' }))).toBe(true)
  })

  it('anciennes sessions : display_name, titre, premier prompt, identifiant', () => {
    const base = { claude_session_id: '12345678-aaaa', title: null, first_prompt: null }
    expect(pastDisplayName({ ...base, display_name: 'D', title: 'T' })).toBe('D')
    expect(pastDisplayName({ ...base, title: 'T', first_prompt: 'P' })).toBe('T')
    expect(pastDisplayName({ ...base, first_prompt: 'P' })).toBe('P')
    expect(pastDisplayName(base)).toBe('12345678')
  })

  it('n’accepte que les couleurs de la palette', () => {
    expect(sessionColor(session({ color: 'bleu' }))).toBe('bleu')
    expect(sessionColor(session({ color: null }))).toBeNull()
    expect(sessionColor({ color: 'fuchsia' as never })).toBeNull()
  })
})
