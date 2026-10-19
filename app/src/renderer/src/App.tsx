import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'

import type { ConnectionState } from '../../shared/bridge'
import { ErrorCode, type Session } from '../../shared/protocol'
import { CallError, api, call } from './api'
import { LinkDialog } from './components/LinkDialog'
import { NewSessionDialog } from './components/NewSessionDialog'
import { SessionPane } from './components/SessionPane'
import { Sidebar } from './components/Sidebar'
import { TopBar } from './components/TopBar'
import { fallbackProject, groupByProject, pastToOffer, sidebarOrder, type PastEntry } from './state/projects'
import { initialState, reducer } from './state/store'
import { applyThemeMode, effectiveScheme, loadThemeMode, type ThemeMode } from './theme'

function connectionText(c: ConnectionState): { text: string; bad: boolean } | null {
  switch (c.state) {
    case 'connected':
      return null
    case 'connecting':
      return { text: 'Connexion au démon orchd…', bad: false }
    case 'starting-daemon':
      return { text: `Démarrage du démon (« ${c.bin} daemon »)…`, bad: false }
    case 'disconnected':
      return {
        text: `Démon injoignable (${c.error}). Nouvel essai dans ${Math.max(1, Math.round(c.retryInMs / 1000))} s.`,
        bad: true,
      }
    case 'incompatible':
      return { text: `Démon incompatible : ${c.error}.`, bad: true }
    case 'refused':
      return {
        text: `Connexion refusée : ${c.error} Nouvel essai dans ${Math.max(1, Math.round(c.retryInMs / 1000))} s.`,
        bad: true,
      }
  }
}

function useScheme(mode: ThemeMode): 'light' | 'dark' {
  const [, force] = useState(0)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const on = () => force((n) => n + 1)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return effectiveScheme(mode)
}

