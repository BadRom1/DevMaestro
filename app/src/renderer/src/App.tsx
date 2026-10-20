import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'

import type { ConnectionState } from '../../shared/bridge'
import { validHome } from '../../shared/home'
import { ErrorCode, type Session } from '../../shared/protocol'
import { CallError, api, call } from './api'
import { CleanupDialog } from './components/CleanupDialog'
import { forgetDiffMemory } from './components/DiffView'
import { forgetFilesMemory } from './components/FilesView'
import { LinkDialog } from './components/LinkDialog'
import { NewSessionDialog } from './components/NewSessionDialog'
import { SessionPane } from './components/SessionPane'
import { Sidebar } from './components/Sidebar'
import { TopBar } from './components/TopBar'
import { ancestorToResolve, fallbackProject, groupByProject, groupPast, pastToOffer, sidebarOrder, type PastEntry } from './state/projects'
import { daemonSaysFolderExists } from './state/format'
import { initialState, needsResolve, reducer } from './state/store'
import { KanbanView } from './components/KanbanView'
import { browserStorage } from './state/collapse'
import { loadPaneOpen, paneVisible, savePaneOpen } from './state/kanbanFilter'
import { SettingsDialog } from './components/SettingsDialog'
import { useSettings } from './settings'
import { buildProjectChoices, sessionProjectKey } from './state/newSession'
import { noteWork, type WorktreeLists } from './state/worktrees'
import { rootFromCommonDir } from '../../shared/worktrees'
import { emptyDraft, reviewReducer, type ReviewAction, type ReviewDraft } from './state/review'
import {
  initialLoad,
  loadFailed,
  loadPhase,
  loadSucceeded,
  retryNow,
  sessionsToLoad,
  startLoad,
  type LoadState,
} from './state/subagentsLoad'
import { resolveScheme } from './state/themeTokens'
import { applyTheme, systemPrefersLight, terminalTheme, type ThemeMode } from './theme'

