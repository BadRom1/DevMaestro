/**
 * Fenêtre « Réglages » (maquette) : Apparence (mode, puis palette, couleurs et
 * aperçu propres au mode clair et au mode sombre) et Général (notifications, confirmations, libellés des
 * profils, profil par défaut par projet) et Consignes (textes tapés dans les
 * sessions, lot 18). Les modifications s'appliquent tout
 * de suite et sont enregistrées par le processus principal.
 */
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react'

import { LANGUAGE_PREFS, type LanguagePref, type PlainKey } from '../../../shared/i18n'
import type { Profile } from '../../../shared/protocol'
import {
  DEFAULT_ZOOM,
  MAX_LONG_LABEL,
  MAX_SHORT_LABEL,
  MAX_THEME_IMPORT,
  PALETTE_NAMES,
  SCHEMES,
  SESSION_TABS,
  THEME_TOKENS,
  ZOOM_STEPS,
  checkProfileLabel,
  parseThemeImport,
  profileLabel,
  stepZoom,
  type SchemeTheme,
  type SessionTab,
  type ThemeImport,
  type ThemeMode,
  type ThemeToken,
} from '../../../shared/settings'
import {
  DEFAULT_WORKTREE_LOCATIONS,
  LOCATION_LABELS,
  MAX_BRANCH_PREFIX,
  branchFromName,
  branchPrefixProblem,
  type DefaultWorktreeLocation,
} from '../../../shared/worktrees'
import type { DeliveryMode } from '../../../shared/protocol'
import type { ProjectDelivery } from '../../../shared/settings'
import { api } from '../api'
import { useI18n, useT } from '../i18n'
import { useSettings } from '../settings'
import type { ProjectChoice } from '../state/newSession'
import { BASE, PALETTES, TOKEN_LABELS, paletteValue, schemeTokens, themeJson, tokenValue, type Scheme } from '../state/themeTokens'
import { tildify } from '../state/format'
import { Meter, ProfileBadge, StatusGlyph } from './common'
import { ConfirmBar } from './ForgetConfirm'
import { Modal } from './Modal'
import { PluginSettings } from './PluginSettings'
import { PromptSettings } from './PromptSettings'
import { THEMES, autoTitle } from './TopBar'

type Tab = 'apparence' | 'general' | 'consignes' | 'plugins'

const PREVIEW_GLYPHS = [
  { kind: 'waiting', key: 'common.status.waiting' },
  { kind: 'running', key: 'common.status.running' },
  { kind: 'idle', key: 'common.status.idle' },
  { kind: 'stopped', key: 'common.status.stopped' },
  { kind: 'error', key: 'common.status.error' },
] as const satisfies readonly { kind: string; key: PlainKey }[]

/** Nom d'un mode dans une phrase (« mode clair »). */
const SCHEME_INLINE: Record<Scheme, PlainKey> = { light: 'settings.scheme.light.inline', dark: 'settings.scheme.dark.inline' }
/** Titre d'un mode (« Mode clair »). */
const SCHEME_TITLE: Record<Scheme, PlainKey> = { light: 'settings.scheme.light.title', dark: 'settings.scheme.dark.title' }

/** Aperçu d'un mode (glyphes, diff, jauges, boutons) avec ses jetons, quel que soit le mode affiché. */
function ThemePreview({ tokens, label }: { tokens: Record<string, string>; label: string }) {
  const t = useT()
  const style = Object.fromEntries(Object.entries(tokens).map(([k, v]) => [`--${k}`, v])) as CSSProperties
  return (
    <div className="preview" style={style} aria-label={label} role="group">
      <div className="row">
        {PREVIEW_GLYPHS.map((g) => {
          const glyph = { kind: g.kind, label: t(g.key) }
          return (
            <span key={g.kind} className="pv">
              <StatusGlyph glyph={glyph} /> {glyph.label}
            </span>
          )
        })}
      </div>
      <div className="diff" aria-hidden="true">
        {/* i18n-exempt: extrait de code d'exemple (décoratif) */}
        <div className="del">− token := r.URL.Query().Get("code")</div>
        {/* i18n-exempt: extrait de code d'exemple (décoratif) */}
        <div className="add">+ code, err := parseCode(r, sessions)</div>
      </div>
      <div className="row">
        <span className="pv">
          <Meter pct={45} label={t('settings.preview.meter', { pct: 45 })} /> {t('settings.preview.pct', { pct: 45 })}
        </span>
        <span className="pv">
          <Meter pct={80} label={t('settings.preview.meter', { pct: 80 })} /> {t('settings.preview.pct', { pct: 80 })}
        </span>
        <span className="pv">
          <Meter pct={95} label={t('settings.preview.meter', { pct: 95 })} /> {t('settings.preview.pct', { pct: 95 })}
        </span>
      </div>
      <div className="row">
        <span className="chip pend">{t('settings.preview.maybeStale')}</span>
        <span className="chip bad">{t('settings.preview.folderDeleted')}</span>
        <button type="button" className="btn pri sm" tabIndex={-1}>
          {t('settings.preview.primaryButton')}
        </button>
      </div>
    </div>
  )
}

