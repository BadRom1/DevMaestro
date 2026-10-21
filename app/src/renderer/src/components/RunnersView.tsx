/**
 * Onglet « Lancer » d'une session (lot 14a) : commandes détectées dans le
 * worktree (groupées par type, commande visible), confirmation la première
 * fois pour un worktree, exécutions avec leur terminal (lecture et saisie),
 * état, code de sortie, Arrêter, Relancer ; adresses locales repérées →
 * aperçu dans une iframe isolée ou ouverture dans le navigateur (après la
 * confirmation des liens).
 *
 * Seul un runner détecté par le démon peut être lancé : la page n'envoie
 * qu'un identifiant (`runners.start {id, runner_id}`), jamais une commande.
 */
import type { ITheme } from '@xterm/xterm'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { previewLabel } from '../../../shared/preview'
import type { Runner, RunnerFile, RunnerFileState, Session } from '../../../shared/protocol'
import { numberFormat, t as tr, type PlainKey } from '../../../shared/i18n'
import { openableRunnerFile, riskyRunnerFile } from '../../../shared/runnerFiles'
import { ErrorCode } from '../../../shared/protocol'
import type { RunnerConfirmation } from '../../../shared/bridge'
import { CallError, api, call, errorText, runnerChannel } from '../api'
import { useI18n, useT } from '../i18n'
import { daemonText, describeError } from '../state/errors'
import { relativeTime } from '../state/format'
import {
  commandText,
  confirmText,
  filesText,
  groupRunners,
  normalizeList,
  normalizeProcess,
  normalizeProcs,
  previewable,
  readConfirmation,
  stateLabel,
  stateTone,
  type RunnerProc,
  type RunnersData,
} from '../state/runners'
import { TerminalView, type TerminalStream } from '../terminal/TerminalView'
import { Modal } from './Modal'

/** Origine de la page (refusée dans l'aperçu), `null` pour file://. */
function pageOrigin(): string | null {
  return window.location.protocol === 'file:' ? null : window.location.origin
}

/** Libellé de l'état d'un fichier de l'empreinte (texte, jamais la seule couleur). */
const FILE_STATE_KEYS: Record<RunnerFileState, PlainKey> = {
  ok: 'sessions.runners.fileState.ok',
  absent: 'sessions.runners.fileState.absent',
  outside: 'sessions.runners.fileState.outside',
  too_large: 'sessions.runners.fileState.tooLarge',
  unresolved: 'sessions.runners.fileState.unresolved',
}

/** Erreur produite par l'app (preload trop ancien) : marquée `origin: "app"`, pas un texte du démon. */
function oldPreload() {
  return { ok: false, error: { code: ErrorCode.Internal, message: tr('sessions.runners.oldPreload'), data: { origin: 'app' } } } as const
}

/** Attente de la fin d'une exécution avant de la relancer (SIGKILL au bout de 3 s côté démon). */
const RESTART_WAIT_MS = 5000

