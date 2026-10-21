/**
 * « Voir les différences » d'un conflit d'enregistrement (lot 7) : diff par
 * lignes, calculé dans la page, entre la version ouverte, la version
 * actuelle sur le disque et la mienne, affiché avec le lecteur de diff.
 */
import { useMemo, useState } from 'react'

import type { PlainKey } from '../../../shared/i18n'
import { useT } from '../i18n'
import { diffRows } from '../state/diff'
import { invisibleDifference, lineDiff } from '../state/lineDiff'
import { emptyDraft } from '../state/review'
import { DiffTable } from './DiffReader'
import { Modal } from './Modal'

type Pair = 'disk' | 'mine' | 'overwrite'

/** Paires comparées : clé, libellé du bouton, aide (clés du catalogue, traduites au rendu). */
const PAIRS: readonly (readonly [Pair, PlainKey, PlainKey])[] = [
  ['disk', 'files.editDiff.disk', 'files.editDiff.diskHelp'],
  ['mine', 'files.editDiff.mine', 'files.editDiff.mineHelp'],
  ['overwrite', 'files.editDiff.overwrite', 'files.editDiff.overwriteHelp'],
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
  const t = useT()
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
  const help = t(PAIRS.find(([k]) => k === pair)![2])

  return (
    <Modal title={t('files.editDiff.title', { path })} onClose={onClose} width={1100}>
      <div className="mb">
        <div className="seg" role="group" aria-label={t('files.editDiff.pairsLabel')}>
          {PAIRS.map(([k, l]) => (
            <button key={k} aria-pressed={pair === k} onClick={() => setPair(k)}>
              {t(l)}
            </button>
          ))}
        </div>
        <p className="hint" style={{ margin: 0 }}>
          {help}
        </p>
        {needsCurrent && current === null ? (
          <p className="inline-err" role="alert">
            {currentError ?? t('files.editDiff.readingCurrent')}
          </p>
        ) : result?.identical ? (
          <p className="empty">{result.invisible ?? t('files.editDiff.noDifference')}</p>
        ) : (
          <>
            {result?.approximate && <p className="hint">{t('files.editDiff.approximate')}</p>}
            <div className="ediff">
              <DiffTable rows={rows} draft={emptyDraft} review={NOOP} full commentsAt={NONE} editingAt={NO} onEdit={NOOP} />
            </div>
          </>
        )}
      </div>
      <div className="mf">
        <span style={{ marginRight: 'auto' }} />
        <button className="btn" data-autofocus onClick={onClose}>
          {t('files.close')}
        </button>
      </div>
    </Modal>
  )
}
