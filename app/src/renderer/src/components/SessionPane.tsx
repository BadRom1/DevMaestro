import { useCallback, useEffect, useId, useMemo, useReducer, useRef, useState } from 'react'

import {
  SETTABLE_MODES,
  type ProjectInfo,
  type Profile,
  type Session,
  type SessionColor,
  type SettableMode,
  type Subagent,
} from '../../../shared/protocol'
import { CallError, call, errorCode, errorText } from '../api'
import {
  basename,
  folderMissing,
  formatCompact,
  formatNumber,
  formatPct,
  formatUsd,
  modeLabel,
  relativeTime,
  resumeBlock,
  sessionColor,
  sessionDisplayName,
  supportsNaming,
} from '../state/format'
import { displayedMode, idleMode, modeReducer, normalizeMode } from '../state/modeSwitch'
import { glyphFor } from '../state/status'
import { sessionIssue } from '../state/forge'
import { IssueChip } from './IssueChip'
import type { ITheme } from '@xterm/xterm'

import { TerminalView } from '../terminal/TerminalView'
import { Meter, ProfileChip, StatusGlyph } from './common'
import { useSettings } from '../settings'
import { RequestDock, useRequestDock } from './RequestDock'
import { requestKey } from '../state/askDock'
import { ViewBoundary } from './ViewBoundary'
import { activeComments, commitComments, fileComments, type ReviewAction, type ReviewDraft } from '../state/review'
import { DiffView, useSessionDiff } from './DiffView'
import { FilesView } from './FilesView'
import { CommitsView } from './CommitsView'
import { AgentsView } from './Subagents'
import { ConversationView } from './ConversationView'
import { runningCount, runningLabel } from '../state/subagents'
import { ForgetConfirm } from './ForgetConfirm'
import { ColorBar, ColorPicker, RenameField } from './SessionIdentity'
import { sortFiles } from '../state/diff'
import { guardLeave } from '../state/unsaved'
import type { DiffFile } from '../../../shared/protocol'

type Tab = 'conversation' | 'terminal' | 'diff' | 'commits' | 'files' | 'agents'

const NO_FILES: readonly DiffFile[] = []

/** Changement de mode : appel, réessai unique et délai de confirmation (voir `modeSwitch`). */
function useModeSwitch(session: Session) {
  const [sw, dispatch] = useReducer(modeReducer, idleMode)
  const latest = useRef(session)
  latest.current = session

  useEffect(() => {
    dispatch({ type: 'session', mode: session.mode, alive: session.alive })
  }, [session.mode, session.alive])

  const send = useCallback(async (target: SettableMode) => {
    try {
      const r = await call('sessions.setMode', { id: latest.current.id, mode: target })
      dispatch({ type: 'sent', sent: r.sent, mode: latest.current.mode })
    } catch (e) {
      const message = e instanceof CallError ? e.failure.message : errorText(e)
      dispatch({ type: 'failed', code: errorCode(e), message, mode: latest.current.mode, now: Date.now() })
    }
  }, [])

  useEffect(() => {
    if (sw.phase !== 'pending') return
    const now = Date.now()
    if (sw.retryAt !== null) {
      const target = sw.target
      const t = setTimeout(() => {
        dispatch({ type: 'retrying', now: Date.now() })
        void send(target)
      }, Math.max(0, sw.retryAt - now))
      return () => clearTimeout(t)
    }
    const t = setTimeout(() => dispatch({ type: 'timeout', mode: latest.current.mode }), Math.max(0, sw.deadline - now))
    return () => clearTimeout(t)
  }, [sw, send])

  const request = useCallback(
    (target: SettableMode) => {
      if (normalizeMode(latest.current.mode) === target) return
      dispatch({ type: 'request', target, mode: latest.current.mode, now: Date.now() })
      void send(target)
    },
    [send],
  )

  return { sw, request }
}

const OLD_DAEMON = 'Le démon ne gère pas encore le nommage des sessions : mets orchd à jour.'

