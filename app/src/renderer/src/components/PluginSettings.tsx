/**
 * Réglages → Plugins (lot 22a) : dossier des plugins et, pour chacun,
 * libellé, nom, version, description, état, commande, fichiers hachés,
 * permissions expliquées (`network` et `worktree.write` signalées) et
 * empreinte (abrégée, complète au survol, copiable). « Accepter » ouvre une
 * confirmation qui récapitule commande, permissions et empreinte, avec un
 * avertissement fort pour `network` ; l'accord et la révocation passent par
 * les canaux dédiés du processus principal (`acceptPlugin`, `revokePlugin`),
 * jamais par le protocole. Onglet présent seulement avec la capacité `plugins`.
 */
import { useEffect, useId, useRef, useState } from 'react'

import type { PlainKey } from '../../../shared/i18n'
import { cleanPluginText, revealInvisible } from '../../../shared/pluginDocument'
import type { PluginInfo } from '../../../shared/protocol'
import { api } from '../api'
import { useI18n } from '../i18n'
import { isActivePlugin, localized, reloadPlugins, usePlugins } from '../pluginsStore'
import { daemonText, describeError } from '../state/errors'
import { reasonKey, stderrTail } from './PluginPanel'

const PERMISSION_KEYS: Record<string, PlainKey> = {
  'diff.read': 'plugins.perm.diffRead',
  'worktree.read': 'plugins.perm.worktreeRead',
  'worktree.write': 'plugins.perm.worktreeWrite',
  'sessions.read': 'plugins.perm.sessionsRead',
  'claude.propose': 'plugins.perm.claudePropose',
  network: 'plugins.perm.network',
}

function permissionKey(perm: string): PlainKey {
  return Object.prototype.hasOwnProperty.call(PERMISSION_KEYS, perm) ? PERMISSION_KEYS[perm]! : 'plugins.perm.unknown'
}

/** Permissions à signaler (non empêchées techniquement). */
const FLAGGED = new Set(['network', 'worktree.write'])

export type PluginStateKind = 'invalid' | 'changed' | 'active' | 'new'

/** État d'un plugin pour l'utilisateur : invalide, modifié depuis l'accord, actif ou nouveau. */
export function pluginState(p: PluginInfo, accepted: Record<string, string>): PluginStateKind {
  if (!p.valid || p.fingerprint === null) return 'invalid'
  const mine = Object.prototype.hasOwnProperty.call(accepted, p.name) ? accepted[p.name] : undefined
  if (p.acceptance === 'changed' || (mine !== undefined && mine !== p.fingerprint)) return 'changed'
  if (isActivePlugin(p, accepted)) return 'active'
  return 'new'
}

const STATE_KEYS: Record<PluginStateKind, PlainKey> = {
  invalid: 'plugins.state.invalid',
  changed: 'plugins.state.changed',
  active: 'plugins.state.active',
  new: 'plugins.state.new',
}
const STATE_CHIP: Record<PluginStateKind, string> = { invalid: 'bad', changed: 'pend', active: 'ok', new: '' }

/**
 * Commande lisible : invisibles, contrôles et caractères de direction rendus
 * visibles (`⟨U+202E⟩`), arguments avec blanc ou guillemet entre guillemets.
 */
