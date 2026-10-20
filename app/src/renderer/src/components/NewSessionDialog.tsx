/**
 * Fenêtre « Nouvelle session » (maquette) : projet connu ou autre dossier,
 * profil (défaut du projet), modèle, mode, puis prompt libre ou reprise
 * d'une session du projet. Option « Dans un nouveau worktree » (lot 6) pour
 * un dépôt git. Ctrl+Entrée lance.
 */
import { useEffect, useId, useMemo, useState } from 'react'

import { MAX_TITLE, SETTABLE_MODES, type ProjectInfo, type Profile, type Session, type WorktreeRequest } from '../../../shared/protocol'
import { projectWorktreeLocation } from '../../../shared/settings'
import {
  LOCATION_LABELS,
  WORKTREE_LOCATIONS,
  branchFromName,
  branchNameProblem,
  commonDirHash8,
  worktreePath,
  type WorktreeLocation,
} from '../../../shared/worktrees'
import { api, call, errorCode, errorText } from '../api'
import { UNCERTAIN_TEXT, outcomeUncertain } from '../state/errors'
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
import type { WorktreeLists } from '../state/worktrees'
import { useSettings } from '../settings'
import { ProfileBadge } from './common'
import { Modal } from './Modal'

const OTHER = '__autre__'

type Tab = 'prompt' | 'resume'

/** Premiers mots du prompt (source du nom de branche quand la session n'a pas de nom). */
function firstWords(text: string, n = 6): string {
  return text.trim().split('\n')[0]!.split(/\s+/).slice(0, n).join(' ')
}