/** Bloc d'un mode affiché (clair ou sombre) : sa palette, ses couleurs et son aperçu. */
function SchemeBlock({ target, active, followsSystem }: { target: Scheme; active: boolean; followsSystem: boolean }) {
  const { settings, update } = useSettings()
  const t = useT()
  const own = settings.theme[target]
  const id = useId()
  const custom = own.custom
  const customCount = Object.keys(custom).length
  const modeName = t(SCHEME_INLINE[target])

  function setColor(token: ThemeToken, value: string | null) {
    const next = { ...custom }
    // Une couleur égale à celle de la palette n'est pas une personnalisation.
    if (value === null || value.toLowerCase() === paletteValue(own.palette, target, token).toLowerCase()) delete next[token]
    else next[token] = value.toLowerCase()
    update({ theme: { [target]: { ...own, custom: next } } })
  }

  return (
    <section className={`scheme-block${active ? ' on' : ''}`} aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`}>
        {t(SCHEME_TITLE[target])}
        {active && <span className="chip">{followsSystem ? t('settings.scheme.shownSystem') : t('settings.scheme.shown')}</span>}
      </h3>
      <div className="field">
        <span className="lbl" id={`${id}-pal`}>
          {t('settings.scheme.palette')}
        </span>
        <div className="presets" role="group" aria-labelledby={`${id}-pal`}>
          {PALETTE_NAMES.map((name) => {
            const p = PALETTES[name]
            const values = { ...BASE[target], ...p[target] }
            return (
              <button
                key={name}
                type="button"
                className="preset"
                aria-pressed={own.palette === name}
                onClick={() => update({ theme: { [target]: { ...own, palette: name } } })}
              >
                <b>{p.name}</b>
                <span className="sw" aria-hidden="true">
                  {/* i18n-exempt: identifiants de jetons de couleur */}
                  {(['accent', 'wait', 'run', 'done', 'err'] as const).map((k) => (
                    <i key={k} style={{ background: values[k] }} />
                  ))}
                </span>
                <small>{p.description}</small>
              </button>
            )
          })}
        </div>
      </div>
      <div className="field">
        <span className="lbl" id={`${id}-colors`}>
          {t('settings.scheme.colors')}
          {customCount > 0 && (
            <span className="hint">
              {' '}
              {t('settings.scheme.customCount', { count: customCount })}
            </span>
          )}
        </span>
        <div className="colors" role="group" aria-labelledby={`${id}-colors`}>
          {THEME_TOKENS.map((tok) => {
            const v = tokenValue(settings.theme, target, tok)
            return (
              <div className="crow" key={tok}>
                <input
                  type="color"
                  value={v}
                  aria-label={t('settings.scheme.colorLabel', { token: TOKEN_LABELS[tok], mode: modeName })}
                  onChange={(e) => setColor(tok, e.target.value)}
                />
                <span className="nm">{TOKEN_LABELS[tok]}</span>
                <span className="hex">{v}</span>
                {custom[tok] && (
                  <button
                    type="button"
                    className="btn sm ghost"
                    aria-label={t('settings.scheme.colorReset', { token: TOKEN_LABELS[tok], mode: modeName })}
                    title={t('settings.scheme.colorResetTitle')}
                    onClick={() => setColor(tok, null)}
                  >
                    ↺
                  </button>
                )}
              </div>
            )
          })}
        </div>
        <div>
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => update({ theme: { [target]: { ...own, custom: {} } } })}
            disabled={customCount === 0}
          >
            {t('settings.scheme.resetColors', { mode: modeName })}
          </button>
        </div>
      </div>
      <ThemePreview tokens={schemeTokens(settings.theme, target)} label={t('settings.scheme.preview', { mode: modeName })} />
    </section>
  )
}

/** « Taille du texte » : toute l'interface, terminal compris (zoom appliqué par le processus principal). */
function TextSize() {
  const { settings, update } = useSettings()
  const { t, rich } = useI18n()
  const zoom = settings.ui.zoom
  const set = (z: number) => update({ ui: { zoom: z } })
  return (
    <div className="field">
      <label className="lbl" htmlFor="st-zoom">
        {t('settings.zoom.label')}
      </label>
      <div className="row-inline">
        <div className="zoomctl">
          <button
            type="button"
            className="btn"
            aria-label={t('settings.zoom.smaller')}
            disabled={zoom === ZOOM_STEPS[0]}
            onClick={() => set(stepZoom(zoom, 'out'))}
          >
            −
          </button>
          <select id="st-zoom" value={zoom} onChange={(e) => set(Number(e.target.value))}>
            {ZOOM_STEPS.map((z) => (
              <option key={z} value={z}>
                {z === DEFAULT_ZOOM ? t('settings.zoom.optionDefault', { zoom: z }) : t('settings.zoom.option', { zoom: z })}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn"
            aria-label={t('settings.zoom.larger')}
            disabled={zoom === ZOOM_STEPS[ZOOM_STEPS.length - 1]}
            onClick={() => set(stepZoom(zoom, 'in'))}
          >
            +
          </button>
        </div>
        <span className="hint">
          {rich('settings.zoom.hint', {
            ctrl: <kbd>{t('settings.zoom.ctrl')}</kbd>,
            plus: <kbd>+</kbd>,
            minus: <kbd>−</kbd>,
            zero: <kbd>0</kbd>,
          })}
        </span>
      </div>
    </div>
  )
}

const SESSION_TAB_LABELS: Record<SessionTab, PlainKey> = { terminal: 'settings.sessionTab.terminal', conversation: 'settings.sessionTab.conversation' }

/** « Onglet par défaut d'une session » : celui ouvert en arrivant sur une session. */
function SessionTabField() {
  const { settings, update } = useSettings()
  const t = useT()
  return (
    <div className="field">
      <label className="lbl" htmlFor="st-session-tab">
        {t('settings.sessionTab.label')}
      </label>
      <div className="row-inline">
        <select
          id="st-session-tab"
          value={settings.ui.sessionTab}
          onChange={(e) => update({ ui: { sessionTab: e.target.value as SessionTab } })}
        >
          {SESSION_TABS.map((tab) => (
            <option key={tab} value={tab}>
              {t(SESSION_TAB_LABELS[tab])}
            </option>
          ))}
        </select>
        <span className="hint">{t('settings.sessionTab.hint')}</span>
      </div>
    </div>
  )
}

type Parsed = { ok: true; theme: ThemeImport } | { ok: false; error: string } | null

/**
 * « Importer un thème (JSON) » : texte collé ou fichier choisi, validé comme
 * une modification des réglages (ancien format à palette unique accepté),
 * aperçu des deux modes, puis « Appliquer ».
 */
function ThemeImportPanel({ onDone, onCancel }: { onDone: (message: string) => void; onCancel: () => void }) {
  const { settings, update } = useSettings()
  const t = useT()
  const [text, setText] = useState('')
  const [fileError, setFileError] = useState<string | null>(null)
  /** « Abandonner le JSON saisi ? » affiché (Échap ou Annuler avec un texte non appliqué). */
  const [confirmDrop, setConfirmDrop] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  const box = useRef<HTMLElement>(null)
  const id = useId()
  const parsed: Parsed = useMemo(() => {
    if (text.trim() === '') return null
    try {
      return { ok: true, theme: parseThemeImport(text) }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  }, [text])

  // Corps en bloc : `scrollIntoView` renvoie une promesse dans Chromium récent, et un effet ne doit
  // renvoyer qu'une fonction de nettoyage (sinon React plante au démontage : écran blanc).
  useEffect(() => {
    void box.current?.scrollIntoView?.({ block: 'nearest' })
  }, [])

  async function readFile(f: File | undefined) {
    setFileError(null)
    if (!f) return
    if (f.size > MAX_THEME_IMPORT) {
      setFileError(t('settings.import.fileTooBig', { kib: Math.round(MAX_THEME_IMPORT / 1024) }))
      return
    }
    try {
      setText(await f.text())
    } catch (e) {
      setFileError(t('settings.import.readFailed', { error: (e as Error).message }))
    }
  }

  const error = fileError ?? (parsed && !parsed.ok ? t('settings.import.rejected', { error: parsed.error }) : null)
  const theme = parsed?.ok ? parsed.theme : null
  const pair: Record<'light' | 'dark', SchemeTheme> | null = theme ? { light: theme.light, dark: theme.dark } : null

  /** Fermer le panneau : sans perdre de JSON saisi sans confirmation. */
  function cancel() {
    if (text.trim() === '') onCancel()
    else setConfirmDrop(true)
  }

  return (
    <section
      className="import-box"
      ref={box}
      aria-labelledby={`${id}-h`}
      // Échap ferme d'abord ce panneau (ou la confirmation), pas les Réglages.
      data-own-escape=""
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.preventDefault()
        e.stopPropagation()
        if (confirmDrop) setConfirmDrop(false)
        else cancel()
      }}
    >
      <h3 id={`${id}-h`}>{t('settings.import.title')}</h3>
      <label className="field">
        <span className="lbl">{t('settings.import.json')}</span>
        <textarea
          autoFocus
          value={text}
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-st`}
          // i18n-exempt: exemple de JSON (format technique)
          placeholder={'{ "mode": "system", "light": { "palette": "okabe", "custom": {} }, "dark": { … } }'}
          onChange={(e) => {
            setFileError(null)
            setText(e.target.value)
          }}
        />
      </label>
      <div className="row-inline">
        <button type="button" className="btn sm" onClick={() => file.current?.click()}>
          {t('settings.import.chooseFile')}
        </button>
        <input
          ref={file}
          type="file"
          accept=".json,application/json"
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            void readFile(e.target.files?.[0])
            e.target.value = ''
          }}
        />
        <span className="hint">{t('settings.import.formatHint')}</span>
      </div>
      <p id={`${id}-st`} className={error ? 'inline-err' : 'hint'} role="status">
        {error ?? (theme ? (theme.mode ? t('settings.import.valid') : t('settings.import.validKeepMode')) : t('settings.import.empty'))}
      </p>
      {pair && (
        <div className="schemes">
          {SCHEMES.map((sc) => (
            <ThemePreview key={sc} tokens={schemeTokens(pair, sc)} label={t('settings.import.preview', { mode: t(SCHEME_INLINE[sc]) })} />
          ))}
        </div>
      )}
      <div className="row-inline">
        <button
          type="button"
          className="btn pri"
          disabled={!theme}
          onClick={() => {
            if (!theme) return
            update({ theme: { mode: theme.mode ?? settings.theme.mode, light: theme.light, dark: theme.dark } })
            onDone(t('settings.import.done'))
          }}
        >
          {t('settings.import.apply')}
        </button>
        <button type="button" className="btn ghost" onClick={cancel}>
          {t('settings.import.cancel')}
        </button>
      </div>
      {confirmDrop && (
        <ConfirmBar
          message={t('settings.import.dropMessage')}
          confirmLabel={t('settings.import.drop')}
          busyLabel={t('settings.import.dropping')}
          errorPrefix={t('settings.import.dropFailed')}
          onConfirm={async () => onCancel()}
          onCancel={() => setConfirmDrop(false)}
        />
      )}
    </section>
  )
}

