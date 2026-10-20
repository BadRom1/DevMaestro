/**
 * Lot 7 (édition de fichiers), logique pure : validation de `files.write`,
 * état de l'édition (modifié, conflit, écrasement, rechargement), fins de
 * ligne, diff par lignes et garde avant de quitter.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ValidationError, validateParams } from '../src/main/validate'
import { MAX_FILE_WRITE_BYTES, type FileContent, type FileVersion } from '../src/shared/protocol'
import { diffRows } from '../src/renderer/src/state/diff'
import {
  canEdit,
  canOverwrite,
  conflictVersion,
  editReducer,
  editable,
  eolStyle,
  normalizeEol,
  notEditableReason,
  expectedFor,
  type Edit,
  type EditAction,
} from '../src/renderer/src/state/fileEdit'
import { invisibleDifference, lineDiff, splitLines } from '../src/renderer/src/state/lineDiff'
import {
  cancelLeave,
  confirmLeave,
  guardLeave,
  hasUnsaved,
  pendingLeave,
  resetUnsaved,
  setUnsaved,
  subscribeLeave,
  unsavedPath,
  unsavedVersion,
} from '../src/renderer/src/state/unsaved'

const ID = '0c69fdc4-b2c9-4511-97c8-bb78d2323d61'
const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)
const SHA_C = 'c'.repeat(64)
const V_A: FileVersion = { size: 3, mtime_ns: 1, sha256: SHA_A }
const V_B: FileVersion = { size: 4, mtime_ns: 2, sha256: SHA_B }
const V_C: FileVersion = { size: 5, mtime_ns: 3, sha256: SHA_C }

describe('validation de files.write', () => {
  const ok = { id: ID, path: 'src/main.rs', content: 'fn main() {}\n', expected: { sha256: SHA_A } }

  it('nettoie : champs inconnus retirés, y compris dans expected', () => {
    expect(validateParams('files.write', { ...ok, extra: 1, expected: { sha256: SHA_A, size: 3 } })).toEqual(ok)
  })

  it('expected null (création) et contenu vide acceptés', () => {
    expect(validateParams('files.write', { ...ok, expected: null, content: '' })).toEqual({ ...ok, expected: null, content: '' })
  })

  it('2 Mio d’UTF-8 au plus, comptés en octets', () => {
    const max = 'a'.repeat(MAX_FILE_WRITE_BYTES)
    expect(validateParams('files.write', { ...ok, content: max }).content).toBe(max)
    expect(() => validateParams('files.write', { ...ok, content: max + 'a' })).toThrow(/2 Mio/)
    // « é » : 2 octets ; moitié de la limite en caractères + 1 → au-delà en octets.
    const accents = 'é'.repeat(MAX_FILE_WRITE_BYTES / 2)
    expect(validateParams('files.write', { ...ok, content: accents }).content).toBe(accents)
    expect(() => validateParams('files.write', { ...ok, content: accents + 'é' })).toThrow(/2 Mio/)
  })

  it('refuse chemins absolus ou non normalisés, contenus et empreintes invalides', () => {
    const bad: unknown[] = [
      { ...ok, id: 'x' },
      { ...ok, path: '/etc/passwd' },
      { ...ok, path: '../hors' },
      { ...ok, path: 'a/../../b' },
      { ...ok, path: 'a//b' },
      { ...ok, path: './a' },
      { ...ok, path: 'a/' },
      { ...ok, path: '' },
      { ...ok, path: 'a\0b' },
      { ...ok, content: 3 },
      { ...ok, content: null },
      { ...ok, content: 'x\uD800y' },
      { ...ok, content: '\uDC00' },
      { id: ID, path: 'a', content: 'x' },
      { ...ok, expected: undefined },
      { ...ok, expected: 'abc' },
      { ...ok, expected: [] },
      { ...ok, expected: {} },
      { ...ok, expected: { sha256: SHA_A.toUpperCase() } },
      { ...ok, expected: { sha256: SHA_A.slice(1) } },
      { ...ok, expected: { sha256: 'g'.repeat(64) } },
    ]
    for (const p of bad) expect(() => validateParams('files.write', p), JSON.stringify(p)?.slice(0, 80)).toThrow(ValidationError)
  })

  it('paires de substitution valides (émoji) acceptées', () => {
    expect(validateParams('files.write', { ...ok, content: 'ok 🎉\n' }).content).toBe('ok 🎉\n')
  })
})

const run = (actions: EditAction[], from: Edit = null): Edit => actions.reduce(editReducer, from)
const begin: EditAction = { type: 'begin', path: 'a.txt', content: 'abc', version: V_A }

describe('état de l’édition', () => {
  it('Modifier, saisie, enregistrement : retour en lecture', () => {
    const e = run([begin, { type: 'change', dirty: true }])
    expect(e).toMatchObject({ phase: 'editing', dirty: true, base: 'abc' })
    const saving = editReducer(e, { type: 'save' })
    expect(saving?.phase).toBe('saving')
    expect(expectedFor(saving)).toEqual({ sha256: SHA_A })
    expect(editable(saving)).toBe(false)
    expect(editReducer(saving, { type: 'saved' })).toBeNull()
  })

  it('revenir au texte d’origine : plus modifié', () => {
    expect(run([begin, { type: 'change', dirty: true }, { type: 'change', dirty: false }])?.dirty).toBe(false)
  })

  it('échec hors conflit : édition reprise avec le message', () => {
    const e = run([begin, { type: 'change', dirty: true }, { type: 'save' }, { type: 'failed', error: 'disque plein' }])
    expect(e).toMatchObject({ phase: 'editing', error: 'disque plein', dirty: true })
    expect(editReducer(e, { type: 'save' })?.error).toBeNull()
  })

  it('conflit : version actuelle, puis contenu relu ; écrasement après seconde confirmation', () => {
    let e = run([begin, { type: 'change', dirty: true }, { type: 'save' }, { type: 'conflict', version: V_B }])
    expect(e).toMatchObject({ phase: 'conflict', conflict: { version: V_B, content: null } })
    expect(editable(e)).toBe(true)
    e = editReducer(e, { type: 'currentLoaded', content: 'abcd', version: V_B })
    expect(e?.conflict?.content).toBe('abcd')
    // Pas d'écriture sans la seconde confirmation.
    expect(editReducer(e, { type: 'overwrite' })).toBe(e)
    e = editReducer(e, { type: 'askOverwrite' })
    expect(e?.phase).toBe('confirmOverwrite')
    expect(editable(e)).toBe(false)
    expect(editReducer(e, { type: 'cancelOverwrite' })?.phase).toBe('conflict')
    e = editReducer(e, { type: 'overwrite' })
    expect(e?.phase).toBe('overwriting')
    // Écrasement : empreinte actuelle, pas celle de la version ouverte.
    expect(expectedFor(e)).toEqual({ sha256: SHA_B })
    expect(editReducer(e, { type: 'saved' })).toBeNull()
  })

  it('écrasement refusé à son tour (fichier encore changé) : nouveau conflit avec la nouvelle version', () => {
    const e = run([
      begin,
      { type: 'change', dirty: true },
      { type: 'save' },
      { type: 'conflict', version: V_B },
      { type: 'askOverwrite' },
      { type: 'overwrite' },
      { type: 'conflict', version: V_C },
    ])
    expect(e).toMatchObject({ phase: 'conflict', conflict: { version: V_C, content: null } })
  })

  it('version actuelle inconnue : pas d’écrasement tant qu’elle n’est pas relue', () => {
    let e = run([begin, { type: 'change', dirty: true }, { type: 'save' }, { type: 'conflict', version: undefined }])
    expect(canOverwrite(e)).toBe(false)
    expect(editReducer(e, { type: 'askOverwrite' })).toBe(e)
    e = editReducer(e, { type: 'currentLoaded', content: 'x', version: V_C })
    expect(canOverwrite(e)).toBe(true)
  })

  it('fichier disparu (version null) : écrasement = recréation (expected null)', () => {
    const e = run([begin, { type: 'change', dirty: true }, { type: 'save' }, { type: 'conflict', version: null }, { type: 'askOverwrite' }, { type: 'overwrite' }])
    expect(e?.phase).toBe('overwriting')
    expect(expectedFor(e)).toBeNull()
  })

  it('relecture impossible pendant le conflit : message gardé', () => {
    const e = run([begin, { type: 'save' }, { type: 'conflict', version: V_B }, { type: 'currentFailed', error: 'illisible' }])
    expect(e?.conflict?.loadError).toBe('illisible')
  })

  it('Recharger : la version actuelle devient la version ouverte, modifications perdues', () => {
    const e = run([begin, { type: 'change', dirty: true }, { type: 'save' }, { type: 'conflict', version: V_B }, { type: 'reload', content: 'abcd', version: V_B }])
    expect(e).toMatchObject({ phase: 'editing', base: 'abcd', version: V_B, dirty: false, conflict: null, diskChanged: false })
  })

  it('changement vu sur le disque pendant l’édition : signalé, puis effacé si l’empreinte revient', () => {
    let e = run([begin, { type: 'diskSeen', sha256: SHA_B }])
    expect(e?.diskChanged).toBe(true)
    e = editReducer(e, { type: 'diskSeen', sha256: SHA_A })
    expect(e?.diskChanged).toBe(false)
  })

  it('Annuler : retour en lecture ; actions sans effet hors de leur phase', () => {
    expect(run([begin, { type: 'cancel' }])).toBeNull()
    const e = run([begin])
    expect(editReducer(e, { type: 'saved' })).toBe(e)
    expect(editReducer(e, { type: 'conflict', version: V_B })).toBe(e)
    expect(editReducer(e, { type: 'failed', error: 'x' })).toBe(e)
    expect(editReducer(null, { type: 'save' })).toBeNull()
    expect(expectedFor(e)).toBeUndefined()
  })

  it('modifiable seulement : texte entier lu, avec empreinte, pas un lien', () => {
    const c: FileContent = { path: 'a', size: 3, binary: false, too_large: false, content: 'abc', version: V_A }
    expect(canEdit(c, false)).toBe(true)
    expect(canEdit(c, true)).toBe(false)
    expect(canEdit({ ...c, version: undefined }, false)).toBe(false)
    expect(canEdit({ ...c, version: { size: 1, mtime_ns: 1, sha256: 'court' } }, false)).toBe(false)
    expect(canEdit({ ...c, binary: true, content: null }, false)).toBe(false)
    expect(canEdit({ ...c, too_large: true, content: null }, false)).toBe(false)
    expect(canEdit(null, false)).toBe(false)
    // Avis du démon : prioritaire quand il est donné.
    expect(canEdit({ ...c, editable: true }, false)).toBe(true)
    expect(canEdit({ ...c, editable: false, not_editable_reason: 'fichier en lecture seule' }, false)).toBe(false)
  })

  it('refus du démon : raison montrée sur un « Modifier » désactivé (seulement si le démon sait éditer)', () => {
    const c: FileContent = { path: 'a', size: 3, binary: true, too_large: false, content: null, version: V_A, editable: false, not_editable_reason: 'fichier binaire' }
    expect(notEditableReason(c)).toBe('fichier binaire')
    expect(notEditableReason({ ...c, not_editable_reason: null })).toMatch(/ne peut pas être modifié/)
    expect(notEditableReason({ ...c, version: null, too_large: true })).toBe('fichier binaire')
    expect(notEditableReason({ ...c, version: undefined })).toBeNull()
    expect(notEditableReason({ ...c, editable: true })).toBeNull()
    expect(notEditableReason({ ...c, editable: undefined })).toBeNull()
  })

  it('données d’un conflit : version, fichier disparu, ou inconnue', () => {
    expect(conflictVersion({ version: V_B })).toEqual(V_B)
    expect(conflictVersion({ version: null })).toBeNull()
    expect(conflictVersion({})).toBeUndefined()
    expect(conflictVersion({ version: { sha256: 'x' } })).toBeUndefined()
    expect(conflictVersion(undefined)).toBeUndefined()
  })

  it('fins de ligne : LF, CRLF, mélangées', () => {
    expect(eolStyle('a\nb\n')).toBe('lf')
    expect(eolStyle('')).toBe('lf')
    expect(eolStyle('a\r\nb\r\n')).toBe('crlf')
    expect(eolStyle('a\r\nb\n')).toBe('mixed')
    expect(eolStyle('a\rb')).toBe('mixed')
    expect(eolStyle('a\r\n\rb')).toBe('mixed')
  })
})

describe('diff par lignes', () => {
  it('identiques : aucun hunk', () => {
    expect(lineDiff('a\nb\n', 'a\nb\n')).toMatchObject({ identical: true, approximate: false, diff: { hunks: [] } })
  })

  it('une ligne changée au milieu : un hunk avec 3 lignes de contexte et numéros', () => {
    const before = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].join('\n') + '\n'
    const after = before.replace('5\n', 'cinq\n')
    const r = lineDiff(before, after)
    expect(r.diff.hunks).toHaveLength(1)
    const h = r.diff.hunks[0]!
    expect(h.header).toBe('@@ -2,7 +2,7 @@')
    expect(h.lines.map((l) => `${l.kind}${l.text}`)).toEqual([' 2', ' 3', ' 4', '-5', '+cinq', ' 6', ' 7', ' 8'])
    expect(h.lines.find((l) => l.kind === '-')).toMatchObject({ old_no: 5, new_no: null })
    expect(h.lines.find((l) => l.kind === '+')).toMatchObject({ old_no: null, new_no: 5 })
    // Passe par le modèle du lecteur de diff.
    expect(diffRows(r.diff).filter((x) => x.type === 'line')).toHaveLength(8)
  })

  it('changements éloignés : deux hunks ; proches : un seul', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `l${i + 1}`)
    const far = [...lines]
    far[2] = 'X'
    far[25] = 'Y'
    expect(lineDiff(lines.join('\n'), far.join('\n')).diff.hunks).toHaveLength(2)
    const near = [...lines]
    near[2] = 'X'
    near[8] = 'Y'
    expect(lineDiff(lines.join('\n'), near.join('\n')).diff.hunks).toHaveLength(1)
  })

  it('ajouts et suppressions : diff minimal, appliqué il redonne le texte', () => {
    const a = 'a\nb\nc\nd\ne\nf\n'
    const b = 'a\nc\nd\nX\ne\nf\nY\n'
    const r = lineDiff(a, b)
    const changed = r.diff.hunks.flatMap((h) => h.lines.filter((l) => l.kind !== ' ').map((l) => `${l.kind}${l.text}`))
    expect(changed).toEqual(['-b', '+X', '+Y'])
    expect(apply(a, r)).toEqual(splitLines(b))
  })

  it('fichier vide vers texte, et texte vers vide', () => {
    expect(lineDiff('', 'a\nb\n').diff.hunks[0]).toMatchObject({ header: '@@ -0,0 +1,2 @@' })
    expect(lineDiff('a\nb\n', '').diff.hunks[0]).toMatchObject({ header: '@@ -1,2 +0,0 @@' })
  })

  it('CRLF : le \\r n’apparaît pas et ne crée pas de différence avec LF', () => {
    expect(lineDiff('a\r\nb\r\n', 'a\nb\n').identical).toBe(true)
  })

  it('trop de différences : diff en bloc, signalé, toujours exact', () => {
    const a = Array.from({ length: 50 }, (_, i) => `a${i}`).join('\n')
    const b = Array.from({ length: 50 }, (_, i) => (i % 2 ? `a${i}` : `b${i}`)).join('\n')
    const r = lineDiff(a, b, { maxDistance: 10 })
    expect(r.approximate).toBe(true)
    expect(apply(a, r)).toEqual(splitLines(b))
    const exact = lineDiff(a, b)
    expect(exact.approximate).toBe(false)
    expect(apply(a, exact)).toEqual(splitLines(b))
  })

  it('aléatoire : le diff appliqué redonne toujours la cible', () => {
    let seed = 7
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    for (let t = 0; t < 200; t++) {
      const a = Array.from({ length: rnd(15) }, () => 'abcde'[rnd(5)]!)
      const b = Array.from({ length: rnd(15) }, () => 'abcde'[rnd(5)]!)
      const r = lineDiff(a.join('\n'), b.join('\n'), { context: 1000 })
      expect(apply(a.join('\n'), r)).toEqual(b)
    }
  })
})

/** Applique un diff (contexte complet ou non) à `before` : lignes de la nouvelle version. */
function apply(before: string, r: ReturnType<typeof lineDiff>): string[] {
  const src = splitLines(before)
  const out: string[] = []
  let i = 0
  for (const h of r.diff.hunks) {
    const start = h.old_lines === 0 ? h.old_start : h.old_start - 1
    while (i < start) out.push(src[i++]!)
    for (const l of h.lines) {
      if (l.kind === ' ') {
        expect(src[i]).toBe(l.text)
        out.push(src[i++]!)
      } else if (l.kind === '-') {
        expect(src[i]).toBe(l.text)
        i++
      } else out.push(l.text)
    }
  }
  while (i < src.length) out.push(src[i++]!)
  return out
}