function Header({
  session,
  agents,
  project,
  profiles,
  termSize,
  onSessionUpdated,
  onForget,
  onOpenIssue,
}: {
  session: Session
  onOpenIssue?: (s: Session) => void
  agents: readonly Subagent[] | undefined
  project: ProjectInfo | undefined
  profiles: Profile[]
  termSize: { cols: number; rows: number } | null
  onSessionUpdated: (s: Session) => void
  onForget: (id: string) => Promise<void>
}) {
  const [busy, setBusy] = useState<'stop' | 'resume' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [forgetting, setForgetting] = useState(false)
  const { settings } = useSettings()
  // `false` seulement si le démon l'affirme (absent : démon plus ancien, la reprise reste proposée).
  const block = resumeBlock(session, project)
  const missing = folderMissing(session, project)
  const { sw, request } = useModeSwitch(session)
  const glyph = glyphFor(session.status)
  const m = session.metrics
  const projectName = project?.name ?? basename(project?.root ?? session.project_root ?? session.cwd)
  const branch = session.branch ?? project?.branch ?? 'sans branche'
  const model = m?.model?.display_name ?? m?.model?.id ?? session.model ?? 'modèle inconnu'
  const mode = displayedMode(sw, session.mode)
  const known = (SETTABLE_MODES as readonly string[]).includes(mode)
  const pendingMode = sw.phase === 'pending'
  const name = sessionDisplayName(session)
  const naming = supportsNaming(session)
  const color = sessionColor(session)
  const agentsRunning = runningLabel(runningCount(session, agents))
  const iss = sessionIssue(session)

  async function run(kind: 'stop' | 'resume', f: () => Promise<unknown>, what: string) {
    setBusy(kind)
    setError(null)
    try {
      await f()
    } catch (e) {
      setError(`${what} : ${errorText(e)}`)
    } finally {
      setBusy(null)
    }
  }

  async function update(params: { title?: string | null; color?: SessionColor | null }) {
    const r = await call('sessions.update', { id: session.id, ...params })
    onSessionUpdated(r.session)
  }

  async function saveTitle(title: string | null) {
    try {
      await update({ title })
      setRenaming(false)
    } catch (e) {
      throw new Error(`Renommage impossible : ${errorText(e)}`)
    }
  }

  function pickColor(c: SessionColor | null) {
    setError(null)
    update({ color: c }).catch((e: unknown) => setError(`Couleur non enregistrée : ${errorText(e)}`))
  }

  return (
    <div className="sh">
      <div className="sh-1">
        {/* Identité, étiquettes, actions : chacun d'un bloc ; étroit (zoom), identité et actions en ligne 1, étiquettes en ligne 2. */}
        <div className="sh-id">
          <StatusGlyph glyph={glyph} decorative={false} />
          <ColorBar color={color} size="lg" />
          {renaming ? (
            <RenameField
              initial={session.title ?? ''}
              placeholder={name}
              onSave={saveTitle}
              onCancel={() => setRenaming(false)}
            />
          ) : (
            <h2
              className="sname"
              title={naming ? `${name} (double-clic pour renommer)` : name}
              onDoubleClick={() => naming && setRenaming(true)}
            >
              {name}
            </h2>
          )}
          <span className="where" title={`${project?.root ?? session.project_root ?? session.cwd} · ${branch}`}>
            {projectName} <span>/</span> {branch}
          </span>
          {iss && <IssueChip issue={iss} onOpen={onOpenIssue ? () => onOpenIssue(session) : undefined} />}
        </div>
        <div className="sh-tags">
          <ProfileChip profile={session.profile} profiles={profiles} />
          <span className="chip" title="Modèle">
            {model}
          </span>
          <label className="chip" style={{ paddingRight: 2 }}>
            mode
            <select
              className="mode"
              aria-label="Mode de la session"
              aria-busy={pendingMode}
              value={mode}
              disabled={pendingMode || !session.alive || session.status.state === 'waiting'}
              title={
                session.status.state === 'waiting'
                  ? 'Réponds d’abord à la demande en attente (Shift+Tab agirait sur le dialogue)'
                  : undefined
              }
              onChange={(e) => request(e.target.value as SettableMode)}
            >
              {!known && (
                <option value={mode} disabled>
                  {modeLabel(session.mode)}
                </option>
              )}
              {SETTABLE_MODES.map((v) => (
                <option key={v} value={v}>
                  {modeLabel(v)}
                </option>
              ))}
            </select>
          </label>
          {pendingMode && (
            <span className="hint pending" role="status">
              <span className="spin" aria-hidden="true" /> en cours…
            </span>
          )}
        </div>
        <div className="acts">
          <button
            className="btn sm ghost"
            disabled={!naming || renaming}
            title={naming ? 'Renommer la session' : OLD_DAEMON}
            onClick={() => setRenaming(true)}
          >
            Renommer
          </button>
          <ColorPicker value={color} disabled={!naming} disabledReason={OLD_DAEMON} onPick={pickColor} />
          {session.alive ? (
            <button
              className="btn sm ghost"
              disabled={busy !== null}
              onClick={() => void run('stop', () => call('sessions.stop', { id: session.id }), 'Arrêt impossible')}
            >
              {busy === 'stop' ? 'Arrêt…' : 'Arrêter'}
            </button>
          ) : (
            <>
              <button
                className="btn sm"
                disabled={busy !== null || block !== null}
                title={block ? block.long : 'Relancer Claude Code sur cette conversation'}
                onClick={() =>
                  void run(
                    'resume',
                    () => call('sessions.resume', { id: session.id, ...(termSize ?? {}) }),
                    'Reprise impossible',
                  )
                }
              >
                {busy === 'resume' ? 'Reprise…' : 'Reprendre'}
              </button>
              <button
                className="btn sm ghost"
                disabled={busy !== null || forgetting}
                title="Retirer cette session arrêtée de la liste de DevMaestro"
                onClick={() => {
                  if (settings.confirmRemoval) setForgetting(true)
                  else
                    onForget(session.id).catch((e: unknown) => setError(`Retrait impossible : ${errorText(e)}`))
                }}
              >
                Retirer de la liste
              </button>
            </>
          )}
        </div>
      </div>
      {forgetting && !session.alive && (
        <ForgetConfirm
          name={name}
          onConfirm={() => onForget(session.id)}
          onCancel={() => setForgetting(false)}
        />
      )}
      <div className="sh-2">
        <span>{glyph.label}</span>
        {agentsRunning && (
          <span className="chip ag-chip">
            <span className="st running" aria-hidden="true" /> {agentsRunning}
          </span>
        )}
        <span
          title={
            m?.context_window_size ? `Fenêtre de contexte : ${formatNumber(m.context_window_size)} tokens` : 'Fenêtre de contexte'
          }
        >
          contexte <Meter pct={m?.context_used_pct} label="Contexte utilisé" /> <b>{formatPct(m?.context_used_pct)}</b>
          {m?.context_window_size ? ` · ${formatCompact(m.context_window_size)}` : ''}
        </span>
        <span>
          coût <b>{formatUsd(m?.cost_usd)}</b> · <span title={typeof m?.total_tokens === 'number' ? `${formatNumber(m.total_tokens)} tokens` : undefined}>
            {formatCompact(m?.total_tokens)}
          </span>{' '}
          tokens
        </span>
        <span>
          {session.status.state === 'running' ? 'actif ' : 'dernière activité '}
          <b>{relativeTime(session.last_activity)}</b>
        </span>
        {session.possibly_stale && <span className="chip pend">peut-être obsolète</span>}
        {block && (
          <span className="chip" title={block.long}>
            {block.short} : reprise impossible
          </span>
        )}
        {missing && !block && (
          <span className="chip bad" title={`Le dossier ${session.cwd} n’existe plus`}>
            dossier supprimé
          </span>
        )}
        {sw.phase === 'idle' && sw.error && (
          <span className="inline-err" role="alert">
            {sw.error}
          </span>
        )}
        {error && (
          <span className="inline-err" role="alert">
            {error}
          </span>
        )}
      </div>
    </div>
  )
}

