/**
 * Changer de compte (v0.3, lot 15 ter) : basculer une session d'un profil
 * Claude Code à un autre sans passer par « Nouvelle session ».
 *
 * Avec les méthodes existantes du démon : `sessions.stop`, attente de l'arrêt
 * effectif (`alive: false`, reçu par `session.updated`), puis
 * `sessions.resume {id, profile}`. Le démon vérifie que le profil cible voit
 * la conversation (`-32015` sinon) et garde l'identifiant de la session :
 * même onglet, même sélection, même dossier.
 *
 * Logique pure : `switchStep` reçoit l'état et un évènement, rend le nouvel
 * état et l'effet à lancer (arrêt ou reprise) ; le composant exécute les
 * effets et fournit l'heure et les instantanés de la session.
 */
import { ErrorCode, type PastSession, type Profile, type Session } from '../../../shared/protocol'
import { QUOTA_CRIT_PCT, type QuotaView } from './quotas'

/** Repos tenu pendant ce délai avant de basculer (un tour peut enchaîner les outils). */
export const IDLE_SETTLE_MS = 1_500
/** Attente maximale de l'arrêt effectif après `sessions.stop` (le démon force l'arrêt avant). */
export const STOP_TIMEOUT_MS = 30_000
/** Reprise refusée car la fin du processus n'est pas encore constatée : nouvel essai après ce délai. */
export const RESUME_RETRY_MS = 500
/** Nombre d'essais de reprise refusés pour « la session tourne encore » (`-32002`). */
export const RESUME_ATTEMPTS = 6

/** Profils vers lesquels basculer : tous sauf celui de la session. */
export function switchTargets(session: Pick<Session, 'profile'>, profiles: readonly Profile[]): Profile[] {
  return profiles.filter((p) => p.name !== session.profile)
}

/**
 * Action « Changer de compte… » proposée : au moins deux profils, et une
 * session vivante (arrêt puis reprise) ou arrêtée mais reprenable (reprise seule).
 */
export function canSwitch(
  session: Pick<Session, 'alive' | 'profile' | 'resumable' | 'resume_blocker'>,
  profiles: readonly Profile[],
): boolean {
  if (profiles.length < 2 || switchTargets(session, profiles).length === 0) return false
  if (session.alive) return true
  return session.resumable !== false && !session.resume_blocker
}

/**
 * Pourquoi Claude ne se repose pas (texte court, sans majuscule), ou `null`
 * au repos : une demande attend, un tour est en cours, ou l'activité
 * dérivée des hooks n'est pas « au repos ».
 */
export function busyReason(s: Pick<Session, 'alive' | 'status' | 'pending' | 'activity'>): string | null {
  if (!s.alive) return null
  const asks = s.pending.map((p) => p.pending.kind)
  if (asks.includes('question') || (s.status.state === 'waiting' && s.status.wait === 'question')) {
    return 'une question attend ta réponse'
  }
  if (asks.length > 0 || s.status.state === 'waiting') return 'une demande de permission attend ta réponse'
  const a = s.activity
  if (a && a.kind !== 'idle') {
    switch (a.kind) {
      case 'tool':
        return a.tool ? `Claude utilise l’outil ${a.tool}` : 'Claude utilise un outil'
      case 'subagents':
        return 'des sous-agents travaillent'
      case 'compacting':
        return 'Claude compacte la conversation'
      case 'waiting':
        return 'une demande attend ta réponse'
      default:
        return 'Claude répond'
    }
  }
  if (s.status.state === 'running' || s.status.state === 'starting') return 'Claude travaille'
  return null
}

/** Profondeur de `transcripts.list` pour chercher la conversation (les plus récentes d'abord). */
export const VISIBILITY_LIMIT = 200

export type Visibility = 'visible' | 'absent' | 'unknown'

/**
 * Un profil voit-il la conversation ? D'après `transcripts.list {profile,
 * exclude_known: false, include_hidden: true, limit}` (les conversations des
 * sessions du démon y sont gardées) : listée → `visible` ; absente d'une liste
 * complète (moins de `limit` entrées) → `absent` ; liste pleine, appel en
 * échec ou conversation sans identifiant → `unknown` (le démon tranchera par
 * `-32015`).
 */
