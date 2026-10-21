/**
 * Onglet « Conversation » (v0.3, lots 11 et 12, ADR 0005) : la session lue
 * comme un fil de messages, à partir des entrées normalisées par le démon
 * (`conversation.get`, puis `conversation.changed`).
 *
 * - Liste virtualisée : seules les entrées proches de la fenêtre sont
 *   rendues (hauteurs estimées, puis mesurées) ; les plus anciennes se
 *   chargent en remontant ; la vue reste collée en bas tant que
 *   l'utilisateur n'est pas remonté (« Aller en bas » sinon).
 * - Contenu venu de Claude non fiable : jamais de HTML brut (Markdown rendu
 *   par markdown-it sans HTML, le reste en nœuds texte), liens ouverts par
 *   la confirmation de l'app.
 * - Indicateur d'activité tiré des hooks (`session.activity`), annoncé
 *   poliment ; champ de saisie (`sessions.sendPrompt`), avec la liste des
 *   slash commands à `/` (lot 17, `SlashCommandPopup`).
 */
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react'

import {
  ErrorCode,
  type CompactionEntry,
  type ConversationEntry,
  type ConversationSegment,
  type FullPart,
  type PromptEntry,
  type QuestionEntry,
  type Session,
  type SubagentEntry,
  type ToolEntry,
} from '../../../shared/protocol'
import { dateFormat, t as translate } from '../../../shared/i18n'
import { CallError, api, call, errorText } from '../api'
import { useI18n, useT } from '../i18n'
import {
  OLDER_THRESHOLD,
  activityLabel,
  charsLabel,
  clipText,
  conversationReducer,
  estimateHeight,
  formatElapsed,
  historyStep,
  initialConversation,
  inputText,
  isAtBottom,
  isEntry,
  isHiddenEntry,
  layoutOffsets,
  patchHunks,
  promptProblem,
  promptSourceLabel,
  pushHistory,
  questionViews,
  segmentLabel,
  settleDelay,
  subagentStatusLabel,
  threadOf,
  toolIcon,
  toolStatus,
  tokensLabel,
  upsertEntries,
  visibleRange,
} from '../state/conversation'
import { diffRows } from '../state/diff'
import { classifyLink, renderMarkdown } from '../state/markdown'
import { emptyDraft } from '../state/review'
import { completeCommand, isExactCommand, popupKey, rankCommands, slashQuery } from '../state/slashCommands'
import { DiffTable } from './DiffReader'
import { SlashCommandPopup, SlashStatus, optionId, useSlashCommands } from './SlashCommandPopup'

/** Entrées demandées par page. */
const PAGE = 200
/** Marge rendue au-dessus et au-dessous de la fenêtre (px). */
const OVERSCAN = 600
/** Hauteur de la fenêtre tant qu'elle n'est pas mesurée (jsdom, premier rendu). */
const DEFAULT_VIEWPORT = 800

/** Coupes d'affichage (« Voir tout » montre le reste). */
const CLIP_TEXT = { chars: 20_000, lines: 400 }
const CLIP_PROMPT = { chars: 4_000, lines: 60 }
const CLIP_TOOL = { chars: 4_000, lines: 60 }

/** Démon sans la vue conversation (langue courante). */
const unsupportedText = () => translate('conversation.unsupported')

/* ---------- Mémoire par session (brouillon et historique du champ) ---------- */

const drafts = new Map<string, string>()
const histories = new Map<string, readonly string[]>()

/** Oublie le brouillon et l'historique d'une session (tests, session retirée). */
export function forgetComposerMemory(sessionId?: string): void {
  if (sessionId === undefined) {
    drafts.clear()
    histories.clear()
  } else {
    drafts.delete(sessionId)
    histories.delete(sessionId)
  }
}

/* ---------- Contexte partagé par les entrées ---------- */

type FullState = { phase: 'loading' } | { phase: 'ready'; text: string; truncated: boolean } | { phase: 'error'; message: string }

interface RowContext {
  sessionId: string
  onLink: (url: string) => void
  /** Volets dépliés (outil, collage, résumé…), gardés hors des lignes : la virtualisation les démonte. */
  isOpen: (key: string) => boolean
  toggle: (key: string) => void
  /** Contenus entiers (`conversation.full`) déjà demandés. */
  full: (uid: string, part: FullPart) => FullState | undefined
  loadFull: (uid: string, part: FullPart) => void
  segments: readonly ConversationSegment[]
}

/* ---------- Petits blocs ---------- */

function formatTime(ts: string | null | undefined): string | null {
  if (!ts) return null
  const ms = Date.parse(ts)
  if (Number.isNaN(ms)) return null
  return dateFormat({ hour: '2-digit', minute: '2-digit' }).format(new Date(ms))
}

/** Ouvre les liens du Markdown par la confirmation de l'app ; le reste est inerte. */
function linkHandler(onLink: (url: string) => void) {
  return (e: MouseEvent<HTMLElement>) => {
    const a = (e.target as HTMLElement).closest('a')
    if (!a) return
    e.preventDefault()
    const link = classifyLink(a.getAttribute('href'), '')
    if (link.kind === 'external') onLink(link.url)
  }
}

/* Cache LRU du HTML rendu (Markdown et code coloré) : une ligne qui revient à l'écran en défilant n'est pas re-rendue. */
const HTML_CACHE_MAX = 300
const htmlCache = new Map<string, string>()

/** Empreinte FNV-1a 32 bits (texte remplacé à longueur égale). */
function fnv(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(36)
}

/** HTML d'un Markdown, mis en cache par entrée (`cacheKey` : uid et partie), longueur et empreinte. */
function markdownHtml(cacheKey: string, source: string): string {
  const k = `${cacheKey}|${source.length}|${fnv(source)}`
  const hit = htmlCache.get(k)
  if (hit !== undefined) {
    htmlCache.delete(k)
    htmlCache.set(k, hit)
    return hit
  }
  // Identifiants des titres préfixés par l'entrée : uniques dans la page.
  const html = renderMarkdown(source, { idPrefix: cacheKey }).html
  htmlCache.set(k, html)
  if (htmlCache.size > HTML_CACHE_MAX) htmlCache.delete(htmlCache.keys().next().value!)
  return html
}

function Markdown({ source, onLink, cacheKey }: { source: string; onLink: (url: string) => void; cacheKey: string }) {
  const html = useMemo(() => markdownHtml(cacheKey, source), [cacheKey, source])
  const onClick = useMemo(() => linkHandler(onLink), [onLink])
  // HTML produit par markdown-it sans HTML brut (échappé) ni image chargée, comme l'onglet Fichiers.
  return <div className="md cv-md" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
}

