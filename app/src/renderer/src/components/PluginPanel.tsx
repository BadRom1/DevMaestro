/**
 * Onglet de session d'un plugin (lot 22a) : `plugins.panel` (langue de
 * l'interface), document revalidé puis rendu natif ; « Actualiser » et
 * redemande automatique selon `refresh_ms`, seulement quand l'onglet est
 * affiché et jamais pendant une autre requête ; erreurs du démon traduites,
 * raison de la défaillance du processus et fin de sa sortie d'erreur.
 *
 * Actions : `plugins.action` avec les `args` du bouton ; un `document`
 * remplace le panneau ; un `propose` ouvre « Envoyer à Claude », qui montre
 * la **consigne tapée** (registre des consignes, clé de l'action puis
 * `pluginPropose`) et le **contenu collé** ; rien n'est envoyé sans le clic
 * sur « Envoyer ». Aucun texte du plugin n'entre dans la consigne tapée.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import { cleanPluginText, parsePluginDocument, parseProposeContent, type ActionItem, type PluginDocument } from '../../../shared/pluginDocument'
import { pluginPromptKey, renderPrompt, resolvePrompt } from '../../../shared/prompts'
import { ErrorCode, type PluginInfo, type Session } from '../../../shared/protocol'
import { CallError, call, errorText } from '../api'
import { useI18n } from '../i18n'
import { usePromptScope } from '../promptScope'
import { useSettings } from '../settings'
import { Modal } from './Modal'
import { PluginDocumentView } from './PluginDocumentView'
import type { PlainKey } from '../../../shared/i18n'

const REASON_KEYS: Record<string, PlainKey> = {
  launch: 'plugins.reason.launch',
  timeout: 'plugins.reason.timeout',
  closed: 'plugins.reason.closed',
  line_too_long: 'plugins.reason.line_too_long',
  not_json: 'plugins.reason.not_json',
  protocol: 'plugins.reason.protocol',
  flood: 'plugins.reason.flood',
  error: 'plugins.reason.error',
}

/** Clé traduite d'une raison de défaillance (inconnue : « raison inconnue »). */
export function reasonKey(reason: unknown): PlainKey {
  return typeof reason === 'string' && Object.prototype.hasOwnProperty.call(REASON_KEYS, reason) ? REASON_KEYS[reason]! : 'plugins.reason.unknown'
}

/** Fin de stderr d'un plugin, nettoyée (texte tiers), 4 Kio au plus. */
export function stderrTail(v: unknown): string | null {
  if (typeof v !== 'string' || v.trim() === '') return null
  return cleanPluginText(v.slice(-4096), 'multiline')
}

interface PanelError {
  text: string
  /** Défaillance du processus (`-32033`) : raison et fin de stderr. */
  failure?: { reason: PlainKey; stderr: string | null }
}

function panelError(e: unknown): PanelError {
  const text = errorText(e)
  if (e instanceof CallError && e.failure.code === ErrorCode.PluginFailed) {
    const d = e.failure.data as { reason?: unknown; stderr_tail?: unknown } | undefined
    return { text, failure: { reason: reasonKey(d?.reason), stderr: stderrTail(d?.stderr_tail) } }
  }
  return { text }
}

