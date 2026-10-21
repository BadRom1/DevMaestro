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
  ownOverride,
  previewPrompt,
  promptProblem,
  resolvePrompt,
  type PromptDef,
} from '../../../shared/prompts'
import { useSettings } from '../settings'
import { tildify } from '../state/format'
import type { ProjectChoice } from '../state/newSession'

/** Valeur du sélecteur de portée pour le réglage global. */
const GLOBAL = ''

function PromptEditor({ def, projectKey }: { def: PromptDef; projectKey: string | null }) {
  const { settings, update } = useSettings()
  const id = useId()
  const resolved = resolvePrompt(settings.prompts, def.id, projectKey)
  /** Ce dont hérite la portée affichée : le global pour un projet, le défaut pour le global. */
  const inherited = projectKey ? resolvePrompt(settings.prompts, def.id, null).template : def.default
  /** Surcharge de cette portée telle qu'enregistrée : invalide (relue du disque), elle est montrée mais pas utilisée. */
  const stored = ownOverride(settings.prompts, def.id, projectKey)
  const storedProblem = stored === undefined ? null : promptProblem(def.id, stored)
  const shown = storedProblem && stored !== undefined ? stored : resolved.template
  const storedError = storedProblem
    ? `Texte enregistré invalide, non utilisé (${projectKey ? 'le réglage global' : 'le texte par défaut'} s’applique) : ${storedProblem}`
    : null
  const [text, setText] = useState(shown)
  const [error, setError] = useState<string | null>(storedError)
  useEffect(() => {
    setText(shown)
    setError(storedError)
  }, [shown, storedError, resolved.origin, projectKey])

  function save(v: string | null) {
    if (v === null) setError(null)
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
          Origine : {ORIGIN_LABELS[resolved.origin]}
        </span>
      </div>
      <span className="hint">Envoyée par {def.when}.</span>
      <span className="hint">
        {def.pasted ? <>Collé ensuite, comme donnée (non modifiable ici) : {def.pasted}.</> : <>Rien n’est collé : la consigne part seule.</>}
      </span>
      <textarea
        value={text}
        rows={3}
        spellCheck={false}
        aria-label={`Consigne « ${def.label} »`}
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
          setError(problem ? `Non enregistré : ${problem}` : null)
          if (!problem) save(v)
        }}
      />
      <span id={`${id}-e`} className={error ? 'inline-err' : 'hint'} role={error ? 'alert' : undefined}>
        {error ?? ''}
      </span>
      <span className="hint">
        Variables :{' '}
        {def.variables.map((v, i) => (
          <span key={v.name}>
            {i > 0 && ' ; '}
            <span className="mono">{`{${v.name}}`}</span> {v.description}
          </span>
        ))}
        .
      </span>
      <div role="group" aria-labelledby={`${id}-p`} className="prompt-preview">
        <span className="lbl" id={`${id}-p`}>
          Aperçu (valeurs d’exemple)
        </span>
        {'text' in preview ? (
          <pre className="deliv-prompt mono">{preview.text}</pre>
        ) : (
          <p className="hint">Aperçu indisponible : {preview.error}</p>
        )}
      </div>
      {canReset && (
        <button type="button" className="btn sm ghost" style={{ justifySelf: 'start' }} onClick={() => {
            setText(inherited)
            save(null)
          }}>
          {projectKey ? 'Hériter du global' : 'Rétablir le défaut'}
        </button>
      )}
    </section>
  )
}

export function PromptSettings({ projects, home }: { projects: ProjectChoice[]; home: string | null }) {
  const [scope, setScope] = useState<string>(GLOBAL)
  // Une entrée par clé de projet (plusieurs dossiers peuvent partager les réglages d'un dépôt).
  const choices = projects.filter((c, i) => projects.findIndex((d) => d.profileKey === c.profileKey) === i)
  const projectKey = scope === GLOBAL ? null : scope
  return (
    <>
      <div className="mb">
        <div className="field">
          <span className="lbl">Consignes envoyées à Claude</span>
          <span className="hint">
            Textes que l’app <b>tape</b> dans une session, avec l’autorité d’un prompt de ta part. Le contenu tiers (issue, journal
            de CI, extraits) est <b>collé</b> à part, comme donnée, et n’entre jamais dans la consigne : les variables ne portent que
            des valeurs locales (numéros, nombres) et des noms de branche réduits à lettres, chiffres et - _ . / + (une branche peut
            venir d’une fourche, donc d’un tiers). Une ligne, 1 500 caractères au plus ; les accolades sont réservées aux variables
            (pas d’accolade littérale) ; pas de « # », « / » ni « ! » en tête.
          </span>
          <label className="pprow">
            <span className="nm">Portée</span>
            <select value={scope} aria-label="Portée des consignes" onChange={(e) => setScope(e.target.value)}>
              <option value={GLOBAL}>Global (tous les projets)</option>
              {choices.map((c) => (
                <option key={c.profileKey} value={c.profileKey}>
                  {c.name} — {tildify(c.root, home)}
                </option>
              ))}
            </select>
          </label>
          <span className="hint">
            {projectKey
              ? 'Le projet hérite du réglage global, sauf pour les consignes modifiées ici.'
              : 'Valent pour tous les projets qui n’ont pas leur propre texte.'}
          </span>
        </div>
        {PROMPTS.map((def) => (
          <PromptEditor key={`${projectKey ?? GLOBAL}:${def.id}`} def={def} projectKey={projectKey} />
        ))}
      </div>
      <div className="mf">
        <span className="hint">Les modifications valides sont enregistrées tout de suite.</span>
      </div>
    </>
  )
}