export function visibilityIn(
  claudeSessionId: string | null | undefined,
  list: readonly Pick<PastSession, 'claude_session_id'>[] | null | undefined,
  limit = VISIBILITY_LIMIT,
): Visibility {
  if (!claudeSessionId || !list) return 'unknown'
  if (list.some((x) => x.claude_session_id === claudeSessionId)) return 'visible'
  return list.length < limit ? 'absent' : 'unknown'
}

/** Mode qui supprime les demandes de permission : le démon refuse de le reprendre sans `allow_dangerous_modes` (`-32005`). */
export function dangerousMode(mode: string | null | undefined): boolean {
  return mode === 'bypassPermissions' || mode === 'dontAsk'
}

/**
 * Risques connus avant de basculer, pour avertir dans le dialogue :
 * - `noTranscript` : la conversation n'a pas encore de transcript (absente
 *   même du profil d'origine, ou aucun premier prompt) : reprise refusée sous
 *   tout profil, origine comprise ;
 * - `targetBlind` : le profil cible ne la voit pas (`projects/` distinct) ;
 * - `dangerous` : mode `bypassPermissions` / `dontAsk`, refusé à la reprise
 *   sauf `allow_dangerous_modes` (réglage du démon que l'app ne connaît pas).
 */
export interface SwitchRisks {
  noTranscript: 'sure' | 'likely' | null
  targetBlind: boolean
  dangerous: boolean
}

export function switchRisks(
  session: Pick<Session, 'mode' | 'first_prompt' | 'claude_session_id'>,
  origin: Visibility,
  target: Visibility,
): SwitchRisks {
  const noTranscript =
    !session.claude_session_id || (origin === 'absent' && target !== 'visible')
      ? 'sure'
      : origin === 'unknown' && target !== 'visible' && session.first_prompt === null
        ? 'likely'
        : null
  return {
    noTranscript,
    targetBlind: noTranscript === null && target === 'absent',
    dangerous: dangerousMode(session.mode),
  }
}

/** Fenêtre de quota au plafond (≥ seuil critique de la jauge), la plus pleine des deux. */
export interface Ceiling {
  window: '5 h' | '7 j'
  pct: number
}

export function ceilingOf(view: Pick<QuotaView, 'fiveHour' | 'sevenDay'> | null | undefined): Ceiling | null {
  if (!view) return null
  const five = view.fiveHour?.used_pct
  const seven = view.sevenDay?.used_pct
  const c: Ceiling[] = []
  if (typeof five === 'number' && five >= QUOTA_CRIT_PCT) c.push({ window: '5 h', pct: five })
  if (typeof seven === 'number' && seven >= QUOTA_CRIT_PCT) c.push({ window: '7 j', pct: seven })
  return c.sort((a, b) => b.pct - a.pct)[0] ?? null
}

/**
 * Invite « Compte X au plafond » pour la session affichée : son profil est au
 * plafond et au moins un autre profil a un quota **connu** sous le seuil
 * (sinon basculer n'aide pas, ou on n'en sait rien).
 * Jamais de bascule automatique : l'invite ouvre seulement le dialogue.
 */
export function ceilingSuggestion(
  session: Pick<Session, 'alive' | 'profile' | 'resumable' | 'resume_blocker'>,
  profiles: readonly Profile[],
  views: readonly QuotaView[],
): Ceiling | null {
  if (!canSwitch(session, profiles)) return null
  const own = ceilingOf(views.find((v) => v.profile === session.profile))
  if (!own) return null
  const escape = switchTargets(session, profiles).some((p) => {
    const v = views.find((x) => x.profile === p.name)
    const known = typeof v?.fiveHour?.used_pct === 'number' || typeof v?.sevenDay?.used_pct === 'number'
    return known && !ceilingOf(v)
  })
  return escape ? own : null
}

/** Clé de fermeture de l'invite : la même session, le même profil, la même mesure (elle revient quand le quota change). */
export function ceilingKey(sessionId: string, profile: string, c: Ceiling): string {
  return `${sessionId}|${profile}|${c.window}|${Math.round(c.pct)}`
}

/* ---------- Enchaînement ---------- */

interface Base {
  /** Profil cible. */
  target: string
  /** Profil de la session au départ de la bascule. */
  origin: string
}