function Appearance({ scheme }: { scheme: Scheme }) {
  const { settings, update } = useSettings()
  const t = useT()
  const theme = settings.theme
  const [copied, setCopied] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const importBtn = useRef<HTMLButtonElement>(null)

  async function copy() {
    const ok = await api.copyText(themeJson(theme)).catch(() => false)
    setCopied(ok ? t('settings.appearance.copied') : t('settings.appearance.copyFailed'))
  }

  function closeImport(message: string | null) {
    setImporting(false)
    if (message) setCopied(message)
    importBtn.current?.focus()
  }

  return (
    <>
      <div className="mb">
        {importing && <ThemeImportPanel onDone={(m) => closeImport(m)} onCancel={() => closeImport(null)} />}
        <TextSize />
        <SessionTabField />
        <div className="field">
          <span className="lbl" id="st-mode">
            {t('settings.appearance.mode')}
          </span>
          <div className="row-inline">
            <div className="seg" role="group" aria-labelledby="st-mode">
              {THEMES.map(([m, l]) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={theme.mode === m}
                  title={m === 'system' ? autoTitle() : undefined}
                  onClick={() => update({ theme: { mode: m } })}
                >
                  {l}
                </button>
              ))}
            </div>
            <span className="hint">
              {theme.mode === 'system'
                ? t('settings.appearance.modeHintSystem', { mode: t(SCHEME_INLINE[scheme]) })
                : t('settings.appearance.modeHint')}
            </span>
          </div>
        </div>
        <div className="schemes">
          {SCHEMES.map((s) => (
            <SchemeBlock key={s} target={s} active={s === scheme} followsSystem={theme.mode === 'system'} />
          ))}
        </div>
        <p className="callout">{t('settings.appearance.callout')}</p>
      </div>
      <div className="mf">
        <span className="hint" role="status" style={{ marginRight: 'auto' }}>
          {copied ?? t('settings.footer')}
        </span>
        <button
          type="button"
          className="btn"
          ref={importBtn}
          aria-expanded={importing}
          onClick={() => {
            setCopied(null)
            setImporting((v) => !v)
          }}
        >
          {t('settings.appearance.import')}
        </button>
        <button type="button" className="btn" onClick={() => void copy()}>
          {t('settings.appearance.copy')}
        </button>
      </div>
    </>
  )
}

