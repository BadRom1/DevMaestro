/**
 * « Voir les différences » d'un conflit d'enregistrement (lot 7) : diff par
 * lignes, calculé dans la page, entre la version ouverte, la version
 * actuelle sur le disque et la mienne, affiché avec le lecteur de diff.
 */
import { useMemo, useState } from 'react'

import { diffRows } from '../state/diff'
import { invisibleDifference, lineDiff } from '../state/lineDiff'
import { emptyDraft } from '../state/review'
import { DiffTable } from './DiffReader'
import { Modal } from './Modal'

type Pair = 'disk' | 'mine' | 'overwrite'

const PAIRS: readonly (readonly [Pair, string, string])[] = [
  ['disk', 'Changements sur le disque', 'De la version ouverte à la version actuelle du fichier (sans doute modifiée par Claude).'],
  ['mine', 'Mes modifications', 'De la version ouverte à ma version.'],
  ['overwrite', 'Si j’écrase', 'De la version actuelle du fichier à ma version : ce que « Écraser quand même » changerait.'],
]

const NONE = () => []
const NO = () => false
const NOOP = () => undefined

export function EditDiffDialog({
  path,
  base,
  current,
  currentError,
  mine,
  onClose,
}: {
  path: string
  /** Version ouverte. */
  base: string
  /** Version actuelle (`null` : pas encore lue, illisible ou disparue). */
  current: string | null
  currentError: string | null
  mine: string
  onClose: () => void
}) {
  const [pair, setPair] = useState<Pair>(current === null ? 'mine' : 'disk')
  const needsCurrent = pair !== 'mine'
  const result = useMemo(() => {
    const texts = pair === 'mine' ? [base, mine] : current === null ? null : pair === 'disk' ? [base, current] : [current, mine]
    if (!texts) return null
    const [before, after] = texts as [string, string]
    const r = lineDiff(before, after)
    // Diff par lignes vide : les fins de ligne ou le saut de ligne final peuvent encore différer.
    return { ...r, invisible: r.identical ? invisibleDifference(before, after) : null }
  }, [pair, base, current, mine])
  const rows = useMemo(() => (result ? diffRows(result.diff) : []), [result])
  const help = PAIRS.find(([k]) => k === pair)![2]

  return (
    <Modal title={`Différences : ${path}`} onClose={onClose} width={1100}>
      <div className="mb">
        <div className="seg" role="group" aria-label="Versions comparées">
          {PAIRS.map(([k, l]) => (
            <button key={k} aria-pressed={pair === k} onClick={() => setPair(k)}>
              {l}
            </button>
          ))}
        </div>
        <p className="hint" style={{ margin: 0 }}>
          {help}
        </p>
        {needsCurrent && current === null ? (
          <p className="inline-err" role="alert">
            {currentError ?? 'Version actuelle en cours de lecture…'}
          </p>
        ) : result?.identical ? (
          <p className="empty">{result.invisible ?? 'Aucune différence.'}</p>
        ) : (
          <>
            {result?.approximate && <p className="hint">Trop de différences pour un diff ligne à ligne : les lignes changées sont données en bloc.</p>}
            <div className="ediff">
              <DiffTable rows={rows} draft={emptyDraft} review={NOOP} full commentsAt={NONE} editingAt={NO} onEdit={NOOP} />
            </div>
          </>
        )}
      </div>
      <div className="mf">
        <span style={{ marginRight: 'auto' }} />
        <button className="btn" data-autofocus onClick={onClose}>
          Fermer
        </button>
      </div>
    </Modal>
  )
}
