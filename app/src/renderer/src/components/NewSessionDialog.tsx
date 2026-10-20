/**
 * Fenêtre « Nouvelle session » (maquette) : projet connu ou autre dossier,
 * profil (défaut du projet), modèle, mode, puis prompt libre ou reprise
 * d'une session du projet. Ctrl+Entrée lance.
 */
import { useEffect, useId, useMemo, useState } from 'react'

import { SETTABLE_MODES, type ProjectInfo, type Profile, type Session } from '../../../shared/protocol'
import { api, call, errorText } from '../api'
import { modeLabel, pastDisplayName, sessionDisplayName, shortAgo, tildify } from '../state/format'
import {
  MODEL_ALIASES,
  buildProjectChoices,
  mergeExtraChoices,
  profileKeyOf,
  projectKeyOf,
  resolveDefaultProfile,
  resumeCandidates,
  type ProjectChoice,
  type ResumeCandidate,
} from '../state/newSession'
import type { PastEntry } from '../state/projects'
import { folderName } from '../state/projects'
import { useSettings } from '../settings'
import { ProfileBadge } from './common'
import { Modal } from './Modal'

const OTHER = '__autre__'

type Tab = 'prompt' | 'resume'

export function NewSessionDialog({
  profiles,
  sessions,
  past,
  projects,
  home,
  projectProfiles,
  initialCwd,
  termSize,
  onClose,
  onLaunched,
}: {
  profiles: Profile[]
  sessions: Session[]
  past: PastEntry[]
  projects: Record<string, ProjectInfo>
  home: string | null
  projectProfiles: Record<string, string>
  /** Dossier de la session sélectionnée : son projet est présélectionné. */
  initialCwd: string | null
  termSize: { cols: number; rows: number } | null
  onClose: () => void
  onLaunched: (s: Session, warnings: string[]) => void
}) {
  const known = useMemo(() => buildProjectChoices({ sessions, past, projects, home }), [sessions, past, projects, home])
  /** Dossiers choisis par « Autre dossier… » (fusionnés dans leur projet s'il est connu). */
  const [extras, setExtras] = useState<ProjectChoice[]>([])
  const choices = useMemo(() => mergeExtraChoices(known, extras), [extras, known])
  const [projectKey, setProjectKey] = useState<string>(() => {
    const k = initialCwd ? projectKeyOf(initialCwd, projects[initialCwd]) : null
    return (k && known.some((c) => c.key === k) ? k : known[0]?.key) ?? ''
  })
  const project = choices.find((c) => c.key === projectKey) ?? null
  const [dir, setDir] = useState<string>(() => {
    const c = known.find((x) => x.key === projectKey)
    const inProject = initialCwd && c?.dirs.some((d) => d.path === initialCwd)
    return inProject ? initialCwd! : (c?.dirs[0]?.path ?? '')
  })
  const { label } = useSettings()
  const names = profiles.map((p) => p.name)
  const resolved = resolveDefaultProfile({
    projectRoot: project?.profileKey ?? null,
    projectProfiles,
    profiles: names.length ? names : ['default'],
    recent: project?.recentProfile ?? null,
  })
  const [profile, setProfile] = useState<string | null>(null) // null : celui du projet
  const effectiveProfile = profile ?? resolved.profile
  const [model, setModel] = useState('')
  const [mode, setMode] = useState('')
  const [tab, setTab] = useState<Tab>('prompt')
  const [prompt, setPrompt] = useState('')
  const [resumeKey, setResumeKey] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const tabsId = useId()

  const candidates: ResumeCandidate[] = useMemo(
    () =>
      project
        ? resumeCandidates({
            projectKey: project.key,
            sessions,
            past,
            projects,
            label: (x) => ('id' in x ? sessionDisplayName(x) : pastDisplayName(x)),
          })
        : [],
    [project, sessions, past, projects],
  )
  const chosen = candidates.find((c) => c.key === resumeKey) ?? null

  // Projet changé : dossier et profil reviennent à ceux du projet.
  function pickProject(key: string) {
    setProjectKey(key)
    const c = choices.find((x) => x.key === key)
    setDir(c?.dirs[0]?.path ?? '')
    setProfile(null)
    setResumeKey(null)
  }

  useEffect(() => {
    if (resumeKey && !chosen) setResumeKey(null)
  }, [resumeKey, chosen])

  async function pickOther() {
    setPicking(true)
    setError(null)
    try {
      const path = await api.pickFolder()
      if (!path) return
      let info: ProjectInfo | undefined
      try {
        info = await call('projects.resolve', { path })
      } catch {
        info = undefined
      }
      const key = projectKeyOf(path, info)
      const isGit = !!info?.is_git
      const root = isGit ? (info?.root ?? path) : path
      const c: ProjectChoice = {
        key,
        name: isGit ? (info?.name ?? folderName(root, home)) : folderName(path, home),
        root,
        profileKey: profileKeyOf(path, info),
        isGit,
        dirs: [{ path, label: tildify(path, home), branch: info?.branch ?? null }],
        latest: Date.now(),
        recentProfile: null,
      }
      // Projet connu : le dossier s'ajoute à ses dossiers ; sinon le projet passe en tête.
      setExtras((xs) => [...xs, c])
      setProjectKey(key)
      setDir(path)
      setProfile(null)
      setResumeKey(null)
    } catch (e) {
      setError(`Choix du dossier impossible : ${errorText(e)}`)
    } finally {
      setPicking(false)
    }
  }

  const canGo = !busy && (tab === 'prompt' ? dir.startsWith('/') : !!chosen)

  async function go() {
    if (!canGo) return
    setBusy(true)
    setError(null)
    const common = {
      ...(mode ? { mode } : {}),
      ...(model ? { model } : {}),
      ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
      ...(termSize ?? {}),
    }
    try {
      if (tab === 'prompt') {
        const r = await call('sessions.launch', { cwd: dir, profile: effectiveProfile, ...common })
        onLaunched(r.session, r.warnings ?? [])
      } else if (chosen?.kind === 'session') {
        const r = await call('sessions.resume', { id: chosen.session.id, ...common })
        onLaunched(r.session, r.warnings ?? [])
      } else if (chosen?.kind === 'past') {
        const r = await call('sessions.resume', {
          claude_session_id: chosen.past.claude_session_id,
          ...(chosen.past.cwd ? { cwd: chosen.past.cwd } : {}),
          profile: chosen.past.profile,
          ...common,
        })
        onLaunched(r.session, r.warnings ?? [])
      }
    } catch (e) {
      setError(`${tab === 'prompt' ? 'Lancement' : 'Reprise'} impossible : ${errorText(e)}`)
      setBusy(false)
    }
  }

  const profileHint =
    tab === 'resume'
      ? 'la reprise garde le profil de la session'
      : profile !== null && profile !== resolved.profile
        ? `remplace le défaut (${label(resolved.profile).long})`
        : resolved.source === 'project'
          ? 'profil par défaut du projet'
          : resolved.source === 'recent'
            ? 'dernier profil utilisé dans ce projet'
            : 'aucun profil réglé pour ce projet'

  return (
    <Modal title="Nouvelle session" onClose={onClose} width={760} busy={busy}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void go()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            void go()
          }
        }}
      >
        <div className="mb">
          <div className="grid2">
            <label className="field">
              <span className="lbl">Projet</span>
              <select
                value={project ? project.key : ''}
                autoFocus
                onChange={(e) => (e.target.value === OTHER ? void pickOther() : pickProject(e.target.value))}
                disabled={picking}
              >
                {choices.length === 0 && <option value="">Aucun projet connu</option>}
                {choices.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.name}
                    {c.latest ? ` · ${shortAgo(new Date(c.latest).toISOString())}` : ''}
                  </option>
                ))}
                <option value={OTHER}>Autre dossier…</option>
              </select>
              <span className="hint mono">{project ? tildify(project.root, home) : 'Choisis un projet ou un dossier.'}</span>
            </label>
            <label className="field">
              <span className="lbl">Dossier</span>
              <select value={dir} onChange={(e) => setDir(e.target.value)} disabled={!project || tab === 'resume'}>
                {/* Le choix affiché est toujours le dossier qui sera lancé. */}
                {dir && !(project?.dirs ?? []).some((d) => d.path === dir) && <option value={dir}>{tildify(dir, home)}</option>}
                {(project?.dirs ?? []).map((d) => (
                  <option key={d.path} value={d.path}>
                    {d.label}
                    {d.branch ? ` (${d.branch})` : ''}
                  </option>
                ))}
              </select>
              <span className="hint">
                <button type="button" className="linkish" onClick={() => void pickOther()} disabled={picking}>
                  {picking ? 'Choix en cours…' : 'Autre dossier…'}
                </button>
              </span>
            </label>
          </div>
          <div className="grid3">
            <label className="field">
              <span className="lbl">Profil</span>
              <select value={effectiveProfile} onChange={(e) => setProfile(e.target.value)} disabled={tab === 'resume'}>
                {names.length === 0 && <option value="default">default</option>}
                {names.map((n) => (
                  <option key={n} value={n}>
                    {label(n).long}
                  </option>
                ))}
              </select>
              <span className="hint">{profileHint}</span>
            </label>
            <label className="field">
              <span className="lbl">Modèle</span>
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                {MODEL_ALIASES.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="lbl">Mode</span>
              <select value={mode} onChange={(e) => setMode(e.target.value)}>
                <option value="">Celui du profil</option>
                {SETTABLE_MODES.map((m) => (
                  <option key={m} value={m}>
                    {modeLabel(m)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="stabs inline" role="tablist" aria-label="Partir de">
            {(
              [
                ['prompt', 'Prompt libre'],
                ['resume', 'Reprendre une session'],
              ] as const
            ).map(([k, l]) => (
              <button
                key={k}
                type="button"
                role="tab"
                id={`${tabsId}-${k}`}
                aria-selected={tab === k}
                aria-controls={`${tabsId}-panel`}
                tabIndex={tab === k ? 0 : -1}
                onClick={() => setTab(k)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                    e.preventDefault()
                    const next: Tab = tab === 'prompt' ? 'resume' : 'prompt'
                    setTab(next)
                    document.getElementById(`${tabsId}-${next}`)?.focus()
                  }
                }}
              >
                {l}
                {k === 'resume' && candidates.length > 0 && <span className="badge">{candidates.length}</span>}
              </button>
            ))}
          </div>
          <div role="tabpanel" id={`${tabsId}-panel`} aria-labelledby={`${tabsId}-${tab}`} className="tabpanel">
            {tab === 'resume' && (
              <fieldset className="resume-list">
                <legend className="lbl">Session à reprendre</legend>
                {candidates.length === 0 && <p className="hint">Aucune session reprenable dans ce projet.</p>}
                {candidates.map((c) => (
                  <label key={c.key} className="rrow">
                    <input
                      type="radio"
                      name={`${tabsId}-resume`}
                      checked={resumeKey === c.key}
                      onChange={() => setResumeKey(c.key)}
                    />
                    <ProfileBadge profile={c.profile} profiles={profiles} />
                    <span className="rname">{c.label}</span>
                    <span className="sr-only">profil {label(c.profile).long}</span>
                    <span className="hint">
                      {c.branch ? `${c.branch} · ` : ''}
                      {shortAgo(c.at ? new Date(c.at).toISOString() : null)}
                      {c.kind === 'session' ? ' · arrêtée' : ''}
                    </span>
                  </label>
                ))}
              </fieldset>
            )}
            <label className="field">
              <span className="lbl">{tab === 'prompt' ? 'Prompt initial' : 'Message à la reprise (facultatif)'}</span>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder={tab === 'prompt' ? 'Décris la tâche… (facultatif)' : 'Où en étions-nous ?'}
              />
            </label>
          </div>
        </div>
        <div className="mf">
          {error ? (
            <span className="err" role="alert">
              {error}
            </span>
          ) : (
            <span className="hint" style={{ marginRight: 'auto' }}>
              <kbd>Ctrl</kbd>+<kbd>Entrée</kbd> pour {tab === 'prompt' ? 'lancer' : 'reprendre'}
            </span>
          )}
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
            Annuler
          </button>
          <button className="btn pri" disabled={!canGo}>
            {busy ? (tab === 'prompt' ? 'Lancement…' : 'Reprise…') : tab === 'prompt' ? 'Lancer ▶' : 'Reprendre ▶'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