export function RunnersView({
  session,
  theme,
  onLink,
  onRunning,
  onUnsupported,
  onOpenFile,
}: {
  session: Session
  theme: ITheme
  onLink: (url: string) => void
  /** Exécutions connues de la session (indicateur de la barre latérale et du kanban). */
  onRunning: (sessionId: string, running: RunnerProc[]) => void
  /** Le démon ne connaît pas les runners (trop ancien) : l'onglet est masqué. */
  onUnsupported: () => void
  /** « Voir » un fichier de l'empreinte : onglet « Fichiers », en lecture. */
  onOpenFile?: (path: string) => void
}) {
  const { t, rich } = useI18n()
  const [data, setData] = useState<RunnersData | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  /** Commande à faire accepter (relue par le processus principal) ; `changed` : elle a changé depuis l'affichage. */
  const [confirm, setConfirm] = useState<{ c: RunnerConfirmation; changed: boolean } | null>(null)
  const [preview, setPreview] = useState<{ url: string; n: number } | null>(null)
  const sessionId = session.id
  const latest = useRef<RunnersData | null>(null)
  latest.current = data
  const onRunningRef = useRef(onRunning)
  onRunningRef.current = onRunning
  const onUnsupportedRef = useRef(onUnsupported)
  onUnsupportedRef.current = onUnsupported

  const applyRunning = useCallback(
    (running: RunnerProc[]) => {
      setData((d) => (d ? { ...d, running } : d))
      onRunningRef.current(sessionId, running)
    },
    [sessionId],
  )

  const load = useCallback(async () => {
    try {
      const r = normalizeList(await call('runners.list', { id: sessionId }))
      setData(r)
      setLoadError(null)
      onRunningRef.current(sessionId, r.running)
      return r
    } catch (e) {
      if (e instanceof CallError && e.failure.code === ErrorCode.MethodNotFound) onUnsupportedRef.current()
      else setLoadError(errorText(e))
      return null
    }
  }, [sessionId])

  useEffect(() => {
    void load()
  }, [load])

  // Changements annoncés par le démon : la liste à jour des exécutions de la session.
  useEffect(
    () =>
      api.onNotification((n) => {
        if (n.method === 'runners.changed' && n.params?.id === sessionId && Array.isArray(n.params.running)) {
          applyRunning(normalizeProcs(n.params.running))
        }
      }),
    [sessionId, applyRunning],
  )

  // Exécution affichée : la dernière lancée, sinon la première en cours.
  const running = data?.running ?? []
  const current = running.find((p) => p.processId === selected) ?? null
  useEffect(() => {
    if (selected && running.some((p) => p.processId === selected)) return
    const next = running.find((p) => p.state === 'running') ?? running[0] ?? null
    setSelected(next?.processId ?? null)
  }, [running, selected])

  // Aperçu d'une adresse qui n'est plus celle de l'exécution affichée : fermé.
  const origin = pageOrigin()
  const urls = useMemo(() => current?.urls ?? [], [current])
  const okUrls = useMemo(() => previewable(urls, origin), [urls, origin])
  useEffect(() => {
    if (preview && !okUrls.includes(preview.url)) setPreview(null)
  }, [okUrls, preview])

  // Démontage : plus aucune exécution transmise à la page.
  useEffect(
    () => () => {
      void api.viewRunner?.({ session_id: null, process_id: null })
    },
    [],
  )

  const termLabel = t('sessions.runners.terminalLabel')
  const stream = useMemo<TerminalStream>(
    () => ({
      channel: runnerChannel,
      view: (id, size) => {
        if (!api.viewRunner) {
          return Promise.resolve(oldPreload())
        }
        return id
          ? api.viewRunner({ session_id: sessionId, process_id: id, ...size })
          : api.viewRunner({ session_id: null, process_id: null })
      },
      resize: (id, cols, rows) => api.resizeRunner?.({ process_id: id, cols, rows }),
      label: termLabel,
    }),
    [sessionId, termLabel],
  )

  const runnerOf = (id: string): Runner | undefined => data?.runners.find((r) => r.id === id)

  /**
   * Lancer : le processus principal refuse tant que cette commande n'a pas été
   * acceptée dans ce worktree (et redemande si elle a changé) ; le refus
   * porte la commande à montrer.
   */
  async function start(runner: Pick<Runner, 'id' | 'label'>, retried = false): Promise<void> {
    setBusy(runner.id)
    setActionError(null)
    try {
      const p = normalizeProcess(await call('runners.start', { id: sessionId, runner_id: runner.id }))
      if (p) {
        const cur = latest.current?.running ?? []
        applyRunning([p, ...cur.filter((x) => x.processId !== p.processId)])
        setSelected(p.processId)
      } else {
        await load()
      }
    } catch (e) {
      const code = e instanceof CallError ? e.failure.code : null
      const c = e instanceof CallError && code === ErrorCode.RunnerConfirmationRequired ? readConfirmation(e.failure.data) : null
      if (c) setConfirm({ c, changed: false })
      else if (code === ErrorCode.RunnerUnknown && !retried) {
        // Commande changée depuis sa confirmation (ou disparue) : liste relue, puis nouvel essai,
        // qui redemande la confirmation si elle a changé.
        setBusy(null)
        await load()
        return start(runner, true)
      } else setActionError(t('sessions.runners.startFailed', { label: runner.label, error: errorText(e) }))
    } finally {
      setBusy(null)
    }
  }

  /** « Lancer » dans le dialogue : commande retenue par le processus principal, puis lancement. */
  async function accept(c: RunnerConfirmation) {
    setBusy(c.runner_id)
    const r = api.confirmRunner
      ? await api.confirmRunner({ session_id: sessionId, runner_id: c.runner_id, fingerprint: c.fingerprint })
      : oldPreload()
    setBusy(null)
    if (!r.ok) {
      const next = r.error.code === ErrorCode.RunnerConfirmationRequired ? readConfirmation(r.error.data) : null
      if (next) setConfirm({ c: next, changed: true })
      else {
        setConfirm(null)
        setActionError(t('sessions.runners.startFailed', { label: c.label, error: describeError(r.error.code, r.error.message, r.error.data) }))
      }
      return
    }
    setConfirm(null)
    await start({ id: c.runner_id, label: c.label })
  }

  async function stop(p: RunnerProc) {
    setBusy(p.processId)
    setActionError(null)
    try {
      await call('runners.stop', { id: sessionId, process_id: p.processId })
    } catch (e) {
      setActionError(t('sessions.runners.stopFailed', { error: errorText(e) }))
    } finally {
      setBusy(null)
    }
  }

  /** Relancer : arrêt (si elle tourne), attente de la fin, puis nouveau lancement du même runner. */
  async function restart(p: RunnerProc) {
    const runner = runnerOf(p.runnerId)
    if (!runner) {
      setActionError(t('sessions.runners.restartGone'))
      return
    }
    if (p.state === 'running') {
      setBusy(p.processId)
      setActionError(null)
      try {
        await call('runners.stop', { id: sessionId, process_id: p.processId })
        const until = Date.now() + RESTART_WAIT_MS
        for (;;) {
          const r = await load()
          const still = r?.running.find((x) => x.processId === p.processId)
          if (!still || still.state !== 'running') break
          if (Date.now() > until) throw new Error(t('sessions.runners.stopTimeout'))
          await new Promise((ok) => setTimeout(ok, 400))
        }
      } catch (e) {
        setActionError(t('sessions.runners.restartFailed', { error: errorText(e) }))
        setBusy(null)
        return
      }
      setBusy(null)
    }
    await start(runner)
  }

  if (loadError && !data) {
    return (
      <div className="empty" role="alert">
        <b>{t('sessions.runners.unavailable')}</b>
        <span className="hint">{loadError}</span>
        <button className="btn sm" onClick={() => void load()}>
          {t('sessions.runners.retry')}
        </button>
      </div>
    )
  }
  if (!data) {
    return (
      <p className="empty" role="status">
        {t('sessions.runners.searching')}
      </p>
    )
  }

  const groups = groupRunners(data.runners)
  return (
    <div className="runners-view">
      <div className="rn-list">
        <div className="cap">
          <b>{t('sessions.runners.detected')}</b>
          <button className="btn sm ghost" onClick={() => void load()} title={t('sessions.runners.refreshTitle')}>
            {t('sessions.runners.refresh')}
          </button>
        </div>
        {groups.length === 0 && (
          <p className="hint pad">
            {t('sessions.runners.none')}
          </p>
        )}
        {groups.map((g) => (
          <section key={g.kind} className="rn-group" aria-label={g.label}>
            <h3 className="rn-gt">{g.label}</h3>
            <ul role="list">
              {g.runners.map((r) => {
                const live = running.filter((p) => p.runnerId === r.id && p.state === 'running').length
                return (
                  <li key={r.id} className="rn-item">
                    <div className="rn-l1">
                      <span className="rn-name">{r.label}</span>
                      {live > 0 && (
                        <span className="chip ag-chip" title={t('sessions.runners.liveTitle', { count: live })}>
                          <span className="st running" aria-hidden="true" /> {live}
                        </span>
                      )}
                      <button
                        className="btn sm"
                        disabled={busy !== null}
                        onClick={() => void start(r)}
                        aria-label={t('sessions.runners.startLabel', { label: r.label, command: commandText(r) })}
                      >
                        {t('sessions.runners.start')}
                      </button>
                    </div>
                    <code className="mono rn-cmd" title={r.source ? t('sessions.runners.from', { source: r.source }) : undefined}>
                      {commandText(r)}
                    </code>
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
        {running.length > 0 && (
          <section className="rn-group" aria-label={t('sessions.runners.procs')}>
            <h3 className="rn-gt">{t('sessions.runners.procs')}</h3>
            <ul role="list">
              {running.map((p) => {
                const r = runnerOf(p.runnerId)
                return (
                  <li key={p.processId}>
                    <button
                      className="rn-proc"
                      aria-current={p.processId === selected}
                      onClick={() => setSelected(p.processId)}
                    >
                      <span className={`rn-dot ${stateTone(p)}`} aria-hidden="true" />
                      <span className="rn-name">{r?.label ?? p.label ?? p.runnerId}</span>
                      <span className={`rn-state ${stateTone(p)}`}>{stateLabel(p)}</span>
                      {p.startedAt && <span className="hint">{relativeTime(p.startedAt)}</span>}
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        )}
      </div>
      <div className="rn-detail">
        {actionError && (
          <div className="rn-err err" role="alert">
            {actionError}
            <button className="btn sm ghost" onClick={() => setActionError(null)} aria-label={t('sessions.runners.closeMessage')}>
              ×
            </button>
          </div>
        )}
        {current ? (
          <div className="rn-head">
            <span className={`rn-dot ${stateTone(current)}`} aria-hidden="true" />
            <b>{runnerOf(current.runnerId)?.label ?? current.label ?? current.runnerId}</b>
            <span className={`rn-state ${stateTone(current)}`} role="status">
              {stateLabel(current)}
            </span>
            {/* i18n-exempt: nom de variable d'environnement */}
            {current.port !== null && <span className="hint">PORT={current.port}</span>}
            <span className="rn-acts">
              {current.state === 'running' && (
                <button className="btn sm danger" disabled={busy !== null} onClick={() => void stop(current)}>
                  {t('sessions.runners.stop')}
                </button>
              )}
              <button
                className="btn sm"
                disabled={busy !== null || !runnerOf(current.runnerId)}
                onClick={() => void restart(current)}
                title={runnerOf(current.runnerId) ? undefined : t('sessions.runners.goneTitle')}
              >
                {t('sessions.runners.restart')}
              </button>
            </span>
          </div>
        ) : (
          <p className="hint rn-none">{t('sessions.runners.noProc')}</p>
        )}
        {current && urls.length > 0 && (
          <ul className="rn-urls" role="list" aria-label={t('sessions.runners.urls')}>
            {urls.map((u) => {
              // Adresse normalisée si l'aperçu l'accepte (sinon : navigateur seulement).
              const target = previewable([u], origin)[0] ?? null
              const ok = target !== null
              return (
                <li key={u}>
                  <code className="mono">{target ? previewLabel(target) : u}</code>
                  <button
                    className="btn sm"
                    disabled={!ok}
                    aria-pressed={!!target && preview?.url === target}
                    title={ok ? t('sessions.runners.previewTitle') : t('sessions.runners.previewLimited')}
                    onClick={() => target && setPreview((p) => (p?.url === target ? null : { url: target, n: 0 }))}
                  >
                    {t('sessions.runners.preview')}
                  </button>
                  <button className="btn sm ghost" onClick={() => onLink(u)}>
                    {t('sessions.runners.openBrowser')}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
        <div className={`rn-body${preview ? ' split' : ''}`}>
          <div className="rn-term">
            <TerminalView
              stream={stream}
              sessionId={current?.processId ?? null}
              alive={current?.state === 'running'}
              theme={theme}
              onLink={onLink}
              emptyText={t('sessions.runners.termEmpty')}
            />
          </div>
          {preview && (
            <div className="rn-preview" aria-label={t('sessions.runners.webPreview')}>
              <div className="rn-pbar">
                <code className="mono">{previewLabel(preview.url)}</code>
                <button className="btn sm ghost" onClick={() => setPreview((p) => (p ? { ...p, n: p.n + 1 } : p))}>
                  {t('sessions.runners.reload')}
                </button>
                <button className="btn sm ghost" onClick={() => onLink(preview.url)}>
                  {t('sessions.runners.openBrowser')}
                </button>
                <button className="btn sm ghost" onClick={() => setPreview(null)} aria-label={t('sessions.runners.closePreview')}>
                  ×
                </button>
              </div>
              {/* Isolée : pas de navigation de la page, ni de fenêtre Electron (popups → confirmation des liens). */}
              <iframe
                key={`${preview.url}#${preview.n}`}
                src={preview.url}
                title={t('sessions.runners.previewOf', { url: previewLabel(preview.url) })}
                sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
                referrerPolicy="no-referrer"
                allow=""
              />
            </div>
          )}
        </div>
      </div>
      {confirm && (
        <Modal title={t('sessions.runners.confirmTitle')} onClose={() => setConfirm(null)} width={600} busy={busy !== null}>
          <div className="mb">
            {confirm.changed && (
              <p className="err" role="alert" style={{ margin: 0 }}>
                {t('sessions.runners.changed')}
              </p>
            )}
            <p style={{ margin: 0 }}>{confirmText()}</p>
            <code className="mono" style={{ overflowWrap: 'anywhere' }}>
              {commandText(confirm.c)}
            </code>
            {confirm.c.body && (
              <>
                <span className="hint">{t('sessions.runners.body')}</span>
                <pre className="mono rn-body-src">
                  <code>{confirm.c.body}</code>
                </pre>
                {confirm.c.body_truncated && (
                  <p className="hint rn-cut" role="note" style={{ margin: 0 }}>
                    {t('sessions.runners.bodyCut')}
                  </p>
                )}
              </>
            )}
            {confirm.c.files && confirm.c.files.length > 0 && (
              <RunnerFiles
                files={confirm.c.files}
                onOpen={
                  onOpenFile
                    ? (path) => {
                        setConfirm(null)
                        onOpenFile(path)
                      }
                    : undefined
                }
              />
            )}
            <p className="hint" style={{ margin: 0 }}>
              {rich('sessions.runners.confirmWhere', {
                worktree: <span className="mono">{confirm.c.worktree}</span>,
                source: confirm.c.source ? t('sessions.runners.confirmSource', { source: confirm.c.source }) : '',
              })}
            </p>
          </div>
          <div className="mf">
            <span style={{ marginRight: 'auto' }} />
            <button className="btn ghost" onClick={() => setConfirm(null)} data-autofocus>
              {t('sessions.confirm.cancel')}
            </button>
            <button className="btn pri" disabled={busy !== null} onClick={() => void accept(confirm.c)}>
              {t('sessions.runners.start')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}

/**
 * Fichiers pris en compte par l'empreinte : état écrit en texte, « Voir »
 * (onglet « Fichiers », lecture), avertissement si l'un n'a pas pu être lu
 * en entier (trop gros, non résolu, hors du worktree).
 */
function RunnerFiles({ files, onOpen }: { files: readonly RunnerFile[]; onOpen?: (path: string) => void }) {
  const t = useT()
  const risky = files.filter(riskyRunnerFile)
  return (
    <div className="rn-files">
      <span className="hint">{t('sessions.runners.filesRead')}</span>
      <ul role="list">
        {files.map((f) => (
          <li key={f.path} className={`rn-file ${f.state}`}>
            <span className="mono rn-file-p">{f.path}</span>
            <span className={`fbadge sm${riskyRunnerFile(f) ? ' pend' : f.state === 'absent' ? ' muted' : ' ok'}`}>
              {riskyRunnerFile(f) && <span aria-hidden="true">⚠ </span>}
              {t(FILE_STATE_KEYS[f.state])}
            </span>
            {f.size !== null && <span className="hint">{formatBytes(f.size)}</span>}
            {f.note && <span className="hint rn-file-note">{daemonText(f.note)}</span>}
            {onOpen && openableRunnerFile(f) && (
              <button type="button" className="btn sm ghost" onClick={() => onOpen(f.path)} aria-label={t('sessions.runners.seeLabel', { path: f.path })}>
                {t('sessions.runners.see')}
              </button>
            )}
          </li>
        ))}
      </ul>
      <p style={{ margin: 0 }}>{filesText()}</p>
      {risky.length > 0 && (
        <p className="forge-warn" role="alert">
          <span aria-hidden="true">⚠ </span>
          {t('sessions.runners.riskyWarn', {
            lead:
              risky.length > 1
                ? t('sessions.runners.riskyMany', { count: risky.length })
                : t('sessions.runners.riskyOne', { path: risky[0]!.path }),
            states: risky
              .map((f) => t(FILE_STATE_KEYS[f.state]))
              .filter((v, i, a) => a.indexOf(v) === i)
              .join(', '),
          })}
        </p>
      )}
    </div>
  )
}

/** Taille lisible : « 812 o », « 4,2 Kio », « 1,3 Mio ». */
function formatBytes(n: number): string {
  if (n < 1024) return tr('sessions.runners.bytes', { n })
  const k = n / 1024
  const nf = numberFormat({ maximumFractionDigits: 1 })
  if (k < 1024) return tr('sessions.runners.kib', { n: nf.format(k) })
  return tr('sessions.runners.mib', { n: nf.format(k / 1024) })
}