export function PluginPanel({
  plugin,
  session,
  visible,
  onLink,
}: {
  plugin: PluginInfo
  session: Session | null
  /** Onglet affiché : la redemande automatique ne tourne que dans ce cas. */
  visible: boolean
  onLink: (url: string) => void
}) {
  const { t, locale } = useI18n()
  const [doc, setDoc] = useState<PluginDocument | null>(null)
  const [error, setError] = useState<PanelError | null>(null)
  const [busy, setBusy] = useState<'load' | 'action' | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [propose, setPropose] = useState<{ action: string; content: string } | null>(null)
  /** Chargement terminé : réarme la redemande automatique. */
  const [loaded, setLoaded] = useState(0)
  const inFlight = useRef(false)
  const alive = useRef(true)
  useEffect(
    () => () => {
      alive.current = false
    },
    [],
  )
  const sessionId = session?.id ?? null
  const actionIds = plugin.actions.map((a) => a.id)
  const actionKey = actionIds.join(',')

  const load = useCallback(async () => {
    if (!sessionId || inFlight.current) return
    inFlight.current = true
    setBusy('load')
    try {
      const r = await call('plugins.panel', { name: plugin.name, session_id: sessionId, locale })
      if (!alive.current) return
      const parsed = parsePluginDocument(r?.document, actionKey ? actionKey.split(',') : [])
      if (parsed.ok) {
        setDoc(parsed.document)
        setError(null)
      } else {
        setDoc(null)
        setError({ text: t('plugins.panel.invalid', { problem: parsed.problem }) })
      }
    } catch (e) {
      if (!alive.current) return
      setDoc(null)
      setError(panelError(e))
    } finally {
      inFlight.current = false
      if (alive.current) {
        setBusy(null)
        setLoaded((n) => n + 1)
      }
    }
  }, [plugin.name, sessionId, locale, actionKey])

  // Onglet affiché (ou session, langue, plugin changés) : panneau demandé.
  useEffect(() => {
    if (visible) void load()
  }, [visible, load])

  // Redemande automatique : onglet affiché, document valide, aucune requête en cours.
  const refresh = doc?.refresh_ms
  useEffect(() => {
    if (!visible || !refresh || error || busy) return
    const timer = setTimeout(() => void load(), refresh)
    return () => clearTimeout(timer)
  }, [visible, refresh, error, busy, loaded, load])

  async function runAction(item: ActionItem) {
    if (!sessionId || inFlight.current) return
    inFlight.current = true
    setBusy('action')
    setActionError(null)
    try {
      const r = await call('plugins.action', {
        name: plugin.name,
        action: item.id,
        session_id: sessionId,
        locale,
        ...(item.args ? { args: item.args } : {}),
      })
      if (!alive.current) return
      if (r?.document !== undefined && r.document !== null) {
        const parsed = parsePluginDocument(r.document, actionIds)
        if (parsed.ok) {
          setDoc(parsed.document)
          setError(null)
        } else setActionError(t('plugins.panel.invalid', { problem: parsed.problem }))
      }
      if (r?.propose !== undefined && r.propose !== null) {
        // Seulement une action déclarée `propose: true` (le démon le vérifie aussi).
        const declared = plugin.actions.find((a) => a.id === item.id)?.propose === true
        const p = declared ? parseProposeContent(r.propose) : { ok: false as const, problem: t('errors.pluginInvalid') }
        if (p.ok) setPropose({ action: item.id, content: p.content })
        else setActionError(t('plugins.propose.invalid', { problem: p.problem }))
      }
    } catch (e) {
      if (alive.current) setActionError(t('plugins.panel.actionError', { error: panelError(e).text }))
    } finally {
      inFlight.current = false
      if (alive.current) {
        setBusy(null)
        setLoaded((n) => n + 1)
      }
    }
  }

  if (!session) return <p className="empty">{t('plugins.panel.noSession')}</p>
  return (
    <div className="pplug">
      <div className="pplug-bar">
        <span className="hint pplug-third" role="note">
          {t('plugins.panel.thirdParty')}
        </span>
        {refresh && !error && <span className="hint">{t('plugins.panel.autoRefresh', { seconds: Math.round(refresh / 1000) })}</span>}
        <button type="button" className="btn sm ghost" disabled={busy !== null} onClick={() => void load()}>
          {busy === 'load' && doc ? t('plugins.panel.refreshing') : t('plugins.panel.refresh')}
        </button>
      </div>
      <div className="pplug-body" aria-busy={busy !== null}>
        {busy === 'load' && !doc && !error && <p className="hint">{t('plugins.panel.loading')}</p>}
        {busy === 'action' && (
          <p className="hint" role="status">
            {t('plugins.panel.actionBusy')}
          </p>
        )}
        {actionError && (
          <p className="inline-err" role="alert">
            {actionError}
          </p>
        )}
        {error ? (
          <div className="pplug-err" role="alert">
            <p className="inline-err">{t('plugins.panel.error', { error: error.text })}</p>
            {error.failure && <p className="hint">{t('plugins.panel.failure', { reason: t(error.failure.reason) })}</p>}
            {error.failure?.stderr && (
              <>
                <p className="hint">{t('plugins.panel.stderr')}</p>
                <pre className="deliv-prompt mono pd-stderr">{error.failure.stderr}</pre>
              </>
            )}
          </div>
        ) : (
          doc && <PluginDocumentView doc={doc} busy={busy !== null} onAction={(it) => void runAction(it)} onLink={onLink} />
        )}
      </div>
      {propose && <ProposeDialog plugin={plugin.name} action={propose.action} content={propose.content} session={session} onClose={() => setPropose(null)} />}
    </div>
  )
}

