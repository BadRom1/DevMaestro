import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'

import type { ConnectionState } from '../../shared/bridge'
import { validHome } from '../../shared/home'
import { ErrorCode, type Session } from '../../shared/protocol'
import { CallError, api, call } from './api'
import { LinkDialog } from './components/LinkDialog'
import { NewSessionDialog } from './components/NewSessionDialog'
import { SessionPane } from './components/SessionPane'
import { Sidebar } from './components/Sidebar'
import { TopBar } from './components/TopBar'
import { ancestorToResolve, fallbackProject, groupByProject, groupPast, pastToOffer, sidebarOrder, type PastEntry } from './state/projects'
import { daemonSaysFolderExists } from './state/format'
import { initialState, needsResolve, reducer } from './state/store'
import { SettingsDialog } from './components/SettingsDialog'
import { useSettings } from './settings'
import { buildProjectChoices } from './state/newSession'
import { emptyDraft, reviewReducer, type ReviewAction, type ReviewDraft } from './state/review'
import { resolveScheme } from './state/themeTokens'
import { applyTheme, systemPrefersLight, terminalTheme, type ThemeMode } from './theme'

/** Aucun fichier vu (référence stable). */
const NO_SEEN: Record<string, boolean> = {}

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

/** Préférence du système (clair ou sombre), suivie en direct. */
function useSystemPrefersLight(): boolean {
  const [light, setLight] = useState(systemPrefersLight)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const on = () => setLight(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return light
}

/** Profondeur de la liste des anciennes sessions, par profil. */
const PAST_LIMIT = 100
/** Nouvel essai de `projects.resolve` après un échec (dossier disparu, démon occupé…). */
const RESOLVE_RETRY_MS = 60_000

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState)
  const { settings, update: updateSettings } = useSettings()
  const themeMode: ThemeMode = settings.theme.mode
  // Seule source du mode affiché : le réglage, et la préférence du système pour « Auto ».
  const systemLight = useSystemPrefersLight()
  const scheme = resolveScheme(themeMode, systemLight)
  // Variables CSS posées avant l'affichage, à chaque changement (mode, palette, couleurs, système).
  useLayoutEffect(() => applyTheme(settings.theme, scheme), [settings.theme, scheme])
  // Couleurs du terminal calculées des mêmes jetons (sans relire le CSS : aucun décalage).
  const termTheme = useMemo(() => terminalTheme(settings.theme, scheme), [settings.theme, scheme])
  const [dialog, setDialog] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const closeSettings = useCallback(() => setSettingsOpen(false), [])
  /** Avertissements du démon au lancement (mode dangereux remplacé…). */
  const [notices, setNotices] = useState<string[]>([])
  const [link, setLink] = useState<string | null>(null)
  const closeDialog = useCallback(() => setDialog(false), [])
  const closeLink = useCallback(() => setLink(null), [])
  const [termSize, setTermSize] = useState<{ cols: number; rows: number } | null>(null)
  const resolving = useRef(new Set<string>())
  /** Dossiers « disparus » déjà redemandés parce que le démon les voit de nouveau. */
  const rechecked = useRef(new Set<string>())
  const [clock, tick] = useState(0)
  const [home, setHome] = useState<string | null>(null)

  // Dossier personnel : donné par le processus principal (absent avec un preload plus ancien).
  useEffect(() => {
    let alive = true
    void Promise.resolve(api.home?.())
      .then((h) => alive && setHome(validHome(h)))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

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
      else if (n.method === 'session.removed') dispatch({ type: 'session.removed', id: n.params.id })
      else if (n.method === 'session.diff_changed') dispatch({ type: 'diff.changed', id: n.params.id })
      else if (n.method === 'quotas.updated') dispatch({ type: 'quotas', report: n.params, notified: true })
    })
    return () => {
      alive = false
      offC()
      offN()
    }
  }, [])

  /**
   * Quotas du démon (dès la connexion, avant toute session). Démon plus
   * ancien (-32601) : la barre du haut garde ceux de la statusline.
   */
  const [quotasSupported, setQuotasSupported] = useState<boolean | null>(null)
  const loadQuotas = useCallback(async (refresh: boolean) => {
    try {
      const r = await call('quotas.get', refresh ? { refresh: true } : {})
      setQuotasSupported(true)
      dispatch({ type: 'quotas', report: r })
    } catch (e) {
      if (e instanceof CallError && e.failure.code === ErrorCode.MethodNotFound) setQuotasSupported(false)
      else if (refresh) throw e
      else console.warn('[devmaestro] quotas.get :', e)
    }
  }, [])

  // À chaque connexion : profils, sessions, anciennes sessions, quotas.
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
        void loadQuotas(false)
      } catch (e) {
        console.warn('[devmaestro] chargement initial :', e)
      }
    })()
    return () => {
      alive = false
    }
  }, [state.connection, loadPast, loadQuotas])

  const sessions = useMemo(() => Object.values(state.sessions), [state.sessions])


  const past = useMemo(() => pastToOffer(state.past, sessions, PAST_LIMIT), [state.past, sessions])

  // Nouvelle connexion : les désaccords pourront être redemandés.
  useEffect(() => {
    if (state.connection.state === 'connected') rechecked.current.clear()
  }, [state.connection])

  // Projets : `projects.resolve` une fois par dossier (sessions courantes et anciennes).
  useEffect(() => {
    if (state.connection.state !== 'connected') return
    const dirs: { cwd: string; project_root: string | null; exists: boolean | undefined }[] = [
      ...sessions.map((s) => ({ cwd: s.cwd, project_root: s.project_root, exists: daemonSaysFolderExists(s) })),
      ...past.flatMap((p) =>
        p.cwd ? [{ cwd: p.cwd, project_root: null, exists: typeof p.cwd_exists === 'boolean' ? p.cwd_exists : undefined }] : [],
      ),
    ]
    // Dossiers disparus : situer le plus haut ancêtre disparu (résolution des parents, un par un).
    for (const d of [...dirs]) {
      const up = ancestorToResolve(d.cwd, state.projects)
      if (up) dirs.push({ cwd: up, project_root: null, exists: undefined })
    }
    for (const s of dirs) {
      const opts = { daemonSaysExists: s.exists, rechecked: rechecked.current.has(s.cwd) }
      if (resolving.current.has(s.cwd) || !needsResolve(state, s.cwd, Date.now(), opts)) continue
      // Désaccord avec le démon (dossier recréé) : une seule nouvelle demande jusqu'au changement suivant.
      if (state.projects[s.cwd]?.exists === false && s.exists === true) rechecked.current.add(s.cwd)
      resolving.current.add(s.cwd)
      call('projects.resolve', { path: s.cwd })
        .then((info) => {
          if (info.exists !== false) rechecked.current.delete(s.cwd)
          dispatch({ type: 'project', cwd: s.cwd, info })
        })
        .catch((e: unknown) => {
          // Connexion perdue ou délai : on réessaiera à la reconnexion. Autre
          // erreur (dossier disparu…) : repli provisoire, nouvel essai plus tard.
          const code = e instanceof CallError ? e.failure.code : null
          if (code === ErrorCode.Disconnected || code === ErrorCode.Timeout) return
          dispatch({ type: 'project.failed', cwd: s.cwd, fallback: fallbackProject(s), retryAt: Date.now() + RESOLVE_RETRY_MS })
        })
        .finally(() => resolving.current.delete(s.cwd))
    }
    // `clock` : réévalue les nouveaux essais toutes les 30 s.
  }, [sessions, past, state, clock])
  const groups = useMemo(() => groupByProject(sessions, state.projects, home), [sessions, state.projects, home])
  const ordered = useMemo(() => sidebarOrder(groups), [groups])
  const waiting = ordered.filter((s) => s.status.state === 'waiting')
  const pastGroups = useMemo(() => groupPast(past, state.projects, home), [past, state.projects, home])
  const selected = state.selectedId ? (state.sessions[state.selectedId] ?? null) : null

  // Sélection par défaut : la première qui attend, sinon la première de la liste.
  useEffect(() => {
    if (selected || ordered.length === 0) return
    dispatch({ type: 'select', id: (waiting[0] ?? ordered[0])!.id })
  }, [selected, ordered, waiting])


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

  const onLaunched = useCallback((s: Session, warnings: string[]) => {
    dispatch({ type: 'session.updated', session: s })
    dispatch({ type: 'select', id: s.id })
    setNotices(warnings.filter((w) => typeof w === 'string' && w.trim() !== ''))
    setDialog(false)
  }, [])

  // Clic sur une notification desktop : afficher la session.
  useEffect(() => api.onSelectSession?.((id) => dispatch({ type: 'select', id })), [])

  const projectChoices = useMemo(
    () => buildProjectChoices({ sessions, past, projects: state.projects, home }),
    [sessions, past, state.projects, home],
  )

  /** Masque une ancienne session (`transcripts.hide`) ; retirée aussitôt de la liste. */
  const hidePast = useCallback(async (p: PastEntry) => {
    await call('transcripts.hide', { profile: p.profile, claude_session_id: p.claude_session_id })
    dispatch({ type: 'past.hidden', profile: p.profile, claude_session_id: p.claude_session_id })
  }, [])

  /** Retire une session arrêtée de la liste du démon ; la page la retire aussitôt. */
  const forget = useCallback(async (id: string) => {
    await call('sessions.forget', { id })
    dispatch({ type: 'session.removed', id })
  }, [])

  /** Revues en cours, par session (gardées en changeant de session). */
  const [reviews, setReviews] = useState<Record<string, ReviewDraft>>({})
  /** Fichiers marqués « vu », par session puis chemin. */
  const [seenFiles, setSeenFiles] = useState<Record<string, Record<string, boolean>>>({})
  const selectedId = state.selectedId
  const reviewSelected = useCallback(
    (a: ReviewAction) => {
      if (!selectedId) return
      setReviews((r) => ({ ...r, [selectedId]: reviewReducer(r[selectedId] ?? emptyDraft, a) }))
    },
    [selectedId],
  )
  const seeSelected = useCallback(
    (path: string, value: boolean) => {
      if (!selectedId) return
      setSeenFiles((m) => ({ ...m, [selectedId]: { ...(m[selectedId] ?? {}), [path]: value } }))
    },
    [selectedId],
  )

  const onSessionUpdated = useCallback((s: Session) => dispatch({ type: 'session.response', session: s }), [])

  const onTermSize = useCallback((cols: number, rows: number) => setTermSize({ cols, rows }), [])

  const banner = connectionText(state.connection)
  const selectedProject = selected ? state.projects[selected.cwd] : undefined

  return (
    <div className="app">
      <TopBar
        sessions={sessions}
        profiles={state.profiles}
        daemonQuotas={state.quotas}
        quotasSeq={state.quotasSeq}
        onRefreshQuotas={quotasSupported === false ? null : () => loadQuotas(true)}
        waitingCount={waiting.length}
        onNextWaiting={() => waiting[0] && select(waiting[0].id)}
        themeMode={themeMode}
        onTheme={(m) => updateSettings({ theme: { ...settings.theme, mode: m } })}
        onNew={() => setDialog(true)}
        onSettings={() => setSettingsOpen(true)}
      />
      <div className={`conn${banner?.bad ? ' bad' : ''}`} role="status" aria-live="polite" hidden={!banner}>
        {banner?.text}
      </div>
      {notices.length > 0 && (
        <div className="conn notice" role="alert">
          <span>
            <b>Avertissement du démon :</b> {notices.join(' ')}
          </span>
          <button className="btn sm ghost" onClick={() => setNotices([])} aria-label="Fermer l’avertissement">
            ×
          </button>
        </div>
      )}
      <main className="viewA">
        <Sidebar
          groups={groups}
          past={past}
          pastGroups={pastGroups}
          onForget={forget}
          onHidePast={hidePast}
          profiles={state.profiles}
          home={home}
          projects={state.projects}
          selectedId={state.selectedId}
          onSelect={select}
          onResumePast={resumePast}
        />
        <SessionPane
          session={selected}
          project={selectedProject}
          profiles={state.profiles}
          stale={selected ? (state.stale[selected.id] ?? []) : []}
          termTheme={termTheme}
          termSize={termSize}
          onTermSize={onTermSize}
          onLink={setLink}
          onSessionUpdated={onSessionUpdated}
          onForget={forget}
          diffSeq={selected ? (state.diffSeq[selected.id] ?? 0) : 0}
          draft={(selected && reviews[selected.id]) || emptyDraft}
          review={reviewSelected}
          seen={(selected && seenFiles[selected.id]) || NO_SEEN}
          onSeen={seeSelected}
        />
      </main>
      {dialog && (
        <NewSessionDialog
          profiles={state.profiles}
          sessions={sessions}
          past={past}
          projects={state.projects}
          home={home}
          projectProfiles={settings.projectProfiles}
          initialCwd={selected?.cwd ?? null}
          termSize={termSize}
          onClose={closeDialog}
          onLaunched={onLaunched}
        />
      )}
      {settingsOpen && (
        <SettingsDialog
          profiles={state.profiles}
          projects={projectChoices}
          home={home}
          scheme={scheme}
          onClose={closeSettings}
        />
      )}
      {link && <LinkDialog url={link} onClose={closeLink} />}
    </div>
  )
}