export function commandText(argv: readonly string[]): string {
  return argv
    .map((raw) => {
      const a = revealInvisible(raw)
      return a === '' || /[\s"'\\]/.test(a) ? JSON.stringify(a) : a
    })
    .join(' ')
}

/** Configuration du manifeste (comprise dans l'empreinte), lisible, invisibles rendus visibles, 4 000 caractères au plus. */
export function configText(config: unknown): string | null {
  if (config === undefined) return null
  let text: string
  try {
    text = JSON.stringify(config, null, 2) ?? 'null'
  } catch {
    return null
  }
  const shown = revealInvisible(text)
  return shown.length > 4000 ? `${shown.slice(0, 3999)}…` : shown
}

/** Erreurs du manifeste montrées au plus. */
export const MAX_SHOWN_ERRORS = 20
const MAX_ERROR_CHARS = 300

/** Erreur du démon sur une ligne, invisibles et contrôles retirés. */
function oneLine(e: string): string {
  return cleanPluginText(e.slice(0, 4 * MAX_ERROR_CHARS), 'line')
}

function ManifestErrors({ errors }: { errors: readonly string[] }) {
  const { t } = useI18n()
  const shown = errors.slice(0, MAX_SHOWN_ERRORS)
  const more = errors.length - shown.length
  return (
    <ul className="pl-errors">
      {shown.map((e, i) => {
        const clean = oneLine(e)
        const cut = [...clean].length > MAX_ERROR_CHARS ? `${[...clean].slice(0, MAX_ERROR_CHARS - 1).join('')}…` : clean
        return (
          <li key={i} className="inline-err iso">
            {daemonText(cut)}
          </li>
        )
      })}
      {more > 0 && <li className="hint">{t('plugins.settings.moreErrors', { count: more })}</li>}
    </ul>
  )
}

function Files({ files }: { files: readonly string[] | undefined }) {
  const { t } = useI18n()
  if (!files || files.length === 0) return <span className="hint">{t('plugins.settings.none')}</span>
  return (
    <ul className="pl-files">
      {files.map((f, i) => (
        <li key={i} className="mono iso">
          {revealInvisible(f)}
        </li>
      ))}
    </ul>
  )
}

function Permissions({ list }: { list: readonly string[] }) {
  const { t } = useI18n()
  if (list.length === 0) return <p className="hint">{t('plugins.settings.noPermissions')}</p>
  return (
    <ul className="pl-perms">
      {list.map((perm) => {
        const flagged = FLAGGED.has(perm)
        return (
          <li key={perm} className={flagged ? 'flag' : undefined}>
            <code className="mono">{perm}</code>
            {flagged && (
              <span className="chip pend">
                <span aria-hidden="true">⚠</span> {t('plugins.perm.flag')}
              </span>
            )}{' '}
            <span>{t(permissionKey(perm))}</span>
          </li>
        )
      })}
    </ul>
  )
}

function Fingerprint({ value }: { value: string }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  return (
    <span className="pl-fp">
      <code className="mono" title={value} aria-label={value}>
        {value.slice(0, 12)}…
      </code>
      <button
        type="button"
        className="btn sm ghost"
        onClick={() => {
          void api.copyText(value).then((ok) => setCopied(ok))
        }}
      >
        {t('plugins.settings.copyFingerprint')}
      </button>
      {copied && (
        <span className="hint" role="status">
          {t('plugins.settings.copied')}
        </span>
      )}
    </span>
  )
}

/**
 * Confirmation de l'accord, dans l'onglet (pas de fenêtre modale dans la
 * fenêtre des réglages) : récapitulatif de la commande, des permissions et
 * de l'empreinte ; avertissement fort (rôle `alert`, texte) pour `network`.
 */
function AcceptConfirm({ plugin, onClose }: { plugin: PluginInfo; onClose: () => void }) {
  const { t, locale } = useI18n()
  const id = useId()
  // Focus initial sur « Annuler », jamais sur « Accepter » (une touche Entrée de trop n'accepte rien).
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    cancel.current?.focus()
  }, [])
  const config = configText(plugin.config)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const label = localized(plugin.label, locale) ?? plugin.name
  const fp = plugin.fingerprint!
  const network = plugin.permissions.includes('network')
  const writes = plugin.permissions.includes('worktree.write')

  async function accept() {
    setBusy(true)
    setError(null)
    try {
      const r = (await api.acceptPlugin?.({ name: plugin.name, fingerprint: fp })) ?? null
      if (r && r.ok) {
        void reloadPlugins()
        onClose()
        return
      }
      setError(t('plugins.accept.error', { error: r ? describeError(r.error.code, r.error.message, r.error.data) : t('errors.methodNotFound') }))
    } catch (e) {
      setError(t('plugins.accept.error', { error: (e as Error).message }))
    }
    setBusy(false)
  }

  return (
    <section className="pl-confirm" aria-labelledby={`${id}-h`}>
      <div className="mb">
        <h3 id={`${id}-h`} className="iso">
          {t('plugins.accept.title', { name: plugin.name })}
        </h3>
        <p className="pl-label">
          <strong className="iso">{label}</strong>
          {plugin.version && <span className="hint"> {t('plugins.settings.version', { version: plugin.version })}</span>}
        </p>
        <p className="hint">{t('plugins.accept.intro')}</p>
        {network && (
          <p className="pl-warn strong" role="alert">
            <span aria-hidden="true">⚠ </span>
            {t('plugins.accept.networkWarning')}
          </p>
        )}
        {writes && (
          <p className="pl-warn" role="note">
            <span aria-hidden="true">⚠ </span>
            {t('plugins.accept.writeWarning')}
          </p>
        )}
        <div className="field">
          <span className="lbl">{t('plugins.accept.command')}</span>
          <pre className="deliv-prompt mono iso pl-cmd">{commandText(plugin.command ?? [])}</pre>
          <span className="hint">{t('plugins.settings.revealHint')}</span>
        </div>
        <div className="field">
          <span className="lbl">{t('plugins.settings.files')}</span>
          <Files files={plugin.files} />
        </div>
        {config !== null && (
          <div className="field">
            <span className="lbl">{t('plugins.settings.config')}</span>
            <pre className="deliv-prompt mono iso pl-config">{config}</pre>
          </div>
        )}
        <div className="field">
          <span className="lbl">{t('plugins.accept.permissions')}</span>
          <Permissions list={plugin.permissions} />
        </div>
        <div className="field">
          <span className="lbl">{t('plugins.accept.fingerprint')}</span>
          <code className="mono pl-fp-full">{fp}</code>
        </div>
        {error && (
          <p className="inline-err" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="mf">
        <button type="button" className="btn pri" disabled={busy} onClick={() => void accept()}>
          {busy ? t('plugins.accept.busy') : t('plugins.accept.confirm')}
        </button>
        <button type="button" ref={cancel} className="btn ghost" disabled={busy} onClick={onClose}>
          {t('plugins.accept.cancel')}
        </button>
      </div>
    </section>
  )
}

function PluginCard({ plugin, accepted, onAccept }: { plugin: PluginInfo; accepted: Record<string, string>; onAccept: () => void }) {
  const { t, locale } = useI18n()
  const id = useId()
  const [revoking, setRevoking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const state = pluginState(plugin, accepted)
  const label = localized(plugin.label, locale)
  const description = localized(plugin.description, locale)
  const tab = localized(plugin.tab?.label, locale)
  const failed = plugin.process?.state === 'failed'
  const stderr = failed ? stderrTail(plugin.process.stderr_tail) : null
  const revocable = plugin.acceptance !== 'none' || Object.prototype.hasOwnProperty.call(accepted, plugin.name)

  async function revoke() {
    setRevoking(true)
    setError(null)
    try {
      const r = (await api.revokePlugin?.({ name: plugin.name })) ?? null
      if (r && r.ok) void reloadPlugins()
      else setError(t('plugins.settings.revokeError', { error: r ? describeError(r.error.code, r.error.message, r.error.data) : t('errors.methodNotFound') }))
    } catch (e) {
      setError(t('plugins.settings.revokeError', { error: (e as Error).message }))
    }
    setRevoking(false)
  }

  return (
    <li className="pl-card" aria-labelledby={`${id}-h`}>
      <div className="pl-head">
        <h3 id={`${id}-h`} className="iso">
          {label ?? revealInvisible(plugin.name)}
        </h3>
        <span className="hint iso">{t('plugins.settings.name', { name: revealInvisible(plugin.name) })}</span>
        {plugin.version && <span className="hint">{t('plugins.settings.version', { version: plugin.version })}</span>}
        <span className={`chip ${STATE_CHIP[state]}`}>{t('plugins.settings.state', { state: t(STATE_KEYS[state]) })}</span>
        {failed && <span className="chip bad">{t('plugins.state.failed')}</span>}
        {plugin.process?.state === 'running' && <span className="chip">{t('plugins.state.running')}</span>}
      </div>
      {description && <p className="iso pl-desc">{description}</p>}
      {tab && <p className="hint">{t('plugins.settings.tabContrib', { label: tab })}</p>}
      {!plugin.valid && plugin.errors.length > 0 && (
        <div className="field">
          <span className="lbl">{t('plugins.settings.errors')}</span>
          <ManifestErrors errors={plugin.errors} />
        </div>
      )}
      {failed && (
        <div className="field" role="note">
          <span className="inline-err">{t('plugins.settings.failure', { reason: t(reasonKey(plugin.process.reason)) })}</span>
          {plugin.process.message && <span className="hint iso">{t('plugins.settings.failureMessage', { message: daemonText(plugin.process.message) })}</span>}
          {stderr && (
            <>
              <span className="hint">{t('plugins.settings.stderr')}</span>
              <pre className="deliv-prompt mono pd-stderr">{stderr}</pre>
            </>
          )}
        </div>
      )}
      {plugin.command && (
        <div className="field">
          <span className="lbl">{t('plugins.settings.command')}</span>
          <code className="mono iso pl-cmd">{commandText(plugin.command)}</code>
        </div>
      )}
      {plugin.valid && (
        <div className="field">
          <span className="lbl">{t('plugins.settings.files')}</span>
          <Files files={plugin.files} />
        </div>
      )}
      {plugin.valid && configText(plugin.config) !== null && (
        <div className="field">
          <span className="lbl">{t('plugins.settings.config')}</span>
          <pre className="deliv-prompt mono iso pl-config">{configText(plugin.config)}</pre>
        </div>
      )}
      {plugin.valid && (
        <div className="field">
          <span className="lbl">{t('plugins.settings.permissions')}</span>
          <Permissions list={plugin.permissions} />
        </div>
      )}
      {plugin.fingerprint && (
        <div className="field">
          <span className="lbl">{t('plugins.settings.fingerprint')}</span>
          <Fingerprint value={plugin.fingerprint} />
        </div>
      )}
      <div className="pl-actions">
        {plugin.valid && plugin.fingerprint && state !== 'active' && (
          <button type="button" className="btn sm pri" onClick={onAccept}>
            {state === 'changed' ? t('plugins.settings.acceptAgain') : t('plugins.settings.accept')}
          </button>
        )}
        {revocable && (
          <button type="button" className="btn sm danger" disabled={revoking} onClick={() => void revoke()}>
            {revoking ? t('plugins.settings.revoking') : t('plugins.settings.revoke')}
          </button>
        )}
      </div>
      {error && (
        <p className="inline-err" role="alert">
          {error}
        </p>
      )}
    </li>
  )
}

export function PluginSettings() {
  const { t } = useI18n()
  const s = usePlugins()
  const [accepting, setAccepting] = useState<string | null>(null)
  useEffect(() => {
    void reloadPlugins()
  }, [])
  const target = accepting ? s.plugins.find((p) => p.name === accepting && p.valid && p.fingerprint) : undefined
  if (target) return <AcceptConfirm key={`${target.name}:${target.fingerprint}`} plugin={target} onClose={() => setAccepting(null)} />
  return (
    <>
      <div className="mb">
        <div className="field">
          <span className="lbl">{t('plugins.settings.title')}</span>
          <span className="hint">{t('plugins.settings.intro')}</span>
          {s.dir && <span className="hint">{t('plugins.settings.dir', { dir: s.dir })}</span>}
          <span className="hint">{t('plugins.settings.thirdParty')}</span>
        </div>
        {s.status === 'loading' && <p className="hint">{t('plugins.settings.loading')}</p>}
        {s.status === 'error' && (
          <p className="inline-err" role="alert">
            {t('plugins.settings.loadError', { error: s.error ?? '' })}
          </p>
        )}
        {s.status === 'ready' && s.plugins.length === 0 && <p className="hint">{t('plugins.settings.empty')}</p>}
        {s.plugins.length > 0 && (
          <ul className="pl-list" aria-label={t('plugins.settings.listLabel')}>
            {s.plugins.map((p) => (
              <PluginCard key={p.name} plugin={p} accepted={s.accepted} onAccept={() => setAccepting(p.name)} />
            ))}
          </ul>
        )}
      </div>
      <div className="mf">
        <button type="button" className="btn sm ghost" onClick={() => void reloadPlugins()}>
          {t('plugins.settings.reload')}
        </button>
      </div>
    </>
  )
}