function LabelRow({ profile, profiles }: { profile: Profile; profiles: Profile[] }) {
  const { settings, update } = useSettings()
  const t = useT()
  const current = profileLabel(profile.name, settings.profileLabels)
  const custom = settings.profileLabels[profile.name]
  const [long, setLong] = useState(current.long)
  const [short, setShort] = useState(current.short)
  const [error, setError] = useState<string | null>(null)
  const id = useId()

  function commit(nextLong: string, nextShort: string) {
    const c = checkProfileLabel({ long: nextLong, short: nextShort })
    if (typeof c === 'string') {
      setError(c)
      return
    }
    setError(null)
    update({ profileLabels: { [profile.name]: c } })
  }

  return (
    <div className="lrow">
      <ProfileBadge profile={profile.name} profiles={profiles} />
      <span className="mono tech" title={profile.config_dir}>
        {profile.name}
      </span>
      <label className="field">
        <span className="sr-only">{t('settings.label.long', { profile: profile.name })}</span>
        <input
          value={long}
          maxLength={MAX_LONG_LABEL * 2}
          aria-describedby={error ? `${id}-err` : undefined}
          aria-invalid={error ? true : undefined}
          onChange={(e) => {
            setLong(e.target.value)
            commit(e.target.value, short)
          }}
          placeholder={t('settings.label.placeholder')}
        />
      </label>
      <label className="field short">
        <span className="sr-only">{t('settings.label.short', { profile: profile.name })}</span>
        <input
          value={short}
          aria-invalid={error ? true : undefined}
          onChange={(e) => {
            const v = [...e.target.value].slice(0, MAX_SHORT_LABEL).join('')
            setShort(v)
            commit(long, v)
          }}
          placeholder="P"
        />
      </label>
      <button
        type="button"
        className="btn sm ghost"
        disabled={!custom}
        title={t('settings.label.resetTitle')}
        onClick={() => {
          const d = profileLabel(profile.name, {})
          setLong(d.long)
          setShort(d.short)
          setError(null)
          update({ profileLabels: { [profile.name]: null } })
        }}
      >
        {t('settings.label.reset')}
      </button>
      {error && (
        <span id={`${id}-err`} className="inline-err" role="alert">
          {error}
        </span>
      )}
    </div>
  )
}