/** L'utilisateur est-il en train de saisir ailleurs (terminal, champ de texte) ? */
function typingElsewhere(terminalHost: HTMLElement | null): boolean {
  const a = document.activeElement
  if (!a || a === document.body) return false
  if (terminalHost?.contains(a)) return true
  return a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement || a instanceof HTMLSelectElement
}

export function SessionPane({
  session,
  project,
  profiles,
  stale,
  termTheme,
  termSize,
  onTermSize,
  onLink,
  onSessionUpdated,
  onForget,
  onOpenIssue,
  diffSeq,
  draft,
  review,
  seen: seenFiles,
  onSeen,
  agents,
  agentsLoad,
  onRetryAgents,
  agentId,
  onSelectAgent,
  openAgents,
}: {
  session: Session | null
  /** Sous-agents de la session affichée ; `undefined` tant que la liste est inconnue. */
  agents: readonly Subagent[] | undefined
  /** Amorçage de la liste (« Chargement », « indisponible »…), ou `null`. */
  agentsLoad: 'loading' | 'failed' | 'unsupported' | null
  onRetryAgents: (sessionId: string) => void
  /** Agent choisi dans l'onglet « Agents » (gardé par session). */
  agentId: string | null
  onSelectAgent: (agentId: string) => void
  /** Augmente à chaque demande d'ouverture de l'onglet « Agents » (clic dans la barre latérale). */
  openAgents: number
  /** Nombre de `session.diff_changed` reçus pour la session affichée. */
  diffSeq: number
  /** Revue en cours de la session affichée. */
  draft: ReviewDraft
  review: (a: ReviewAction) => void
  /** Fichiers marqués « vu » dans la session affichée. */
  seen: Record<string, boolean>
  onSeen: (path: string, value: boolean) => void
  project: ProjectInfo | undefined
  profiles: Profile[]
  stale: number[]
  /** Couleurs du terminal (mode affiché, palette, couleurs choisies). */
  termTheme: ITheme
  termSize: { cols: number; rows: number } | null
  onTermSize: (cols: number, rows: number) => void
  onLink: (url: string) => void
  onSessionUpdated: (s: Session) => void
  onForget: (id: string) => Promise<void>
  /** Ouvre le détail de l’issue liée (absent : forge masquée ou désactivée). */
  onOpenIssue?: (s: Session) => void
}) {
  const pending = session?.pending ?? []
  const termHost = useRef<HTMLDivElement>(null)
  const keys = session ? pending.map((r) => requestKey(session.id, r.request_id)) : []
  /**
   * Zone des demandes réduite (« Réduire ») ; une nouvelle demande la rouvre et
   * prend le focus, sauf si l'utilisateur tape (terminal ou champ).
   */
  const dock = useRequestDock(session?.id ?? null, keys, () => typingElsewhere(termHost.current))
  const { settings } = useSettings()
  /** Onglet ouvert au départ : réglage « Onglet par défaut d'une session » (Terminal tant qu'il n'est pas choisi). */
  const [tab, setTabNow] = useState<Tab>(() => settings.ui.sessionTab)
  const tabRef = useRef(tab)
  tabRef.current = tab
  /** Changement d'onglet : confirmation d'abord si un fichier modifié n'est pas enregistré (onglet Fichiers). */
  const setTab = (next: Tab) => {
    if (next === tabRef.current) return
    guardLeave(session?.id ?? null, 'changer d’onglet', () => setTabNow(next))
  }
  /**
   * Conversations déjà ouvertes : la vue reste montée (masquée) quand on change
   * d'onglet, pour garder le fil, sa position et les volets dépliés.
   */
  const [convOpened, setConvOpened] = useState<string | null>(null)
  useEffect(() => {
    if (tab === 'conversation' && session && convOpened !== session.id) setConvOpened(session.id)
  }, [tab, session?.id])
  /** Fichier à montrer dans le diff (« Voir le diff » depuis l'onglet Fichiers). */
  const [diffFocus, setDiffFocus] = useState<{ sessionId: string; path: string; n: number } | null>(null)
  /** Extrait à montrer dans l'onglet Fichiers (clic dans la liste de la revue). */
  const [filesFocus, setFilesFocus] = useState<{ sessionId: string; path: string; line: number; n: number } | null>(null)
  /** Commit à montrer dans l'onglet Commits (clic dans la liste de la revue). */
  const [commitFocus, setCommitFocus] = useState<{ sessionId: string; sha: string; path: string; n: number } | null>(null)
  const openCommit = (sha: string, path: string) => {
    if (!session) return
    setCommitFocus((f) => ({ sessionId: session.id, sha, path, n: (f?.n ?? 0) + 1 }))
    setTab('commits')
  }
  // Le diff n'est calculé qu'une fois l'onglet ouvert pour la session (puis tenu à jour pour le badge).
  const [diffOpened, setDiffOpened] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => {
    if ((tab === 'diff' || tab === 'files') && session && !diffOpened.has(session.id)) setDiffOpened((s) => new Set(s).add(session.id))
  }, [tab, session?.id])
  const diff = useSessionDiff(
    session?.id ?? null,
    diffSeq,
    (tab !== 'terminal' && tab !== 'conversation') || (!!session && diffOpened.has(session.id)),
  )
  const fileCount = diff.summary?.files.length ?? null
  /** Liste du diff dans l'ordre de l'onglet Diff : la revue part dans le même ordre d'où qu'on l'envoie. */
  const reviewFiles = useMemo(() => (diff.summary ? sortFiles(diff.summary.files) : NO_FILES), [diff.summary])
  const pendingComments = activeComments(draft).length
  const fileExtracts = fileComments(draft).length
  const commitNotes = commitComments(draft).length
  const tabsId = useId()
  const backToTerminal = () => {
    setTab('terminal')
    document.getElementById(`${tabsId}-terminal`)?.focus()
  }
  const tabs = [
    ['conversation', 'Conversation'],
    ['terminal', 'Terminal'],
    ['diff', 'Diff'],
    ['commits', 'Commits'],
    ['files', 'Fichiers'],
    ['agents', 'Agents'],
  ] as const
  const agentsRunning = session ? runningCount(session, agents) : 0

  // Clic sur un sous-agent dans la barre latérale : onglet « Agents » (pas au montage du volet),
  // puis focus sur l'agent choisi.
  const openedAgents = useRef(openAgents)
  const focusAgent = useRef(false)
  useEffect(() => {
    if (openAgents === openedAgents.current) return
    openedAgents.current = openAgents
    focusAgent.current = true
    setTab('agents')
  }, [openAgents])
  useEffect(() => {
    if (!focusAgent.current || tab !== 'agents') return
    focusAgent.current = false
    const panel = document.getElementById(`${tabsId}-agents-panel`)
    panel?.querySelector<HTMLElement>('.ag-item[aria-current="true"]')?.focus()
  }, [tab, openAgents, agentId, tabsId])

  return (
    <section className="panel sess" aria-label={session ? `Session ${sessionDisplayName(session)}` : 'Aucune session'}>
      {session ? (
        <Header
          key={session.id}
          session={session}
          agents={agents}
          project={project}
          profiles={profiles}
          termSize={termSize}
          onSessionUpdated={onSessionUpdated}
          onForget={onForget}
          onOpenIssue={onOpenIssue}
        />
      ) : (
        <div className="sh">
          <div className="sh-1">
            <h2>Aucune session sélectionnée</h2>
          </div>
        </div>
      )}
      <div className="tabs" role="tablist" aria-label="Vues de la session">
        {tabs.map(([k, l]) => (
          <button
            key={k}
            role="tab"
            id={`${tabsId}-${k}`}
            aria-selected={tab === k}
            aria-controls={`${tabsId}-${k}-panel`}
            tabIndex={tab === k ? 0 : -1}
            onClick={() => setTab(k)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                e.preventDefault()
                const order = tabs.map(([t]) => t)
                const i = order.indexOf(tab)
                const next = order[(i + (e.key === 'ArrowRight' ? 1 : order.length - 1)) % order.length]!
                setTab(next)
                document.getElementById(`${tabsId}-${next}`)?.focus()
              }
            }}
          >
            {l}
            {(k === 'terminal' || k === 'conversation') && pending.length > 0 && (
              <span className="badge wait" aria-label={`${pending.length} à répondre`}>
                {pending.length}
              </span>
            )}
            {k === 'diff' && fileCount !== null && fileCount > 0 && (
              <span className="badge" aria-label={`${fileCount} fichier${fileCount > 1 ? 's' : ''} changé${fileCount > 1 ? 's' : ''}`}>
                {fileCount}
              </span>
            )}
            {k === 'agents' && agentsRunning > 0 && (
              <span className="badge" aria-label={runningLabel(agentsRunning) ?? undefined}>
                {agentsRunning}
              </span>
            )}
            {k === 'diff' && pendingComments > 0 && (
              <span className="badge pend" aria-label={`${pendingComments} commentaire${pendingComments > 1 ? 's' : ''} en attente`}>
                💬{pendingComments}
              </span>
            )}
            {k === 'commits' && commitNotes > 0 && (
              <span className="badge pend" aria-label={`${commitNotes} commentaire${commitNotes > 1 ? 's' : ''} de commit dans la revue`}>
                💬{commitNotes}
              </span>
            )}
            {k === 'files' && fileExtracts > 0 && (
              <span className="badge pend" aria-label={`${fileExtracts} extrait${fileExtracts > 1 ? 's' : ''} de fichier dans la revue`}>
                💬{fileExtracts}
              </span>
            )}
          </button>
        ))}
      </div>
      <div className="term-panel">
        {/* Le terminal reste monté sous les autres onglets ; seule la zone des demandes change sa taille. */}
        <div
          className="term-wrap"
          role="tabpanel"
          id={`${tabsId}-terminal-panel`}
          aria-labelledby={`${tabsId}-terminal`}
          inert={tab !== 'terminal'}
        >
        <TerminalView
          sessionId={session?.id ?? null}
          alive={session?.alive ?? false}
          theme={termTheme}
          onSize={onTermSize}
          onLink={onLink}
          hostRef={termHost}
          emptyText="Choisis une session à gauche, ou lance-en une nouvelle."
        />
        </div>
        {session && (tab === 'conversation' || convOpened === session.id) && (
          <div
            className="diff-layer conv-layer"
            role="tabpanel"
            id={`${tabsId}-conversation-panel`}
            aria-labelledby={`${tabsId}-conversation`}
            hidden={tab !== 'conversation'}
          >
            <ViewBoundary key={session.id} label="Conversation">
              <ConversationView key={session.id} session={session} onLink={onLink} hidden={tab !== 'conversation'} />
            </ViewBoundary>
          </div>
        )}
        {!session && tab === 'conversation' && (
          <div className="diff-layer" role="tabpanel" id={`${tabsId}-conversation-panel`} aria-labelledby={`${tabsId}-conversation`}>
            <p className="empty">Choisis une session pour lire sa conversation.</p>
          </div>
        )}
        {tab === 'diff' && (
          <div className="diff-layer" role="tabpanel" id={`${tabsId}-diff-panel`} aria-labelledby={`${tabsId}-diff`}>
            {session ? (
              <ViewBoundary key={session.id} label="Diff">
                <DiffView
                  key={session.id}
                  focusPath={diffFocus}
                  session={session}
                  diff={diff}
                  reviewFiles={reviewFiles}
                  draft={draft}
                  review={review}
                  seen={seenFiles}
                  onSeen={onSeen}
                  onSent={backToTerminal}
                  onOpenFile={(path, line) => {
                    setFilesFocus((f) => ({ sessionId: session.id, path, line, n: (f?.n ?? 0) + 1 }))
                    setTab('files')
                  }}
                  onOpenCommit={openCommit}
                />
              </ViewBoundary>
            ) : (
              <p className="empty">Choisis une session pour voir ce qu’elle a changé.</p>
            )}
          </div>
        )}
        {tab === 'commits' && (
          <div className="diff-layer" role="tabpanel" id={`${tabsId}-commits-panel`} aria-labelledby={`${tabsId}-commits`}>
            {session ? (
              <ViewBoundary key={session.id} label="Commits">
                <CommitsView
                  key={session.id}
                  session={session}
                  seq={diffSeq}
                  draft={draft}
                  review={review}
                  reviewFiles={reviewFiles}
                  onSent={backToTerminal}
                  focusCommit={commitFocus}
                  onOpenFile={(path, line) => {
                    setFilesFocus((f) => ({ sessionId: session.id, path, line, n: (f?.n ?? 0) + 1 }))
                    setTab('files')
                  }}
                />
              </ViewBoundary>
            ) : (
              <p className="empty">Choisis une session pour parcourir ses commits.</p>
            )}
          </div>
        )}
        {tab === 'files' && (
          <div className="diff-layer" role="tabpanel" id={`${tabsId}-files-panel`} aria-labelledby={`${tabsId}-files`}>
            {session ? (
              <ViewBoundary key={session.id} label="Fichiers">
                <FilesView
                  key={session.id}
                  session={session}
                  diff={diff.summary}
                  reviewFiles={reviewFiles}
                  diffVersion={diff.version}
                  draft={draft}
                  review={review}
                  onSent={backToTerminal}
                  focusFile={filesFocus}
                  onLink={onLink}
                  onShowDiff={(path) => {
                    setDiffFocus((f) => ({ sessionId: session.id, path, n: (f?.n ?? 0) + 1 }))
                    setTab('diff')
                  }}
                  onOpenCommit={openCommit}
                  onMentioned={() => {
                    setTab('terminal')
                    // Le terminal reprend le focus pour continuer le message.
                    requestAnimationFrame(() => termHost.current?.querySelector<HTMLElement>('.xterm-helper-textarea')?.focus())
                  }}
                />
              </ViewBoundary>
            ) : (
              <p className="empty">Choisis une session pour parcourir ses fichiers.</p>
            )}
          </div>
        )}
        {tab === 'agents' && (
          <div className="diff-layer" role="tabpanel" id={`${tabsId}-agents-panel`} aria-labelledby={`${tabsId}-agents`}>
            {session ? (
              <ViewBoundary key={session.id} label="Agents">
                <AgentsView
                  key={session.id}
                  session={session}
                  agents={agents}
                  load={agentsLoad}
                  onRetry={() => onRetryAgents(session.id)}
                  selectedId={agentId}
                  onSelect={onSelectAgent}
                  onLink={onLink}
                />
              </ViewBoundary>
            ) : (
              <p className="empty">Choisis une session pour suivre ses sous-agents.</p>
            )}
          </div>
        )}
        {/* Zone réservée au bas du volet, sous l'onglet affiché : le contenu au-dessus rétrécit (terminal réajusté). */}
        <RequestDock
          session={session}
          pending={pending}
          stale={stale}
          reduced={dock.reduced}
          dockRef={dock.dockRef}
          onToggle={dock.toggle}
        />
      </div>
    </section>
  )
}
