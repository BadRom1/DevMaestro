import { useCallback, useEffect, useReducer, useRef, useState } from 'react'

import {
  SETTABLE_MODES,
  type ProjectInfo,
  type Profile,
  type Session,
  type SessionColor,
  type SettableMode,
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
import { TerminalView } from '../terminal/TerminalView'
import { Meter, StatusGlyph, profileClass } from './common'
import { PermissionCard, QuestionCard } from './RequestCards'
import { ForgetConfirm } from './ForgetConfirm'
import { ColorBar, ColorPicker, RenameField } from './SessionIdentity'

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
  project,
  profiles,
  termSize,
  onSessionUpdated,
  onForget,
}: {
  session: Session
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
        <span className={`chip ${profileClass(session.profile, profiles)}`} title="Profil Claude Code">
          {session.profile}
        </span>
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
                onClick={() => setForgetting(true)}
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
  scheme,
  termSize,
  onTermSize,
  onLink,
  onSessionUpdated,
  onForget,
}: {
  session: Session | null
  project: ProjectInfo | undefined
  profiles: Profile[]
  stale: number[]
  scheme: 'light' | 'dark'
  termSize: { cols: number; rows: number } | null
  onTermSize: (cols: number, rows: number) => void
  onLink: (url: string) => void
  onSessionUpdated: (s: Session) => void
  onForget: (id: string) => Promise<void>
}) {
  const pending = session?.pending ?? []
  const termHost = useRef<HTMLDivElement>(null)
  const asks = useRef<HTMLDivElement>(null)
  const seen = useRef(new Set<string>())
  const keys = pending.map((r) => `${session?.id}:${r.request_id}`)
  const keysSig = keys.join(',')

  // Nouvelle demande : le focus va à la carte, sauf si l'utilisateur tape (terminal ou champ).
  useEffect(() => {
    const fresh = keys.filter((k) => !seen.current.has(k))
    seen.current = new Set(keys)
    if (fresh.length === 0 || typingElsewhere(termHost.current)) return
    const card = asks.current?.querySelector<HTMLElement>(`[data-request-key="${fresh[0]}"]`)
    card?.focus()
    // La signature des clés suffit comme dépendance.
  }, [keysSig])

  return (
    <section className="panel sess" aria-label={session ? `Session ${sessionDisplayName(session)}` : 'Aucune session'}>
      {session ? (
        <Header
          key={session.id}
          session={session}
          project={project}
          profiles={profiles}
          termSize={termSize}
          onSessionUpdated={onSessionUpdated}
          onForget={onForget}
        />
      ) : (
        <div className="sh">
          <div className="sh-1">
            <h2>Aucune session sélectionnée</h2>
          </div>
        </div>
      )}
      <div className="tabs" role="tablist" aria-label="Vues de la session">
        <button role="tab" aria-selected="true" id="tab-terminal" aria-controls="panel-terminal">
          Terminal
          {pending.length > 0 && <span className="badge wait">{pending.length}</span>}
        </button>
      </div>
      <div className="term-panel" role="tabpanel" id="panel-terminal" aria-labelledby="tab-terminal">
        <TerminalView
          sessionId={session?.id ?? null}
          alive={session?.alive ?? false}
          scheme={scheme}
          onSize={onTermSize}
          onLink={onLink}
          hostRef={termHost}
          emptyText="Choisis une session à gauche, ou lance-en une nouvelle."
        />
        {/* Les cartes recouvrent le bas du terminal sans changer sa taille. */}
        <div className="asks" ref={asks} aria-live="polite" aria-label="Demandes en attente">
          {session &&
            pending.map((r) => {
              const isStale = session.possibly_stale || stale.includes(r.request_id)
              const k = `${session.id}:${r.request_id}`
              return r.pending.kind === 'question' ? (
                <QuestionCard key={k} cardKey={k} session={session} req={r} stale={isStale} />
              ) : (
                <PermissionCard key={k} cardKey={k} session={session} req={r} stale={isStale} />
              )
            })}
        </div>
      </div>
    </section>
  )
}