describe('garde avant de quitter', () => {
  afterEach(() => resetUnsaved())

  it('rien de modifié : la navigation se fait tout de suite', () => {
    const go = vi.fn()
    guardLeave(ID, 'changer d’onglet', go)
    expect(go).toHaveBeenCalledOnce()
    expect(pendingLeave()).toBeNull()
  })

  it('modifié : navigation en attente ; « Rester » l’oublie', () => {
    setUnsaved(ID, 'src/a.ts')
    const go = vi.fn()
    const seen = vi.fn()
    const off = subscribeLeave(seen)
    guardLeave(ID, 'changer de session', go)
    expect(go).not.toHaveBeenCalled()
    expect(pendingLeave()).toMatchObject({ path: 'src/a.ts', action: 'changer de session' })
    cancelLeave()
    expect(go).not.toHaveBeenCalled()
    expect(pendingLeave()).toBeNull()
    expect(unsavedPath(ID)).toBe('src/a.ts')
    expect(seen).toHaveBeenCalledTimes(2)
    off()
  })

  it('« Abandonner mes modifications » : modifications oubliées puis navigation', () => {
    setUnsaved(ID, 'src/a.ts')
    const go = vi.fn(() => expect(hasUnsaved()).toBe(false))
    guardLeave(null, 'changer de vue', go)
    confirmLeave()
    expect(go).toHaveBeenCalledOnce()
    expect(hasUnsaved()).toBe(false)
  })

  it('autre session sans modification : pas de confirmation ; fermeture : toutes les sessions comptent', () => {
    setUnsaved(ID, 'a')
    const go = vi.fn()
    guardLeave('00000000-0000-4000-8000-000000000001', 'changer d’onglet', go)
    expect(go).toHaveBeenCalledOnce()
    expect(hasUnsaved()).toBe(true)
    setUnsaved(ID, null)
    expect(hasUnsaved()).toBe(false)
  })
})

