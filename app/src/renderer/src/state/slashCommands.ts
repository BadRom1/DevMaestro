/**
 * Slash commands du champ de saisie de la conversation (v0.3, lot 17),
 * logique pure : repérage de la requête (`/…` en tête du champ), filtre et
 * classement, complétion, touches de la liste, libellés.
 *
 * La liste vient du démon (`commands.list`) ; sans lui (démon ancien, appel
 * en échec ou en cours), la liste intégrée de l'app sert de repli. Elle est
 * la copie de `crates/core/src/domain/builtin_commands.json` (un test vérifie
 * l'égalité des deux fichiers).
 */
import builtinData from '../../../shared/builtinCommands.json'
import { getLocale, t } from '../../../shared/i18n'
import { BUILTIN_COMMANDS_EN } from '../../../shared/i18n/catalog/conversation'
import { COMMAND_SOURCES, type CommandSource, type SlashCommand } from '../../../shared/protocol'

/** Propositions affichées au plus. */
export const MAX_SUGGESTIONS = 50

/** Version de Claude Code de référence de la liste intégrée. */
export const BUILTIN_VERSION: string = builtinData.claude_code_version

/** Commandes intégrées de Claude Code (repli sans le démon). */
export const BUILTIN_COMMANDS: readonly SlashCommand[] = builtinData.commands.map((c) => {
  const raw = c as { name: string; description?: string; argument_hint?: string; aliases?: string[]; kind?: string; interactive?: boolean }
  const out: SlashCommand = { name: raw.name, source: 'builtin', kind: raw.kind === 'skill' ? 'skill' : 'command' }
  if (raw.description) out.description = raw.description
  if (raw.argument_hint) out.argument_hint = raw.argument_hint
  if (raw.aliases?.length) out.aliases = [...raw.aliases]
  if (raw.interactive) out.interactive = true
  return out
})

const NAME_RE = /^[A-Za-z0-9_-]{1,64}(?::[A-Za-z0-9_-]{1,64}){0,6}$/

/** Liste du démon relue prudemment : entrées mal formées écartées, champs bornés. */
export function normalizeCommands(raw: unknown): SlashCommand[] | null {
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { commands?: unknown }).commands)) return null
  const out: SlashCommand[] = []
  const text = (v: unknown, max: number) => (typeof v === 'string' && v.length > 0 ? v.slice(0, max) : undefined)
  for (const c of (raw as { commands: unknown[] }).commands) {
    if (typeof c !== 'object' || c === null) continue
    const o = c as Record<string, unknown>
    if (typeof o.name !== 'string' || !NAME_RE.test(o.name)) continue
    if (!COMMAND_SOURCES.includes(o.source as CommandSource)) continue
    const cmd: SlashCommand = { name: o.name, source: o.source as CommandSource, kind: o.kind === 'skill' ? 'skill' : 'command' }
    const d = text(o.description, 512)
    if (d) cmd.description = d
    const h = text(o.argument_hint, 128)
    if (h) cmd.argument_hint = h
    if (Array.isArray(o.aliases)) {
      const a = o.aliases.filter((x): x is string => typeof x === 'string' && NAME_RE.test(x)).slice(0, 16)
      if (a.length) cmd.aliases = a
    }
    if (o.interactive === true) cmd.interactive = true
    const p = text(o.plugin, 64)
    if (p) cmd.plugin = p
    if (o.conflict === 'builtin' || o.conflict === 'plugin') cmd.conflict = o.conflict
    out.push(cmd)
    if (out.length >= 1000) break
  }
  return out
}

/** Mot `/…` en cours de saisie : `query` sans le `/`, `end` : fin du mot dans le texte. */
export interface SlashQuery {
  query: string
  end: number
}

/**
 * Requête de complétion, ou `null` : seulement si **tout le champ** commence
 * par `/` et que le curseur est dans le premier mot (sans blanc avant lui) ;
 * un `/` au milieu d'un texte ne compte pas.
 */
export function slashQuery(value: string, caret: number | null): SlashQuery | null {
  if (!value.startsWith('/')) return null
  const m = /\s/.exec(value)
  const end = m ? m.index : value.length
  const at = caret ?? value.length
  if (at < 1 || at > end) return null
  return { query: value.slice(1, end), end }
}

/**
 * Départage des égalités de rang (le démon a déjà fusionné et dédoublonné
 * les sources) : une commande d'origine passe avant celle qui reprend son nom
 * (`conflict`), puis intégrées, projet, utilisateur, plugins.
 */
const SOURCE_RANK: Record<CommandSource, number> = { builtin: 0, project: 1, user: 2, plugin: 3 }

/** Rang d'une commande pour la requête (plus petit : meilleur) ; `null` : écartée. */
function matchRank(c: SlashCommand, q: string): number | null {
  if (q === '') return 5
  const name = c.name.toLowerCase()
  const aliases = (c.aliases ?? []).map((a) => a.toLowerCase())
  if (name === q || aliases.includes(q)) return 0
  if (name.startsWith(q)) return 1
  if (name.split(':').slice(1).some((s) => s.startsWith(q))) return 2
  if (aliases.some((a) => a.startsWith(q))) return 3
  if (name.includes(q)) return 4
  return null
}

/**
 * Propositions pour la requête, sans tenir compte de la casse : nom exact
 * (ou alias exact), préfixe du nom, préfixe d'un segment après `:`, préfixe
 * d'un alias, sous-chaîne ; à rang égal, l'originale avant celle qui reprend
 * son nom, puis source (intégrée, projet, utilisateur, plugin), puis nom. Un
 * même nom peut figurer deux fois (intégrée et reprise marquée) : rien n'est
 * masqué.
 */
