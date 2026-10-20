/**
 * Fenêtre « Réglages » (maquette) : Apparence (mode, puis palette, couleurs et
 * aperçu propres au mode clair et au mode sombre) et Général (notifications, confirmations, libellés des
 * profils, profil par défaut par projet). Les modifications s'appliquent tout
 * de suite et sont enregistrées par le processus principal.
 */
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react'

import type { Profile } from '../../../shared/protocol'
import {
  DEFAULT_ZOOM,
  MAX_LONG_LABEL,
  MAX_SHORT_LABEL,
  MAX_THEME_IMPORT,
  PALETTE_NAMES,
  SCHEMES,
  THEME_TOKENS,
  ZOOM_STEPS,
  checkProfileLabel,
  parseThemeImport,
  profileLabel,
  stepZoom,
  type SchemeTheme,
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
import { api } from '../api'
import { useSettings } from '../settings'
import type { ProjectChoice } from '../state/newSession'
import { BASE, PALETTES, TOKEN_LABELS, paletteValue, schemeTokens, themeJson, tokenValue, type Scheme } from '../state/themeTokens'
import { tildify } from '../state/format'
import { Meter, ProfileBadge, StatusGlyph } from './common'
import { ConfirmBar } from './ForgetConfirm'
import { Modal } from './Modal'

type Tab = 'apparence' | 'general'

const MODES: [ThemeMode, string][] = [
  ['light', 'Clair'],
  ['dark', 'Sombre'],
  ['system', 'Suivre le système'],
]

const PREVIEW_GLYPHS = [
  { kind: 'waiting', label: 'À répondre' },
  { kind: 'running', label: 'En cours' },
  { kind: 'idle', label: 'Inactive' },
  { kind: 'stopped', label: 'Arrêtée' },
  { kind: 'error', label: 'Erreur' },
] as const

const SCHEME_LABELS: Record<Scheme, string> = { light: 'Clair', dark: 'Sombre' }

/** Aperçu d'un mode (glyphes, diff, jauges, boutons) avec ses jetons, quel que soit le mode affiché. */
function ThemePreview({ tokens, label }: { tokens: Record<string, string>; label: string }) {
  const style = Object.fromEntries(Object.entries(tokens).map(([k, v]) => [`--${k}`, v])) as CSSProperties
  return (
    <div className="preview" style={style} aria-label={label} role="group">
      <div className="row">
        {PREVIEW_GLYPHS.map((g) => (
          <span key={g.kind} className="pv">
            <StatusGlyph glyph={g} /> {g.label}
          </span>
        ))}
      </div>
      <div className="diff" aria-hidden="true">
        <div className="del">− token := r.URL.Query().Get("code")</div>
        <div className="add">+ code, err := parseCode(r, sessions)</div>
      </div>
      <div className="row">
        <span className="pv">
          <Meter pct={45} label="Exemple 45 %" /> 45 %
        </span>
        <span className="pv">
          <Meter pct={80} label="Exemple 80 %" /> 80 %
        </span>
        <span className="pv">
          <Meter pct={95} label="Exemple 95 %" /> 95 %
        </span>
      </div>
      <div className="row">
        <span className="chip pend">peut-être obsolète</span>
        <span className="chip bad">dossier supprimé</span>
        <button type="button" className="btn pri sm" tabIndex={-1}>
          Bouton principal
        </button>
      </div>
    </div>
  )
}

/** Bloc d'un mode affiché (clair ou sombre) : sa palette, ses couleurs et son aperçu. */
function SchemeBlock({ target, active, followsSystem }: { target: Scheme; active: boolean; followsSystem: boolean }) {
  const { settings, update } = useSettings()
  const own = settings.theme[target]
  const id = useId()
  const custom = own.custom
  const customCount = Object.keys(custom).length
  const modeName = target === 'dark' ? 'sombre' : 'clair'

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
        Mode {modeName}
        {active && <span className="chip">{followsSystem ? 'Affiché (suit le système)' : 'Affiché'}</span>}
      </h3>
      <div className="field">
        <span className="lbl" id={`${id}-pal`}>
          Palette
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
                  {(['accent', 'wait', 'run', 'done', 'err'] as const).map((t) => (
                    <i key={t} style={{ background: values[t] }} />
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
          Couleurs
          {customCount > 0 && (
            <span className="hint">
              {' '}
              · {customCount} personnalisée{customCount > 1 ? 's' : ''}
            </span>
          )}
        </span>
        <div className="colors" role="group" aria-labelledby={`${id}-colors`}>
          {THEME_TOKENS.map((t) => {
            const v = tokenValue(settings.theme, target, t)
            return (
              <div className="crow" key={t}>
                <input
                  type="color"
                  value={v}
                  aria-label={`${TOKEN_LABELS[t]} (mode ${modeName})`}
                  onChange={(e) => setColor(t, e.target.value)}
                />
                <span className="nm">{TOKEN_LABELS[t]}</span>
                <span className="hex">{v}</span>
                {custom[t] && (
                  <button
                    type="button"
                    className="btn sm ghost"
                    aria-label={`Couleur de la palette pour « ${TOKEN_LABELS[t]} » (mode ${modeName})`}
                    title="Revenir à la couleur de la palette"
                    onClick={() => setColor(t, null)}
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
            Réinitialiser les couleurs du mode {modeName}
          </button>
        </div>
      </div>
      <ThemePreview tokens={schemeTokens(settings.theme, target)} label={`Aperçu du mode ${modeName}`} />
    </section>
  )
}

/** « Taille du texte » : toute l'interface, terminal compris (zoom appliqué par le processus principal). */
function TextSize() {
  const { settings, update } = useSettings()
  const zoom = settings.ui.zoom
  const set = (z: number) => update({ ui: { zoom: z } })
  return (
    <div className="field">
      <label className="lbl" htmlFor="st-zoom">
        Taille du texte
      </label>
      <div className="row-inline">
        <div className="zoomctl">
          <button
            type="button"
            className="btn"
            aria-label="Texte plus petit"
            disabled={zoom === ZOOM_STEPS[0]}
            onClick={() => set(stepZoom(zoom, 'out'))}
          >
            −
          </button>
          <select id="st-zoom" value={zoom} onChange={(e) => set(Number(e.target.value))}>
            {ZOOM_STEPS.map((z) => (
              <option key={z} value={z}>
                {z} %{z === DEFAULT_ZOOM ? ' (par défaut)' : ''}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn"
            aria-label="Texte plus grand"
            disabled={zoom === ZOOM_STEPS[ZOOM_STEPS.length - 1]}
            onClick={() => set(stepZoom(zoom, 'in'))}
          >
            +
          </button>
          <button type="button" className="btn ghost" disabled={zoom === DEFAULT_ZOOM} onClick={() => set(DEFAULT_ZOOM)}>
            100 %
          </button>
        </div>
        <span className="hint">
          Toute l’interface, terminal compris. Raccourcis : <kbd>Ctrl</kbd> + <kbd>+</kbd>, <kbd>Ctrl</kbd> + <kbd>−</kbd>,{' '}
          <kbd>Ctrl</kbd> + <kbd>0</kbd>, ou <kbd>Ctrl</kbd> + molette.
        </span>
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
      setFileError(`Fichier trop gros : ${Math.round(MAX_THEME_IMPORT / 1024)} Kio au plus.`)
      return
    }
    try {
      setText(await f.text())
    } catch (e) {
      setFileError(`Lecture impossible : ${(e as Error).message}`)
    }
  }

  const error = fileError ?? (parsed && !parsed.ok ? `Thème refusé : ${parsed.error}.` : null)
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
      <h3 id={`${id}-h`}>Importer un thème (JSON)</h3>
      <label className="field">
        <span className="lbl">JSON du thème</span>
        <textarea
          autoFocus
          value={text}
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-st`}
          placeholder={'{ "mode": "system", "light": { "palette": "okabe", "custom": {} }, "dark": { … } }'}
          onChange={(e) => {
            setFileError(null)
            setText(e.target.value)
          }}
        />
      </label>
      <div className="row-inline">
        <button type="button" className="btn sm" onClick={() => file.current?.click()}>
          Choisir un fichier…
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
        <span className="hint">Format de « Copier le thème (JSON) », ou ancien format à palette unique.</span>
      </div>
      <p id={`${id}-st`} className={error ? 'inline-err' : 'hint'} role="status">
        {error ?? (theme ? `Thème valide${theme.mode ? '' : ' (le mode actuel est gardé)'} : aperçu ci-dessous.` : 'Colle un thème ou choisis un fichier.')}
      </p>
      {pair && (
        <div className="schemes">
          {SCHEMES.map((sc) => (
            <ThemePreview key={sc} tokens={schemeTokens(pair, sc)} label={`Aperçu du thème importé, mode ${SCHEME_LABELS[sc].toLowerCase()}`} />
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
            onDone('Thème importé.')
          }}
        >
          Appliquer
        </button>
        <button type="button" className="btn ghost" onClick={cancel}>
          Annuler
        </button>
      </div>
      {confirmDrop && (
        <ConfirmBar
          message="Abandonner le thème saisi ? Le JSON collé sera perdu."
          confirmLabel="Abandonner"
          busyLabel="Abandon…"
          errorPrefix="Abandon impossible"
          onConfirm={async () => onCancel()}
          onCancel={() => setConfirmDrop(false)}
        />
      )}
    </section>
  )
}

function Appearance({ scheme }: { scheme: Scheme }) {
  const { settings, update } = useSettings()
  const theme = settings.theme
  const [copied, setCopied] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const importBtn = useRef<HTMLButtonElement>(null)

  async function copy() {
    const ok = await api.copyText(themeJson(theme)).catch(() => false)
    setCopied(ok ? 'Thème copié (JSON).' : 'Copie impossible.')
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
        <div className="field">
          <span className="lbl" id="st-mode">
            Mode
          </span>
          <div className="row-inline">
            <div className="seg" role="group" aria-labelledby="st-mode">
              {MODES.map(([m, l]) => (
                <button key={m} type="button" aria-pressed={theme.mode === m} onClick={() => update({ theme: { mode: m } })}>
                  {l}
                </button>
              ))}
            </div>
            <span className="hint">
              Chaque mode a sa palette et ses couleurs.
              {theme.mode === 'system' && ` Le système est actuellement en mode ${SCHEME_LABELS[scheme].toLowerCase()}.`}
            </span>
          </div>
        </div>
        <div className="schemes">
          {SCHEMES.map((s) => (
            <SchemeBlock key={s} target={s} active={s === scheme} followsSystem={theme.mode === 'system'} />
          ))}
        </div>
        <p className="callout">
          Les statuts ne reposent jamais sur la couleur seule : chacun a sa forme (carré « ! », anneau qui tourne, cercle vide,
          coche, croix), et les lignes de diff gardent leurs signes + et −.
        </p>
      </div>
      <div className="mf">
        <span className="hint" role="status" style={{ marginRight: 'auto' }}>
          {copied ?? 'Les réglages sont propres à ton compte sur ce poste.'}
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
          Importer un thème (JSON)
        </button>
        <button type="button" className="btn" onClick={() => void copy()}>
          Copier le thème (JSON)
        </button>
      </div>
    </>
  )
}

function LabelRow({ profile, profiles }: { profile: Profile; profiles: Profile[] }) {
  const { settings, update } = useSettings()
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
        <span className="sr-only">Libellé long du profil {profile.name}</span>
        <input
          value={long}
          maxLength={MAX_LONG_LABEL * 2}
          aria-describedby={error ? `${id}-err` : undefined}
          aria-invalid={error ? true : undefined}
          onChange={(e) => {
            setLong(e.target.value)
            commit(e.target.value, short)
          }}
          placeholder="Libellé"
        />
      </label>
      <label className="field short">
        <span className="sr-only">Libellé court du profil {profile.name} (1 à 3 caractères)</span>
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
        title="Revenir aux libellés par défaut"
        onClick={() => {
          const d = profileLabel(profile.name, {})
          setLong(d.long)
          setShort(d.short)
          setError(null)
          update({ profileLabels: { [profile.name]: null } })
        }}
      >
        Par défaut
      </button>
      {error && (
        <span id={`${id}-err`} className="inline-err" role="alert">
          {error}
        </span>
      )}
    </div>
  )
}

const LOCATION_HINTS: Record<DefaultWorktreeLocation, string> = {
  sibling: '<parent du dépôt>/<dépôt>-<branche>',
  in_repo: '<dépôt>/.worktrees/<branche> (exclu de git localement)',
  managed: '~/.local/share/devmaestro/worktrees/…',
}

function Worktrees({ projects, home }: { projects: ProjectChoice[]; home: string | null }) {
  const { settings, update } = useSettings()
  const w = settings.worktrees
  const [prefix, setPrefix] = useState(w.branchPrefix)
  const [prefixError, setPrefixError] = useState<string | null>(null)
  const id = useId()
  const repos = projects.filter((c) => c.isGit)
  return (
    <div className="field">
      <span className="lbl">Worktrees</span>
      <span className="hint">Option « Dans un nouveau worktree » de « Nouvelle session », et nettoyage des branches intégrées.</span>
      <label className="wtrow">
        <span>Emplacement par défaut</span>
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
          {LOCATION_HINTS[w.location]}
        </span>
      </label>
      <label className="wtrow">
        <span>Préfixe des branches</span>
        <input
          className="mono"
          value={prefix}
          maxLength={MAX_BRANCH_PREFIX}
          spellCheck={false}
          placeholder="ex. romain/"
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
          {prefixError ?? `ex. ${branchFromName('Corriger l’export', prefix || '')}`}
        </span>
      </label>
      <label className="optrow">
        <input
          type="checkbox"
          checked={w.notifyIntegrated}
          onChange={(e) => update({ worktrees: { notifyIntegrated: e.target.checked } })}
        />
        <span>
          Notification du bureau quand une branche est intégrée
          <span className="hint optaide">
            Une seule fois par worktree, quand aucune session n’y tourne : « La branche X est intégrée : nettoyer le worktree ? »
          </span>
        </span>
      </label>
      {repos.length > 0 && (
        <>
          <span className="hint">Emplacement par projet (remplace le défaut) :</span>
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
                    aria-label={`Emplacement des worktrees de ${c.name}`}
                    onChange={(e) =>
                      update({
                        worktrees: {
                          projectLocations: { [c.profileKey]: (e.target.value || null) as DefaultWorktreeLocation | null },
                        },
                      })
                    }
                  >
                    <option value="">Par défaut ({LOCATION_LABELS[w.location]})</option>
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

function General({ profiles, projects, home }: { profiles: Profile[]; projects: ProjectChoice[]; home: string | null }) {
  const { settings, update, label } = useSettings()
  return (
    <>
      <div className="mb">
        <div className="field">
          <span className="lbl">Notifications</span>
          <label className="optrow">
            <input
              type="checkbox"
              checked={settings.notifications.enabled}
              onChange={(e) => update({ notifications: { enabled: e.target.checked } })}
            />
            <span>
              Notification du bureau quand une session attend une réponse
              <span className="hint optaide">
                Sans son (tes hooks s’en chargent) ; aucune si la fenêtre a le focus et affiche déjà cette session.
              </span>
            </span>
          </label>
        </div>
        <div className="field">
          <span className="lbl">Confirmations</span>
          <label className="optrow">
            <input type="checkbox" checked={settings.confirmRemoval} onChange={(e) => update({ confirmRemoval: e.target.checked })} />
            <span>Demander confirmation avant de retirer une session ou de masquer une ancienne session</span>
          </label>
        </div>
        <div className="field">
          <span className="lbl">Profils</span>
          <span className="hint">
            Libellé long (affiché partout) et court (badge de 1 à 3 caractères). Le nom technique reste dans les infobulles.
          </span>
          {profiles.length === 0 && <p className="hint">Aucun profil connu du démon.</p>}
          {profiles.map((p) => (
            <LabelRow key={p.name} profile={p} profiles={profiles} />
          ))}
        </div>
        <div className="field">
          <span className="lbl">Profil par défaut par projet</span>
          <span className="hint">Proposé dans « Nouvelle session ». « Automatique » : le dernier profil utilisé dans le projet.</span>
          {projects.length === 0 && <p className="hint">Aucun projet connu pour l’instant.</p>}
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
                    aria-label={`Profil par défaut de ${c.name}`}
                    onChange={(e) => update({ projectProfiles: { [c.profileKey]: e.target.value || null } })}
                  >
                    <option value="">Automatique</option>
                    {profiles.map((p) => (
                      <option key={p.name} value={p.name}>
                        {label(p.name).long}
                      </option>
                    ))}
                    {set && !profiles.some((p) => p.name === set) && <option value={set}>{set} (inconnu)</option>}
                  </select>
                </label>
              )
            })}
          </div>
        </div>
        <Worktrees projects={projects} home={home} />
      </div>
      <div className="mf">
        <span className="hint">Les réglages sont propres à ton compte sur ce poste.</span>
      </div>
    </>
  )
}

export function SettingsDialog({
  profiles,
  projects,
  home,
  scheme,
  onClose,
}: {
  profiles: Profile[]
  projects: ProjectChoice[]
  home: string | null
  scheme: Scheme
  onClose: () => void
}) {
  const [tab, setTab] = useState<Tab>('apparence')
  const { saveError } = useSettings()
  const id = useId()
  const tabs: [Tab, string][] = [
    ['apparence', 'Apparence'],
    ['general', 'Général'],
  ]
  return (
    <Modal title="Réglages" onClose={onClose} width={780}>
      <div className="stabs" role="tablist" aria-label="Rubriques des réglages">
        {tabs.map(([k, l]) => (
          <button
            key={k}
            type="button"
            role="tab"
            id={`${id}-${k}`}
            aria-selected={tab === k}
            aria-controls={`${id}-panel`}
            tabIndex={tab === k ? 0 : -1}
            onClick={() => setTab(k)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                e.preventDefault()
                const next: Tab = tab === 'apparence' ? 'general' : 'apparence'
                setTab(next)
                document.getElementById(`${id}-${next}`)?.focus()
              }
            }}
          >
            {l}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${tab}`}>
        {saveError && (
          <p className="inline-err" role="alert" style={{ padding: '8px 16px 0' }}>
            {saveError}
          </p>
        )}
        {tab === 'apparence' ? <Appearance scheme={scheme} /> : <General profiles={profiles} projects={projects} home={home} />}
      </div>
    </Modal>
  )
}
