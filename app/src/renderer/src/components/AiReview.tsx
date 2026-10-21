/**
 * Revue assistée par IA (v0.3, lot 19) : bouton « Revue assistée » des
 * demandes de fusion, de l'onglet Diff et de l'onglet Commits, petite
 * confirmation (profil, dossier, contexte préparé et son aperçu), lancement
 * direct d'une session en mode `plan` par `sessions.launch` (consigne tapée,
 * contenu collé), badge « revue » tenu localement.
 */
import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type Ref } from 'react'

import type { FileDiff, Profile, PullDetail, Session } from '../../../shared/protocol'
import { resolvePrompt } from '../../../shared/prompts'
import { LOCATION_LABELS } from '../../../shared/worktrees'
import { call, errorCode, errorText } from '../api'
import {
  MAX_REVIEW_FILES_READ,
  MAX_REVIEW_PASTED_BYTES,
  buildReviewContext,
  fetchCommand,
  isUnknownBase,
  loadReviewMarks,
  markOf,
  readReviewFiles,
  reviewBranch,
  reviewButtonLabel,
  reviewInstruction,
  reviewLocation,
  reviewPromptId,
  reviewSessionName,
  saveReviewMarks,
  short,
  sizeLabel,
  targetRoot,
  targetSha,
  withMark,
  withoutMark,
  type FileRead,
  type ReviewMark,
  type ReviewMarks,
  type ReviewTarget,
} from '../state/aiReview'
import { browserStorage } from '../state/collapse'
import { UNCERTAIN_TEXT, outcomeUncertain } from '../state/errors'
import { initialOf } from '../state/forge'
import { pullDiffFiles, validHeadSha } from '../state/forgePulls'
import { resolveDefaultProfile } from '../state/newSession'
import type { WorktreeLists } from '../state/worktrees'
import { useSettings } from '../settings'
import { Modal } from './Modal'

/* ---------- Registre local des sessions de revue ---------- */

const listeners = new Set<() => void>()
let marks: ReviewMarks | null = null

function current(): ReviewMarks {
  marks ??= loadReviewMarks(browserStorage())
  return marks
}

function commit(next: ReviewMarks) {
  if (next === marks) return
  marks = next
  saveReviewMarks(browserStorage(), next)
  for (const l of listeners) l()
}

export const reviewMarks = {
  get: current,
  subscribe(l: () => void): () => void {
    listeners.add(l)
    return () => listeners.delete(l)
  },
  set(id: string, mark: ReviewMark) {
    commit(withMark(current(), id, mark))
  },
  /** Session retirée (`session.removed`) : sa marque part avec elle. */
  remove(id: string) {
    commit(withoutMark(current(), id))
  },
  /** Tests : relit le stockage. */
  reset() {
    marks = null
    for (const l of listeners) l()
  },
}

export function useReviewMarks(): ReviewMarks {
  return useSyncExternalStore(reviewMarks.subscribe, current)
}

/** Badge « revue » d'une session (barre latérale, en-tête). */
export function ReviewBadge({ mark, onOpenPull }: { mark: ReviewMark; onOpenPull?: () => void }) {
  const what = mark.kind === 'pull' ? `de la demande #${mark.pr ?? '?'}` : mark.kind === 'commit' ? `du commit ${mark.sha ? short(mark.sha) : ''}` : 'du diff'
  const title = `Session de revue assistée ${what}, en lecture seule (mode plan)`
  if (onOpenPull && mark.kind === 'pull' && mark.pr) {
    return (
      <button type="button" className="chip review-chip" title={`${title} : ouvrir la demande`} onClick={onOpenPull}>
        <span aria-hidden="true">◎</span> revue PR #{mark.pr}
      </button>
    )
  }
  return (
    <span className="chip review-chip" title={title}>
      <span aria-hidden="true">◎</span> revue
    </span>
  )
}

/* ---------- Contexte de l'app ---------- */

export interface AiReviewDeps {
  /** Le démon sait taper une consigne puis coller un contenu (`hello.capabilities.initial_prompt`). */
  supported: boolean
  profiles: Profile[]
  termSize: { cols: number; rows: number } | null
  worktreeLists: WorktreeLists
  loadWorktrees: (root: string) => void
  /** Clé de profil et profil récent du projet de cette racine (comme « Nouvelle session »). */
  projectFor: (root: string) => { profileKey: string; recentProfile: string | null }
  /** Session lancée : affichée, avertissements montrés. */
  onLaunched: (s: Session, warnings: string[]) => void
}