export function rankCommands(commands: readonly SlashCommand[], query: string, limit = MAX_SUGGESTIONS): SlashCommand[] {
  const q = query.toLowerCase()
  const scored: { c: SlashCommand; r: number }[] = []
  for (const c of commands) {
    const r = matchRank(c, q)
    if (r !== null) scored.push({ c, r })
  }
  scored.sort(
    (a, b) =>
      a.r - b.r ||
      Number(!!a.c.conflict) - Number(!!b.c.conflict) ||
      SOURCE_RANK[a.c.source] - SOURCE_RANK[b.c.source] ||
      (a.c.name < b.c.name ? -1 : a.c.name > b.c.name ? 1 : 0),
  )
  return scored.slice(0, limit).map((s) => s.c)
}

/**
 * Texte complété : `/<nom> ` (avec un espace) si la commande attend des
 * arguments, `/<nom>` sinon ; le reste du texte après le premier mot est
 * gardé. `caret` : position du curseur après la complétion.
 */
export function completeCommand(value: string, q: SlashQuery, c: SlashCommand): { value: string; caret: number } {
  const head = `/${c.name}`
  const rest = value.slice(q.end)
  if (rest === '') {
    const v = c.argument_hint ? `${head} ` : head
    return { value: v, caret: v.length }
  }
  return { value: head + rest, caret: head.length + (/^[ \t]/.test(rest) ? 1 : 0) }
}

/** Le mot tapé est-il déjà exactement cette commande ou l'un de ses alias ? (Entrée envoie alors.) */
export function isExactCommand(q: SlashQuery, c: SlashCommand): boolean {
  return q.query === c.name || (c.aliases ?? []).includes(q.query)
}

/** Ce que fait une touche quand la liste est ouverte. */
export type PopupAction =
  | { type: 'move'; index: number }
  | { type: 'complete' }
  | { type: 'send' }
  | { type: 'close' }
  | null

export interface PopupKey {
  key: string
  shiftKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  metaKey?: boolean
}

/**
 * Touche dans le champ, liste ouverte avec `count` propositions dont
 * `active` est choisie : ↑ / ↓ en boucle, Tab complète, Entrée complète (ou
 * envoie si `exact`), Échap ferme ; le reste (`null`) suit son cours normal.
 */
export function popupKey(e: PopupKey, count: number, active: number, exact: boolean): PopupAction {
  if (count <= 0) return null
  const mod = !!(e.ctrlKey || e.altKey || e.metaKey)
  switch (e.key) {
    case 'ArrowDown':
      return mod || e.shiftKey ? null : { type: 'move', index: (active + 1) % count }
    case 'ArrowUp':
      return mod || e.shiftKey ? null : { type: 'move', index: (active - 1 + count) % count }
    case 'Tab':
      return mod || e.shiftKey ? null : { type: 'complete' }
    case 'Enter':
      if (mod || e.shiftKey) return null
      return exact ? { type: 'send' } : { type: 'complete' }
    case 'Escape':
      return { type: 'close' }
    default:
      return null
  }
}

/** Origine lisible d'une commande. */
export function sourceLabel(c: SlashCommand): string {
  const base =
    c.source === 'builtin'
      ? t('conversation.slash.source.builtin')
      : c.source === 'project'
        ? t('conversation.slash.source.project')
        : c.source === 'user'
          ? t('conversation.slash.source.user')
          : t('conversation.slash.source.plugin', { plugin: c.plugin ?? '' }).trim()
  return c.kind === 'skill' ? t('conversation.slash.source.skill', { source: base }) : base
}

/**
 * Description et indication d'arguments affichées : version anglaise des
 * commandes intégrées quand l'interface est en anglais (la liste de référence
 * est en français) ; celles des commandes du disque (utilisateur, projet,
 * plugins) viennent de leurs fichiers et restent telles quelles.
 */
export function commandTexts(c: SlashCommand): { description?: string; argument_hint?: string } {
  const en = c.source === 'builtin' && getLocale() === 'en' && Object.prototype.hasOwnProperty.call(BUILTIN_COMMANDS_EN, c.name)
    ? BUILTIN_COMMANDS_EN[c.name]
    : undefined
  if (!en) return { description: c.description, argument_hint: c.argument_hint }
  return {
    description: c.description ? en.description : undefined,
    argument_hint: c.argument_hint ? (en.argument_hint ?? c.argument_hint) : undefined,
  }
}

/** Avertissement d'une commande qui reprend le nom d'une autre, ou `null`. */
export function conflictLabel(c: SlashCommand): string | null {
  if (c.conflict === 'builtin') return t('conversation.slash.conflict.builtin')
  if (c.conflict === 'plugin') return t('conversation.slash.conflict.plugin')
  return null
}

/** Mention discrète sous la liste quand la lecture du démon a été bornée. */
export function listNote(truncated: boolean, ignored: number): string | null {
  const parts: string[] = []
  if (truncated) parts.push(t('conversation.slash.truncated'))
  if (ignored > 0) parts.push(t('conversation.slash.ignored', { count: ignored }))
  return parts.length ? parts.join(' ') : null
}

/** Annonce du nombre de propositions (lecteurs d'écran). */
export function suggestionsLabel(n: number): string {
  if (n === 0) return t('conversation.slash.none')
  return t('conversation.slash.count', { count: n })
}