export function NewSessionDialog({
  profiles,
  sessions,
  past,
  projects,
  home,
  projectProfiles,
  initialCwd,
  initialProjectKey,
  termSize,
  worktreeLists,
  worktreesSupported,
  loadWorktrees,
  managedDir,
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
  /** Projet de la session sélectionnée (identité enregistrée), prioritaire sur la déduction depuis `initialCwd`. */
  initialProjectKey?: string | null
  termSize: { cols: number; rows: number } | null
  /** Worktrees connus, par racine de dépôt. */
  worktreeLists: WorktreeLists
  /** Le démon connaît-il les worktrees (`worktrees.list`) ? `null` : pas encore su. */
  worktreesSupported: boolean | null
  loadWorktrees: (root: string) => void
  /** Dossier des worktrees gérés par l'app. */
  managedDir: string | null
  onClose: () => void
  onLaunched: (s: Session, warnings: string[]) => void
}) {
  const known = useMemo(() => buildProjectChoices({ sessions, past, projects, home }), [sessions, past, projects, home])
  /** Dossiers choisis par « Autre dossier… » (fusionnés dans leur projet s'il est connu). */
  const [extras, setExtras] = useState<ProjectChoice[]>([])
  const choices = useMemo(() => mergeExtraChoices(known, extras), [extras, known])
  const [projectKey, setProjectKey] = useState<string>(() => {
    const k = initialProjectKey ?? (initialCwd ? projectKeyOf(initialCwd, projects[initialCwd]) : null)
    return (k && known.some((c) => c.key === k) ? k : known[0]?.key) ?? ''
  })
  const project = choices.find((c) => c.key === projectKey) ?? null
  const [dir, setDir] = useState<string>(() => {
    const c = known.find((x) => x.key === projectKey)
    const inProject = initialCwd && c?.dirs.some((d) => d.path === initialCwd)
    return inProject ? initialCwd! : (c?.dirs[0]?.path ?? '')
  })
  const { label, settings } = useSettings()
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
  const [name, setName] = useState('')

  /* ----- Worktree (lot 6) ----- */
  const repoRoot = project?.isGit ? project.root : null
  const wtList = repoRoot ? worktreeLists[repoRoot] : undefined
  const [useWt, setUseWt] = useState(false)
  const [branch, setBranch] = useState('')
  const [branchTouched, setBranchTouched] = useState(false)
  /** Base choisie (`null` : branche de référence du dépôt). */
  const [base, setBase] = useState<string | null>(null)
  /** Emplacement choisi ici (`null` : réglage du projet). */
  const [location, setLocation] = useState<WorktreeLocation | null>(null)
  const [customParent, setCustomParent] = useState<string | null>(null)
  const wtOffered = tab === 'prompt' && !!repoRoot && worktreesSupported === true
  const wtOn = wtOffered && useWt
  const effBranch = branchTouched
    ? branch
    : branchFromName(name.trim() || firstWords(prompt), settings.worktrees.branchPrefix)
  const effLocation: WorktreeLocation = location ?? projectWorktreeLocation(settings.worktrees, project?.profileKey ?? null)
  // Base par défaut : la branche de référence retenue par le démon (« origin/main »), sinon la branche par défaut.
  const defaultBase = wtList?.reference ?? wtList?.default_branch ?? null
  const effBase = base ?? defaultBase ?? ''
  // Identité du dépôt (clé `git:<dossier commun>`) : empreinte du dossier géré.
  const commonDir = project?.key.startsWith('git:/') ? project.key.slice('git:'.length) : null
  const wtPath = repoRoot
    ? worktreePath({
        location: effLocation,
        root: repoRoot,
        branch: effBranch,
        managedDir,
        commonDirHash: commonDir ? commonDirHash8(commonDir) : null,
        customParent,
      })
    : null
  const wtProblem: string | null = !wtOn
    ? null
    : branchNameProblem(effBranch.trim()) ??
      (base !== null && base.trim() !== '' ? branchNameProblem(base.trim()) && `base : ${branchNameProblem(base.trim())}` : null) ??
      (effLocation === 'custom' && !customParent ? 'choisis le dossier où créer le worktree' : null) ??
      (wtPath && wtList?.worktrees.some((w) => w.path === wtPath) ? `le dossier existe déjà : ${tildify(wtPath, home)}` : null) ??
      ((() => {
        const other = wtList?.worktrees.find((w) => w.branch === effBranch.trim())
        return other ? `la branche ${effBranch.trim()} est déjà extraite dans ${tildify(other.path, home)}` : null
      })())

  // Dépôt git choisi : ses worktrees (support du démon, branche de référence).
  useEffect(() => {
    if (repoRoot && !wtList && worktreesSupported !== false) loadWorktrees(repoRoot)
  }, [repoRoot, wtList, worktreesSupported, loadWorktrees])

  async function pickCustomParent(): Promise<void> {
    setError(null)
    try {
      const path = await api.pickFolder()
      if (path) {
        setCustomParent(path)
        setLocation('custom')
      }
    } catch (e) {
      setError(`Choix du dossier impossible : ${errorText(e)}`)
    }
  }

  function chooseLocation(v: WorktreeLocation): void {
    if (v === 'custom' && !customParent) {
      void pickCustomParent()
      return
    }
    setLocation(v)
  }

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
    setBase(null)
    setLocation(null)
    setCustomParent(null)
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
      setBase(null)
      setLocation(null)
      setCustomParent(null)
    } catch (e) {
      setError(`Choix du dossier impossible : ${errorText(e)}`)
    } finally {
      setPicking(false)
    }
  }

  const canGo = !busy && (tab === 'prompt' ? dir.startsWith('/') && !wtProblem : !!chosen)

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
        const worktree: WorktreeRequest | undefined = wtOn
          ? {
              branch: effBranch.trim(),
              ...(base !== null && base.trim() !== '' && base.trim() !== defaultBase ? { base: base.trim() } : {}),
              location: effLocation,
              ...(effLocation === 'custom' && wtPath ? { path: wtPath } : {}),
            }
          : undefined
        const r = await call('sessions.launch', { cwd: dir, profile: effectiveProfile, ...common, ...(worktree ? { worktree } : {}) })
        const warnings = [...(r.warnings ?? [])]
        // Démon trop ancien : il ignore la demande et lance dans le dossier choisi.
        if (worktree && !r.worktree) {
          warnings.push(`Le démon n’a pas créé de worktree (version trop ancienne ?) : la session tourne dans ${r.session.cwd}.`)
        }
        let session = r.session
        if (name.trim()) {
          try {
            session = (await call('sessions.update', { id: session.id, title: name.trim() })).session
          } catch (e) {
            warnings.push(`Nom de la session non enregistré : ${errorText(e)}`)
          }
        }
        onLaunched(session, warnings)
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
      const uncertain = outcomeUncertain(errorCode(e))
      setError(
        tab === 'prompt' && wtOn
          ? uncertain
            ? `Création du worktree sans réponse (${errorText(e)}) : ${UNCERTAIN_TEXT} des sessions et des worktrees avant de relancer.`
            : `Worktree ou lancement impossible : ${errorText(e)}. Aucune session n’a été lancée.`
          : `${tab === 'prompt' ? 'Lancement' : 'Reprise'} impossible : ${errorText(e)}`,
      )
      // La création a pu aboutir : listes redemandées.
      if (uncertain && wtOn && repoRoot) loadWorktrees(repoRoot)
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
            {tab === 'prompt' && (
              <label className="field">
                <span className="lbl">Nom de la session (facultatif)</span>
                <input
                  value={name}
                  maxLength={MAX_TITLE}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Ex. : Corriger l’export CSV"
                />
              </label>
            )}
            {wtOffered && (
              <fieldset className="wt-new">
                <legend className="sr-only">Worktree</legend>
                <label className="optrow">
                  <input type="checkbox" checked={useWt} onChange={(e) => setUseWt(e.target.checked)} />
                  <span>
                    Dans un nouveau worktree
                    <span className="hint optaide">
                      Une branche à part, dans son propre dossier : la session y est lancée une fois le worktree créé.
                    </span>
                  </span>
                </label>
                {useWt && (
                  <>
                    <div className="grid3">
                      <label className="field">
                        <span className="lbl">Branche</span>
                        <input
                          className="mono"
                          value={effBranch}
                          spellCheck={false}
                          aria-invalid={wtProblem && branchNameProblem(effBranch.trim()) ? true : undefined}
                          onChange={(e) => {
                            setBranch(e.target.value)
                            setBranchTouched(true)
                          }}
                          placeholder={`${settings.worktrees.branchPrefix}nom-de-la-branche`}
                        />
                        <span className="hint">
                          {branchTouched ? (
                            <button
                              type="button"
                              className="linkish"
                              onClick={() => {
                                setBranchTouched(false)
                                setBranch('')
                              }}
                            >
                              Reprendre le nom de la session
                            </button>
                          ) : (
                            'tirée du nom de la session (ou du prompt)'
                          )}
                        </span>
                      </label>
                      <label className="field">
                        <span className="lbl">Base</span>
                        <input
                          className="mono"
                          value={effBase}
                          spellCheck={false}
                          onChange={(e) => setBase(e.target.value)}
                          placeholder={defaultBase ?? 'branche de référence'}
                        />
                        <span className="hint">
                          {defaultBase ? `branche de référence : ${defaultBase}` : 'vide : branche de référence du dépôt'}
                        </span>
                      </label>
                      <label className="field">
                        <span className="lbl">Emplacement</span>
                        <select value={effLocation} onChange={(e) => chooseLocation(e.target.value as WorktreeLocation)}>
                          {WORKTREE_LOCATIONS.map((l) => (
                            <option key={l} value={l}>
                              {LOCATION_LABELS[l]}
                              {l === projectWorktreeLocation(settings.worktrees, project?.profileKey ?? null) ? ' (réglage du projet)' : ''}
                            </option>
                          ))}
                        </select>
                        {effLocation === 'custom' && (
                          <span className="hint">
                            <button type="button" className="linkish" onClick={() => void pickCustomParent()}>
                              Changer de dossier…
                            </button>
                          </span>
                        )}
                      </label>
                    </div>
                    <p className="hint wt-path">
                      Dossier du worktree :{' '}
                      <span className="mono">{wtPath ? tildify(wtPath, home) : '—'}</span>
                    </p>
                    {wtProblem && (
                      <p className="inline-err" role="alert">
                        {wtProblem}
                      </p>
                    )}
                  </>
                )}
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
              <kbd>Ctrl</kbd>+<kbd>Entrée</kbd> pour {tab === 'prompt' ? (wtOn ? 'créer le worktree et lancer' : 'lancer') : 'reprendre'}
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
