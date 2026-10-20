import { describe, expect, it } from 'vitest'

import { ValidationError, validateParams } from '../src/main/validate'
import { ErrorCode, RENDERER_METHODS, type Subagent } from '../src/shared/protocol'
import { classifyLink, renderMarkdown } from '../src/renderer/src/state/markdown'
import {
  RETRY_MS,
  initialLoad,
  loadFailed,
  loadPhase,
  loadSucceeded,
  retryNow,
  sessionsToLoad,
  startLoad,
} from '../src/renderer/src/state/subagentsLoad'
import { initialState, reducer } from '../src/renderer/src/state/store'
import {
  agentDurationMs,
  agentGlyph,
  agentTitle,
  agentTree,
  agentType,
  formatDuration,
  normalizeAgents,
  normalizeSubagent,
  reportKey,
  runningCount,
  runningLabel,
  subagentFromResult,
  toolCountLabel,
  totalCount,
} from '../src/renderer/src/state/subagents'
import { session } from './fixtures'

const ID = '0c69fdc4-b2c9-4511-97c8-bb78d2323d61'
/** Identifiant réel relevé le 2026-10-20 (fixtures du prototype n° 1). */
const AGENT = 'a1dcf2f8a7682d931'

let n = 0
function agent(over: Partial<Subagent> = {}): Subagent {
  n++
  return {
    agent_id: `a${String(n).padStart(16, '0')}`,
    agent_type: 'general-purpose',
    description: `tâche ${n}`,
    model: 'claude-opus-5-5',
    tool_use_id: `toolu_${n}`,
    status: 'done',
    started_at: '2026-10-20T10:00:00Z',
    ended_at: '2026-10-20T10:01:00Z',
    tool_count: 3,
    current_tool: null,
    last_tool: 'Read',
    transcript_path: null,
    ...over,
  }
}

describe('sous-agents : lecture tolérante', () => {
  it('champs absents ou mal typés → null, sans agent_id → écarté', () => {
    expect(normalizeSubagent({ agent_id: AGENT })).toEqual({
      agent_id: AGENT,
      agent_type: null,
      description: null,
      model: null,
      tool_use_id: null,
      status: 'running',
      started_at: null,
      ended_at: null,
      tool_count: null,
      current_tool: null,
      last_tool: null,
      transcript_path: null,
    })
    expect(normalizeSubagent({ agent_type: 'Explore' })).toBeNull()
    expect(normalizeSubagent({ agent_id: '' })).toBeNull()
    expect(normalizeSubagent(null)).toBeNull()
    expect(normalizeSubagent([AGENT])).toBeNull()
    const a = normalizeSubagent({ agent_id: AGENT, tool_count: 'trois', model: 5, status: 'done' })!
    expect(a.tool_count).toBeNull()
    expect(a.model).toBeNull()
  })

  it('statut inconnu : en cours sans fin, terminé sinon', () => {
    expect(normalizeSubagent({ agent_id: AGENT, status: 'paused' })!.status).toBe('running')
    expect(normalizeSubagent({ agent_id: AGENT, status: 'paused', ended_at: '2026-10-20T10:00:00Z' })!.status).toBe('done')
  })

  it('rapport gardé seulement quand le démon le donne', () => {
    expect('report' in normalizeSubagent({ agent_id: AGENT })!).toBe(false)
    const a = normalizeSubagent({ agent_id: AGENT, report: '# Fini', report_truncated: true })!
    expect(a.report).toBe('# Fini')
    expect(a.report_truncated).toBe(true)
    expect(normalizeSubagent({ agent_id: AGENT, report: null, report_truncated: 'oui' })!.report_truncated).toBe(false)
  })

  it('liste : tableau ou {agents}, entrées illisibles et doublons écartés', () => {
    expect(normalizeAgents(undefined)).toEqual([])
    expect(normalizeAgents({})).toEqual([])
    expect(normalizeAgents({ agents: 'x' })).toEqual([])
    const list = normalizeAgents({ agents: [{ agent_id: 'a1' }, null, { agent_id: 'a2' }, { agent_id: 'a1' }, 4] })
    expect(list.map((a) => a.agent_id)).toEqual(['a1', 'a2'])
    expect(normalizeAgents([{ agent_id: 'a3' }]).map((a) => a.agent_id)).toEqual(['a3'])
  })

  it('résultat de sessions.subagent : direct ou enveloppé', () => {
    expect(subagentFromResult({ agent_id: AGENT, report: 'x' })!.report).toBe('x')
    expect(subagentFromResult({ agent: { agent_id: AGENT, report: 'y' } })!.report).toBe('y')
    expect(subagentFromResult({ subagent: { agent_id: AGENT } })!.agent_id).toBe(AGENT)
    expect(subagentFromResult({})).toBeNull()
    expect(subagentFromResult(null)).toBeNull()
  })

  it('en cours : la liste quand elle est connue, sinon le champ de la session, sinon 0', () => {
    const old = session()
    expect(runningCount(old)).toBe(0)
    expect(runningCount(old, [agent({ status: 'running' }), agent()])).toBe(1)
    const s = session({ subagents_running: 2, subagents_total: 7 })
    // Liste connue (même vide) : elle fait foi, pour que tout l'écran dise la même chose.
    expect(runningCount(s, [])).toBe(0)
    expect(runningCount(s, [agent({ status: 'running' })])).toBe(1)
    expect(runningCount(s)).toBe(2)
    expect(runningCount(s, undefined)).toBe(2)
    expect(runningCount(session({ subagents_running: null }))).toBe(0)
    expect(runningCount(session({ subagents_running: -1 as number }))).toBe(0)
  })

  it('total : le champ de la session, sinon la taille de la liste, sinon 0', () => {
    expect(totalCount(session())).toBe(0)
    expect(totalCount(session(), [agent(), agent()])).toBe(2)
    expect(totalCount(session({ subagents_total: 7 }), [])).toBe(7)
  })
})

