/**
 * Liste des slash commands sous le doigt (v0.3, lot 17) : chargement de la
 * liste (`commands.list` à chaque ouverture, repli sur la liste intégrée) et
 * popup accessible au-dessus du champ de saisie.
 *
 * Le champ reste un `textarea` (rôle implicite `textbox`, le seul permis sur
 * cet élément) : il porte `aria-autocomplete="list"`, `aria-haspopup`,
 * `aria-controls` et `aria-activedescendant` vers la `listbox` ; le focus ne
 * quitte jamais le champ. Le nombre de propositions est annoncé poliment.
 */
import { useEffect, useLayoutEffect, useState } from 'react'

import { t as translate } from '../../../shared/i18n'
import { ErrorCode, type SlashCommand } from '../../../shared/protocol'
import { CallError, call, errorText } from '../api'
import { useT } from '../i18n'
import {
  BUILTIN_COMMANDS,
  commandTexts,
  conflictLabel,
  listNote,
  normalizeCommands,
  sourceLabel,
  suggestionsLabel,
} from '../state/slashCommands'

/** Repli, démon sans la capacité `slash_commands` (langue courante). */
export function slashOldDaemon(): string {
  return translate('conversation.slash.oldDaemon')
}

/**
 * Commandes proposées pour la session : relues auprès du démon à chaque
 * ouverture de la liste (`wanted` qui passe à vrai), si le démon annonce la
 * capacité (`supported`) ; sinon, et pendant le chargement ou en cas
 * d'échec, la liste intégrée.
 */
export function useSlashCommands(
  sessionId: string,
  supported: boolean | null,
  wanted: boolean,
): { commands: readonly SlashCommand[]; note: string | null } {
  const [list, setList] = useState<readonly SlashCommand[] | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [refused, setRefused] = useState(false)

  // Relu à chaque passage de `wanted` à vrai (ouverture de la liste).
  useEffect(() => {
    if (!wanted || supported !== true || refused) return
    let alive = true
    call('commands.list', { id: sessionId })
      .then((r) => {
        if (!alive) return
        const cmds = normalizeCommands(r)
        setList(cmds)
        const o = r as { truncated?: unknown; ignored?: unknown }
        const ignored = typeof o.ignored === 'number' && Number.isFinite(o.ignored) ? Math.max(0, Math.floor(o.ignored)) : 0
        setNote(cmds ? listNote(o.truncated === true, ignored) : translate('conversation.slash.unreadable'))
      })
      .catch((e: unknown) => {
        if (!alive) return
        if (e instanceof CallError && e.failure.code === ErrorCode.MethodNotFound) {
          setRefused(true)
          setList(null)
          setNote(slashOldDaemon())
        } else {
          setNote(translate('conversation.slash.unavailable', { error: errorText(e) }))
        }
      })
    return () => {
      alive = false
    }
  }, [wanted, supported, sessionId, refused])

  if (supported === false || refused) return { commands: BUILTIN_COMMANDS, note: slashOldDaemon() }
  return { commands: list ?? BUILTIN_COMMANDS, note: supported === true ? note : null }
}

/** Identifiant de l'option `i` de la liste `listId`. */
export function optionId(listId: string, i: number): string {
  return `${listId}-o${i}`
}

export function SlashCommandPopup({
  listId,
  items,
  active,
  note,
  anchor,
  onPick,
}: {
  listId: string
  items: readonly SlashCommand[]
  active: number
  note: string | null
  /** Élément au-dessus duquel la liste s'ouvre (place disponible mesurée jusqu'au haut de `.cv`). */
  anchor: HTMLElement | null
  onPick: (index: number) => void
}) {
  const t = useT()
  const [maxHeight, setMaxHeight] = useState(320)
  useLayoutEffect(() => {
    const cv = anchor?.closest('.cv')
    if (!anchor || !cv) return
    const avail = anchor.getBoundingClientRect().top - cv.getBoundingClientRect().top - 8
    setMaxHeight(avail > 80 ? Math.min(320, avail) : 320)
  }, [anchor, items.length])
  useLayoutEffect(() => {
    const el = document.getElementById(optionId(listId, active))
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [listId, active])
  return (
    <div className="slash-pop" style={{ maxHeight }}>
      <ul role="listbox" id={listId} aria-label={t('conversation.slash.listLabel')} className="slash-list">
        {items.map((c, i) => {
          const texts = commandTexts(c)
          return (
            <li
              // Un même nom peut figurer deux fois (intégrée et reprise marquée).
              key={`${c.source}:${c.plugin ?? ''}:${c.name}`}
              id={optionId(listId, i)}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'slash-opt on' : 'slash-opt'}
              // Le focus reste dans le champ.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onPick(i)}
            >
              <span className="slash-l1">
                <span className="slash-name">/{c.name}</span>
                {texts.argument_hint && <span className="slash-hint">{texts.argument_hint}</span>}
                <span className="slash-src">{sourceLabel(c)}</span>
                {conflictLabel(c) && <span className="slash-conflict">{conflictLabel(c)}</span>}
                {c.interactive && <span className="slash-tui">{t('conversation.slash.interactive')}</span>}
              </span>
              {texts.description && <span className="slash-desc">{texts.description}</span>}
            </li>
          )
        })}
      </ul>
      {note && <p className="slash-note">{note}</p>}
    </div>
  )
}

/** Annonce polie du nombre de propositions. */
export function SlashStatus({ count, open }: { count: number; open: boolean }) {
  return (
    <span className="sr-only" aria-live="polite">
      {open ? suggestionsLabel(count) : ''}
    </span>
  )
}