/**
 * Texte long : coupé à l'affichage, « Voir tout » le montre en entier ;
 * coupé par le démon (`truncated`) : « Voir tout » le demande (`conversation.full`).
 */
function LongText({
  ctx,
  uid,
  part,
  text,
  truncated,
  clip,
  render,
}: {
  ctx: RowContext
  uid: string
  part: FullPart
  text: string
  truncated: boolean
  clip: { chars: number; lines: number }
  render: (text: string) => ReactNode
}) {
  const t = useT()
  const key = `${uid}:${part}:all`
  const all = ctx.isOpen(key)
  const full = truncated ? ctx.full(uid, part) : undefined
  const fullText = all && full?.phase === 'ready' ? full.text : null
  const { shown, clipped } = useMemo(() => (all ? { shown: text, clipped: false } : clipText(text, clip.chars, clip.lines)), [all, text, clip])
  const more = (clipped || truncated) && !(all && (!truncated || fullText !== null))
  return (
    <>
      {render(fullText ?? shown)}
      {more && (
        <div className="cv-more">
          <span className="hint">
            {truncated ? t('conversation.long.truncated') : t('conversation.long.partial', { chars: charsLabel(text.length) })}
          </span>{' '}
          <button
            type="button"
            className="btn sm ghost"
            disabled={full?.phase === 'loading'}
            onClick={() => {
              if (truncated && full?.phase !== 'ready') ctx.loadFull(uid, part)
              if (!all) ctx.toggle(key)
            }}
          >
            {full?.phase === 'loading' ? t('conversation.loading') : t('conversation.long.showAll')}
          </button>
          {full?.phase === 'error' && (
            <span className="inline-err" role="alert">
              {full.message}
            </span>
          )}
        </div>
      )}
      {all && full?.phase === 'ready' && full.truncated && <p className="hint">{t('conversation.long.fullTruncated')}</p>}
    </>
  )
}

function Pre({ text, className = '' }: { text: string; className?: string }) {
  return <pre className={`cv-pre ${className}`}>{text}</pre>
}

/** Bouton qui déplie un volet (une ligne : icône, titre, détails). */
function Disclosure({
  ctx,
  openKey,
  head,
  label,
  className,
  children,
}: {
  ctx: RowContext
  openKey: string
  head: ReactNode
  label: string
  className: string
  children: () => ReactNode
}) {
  const open = ctx.isOpen(openKey)
  const id = useId()
  return (
    <div className={`${className}${open ? ' open' : ''}`}>
      <button
        type="button"
        className="cv-head"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={label}
        onClick={() => ctx.toggle(openKey)}
      >
        <span className="cv-caret" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        {head}
      </button>
      {open && (
        <div className="cv-body" id={id}>
          {children()}
        </div>
      )}
    </div>
  )
}

/* ---------- Entrées ---------- */

function PromptRow({ e, ctx }: { e: PromptEntry; ctx: RowContext }) {
  const t = useT()
  const source = promptSourceLabel(e.source)
  const pasted = Array.isArray(e.pasted) ? e.pasted.filter((p) => p && typeof p.text === 'string') : []
  const time = formatTime(e.ts)
  // Texte entier relu (collages remis en place) : les volets des collages feraient double emploi.
  const fullShown = e.truncated === true && ctx.isOpen(`${e.uid}:text:all`) && ctx.full(e.uid, 'text')?.phase === 'ready'
  // Fil d'un sous-agent : sa consigne vient de l'agent qui l'a lancé, pas de l'utilisateur.
  const fromParent = !!e.agent_id && e.source === 'system'
  return (
    <div className="cv-prompt">
      <div className="cv-who">
        <span className="lbl">{fromParent ? t('conversation.prompt.fromParent') : t('conversation.you')}</span>
        {source && !fromParent && <span className="chip">{source}</span>}
        {time && <span className="hint">{time}</span>}
      </div>
      <LongText
        ctx={ctx}
        uid={e.uid}
        part="text"
        text={typeof e.text === 'string' ? e.text : ''}
        truncated={e.truncated === true}
        clip={CLIP_PROMPT}
        render={(x) => <div className="cv-ptext">{x}</div>}
      />
      {!fullShown &&
        pasted.map((p, i) => (
          <Disclosure
            key={`${p.id}:${i}`}
            ctx={ctx}
            openKey={`${e.uid}:paste:${i}`}
            className="cv-paste"
            label={t('conversation.paste.label', { id: p.id, chars: charsLabel(p.text.length) })}
            head={
              <span>
                {t('conversation.paste.title', { id: p.id })} <span className="hint">· {charsLabel(p.text.length)}</span>
              </span>
            }
          >
            {() => <Pre text={clipText(p.text, 200_000, 5_000).shown} />}
          </Disclosure>
        ))}
    </div>
  )
}

function ToolRow({ e, ctx }: { e: ToolEntry; ctx: RowContext }) {
  const t = useT()
  const st = toolStatus(e.result)
  const name = typeof e.name === 'string' && e.name ? e.name : t('conversation.tool.fallbackName')
  const summary = typeof e.summary === 'string' ? e.summary : ''
  return (
    <Disclosure
      ctx={ctx}
      openKey={`${e.uid}:tool`}
      className={`cv-tool st-${st.key}`}
      label={
        summary
          ? t('conversation.tool.labelSummary', { name, summary, status: st.label })
          : t('conversation.tool.label', { name, status: st.label })
      }
      head={
        <>
          <span className="cv-icon" aria-hidden="true">
            {toolIcon(name)}
          </span>
          <b className="cv-tname">{name}</b>
          <span className="cv-sum">{summary}</span>
          <span className={`cv-st ${st.key}`}>
            <span aria-hidden="true">{st.glyph}</span> {st.label}
          </span>
        </>
      }
    >
      {() => <ToolBody e={e} ctx={ctx} />}
    </Disclosure>
  )
}