describe('sous-agents : sous-arbre de la barre latérale', () => {
  it('en cours d’abord (ordre de la liste du démon), puis les 5 derniers finis, nombre des autres', () => {
    // Heures de départ inversées : seul l'ordre de lancement (celui de la liste) compte.
    const r0 = agent({ status: 'running', started_at: '2026-10-20T10:05:00Z', ended_at: null })
    const r1 = agent({ status: 'running', started_at: '2026-10-20T10:02:00Z', ended_at: null })
    const done = Array.from({ length: 8 }, (_, i) =>
      agent({ status: i === 2 ? 'failed' : i === 4 ? 'interrupted' : 'done', ended_at: `2026-10-20T11:0${i}:00Z` }),
    )
    const t = agentTree([done[0]!, r0, ...done.slice(1), r1])
    expect(t.running.map((a) => a.agent_id)).toEqual([r0.agent_id, r1.agent_id])
    // Du plus récent au plus ancien.
    expect(t.finished.map((a) => a.agent_id)).toEqual([7, 6, 5, 4, 3].map((i) => done[i]!.agent_id))
    expect(t.more).toBe(3)
  })

  it('finis sans heure : après ceux qui en ont, le dernier de la liste d’abord', () => {
    const a = agent({ status: 'running', started_at: null, ended_at: null })
    const b = agent({ status: 'running', started_at: null, ended_at: null })
    const c = agent({ started_at: null, ended_at: null })
    const d = agent({ started_at: null, ended_at: null })
    const e = agent()
    const t = agentTree([a, c, b, e, d])
    expect(t.running).toEqual([a, b])
    expect(t.finished).toEqual([e, d, c])
    expect(t.more).toBe(0)
  })

  it('liste vide, limite nulle', () => {
    expect(agentTree([])).toEqual({ running: [], finished: [], more: 0 })
    expect(agentTree([agent(), agent()], 0)).toMatchObject({ finished: [], more: 2 })
  })
})

