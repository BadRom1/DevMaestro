/**
 * Normalisation minimale d'un transcript réel de Claude Code (fixtures du
 * prototype n° 5) en entrées du contrat du lot 10, **pour les tests du front
 * seulement** : la vraie normalisation est faite par le démon. Couvre ce que
 * contiennent les fixtures (prompts et collages, textes, réflexions, outils et
 * résultats avec `structuredPatch`, question, sous-agent, notification,
 * compaction, commandes) ; le reste de l'intendance est ignoré.
 */
import type { ConversationEntry, ToolEntry } from '../src/shared/protocol'

/*
 * Sans module de Node : utilisé aussi par les tests jsdom (contenu lu par
 * `readFileSync` côté Node, importé en `?raw` côté jsdom).
 */

type J = Record<string, unknown>

const IGNORED = new Set([
  'attachment',
  'api-request',
  'api-request-blob',
  'api-request-shape',
  'last-prompt',
  'mode',
  'permission-mode',
  'atis-latch',
  'file-history-snapshot',
  'file-history-delta',
  'ai-title',
  'cost-state',
  'queue-operation',
])

const tag = (s: string, name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(s)?.[1]?.trim() ?? null
// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')

function summaryOf(name: string, input: J): string {
  for (const k of ['file_path', 'command', 'pattern', 'url', 'query', 'description', 'path']) {
    if (typeof input[k] === 'string') return input[k] as string
  }
  return name
}

/** Entrées normalisées du contenu d'un fichier `.jsonl`. */
export function normalizeTranscript(content: string, segment = 0, agentId?: string): ConversationEntry[] {
  const out: ConversationEntry[] = []
  const byTool = new Map<string, ConversationEntry>()
  let lastCommand: Extract<ConversationEntry, { kind: 'command' }> | null = null
  let lastCompaction: Extract<ConversationEntry, { kind: 'compaction' }> | null = null
  const lines = content.split('\n')
  for (const line of lines) {
    if (!line.trim()) continue
    let d: J
    try {
      d = JSON.parse(line) as J
    } catch {
      continue
    }
    const type = String(d.type)
    const uid = String(d.uuid ?? `${type}:${out.length}`)
    const base = { uid, ts: typeof d.timestamp === 'string' ? d.timestamp : null, segment, ...(agentId ? { agent_id: agentId } : {}) }
    if (IGNORED.has(type)) continue
    const msg = (d.message ?? {}) as J
    if (type === 'system') {
      if (d.subtype === 'compact_boundary') {
        const m = (d.compactMetadata ?? {}) as J
        lastCompaction = {
          ...base,
          kind: 'compaction',
          trigger: typeof m.trigger === 'string' ? m.trigger : null,
          pre_tokens: typeof m.preTokens === 'number' ? m.preTokens : null,
          post_tokens: typeof m.postTokens === 'number' ? m.postTokens : null,
          summary: null,
        }
        out.push(lastCompaction)
      } else if (d.subtype === 'api_error') out.push({ ...base, kind: 'error', message: 'Erreur de l’API' })
      continue
    }
    if (type === 'user') {
      if (d.isMeta) continue
      const c = msg.content
      if (typeof c === 'string') {
        if (d.isCompactSummary) {
          if (lastCompaction) lastCompaction.summary = c
          continue
        }
        if (c.startsWith('<command-name>')) {
          const name = tag(c, 'command-name') ?? ''
          lastCommand = { ...base, kind: 'command', name, args: tag(c, 'command-args') || null, output: null }
          out.push(lastCommand)
          continue
        }
        if (c.startsWith('<local-command-stdout>')) {
          if (lastCommand) lastCommand.output = stripAnsi(tag(c, 'local-command-stdout') ?? '')
          continue
        }
        if (c.startsWith('<task-notification>')) {
          out.push({ ...base, kind: 'notification', task_id: tag(c, 'task-id'), status: tag(c, 'status'), summary: tag(c, 'summary') })
          continue
        }
        if (c.startsWith('<local-command-caveat>')) continue
        const pasted: { id: string; text: string }[] = []
        const text = c.replace(/<pasted_content id="([^"]*)">([\s\S]*?)<\/pasted_content id="\1">/g, (_m, id: string, body: string) => {
          pasted.push({ id, text: body.replace(/^\n|\n$/g, '') })
          return ''
        })
        const source = d.promptSource === 'suggestion_accepted' ? 'suggestion' : typeof d.promptSource === 'string' ? d.promptSource : 'typed'
        out.push({ ...base, kind: 'prompt', text: text.trim(), source, pasted })
        continue
      }
      if (Array.isArray(c)) {
        for (const b of c as J[]) {
          if (b.type !== 'tool_result') continue
          const target = byTool.get(String(b.tool_use_id))
          const tur = (d.toolUseResult ?? {}) as J
          const content = b.content
          const text = typeof content === 'string' ? content : Array.isArray(content) ? (content as J[]).map((x) => String(x.text ?? '')).join('\n') : ''
          if (target?.kind === 'tool') {
            const t: ToolEntry = { ...target, result: { status: b.is_error ? 'error' : 'ok', text, truncated: false, patch: tur.structuredPatch } }
            out[out.indexOf(target)] = t
            byTool.set(t.tool_use_id, t)
          } else if (target?.kind === 'question') {
            const q = { ...target, answers: tur.answers ?? {} }
            out[out.indexOf(target)] = q
          } else if (target?.kind === 'subagent') {
            const s = { ...target, agent_id: typeof tur.agentId === 'string' ? tur.agentId : null, status: 'running' }
            out[out.indexOf(target)] = s
          }
        }
      }
      continue
    }
    if (type === 'assistant') {
      for (const b of (Array.isArray(msg.content) ? msg.content : []) as J[]) {
        if (b.type === 'text') out.push({ ...base, kind: 'text', markdown: String(b.text ?? '') })
        else if (b.type === 'thinking') out.push({ ...base, kind: 'thinking' })
        else if (b.type === 'tool_use') {
          const name = String(b.name)
          const input = (b.input ?? {}) as J
          const tid = String(b.id)
          let e: ConversationEntry
          if (name === 'AskUserQuestion') e = { ...base, kind: 'question', tool_use_id: tid, questions: input.questions }
          else if (name === 'Agent' || name === 'Task') {
            e = {
              ...base,
              kind: 'subagent',
              tool_use_id: tid,
              agent_id: null,
              agent_type: typeof input.subagent_type === 'string' ? input.subagent_type : null,
              description: typeof input.description === 'string' ? input.description : null,
              status: 'running',
            }
          } else e = { ...base, kind: 'tool', tool_use_id: tid, name, summary: summaryOf(name, input), input }
          byTool.set(tid, e)
          out.push(e)
        } else out.push({ ...base, uid: `${uid}:${String(b.type)}`, kind: 'unknown', type: 'assistant', subtype: String(b.type) })
      }
      continue
    }
    out.push({ ...base, kind: 'unknown', type, subtype: typeof d.subtype === 'string' ? d.subtype : null })
  }
  return out
}