/** Forme du chemin d'un worktree selon l'emplacement (langue de l'interface). */
function locationHint(l: DefaultWorktreeLocation, t: (key: PlainKey) => string): string {
  if (l === 'sibling') return t('settings.worktrees.hintSibling')
  if (l === 'in_repo') return t('settings.worktrees.hintInRepo')
  return '~/.local/share/devmaestro/worktrees/…'
}

function Worktrees({ projects, home }: { projects: ProjectChoice[]; home: string | null }) {
  const { settings, update } = useSettings()
  const t = useT()
  const w = settings.worktrees
  const [prefix, setPrefix] = useState(w.branchPrefix)
  const [prefixError, setPrefixError] = useState<string | null>(null)
  const id = useId()
  const repos = projects.filter((c) => c.isGit)
  return (
    <div className="field">
      <span className="lbl">{t('settings.worktrees.title')}</span>
      <span className="hint">{t('settings.worktrees.hint')}</span>
      <label className="wtrow">
        <span>{t('settings.worktrees.location')}</span>
        <select
          value={w.location}
          onChange={(e) => update({ worktrees: { location: e.target.value as DefaultWorktreeLocation } })}
          aria-describedby={`${id}-loc`}
        >
          {DEFAULT_WORKTREE_LOCATIONS.map((l) => (
            <option key={l} value={l}>
              {LOCATION_LABELS[l]}
            </option>
          ))}
        </select>
        <span id={`${id}-loc`} className="hint mono">
          {locationHint(w.location, t)}
        </span>
      </label>
      <label className="wtrow">
        <span>{t('settings.worktrees.prefix')}</span>
        <input
          className="mono"
          value={prefix}
          maxLength={MAX_BRANCH_PREFIX}
          spellCheck={false}
          placeholder={t('settings.worktrees.prefixPlaceholder')}
          aria-invalid={prefixError ? true : undefined}
          aria-describedby={`${id}-pre`}
          onChange={(e) => {
            const v = e.target.value
            setPrefix(v)
            const problem = branchPrefixProblem(v)
            setPrefixError(problem)
            if (!problem) update({ worktrees: { branchPrefix: v } })
          }}
        />
        <span id={`${id}-pre`} className={prefixError ? 'inline-err' : 'hint mono'} role={prefixError ? 'alert' : undefined}>
          {prefixError ?? t('settings.worktrees.example', { branch: branchFromName(t('settings.worktrees.sampleName'), prefix || '') })}
        </span>
      </label>
      <label className="optrow">
        <input
          type="checkbox"
          checked={w.notifyIntegrated}
          onChange={(e) => update({ worktrees: { notifyIntegrated: e.target.checked } })}
        />
        <span>
          {t('settings.worktrees.notify')}
          <span className="hint optaide">{t('settings.worktrees.notifyHint')}</span>
        </span>
      </label>
      {repos.length > 0 && (
        <>
          <span className="hint">{t('settings.worktrees.perProject')}</span>
          <div className="pprofiles">
            {repos.map((c) => {
              const set = w.projectLocations[c.profileKey] ?? ''
              return (
                <label key={c.key} className="pprow">
                  <span className="nm" title={c.root}>
                    <b>{c.name}</b> <span className="hint mono">{tildify(c.root, home)}</span>
                  </span>
                  <select
                    value={set}
                    aria-label={t('settings.worktrees.projectLabel', { name: c.name })}
                    onChange={(e) =>
                      update({
                        worktrees: {
                          projectLocations: { [c.profileKey]: (e.target.value || null) as DefaultWorktreeLocation | null },
                        },
                      })
                    }
                  >
                    <option value="">{t('settings.worktrees.projectDefault', { location: LOCATION_LABELS[w.location] })}</option>
                    {DEFAULT_WORKTREE_LOCATIONS.map((l) => (
                      <option key={l} value={l}>
                        {LOCATION_LABELS[l]}
                      </option>
                    ))}
                  </select>
                </label>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

const MODE_LABELS: Record<DeliveryMode, PlainKey> = { pr: 'settings.delivery.mode.pr', trunk: 'settings.delivery.mode.trunk' }

function Delivery({ projects, home }: { projects: ProjectChoice[]; home: string | null }) {
  const { settings, update } = useSettings()
  const t = useT()
  const d = settings.delivery
  const repos = projects.filter((c) => c.isGit)
  const setProject = (key: string, next: ProjectDelivery) => update({ delivery: { projects: { [key]: next } } })
  return (
    <div className="field">
      <span className="lbl">{t('settings.delivery.title')}</span>
      <span className="hint">{t('settings.delivery.hint')}</span>
      <label className="optrow">
        <input
          type="checkbox"
          checked={d.notifyCiFailure}
          onChange={(e) => update({ delivery: { notifyCiFailure: e.target.checked } })}
        />
        <span>
          {t('settings.delivery.notifyCi')}
          <span className="hint optaide">{t('settings.delivery.notifyCiHint')}</span>
        </span>
      </label>
      {repos.length > 0 && (
        <>
          <span className="hint">{t('settings.delivery.perProject')}</span>
          <div className="pprofiles">
            {repos.map((c) => {
              // i18n-exempt: identifiant de mode
              const p: ProjectDelivery = d.projects[c.profileKey] ?? { mode: 'pr' }
              return (
                <div key={c.key} className="deliv-proj">
                  <label className="pprow">
                    <span className="nm" title={c.root}>
                      <b>{c.name}</b> <span className="hint mono">{tildify(c.root, home)}</span>
                    </span>
                    <select
                      value={p.mode}
                      aria-label={t('settings.delivery.projectLabel', { name: c.name })}
                      onChange={(e) => setProject(c.profileKey, { ...p, mode: e.target.value as DeliveryMode })}
                    >
                      {/* i18n-exempt: identifiants de modes */}
                      {(['pr', 'trunk'] as const).map((m) => (
                        <option key={m} value={m}>
                          {t(MODE_LABELS[m])}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

function General({ profiles, projects, home }: { profiles: Profile[]; projects: ProjectChoice[]; home: string | null }) {
  const { settings, update, label } = useSettings()
  const t = useT()
  return (
    <>
      <div className="mb">
        <LanguageField />
        <div className="field">
          <span className="lbl">{t('settings.notifications.title')}</span>
          <label className="optrow">
            <input
              type="checkbox"
              checked={settings.notifications.enabled}
              onChange={(e) => update({ notifications: { enabled: e.target.checked } })}
            />
            <span>
              {t('settings.notifications.waiting')}
              <span className="hint optaide">{t('settings.notifications.waitingHint')}</span>
            </span>
          </label>
        </div>
        <div className="field">
          <span className="lbl">{t('settings.confirmations.title')}</span>
          <label className="optrow">
            <input type="checkbox" checked={settings.confirmRemoval} onChange={(e) => update({ confirmRemoval: e.target.checked })} />
            <span>{t('settings.confirmations.removal')}</span>
          </label>
        </div>
        <div className="field">
          <span className="lbl">{t('settings.forges.title')}</span>
          <label className="optrow">
            <input
              type="checkbox"
              checked={settings.forges.enabled}
              onChange={(e) => update({ forges: { enabled: e.target.checked } })}
            />
            <span>
              {t('settings.forges.read')}
              <span className="hint optaide">{t('settings.forges.readHint')}</span>
            </span>
          </label>
        </div>
        <div className="field">
          <span className="lbl">{t('settings.profiles.title')}</span>
          <span className="hint">{t('settings.profiles.hint')}</span>
          {profiles.length === 0 && <p className="hint">{t('settings.profiles.none')}</p>}
          {profiles.map((p) => (
            <LabelRow key={p.name} profile={p} profiles={profiles} />
          ))}
        </div>
        <div className="field">
          <span className="lbl">{t('settings.projectProfiles.title')}</span>
          <span className="hint">{t('settings.projectProfiles.hint')}</span>
          {projects.length === 0 && <p className="hint">{t('settings.projectProfiles.none')}</p>}
          <div className="pprofiles">
            {projects.map((c) => {
              const set = settings.projectProfiles[c.profileKey] ?? ''
              return (
                <label key={c.key} className="pprow">
                  <span className="nm" title={c.root}>
                    <b>{c.name}</b> <span className="hint mono">{tildify(c.root, home)}</span>
                  </span>
                  <select
                    value={set}
                    aria-label={t('settings.projectProfiles.label', { name: c.name })}
                    onChange={(e) => update({ projectProfiles: { [c.profileKey]: e.target.value || null } })}
                  >
                    <option value="">{t('settings.projectProfiles.auto')}</option>
                    {profiles.map((p) => (
                      <option key={p.name} value={p.name}>
                        {label(p.name).long}
                      </option>
                    ))}
                    {set && !profiles.some((p) => p.name === set) && <option value={set}>{t('settings.projectProfiles.unknown', { profile: set })}</option>}
                  </select>
                </label>
              )
            })}
          </div>
        </div>
        <Worktrees projects={projects} home={home} />
        <Delivery projects={projects} home={home} />
      </div>
      <div className="mf">
        <span className="hint">{t('settings.footer')}</span>
      </div>
    </>
  )
}

const LANGUAGE_LABELS: Record<LanguagePref, PlainKey> = {
  system: 'common.language.system',
  fr: 'common.language.fr',
  en: 'common.language.en',
}

/** « Langue » : Système, Français ou English (les noms des langues restent dans leur propre langue) ; appliquée à chaud. */
function LanguageField() {
  const { settings, update } = useSettings()
  const t = useT()
  return (
    <div className="field">
      <label className="lbl" htmlFor="st-language">
        {t('settings.language.label')}
      </label>
      <div className="row-inline">
        <select
          id="st-language"
          value={settings.ui.language}
          onChange={(e) => update({ ui: { language: e.target.value as LanguagePref } })}
        >
          {LANGUAGE_PREFS.map((l) => (
            <option key={l} value={l}>
              {t(LANGUAGE_LABELS[l])}
            </option>
          ))}
        </select>
      </div>
    </div>
  )
}

export function SettingsDialog({
  profiles,
  projects,
  home,
  scheme,
  plugins = false,
  onClose,
}: {
  profiles: Profile[]
  projects: ProjectChoice[]
  home: string | null
  scheme: Scheme
  /** Le démon annonce la capacité `plugins` (lot 22a) : onglet « Plugins ». */
  plugins?: boolean
  onClose: () => void
}) {
  const [tab, setTab] = useState<Tab>('apparence')
  const { saveError } = useSettings()
  const t = useT()
  const id = useId()
  const tabs: [Tab, string][] = [
    ['apparence', t('settings.tab.appearance')],
    ['general', t('settings.tab.general')],
    ['consignes', t('settings.tab.prompts')],
    ...(plugins ? ([['plugins', t('plugins.settings.tab')]] as [Tab, string][]) : []),
  ]
  // Capacité perdue (démon remplacé) pendant que l'onglet est ouvert : retour aux consignes.
  const shown: Tab = tab === 'plugins' && !plugins ? 'consignes' : tab
  return (
    <Modal title={t('settings.title')} onClose={onClose} width={780}>
      <div className="stabs" role="tablist" aria-label={t('settings.tabsLabel')}>
        {tabs.map(([k, l]) => (
          <button
            key={k}
            type="button"
            role="tab"
            id={`${id}-${k}`}
            aria-selected={shown === k}
            aria-controls={`${id}-panel`}
            tabIndex={shown === k ? 0 : -1}
            onClick={() => setTab(k)}
            onKeyDown={(e) => {
              if (['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) {
                e.preventDefault()
                const i = tabs.findIndex(([k]) => k === shown)
                const j =
                  e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length
                const next: Tab = tabs[j]![0]
                setTab(next)
                document.getElementById(`${id}-${next}`)?.focus()
              }
            }}
          >
            {l}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${shown}`}>
        {saveError && (
          <p className="inline-err" role="alert" style={{ padding: '8px 16px 0' }}>
            {saveError}
          </p>
        )}
        {shown === 'apparence' ? (
          <Appearance scheme={scheme} />
        ) : shown === 'general' ? (
          <General profiles={profiles} projects={projects} home={home} />
        ) : shown === 'plugins' ? (
          <PluginSettings />
        ) : (
          <PromptSettings projects={projects} home={home} />
        )}
      </div>
    </Modal>
  )
}