interface AiReviewApi extends AiReviewDeps {
  /** Ouvre la confirmation dans une fenêtre (Diff, Commits). */
  open: (t: ReviewTarget) => void
}

const Ctx = createContext<AiReviewApi | null>(null)

export function useAiReview(): AiReviewApi | null {
  return useContext(Ctx)
}

export function AiReviewProvider({ children, ...deps }: AiReviewDeps & { children: ReactNode }) {
  const [target, setTarget] = useState<ReviewTarget | null>(null)
  /** Lancement en cours : Échap, le fond et × ne ferment pas la fenêtre. */
  const [busy, setBusy] = useState(false)
  const api = useMemo<AiReviewApi>(() => ({ ...deps, open: setTarget }), [deps.supported, deps.profiles, deps.termSize, deps.worktreeLists, deps.loadWorktrees, deps.projectFor, deps.onLaunched])
  const close = () => {
    setBusy(false)
    setTarget(null)
  }
  return (
    <Ctx.Provider value={api}>
      {children}
      {target && (
        <Modal title={`Revue assistée : ${reviewSessionName(target).replace(/^Revue /, '')}`} onClose={close} width={720} busy={busy}>
          <AiReviewConfirm target={target} deps={api} onCancel={close} onDone={close} onBusy={setBusy} />
        </Modal>
      )}
    </Ctx.Provider>
  )
}

const OLD_DAEMON = 'Démon trop ancien : il ne sait pas taper une consigne puis coller un contenu. Mets orchd à jour.'

/**
 * Bouton « Revue assistée ». `onClick` absent : la fenêtre de confirmation
 * du contexte (`open`) ; présent : l'appelant affiche la confirmation lui-même
 * (détail d'une demande de fusion, déjà dans un panneau). Démon trop ancien :
 * bouton `aria-disabled` (reste focalisable) et raison visible.
 */
export function AiReviewButton({
  target,
  onClick,
  className = 'btn sm',
  buttonRef,
}: {
  target: () => ReviewTarget | null
  onClick?: (t: ReviewTarget) => void
  className?: string
  buttonRef?: Ref<HTMLButtonElement>
}) {
  const ctx = useAiReview()
  const reasonId = useId()
  if (!ctx) return null
  const probe = target()
  if (!probe) return null
  const label = reviewButtonLabel({
    kind: probe.kind,
    ...(probe.kind === 'pull' ? { number: probe.pull.number } : {}),
    ...(probe.kind === 'commit' ? { sha: probe.commit.sha } : {}),
  })
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={className}
        aria-label={label}
        aria-disabled={ctx.supported ? undefined : true}
        aria-describedby={ctx.supported ? undefined : reasonId}
        title={ctx.supported ? `${label} : session Claude en lecture seule (mode plan), diff en contexte` : OLD_DAEMON}
        onClick={() => {
          if (!ctx.supported) return
          const t = target()
          if (t) (onClick ?? ctx.open)(t)
        }}
      >
        Revue assistée
      </button>
      {!ctx.supported && (
        <span className="hint" id={reasonId}>
          revue assistée : mets orchd à jour
        </span>
      )}
    </>
  )
}

/* ---------- Confirmation ---------- */

type Prep = { phase: 'loading' } | { phase: 'ready'; reads: ReadonlyMap<string, FileRead> } | { phase: 'error'; message: string }

type LaunchError =
  | { kind: 'base'; command: string | null; message: string }
  | { kind: 'stale'; fresh: PullDetail; sha: string }
  | { kind: 'uncertain'; message: string }
  | { kind: 'other'; message: string }

function fetcherOf(t: ReviewTarget): (path: string) => Promise<FileDiff> {
  if (t.kind === 'pull') return (path) => call('forge.pullFile', { root: t.root, number: t.pull.number, path })
  if (t.kind === 'diff') return (path) => call('sessions.diffFile', { id: t.session.id, path })
  const sha = t.commit.sha
  return (path) => call('sessions.commitDiffFile', { id: t.session.id, sha, path })
}