export type SwitchState =
  /** « Attendre la fin » : bascule dès que le repos tient `IDLE_SETTLE_MS`. */
  | (Base & { kind: 'waiting'; idleSince: number | null; reason: string | null })
  /** `sessions.stop` envoyé : attente de l'arrêt effectif. */
  | (Base & { kind: 'stopping'; deadline: number })
  /** `sessions.resume {id, profile}` en cours ; `retryAt` : nouvel essai prévu. */
  | (Base & { kind: 'resuming'; profile: string; attempts: number; retryAt: number | null })
  /**
   * La session s'est arrêtée d'elle-même pendant « Attendre la fin » (`/exit`,
   * plantage, arrêt ailleurs) : pas de reprise sans un clic de l'utilisateur.
   */
  | (Base & { kind: 'interrupted' })
  /** Échec : `step` dit où ; la session peut être déjà arrêtée (voir l'instantané). */
  | (Base & { kind: 'failed'; step: 'stop' | 'resume'; profile: string; message: string; code: number | null })
  /** Reprise faite, avec des avertissements du démon à montrer. */
  | (Base & { kind: 'done'; warnings: string[] })

export type SwitchEvent =
  | { type: 'start'; session: Session; target: string; wait: boolean; now: number }
  | { type: 'session'; session: Session | null; now: number }
  | { type: 'tick'; now: number }
  | { type: 'stopSent'; alive: boolean; now: number }
  | { type: 'stopFailed'; message: string; code: number | null }
  | { type: 'resumed'; warnings: string[] }
  | { type: 'resumeFailed'; message: string; code: number | null; now: number }
  /** Après un échec : reprendre sous ce profil (origine, ou nouvel essai vers la cible). */
  | { type: 'resumeAs'; profile: string; session: Session | null; now: number }
  /** Annule l'attente du repos, ou ferme un échec / un avertissement. */
  | { type: 'cancel' }

export type SwitchEffect = { kind: 'stop' } | { kind: 'resume'; profile: string } | null

export interface SwitchResult {
  state: SwitchState | null
  effect: SwitchEffect
}

const keep = (state: SwitchState | null): SwitchResult => ({ state, effect: null })

function stopNow(b: Base, now: number): SwitchResult {
  return { state: { ...b, kind: 'stopping', deadline: now + STOP_TIMEOUT_MS }, effect: { kind: 'stop' } }
}

function resumeNow(b: Base, profile: string): SwitchResult {
  return { state: { ...b, kind: 'resuming', profile, attempts: 1, retryAt: null }, effect: { kind: 'resume', profile } }
}

