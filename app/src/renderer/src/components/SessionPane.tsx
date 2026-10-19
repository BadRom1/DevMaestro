import { useEffect, useRef, useState } from 'react'

import { SETTABLE_MODES, type ProjectInfo, type Profile, type Session, type SettableMode } from '../../../shared/protocol'
import { call, errorText } from '../api'
import { basename, formatNumber, formatPct, formatUsd, modeLabel, relativeTime } from '../state/format'
import { glyphFor } from '../state/status'
import { TerminalView } from '../terminal/TerminalView'
import { Meter, StatusGlyph, profileClass } from './common'
import { PermissionCard, QuestionCard } from './RequestCards'

function normalizeMode(mode: string | null): string {
  return mode === 'manual' ? 'default' : (mode ?? '')
}

function Header({
  session,
  project,
  profiles,
  termSize,
}: {
  session: Session
  project: ProjectInfo | undefined
  profiles: Profile[]
  termSize: { cols: number; rows: number } | null
}) {
  const [busy, setBusy] = useState<'mode' | 'stop' | 'resume' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const glyph = glyphFor(session.status)
  const m = session.metrics
  const name = project?.name ?? basename(project?.root ?? session.project_root ?? session.cwd)
  const branch = session.branch ?? project?.branch ?? 'sans branche'
  const model = m?.model?.display_name ?? m?.model?.id ?? session.model ?? 'modèle inconnu'
  const mode = normalizeMode(session.mode)
  const known = (SETTABLE_MODES as readonly string[]).includes(mode)

  async function run(kind: 'mode' | 'stop' | 'resume', f: () => Promise<unknown>, what: string) {
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

  return (
    <div className="sh">
      <div className="sh-1">
        <StatusGlyph glyph={glyph} decorative={false} />
        <h2>
          {name} <span>/</span> {branch}
        </h2>
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
            value={mode}
            disabled={busy === 'mode' || !session.alive || session.status.state === 'waiting'}
            title={
              session.status.state === 'waiting'
                ? 'Réponds d’abord à la demande en attente (Shift+Tab agirait sur le dialogue)'
                : undefined
            }
            onChange={(e) =>
              void run(
                'mode',
                () => call('sessions.setMode', { id: session.id, mode: e.target.value as SettableMode }),
                'Changement de mode impossible',
              )
            }
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
        {busy === 'mode' && <span className="hint">envoi…</span>}
        <div className="acts">
          {session.alive ? (
            <button
              className="btn sm ghost"
              disabled={busy !== null}
              onClick={() => void run('stop', () => call('sessions.stop', { id: session.id }), 'Arrêt impossible')}
            >
              {busy === 'stop' ? 'Arrêt…' : 'Arrêter'}
            </button>
          ) : (
            <button
              className="btn sm"
              disabled={busy !== null}
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
          )}
        </div>
      </div>
      <div className="sh-2">
        <span>{glyph.label}</span>
        <span title="Fenêtre de contexte">
          contexte <Meter pct={m?.context_used_pct} label="Contexte utilisé" /> <b>{formatPct(m?.context_used_pct)}</b>
          {m?.context_window_size ? ` · ${formatNumber(m.context_window_size)}` : ''}
        </span>
        <span>
          coût <b>{formatUsd(m?.cost_usd)}</b> · {formatNumber(m?.total_tokens)} tokens
        </span>
        <span>
          {session.status.state === 'running' ? 'actif ' : 'dernière activité '}
          <b>{relativeTime(session.last_activity)}</b>
        </span>
        {session.possibly_stale && <span className="chip pend">peut-être obsolète</span>}
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
}: {
  session: Session | null
  project: ProjectInfo | undefined
  profiles: Profile[]
  stale: number[]
  scheme: 'light' | 'dark'
  termSize: { cols: number; rows: number } | null
  onTermSize: (cols: number, rows: number) => void
  onLink: (url: string) => void
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
    <section className="panel sess" aria-label={session ? `Session ${session.branch ?? session.cwd}` : 'Aucune session'}>
      {session ? (
        <Header key={session.id} session={session} project={project} profiles={profiles} termSize={termSize} />
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