describe('sous-agents : durées et libellés', () => {
  const now = Date.parse('2026-10-20T10:03:30Z')

  it('durée : jusqu’à la fin, ou jusqu’à maintenant s’il tourne', () => {
    expect(agentDurationMs(agent(), now)).toBe(60_000)
    expect(agentDurationMs(agent({ status: 'running', ended_at: null }), now)).toBe(210_000)
    expect(agentDurationMs(agent({ started_at: null }), now)).toBeNull()
    // Fini sans heure de fin connue : durée inconnue (pas « jusqu'à maintenant »).
    expect(agentDurationMs(agent({ status: 'interrupted', ended_at: null }), now)).toBeNull()
    // Horloges décalées : jamais négative.
    expect(agentDurationMs(agent({ status: 'running', ended_at: null, started_at: '2026-10-20T11:00:00Z' }), now)).toBe(0)
  })

  it('format : secondes, minutes, heures', () => {
    expect(formatDuration(0)).toBe('0 s')
    expect(formatDuration(8_400)).toBe('8 s')
    expect(formatDuration(65_000)).toBe('1 min 05 s')
    expect(formatDuration(3_725_000)).toBe('1 h 02 min')
    expect(formatDuration(null)).toBe('—')
    expect(formatDuration(Number.NaN)).toBe('—')
  })

  it('statut : classe de glyphe distincte et libellé en français', () => {
    expect(agentGlyph('running')).toEqual({ kind: 'running', label: 'en cours' })
    expect(agentGlyph('done')).toEqual({ kind: 'stopped', label: 'terminé' })
    expect(agentGlyph('failed')).toEqual({ kind: 'error', label: 'échec' })
    expect(agentGlyph('interrupted')).toEqual({ kind: 'interrupted', label: 'interrompu' })
    const kinds = new Set((['running', 'done', 'failed', 'interrupted'] as const).map((s) => agentGlyph(s).kind))
    expect(kinds.size).toBe(4)
  })

  it('« n sous-agent(s) en cours », nom, type, outils', () => {
    expect(runningLabel(0)).toBeNull()
    expect(runningLabel(1)).toBe('1 sous-agent en cours')
    expect(runningLabel(2)).toBe('2 sous-agents en cours')
    expect(agentTitle({ description: '  ', agent_type: 'Explore' })).toBe('Explore')
    expect(agentTitle({ description: null, agent_type: null })).toBe('sous-agent')
    expect(agentType({ agent_type: '' })).toBe('type inconnu')
    expect(toolCountLabel(1)).toBe('1 outil')
    expect(toolCountLabel(0)).toBe('0 outil')
    expect(toolCountLabel(12)).toBe('12 outils')
    expect(toolCountLabel(null)).toBe('outils : inconnu')
  })

  it('clé de rapport : change avec le statut ou la fin, pas avec les outils', () => {
    const a = agent({ status: 'running', ended_at: null })
    const b = { ...a, tool_count: 9, current_tool: 'Bash' }
    expect(reportKey(b)).toBe(reportKey(a))
    expect(reportKey({ ...a, status: 'done', ended_at: '2026-10-20T10:09:00Z' })).not.toBe(reportKey(a))
  })
})

