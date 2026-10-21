/**
 * Vue conversation (v0.3, lots 11 et 12) : validation IPC des nouvelles
 * méthodes, relais de la notification, fusion des notifications, prompts en
 * attente, historique, fenêtre virtualisée, défilement collé, formes libres,
 * réglage de l'onglet par défaut.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { MAX_PROMPT_BYTES, ValidationError, validateParams } from '../src/main/validate'
import type { ConversationEntry, ConversationPage, PromptEntry } from '../src/shared/protocol'
import { RENDERER_METHODS } from '../src/shared/protocol'
import { applyPatch, defaultSettings, normalizeSettings, validatePatch } from '../src/shared/settings'
import {
  activityLabel,
  clipText,
  conversationReducer,
  estimateHeight,
  formatElapsed,
  historyStep,
  initialConversation,
  isAtBottom,
  layoutOffsets,
  patchHunks,
  promptMatches,
  promptProblem,
  promptWithPastes,
  settleDelay,
  SETTLE_GRACE_MS,
  SETTLE_IDLE_MS,
  threadOf,
  pushHistory,
  questionViews,
  reconcilePending,
  toolStatus,
  upsertEntries,
  visibleRange,
  type ConversationState,
} from '../src/renderer/src/state/conversation'
import { normalizeTranscript } from './conversation-fixture'

const ID = '0c69fdc4-b2c9-4511-97c8-bb78d2323d61'

const text = (uid: string, markdown: string, segment = 0): ConversationEntry => ({ uid, kind: 'text', ts: null, segment, markdown })
const prompt = (uid: string, t: string, over: Partial<PromptEntry> = {}): PromptEntry => ({
  uid,
  kind: 'prompt',
  ts: null,
  segment: 0,
  text: t,
  source: 'typed',
  pasted: [],
  ...over,
})
const page = (entries: ConversationEntry[], has_more = false): ConversationPage => ({
  segments: [{ segment: 0, claude_session_id: 'c', reason: 'start', started_at: null }],
  entries,
  has_more,
  invalid_lines: 0,
})
const ready = (entries: ConversationEntry[], over: Partial<ConversationState> = {}): ConversationState =>
  ({ ...conversationReducer(initialConversation, { type: 'loaded', page: page(entries) }), ...over })

describe('validation IPC de la vue conversation', () => {
  it('ouvre les quatre méthodes à la page', () => {
    for (const m of ['conversation.get', 'conversation.subagent', 'conversation.full', 'sessions.sendPrompt'] as const) {
      expect(RENDERER_METHODS).toContain(m)
    }
  })

  it('conversation.get : uuid, curseur et limite bornée, champs inconnus retirés', () => {
    expect(validateParams('conversation.get', { id: ID, x: 1 })).toEqual({ id: ID })
    expect(validateParams('conversation.get', { id: ID, before: 'e3c00d1d-f358-46f0-a834-6a4ebec541a3', limit: 1000 })).toEqual({
      id: ID,
      before: 'e3c00d1d-f358-46f0-a834-6a4ebec541a3',
      limit: 1000,
    })
    expect(validateParams('conversation.get', { id: ID, before: 'msg_01:tool#2' }).before).toBe('msg_01:tool#2')
    for (const bad of [
      { id: 'x' },
      { id: ID, limit: 0 },
      { id: ID, limit: 1001 },
      { id: ID, limit: 2.5 },
      { id: ID, before: '' },
      { id: ID, before: 'a b' },
      { id: ID, before: '../../etc' },
      { id: ID, before: 'x'.repeat(257) },
      { id: ID, before: 3 },
    ]) {
      expect(() => validateParams('conversation.get', bad), JSON.stringify(bad)).toThrow(ValidationError)
    }
  })

  it('conversation.subagent : agent_id de Claude Code obligatoire', () => {
    expect(validateParams('conversation.subagent', { id: ID, agent_id: 'a413854c8aebbc6cf', limit: 50 })).toEqual({
      id: ID,
      agent_id: 'a413854c8aebbc6cf',
      limit: 50,
    })
    expect(() => validateParams('conversation.subagent', { id: ID })).toThrow(ValidationError)
    expect(() => validateParams('conversation.subagent', { id: ID, agent_id: 'a/../b' })).toThrow(ValidationError)
    expect(() => validateParams('conversation.subagent', { id: ID, agent_id: 'x'.repeat(129) })).toThrow(ValidationError)
  })

  it('conversation.full : uid et part parmi input, result, text', () => {
    expect(validateParams('conversation.full', { id: ID, uid: 'u1', part: 'result' })).toEqual({ id: ID, uid: 'u1', part: 'result' })
    expect(() => validateParams('conversation.full', { id: ID, uid: 'u1', part: 'raw' })).toThrow(ValidationError)
    expect(() => validateParams('conversation.full', { id: ID, part: 'text' })).toThrow(ValidationError)
  })

  it('sessions.sendPrompt : texte non vide, 256 Kio d’UTF-8 au plus, sans caractère nul', () => {
    expect(validateParams('sessions.sendPrompt', { id: ID, text: '/compact' })).toEqual({ id: ID, text: '/compact' })
    expect(validateParams('sessions.sendPrompt', { id: ID, text: 'a\nb' }).text).toBe('a\nb')
    expect(validateParams('sessions.sendPrompt', { id: ID, text: 'é'.repeat(MAX_PROMPT_BYTES / 2) }).text).toHaveLength(MAX_PROMPT_BYTES / 2)
    for (const bad of [
      { id: ID, text: '' },
      { id: ID, text: '  \n\t' },
      { id: ID, text: 3 },
      { id: ID },
      { id: ID, text: 'a\0b' },
      { id: ID, text: 'a'.repeat(MAX_PROMPT_BYTES + 1) },
      // 2 octets par « é » : sous la limite en caractères, au-delà en octets.
      { id: ID, text: 'é'.repeat(MAX_PROMPT_BYTES / 2 + 1) },
      { id: 'pas-un-uuid', text: 'ok' },
    ]) {
      expect(() => validateParams('sessions.sendPrompt', bad), JSON.stringify(bad).slice(0, 60)).toThrow(ValidationError)
    }
  })

  it('le processus principal relaie conversation.changed à la page', () => {
    const src = readFileSync(resolve(__dirname, '../src/main/index.ts'), 'utf8')
    const relay = src.slice(src.indexOf("client.on('notification'"), src.indexOf("client.on('connected'"))
    expect(relay).toContain("n.method === 'conversation.changed'")
  })
})

describe('fusion des notifications', () => {
  it('un upsert d’un uid connu remplace l’entrée, un nouveau s’ajoute à la fin', () => {
    const base = [text('a', 'un'), text('b', 'deux')]
    const out = upsertEntries(base, [text('b', 'deux bis'), text('c', 'trois')])
    expect(out.map((e) => [e.uid, (e as { markdown: string }).markdown])).toEqual([
      ['a', 'un'],
      ['b', 'deux bis'],
      ['c', 'trois'],
    ])
    expect(upsertEntries(base, [])).toBe(base)
    // Entrée abîmée ignorée.
    expect(upsertEntries(base, [{ kind: 'text' } as unknown as ConversationEntry])).toBe(base)
  })

  it('ordre du lot du démon : une entrée nouvelle se range avant l’entrée connue qui la suit dans le lot', () => {
    const cmd: ConversationEntry = { uid: 'cmd', kind: 'command', ts: null, segment: 0, name: '/compact', args: null, output: null }
    const compaction: ConversationEntry = { uid: 'cp', kind: 'compaction', ts: null, segment: 0, trigger: 'manual', pre_tokens: 1, post_tokens: 1, summary: null }
    let s = ready([text('a', 'un'), compaction])
    s = conversationReducer(s, { type: 'changed', upserts: [cmd, { ...compaction, summary: 'résumé' }] })
    expect(s.entries.map((e) => e.uid)).toEqual(['a', 'cmd', 'cp'])
    expect((s.entries[2] as { summary: string }).summary).toBe('résumé')
  })

  it('ordre du lot : une ancienne entrée mise à jour dans le lot ne fait pas insérer la nouvelle au milieu du fil', () => {
    const base = [text('a', 'un'), text('b', 'deux'), text('c', 'trois')]
    expect(upsertEntries(base, [text('a', 'un bis'), text('x', 'x')]).map((e) => e.uid)).toEqual(['a', 'b', 'c', 'x'])
    // Plusieurs nouvelles devant une connue : rangées devant elle, dans l'ordre du lot ; rien de connu après : à la fin.
    expect(upsertEntries(base, [text('x', 'x'), text('y', 'y'), text('c', 'trois'), text('z', 'z')]).map((e) => e.uid)).toEqual([
      'a',
      'b',
      'x',
      'y',
      'c',
      'z',
    ])
    expect(upsertEntries(base, [text('m', 'm'), text('n', 'n')]).map((e) => e.uid)).toEqual(['a', 'b', 'c', 'm', 'n'])
  })

  it('pendant le chargement : la commande arrivée avec sa compaction se range aussi avant elle', () => {
    const cmd: ConversationEntry = { uid: 'cmd', kind: 'command', ts: null, segment: 0, name: '/compact', args: null, output: null }
    const compaction: ConversationEntry = { uid: 'cp', kind: 'compaction', ts: null, segment: 0, trigger: 'auto', pre_tokens: 1, post_tokens: 1, summary: null }
    let s = conversationReducer(initialConversation, { type: 'reload' })
    s = conversationReducer(s, { type: 'changed', upserts: [cmd, compaction] })
    s = conversationReducer(s, { type: 'loaded', page: page([text('a', 'un'), compaction]) })
    expect(s.entries.map((e) => e.uid)).toEqual(['a', 'cmd', 'cp'])
  })

  it('résultat d’outil qui complète l’appel : même place dans le fil', () => {
    const tool: ConversationEntry = { uid: 't', kind: 'tool', ts: null, segment: 0, tool_use_id: 'x', name: 'Bash', summary: 'ls', input: {} }
    let s = ready([prompt('p', 'go'), tool, text('z', 'fin')])
    s = conversationReducer(s, { type: 'changed', upserts: [{ ...tool, result: { status: 'ok', text: 'a\nb', truncated: false } }] })
    expect(s.entries.map((e) => e.uid)).toEqual(['p', 't', 'z'])
    expect((s.entries[1] as { result?: { text: string } }).result?.text).toBe('a\nb')
  })

  it('les notifications reçues pendant le chargement sont appliquées après la première page', () => {
    let s = conversationReducer(initialConversation, { type: 'reload' })
    s = conversationReducer(s, { type: 'changed', upserts: [text('b', 'deux bis'), text('c', 'trois')] })
    expect(s.entries).toEqual([])
    s = conversationReducer(s, { type: 'loaded', page: page([text('a', 'un'), text('b', 'deux')]) })
    expect(s.entries.map((e) => e.uid)).toEqual(['a', 'b', 'c'])
    expect((s.entries[1] as { markdown: string }).markdown).toBe('deux bis')
    expect(s.buffered).toEqual([])
  })

  it('segment ouvert par /clear : ajouté et trié ; entrées des sous-agents hors du fil principal', () => {
    let s = ready([text('a', 'un')])
    s = conversationReducer(s, {
      type: 'changed',
      upserts: [text('b', 'après clear', 1), { ...text('sa', 'agent'), agent_id: 'a1' }],
      segment: { segment: 1, claude_session_id: 'c2', reason: 'clear', started_at: null },
    })
    expect(s.entries.map((e) => e.uid)).toEqual(['a', 'b'])
    // L'entrée `subagent` porte l'agent qu'elle lance : elle reste dans le fil principal.
    s = conversationReducer(s, {
      type: 'changed',
      upserts: [{ uid: 'lance', kind: 'subagent', ts: null, segment: 1, tool_use_id: 't', agent_id: 'a1', agent_type: 'Explore', description: null, status: 'running' }],
    })
    expect(s.entries.map((e) => e.uid)).toEqual(['a', 'b', 'lance'])
    // Sous-agent lancé par le sous-agent a1 : dans le fil de a1, pas dans le fil principal.
    const nested: ConversationEntry = { uid: 'n', kind: 'subagent', ts: null, segment: 1, tool_use_id: 'u', agent_id: 'b2', parent_agent_id: 'a1', agent_type: 'Explore', description: null, status: 'running' }
    expect(threadOf(nested)).toBe('a1')
    s = conversationReducer(s, { type: 'changed', upserts: [nested] })
    expect(s.entries.map((e) => e.uid)).toEqual(['a', 'b', 'lance'])
    expect(s.segments.map((x) => [x.segment, x.reason])).toEqual([
      [0, 'start'],
      [1, 'clear'],
    ])
  })

  it('entrées plus anciennes ajoutées en tête sans doublon', () => {
    let s = ready([text('c', '3'), text('d', '4')])
    s = { ...s, hasMore: true }
    s = conversationReducer(s, { type: 'olderStart' })
    expect(s.olderLoading).toBe(true)
    s = conversationReducer(s, { type: 'older', page: page([text('a', '1'), text('b', '2'), text('c', '3')], false) })
    expect(s.entries.map((e) => e.uid)).toEqual(['a', 'b', 'c', 'd'])
    expect(s.hasMore).toBe(false)
    expect(s.olderLoading).toBe(false)
  })

  it('démon trop ancien : phase « unsupported »', () => {
    const s = conversationReducer(initialConversation, { type: 'failed', unsupported: true, message: 'mets orchd à jour' })
    expect(s.phase).toBe('unsupported')
    expect(conversationReducer(s, { type: 'changed', upserts: [text('a', 'x')] })).toBe(s)
  })
})

describe('prompts envoyés en attente', () => {
  const NOW = Date.parse('2026-10-20T10:00:00Z')

  it('reste affiché jusqu’à son arrivée dans le transcript (rapprochement par le texte)', () => {
    let s = ready([prompt('p0', 'bonjour')])
    s = conversationReducer(s, { type: 'send', id: 1, text: 'bonjour', at: NOW })
    s = conversationReducer(s, { type: 'sent', id: 1 })
    expect(s.pending).toEqual([{ id: 1, text: 'bonjour', sent: true, at: NOW, busy: false }])
    // Mise à jour d'un prompt déjà connu : ne le retire pas.
    s = conversationReducer(s, { type: 'changed', upserts: [prompt('p0', 'bonjour')] })
    expect(s.pending).toHaveLength(1)
    s = conversationReducer(s, { type: 'changed', upserts: [text('t', 'réponse')] })
    expect(s.pending).toHaveLength(1)
    s = conversationReducer(s, { type: 'changed', upserts: [prompt('p1', '  bonjour \n')] })
    expect(s.pending).toEqual([])
  })

  it('collage : repère « [collage id] » remplacé par son contenu, ou contenu ajouté', () => {
    const long = Array.from({ length: 15 }, (_, i) => `ligne ${i + 1}`).join('\n')
    const sent = `Compte ces lignes :\n${long}\nMerci.`
    const e = prompt('p', 'Compte ces lignes :\n[collage d880]\nMerci.', { pasted: [{ id: 'd880', text: long }] })
    expect(promptWithPastes(e)).toBe(sent)
    expect(promptMatches(sent, e)).toBe(true)
    expect(promptMatches(`Compte :\n${long}`, prompt('p', 'Compte :', { pasted: [{ id: 'x', text: long }] }))).toBe(true)
    expect(promptMatches('autre chose', prompt('p', 'Compte ces lignes :'))).toBe(false)
    expect(promptMatches('', prompt('p', ''))).toBe(false)
  })

  it('slash command et mode « ! » : rapprochés de l’entrée `command`', () => {
    const cmd = (name: string, args: string | null): ConversationEntry => ({ uid: 'c', kind: 'command', ts: null, segment: 0, name, args, output: null })
    expect(promptMatches('/compact', cmd('/compact', null))).toBe(true)
    expect(promptMatches('/model  opus', cmd('/model', 'opus'))).toBe(true)
    expect(promptMatches('/model opus', cmd('model', 'opus'))).toBe(true)
    expect(promptMatches('!ls -la', cmd('!', 'ls -la'))).toBe(true)
    expect(promptMatches('/clear', cmd('/compact', null))).toBe(false)
    let s = ready([])
    s = conversationReducer(s, { type: 'send', id: 1, text: '/compact', at: NOW })
    s = conversationReducer(s, { type: 'changed', upserts: [cmd('/compact', '')] })
    expect(s.pending).toEqual([])
  })

  it('repli : au repos après l’envoi, retirée après le délai de grâce', () => {
    let s = ready([])
    s = conversationReducer(s, { type: 'send', id: 1, text: '/model', at: NOW })
    s = conversationReducer(s, { type: 'sent', id: 1 })
    // Pas encore d'activité vue : attente gardée tant que SETTLE_IDLE_MS n'est pas écoulé.
    expect(settleDelay(s.pending, NOW)).toBe(SETTLE_IDLE_MS)
    expect(conversationReducer(s, { type: 'settle', now: NOW + 1000 }).pending).toHaveLength(1)
    expect(conversationReducer(s, { type: 'settle', now: NOW + SETTLE_IDLE_MS }).pending).toEqual([])
    // Activité vue (hors repos) : retirée dès le délai de grâce au repos suivant.
    s = conversationReducer(s, { type: 'activity', idle: false })
    expect(s.pending[0]!.busy).toBe(true)
    expect(settleDelay(s.pending, NOW)).toBe(SETTLE_GRACE_MS)
    expect(conversationReducer(s, { type: 'settle', now: NOW + 1 }).pending).toEqual([])
    // Une attente pas encore acceptée par le démon n'est jamais retirée par le repli.
    let u = conversationReducer(ready([]), { type: 'send', id: 2, text: 'x', at: NOW })
    u = conversationReducer(u, { type: 'activity', idle: false })
    expect(u.pending[0]!.busy).toBe(false)
    expect(conversationReducer(u, { type: 'settle', now: NOW + 10 * SETTLE_IDLE_MS }).pending).toHaveLength(1)
    expect(settleDelay(u.pending, NOW)).toBeNull()
  })

  it('rechargement : la page relue résout l’attente, mais pas un prompt identique plus ancien', () => {
    let s = ready([])
    s = conversationReducer(s, { type: 'send', id: 1, text: 'oui', at: NOW })
    s = conversationReducer(s, { type: 'sent', id: 1 })
    s = conversationReducer(s, { type: 'reload' })
    const old = prompt('p0', 'oui', { ts: '2026-10-20T09:00:00Z' })
    expect(conversationReducer(s, { type: 'loaded', page: page([old]) }).pending).toHaveLength(1)
    const fresh = prompt('p1', 'oui', { ts: '2026-10-20T10:00:01Z' })
    expect(conversationReducer(s, { type: 'loaded', page: page([old, fresh]) }).pending).toEqual([])
    // Arrivée par une notification pendant le rechargement : résolue aussi.
    const b = conversationReducer(s, { type: 'changed', upserts: [fresh] })
    expect(conversationReducer(b, { type: 'loaded', page: page([old]) }).pending).toEqual([])
  })

  it('un envoi refusé disparaît ; l’arrêt de la session vide les attentes ; chaque entrée n’en retire qu’une', () => {
    let s = ready([])
    s = conversationReducer(s, { type: 'send', id: 1, text: 'a', at: NOW })
    s = conversationReducer(s, { type: 'send', id: 2, text: 'a', at: NOW })
    s = conversationReducer(s, { type: 'sendFailed', id: 2 })
    expect(s.pending.map((p) => p.id)).toEqual([1])
    expect(reconcilePending([...s.pending, { id: 3, text: 'a', sent: true, at: NOW, busy: false }], [prompt('x', 'a')]).map((p) => p.id)).toEqual([3])
    expect(conversationReducer(s, { type: 'stopped' }).pending).toEqual([])
  })

  it('refuse un prompt vide ou trop long', () => {
    expect(promptProblem('')).toMatch(/vide/)
    expect(promptProblem(' \n')).toMatch(/vide/)
    expect(promptProblem('/clear')).toBeNull()
    expect(promptProblem('é'.repeat(131_073))).toMatch(/256 Kio/)
  })
})

describe('historique des prompts', () => {
  const items = ['un', 'deux', 'trois']

  it('↑ depuis un champ vide, puis on circule tant que le texte n’est pas modifié', () => {
    expect(historyStep(items, null, '', 'up')).toEqual({ index: 2, value: 'trois' })
    expect(historyStep(items, 2, 'trois', 'up')).toEqual({ index: 1, value: 'deux' })
    expect(historyStep(items, 0, 'un', 'up')).toEqual({ index: 0, value: 'un' })
    expect(historyStep(items, 1, 'deux', 'down')).toEqual({ index: 2, value: 'trois' })
    expect(historyStep(items, 2, 'trois', 'down')).toEqual({ index: null, value: '' })
  })

  it('champ non vide ou texte modifié : la flèche garde son effet normal', () => {
    expect(historyStep(items, null, 'brouillon', 'up')).toBeNull()
    expect(historyStep(items, null, '', 'down')).toBeNull()
    expect(historyStep(items, 1, 'deux modifié', 'up')).toBeNull()
    expect(historyStep([], null, '', 'up')).toBeNull()
  })

  it('pas de doublon consécutif, 100 au plus', () => {
    expect(pushHistory(['a'], 'a')).toEqual(['a'])
    expect(pushHistory(['a'], '  ')).toEqual(['a'])
    let h: readonly string[] = []
    for (let i = 0; i < 150; i++) h = pushHistory(h, `p${i}`)
    expect(h).toHaveLength(100)
    expect(h[0]).toBe('p50')
  })
})

describe('liste virtualisée', () => {
  it('5 000 entrées : seules celles de la fenêtre (et de la marge) sont rendues', () => {
    const heights = Array.from({ length: 5000 }, (_, i) => 30 + (i % 7) * 10)
    const off = layoutOffsets(heights)
    expect(off[5000]).toBe(heights.reduce((a, b) => a + b, 0))
    const bottom = visibleRange(off, off[5000]! - 800, 800, 600)
    expect(bottom.end).toBe(5000)
    expect(bottom.end - bottom.start).toBeLessThan(60)
    const top = visibleRange(off, 0, 800, 600)
    expect(top.start).toBe(0)
    expect(top.end - top.start).toBeLessThan(60)
    const mid = visibleRange(off, 100_000, 800, 0)
    expect(off[mid.start]!).toBeLessThanOrEqual(100_000)
    expect(off[mid.end]!).toBeGreaterThanOrEqual(100_800)
    expect(visibleRange(layoutOffsets([]), 0, 800, 600)).toEqual({ start: 0, end: 0 })
  })

  it('hauteur estimée selon le type (outil replié : une ligne)', () => {
    const tool: ConversationEntry = { uid: 't', kind: 'tool', ts: null, segment: 0, tool_use_id: 'x', name: 'Bash', summary: '', input: {} }
    expect(estimateHeight(tool)).toBeLessThan(estimateHeight(text('a', 'x'.repeat(2000))))
  })

  it('défilement collé : en bas à moins de 48 px près', () => {
    expect(isAtBottom(952, 2000, 1000)).toBe(true)
    expect(isAtBottom(900, 2000, 1000)).toBe(false)
    expect(isAtBottom(0, 0, 0)).toBe(true)
  })
})

describe('formes libres et libellés', () => {
  it('hunks d’un Edit : forme brute de structuredPatch et forme du protocole', () => {
    const raw = [{ oldStart: 3, oldLines: 2, newStart: 3, newLines: 3, lines: [' a', '-b', '+c', '+d'] }]
    const h = patchHunks(raw)!
    expect(h[0]!.header).toBe('@@ -3,2 +3,3 @@')
    expect(h[0]!.lines).toEqual([
      { kind: ' ', old_no: 3, new_no: 3, text: 'a' },
      { kind: '-', old_no: 4, new_no: null, text: 'b' },
      { kind: '+', old_no: null, new_no: 4, text: 'c' },
      { kind: '+', old_no: null, new_no: 5, text: 'd' },
    ])
    const proto = [{ header: '@@ x @@', old_start: 1, old_lines: 1, new_start: 1, new_lines: 1, lines: [{ kind: '+', old_no: null, new_no: 1, text: 'z' }] }]
    expect(patchHunks(proto)![0]!.lines[0]).toEqual({ kind: '+', old_no: null, new_no: 1, text: 'z' })
    expect(patchHunks({ hunks: raw })).toHaveLength(1)
    expect(patchHunks(null)).toBeNull()
    expect(patchHunks('<script>')).toBeNull()
    expect(patchHunks([{ lines: [] }])).toBeNull()
  })

  it('questions : réponse choisie, choix multiple, texte libre avec virgule', () => {
    const qs = [
      { question: 'Thé ou café ?', header: 'Boisson', options: [{ label: 'Thé', description: 'chaud' }, { label: 'Café' }], multiSelect: false },
      { question: 'Lesquels ?', options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }], multiSelect: true },
      { question: 'Autre ?', options: [{ label: 'X' }] },
    ]
    const v = questionViews(qs, { 'Thé ou café ?': 'Thé', 'Lesquels ?': 'A, C', 'Autre ?': 'rien, merci' })
    expect(v.map((q) => q.answer)).toEqual([['Thé'], ['A', 'C'], ['rien, merci']])
    expect(v[0]!.header).toBe('Boisson')
    expect(v[1]!.multiSelect).toBe(true)
    expect(questionViews(qs, undefined).every((q) => q.answer === null)).toBe(true)
    expect(questionViews('n’importe quoi', null)).toEqual([])
  })

  it('statut d’outil : glyphe et texte', () => {
    expect(toolStatus(undefined)).toMatchObject({ label: 'en cours' })
    expect(toolStatus({ status: 'ok' })).toMatchObject({ glyph: '✓', label: 'réussi' })
    expect(toolStatus({ status: 'error' })).toMatchObject({ glyph: '×', label: 'erreur' })
    expect(toolStatus({ status: 'interrupted' })).toMatchObject({ label: 'interrompu' })
  })

  it('activité : libellés et temps écoulé', () => {
    expect(activityLabel({ kind: 'prompt' })).toBe('Claude écrit…')
    expect(activityLabel({ kind: 'tool', tool: 'Bash' })).toBe('Outil : Bash…')
    expect(activityLabel({ kind: 'subagents' })).toBe('Sous-agents en cours')
    expect(activityLabel({ kind: 'compacting' })).toBe('Compaction…')
    expect(activityLabel({ kind: 'idle' })).toBeNull()
    expect(activityLabel(undefined)).toBeNull()
    expect(formatElapsed(12_400)).toBe('12 s')
    expect(formatElapsed(185_000)).toBe('3 min 05 s')
    expect(formatElapsed(3_720_000)).toBe('1 h 02 min')
  })

  it('texte coupé à l’affichage', () => {
    expect(clipText('abc', 10, 10)).toEqual({ shown: 'abc', clipped: false })
    expect(clipText('abcdef', 3, 10)).toEqual({ shown: 'abc', clipped: true })
    expect(clipText('a\nb\nc\nd', 100, 2)).toEqual({ shown: 'a\nb', clipped: true })
  })
})

describe('fixtures réelles (normalisation de test)', () => {
  it('le transcript du prototype donne tous les types attendus', () => {
    const file = resolve(__dirname, '../../spikes/05-vue-conversation/fixtures/transcripts/f413d189-39c7-41ff-aeb1-4df75e059737.jsonl')
    const entries = normalizeTranscript(readFileSync(file, 'utf8'))
    const kinds = new Set(entries.map((e) => e.kind))
    for (const k of ['prompt', 'text', 'thinking', 'tool', 'question', 'subagent', 'notification', 'compaction', 'command']) {
      expect(kinds, k).toContain(k)
    }
    const edit = entries.find((e) => e.kind === 'tool' && e.name === 'Edit')
    expect(edit?.kind === 'tool' && patchHunks(edit.result?.patch)?.length).toBeGreaterThan(0)
    const q = entries.find((e) => e.kind === 'question')
    expect(q?.kind === 'question' && questionViews(q.questions, q.answers).some((x) => x.answer)).toBe(true)
    const pasted = entries.find((e) => e.kind === 'prompt' && (e.pasted?.length ?? 0) > 0)
    expect(pasted).toBeDefined()
  })
})

describe('réglage « Onglet par défaut d’une session »', () => {
  it('Terminal par défaut ; Conversation au choix ; valeur invalide refusée ou ignorée', () => {
    expect(defaultSettings().ui.sessionTab).toBe('terminal')
    expect(normalizeSettings({ ui: { zoom: 100, sessionTab: 'conversation' } }).ui.sessionTab).toBe('conversation')
    expect(normalizeSettings({ ui: { sessionTab: 'diff' } }).ui.sessionTab).toBe('terminal')
    const p = validatePatch({ ui: { sessionTab: 'conversation' } })
    expect(applyPatch(defaultSettings(), p).ui).toEqual({ zoom: 100, sessionTab: 'conversation', language: 'system' })
    expect(applyPatch(defaultSettings(), validatePatch({ ui: { zoom: 150 } })).ui.sessionTab).toBe('terminal')
    expect(() => validatePatch({ ui: { sessionTab: 'diff' } })).toThrow()
  })
})