/** Profondeur de la liste des anciennes sessions, par profil. */
const PAST_LIMIT = 20

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState)
  const [themeMode, setThemeMode] = useState<ThemeMode>(loadThemeMode)
  const scheme = useScheme(themeMode)
  const [dialog, setDialog] = useState(false)
  const [link, setLink] = useState<string | null>(null)
  const closeDialog = useCallback(() => setDialog(false), [])
  const closeLink = useCallback(() => setLink(null), [])
  const [termSize, setTermSize] = useState<{ cols: number; rows: number } | null>(null)
  const resolving = useRef(new Set<string>())
  const [, tick] = useState(0)

  // Horloge des « il y a N min ».
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000)
    return () => clearInterval(t)
  }, [])

  // Connexion et notifications du démon.
  useEffect(() => {
    let alive = true
    void api.connection().then((s) => alive && s && dispatch({ type: 'connection', state: s }))
    const offC = api.onConnection((s) => dispatch({ type: 'connection', state: s }))
    const offN = api.onNotification((n) => {
      if (n.method === 'session.updated') dispatch({ type: 'session.updated', session: n.params.session })
      else if (n.method === 'session.effect') dispatch({ type: 'session.effect', id: n.params.id, effect: n.params.effect })
    })
    return () => {
      alive = false
      offC()
      offN()
    }
  }, [])

  // À chaque connexion : profils, sessions, anciennes sessions.
  const loadPast = useCallback(async (profiles: string[]) => {
    for (const profile of profiles) {
      try {
        const r = await call('transcripts.list', { profile, limit: PAST_LIMIT })
        dispatch({ type: 'past', profile, sessions: r.sessions })
      } catch (e) {
        console.warn(`[devmaestro] transcripts.list (${profile}) :`, e)
      }
    }
  }, [])

  useEffect(() => {
    if (state.connection.state !== 'connected') return
    let alive = true
    void (async () => {
      try {
        const [p, s] = await Promise.all([call('profiles.list', {}), call('sessions.list', {})])
        if (!alive) return
        dispatch({ type: 'profiles', profiles: p.profiles })
        dispatch({ type: 'sessions', sessions: s.sessions })
        void loadPast(p.profiles.map((x) => x.name))
      } catch (e) {
        console.warn('[devmaestro] chargement initial :', e)
      }
    })()
    return () => {
      alive = false
    }
  }, [state.connection, loadPast])

  const sessions = useMemo(() => Object.values(state.sessions), [state.sessions])

  // Projets : `projects.resolve` une fois par dossier.
  useEffect(() => {
    if (state.connection.state !== 'connected') return
    for (const s of sessions) {
      if (state.projects[s.cwd] || resolving.current.has(s.cwd)) continue
      resolving.current.add(s.cwd)
      call('projects.resolve', { path: s.cwd })
        .then((info) => dispatch({ type: 'project', cwd: s.cwd, info }))
        .catch((e: unknown) => {
          // Connexion perdue ou délai : on réessaiera. Autre erreur (dossier
          // disparu) : repli mis en cache, sans redemander à chaque mise à jour.
          const code = e instanceof CallError ? e.failure.code : null
          if (code === ErrorCode.Disconnected || code === ErrorCode.Timeout) resolving.current.delete(s.cwd)
          else dispatch({ type: 'project', cwd: s.cwd, info: fallbackProject(s) })
        })
    }
  }, [sessions, state.projects, state.connection])

  const groups = useMemo(() => groupByProject(sessions, state.projects), [sessions, state.projects])
  const ordered = useMemo(() => sidebarOrder(groups), [groups])
  const waiting = ordered.filter((s) => s.status.state === 'waiting')
  const past = useMemo(() => pastToOffer(state.past, sessions, PAST_LIMIT), [state.past, sessions])
  const selected = state.selectedId ? (state.sessions[state.selectedId] ?? null) : null

  // Sélection par défaut : la première qui attend, sinon la première de la liste.
  useEffect(() => {
    if (selected || ordered.length === 0) return
    dispatch({ type: 'select', id: (waiting[0] ?? ordered[0])!.id })
  }, [selected, ordered, waiting])

  const home = useMemo(() => {
    const dir = state.profiles.find((p) => p.name === 'default')?.config_dir ?? state.profiles[0]?.config_dir
    return dir ? dir.replace(/\/[^/]+\/?$/, '') : null
  }, [state.profiles])

  const select = useCallback((id: string) => dispatch({ type: 'select', id }), [])

  const resumePast = useCallback(
    async (p: PastEntry) => {
      const r = await call('sessions.resume', {
        claude_session_id: p.claude_session_id,
        ...(p.cwd ? { cwd: p.cwd } : {}),
        profile: p.profile,
        ...(termSize ?? {}),
      })
      dispatch({ type: 'session.updated', session: r.session })
      dispatch({ type: 'select', id: r.session.id })
    },
    [termSize],
  )

  const onLaunched = useCallback((s: Session) => {
    dispatch({ type: 'session.updated', session: s })
    dispatch({ type: 'select', id: s.id })
    setDialog(false)
  }, [])

  const onTermSize = useCallback((cols: number, rows: number) => setTermSize({ cols, rows }), [])

  const banner = connectionText(state.connection)
  const selectedProject = selected ? state.projects[selected.cwd] : undefined

  return (
    <div className="app">
      <TopBar
        sessions={sessions}
        profiles={state.profiles}
        waitingCount={waiting.length}
        onNextWaiting={() => waiting[0] && select(waiting[0].id)}
        themeMode={themeMode}
        onTheme={(m) => {
          // Appliqué tout de suite : le terminal relit les jetons au rendu suivant.
          applyThemeMode(m)
          setThemeMode(m)
        }}
        onNew={() => setDialog(true)}
      />
      <div className={`conn${banner?.bad ? ' bad' : ''}`} role="status" aria-live="polite" hidden={!banner}>
        {banner?.text}
      </div>
      <main className="viewA">
        <Sidebar
          groups={groups}
          past={past}
          profiles={state.profiles}
          home={home}
          selectedId={state.selectedId}
          onSelect={select}
          onResumePast={resumePast}
        />
        <SessionPane
          session={selected}
          project={selectedProject}
          profiles={state.profiles}
          stale={selected ? (state.stale[selected.id] ?? []) : []}
          scheme={scheme}
          termSize={termSize}
          onTermSize={onTermSize}
          onLink={setLink}
        />
      </main>
      {dialog && (
        <NewSessionDialog
          profiles={state.profiles}
          defaultCwd={selectedProject?.worktree_root ?? selected?.cwd ?? ''}
          termSize={termSize}
          onClose={closeDialog}
          onLaunched={onLaunched}
        />
      )}
      {link && <LinkDialog url={link} onClose={closeLink} />}
    </div>
  )
}
