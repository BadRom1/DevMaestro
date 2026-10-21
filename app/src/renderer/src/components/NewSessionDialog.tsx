/**
 * Fenêtre « Nouvelle session » (maquette) : projet connu ou autre dossier,
 * profil (défaut du projet), modèle, mode, puis prompt libre ou reprise
 * d'une session du projet. Option « Dans un nouveau worktree » (lot 6) pour
 * un dépôt git. Ctrl+Entrée lance.
 */
import { useEffect, useId, useMemo, useState } from 'react'

import { MAX_TITLE, SETTABLE_MODES, type IssueRef, type ProjectInfo, type Profile, type Session, type WorktreeRequest } from '../../../shared/protocol'
import { projectWorktreeLocation } from '../../../shared/settings'
import {
  LOCATION_LABELS,
  WORKTREE_LOCATIONS,
  branchFromName,
  branchNameProblem,
  branchTakenError,
  commonDirHash8,
  nextFreeBranch,
  worktreePath,
  type WorktreeLocation,
} from '../../../shared/worktrees'
import { api, call, errorCode, errorText } from '../api'
import { useI18n } from '../i18n'
import { daemonText, outcomeUncertain, uncertainText } from '../state/errors'
import { modeLabel, pastDisplayName, sessionDisplayName, shortAgo, tildify } from '../state/format'
import {
  modelAliases,
  buildProjectChoices,
  mergeExtraChoices,
  profileKeyOf,
  projectKeyOf,
  resolveDefaultProfile,
  pastResumeProfile,
  resumeCandidates,
  type ProjectChoice,
  type ResumeCandidate,
} from '../state/newSession'
import { forgeContentWarning, initialOf, invisibleNote, type IssuePrefill } from '../state/forge'
import type { PastEntry } from '../state/projects'
import { folderName } from '../state/projects'
import type { WorktreeLists } from '../state/worktrees'
import { useSettings } from '../settings'
import { AnyProfileBadge, ProfileBadge } from './common'
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
  prefill,
  initialSupported = false,
  onOpenIssues,
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
  /** Lancement depuis une issue (lot 13a) : nom, prompt, worktree et branche préremplis, modifiables. */
  prefill?: IssuePrefill | null
  /** Le démon sait taper la consigne puis coller le contenu (`initial`) ; sinon, pas de lancement depuis une issue. */
  initialSupported?: boolean
  /** « Depuis une issue… » : ouvre les issues du projet choisi (absent : forge masquée). */
  onOpenIssues?: (project: { root: string; name: string; key: string }) => void
}) {
  const { t, rich } = useI18n()
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
  /** Depuis une issue : consigne tapée et contenu collé, séparés (le contenu vient de la forge, non fiable). */
  const fromIssue = !!prefill
  const [instruction, setInstruction] = useState(prefill?.instruction ?? '')
  const [pasted, setPasted] = useState(prefill?.pasted ?? '')
  /** Issue liée à la session (gardée tant que l'utilisateur ne la retire pas). */
  const [issue, setIssue] = useState<IssueRef | null>(prefill?.issue ?? null)
  const [resumeKey, setResumeKey] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const tabsId = useId()
  const [name, setName] = useState(prefill?.name ?? '')

  /* ----- Worktree (lot 6) ----- */
  const repoRoot = project?.isGit ? project.root : null
  const wtList = repoRoot ? worktreeLists[repoRoot] : undefined
  const [useWt, setUseWt] = useState(!!prefill)
  // Branche d'une issue : `<préfixe><n>-<slug>`, gardée telle quelle (pas recalculée depuis le nom).
  const [branch, setBranch] = useState(prefill?.branch ?? '')
  const [branchTouched, setBranchTouched] = useState(!!prefill?.branch)
  /** Branches refusées au lancement (déjà extraites ailleurs, dossier existant) : jamais reproposées. */
  const [refused, setRefused] = useState<ReadonlySet<string>>(() => new Set())
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
      (base !== null && base.trim() !== '' ? branchNameProblem(base.trim()) && t('sessions.new.baseProblem', { problem: branchNameProblem(base.trim()) }) : null) ??
      (effLocation === 'custom' && !customParent ? t('sessions.new.pickParent') : null) ??
      (wtPath && wtList?.worktrees.some((w) => w.path === wtPath) ? t('sessions.new.dirExists', { path: tildify(wtPath, home) }) : null) ??
      (refused.has(effBranch.trim()) ? t('sessions.new.branchRefused', { branch: effBranch.trim() }) : null) ??
      ((() => {
        const other = wtList?.worktrees.find((w) => w.branch === effBranch.trim())
        return other ? t('sessions.new.branchCheckedOut', { branch: effBranch.trim(), path: tildify(other.path, home) }) : null
      })())

  /** Branche déjà prise : refusée au lancement, extraite dans un worktree, ou dont le dossier existe. */
  function branchTaken(b: string, refusedNow: ReadonlySet<string> = refused): boolean {
    if (refusedNow.has(b) || wtList?.worktrees.some((w) => w.branch === b)) return true
    if (!repoRoot) return false
    const p = worktreePath({ location: effLocation, root: repoRoot, branch: b, managedDir, commonDirHash: commonDir ? commonDirHash8(commonDir) : null, customParent })
    return !!p && !!wtList?.worktrees.some((w) => w.path === p)
  }
  // Branche prise : la même avec un suffixe, proposée (« Utiliser … »).
  const freeBranch = wtOn && effBranch.trim() && branchTaken(effBranch.trim()) ? nextFreeBranch(effBranch.trim(), (b) => branchTaken(b)) : null
  function applyBranch(b: string) {
    setBranch(b)
    setBranchTouched(true)
    setError(null)
  }

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
      setError(t('sessions.new.pickFailed', { error: errorText(e) }))
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
  /**
   * Profil de reprise choisi à la main (`null` : celui de la session choisie).
   * Un choix explicite est gardé quand on change de session dans la liste
   * (le choix porte sur le compte, pas sur la session : « tout reprendre sous
   * Perso ») ; il n'est oublié qu'au changement de projet. Sans choix, chaque
   * session reprend sous son profil par défaut (`resumeDefault`).
   */
  const [resumeProfile, setResumeProfile] = useState<string | null>(null)
  // Défaut : celui de la session du démon ; pour une ancienne session, le profil du projet s'il la voit.
  const resumeDefault = !chosen ? effectiveProfile : chosen.kind === 'past' ? pastResumeProfile(chosen.past, effectiveProfile) : chosen.profile
  const effectiveResumeProfile = resumeProfile ?? resumeDefault
  /** Profil d'origine connu : session du démon, ou ancienne session vue par un seul profil. */
  const chosenOrigin = !chosen ? null : chosen.kind === 'session' ? chosen.profile : chosen.profiles.length === 1 ? chosen.profiles[0]! : null
  /** Le profil choisi ne voit pas le transcript (dossiers `projects/` distincts) : Claude Code ne la retrouvera pas. */
  const resumeBlind = chosen?.kind === 'past' && !chosen.profiles.includes(effectiveResumeProfile)

  // Projet changé : dossier et profil reviennent à ceux du projet.
  function pickProject(key: string) {
    setProjectKey(key)
    const c = choices.find((x) => x.key === key)
    setDir(c?.dirs[0]?.path ?? '')
    setProfile(null)
    setResumeKey(null)
    setResumeProfile(null)
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
      setResumeProfile(null)
      setBase(null)
      setLocation(null)
      setCustomParent(null)
    } catch (e) {
      setError(t('sessions.new.pickFailed', { error: errorText(e) }))
    } finally {
      setPicking(false)
    }
  }

  const issueProblem =
    fromIssue && tab === 'prompt'
      ? !initialSupported
        ? t('sessions.new.initialUnsupported')
        : instruction.trim() === ''
          ? t('sessions.new.instructionEmpty')
          : null
      : null
  const canGo = !busy && (tab === 'prompt' ? dir.startsWith('/') && !wtProblem && !issueProblem : !!chosen)

  async function go() {
    if (!canGo) return
    setBusy(true)
    setError(null)
    const common = {
      ...(mode ? { mode } : {}),
      ...(model ? { model } : {}),
      ...(termSize ?? {}),
    }
    const first =
      tab === 'prompt' && fromIssue ? { initial: initialOf({ instruction, pasted }) } : prompt.trim() ? { prompt: prompt.trim() } : {}
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
        const r = await call('sessions.launch', {
          cwd: dir,
          profile: effectiveProfile,
          ...common,
          ...first,
          ...(worktree ? { worktree } : {}),
          ...(issue ? { issue } : {}),
        })
        // Avertissements du démon : texte libre (marqué en anglais) ; ceux de l'app, traduits.
        const warnings = (r.warnings ?? []).map(daemonText)
        // Démon trop ancien : il ignore la demande et lance dans le dossier choisi.
        if (worktree && !r.worktree) {
          warnings.push(t('sessions.new.noWorktree', { cwd: r.session.cwd }))
        }
        let session = r.session
        if (name.trim()) {
          try {
            session = (await call('sessions.update', { id: session.id, title: name.trim() })).session
          } catch (e) {
            warnings.push(t('sessions.new.titleFailed', { error: errorText(e) }))
          }
        }
        onLaunched(session, warnings)
      } else if (chosen?.kind === 'session') {
        // Profil envoyé seulement s'il change : sinon le démon garde celui de la session.
        const r = await call('sessions.resume', {
          id: chosen.session.id,
          ...(effectiveResumeProfile !== chosen.session.profile ? { profile: effectiveResumeProfile } : {}),
          ...common,
          ...first,
        })
        onLaunched(r.session, (r.warnings ?? []).map(daemonText))
      } else if (chosen?.kind === 'past') {
        const r = await call('sessions.resume', {
          claude_session_id: chosen.past.claude_session_id,
          ...(chosen.past.cwd ? { cwd: chosen.past.cwd } : {}),
          profile: effectiveResumeProfile,
          ...common,
          ...first,
        })
        onLaunched(r.session, (r.warnings ?? []).map(daemonText))
      }
    } catch (e) {
      const uncertain = outcomeUncertain(errorCode(e))
      const taken = effBranch.trim()
      if (tab === 'prompt' && wtOn && !uncertain && branchTakenError(errorText(e))) {
        // Branche déjà extraite ailleurs (ou dossier existant) : la même avec un suffixe, proposée d'office.
        const nextRefused = new Set(refused).add(taken)
        setRefused(nextRefused)
        const free = nextFreeBranch(taken, (b) => branchTaken(b, nextRefused))
        if (free) applyBranch(free)
        setError(
          free
            ? t('sessions.new.branchTakenFree', { branch: taken, free })
            : t('sessions.new.branchTaken', { branch: taken }),
        )
        if (repoRoot) loadWorktrees(repoRoot)
        setBusy(false)
        return
      }
      setError(
        tab === 'prompt' && wtOn
          ? uncertain
            ? t('sessions.new.wtUncertain', { error: errorText(e), uncertain: uncertainText() })
            : t('sessions.new.wtFailed', { error: errorText(e) })
          : tab === 'prompt'
            ? t('sessions.new.launchFailed', { error: errorText(e) })
            : t('sessions.new.resumeFailed', { error: errorText(e) }),
      )
      // La création a pu aboutir : listes redemandées.
      if (uncertain && wtOn && repoRoot) loadWorktrees(repoRoot)
      setBusy(false)
    }
  }

  const shownProfile = tab === 'resume' ? effectiveResumeProfile : effectiveProfile
  const profileHint =
    tab === 'resume'
      ? !chosen
        ? resumeProfile === null
          ? t('sessions.new.hint.projectDefault')
          : t('sessions.new.hint.resumeChosen')
        : resumeBlind
        ? t('sessions.new.hint.blind')
        : chosenOrigin && effectiveResumeProfile !== chosenOrigin
          ? t('sessions.new.hint.resumeOther', { profile: label(effectiveResumeProfile).long, origin: label(chosenOrigin).long })
          : chosen?.kind === 'past' && !chosenOrigin
            ? t('sessions.new.hint.anyProfile')
            : t('sessions.new.hint.sessionProfile')
      : profile !== null && profile !== resolved.profile
        ? t('sessions.new.hint.override', { profile: label(resolved.profile).long })
        : resolved.source === 'project'
          ? t('sessions.new.hint.projectDefault')
          : resolved.source === 'recent'
            ? t('sessions.new.hint.recent')
            : t('sessions.new.hint.none')

  return (
    <Modal title={t('sessions.new.title')} onClose={onClose} width={760} busy={busy}>
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
              <span className="lbl">{t('sessions.new.project')}</span>
              <select
                value={project ? project.key : ''}
                autoFocus
                onChange={(e) => (e.target.value === OTHER ? void pickOther() : pickProject(e.target.value))}
                disabled={picking}
              >
                {choices.length === 0 && <option value="">{t('sessions.new.noProject')}</option>}
                {choices.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.name}
                    {c.latest ? ` · ${shortAgo(new Date(c.latest).toISOString())}` : ''}
                  </option>
                ))}
                <option value={OTHER}>{t('sessions.new.otherDir')}</option>
              </select>
              <span className="hint mono">{project ? tildify(project.root, home) : t('sessions.new.pickProject')}</span>
              {onOpenIssues && project?.isGit && (
                <span className="hint">
                  <button
                    type="button"
                    className="linkish"
                    onClick={() => onOpenIssues({ root: project.root, name: project.name, key: project.key })}
                  >
                    {t('sessions.new.fromIssue')}
                  </button>
                </span>
              )}
            </label>
            <label className="field">
              <span className="lbl">{t('sessions.new.dir')}</span>
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
                  {picking ? t('sessions.new.picking') : t('sessions.new.otherDir')}
                </button>
              </span>
            </label>
          </div>
          <div className="grid3">
            <label className="field">
              <span className="lbl">{t('sessions.new.profile')}</span>
              <select
                value={shownProfile}
                onChange={(e) => (tab === 'resume' ? setResumeProfile(e.target.value) : setProfile(e.target.value))}
              >
                {/* i18n-exempt: nom technique du profil par défaut */}
                {names.length === 0 && shownProfile !== 'default' && <option value="default">default</option>}
                {/* Profil d'une session absent de la liste des profils : affiché tel quel. */}
                {!names.includes(shownProfile) && <option value={shownProfile}>{label(shownProfile).long}</option>}
                {names.map((n) => (
                  <option key={n} value={n}>
                    {label(n).long}
                  </option>
                ))}
              </select>
              <span className={resumeBlind && tab === 'resume' ? 'hint warn' : 'hint'}>
                {profileHint}
              </span>
            </label>
            <label className="field">
              <span className="lbl">{t('sessions.new.model')}</span>
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                {modelAliases().map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="lbl">{t('sessions.new.mode')}</span>
              <select value={mode} onChange={(e) => setMode(e.target.value)}>
                <option value="">{t('sessions.new.modeDefault')}</option>
                {SETTABLE_MODES.map((m) => (
                  <option key={m} value={m}>
                    {modeLabel(m)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="stabs inline" role="tablist" aria-label={t('sessions.new.startFrom')}>
            {(
              [
                // i18n-exempt: identifiant de l'onglet
                ['prompt', t('sessions.new.tabPrompt')],
                // i18n-exempt: identifiant de l'onglet
                ['resume', t('sessions.new.tabResume')],
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
                <legend className="lbl">{t('sessions.new.resumeLegend')}</legend>
                {candidates.length === 0 && <p className="hint">{t('sessions.new.noResumable')}</p>}
                {candidates.map((c) => (
                  <label key={c.key} className="rrow">
                    <input
                      type="radio"
                      name={`${tabsId}-resume`}
                      checked={resumeKey === c.key}
                      onChange={() => setResumeKey(c.key)}
                    />
                    {/* Badge seulement si le profil d'origine est connu (pas pour une conversation vue par plusieurs profils). */}
                    {c.kind === 'session' || c.profiles.length === 1 ? <ProfileBadge profile={c.profile} profiles={profiles} /> : <AnyProfileBadge />}
                    <span className="rname">{c.label}</span>
                    <span className="sr-only">
                      {c.kind === 'session' || c.profiles.length === 1
                        ? t('sessions.new.srProfile', { profile: label(c.profile).long })
                        : t('sessions.new.srAnyProfile')}
                    </span>
                    <span className="hint">
                      {c.branch ? `${c.branch} · ` : ''}
                      {shortAgo(c.at ? new Date(c.at).toISOString() : null)}
                      {c.kind === 'session' ? t('sessions.new.stoppedSuffix') : ''}
                    </span>
                  </label>
                ))}
              </fieldset>
            )}
            {tab === 'prompt' && issue && (
              <p className="callout issue-linked">
                {t('sessions.new.issueLinked')} <span className="mono">#{issue.number}</span> {issue.title}{' '}
                <button type="button" className="linkish" onClick={() => setIssue(null)}>
                  {t('sessions.new.unlinkIssue')}
                </button>
              </p>
            )}
            {tab === 'prompt' && (
              <label className="field">
                <span className="lbl">{t('sessions.new.name')}</span>
                <input
                  value={name}
                  maxLength={MAX_TITLE}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('sessions.new.namePlaceholder')}
                />
              </label>
            )}
            {wtOffered && (
              <fieldset className="wt-new">
                <legend className="sr-only">{t('sessions.new.worktree')}</legend>
                <label className="optrow">
                  <input type="checkbox" checked={useWt} onChange={(e) => setUseWt(e.target.checked)} />
                  <span>
                    {t('sessions.new.inWorktree')}
                    <span className="hint optaide">{t('sessions.new.inWorktreeHint')}</span>
                  </span>
                </label>
                {useWt && (
                  <>
                    <div className="grid3">
                      <label className="field">
                        <span className="lbl">{t('sessions.new.branch')}</span>
                        <input
                          className="mono"
                          value={effBranch}
                          spellCheck={false}
                          aria-invalid={wtProblem && branchNameProblem(effBranch.trim()) ? true : undefined}
                          onChange={(e) => {
                            setBranch(e.target.value)
                            setBranchTouched(true)
                          }}
                          placeholder={t('sessions.new.branchPlaceholder', { prefix: settings.worktrees.branchPrefix })}
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
                              {t('sessions.new.branchFromName')}
                            </button>
                          ) : (
                            t('sessions.new.branchAuto')
                          )}
                        </span>
                      </label>
                      <label className="field">
                        <span className="lbl">{t('sessions.new.base')}</span>
                        <input
                          className="mono"
                          value={effBase}
                          spellCheck={false}
                          onChange={(e) => setBase(e.target.value)}
                          placeholder={defaultBase ?? t('sessions.new.basePlaceholder')}
                        />
                        <span className="hint">
                          {defaultBase ? t('sessions.new.baseIs', { base: defaultBase }) : t('sessions.new.baseEmpty')}
                        </span>
                      </label>
                      <label className="field">
                        <span className="lbl">{t('sessions.new.location')}</span>
                        <select value={effLocation} onChange={(e) => chooseLocation(e.target.value as WorktreeLocation)}>
                          {WORKTREE_LOCATIONS.map((l) => (
                            <option key={l} value={l}>
                              {LOCATION_LABELS[l]}
                              {l === projectWorktreeLocation(settings.worktrees, project?.profileKey ?? null) ? t('sessions.new.locationProject') : ''}
                            </option>
                          ))}
                        </select>
                        {effLocation === 'custom' && (
                          <span className="hint">
                            <button type="button" className="linkish" onClick={() => void pickCustomParent()}>
                              {t('sessions.new.changeDir')}
                            </button>
                          </span>
                        )}
                      </label>
                    </div>
                    <p className="hint wt-path">
                      {t('sessions.new.wtPath')}{' '}
                      <span className="mono">{wtPath ? tildify(wtPath, home) : '—'}</span>
                    </p>
                    {wtProblem && (
                      <p className="inline-err" role="alert">
                        {wtProblem}
                        {freeBranch && (
                          <>
                            {' '}
                            <button type="button" className="btn sm" onClick={() => applyBranch(freeBranch)}>
                              {t('sessions.new.useBranch', { branch: freeBranch })}
                            </button>
                          </>
                        )}
                      </p>
                    )}
                  </>
                )}
              </fieldset>
            )}
            {tab === 'prompt' && fromIssue && (
              <>
                <label className="field">
                  <span className="lbl">{t('sessions.new.instruction')}</span>
                  <input value={instruction} maxLength={2000} onChange={(e) => setInstruction(e.target.value.replace(/[\r\n]+/g, ' '))} />
                  <span className="hint">{t('sessions.new.instructionHint')}</span>
                </label>
                <p className="forge-warn" role="note">
                  <span aria-hidden="true">⚠ </span>
                  {forgeContentWarning()}
                </p>
                <details className="forge-pasted">
                  <summary>
                    {t('sessions.new.pasted', {
                      size: pasted.trim() ? t('sessions.new.chars', { n: [...pasted].length }) : t('sessions.new.pastedEmpty'),
                    })}
                    {invisibleNote(prefill?.invisible ?? 0) && <span className="chip pend">{invisibleNote(prefill?.invisible ?? 0)}</span>}
                  </summary>
                  <label className="field">
                    <span className="sr-only">{t('sessions.new.pastedLabel')}</span>
                    <textarea value={pasted} onChange={(e) => setPasted(e.target.value)} spellCheck={false} />
                  </label>
                </details>
                {issueProblem && (
                  <p className="inline-err" role="alert">
                    {issueProblem}
                  </p>
                )}
              </>
            )}
            {!(tab === 'prompt' && fromIssue) && (
            <label className="field">
              <span className="lbl">{tab === 'prompt' ? t('sessions.new.prompt') : t('sessions.new.resumeMessage')}</span>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder={tab === 'prompt' ? t('sessions.new.promptPlaceholder') : t('sessions.new.resumePlaceholder')}
              />
            </label>
            )}
          </div>
        </div>
        <div className="mf">
          {error ? (
            <span className="err" role="alert">
              {error}
            </span>
          ) : (
            <span className="hint" style={{ marginRight: 'auto' }}>
              {rich('sessions.new.shortcut', {
                // i18n-exempt: nom de touche
                ctrl: <kbd>Ctrl</kbd>,
                enter: <kbd>{t('sessions.new.enterKey')}</kbd>,
                action:
                  tab === 'prompt'
                    ? wtOn
                      ? t('sessions.new.actionWtLaunch')
                      : t('sessions.new.actionLaunch')
                    : t('sessions.new.actionResume'),
              })}
            </span>
          )}
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
            {t('sessions.confirm.cancel')}
          </button>
          <button className="btn pri" disabled={!canGo}>
            {busy
              ? tab === 'prompt'
                ? t('sessions.new.launching')
                : t('sessions.new.resuming')
              : tab === 'prompt'
                ? t('sessions.new.launch')
                : t('sessions.new.resume')}
          </button>
        </div>
      </form>
    </Modal>
  )
}
