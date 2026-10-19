import { useState } from 'react'

import { SETTABLE_MODES, type Profile, type Session } from '../../../shared/protocol'
import { call, errorText } from '../api'
import { modeLabel } from '../state/format'
import { Modal } from './Modal'

/** Fenêtre minimale du lot 4 (la complète, avec projets et reprise, est au lot 5). */
export function NewSessionDialog({
  profiles,
  defaultCwd,
  termSize,
  onClose,
  onLaunched,
}: {
  profiles: Profile[]
  defaultCwd: string
  termSize: { cols: number; rows: number } | null
  onClose: () => void
  onLaunched: (s: Session) => void
}) {
  const [cwd, setCwd] = useState(defaultCwd)
  const [profile, setProfile] = useState(profiles[0]?.name ?? 'default')
  const [mode, setMode] = useState('')
  const [model, setModel] = useState('')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function launch() {
    const dir = cwd.trim()
    if (!dir.startsWith('/')) {
      setError('Le dossier doit être un chemin absolu.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const r = await call('sessions.launch', {
        cwd: dir,
        profile,
        ...(mode ? { mode } : {}),
        ...(model.trim() ? { model: model.trim() } : {}),
        ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
        ...(termSize ?? {}),
      })
      onLaunched(r.session)
    } catch (e) {
      setError(`Lancement impossible : ${errorText(e)}`)
      setBusy(false)
    }
  }

  return (
    <Modal title="Nouvelle session" onClose={onClose}>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void launch()
          }}
        >
          <div className="mb">
            <label className="field">
              <span className="lbl">Dossier</span>
              <input
                className="mono"
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder="/home/…/projet"
                autoFocus
                required
                spellCheck={false}
              />
              <span className="hint">Chemin absolu d’un dossier existant (dépôt ou worktree).</span>
            </label>
            <div className="grid3">
              <label className="field">
                <span className="lbl">Profil</span>
                <select value={profile} onChange={(e) => setProfile(e.target.value)}>
                  {profiles.length === 0 && <option value="default">default</option>}
                  {profiles.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="lbl">Mode</span>
                <select value={mode} onChange={(e) => setMode(e.target.value)}>
                  <option value="">Celui du profil</option>
                  {SETTABLE_MODES.map((m) => (
                    <option key={m} value={m}>
                      {modeLabel(m)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="lbl">Modèle</span>
                <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="celui du profil" />
              </label>
            </div>
            <label className="field">
              <span className="lbl">Prompt initial</span>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Facultatif : la première consigne à Claude."
              />
            </label>
          </div>
          <div className="mf">
            {error ? (
              <span className="err" role="alert">
                {error}
              </span>
            ) : (
              <span style={{ marginRight: 'auto' }} />
            )}
            <button type="button" className="btn ghost" onClick={onClose}>
              Annuler
            </button>
            <button className="btn pri" disabled={busy}>
              {busy ? 'Lancement…' : 'Lancer'}
            </button>
          </div>
        </form>
    </Modal>
  )
}