describe('sous-agents : état de la page', () => {
  const known = () => reducer(initialState, { type: 'sessions', sessions: [session({ id: ID })] })

  it('la notification remplace la liste (liste complète du démon)', () => {
    let st = reducer(known(), { type: 'subagents.changed', id: ID, agents: [{ agent_id: 'a1' }, { agent_id: 'a2' }] })
    expect(st.subagents[ID]!.map((a) => a.agent_id)).toEqual(['a1', 'a2'])
    st = reducer(st, { type: 'subagents.changed', id: ID, agents: [{ agent_id: 'a2', status: 'done' }] })
    expect(st.subagents[ID]!.map((a) => [a.agent_id, a.status])).toEqual([['a2', 'done']])
    expect(st.subagentsSeq[ID]).toBe(2)
    // Liste illisible : vide plutôt qu'une erreur.
    st = reducer(st, { type: 'subagents.changed', id: ID, agents: undefined })
    expect(st.subagents[ID]).toEqual([])
  })

  it('une réponse partie avant une notification est ignorée', () => {
    let st = reducer(known(), { type: 'subagents.loaded', id: ID, agents: { agents: [{ agent_id: 'a1' }] }, seq: 0 })
    expect(st.subagents[ID]!.map((a) => a.agent_id)).toEqual(['a1'])
    // Demande partie à seq 0, notification arrivée entre-temps (seq 1) : plus ancienne.
    st = reducer(st, { type: 'subagents.changed', id: ID, agents: [{ agent_id: 'a1', status: 'done' }, { agent_id: 'a2' }] })
    const after = reducer(st, { type: 'subagents.loaded', id: ID, agents: { agents: [{ agent_id: 'a1' }] }, seq: 0 })
    expect(after).toBe(st)
    const fresh = reducer(st, { type: 'subagents.loaded', id: ID, agents: { agents: [{ agent_id: 'a3' }] }, seq: 1 })
    expect(fresh.subagents[ID]!.map((a) => a.agent_id)).toEqual(['a3'])
  })

  it('session retirée : ses sous-agents aussi', () => {
    const s = session()
    let st = reducer(initialState, { type: 'sessions', sessions: [s] })
    st = reducer(st, { type: 'subagents.changed', id: s.id, agents: [{ agent_id: 'a1' }] })
    st = reducer(st, { type: 'session.removed', id: s.id })
    expect(st.subagents[s.id]).toBeUndefined()
    expect(st.subagentsSeq[s.id]).toBeUndefined()
    // Notification tardive pour la session retirée : pas d'état fantôme.
    const late = reducer(st, { type: 'subagents.changed', id: s.id, agents: [{ agent_id: 'a1' }] })
    expect(late.subagents[s.id]).toBeUndefined()
    expect(reducer(st, { type: 'subagents.loaded', id: s.id, agents: [{ agent_id: 'a1' }], seq: 0 })).toBe(st)
  })

  it('la liste des sessions purge les sous-agents des sessions absentes', () => {
    const a = session()
    const b = session()
    let st = reducer(initialState, { type: 'sessions', sessions: [a, b] })
    st = reducer(st, { type: 'subagents.changed', id: a.id, agents: [{ agent_id: 'a1' }] })
    st = reducer(st, { type: 'subagents.changed', id: b.id, agents: [{ agent_id: 'b1' }] })
    st = reducer(st, { type: 'sessions', sessions: [b] })
    expect(Object.keys(st.subagents)).toEqual([b.id])
    expect(Object.keys(st.subagentsSeq)).toEqual([b.id])
  })
})

