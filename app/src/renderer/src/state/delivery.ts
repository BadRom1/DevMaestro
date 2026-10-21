/**
 * Livraison et suivi de CI d'une session (v0.3, lot 14b) : états affichés
 * (jamais la couleur seule : symbole et texte), boutons de livraison
 * disponibles, exécutions en échec. Calculs purs, testables sans DOM.
 */
import { actionLabel, primaryAction, type DeliveryAction } from '../../../shared/delivery'
import { renderPrompt, type PromptId } from '../../../shared/prompts'
import type { ChecksState, DeliveryMode, DeliveryState, Run, Session, SessionCi, SessionDelivery } from '../../../shared/protocol'
import { ErrorCode } from '../../../shared/protocol'
import { t } from '../../../shared/i18n'
import type { Badge } from './forgePulls'

export { actionLabel, primaryAction }
export type { DeliveryAction }

/** Relecture de `forge.sessionCi` tant que la session est affichée (le démon garde 30 s). */
export const SESSION_CI_REFRESH_MS = 60_000

/**
 * État de livraison affiché : celui du démon (demande de fusion, commits
 * poussés), promu à `merged` si la branche est intégrée dans la référence
 * (worktree proposé au nettoyage, lot 6).
 */
export function deliveryOf(delivery: SessionDelivery | null | undefined, integrated: boolean): DeliveryState {
  if (integrated) return 'merged'
  const s = delivery?.state
  return s === 'merged' || s === 'pr_open' ? s : 'none'
}

/** Pastille « Livrée » / « PR #n ouverte », ou rien. */
export function deliveryBadge(delivery: SessionDelivery | null | undefined, integrated: boolean): Badge | null {
  const state = deliveryOf(delivery, integrated)
  if (state === 'merged') {
    return {
      glyph: '✓',
      text: t('forge.delivery.badge.delivered'),
      tone: 'ok',
      label: t(integrated && delivery?.state !== 'merged' ? 'forge.delivery.badge.deliveredIntegrated' : 'forge.delivery.badge.delivered'),
    }
  }
  if (state === 'pr_open') {
    const n = delivery?.pull?.number
    return {
      glyph: '⇄',
      text: n ? t('forge.delivery.badge.prOpenNumber', { number: n }) : t('forge.delivery.badge.prOpen'),
      tone: 'pend',
      label: n ? t('forge.delivery.badge.pullOpenNumberLabel', { number: n }) : t('forge.delivery.badge.pullOpenLabel'),
    }
  }
  return null
}

/** Pastille de la CI d'une session suivie ; rien sans exécution. */
export function ciBadge(state: ChecksState | null | undefined): Badge | null {
  switch (state) {
    case 'success':
      return { glyph: '✓', text: t('forge.delivery.ci.success'), tone: 'ok', label: t('forge.delivery.ci.success') }
    case 'failure':
      return { glyph: '✗', text: t('forge.delivery.ci.failure'), tone: 'bad', label: t('forge.delivery.ci.failure') }
    case 'pending':
      return { glyph: '◔', text: t('forge.delivery.ci.pending'), tone: 'pend', label: t('forge.delivery.ci.pending') }
    default:
      return null
  }
}

/**
 * Pourquoi un bouton de livraison est indisponible (texte de l'infobulle),
 * ou `null` s'il peut servir : session arrêtée, demande en attente (la
 * consigne serait tapée dans un dialogue de permission), demande de fusion
 * déjà ouverte, déjà livrée.
 */
export function deliveryBlocker(
  session: Pick<Session, 'alive' | 'status' | 'pending'>,
  action: DeliveryAction,
  state: DeliveryState,
  pullNumber: number | null,
): string | null {
  if (!session.alive) return t('forge.delivery.blocker.notAlive')
  if (session.status.state === 'waiting' || session.pending.length > 0) return t('forge.delivery.blocker.pending')
  if (state === 'merged') return t('forge.delivery.blocker.delivered')
  if (action === 'pr' && state === 'pr_open') {
    return pullNumber ? t('forge.delivery.blocker.pullOpenNumber', { number: pullNumber }) : t('forge.delivery.blocker.pullOpen')
  }
  return null
}

/** Consigne (registre du lot 18) d'un bouton de livraison. */
export function deliveryPromptId(action: DeliveryAction): PromptId {
  return action === 'pr' ? 'deliveryPr' : 'deliveryMerge'
}

/** Consigne d'un bouton de livraison, ou le message d'erreur (modèle invalide). */
export function deliveryPrompt(
  action: DeliveryAction,
  template: string,
  session: Pick<Session, 'branch' | 'issue'>,
  base: string | null,
): { text: string } | { error: string } {
  try {
    return { text: renderPrompt(deliveryPromptId(action), template, { branch: session.branch ?? null, base, issue: session.issue?.number ?? null }) }
  } catch (e) {
    return { error: t('forge.delivery.invalidTemplate', { message: (e as Error).message }) }
  }
}

/**
 * Exécutions en échec à proposer dans « Voir l'échec » : la plus récente de
 * chaque workflow (les relances comprises), si elle a échoué ou a été annulée.
 */
export function failedRuns(runs: readonly Run[] | null | undefined): Run[] {
  const latest = new Map<string, Run>()
  for (const r of runs ?? []) {
    const k = r.workflow ?? r.name
    const prev = latest.get(k)
    if (!prev || (r.created_at ?? '') > (prev.created_at ?? '')) latest.set(k, r)
  }
  return [...latest.values()].filter((r) => r.state === 'failure' || r.state === 'cancelled')
}

/** Libellé d'une exécution (nom du workflow, numéro). */
export function runLabel(r: Pick<Run, 'id' | 'name' | 'workflow'>): string {
  return t('forge.delivery.runLabel', { name: r.workflow ?? r.name, id: r.id })
}

/** Mode retenu pour la session : celui du projet. */
export function sessionMode(mode: DeliveryMode | undefined): DeliveryMode {
  return mode === 'trunk' ? 'trunk' : 'pr'
}

/** Erreur de `forge.sessionCi` : démon ancien (plus d'appel), forge indisponible (rien à montrer), autre. */
export function sessionCiErrorKind(code: number | null): 'old-daemon' | 'unavailable' | 'other' {
  if (code === ErrorCode.MethodNotFound) return 'old-daemon'
  if (code === ErrorCode.ForgeUnavailable) return 'unavailable'
  return 'other'
}

/** Résultat de `forge.sessionCi` lisible (forme minimale vérifiée). */
export function sessionCiOf(v: unknown): SessionCi | null {
  if (typeof v !== 'object' || v === null) return null
  const o = v as Partial<SessionCi>
  if (typeof o.delivery !== 'string' || typeof o.ci !== 'object' || o.ci === null || !Array.isArray(o.ci.runs)) return null
  return o as SessionCi
}