/** État gardé des onglets Diff et Fichiers d'une session oubliée : libéré. */
function forgetViewMemory(id: string): void {
  forgetFilesMemory(id)
  forgetDiffMemory(id)
}

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
      else if (n.method === 'session.removed') {
        forgetViewMemory(n.params.id)
        dispatch({ type: 'session.removed', id: n.params.id })
      }
      else if (n.method === 'session.diff_changed') dispatch({ type: 'diff.changed', id: n.params.id })
      else if (n.method === 'session.subagents_changed') {
        if (typeof n.params?.id === 'string') dispatch({ type: 'subagents.changed', id: n.params.id, agents: n.params.agents })
      } else if (n.method === 'quotas.updated') dispatch({ type: 'quotas', report: n.params, notified: true })
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

  /** Amorçage des listes de sous-agents (voir `subagentsLoad`) ; `loadVer` fait re-rendre. */
  const agentsLoad = useRef<LoadState>(initialLoad())
  const [loadVer, setLoadVer] = useState(0)
  const setAgentsLoad = useCallback((next: LoadState) => {
    agentsLoad.current = next
    setLoadVer((n) => n + 1)
  }, [])

  useEffect(() => {
    if (state.connection.state !== 'connected') return
    // Nouvelle connexion : les listes de sous-agents seront redemandées.
    setAgentsLoad(initialLoad())
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
  }, [state.connection, loadPast, loadQuotas, setAgentsLoad])

  const sessions = useMemo(() => Object.values(state.sessions), [state.sessions])

  /* ---------- Worktrees (lot 6) ---------- */

  /** Listes `worktrees.list` par racine de dépôt. */
  const [worktreeLists, setWorktreeLists] = useState<WorktreeLists>({})
  /** Le démon connaît-il `worktrees.list` ? `null` : pas encore su. */
  const [worktreesSupported, setWorktreesSupported] = useState<boolean | null>(null)
  const wtLoading = useRef(new Set<string>())
  /** Dépôt redemandé pendant un chargement (notification arrivée entre-temps). */
  const wtAgain = useRef(new Set<string>())
  const [managedDir, setManagedDir] = useState<string | null>(null)
  const [cleanup, setCleanup] = useState<{ root: string; name: string; focus: string | null } | null>(null)
  /** Worktrees vus avec du travail à eux (badge « intégrée » crédible, voir `noteWork`). */
  const wtWorked = useRef(new Set<string>())
  const closeCleanup = useCallback(() => setCleanup(null), [])

  const loadWorktrees = useCallback((root: string) => {
    if (wtLoading.current.has(root)) {
      wtAgain.current.add(root)
      return
    }
    wtLoading.current.add(root)
    call('worktrees.list', { root })
      .then((r) => {
        const worktrees = r.worktrees ?? []
        noteWork(wtWorked.current, worktrees)
        setWorktreesSupported(true)
        setWorktreeLists((m) => ({ ...m, [root]: { ...r, default_branch: r.default_branch ?? null, worktrees } }))
      })
      .catch((e: unknown) => {
        const code = e instanceof CallError ? e.failure.code : null
        if (code === ErrorCode.MethodNotFound) {
          setWorktreesSupported(false)
          return
        }
        console.warn(`[devmaestro] worktrees.list (${root}) :`, e)
        if (code === ErrorCode.Disconnected || code === ErrorCode.Timeout) return
        // Refus du démon (dépôt inconnu…) : la méthode existe ; liste vide, sans boucle de nouveaux essais.
        setWorktreesSupported(true)
        setWorktreeLists((m) => (m[root] ? m : { ...m, [root]: { default_branch: null, worktrees: [] } }))
      })
      .finally(() => {
        wtLoading.current.delete(root)
        if (wtAgain.current.delete(root)) loadWorktrees(root)
      })
  }, [])

  // Nouvelle connexion (démon peut-être mis à jour) : support et listes redemandés.
  useEffect(() => {
    if (state.connection.state !== 'connected') return
    setWorktreesSupported(null)
    setWorktreeLists({})
  }, [state.connection])

  // Worktrees changés (création, suppression, intégration) : liste redemandée.
  useEffect(
    () =>
      api.onNotification((n) => {
        if (n.method === 'project.worktrees_changed' && typeof n.params?.root === 'string') loadWorktrees(n.params.root)
      }),
    [loadWorktrees],
  )

  // Dossier des worktrees gérés (chemin affiché à la création) ; absent avec un preload plus ancien.
  useEffect(() => {
    let alive = true
    void Promise.resolve(api.worktreesDir?.())
      .then((d) => alive && setManagedDir(typeof d === 'string' ? d : null))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  /**
   * Sous-agents : `sessions.subagents` pour les sessions qui en ont, puis les
   * notifications `session.subagents_changed`. `clock` (30 s) relance les
   * demandes en échec, sans boucle serrée.
   */
  const seqRef = useRef(state.subagentsSeq)
  seqRef.current = state.subagentsSeq
  useEffect(() => {
    if (state.connection.state !== 'connected') return
    for (const id of sessionsToLoad(agentsLoad.current, sessions, Date.now())) {
      const { state: next, seq } = startLoad(agentsLoad.current, id, seqRef.current)
      setAgentsLoad(next)
      call('sessions.subagents', { id })
        .then((r) => {
          dispatch({ type: 'subagents.loaded', id, agents: r, seq })
          setAgentsLoad(loadSucceeded(agentsLoad.current, id))
        })
        .catch((e: unknown) => {
          const code = e instanceof CallError ? e.failure.code : null
          if (code !== ErrorCode.MethodNotFound) console.warn('[devmaestro] sessions.subagents :', e)
          setAgentsLoad(loadFailed(agentsLoad.current, id, code, Date.now()))
        })
    }
  }, [sessions, state.connection, loadVer, clock, setAgentsLoad])
  const retryAgents = useCallback((id: string) => setAgentsLoad(retryNow(agentsLoad.current, id)), [setAgentsLoad])


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

  /**
   * Fin d'une session : le démon ne signale pas forcément le changement de
   * `sessions_running` ; la liste de son dépôt est redemandée (anti-rebond).
   */
  const wasAlive = useRef(new Map<string, boolean>())
  const endTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  useEffect(() => {
    for (const s of sessions) {
      const before = wasAlive.current.get(s.id)
      wasAlive.current.set(s.id, s.alive)
      if (!before || s.alive || worktreesSupported === false) continue
      const info = state.projects[s.cwd]
      const root = rootFromCommonDir(s.project_common_dir) ?? (info?.is_git ? info.root : null)
      if (!root) continue
      clearTimeout(endTimers.current.get(root))
      endTimers.current.set(
        root,
        setTimeout(() => {
          endTimers.current.delete(root)
          loadWorktrees(root)
        }, 1500),
      )
    }
  }, [sessions, state.projects, worktreesSupported, loadWorktrees])
  useEffect(() => {
    const timers = endTimers.current
    return () => {
      for (const t of timers.values()) clearTimeout(t)
    }
  }, [])

  // Worktrees de chaque dépôt affiché (une fois par connexion, puis sur notification).
  useEffect(() => {
    if (state.connection.state !== 'connected' || worktreesSupported === false) return
    for (const g of groups) {
      if (!g.isGit || g.missing || worktreeLists[g.root]) continue
      // Support encore inconnu : un seul dépôt sonde le démon.
      if (worktreesSupported === null && wtLoading.current.size > 0) break
      loadWorktrees(g.root)
    }
  }, [groups, state.connection, worktreesSupported, worktreeLists, loadWorktrees])

  // Notification « branche intégrée » cliquée : nettoyage de ce dépôt.
  useEffect(
    () =>
      api.onOpenCleanup?.(({ root, path }) => {
        const g = groups.find((x) => x.root === root)
        setCleanup({ root, name: g?.name ?? root.split('/').filter(Boolean).pop() ?? root, focus: path })
        loadWorktrees(root)
      }),
    [groups, loadWorktrees],
  )
  const ordered = useMemo(() => sidebarOrder(groups), [groups])
  const waiting = ordered.filter((s) => s.status.state === 'waiting')
  const pastGroups = useMemo(() => groupPast(past, state.projects, home), [past, state.projects, home])
  const selected = state.selectedId ? (state.sessions[state.selectedId] ?? null) : null

  /**
   * Sélection choisie par l'utilisateur (clic, notification, lancement) et non
   * la sélection par défaut : le volet de la vue par statut ne s'ouvre que sur
   * une session choisie ainsi.
   */
  const [explicitSel, setExplicitSel] = useState(false)

  // Sélection par défaut : la première qui attend, sinon la première de la liste.
  useEffect(() => {
    if (selected || ordered.length === 0) return
    dispatch({ type: 'select', id: (waiting[0] ?? ordered[0])!.id })
  }, [selected, ordered, waiting])


  const select = useCallback((id: string) => {
    dispatch({ type: 'select', id })
    setExplicitSel(true)
  }, [])

  const resumePast = useCallback(
    async (p: PastEntry) => {
      const r = await call('sessions.resume', {
        claude_session_id: p.claude_session_id,
        ...(p.cwd ? { cwd: p.cwd } : {}),
        profile: p.profile,
        ...(termSize ?? {}),
      })
      dispatch({ type: 'session.updated', session: r.session })
      select(r.session.id)
    },
    [termSize, select],
  )

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
    forgetViewMemory(id)
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

  /** Agent choisi dans l'onglet « Agents », par session. */
  const [agentSel, setAgentSel] = useState<Record<string, string>>({})
  /** Demandes d'ouverture de l'onglet « Agents » (clic dans la barre latérale). */
  const [openAgents, setOpenAgents] = useState(0)
  const selectAgent = useCallback(
    (agentId: string) => {
      if (selectedId) setAgentSel((m) => ({ ...m, [selectedId]: agentId }))
    },
    [selectedId],
  )
  const openAgent = useCallback((sessionId: string, agentId: string | null) => {
    select(sessionId)
    if (agentId) setAgentSel((m) => ({ ...m, [sessionId]: agentId }))
    setOpenAgents((n) => n + 1)
  }, [select])

  const onSessionUpdated = useCallback((s: Session) => dispatch({ type: 'session.response', session: s }), [])

  const onTermSize = useCallback((cols: number, rows: number) => setTermSize({ cols, rows }), [])

  const banner = connectionText(state.connection)
  const selectedProject = selected ? state.projects[selected.cwd] : undefined

  /** Vue par statut : volet de session ouvert à côté du kanban (choix retenu). */
  const [kanbanPane, setKanbanPaneState] = useState(() => loadPaneOpen(browserStorage()))
  const setKanbanPane = useCallback((open: boolean) => {
    setKanbanPaneState(open)
    savePaneOpen(browserStorage(), open)
  }, [])
  const openInKanban = useCallback(
    (id: string) => {
      select(id)
      setKanbanPane(true)
    },
    [setKanbanPane, select],
  )
  const closeKanbanPane = useCallback(() => setKanbanPane(false), [setKanbanPane])
  /** Afficher une session : dans le volet en vue par statut, sinon la sélectionner. */
  const kanbanView = settings.view === 'statut'
  const show = useCallback((id: string) => (kanbanView ? openInKanban(id) : select(id)), [kanbanView, openInKanban, select])

  const onLaunched = useCallback(
    (s: Session, warnings: string[]) => {
      dispatch({ type: 'session.updated', session: s })
      show(s.id)
      setNotices(warnings.filter((w) => typeof w === 'string' && w.trim() !== ''))
      setDialog(false)
    },
    [show],
  )

  // Clic sur une notification desktop : afficher la session.
  const showRef = useRef(show)
  showRef.current = show
  useEffect(() => api.onSelectSession?.((id) => showRef.current(id)), [])

  const sessionPane = (
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
      agents={selected ? state.subagents[selected.id] : undefined}
      agentsLoad={selected ? loadPhase(agentsLoad.current, selected.id) : null}
      onRetryAgents={retryAgents}
      agentId={(selected && agentSel[selected.id]) || null}
      onSelectAgent={selectAgent}
      openAgents={openAgents}
    />
  )

  return (
    <div className="app">
      <TopBar
        sessions={sessions}
        profiles={state.profiles}
        daemonQuotas={state.quotas}
        quotasSeq={state.quotasSeq}
        onRefreshQuotas={quotasSupported === false ? null : () => loadQuotas(true)}
        waitingCount={waiting.length}
        onNextWaiting={() => waiting[0] && show(waiting[0].id)}
        themeMode={themeMode}
        onTheme={(m) => updateSettings({ theme: { ...settings.theme, mode: m } })}
        onNew={() => setDialog(true)}
        onSettings={() => setSettingsOpen(true)}
        view={settings.view}
        onView={(v) => updateSettings({ view: v })}
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
      {settings.view === 'statut' ? (
        <KanbanView
          sessions={sessions}
          projects={state.projects}
          profiles={state.profiles}
          stale={state.stale}
          subagents={state.subagents}
          groups={groups}
          selectedId={state.selectedId}
          paneOpen={kanbanPane}
          pane={paneVisible(kanbanPane, selected, explicitSel) ? sessionPane : null}
          onOpen={openInKanban}
          onClose={closeKanbanPane}
        />
      ) : (
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
          subagents={state.subagents}
          onOpenAgent={openAgent}
          worktrees={worktreeLists}
          worktreesWorked={wtWorked.current}
          worktreesEnabled={worktreesSupported === true}
          onCleanup={(root, name, focus) => {
            setCleanup({ root, name, focus })
            loadWorktrees(root)
          }}
        />
        {sessionPane}
      </main>
      )}
      {dialog && (
        <NewSessionDialog
          profiles={state.profiles}
          sessions={sessions}
          past={past}
          projects={state.projects}
          home={home}
          projectProfiles={settings.projectProfiles}
          initialCwd={selected?.cwd ?? null}
          initialProjectKey={selected ? sessionProjectKey(selected, state.projects[selected.cwd]) : null}
          termSize={termSize}
          worktreeLists={worktreeLists}
          worktreesSupported={worktreesSupported}
          loadWorktrees={loadWorktrees}
          managedDir={managedDir}
          onClose={closeDialog}
          onLaunched={onLaunched}
        />
      )}
      {cleanup && (
        <CleanupDialog
          key={cleanup.root}
          seen={wtWorked.current}
          root={cleanup.root}
          name={cleanup.name}
          home={home}
          list={worktreeLists[cleanup.root]}
          focus={cleanup.focus}
          onRefresh={() => loadWorktrees(cleanup.root)}
          onClose={closeCleanup}
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