/**
 * Confirmation : profil (celui du projet par défaut), mode plan, dossier,
 * contexte préparé (résumé et aperçu). Rien ne part avant « Lancer la revue ».
 * Une demande de fusion est relue juste avant le lancement : tête changée,
 * rien ne part (« Recharger la demande »).
 */
export function AiReviewConfirm({
  target: initialTarget,
  deps,
  onCancel,
  onDone,
  onBusy,
}: {
  target: ReviewTarget
  deps: AiReviewDeps
  onCancel: () => void
  onDone: () => void
  /** Lancement en cours (la fenêtre ou le panneau ne se ferme pas). */
  onBusy?: (busy: boolean) => void
}) {
  const { settings, label } = useSettings()
  const [target, setTarget] = useState(initialTarget)
  const root = targetRoot(target)
  const project = deps.projectFor(root)
  const names = deps.profiles.map((p) => p.name)
  const resolved = resolveDefaultProfile({
    projectRoot: project.profileKey,
    projectProfiles: settings.projectProfiles,
    profiles: names.length ? names : ['default'],
    recent: project.recentProfile,
  })
  const [profile, setProfile] = useState<string | null>(null)
  const effectiveProfile = profile ?? resolved.profile
  const [prep, setPrep] = useState<Prep>({ phase: 'loading' })
  const [readCount, setReadCount] = useState(0)
  const [noWorktree, setNoWorktree] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<LaunchError | null>(null)
  const launching = useRef(false)
  const profileId = useId()
  const selectRef = useRef<HTMLSelectElement>(null)

  // La confirmation peut remplacer le détail d'une demande (pas de fenêtre) : le focus y entre.
  useEffect(() => {
    selectRef.current?.focus()
  }, [])
  useEffect(() => {
    onBusy?.(busy)
  }, [busy])

  const promptId = reviewPromptId(target)
  const { template } = resolvePrompt(settings.prompts, promptId, project.profileKey)
  const instruction = useMemo((): { text: string } | { error: string } => {
    try {
      return { text: reviewInstruction(target, template, noWorktree && target.kind === 'pull') }
    } catch (e) {
      return { error: (e as Error).message }
    }
  }, [target, template, noWorktree])

  const needsWorktree = target.kind !== 'diff'
  useEffect(() => {
    if (needsWorktree) deps.loadWorktrees(root)
  }, [root, needsWorktree])

  // Contexte préparé à l'ouverture (et après « Recharger la demande ») : diffs lus quatre à la fois, bornés.
  useEffect(() => {
    let alive = true
    setPrep({ phase: 'loading' })
    setReadCount(0)
    readReviewFiles(target.files, fetcherOf(target), { alive: () => alive, onRead: (n) => alive && setReadCount(n) })
      .then((reads) => alive && setPrep({ phase: 'ready', reads }))
      .catch((e: unknown) => alive && setPrep({ phase: 'error', message: errorText(e) }))
    return () => {
      alive = false
    }
  }, [target])

  const ctx = useMemo(
    () => (prep.phase === 'ready' ? buildReviewContext(target, prep.reads, { noWorktree: noWorktree && target.kind === 'pull' }) : null),
    [prep, target, noWorktree],
  )
  const worktreeList = deps.worktreeLists[root]?.worktrees
  /** Liste des worktrees lue (réutilisation possible) avant de proposer le lancement. */
  const listReady = !needsWorktree || noWorktree || worktreeList !== undefined
  const location = reviewLocation(target, worktreeList, noWorktree)
  const ready = ctx !== null && 'text' in instruction && location !== null && deps.supported && listReady

  /** Tête de la demande relue sans cache : `null` si inchangée ou illisible (le lancement continue). */
  async function changedHead(t: ReviewTarget): Promise<PullDetail | null> {
    if (t.kind !== 'pull') return null
    try {
      const fresh = await call('forge.pull', { root: t.root, number: t.pull.number, refresh: true })
      const sha = validHeadSha(fresh.head?.sha)
      return sha && sha !== targetSha(t) ? fresh : null
    } catch {
      return null
    }
  }

  async function launch() {
    if (!ready || launching.current || !ctx || !location || !('text' in instruction)) return
    launching.current = true
    setBusy(true)
    setError(null)
    try {
      const fresh = await changedHead(target)
      if (fresh) {
        setError({ kind: 'stale', fresh, sha: validHeadSha(fresh.head?.sha) ?? '' })
        return
      }
      const initial = initialOf({ instruction: instruction.text, pasted: ctx.pasted })
      const r = await call('sessions.launch', {
        cwd: location.kind === 'worktree' ? location.root : location.cwd,
        profile: effectiveProfile,
        mode: 'plan',
        initial,
        ...(deps.termSize ?? {}),
        ...(location.kind === 'worktree' ? { worktree: { branch: location.branch, base: location.base, location: 'managed' as const } } : {}),
      })
      const warnings = [...(r.warnings ?? [])]
      let worktree: string | null = null
      if (location.kind === 'worktree') {
        worktree = r.worktree?.path ?? null
        if (!r.worktree) warnings.push(`pas de worktree créé (démon trop ancien ?) : la revue tourne dans ${r.session.cwd}`)
        deps.loadWorktrees(root)
      } else if (location.kind === 'reuse') {
        worktree = location.cwd
      }
      reviewMarks.set(r.session.id, markOf(target, worktree))
      let session = r.session
      try {
        session = (await call('sessions.update', { id: session.id, title: reviewSessionName(target) })).session
      } catch (e) {
        warnings.push(`nom non enregistré : ${errorText(e)}`)
      }
      setBusy(false)
      deps.onLaunched(session, warnings)
      onDone()
    } catch (e) {
      const message = errorText(e)
      const code = errorCode(e)
      // La création du worktree a pu aboutir (ou échouer après coup) : liste relue.
      if (needsWorktree) deps.loadWorktrees(root)
      setError(
        outcomeUncertain(code)
          ? { kind: 'uncertain', message }
          : isUnknownBase(code, message)
            ? { kind: 'base', command: fetchCommand(target), message }
            : { kind: 'other', message },
      )
    } finally {
      launching.current = false
      setBusy(false)
    }
  }

  function reloadPull(fresh: PullDetail) {
    if (target.kind !== 'pull') return
    setTarget({ ...target, pull: fresh, files: pullDiffFiles(fresh.files), listTruncated: !!fresh.files_truncated })
    setError(null)
  }

  const sha = targetSha(target)
  const branch = reviewBranch(target)
  const where =
    location === null
      ? 'Sha invalide : rien à relire.'
      : location.kind === 'folder'
        ? target.kind === 'diff'
          ? `Dans le dossier de la session (${location.cwd}) : les changements non commités y sont.`
          : `Dans le dossier du projet (${location.cwd}), sans worktree : il n’est pas sur la branche relue, Claude n’a que le diff collé (la consigne et le contenu le disent).`
        : location.kind === 'reuse'
          ? `Dans le worktree de revue existant (${location.cwd}, branche ${location.branch}).`
          : `Dans un worktree jetable (${LOCATION_LABELS.managed.toLowerCase()}), branche ${branch} sur ${sha ? short(sha) : '?'} ; ton dépôt principal n’est pas touché. À nettoyer à la fin.`
  const limit = Math.min(target.files.length, MAX_REVIEW_FILES_READ)

  return (
    <div className="aireview">
      <div className="mb" aria-busy={busy || prep.phase === 'loading'}>
        <p className="hint">
          Une session Claude s’ouvre en <b>lecture seule</b> pour expliquer et commenter ces changements ; tu poses tes questions dans la conversation.
        </p>
        <dl className="ar-facts">
          <dt>Session</dt>
          <dd>{reviewSessionName(target)}</dd>
          <dt>Mode</dt>
          <dd>
            <span className="chip">Plan (lecture seule)</span>
          </dd>
          <dt>Où</dt>
          <dd>{listReady ? where : 'Lecture des worktrees du projet…'}</dd>
        </dl>
        <label className="field" htmlFor={profileId}>
          <span className="lbl">Profil</span>
          <select id={profileId} ref={selectRef} data-autofocus value={effectiveProfile} onChange={(e) => setProfile(e.target.value)} disabled={busy}>
            {names.length === 0 && <option value="default">default</option>}
            {names.map((n) => (
              <option key={n} value={n}>
                {label(n).long}
              </option>
            ))}
          </select>
          <span className="hint">
            {profile !== null && profile !== resolved.profile
              ? `remplace le défaut (${label(resolved.profile).long})`
              : resolved.source === 'project'
                ? 'profil par défaut du projet'
                : resolved.source === 'recent'
                  ? 'profil utilisé récemment dans ce projet'
                  : 'profil par défaut'}
          </span>
        </label>
        <div className="ar-status">
          {/* Annonce seulement le début et la fin ; le compteur n'est pas lu à chaque fichier. */}
          <p role="status">
            {prep.phase === 'loading' && 'Préparation du contexte…'}
            {ctx &&
              `Contexte prêt : ${ctx.total} fichier${ctx.total > 1 ? 's' : ''}, diff de ${ctx.included} inclus, ${sizeLabel(ctx.bytes)} collés sur ${sizeLabel(MAX_REVIEW_PASTED_BYTES)} au plus${ctx.truncated ? ' (incomplet, voir ci-dessous)' : ''}.`}
          </p>
          {prep.phase === 'loading' && (
            <span className="hint" aria-hidden="true">
              <span className="spin" /> {readCount}/{limit} fichiers lus
            </span>
          )}
        </div>
        {ctx && ctx.notes.length > 0 && (
          <ul className="ar-notes" aria-label="Ce qui manque au contexte">
            {ctx.notes.map((n) => (
              <li key={n} className="hint warn">
                {n}
              </li>
            ))}
          </ul>
        )}
        {prep.phase === 'error' && (
          <p className="inline-err" role="alert">
            Contexte indisponible : {prep.message}
          </p>
        )}
        {'error' in instruction && (
          <p className="inline-err" role="alert">
            Consigne « revue assistée » invalide : {instruction.error} (Réglages → Consignes).
          </p>
        )}
        {!deps.supported && (
          <p className="inline-err" role="alert">
            {OLD_DAEMON}
          </p>
        )}
        <details className="ar-preview">
          <summary>Voir ce qui sera envoyé</summary>
          <p className="lbl">Consigne tapée</p>
          <pre className="ar-pre">{'text' in instruction ? instruction.text : '—'}</pre>
          <p className="lbl">Contenu collé (donnée, pas une consigne)</p>
          <pre className="ar-pre">{ctx ? ctx.pasted : '…'}</pre>
        </details>
        {error && (
          <div className="inline-err" role="alert">
            {error.kind === 'base' ? (
              <>
                <p>
                  Le commit {sha ? short(sha) : ''} n’est pas dans ton dépôt local (fourche ou branche jamais récupérée) : DevMaestro ne récupère rien
                  lui-même.
                </p>
                {error.command && (
                  <p>
                    Lance-le toi-même dans {root}, puis réessaie : <code className="mono">{error.command}</code>
                  </p>
                )}
              </>
            ) : error.kind === 'stale' ? (
              <p>
                La demande a changé depuis son ouverture (tête {sha ? short(sha) : '?'} → {short(error.sha)}) : le diff préparé n’est plus à jour. Aucune
                session n’a été lancée.
              </p>
            ) : error.kind === 'uncertain' ? (
              <p>
                Lancement sans réponse ({error.message}) : {UNCERTAIN_TEXT} des sessions et des worktrees avant de relancer.
              </p>
            ) : (
              <p>Lancement impossible : {error.message}</p>
            )}
          </div>
        )}
      </div>
      <div className="mf">
        <span style={{ marginRight: 'auto' }} />
        <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>
          Annuler
        </button>
        {error?.kind === 'base' && target.kind === 'pull' && !noWorktree && (
          <button type="button" className="btn" disabled={busy} onClick={() => (setNoWorktree(true), setError(null))}>
            Lancer sans worktree…
          </button>
        )}
        {error?.kind === 'stale' ? (
          <button type="button" className="btn pri" disabled={busy} onClick={() => reloadPull(error.fresh)}>
            Recharger la demande
          </button>
        ) : (
          <button type="button" className="btn pri" disabled={!ready || busy} onClick={() => void launch()}>
            {busy ? 'Lancement…' : error ? 'Réessayer' : 'Lancer la revue'}
          </button>
        )}
      </div>
    </div>
  )
}