/** Une transition ; l'effet rendu est à exécuter une seule fois par l'appelant. */
export function switchStep(state: SwitchState | null, ev: SwitchEvent): SwitchResult {
  if (ev.type === 'start') {
    // Une bascule déjà engagée (arrêt ou reprise) n'est pas remplacée.
    if (state && (state.kind === 'stopping' || state.kind === 'resuming')) return keep(state)
    const b: Base = { target: ev.target, origin: ev.session.profile }
    if (!ev.session.alive) return resumeNow(b, ev.target)
    if (!ev.wait) return stopNow(b, ev.now)
    const reason = busyReason(ev.session)
    return keep({ ...b, kind: 'waiting', idleSince: reason ? null : ev.now, reason })
  }
  if (!state) return keep(null)
  // Session retirée de la liste : la bascule (et son échec éventuel) n'a plus d'objet.
  if (ev.type === 'session' && !ev.session) return keep(null)
  if (ev.type === 'resumeAs' && !ev.session) return keep(null)

  if (ev.type === 'cancel') {
    // Arrêt ou reprise envoyés : plus rien à annuler, on attend leur issue.
    return state.kind === 'stopping' || state.kind === 'resuming' ? keep(state) : keep(null)
  }

  switch (state.kind) {
    case 'waiting': {
      if (ev.type === 'session') {
        if (!ev.session) return keep(null)
        // Arrêtée d'elle-même pendant l'attente : rien sans l'accord de l'utilisateur.
        if (!ev.session.alive) return keep({ target: state.target, origin: state.origin, kind: 'interrupted' })
        const reason = busyReason(ev.session)
        const idleSince = reason ? null : (state.idleSince ?? ev.now)
        if (idleSince !== null && ev.now - idleSince >= IDLE_SETTLE_MS) return stopNow(state, ev.now)
        return idleSince === state.idleSince && reason === state.reason ? keep(state) : keep({ ...state, idleSince, reason })
      }
      if (ev.type === 'tick' && state.idleSince !== null && ev.now - state.idleSince >= IDLE_SETTLE_MS) {
        return stopNow(state, ev.now)
      }
      return keep(state)
    }
    case 'stopping': {
      if (ev.type === 'stopSent' && !ev.alive) return resumeNow(state, state.target)
      if (ev.type === 'session') {
        if (!ev.session) return keep(null)
        if (!ev.session.alive) return resumeNow(state, state.target)
        return keep(state)
      }
      if (ev.type === 'stopFailed') {
        return keep({ ...state, kind: 'failed', step: 'stop', profile: state.target, message: ev.message, code: ev.code })
      }
      if (ev.type === 'tick' && ev.now >= state.deadline) {
        return keep({
          ...state,
          kind: 'failed',
          step: 'stop',
          profile: state.target,
          message: `la session ne s’est pas arrêtée en ${Math.round(STOP_TIMEOUT_MS / 1000)} s`,
          code: null,
        })
      }
      return keep(state)
    }
    case 'resuming': {
      if (ev.type === 'resumed') {
        return keep(ev.warnings.length ? { target: state.profile, origin: state.origin, kind: 'done', warnings: ev.warnings } : null)
      }
      if (ev.type === 'resumeFailed') {
        // Fin du processus pas encore constatée par le démon : on réessaie un peu plus tard.
        if (ev.code === ErrorCode.InvalidState && state.attempts < RESUME_ATTEMPTS) {
          return keep({ ...state, retryAt: ev.now + RESUME_RETRY_MS })
        }
        return keep({ ...state, kind: 'failed', step: 'resume', profile: state.profile, message: ev.message, code: ev.code })
      }
      if (ev.type === 'tick' && state.retryAt !== null && ev.now >= state.retryAt) {
        return {
          state: { ...state, attempts: state.attempts + 1, retryAt: null },
          effect: { kind: 'resume', profile: state.profile },
        }
      }
      return keep(state)
    }
    case 'interrupted':
    case 'failed': {
      // Reprise faite ailleurs (« Reprendre ») : plus rien à proposer.
      if (state.kind === 'interrupted' && ev.type === 'session' && ev.session?.alive) return keep(null)
      // Réponse perdue mais reprise faite : la session tourne sous la cible.
      if (state.kind === 'failed' && ev.type === 'session' && ev.session?.alive && ev.session.profile === state.profile && state.profile !== state.origin) {
        return keep(null)
      }
      if (ev.type === 'resumeAs') {
        if (!ev.session) return keep(null)
        // Toujours vivante (arrêt échoué) : on retente l'arrêt avant la reprise.
        if (ev.session.alive) return stopNow({ origin: state.origin, target: ev.profile }, ev.now)
        return resumeNow({ origin: state.origin, target: ev.profile }, ev.profile)
      }
      return keep(state)
    }
    case 'done':
      return keep(state)
  }
}

/** La bascule a besoin d'une horloge (repos à tenir, délai d'arrêt, nouvel essai). */
export function needsTicks(s: SwitchState | null): boolean {
  if (!s) return false
  return (s.kind === 'waiting' && s.idleSince !== null) || s.kind === 'stopping' || (s.kind === 'resuming' && s.retryAt !== null)
}

/** Bascule engagée (arrêt ou reprise en cours) : les autres actions de la session attendent. */
export function switchInFlight(s: SwitchState | null | undefined): boolean {
  return !!s && (s.kind === 'stopping' || s.kind === 'resuming')
}

/** Message d'un échec de reprise : `-32015` dit que le profil ne voit pas la conversation. */
export function resumeFailureText(code: number | null, message: string, profileLabel: string): string {
  if (code === -32015) {
    return `le profil ${profileLabel} ne voit pas cette conversation (dossier projects/ distinct, ou pas encore de transcript) : ${message}`
  }
  return message
}

/** Ce qui risque de faire échouer aussi « Reprendre sous <origine> » après cet échec. */
export function originRetryCaveat(code: number | null, originLabel: string): string {
  if (code === -32005) {
    return `« Reprendre sous ${originLabel} » échouera aussi tant que le démon n’autorise pas ce mode (allow_dangerous_modes).`
  }
  if (code === -32015) {
    return `« Reprendre sous ${originLabel} » peut aussi échouer si la conversation n’a pas encore de transcript.`
  }
  return `« Reprendre sous ${originLabel} » peut échouer pour la même raison.`
}
