/**
 * Réglages → Consignes (v0.3, lot 18) : chaque consigne que l'app fait taper
 * à Claude, modifiable globalement ou pour un projet (le projet hérite du
 * global sauf surcharge), avec ses variables, l'aperçu rendu sur des valeurs
 * d'exemple et l'origine du texte affiché. Seule la consigne tapée se
 * modifie : le contenu collé derrière (issue, journal, extraits) n'en fait
 * jamais partie.
 */
import { useEffect, useId, useState } from 'react'

import {
  ORIGIN_LABELS,
  PROMPTS,
  defaultPrompt,
  ownOverride,
  previewPrompt,
  promptProblem,
  resolvePrompt,
  type PromptDef,
} from '../../../shared/prompts'
import { useI18n } from '../i18n'
import { useSettings } from '../settings'
import { tildify } from '../state/format'
import type { ProjectChoice } from '../state/newSession'

/** Valeur du sélecteur de portée pour le réglage global. */
const GLOBAL = ''

function PromptEditor({ def, projectKey }: { def: PromptDef; projectKey: string | null }) {
  const { settings, update } = useSettings()
  const { locale, t } = useI18n()
  const id = useId()
  const resolved = resolvePrompt(settings.prompts, def.id, projectKey)
  /** Ce dont hérite la portée affichée : le global pour un projet, le défaut (de la langue de l'interface) pour le global. */
  const inherited = projectKey ? resolvePrompt(settings.prompts, def.id, null).template : defaultPrompt(def.id, locale)
  /** Surcharge de cette portée telle qu'enregistrée : invalide (relue du disque), elle est montrée mais pas utilisée. */
  const stored = ownOverride(settings.prompts, def.id, projectKey)
  const storedProblem = stored === undefined ? null : promptProblem(def.id, stored)
  const shown = storedProblem && stored !== undefined ? stored : resolved.template
  const storedError = storedProblem
    ? t('prompts.ui.storedInvalid', {
        fallback: projectKey ? t('prompts.ui.fallbackGlobal') : t('prompts.ui.fallbackDefault'),
        problem: storedProblem,
      })
    : null
  const [text, setText] = useState(shown)
  /**
   * Erreur affichée, gardée comme sa cause (surcharge enregistrée invalide, ou
   * texte tapé invalide) et traduite au rendu : elle suit un changement de langue.
   */
  const [errorKind, setErrorKind] = useState<'stored' | 'typed' | null>(storedError ? 'stored' : null)
  useEffect(() => {
    setText(shown)
    setErrorKind(storedProblem ? 'stored' : null)
  }, [shown, stored, resolved.origin, projectKey])
  const typedProblem = errorKind === 'typed' ? promptProblem(def.id, text) : null
  const error = errorKind === 'stored' ? storedError : typedProblem ? t('prompts.ui.notSaved', { problem: typedProblem }) : null

  function save(v: string | null) {
    if (v === null) setErrorKind(null)
    // Égal à ce dont la portée hérite : pas de surcharge (l'origine reste celle du niveau au-dessus).
    const value = v === null || v === inherited ? null : v
    if (projectKey) void update({ prompts: { projects: { [projectKey]: { [def.id]: value } } } })
    else void update({ prompts: { global: { [def.id]: value } } })
  }

  const preview = previewPrompt(def.id, text)
  const canReset = stored !== undefined
  return (
    <section className="prompt-ed" aria-labelledby={`${id}-h`}>
      <div className="prompt-ed-h">
        <h3 id={`${id}-h`}>{def.label}</h3>
        <span className="hint prompt-origin">
          {t('prompts.ui.origin', { origin: ORIGIN_LABELS[resolved.origin] })}
        </span>
      </div>
      <span className="hint">{t('prompts.ui.sentBy', { when: def.when })}</span>
      <span className="hint">{def.pasted ? t('prompts.ui.pasted', { pasted: def.pasted }) : t('prompts.ui.nothingPasted')}</span>
      <textarea
        value={text}
        rows={3}
        spellCheck={false}
        aria-label={t('prompts.ui.editorLabel', { label: def.label })}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-e`}
        onKeyDown={(e) => {
          // Une consigne tient sur une ligne : Entrée ne fait pas de saut.
          // (Pas pendant une composition : Entrée y valide le caractère composé.)
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) e.preventDefault()
        }}
        onChange={(e) => {
          const v = e.target.value
          setText(v)
          const problem = promptProblem(def.id, v)
          // Message persistant tant que le texte affiché n'est pas enregistré.
          setErrorKind(problem ? 'typed' : null)
          if (!problem) save(v)
        }}
      />
      <span id={`${id}-e`} className={error ? 'inline-err' : 'hint'} role={error ? 'alert' : undefined}>
        {error ?? ''}
      </span>
      <span className="hint">
        {t('prompts.ui.variables')}{' '}
        {def.variables.map((v, i) => (
          <span key={v.name}>
            {i > 0 && t('prompts.ui.varSeparator')}
            <span className="mono">{`{${v.name}}`}</span> {v.description}
          </span>
        ))}
        .
      </span>
      <div role="group" aria-labelledby={`${id}-p`} className="prompt-preview">
        <span className="lbl" id={`${id}-p`}>
          {t('prompts.ui.preview')}
        </span>
        {'text' in preview ? (
          <pre className="deliv-prompt mono">{preview.text}</pre>
        ) : (
          <p className="hint">{t('prompts.ui.previewUnavailable', { error: preview.error })}</p>
        )}
      </div>
      {canReset && (
        <button type="button" className="btn sm ghost" style={{ justifySelf: 'start' }} onClick={() => {
            setText(inherited)
            save(null)
          }}>
          {projectKey ? t('prompts.ui.inheritGlobal') : t('prompts.ui.restoreDefault')}
        </button>
      )}
    </section>
  )
}

export function PromptSettings({ projects, home }: { projects: ProjectChoice[]; home: string | null }) {
  const { t, rich } = useI18n()
  const [scope, setScope] = useState<string>(GLOBAL)
  // Une entrée par clé de projet (plusieurs dossiers peuvent partager les réglages d'un dépôt).
  const choices = projects.filter((c, i) => projects.findIndex((d) => d.profileKey === c.profileKey) === i)
  const projectKey = scope === GLOBAL ? null : scope
  return (
    <>
      <div className="mb">
        <div className="field">
          <span className="lbl">{t('prompts.ui.title')}</span>
          <span className="hint">
            {rich('prompts.ui.intro', { tape: <b>{t('prompts.ui.introTyped')}</b>, colle: <b>{t('prompts.ui.introPasted')}</b> })}
          </span>
          <label className="pprow">
            <span className="nm">{t('prompts.ui.scope')}</span>
            <select value={scope} aria-label={t('prompts.ui.scopeLabel')} onChange={(e) => setScope(e.target.value)}>
              <option value={GLOBAL}>{t('prompts.ui.scopeGlobal')}</option>
              {choices.map((c) => (
                <option key={c.profileKey} value={c.profileKey}>
                  {c.name} — {tildify(c.root, home)}
                </option>
              ))}
            </select>
          </label>
          <span className="hint">
            {projectKey ? t('prompts.ui.scopeProjectHint') : t('prompts.ui.scopeGlobalHint')}
          </span>
        </div>
        {PROMPTS.map((def) => (
          <PromptEditor key={`${projectKey ?? GLOBAL}:${def.id}`} def={def} projectKey={projectKey} />
        ))}
      </div>
      <div className="mf">
        <span className="hint">{t('prompts.ui.savedLive')}</span>
      </div>
    </>
  )
}