describe('sous-agents : amorçage des listes (sessions.subagents)', () => {
  const withAgents = session({ subagents_total: 3 })
  const none = session({ subagents_total: 0 })
  const oldDaemon = session()

  it('seulement les sessions qui ont des sous-agents (jamais un démon plus ancien)', () => {
    expect(sessionsToLoad(initialLoad(), [withAgents, none, oldDaemon], 0)).toEqual([withAgents.id])
  })

  it('capture le compteur de notifications au départ, une seule demande à la fois', () => {
    const { state, seq } = startLoad(initialLoad(), withAgents.id, { [withAgents.id]: 4 })
    expect(seq).toBe(4)
    expect(startLoad(initialLoad(), withAgents.id, {}).seq).toBe(0)
    expect(loadPhase(state, withAgents.id)).toBe('loading')
    expect(sessionsToLoad(state, [withAgents], 0)).toEqual([])
    const done = loadSucceeded(state, withAgents.id)
    expect(loadPhase(done, withAgents.id)).toBeNull()
    expect(sessionsToLoad(done, [withAgents], 10 ** 12)).toEqual([])
  })

  it('autre erreur : « indisponible », nouvel essai après le délai ou sur « Réessayer »', () => {
    const asked = startLoad(initialLoad(), withAgents.id, {}).state
    const failed = loadFailed(asked, withAgents.id, ErrorCode.Internal, 1000)
    expect(loadPhase(failed, withAgents.id)).toBe('failed')
    expect(sessionsToLoad(failed, [withAgents], 1000 + RETRY_MS - 1)).toEqual([])
    expect(sessionsToLoad(failed, [withAgents], 1000 + RETRY_MS)).toEqual([withAgents.id])
    expect(sessionsToLoad(retryNow(failed, withAgents.id), [withAgents], 1000)).toEqual([withAgents.id])
  })

  it('connexion perdue : redemandée au passage suivant ; méthode inconnue : plus rien', () => {
    const asked = startLoad(initialLoad(), withAgents.id, {}).state
    const lost = loadFailed(asked, withAgents.id, ErrorCode.Disconnected, 0)
    expect(sessionsToLoad(lost, [withAgents], 0)).toEqual([withAgents.id])
    const old = loadFailed(asked, withAgents.id, ErrorCode.MethodNotFound, 0)
    expect(old.supported).toBe(false)
    expect(loadPhase(old, withAgents.id)).toBe('unsupported')
    expect(sessionsToLoad(old, [withAgents, session({ subagents_total: 1 })], 10 ** 12)).toEqual([])
    // Nouvelle connexion : tout est redemandé.
    expect(sessionsToLoad(initialLoad(), [withAgents], 0)).toEqual([withAgents.id])
  })
})

describe('sous-agents : rapport hostile rendu en Markdown', () => {
  it('aucun élément actif ne sort (HTML brut, image, script, javascript:, file:)', () => {
    const { html } = renderMarkdown(
      [
        '# Rapport',
        '<img src=x onerror="alert(1)">',
        '<script>alert(2)</script>',
        '[clic](javascript:alert(3))',
        '[fichier](file:///etc/passwd)',
        '![image](https://exemple.test/x.png)',
        '<a href="javascript:alert(4)">lien</a>',
      ].join('\n\n'),
    )
    expect(html).not.toMatch(/<img|<script|<iframe|<a\s[^>]*href="(javascript|file):/i)
    // Aucun gestionnaire d'événement dans une balise (le texte échappé peut, lui, contenir « onerror= »).
    expect(html).not.toMatch(/<[a-z][^>]*\son\w+=/i)
    expect(html).not.toMatch(/<a\s/i)
    // HTML brut échappé, image remplacée par son texte.
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('[image : image]')
    // Liens de schéma dangereux : jamais suivis au clic.
    expect(classifyLink('javascript:alert(3)', '')).toEqual({ kind: 'inert' })
    expect(classifyLink('file:///etc/passwd', '')).toEqual({ kind: 'inert' })
  })
})

describe('sous-agents : méthodes de la page', () => {
  it('autorisées et validées (agent_id n’est pas un UUID)', () => {
    expect(RENDERER_METHODS).toContain('sessions.subagents')
    expect(RENDERER_METHODS).toContain('sessions.subagent')
    expect(validateParams('sessions.subagents', { id: ID, x: 1 })).toEqual({ id: ID })
    expect(validateParams('sessions.subagent', { id: ID, agent_id: AGENT, x: 1 })).toEqual({ id: ID, agent_id: AGENT })
    for (const bad of [
      ['sessions.subagents', { id: 'x' }],
      ['sessions.subagent', { id: ID }],
      ['sessions.subagent', { id: ID, agent_id: '' }],
      ['sessions.subagent', { id: ID, agent_id: 'a/../b' }],
      ['sessions.subagent', { id: ID, agent_id: 'x'.repeat(129) }],
      ['sessions.subagent', { id: ID, agent_id: 3 }],
      ['sessions.subagent', { agent_id: AGENT }],
    ] as const) {
      expect(() => validateParams(bad[0], bad[1]), JSON.stringify(bad)).toThrow(ValidationError)
    }
  })
})
