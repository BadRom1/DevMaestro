/**
 * Confirmation des commandes du dépôt (lot 14a), tenue par le processus
 * principal : la page ne peut pas lancer un runner que l'utilisateur n'a pas
 * accepté dans ce worktree, même en appelant `runners.start` directement.
 *
 * - La confirmation porte sur (worktree, empreinte du démon) : `Runner.fingerprint`
 *   couvre la commande, le dossier, la source, le **corps** exécuté et le
 *   verrou. Un script modifié (package.json changé par Claude, `git pull`)
 *   change l'empreinte et redemande confirmation.
 * - Avant `runners.start` : détection relue (`runners.list`), worktree de la
 *   session résolu (`sessions.get`, `projects.resolve` : racine git du
 *   dossier, sinon le dossier, comme le démon) ; empreinte non acceptée →
 *   refus `RunnerConfirmationRequired` avec, en `data`, ce que la page doit
 *   montrer (commande et corps). Acceptée : `expected_fingerprint` est
 *   ajouté à `runners.start`, et le démon refuse (`-32024`) si sa détection
 *   au lancement diffère : pas de fenêtre entre la vérification et le lancement.
 * - « Lancer » dans le dialogue : la page renvoie l'empreinte de ce qu'elle
 *   a montré ; elle n'est retenue que si la détection relue donne la même.
 * - Démon sans empreinte (plus ancien) : lancement refusé (« mets orchd à jour »).
 *
 * Sans Electron : testable avec un faux client.
 */
import type { RunnerConfirmation } from '../shared/bridge'
import { readRunnerFiles } from '../shared/runnerFiles'
import { t } from '../shared/i18n'
import { ErrorCode } from '../shared/protocol'
import { RpcError } from './daemon/rpc'

const FINGERPRINT_RE = /^[0-9a-f]{64}$/

/** Refus produit par l'app (pas par le démon) : `data.origin = "app"` (lot 20), message dans la langue courante. */
const APP_ORIGIN = { origin: 'app' } as const

export interface GuardDeps {
  request(method: string, params: unknown): Promise<unknown>
  /** Empreintes acceptées pour ce worktree. */
  isConfirmed(worktree: string, fingerprint: string): boolean
  remember(worktree: string, fingerprint: string): Promise<void>
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Runner tel que le démon le détecte maintenant, avec son worktree et son empreinte. */
export async function describeRunner(deps: GuardDeps, sessionId: string, runnerId: string): Promise<RunnerConfirmation> {
  const got = await deps.request('sessions.get', { id: sessionId })
  const cwd = isObj(got) && isObj(got.session) ? got.session.cwd : undefined
  if (typeof cwd !== 'string' || !cwd.startsWith('/')) throw new RpcError(ErrorCode.UnknownSession, t('main.error.unknownSession'), APP_ORIGIN)
  const project = await deps.request('projects.resolve', { path: cwd })
  const root = isObj(project) ? project.worktree_root : undefined
  const worktree = typeof root === 'string' && root.startsWith('/') ? root : cwd
  const list = await deps.request('runners.list', { id: sessionId })
  const runners = isObj(list) && Array.isArray(list.runners) ? list.runners : []
  const r = runners.find((x): x is Record<string, unknown> => isObj(x) && x.id === runnerId)
  const command = r?.command
  if (!r || !Array.isArray(command) || command.length === 0 || !command.every((a) => typeof a === 'string')) {
    throw new RpcError(ErrorCode.RunnerUnknown, t('main.error.runnerGone'), APP_ORIGIN)
  }
  const fingerprint = r.fingerprint
  if (typeof fingerprint !== 'string' || !FINGERPRINT_RE.test(fingerprint)) {
    throw new RpcError(ErrorCode.MethodNotFound, t('main.error.noFingerprint'), APP_ORIGIN)
  }
  return {
    worktree,
    runner_id: runnerId,
    label: typeof r.label === 'string' ? r.label : runnerId,
    command: command as string[],
    cwd: typeof r.cwd === 'string' ? r.cwd : '',
    source: typeof r.source === 'string' ? r.source : '',
    body: typeof r.body === 'string' ? r.body : null,
    body_truncated: r.body_truncated === true,
    files: readRunnerFiles(r.files),
    fingerprint,
  }
}

/**
 * Avant `runners.start` : refus tant que cette commande n'a pas été acceptée
 * dans ce worktree ; renvoie l'empreinte acceptée (`expected_fingerprint`).
 */
export async function checkStart(deps: GuardDeps, sessionId: string, runnerId: string): Promise<string> {
  const d = await describeRunner(deps, sessionId, runnerId)
  if (deps.isConfirmed(d.worktree, d.fingerprint)) return d.fingerprint
  throw new RpcError(
    ErrorCode.RunnerConfirmationRequired,
    t('main.error.runnerConfirm'),
    // Charge utile lue par la page (`readConfirmation`, qui ignore `origin`).
    { ...d, ...APP_ORIGIN },
  )
}

/** « Lancer » dans le dialogue : retient la commande montrée, si elle n'a pas changé depuis. */
export async function confirmRunner(deps: GuardDeps, sessionId: string, runnerId: string, fingerprint: string): Promise<void> {
  const d = await describeRunner(deps, sessionId, runnerId)
  if (d.fingerprint !== fingerprint) {
    throw new RpcError(ErrorCode.RunnerConfirmationRequired, t('main.error.runnerChanged'), { ...d, ...APP_ORIGIN })
  }
  await deps.remember(d.worktree, d.fingerprint)
}
