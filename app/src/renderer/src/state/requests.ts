/**
 * Demandes en attente (permissions, questions) : résumé de l'outil, règles
 * proposées pour « Toujours », réponses aux questions.
 */
import type { PendingRequest, Question, QuestionAnswers } from '../../../shared/protocol'
import { str, summarizeToolInput, truncate } from '../../../shared/summary'

export { summarizeToolInput }

const DESTINATIONS: Record<string, string> = {
  localSettings: 'réglages locaux du projet',
  projectSettings: 'réglages partagés du projet',
  userSettings: 'réglages de l’utilisateur',
  session: 'cette session',
  cliArg: 'ligne de commande',
}

/**
 * Règles que « Toujours » ajouterait : `always_rules` du démon s'il est
 * présent (ce qui sera vraiment appliqué), sinon les suggestions brutes.
 */
function alwaysSource(req: PendingRequest): unknown[] | null {
  const d = req.pending
  if (d.kind === 'permission' && 'tool_name' in d) {
    if (Array.isArray(d.always_rules)) return d.always_rules
    if (Array.isArray(d.suggestions)) return d.suggestions
  }
  return Array.isArray(req.suggestions) ? req.suggestions : null
}

/** Règles que « Toujours » ajouterait, en texte (forme de Claude Code, sinon JSON). */
export function describeSuggestions(req: PendingRequest): string[] {
  return (alwaysSource(req) ?? []).map((s) => describeSuggestion(s))
}

/**
 * « Toujours » est-il possible ? Faux quand le démon annonce une liste de
 * règles vide (il refuserait la réponse) ; vrai si l'information manque.
 */
export function canAllowAlways(req: PendingRequest): boolean {
  const d = req.pending
  if (d.kind === 'permission' && 'tool_name' in d && Array.isArray(d.always_rules)) return d.always_rules.length > 0
  return true
}

/** L'app peut-elle répondre ? Non sans détail, ni quand aucun relais n'attend la décision. */
export function answerability(req: PendingRequest): { ok: true } | { ok: false; why: string } {
  if ('detailed' in req.pending && req.pending.detailed === false) {
    return { ok: false, why: 'Détails inconnus (signalée par une notification) : réponds dans le terminal.' }
  }
  if (req.answerable === false) {
    return { ok: false, why: 'Aucun relais n’attend cette réponse : réponds dans le terminal.' }
  }
  return { ok: true }
}

function describeSuggestion(s: unknown): string {
  if (!s || typeof s !== 'object') return String(s)
  const o = s as Record<string, unknown>
  const where = typeof o.destination === 'string' ? ` (${DESTINATIONS[o.destination] ?? o.destination})` : ''
  if (o.type === 'addRules' && Array.isArray(o.rules)) {
    const rules = o.rules.map((r) => {
      const rr = (r ?? {}) as Record<string, unknown>
      const tool = str(rr.toolName) ?? '?'
      const content = str(rr.ruleContent)
      return content ? `${tool}(${content})` : tool
    })
    const verb = o.behavior === 'deny' ? 'refuser' : o.behavior === 'ask' ? 'demander' : 'autoriser'
    return `${verb} ${rules.join(', ')}${where}`
  }
  if (o.type === 'setMode' && typeof o.mode === 'string') return `passer en mode ${o.mode}${where}`
  if (o.type === 'addDirectories' && Array.isArray(o.directories)) {
    return `ajouter ${o.directories.join(', ')} aux dossiers autorisés${where}`
  }
  return JSON.stringify(s)
}

export interface QuestionDraft {
  selected: string[]
  other: string
}

export const emptyDraft = (): QuestionDraft => ({ selected: [], other: '' })

/**
 * Réponses à envoyer (`sessions.answerQuestion`) : libellé pour un choix
 * simple, liste de libellés pour un choix multiple (le texte libre s'y
 * ajoute), texte libre seul s'il est saisi pour un choix simple.
 * `complete` est faux tant qu'une question n'a pas de réponse.
 */
export function buildAnswers(
  questions: Question[],
  drafts: QuestionDraft[],
): { answers: QuestionAnswers; complete: boolean } {
  const answers: QuestionAnswers = {}
  let complete = true
  questions.forEach((q, i) => {
    const d = drafts[i] ?? emptyDraft()
    const other = d.other.trim()
    if (q.multi_select) {
      const list = [...d.selected, ...(other ? [other] : [])]
      if (list.length) answers[q.question] = list
      else complete = false
    } else if (other) {
      answers[q.question] = other
    } else if (d.selected[0]) {
      answers[q.question] = d.selected[0]
    } else {
      complete = false
    }
  })
  return { answers, complete }
}

/** Bascule d'une option : remplace (choix simple) ou ajoute / retire (choix multiple). */
export function toggleOption(d: QuestionDraft, label: string, multi: boolean): QuestionDraft {
  if (!multi) return { selected: [label], other: '' }
  const has = d.selected.includes(label)
  return { ...d, selected: has ? d.selected.filter((l) => l !== label) : [...d.selected, label] }
}