/**
 * « Envoyer à Claude » : consigne tapée (registre, jamais un texte du
 * plugin) et contenu collé, en lecture seule ; envoi seulement au clic sur
 * « Envoyer », `sessions.sendPrompt {id, instruction, pasted}`.
 */
export function ProposeDialog({
  plugin,
  action,
  content,
  session,
  onClose,
}: {
  plugin: string
  action: string
  content: string
  session: Session
  onClose: () => void
}) {
  const { t } = useI18n()
  const { settings } = useSettings()
  const scope = usePromptScope()
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Clé de l'action seulement pour trouver la surcharge : le nom et l'action ne sont jamais tapés.
  const key = pluginPromptKey(plugin, action) ?? 'pluginPropose'
  let instruction: string | null = null
  let promptError: string | null = null
  try {
    instruction = renderPrompt('pluginPropose', resolvePrompt(settings.prompts, key, scope.projectKey).template, { branch: session.branch })
  } catch (e) {
    promptError = (e as Error).message
  }
  const stopped = !session.alive

  async function send() {
    if (!instruction || stopped || sending) return
    setSending(true)
    setError(null)
    try {
      await call('sessions.sendPrompt', { id: session.id, instruction, pasted: content })
      onClose()
    } catch (e) {
      setError(t('plugins.propose.error', { error: errorText(e) }))
      setSending(false)
    }
  }

  return (
    <Modal title={t('plugins.propose.title')} onClose={onClose} busy={sending} width={720}>
      <div className="mb">
        <div className="field">
          <span className="lbl">{t('plugins.propose.typed')}</span>
          {instruction !== null ? (
            <pre className="deliv-prompt mono" data-testid="propose-instruction">
              {instruction}
            </pre>
          ) : (
            <p className="inline-err" role="alert">
              {t('plugins.propose.promptError', { error: promptError ?? '' })}
            </p>
          )}
        </div>
        <div className="field">
          <span className="lbl" id={`propose-pasted-${plugin}`}>
            {t('plugins.propose.pasted')}
          </span>
          <pre className="deliv-prompt mono pd-pasted" tabIndex={0} aria-labelledby={`propose-pasted-${plugin}`} data-testid="propose-pasted">
            {content}
          </pre>
        </div>
        {stopped && (
          <p className="inline-err" role="note" id={`propose-stopped-${plugin}`}>
            {t('plugins.propose.stopped')}
          </p>
        )}
        {error && (
          <p className="inline-err" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="mf">
        <button
          type="button"
          className="btn pri"
          disabled={stopped || instruction === null || sending}
          aria-describedby={stopped ? `propose-stopped-${plugin}` : undefined}
          onClick={() => void send()}
        >
          {sending ? t('plugins.propose.sending') : t('plugins.propose.send')}
        </button>
        <button type="button" className="btn ghost" disabled={sending} onClick={onClose}>
          {t('plugins.propose.cancel')}
        </button>
      </div>
    </Modal>
  )
}