function ToolBody({ e, ctx }: { e: ToolEntry; ctx: RowContext }) {
  const t = useT()
  const input = useMemo(() => inputText(e.input), [e.input])
  const hunks = useMemo(() => patchHunks(e.result?.patch), [e.result?.patch])
  const rows = useMemo(() => (hunks ? diffRows({ hunks, binary: false, too_large: false }) : null), [hunks])
  const r = e.result
  return (
    <>
      <div className="cv-sect">
        <span className="lbl">{t('conversation.tool.input')}</span>
        <LongText
          ctx={ctx}
          uid={e.uid}
          part="input"
          text={input}
          truncated={e.input_truncated === true}
          clip={CLIP_TOOL}
          render={(x) => <Pre text={x} />}
        />
      </div>
      {rows && rows.length > 0 && (
        <div className="cv-sect cv-diff">
          <span className="lbl">{t('conversation.tool.change')}</span>
          <div className="cv-diffwrap">
            <DiffTable
              rows={rows}
              draft={emptyDraft}
              review={() => undefined}
              full
              commentsAt={() => []}
              editingAt={() => false}
              onEdit={() => undefined}
            />
          </div>
        </div>
      )}
      <div className="cv-sect">
        <span className="lbl">{t('conversation.tool.result')}</span>
        {r ? (
          <LongText
            ctx={ctx}
            uid={e.uid}
            part="result"
            text={typeof r.text === 'string' ? r.text : ''}
            truncated={r.truncated === true}
            clip={CLIP_TOOL}
            render={(x) => (x ? <Pre text={x} className={r.status === 'error' ? 'err' : ''} /> : <p className="hint">{t('conversation.tool.empty')}</p>)}
          />
        ) : (
          <p className="hint">{t('conversation.tool.waitingResult')}</p>
        )}
      </div>
    </>
  )
}

function QuestionRow({ e }: { e: QuestionEntry }) {
  const t = useT()
  const qs = useMemo(() => questionViews(e.questions, e.answers), [e.questions, e.answers])
  const answered = qs.some((q) => q.answer)
  return (
    <div className="cv-question">
      <div className="cv-who">
        <span className="cv-icon" aria-hidden="true">
          ?
        </span>
        <span className="lbl">{t('conversation.questionFromClaude')}</span>
        {!answered && <span className="chip pend">{t('conversation.question.awaiting')}</span>}
      </div>
      {qs.length === 0 && <p className="hint">{t('conversation.question.unreadable')}</p>}
      {qs.map((q, i) => (
        <div key={i} className="cv-q">
          {q.header && <span className="chip">{q.header}</span>}
          <p className="cv-qtext">{q.question}</p>
          {q.options.length > 0 && (
            <ul className="cv-opts">
              {q.options.map((o, j) => {
                const chosen = !!q.answer?.includes(o.label)
                return (
                  <li key={j} className={chosen ? 'chosen' : undefined}>
                    <span aria-hidden="true">{chosen ? '✓' : '○'}</span> {o.label}
                    {chosen && <span className="sr-only">{t('conversation.question.chosen')}</span>}
                    {o.description && <span className="hint"> — {o.description}</span>}
                  </li>
                )
              })}
            </ul>
          )}
          {q.answer && !q.answer.every((a) => q.options.some((o) => o.label === a)) && (
            <p className="cv-answer">
              <span className="lbl">{t('conversation.question.answer')}</span> {q.answer.join(', ')}
            </p>
          )}
        </div>
      ))}
    </div>
  )
}

function CompactionRow({ e, ctx }: { e: CompactionEntry; ctx: RowContext }) {
  const t = useT()
  const trigger = e.trigger === 'auto' ? t('conversation.compaction.auto') : e.trigger === 'manual' ? t('conversation.compaction.manual') : null
  const tokens =
    e.pre_tokens != null || e.post_tokens != null
      ? t('conversation.compaction.tokens', { pre: tokensLabel(e.pre_tokens), post: tokensLabel(e.post_tokens) })
      : ''
  const label = `${trigger ? t('conversation.compaction.titleTrigger', { trigger }) : t('conversation.compaction.title')}${tokens}`
  if (!e.summary) {
    return (
      <div className="cv-sep" role="separator" aria-label={label}>
        <span>{label}</span>
      </div>
    )
  }
  return (
    <Disclosure
      ctx={ctx}
      openKey={`${e.uid}:summary`}
      className="cv-sep cv-compact"
      label={t('conversation.compaction.summaryLabel', { label })}
      head={<span>{t('conversation.compaction.summaryHead', { label })}</span>}
    >
      {() => (
        <LongText
          ctx={ctx}
          uid={e.uid}
          part="text"
          text={e.summary ?? ''}
          truncated={e.truncated === true}
          clip={CLIP_TEXT}
          render={(x) => <Markdown source={x} onLink={ctx.onLink} cacheKey={`${e.uid}:summary`} />}
        />
      )}
    </Disclosure>
  )
}

function SubagentRow({ e, ctx }: { e: SubagentEntry; ctx: RowContext }) {
  const t = useT()
  const status = subagentStatusLabel(e.status)
  const key = typeof e.status === 'string' ? e.status : 'other'
  const glyph = e.status === 'running' ? '…' : e.status === 'done' ? '✓' : e.status === 'failed' ? '×' : e.status === 'interrupted' ? '■' : '?'
  const type = e.agent_type || t('conversation.agent.fallbackTitle')
  return (
    <Disclosure
      ctx={ctx}
      openKey={`${e.uid}:agent`}
      className={`cv-tool cv-agent st-${key}`}
      label={
        e.description
          ? t('conversation.agent.labelDescription', { type, description: e.description, status })
          : t('conversation.agent.label', { type, status })
      }
      head={
        <>
          <span className="cv-icon" aria-hidden="true">
            ⧉
          </span>
          <b className="cv-tname">{type}</b>
          <span className="cv-sum">{e.description ?? ''}</span>
          <span className={`cv-st ${key === 'done' ? 'ok' : key === 'failed' ? 'error' : key}`}>
            <span aria-hidden="true">{glyph}</span> {status}
          </span>
        </>
      }
    >
      {() =>
        e.agent_id ? (
          <SubagentThread sessionId={ctx.sessionId} agentId={e.agent_id} ctx={ctx} />
        ) : (
          <p className="hint">{t('conversation.agentNothingYet')}</p>
        )
      }
    </Disclosure>
  )
}