describe('corrections après relecture', () => {
  afterEach(() => resetUnsaved())

  it('fins de ligne normalisées au style du fichier', () => {
    expect(normalizeEol('a\nb\rc\r\nd', 'crlf')).toBe('a\r\nb\r\nc\r\nd')
    expect(normalizeEol('a\r\nb\rc\nd', 'lf')).toBe('a\nb\nc\nd')
    expect(normalizeEol('a\r\n', 'crlf')).toBe('a\r\n')
  })

  it('diff vide mais textes différents : fins de ligne ou saut de ligne final précisés', () => {
    expect(invisibleDifference('a\n', 'a\n')).toBeNull()
    expect(invisibleDifference('a\nb\n', 'a\r\nb\r\n')).toMatch(/fins de ligne diffèrent \(LF → CRLF\)/)
    expect(invisibleDifference('a\nb', 'a\nb\n')).toMatch(/saut de ligne final diffère \(absent → présent\)/)
    expect(invisibleDifference('a', 'a\n')).toMatch(/saut de ligne final/)
  })

  it('« Abandonner » ne retire que la session concernée, et signale le retrait (version du registre)', () => {
    const OTHER = '00000000-0000-4000-8000-000000000009'
    setUnsaved(ID, 'a')
    setUnsaved(OTHER, 'b')
    const v = unsavedVersion()
    guardLeave(ID, 'x', () => undefined)
    confirmLeave()
    expect(unsavedPath(ID)).toBeNull()
    expect(unsavedPath(OTHER)).toBe('b')
    expect(unsavedVersion()).toBe(v + 1)
    // Une simple inscription ne change pas la version (pas de boucle avec la vue qui s'inscrit).
    setUnsaved(ID, 'a')
    expect(unsavedVersion()).toBe(v + 1)
  })
})
