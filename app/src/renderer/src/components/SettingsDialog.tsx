/**
 * Fenêtre « Réglages » (maquette) : Apparence (mode, palette, couleurs par
 * mode avec aperçu) et Général (notifications, confirmations, libellés des
 * profils, profil par défaut par projet). Les modifications s'appliquent tout
 * de suite et sont enregistrées par le processus principal.
 */
import { useId, useState, type CSSProperties } from 'react'

import type { Profile } from '../../../shared/protocol'
import {
  MAX_LONG_LABEL,
  MAX_SHORT_LABEL,
  PALETTE_NAMES,
  THEME_TOKENS,
  checkProfileLabel,
  profileLabel,
  type ThemeMode,
  type ThemeToken,
} from '../../../shared/settings'
import { api } from '../api'
import { useSettings } from '../settings'
import type { ProjectChoice } from '../state/newSession'
import { BASE, PALETTES, TOKEN_LABELS, schemeTokens, themeJson, tokenValue, type Scheme } from '../state/themeTokens'
import { tildify } from '../state/format'
import { Meter, ProfileBadge, StatusGlyph } from './common'
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

function Appearance({ scheme }: { scheme: Scheme }) {
  const { settings, update } = useSettings()
  const theme = settings.theme
  const [edited, setEdited] = useState<Scheme>(scheme)
  const [copied, setCopied] = useState<string | null>(null)
  const custom = theme.custom[edited]
  const customCount = Object.keys(custom).length

  function setColor(token: ThemeToken, value: string | null) {
    const next = { ...theme.custom[edited] }
    // Une couleur égale à celle de la palette n'est pas une personnalisation.
    const paletteValue = tokenValue({ palette: theme.palette, custom: { light: {}, dark: {} } }, edited, token)
    if (value === null || value.toLowerCase() === paletteValue.toLowerCase()) delete next[token]
    else next[token] = value.toLowerCase()
    update({ theme: { ...theme, custom: { ...theme.custom, [edited]: next } } })
  }

  async function copy() {
    const ok = await api.copyText(themeJson(theme)).catch(() => false)
    setCopied(ok ? 'Thème copié (JSON).' : 'Copie impossible.')
  }

  const preview = Object.fromEntries(Object.entries(schemeTokens(theme, edited)).map(([k, v]) => [`--${k}`, v])) as CSSProperties

  return (
    <>
      <div className="mb">
        <div className="field">
          <span className="lbl" id="st-mode">
            Mode
          </span>
          <div className="seg" role="group" aria-labelledby="st-mode">
            {MODES.map(([m, l]) => (
              <button key={m} type="button" aria-pressed={theme.mode === m} onClick={() => update({ theme: { ...theme, mode: m } })}>
                {l}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <span className="lbl" id="st-pal">
            Palette
          </span>
          <div className="presets" role="group" aria-labelledby="st-pal">
            {PALETTE_NAMES.map((name) => {
              const p = PALETTES[name]
              const values = { ...BASE[scheme], ...p[scheme] }
              return (
                <button
                  key={name}
                  type="button"
                  className="preset"
                  aria-pressed={theme.palette === name}
                  onClick={() => update({ theme: { ...theme, palette: name } })}
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
          <span className="lbl" id="st-colors">
            Couleurs
          </span>
          <div className="row-inline">
            <div className="seg" role="group" aria-label="Mode dont on règle les couleurs">
              {(
                [
                  ['light', 'Mode clair'],
                  ['dark', 'Mode sombre'],
                ] as const
              ).map(([m, l]) => (
                <button key={m} type="button" aria-pressed={edited === m} onClick={() => setEdited(m)}>
                  {l}
                </button>
              ))}
            </div>
            <span className="hint">
              Chaque mode garde ses propres couleurs ; elles s’ajoutent à la palette.
              {customCount > 0 && <b> {customCount} personnalisée{customCount > 1 ? 's' : ''}.</b>}
            </span>
          </div>
          <div className="colors" aria-labelledby="st-colors">
            {THEME_TOKENS.map((t) => {
              const v = tokenValue(theme, edited, t)
              return (
                <div className="crow" key={t}>
                  <input
                    type="color"
                    value={v}
                    aria-label={`${TOKEN_LABELS[t]} (mode ${edited === 'dark' ? 'sombre' : 'clair'})`}
                    onChange={(e) => setColor(t, e.target.value)}
                  />
                  <span className="nm">{TOKEN_LABELS[t]}</span>
                  <span className="hex">{v}</span>
                  {custom[t] && (
                    <button
                      type="button"
                      className="btn sm ghost"
                      aria-label={`Couleur de la palette pour « ${TOKEN_LABELS[t]} »`}
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
        </div>
        <div className="preview" style={preview} aria-label={`Aperçu du mode ${edited === 'dark' ? 'sombre' : 'clair'}`} role="group">
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
              contexte <Meter pct={45} label="Exemple 45 %" /> 45 %
            </span>
            <span className="pv">
              <Meter pct={80} label="Exemple 80 %" /> 80 %
            </span>
            <span className="pv">
              <Meter pct={95} label="Exemple 95 %" /> 95 %
            </span>
            <span className="chip pend">peut-être obsolète</span>
            <span className="chip bad">dossier supprimé</span>
            <button type="button" className="btn pri sm" tabIndex={-1}>
              Bouton principal
            </button>
          </div>
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
          className="btn ghost"
          onClick={() => update({ theme: { ...theme, custom: { light: {}, dark: {} } } })}
          disabled={Object.keys(theme.custom.light).length + Object.keys(theme.custom.dark).length === 0}
        >
          Réinitialiser les couleurs
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

function General({ profiles, projects, home }: { profiles: Profile[]; projects: ProjectChoice[]; home: string | null }) {
  const { settings, update, label } = useSettings()
  return (
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
    </div>
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