/** Entrées d'un sous-agent (chargées à l'ouverture, tenues à jour par `conversation.changed`). */
function SubagentThread({ sessionId, agentId, ctx }: { sessionId: string; agentId: string; ctx: RowContext }) {
  const t = useT()
  const [entries, setEntries] = useState<readonly ConversationEntry[] | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** Notifications reçues avant la première page : appliquées après (jamais de fil partiel affiché). */
  const buffered = useRef<readonly ConversationEntry[]>([])
  const loaded = useRef(false)

  const load = useCallback(
    async (before?: string) => {
      setBusy(true)
      try {
        const page = await call('conversation.subagent', { id: sessionId, agent_id: agentId, limit: PAGE, ...(before ? { before } : {}) })
        const list = (Array.isArray(page.entries) ? page.entries : []).filter(isEntry)
        setEntries((prev) => {
          if (!before || !prev) {
            const first = upsertEntries(list, buffered.current)
            buffered.current = []
            return first
          }
          const known = new Set(prev.map((x) => x.uid))
          return [...list.filter((x) => !known.has(x.uid)), ...prev]
        })
        loaded.current = true
        setHasMore(page.has_more === true)
        setError(null)
      } catch (err) {
        setError(err instanceof CallError && err.failure.code === ErrorCode.MethodNotFound ? unsupportedText() : errorText(err))
      } finally {
        setBusy(false)
      }
    },
    [sessionId, agentId],
  )

  useEffect(() => {
    void load()
  }, [load])

  useEffect(
    () =>
      api.onNotification((n) => {
        if (n.method !== 'conversation.changed' || n.params?.id !== sessionId || !Array.isArray(n.params.upserts)) return
        const mine = n.params.upserts.filter((x) => isEntry(x) && threadOf(x) === agentId)
        if (!mine.length) return
        if (!loaded.current) buffered.current = upsertEntries(buffered.current, mine)
        else setEntries((prev) => upsertEntries(prev ?? [], mine))
      }),
    [sessionId, agentId],
  )

  if (error && !entries) {
    return (
      <p className="inline-err" role="alert">
        {t('conversation.thread.unavailable', { error })}
      </p>
    )
  }
  if (!entries) return <p className="hint">{t('conversation.thread.loading')}</p>
  return (
    <div className="cv-thread" aria-label={t('conversation.thread.label')}>
      {hasMore && (
        <button type="button" className="btn sm ghost" disabled={busy} onClick={() => void load(entries[0]?.uid)}>
          {busy ? t('conversation.loading') : t('conversation.thread.older')}
        </button>
      )}
      {entries.length === 0 && <p className="hint">{t('conversation.agentNothingYet')}</p>}
      {entries.map((x, i) => (
        <EntryRow key={x.uid} entry={x} prev={entries[i - 1]} ctx={ctx} />
      ))}
      {error && (
        <p className="inline-err" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

function EntryBody({ e, ctx }: { e: ConversationEntry; ctx: RowContext }) {
  const { t, rich } = useI18n()
  switch (e.kind) {
    case 'prompt':
      return <PromptRow e={e} ctx={ctx} />
    case 'text':
      return (
        <div className="cv-text">
          <LongText
            ctx={ctx}
            uid={e.uid}
            part="text"
            text={typeof e.markdown === 'string' ? e.markdown : ''}
            truncated={e.truncated === true}
            clip={CLIP_TEXT}
            render={(x) => <Markdown source={x} onLink={ctx.onLink} cacheKey={`${e.uid}:text`} />}
          />
        </div>
      )
    case 'thinking':
      return (
        <div className="cv-mark">
          <span aria-hidden="true">✻</span> {t('conversation.entry.thinking')}
        </div>
      )
    case 'tool':
      return <ToolRow e={e} ctx={ctx} />
    case 'question':
      return <QuestionRow e={e} />
    case 'subagent':
      return <SubagentRow e={e} ctx={ctx} />
    case 'notification':
      return (
        <div className="cv-mark cv-notif">
          <span aria-hidden="true">⚑</span>{' '}
          {e.status === 'completed'
            ? t('conversation.entry.taskCompleted')
            : e.status
              ? t('conversation.entry.taskStatus', { status: e.status })
              : t('conversation.entry.taskReported')}
          {e.summary && (
            <>
              {' — '}
              <LongText
                ctx={ctx}
                uid={e.uid}
                part="text"
                text={e.summary}
                truncated={e.truncated === true}
                clip={CLIP_PROMPT}
                render={(x) => <span className="cv-sum">{x}</span>}
              />
            </>
          )}
        </div>
      )
    case 'compaction':
      return <CompactionRow e={e} ctx={ctx} />
    case 'command': {
      const name = typeof e.name === 'string' ? e.name : ''
      const head = (
        <span className="mono">
          {name.startsWith('/') ? name : `/${name}`}
          {e.args ? ` ${e.args}` : ''}
        </span>
      )
      if (!e.output) {
        return (
          <div className="cv-mark cv-cmd">
            <span aria-hidden="true">›</span> {head}
          </div>
        )
      }
      return (
        <Disclosure ctx={ctx} openKey={`${e.uid}:out`} className="cv-tool cv-cmd" label={t('conversation.entry.commandOutput', { name })} head={head}>
          {() => (
            <LongText
              ctx={ctx}
              uid={e.uid}
              part="text"
              text={e.output ?? ''}
              truncated={e.truncated === true}
              clip={CLIP_TOOL}
              render={(x) => <Pre text={x} />}
            />
          )}
        </Disclosure>
      )
    }
    case 'error':
      return (
        <div className="cv-error" role="note">
          <span aria-hidden="true">×</span> <b>{t('conversation.entry.error')}</b>
          {t('conversation.colon')}
          <LongText
            ctx={ctx}
            uid={e.uid}
            part="text"
            text={typeof e.message === 'string' ? e.message : ''}
            truncated={e.truncated === true}
            clip={CLIP_PROMPT}
            render={(x) => <span>{x}</span>}
          />
        </div>
      )
    default: {
      const u = e as { kind?: unknown; type?: unknown; subtype?: unknown }
      const what = [u.type, u.subtype].filter((x) => typeof x === 'string' && x).join(' / ') || String(u.kind ?? t('conversation.entry.unknownKind'))
      return (
        <div className="cv-mark cv-unknown">
          <span aria-hidden="true">◇</span> {rich('conversation.entry.unknown', { what: <span className="mono">{what}</span> })}
        </div>
      )
    }
  }
}

/** Une entrée, précédée d'un séparateur quand elle ouvre un nouveau segment (`/clear`). */
const EntryRow = memo(function EntryRow({
  entry,
  prev,
  ctx,
}: {
  entry: ConversationEntry
  prev: ConversationEntry | undefined
  ctx: RowContext
}) {
  const newSegment = !!prev && prev.segment !== entry.segment
  return (
    <>
      {newSegment && (
        <div className="cv-sep cv-clear" role="separator">
          <span>{segmentLabel(ctx.segments.find((s) => s.segment === entry.segment))}</span>
        </div>
      )}
      <EntryBody e={entry} ctx={ctx} />
    </>
  )
})

/* ---------- Indicateur d'activité ---------- */

export function ActivityBar({ session }: { session: Session }) {
  const t = useT()
  const label =
    activityLabel(session.activity) ??
    (session.activity === undefined && session.status.state === 'running' ? t('conversation.activity.working') : null)
  const since = session.activity?.since ? Date.parse(session.activity.since) : Number.NaN
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!label) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [label, since])
  return (
    <div className="cv-activity">
      {/* Région annoncée : le libellé seul, pas le temps qui change chaque seconde. */}
      <span className="sr-only" role="status" aria-live="polite">
        {label ?? ''}
      </span>
      {label && (
        <span className="cv-act" aria-hidden="true">
          <span className="spin" /> {label}
          {Number.isFinite(since) && <span className="hint"> {formatElapsed(now - since)}</span>}
        </span>
      )}
    </div>
  )
}

/* ---------- Champ de saisie ---------- */

/** Le focus est-il libre (personne ne l'a mis ailleurs) ou déjà dans ce champ ? */
function focusFree(own: HTMLElement | null): boolean {
  const a = document.activeElement
  return !a || a === document.body || a === own || (!!own && !!own.closest('form')?.contains(a))
}

export function Composer({
  session,
  onSend,
  slashCommands = null,
}: {
  session: Session
  /** Envoie le prompt ; rejette avec un message dans la langue courante. */
  onSend: (text: string) => Promise<void>
  /**
   * Le démon annonce `commands.list` (`hello.capabilities.slash_commands`) ;
   * `false` ou inconnu : liste intégrée seulement.
   */
  slashCommands?: boolean | null
}) {
  const { t, rich } = useI18n()
  const id = session.id
  const [value, setValue] = useState(() => drafts.get(id) ?? '')
  const [index, setIndex] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Texte d'un envoi refusé pendant que l'utilisateur écrivait déjà autre chose. */
  const [unsent, setUnsent] = useState<string | null>(null)
  const ref = useRef<HTMLTextAreaElement>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const hintId = useId()
  const listId = useId()
  const valueRef = useRef(value)
  valueRef.current = value
  /* Slash commands (lot 17) : curseur suivi, mot écarté par Échap, proposition choisie. */
  const [caret, setCaret] = useState<number | null>(null)
  const [focused, setFocused] = useState(false)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const pendingCaret = useRef<number | null>(null)

  const waiting = session.pending.length > 0 || session.status.state === 'waiting'
  const blocked = !session.alive
    ? t('conversation.composer.stopped')
    : waiting
      ? t('conversation.composer.waiting')
      : null

  /**
   * Champ bloqué en lecture seule (`aria-disabled`) plutôt que `disabled` :
   * il garde le focus et le brouillon. Si le champ avait le focus quand la
   * demande s'est ouverte, il le reprend quand elle se ferme (sauf si
   * l'utilisateur l'a mis ailleurs entre-temps, hors de la zone des demandes qui disparaît).
   */
  const hadFocus = useRef(false)
  const wasBlocked = useRef(!!blocked)
  useLayoutEffect(() => {
    const isBlocked = !!blocked
    if (isBlocked && !wasBlocked.current) hadFocus.current = document.activeElement === ref.current
    if (!isBlocked && wasBlocked.current && hadFocus.current) {
      hadFocus.current = false
      const a = document.activeElement
      if (!a || a === document.body || a === ref.current || !a.isConnected || !!a.closest('.asks')) ref.current?.focus()
    }
    wasBlocked.current = isBlocked
  }, [blocked])

  function set(v: string) {
    setValue(v)
    if (v) drafts.set(id, v)
    else drafts.delete(id)
  }

  const query = blocked ? null : slashQuery(value, caret)
  const token = query ? value.slice(0, query.end) : null
  const wanted = focused && query !== null && token !== dismissed
  const slash = useSlashCommands(id, slashCommands, wanted)
  const suggestions = useMemo(() => (wanted && query ? rankCommands(slash.commands, query.query) : []), [wanted, query?.query, slash.commands])
  const popupOpen = wanted && suggestions.length > 0
  const activeIndex = Math.min(active, Math.max(0, suggestions.length - 1))
  // Nouvelle requête : la première proposition est choisie ; un autre mot lève l'Échap.
  useEffect(() => {
    setActive(0)
  }, [query?.query])
  useEffect(() => {
    if (dismissed !== null && token !== dismissed) setDismissed(null)
  }, [token, dismissed])
  useLayoutEffect(() => {
    const at = pendingCaret.current
    if (at === null || !ref.current) return
    pendingCaret.current = null
    ref.current.setSelectionRange(at, at)
    // Après coup : un `select` de la touche pressée a pu relever l'ancienne position.
    setCaret(at)
  }, [value])

  function complete(index: number) {
    const c = suggestions[index]
    if (!query || !c) return
    const next = completeCommand(value, query, c)
    set(next.value)
    setIndex(null)
    setError(null)
    setCaret(next.caret)
    pendingCaret.current = next.caret
  }

  async function submit() {
    if (blocked || busy) return
    const text = value
    const problem = promptProblem(text)
    if (problem) {
      // Jamais d'Entrée sur un champ vide : rien ne part.
      if (text.trim()) setError(problem)
      return
    }
    setBusy(true)
    setError(null)
    setUnsent(null)
    histories.set(id, pushHistory(histories.get(id) ?? [], text))
    setIndex(null)
    set('')
    try {
      await onSend(text)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      // Le texte revient dans le champ s'il est resté vide ; sinon on propose de le récupérer.
      if (valueRef.current === '') set(text)
      else setUnsent(text)
    } finally {
      setBusy(false)
      if (focusFree(ref.current)) ref.current?.focus()
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (popupOpen && query && !(e.nativeEvent.isComposing || e.keyCode === 229)) {
      const cur = suggestions[activeIndex]
      const act = popupKey(e, suggestions.length, activeIndex, !!cur && isExactCommand(query, cur))
      if (act && act.type !== 'send') {
        e.preventDefault()
        if (act.type === 'move') setActive(act.index)
        else if (act.type === 'complete') complete(activeIndex)
        else {
          // Échap ferme la liste, et seulement elle.
          e.stopPropagation()
          setDismissed(token)
        }
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      // Composition en cours (IME) : Entrée valide la composition, n'envoie rien.
      if (e.nativeEvent.isComposing || e.keyCode === 229) return
      e.preventDefault()
      void submit()
      return
    }
    if (blocked) return
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const step = historyStep(histories.get(id) ?? [], index, value, e.key === 'ArrowUp' ? 'up' : 'down')
      if (!step) return
      e.preventDefault()
      setIndex(step.index)
      set(step.value)
      // Un prompt `/…` rappelé de l'historique n'ouvre pas la liste (↑ / ↓ continuent l'historique).
      const q = slashQuery(step.value, null)
      setDismissed(q ? step.value.slice(0, q.end) : null)
      setCaret(null)
    }
  }

  return (
    <form
      ref={formRef}
      className="cv-composer"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <div className="cv-input">
        {popupOpen && (
          <SlashCommandPopup
            listId={listId}
            items={suggestions}
            active={activeIndex}
            note={slash.note}
            anchor={formRef.current}
            onPick={(i) => {
              complete(i)
              ref.current?.focus()
            }}
          />
        )}
        <SlashStatus count={suggestions.length} open={popupOpen} />
        <textarea
          ref={ref}
          aria-label={t('conversation.composer.label')}
          aria-describedby={hintId}
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-controls={popupOpen ? listId : undefined}
          aria-activedescendant={popupOpen ? optionId(listId, activeIndex) : undefined}
          aria-disabled={blocked ? true : undefined}
          readOnly={!!blocked}
          // Bloqué : la phrase entière est dans l'aide sous le champ ; ici, un rappel court.
          placeholder={
            blocked
              ? session.alive
                ? t('conversation.composer.placeholderWaiting')
                : t('conversation.composer.placeholderStopped')
              : t('conversation.composer.placeholder')
          }
          rows={Math.min(8, Math.max(1, value.split('\n').length))}
          value={value}
          onChange={(e) => {
            if (blocked) return
            set(e.target.value)
            setCaret(e.target.selectionStart)
            setIndex(null)
            setError(null)
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={onKeyDown}
        />
        <button type="submit" className="btn pri" disabled={!!blocked || busy || !value.trim()}>
          {busy ? t('conversation.sending') : t('conversation.composer.send')}
        </button>
      </div>
      {error && (
        <p className="inline-err" role="alert">
          {error}
          {unsent !== null && (
            <>
              {' '}
              <button
                type="button"
                className="btn sm ghost"
                onClick={() => {
                  const cur = valueRef.current
                  set(cur.trim() ? `${cur}\n${unsent}` : unsent)
                  setUnsent(null)
                  setError(null)
                  ref.current?.focus()
                }}
              >
                {t('conversation.composer.restore')}
              </button>
            </>
          )}
        </p>
      )}
      <p className="hint" id={hintId}>
        {blocked ? `${blocked} ` : ''}
        {rich('conversation.composer.hint', {
          enter: <kbd>{t('conversation.key.enter')}</kbd>,
          shift: <kbd>{t('conversation.key.shift')}</kbd>,
          up: <kbd>↑</kbd>,
          down: <kbd>↓</kbd>,
          slash: <kbd>/</kbd>,
          // i18n-exempt: nom de touche identique dans les deux langues
          tab: <kbd>Tab</kbd>,
          esc: <kbd>{t('conversation.key.esc')}</kbd>,
        })}
      </p>
    </form>
  )
}

/* ---------- Ligne de la liste virtualisée ---------- */

/** Ligne mesurée : inscrite une fois auprès de l'observateur (pas à chaque rendu). */
const Item = memo(function Item({
  entry,
  prev,
  index,
  ctx,
  observer,
}: {
  entry: ConversationEntry
  prev: ConversationEntry | undefined
  index: number
  ctx: RowContext
  observer: ResizeObserver | null
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || !observer) return
    observer.observe(el)
    return () => observer.unobserve(el)
  }, [observer])
  return (
    <div ref={ref} className={`cv-item k-${entry.kind}`} data-uid={entry.uid} data-index={index}>
      <EntryRow entry={entry} prev={prev} ctx={ctx} />
    </div>
  )
})

/* ---------- Vue ---------- */

export function ConversationView({
  session,
  onLink,
  hidden = false,
  viewportHeight,
  slashCommands = null,
}: {
  session: Session
  onLink: (url: string) => void
  /** Le démon connaît `commands.list` (capacité `slash_commands` du `hello`). */
  slashCommands?: boolean | null
  /** Onglet masqué : la vue reste montée (état gardé) mais ne défile pas. */
  hidden?: boolean
  /** Hauteur de la fenêtre imposée (tests sans mise en page). */
  viewportHeight?: number
}) {
  const t = useT()
  const id = session.id
  const [state, dispatch] = useReducer(conversationReducer, initialConversation)
  const [reloadSeq, reload] = useReducer((n: number) => n + 1, 0)

  /* Volets dépliés et contenus entiers, gardés ici (les lignes se démontent en défilant). */
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  const [fulls, setFulls] = useState<ReadonlyMap<string, FullState>>(() => new Map())
  const fullsRef = useRef(fulls)
  fullsRef.current = fulls

  /** Contenus entiers périmés : l'entrée a été remplacée par le démon. */
  const dropFulls = useCallback((uids: readonly string[]) => {
    if (uids.length === 0) return
    setFulls((m) => {
      let next: Map<string, FullState> | null = null
      for (const k of m.keys()) {
        const uid = k.slice(0, k.lastIndexOf(':'))
        if (uids.includes(uid)) {
          next ??= new Map(m)
          next.delete(k)
        }
      }
      return next ?? m
    })
  }, [])

  // Première page, puis à chaque reconnexion au démon (des notifications ont pu manquer).
  useEffect(() => {
    let alive = true
    dispatch({ type: 'reload' })
    setFulls(new Map())
    call('conversation.get', { id, limit: PAGE })
      .then((page) => alive && dispatch({ type: 'loaded', page }))
      .catch((e: unknown) => {
        if (!alive) return
        const unsupported = e instanceof CallError && e.failure.code === ErrorCode.MethodNotFound
        dispatch({ type: 'failed', unsupported, message: unsupported ? unsupportedText() : errorText(e) })
      })
    return () => {
      alive = false
    }
  }, [id, reloadSeq])

  useEffect(
    () =>
      api.onNotification((n) => {
        if (n.method !== 'conversation.changed' || n.params?.id !== id) return
        const upserts = Array.isArray(n.params.upserts) ? n.params.upserts.filter(isEntry) : []
        dropFulls(upserts.map((e) => e.uid))
        dispatch({ type: 'changed', upserts, segment: n.params.segment_started })
      }),
    [id, dropFulls],
  )

  useEffect(
    () =>
      api.onConnection((c) => {
        if (c.state === 'connected') reload()
      }),
    [],
  )

  useEffect(() => {
    if (!session.alive) dispatch({ type: 'stopped' })
  }, [session.alive])

  /*
   * Repli des prompts en attente : une slash command sans trace reconnaissable
   * (ou un collage réécrit) ne doit pas rester « en attente » pour toujours.
   * Hors repos : l'envoi a été pris en compte ; au repos, après un délai de
   * grâce, les attentes prises en compte (ou anciennes) sont retirées.
   */
  const activityKind = session.activity?.kind ?? null
  useEffect(() => {
    if (activityKind !== null) dispatch({ type: 'activity', idle: activityKind === 'idle' })
  }, [activityKind, state.pending])
  useEffect(() => {
    if (activityKind !== 'idle') return
    const delay = settleDelay(state.pending, Date.now())
    if (delay === null) return
    const timer = setTimeout(() => dispatch({ type: 'settle', now: Date.now() }), delay)
    return () => clearTimeout(timer)
  }, [activityKind, state.pending])

  const toggle = useCallback((key: string) => {
    setOpen((s) => {
      const n = new Set(s)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })
  }, [])
  const loadFull = useCallback(
    (uid: string, part: FullPart) => {
      const key = `${uid}:${part}`
      if (fullsRef.current.get(key)?.phase === 'loading') return
      setFulls((m) => new Map(m).set(key, { phase: 'loading' }))
      call('conversation.full', { id, uid, part })
        .then((r) =>
          setFulls((m) => new Map(m).set(key, { phase: 'ready', text: typeof r.text === 'string' ? r.text : '', truncated: r.truncated === true })),
        )
        .catch((e: unknown) => setFulls((m) => new Map(m).set(key, { phase: 'error', message: translate('conversation.long.fullUnavailable', { error: errorText(e) }) })))
    },
    [id],
  )
  const ctx = useMemo<RowContext>(
    () => ({
      sessionId: id,
      onLink,
      isOpen: (k) => open.has(k),
      toggle,
      full: (uid, part) => fulls.get(`${uid}:${part}`),
      loadFull,
      segments: state.segments,
    }),
    [id, onLink, open, toggle, fulls, loadFull, state.segments],
  )

  /* Envoi d'un prompt : affiché tout de suite « en attente », retiré à son arrivée dans le transcript. */
  const nextPending = useRef(0)
  const send = useCallback(
    async (text: string) => {
      const pid = ++nextPending.current
      dispatch({ type: 'send', id: pid, text, at: Date.now() })
      stuck.current = true
      try {
        await call('sessions.sendPrompt', { id, text })
        dispatch({ type: 'sent', id: pid })
      } catch (e) {
        dispatch({ type: 'sendFailed', id: pid })
        throw new Error(
          e instanceof CallError && e.failure.code === ErrorCode.MethodNotFound
            ? translate('conversation.sendUnsupported')
            : translate('conversation.sendFailed', { error: errorText(e) }),
        )
      }
    },
    [id],
  )

  /* ---------- Liste virtualisée ---------- */

  const scroller = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  /** Haut de la liste dans le fil (barre « plus anciennes », marges) : les décalages sont comptés depuis là. */
  const listTop = useRef(0)
  const heights = useRef(new Map<string, number>())
  const [measureSeq, bumpMeasure] = useReducer((n: number) => n + 1, 0)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(viewportHeight ?? DEFAULT_VIEWPORT)
  /** Collée en bas tant que l'utilisateur n'est pas remonté. */
  const stuck = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  /** Dernière position lue (un onglet masqué par `display: none` la remet à 0). */
  const lastTop = useRef(0)
  const hiddenRef = useRef(hidden)
  hiddenRef.current = hidden
  // Entrées affichées : sans la commande `/clear` qui ouvre un segment (le séparateur la dit déjà). Le réducteur la
  // garde pour rapprocher un `/clear` envoyé d'ici ; le curseur des entrées plus anciennes reste `state.entries[0]`.
  const entries = useMemo(() => (state.entries.some(isHiddenEntry) ? state.entries.filter((e) => !isHiddenEntry(e)) : state.entries), [state.entries])

  const offsets = useMemo(
    () => layoutOffsets(entries.map((e) => heights.current.get(e.uid) ?? estimateHeight(e))),
    // `measureSeq` : une hauteur mesurée a changé.
    [entries, measureSeq],
  )
  const range = visibleRange(offsets, Math.max(0, scrollTop - listTop.current), viewportHeight ?? viewport, OVERSCAN)
  const latest = useRef({ entries, offsets, range })
  latest.current = { entries, offsets, range }

  /**
   * Mesure des lignes rendues. Une ligne entièrement au-dessus de la
   * position lue qui change de taille décale le défilement d'autant : la
   * ligne lue ne bouge pas.
   */
  const observer = useMemo(() => {
    if (typeof ResizeObserver === 'undefined') return null
    return new ResizeObserver((items) => {
      if (hiddenRef.current) return
      let changed = false
      let above = 0
      const sc = scroller.current
      const readTop = (sc?.scrollTop ?? 0) - listTop.current
      const { entries: list, offsets: off } = latest.current
      for (const it of items) {
        const el = it.target as HTMLElement
        const uid = el.dataset.uid
        if (!uid) continue
        const h = it.borderBoxSize?.[0]?.blockSize ?? el.getBoundingClientRect().height
        if (!(h > 0)) continue
        const idx = Number(el.dataset.index)
        const entry = list[idx]?.uid === uid ? list[idx] : list.find((x) => x.uid === uid)
        const old = heights.current.get(uid) ?? (entry ? estimateHeight(entry) : h)
        if (Math.abs(h - old) < 0.5) continue
        heights.current.set(uid, h)
        changed = true
        const top = list[idx]?.uid === uid ? off[idx] : undefined
        if (top !== undefined && top + old <= readTop) above += h - old
      }
      if (!changed) return
      if (sc && above !== 0 && !stuck.current) {
        sc.scrollTop += above
        lastTop.current = sc.scrollTop
      }
      bumpMeasure()
      // Collée en bas : la nouvelle hauteur est appliquée au rendu suivant, l'effet de mise en page y recolle.
    })
  }, [])
  useEffect(() => () => observer?.disconnect(), [observer])

  // Taille de la fenêtre (la zone des demandes, le zoom la changent) : collée en bas, elle y reste.
  useEffect(() => {
    const el = scroller.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (hiddenRef.current || el.clientHeight <= 0) return
      if (viewportHeight === undefined) setViewport(el.clientHeight)
      if (stuck.current) stickToBottom(el)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [viewportHeight, state.phase])

  // Collée en bas : on y reste à chaque nouvelle entrée ou mesure ; ailleurs, la position lue est gardée.
  const anchor = useRef<{ uid: string; delta: number; first: string } | null>(null)
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el || hidden) return
    listTop.current = listRef.current?.offsetTop ?? 0
    const a = anchor.current
    if (a) {
      // Entrées plus anciennes ajoutées en tête : la ligne lue reste à sa place.
      const i = entries.findIndex((x) => x.uid === a.uid)
      if (i >= 0 && entries[0]?.uid !== a.first) {
        el.scrollTop = listTop.current + offsets[i]! - a.delta
        lastTop.current = el.scrollTop
        setScrollTop(el.scrollTop)
      }
      if (!state.olderLoading) anchor.current = null
      return
    }
    if (stuck.current) {
      el.scrollTop = el.scrollHeight
      lastTop.current = el.scrollTop
      if (el.scrollTop !== scrollTop) setScrollTop(el.scrollTop)
    } else if (el.scrollTop !== lastTop.current) {
      // Retour sur l'onglet : `display: none` a remis le défilement à 0.
      el.scrollTop = lastTop.current
      setScrollTop(el.scrollTop)
    }
  }, [entries, offsets, state.pending.length, state.olderLoading, hidden, viewport])

  const firstUid = useRef<string | undefined>(undefined)
  firstUid.current = state.entries[0]?.uid
  const loadOlder = useCallback(() => {
    const { entries: list, offsets: off, range: r } = latest.current
    const first = list[0]
    if (!first || !firstUid.current) return
    const sc = scroller.current
    const pivot = list[r.start] ?? first
    const idx = list[r.start] ? r.start : 0
    anchor.current = { uid: pivot.uid, delta: listTop.current + off[idx]! - (sc?.scrollTop ?? 0), first: first.uid }
    dispatch({ type: 'olderStart' })
    call('conversation.get', { id, before: firstUid.current, limit: PAGE })
      .then((page) => dispatch({ type: 'older', page }))
      .catch((e: unknown) => {
        anchor.current = null
        dispatch({ type: 'olderFailed', message: errorText(e) })
      })
  }, [id])

  function onScroll() {
    const el = scroller.current
    // Onglet masqué : `display: none` remet le défilement à 0, ce n'est pas l'utilisateur.
    if (!el || hiddenRef.current) return
    const bottom = isAtBottom(el.scrollTop, el.scrollHeight, el.clientHeight)
    if (stuck.current && !bottom && el.scrollTop >= lastTop.current - 1) {
      // Pas de remontée : c'est notre propre défilement, rattrapé par une hauteur qui a changé depuis (mesure d'une
      // ligne, zone des demandes). Seul un défilement vers le haut décolle le fil du bas.
      stickToBottom(el)
      return
    }
    lastTop.current = el.scrollTop
    setScrollTop(el.scrollTop)
    stuck.current = bottom
    setAtBottom(bottom)
    if (el.scrollTop < OLDER_THRESHOLD && state.hasMore && !state.olderLoading && !state.olderError && !anchor.current) loadOlder()
  }

  /** Défile tout en bas et le retient (position lue, fenêtre virtualisée). */
  function stickToBottom(el: HTMLElement) {
    el.scrollTop = el.scrollHeight
    lastTop.current = el.scrollTop
    setScrollTop(el.scrollTop)
  }

  function toBottom() {
    const el = scroller.current
    stuck.current = true
    setAtBottom(true)
    if (el) stickToBottom(el)
  }

  const top = offsets[range.start] ?? 0
  const total = offsets[offsets.length - 1] ?? 0
  const visible = entries.slice(range.start, range.end)

  return (
    <div className="cv">
      <div className="cv-feed">
        <div className="cv-scroll" ref={scroller} onScroll={onScroll} tabIndex={0} aria-label={t('conversation.feed.label')}>
          {state.phase === 'loading' && <p className="empty">{t('conversation.feed.loading')}</p>}
          {state.phase === 'unsupported' && <p className="empty">{state.error}</p>}
          {state.phase === 'error' && (
            <div className="empty">
              <p className="inline-err" role="alert">
                {t('conversation.feed.unavailable', { error: state.error })}
              </p>
              <button type="button" className="btn sm" onClick={reload}>
                {t('conversation.retry')}
              </button>
            </div>
          )}
          {state.phase === 'ready' && (
            <>
              {(state.hasMore || state.olderLoading || state.olderError) && (
                <div className="cv-older">
                  {state.olderError ? (
                    <span className="inline-err" role="alert">
                      {t('conversation.feed.olderUnavailable', { error: state.olderError })}
                    </span>
                  ) : null}
                  <button type="button" className="btn sm ghost" disabled={state.olderLoading} onClick={loadOlder}>
                    {state.olderLoading ? t('conversation.loading') : t('conversation.feed.loadOlder')}
                  </button>
                </div>
              )}
              {entries.length === 0 && state.pending.length === 0 && (
                <p className="empty">{t('conversation.feed.empty')}</p>
              )}
              <div className="cv-list" ref={listRef} style={{ height: total }}>
                <div className="cv-window" style={{ transform: `translateY(${top}px)` }}>
                  {visible.map((e, k) => {
                    const i = range.start + k
                    return <Item key={e.uid} entry={e} prev={entries[i - 1]} index={i} ctx={ctx} observer={observer} />
                  })}
                </div>
              </div>
              {state.invalidLines > 0 && (
                <p className="hint cv-invalid">
                  {t('conversation.feed.invalidLines', { count: state.invalidLines })}
                </p>
              )}
            </>
          )}
          {state.pending.map((p) => (
            <div key={p.id} className="cv-prompt cv-pending">
              <div className="cv-who">
                <span className="lbl">{t('conversation.you')}</span>
                <span className="chip pend">
                  <span className="spin" aria-hidden="true" /> {p.sent ? t('conversation.feed.pendingSent') : t('conversation.feed.pendingSending')}
                </span>
                <button type="button" className="btn sm ghost" onClick={() => dispatch({ type: 'dismiss', id: p.id })}>
                  {t('conversation.feed.dismiss')}
                </button>
              </div>
              <div className="cv-ptext">{clipText(p.text, CLIP_PROMPT.chars, CLIP_PROMPT.lines).shown}</div>
            </div>
          ))}
        </div>
        {!atBottom && state.phase === 'ready' && (
          <button type="button" className="btn sm cv-bottom" onClick={toBottom}>
            {t('conversation.feed.toBottom')}
          </button>
        )}
      </div>
      <ActivityBar session={session} />
      <Composer session={session} onSend={send} slashCommands={slashCommands} />
    </div>
  )
}
