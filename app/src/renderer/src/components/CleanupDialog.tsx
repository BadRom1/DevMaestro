/**
 * Dialogue « Nettoyer les worktrees » (v0.2, lot 6) : worktrees du dépôt avec
 * leur état, cases à cocher (intégrés sans session cochés par défaut, ceux de
 * Claude Desktop jamais), « supprimer aussi la branche » par ligne,
 * confirmation qui nomme ce qui sera perdu, suppression une par une avec un
 * résultat par ligne. Un worktree aux modifications non commitées n'est
 * supprimé de force qu'après une seconde confirmation explicite. La liste
 * suit `project.worktrees_changed`.
 */
import { useEffect, useId, useMemo, useState } from 'react'

import { ErrorCode, type WorktreeInfo, type WorktreesList } from '../../../shared/protocol'
import type { Translate } from '../../../shared/i18n'
import { CallError, call, errorCode, errorText } from '../api'
import { useT } from '../i18n'
import { outcomeUncertain, uncertainText } from '../state/errors'
import { tildify } from '../state/format'
import {
  branchDeletable,
  cleanupRows,
  dirtyFiles,
  initialChoices,
  lossesFor,
  protectedBranches,
  removable,
  removedText,
  worktreeStates,
  type CleanupChoice,
} from '../state/worktrees'
import { Modal } from './Modal'

type RowResult =
  | { state: 'running' }
  | { state: 'done'; text: string }
  /** Délai dépassé ou connexion perdue : la suppression a pu se faire. */
  | { state: 'uncertain' }
  | { state: 'error'; message: string }
  /** Refusé (-32020) : modifications non commitées ; `files` : liste courte du démon. */
  | { state: 'dirty'; files: string[] }

function branchLabel(w: WorktreeInfo, t: Translate): string {
  return w.branch ?? (w.head ? t('sessions.cleanup.detached', { head: w.head.slice(0, 8) }) : t('sessions.cleanup.noBranch'))
}

export function CleanupDialog({
  root,
  name,
  home,
  list,
  focus,
  seen,
  onRefresh,
  onClose,
}: {
  root: string
  name: string
  home: string | null
  /** Dernière liste connue (`undefined` : en chargement). */
  list: WorktreesList | undefined
  /** Worktree visé (« Nettoyer… » sur une ligne, notification) : coché s'il est supprimable. */
  focus: string | null
  /** Worktrees vus avec du travail à eux (voir `noteWork`). */
  seen?: ReadonlySet<string>
  onRefresh: () => void
  onClose: () => void
}) {
  const t = useT()
  /** Lignes vues depuis l'ouverture : une ligne supprimée reste affichée avec son résultat. */
  const [rowsSeen, setRowsSeen] = useState<Record<string, WorktreeInfo>>({})
  const [choices, setChoices] = useState<Record<string, CleanupChoice>>({})
  const [results, setResults] = useState<Record<string, RowResult>>({})
  const [phase, setPhase] = useState<'select' | 'confirm' | 'running'>('select')
  /** Ligne dont la seconde confirmation (suppression forcée) est ouverte. */
  const [forcing, setForcing] = useState<string | null>(null)
  const uid = useId()
  const protectedSet = useMemo(() => protectedBranches(list), [list])

  // Nouvelle liste : lignes ajoutées ou mises à jour ; choix par défaut pour les nouvelles seulement.
  useEffect(() => {
    if (!list) return
    setRowsSeen((prev) => {
      const next = { ...prev }
      for (const w of list.worktrees) if (!w.main) next[w.path] = w
      return next
    })
    setChoices((prev) => ({ ...initialChoices(list.worktrees, focus, { seen, protectedSet: protectedBranches(list) }), ...prev }))
  }, [list, focus, seen])

  const current = useMemo(() => new Set((list?.worktrees ?? []).map((w) => w.path)), [list])
  const rows = useMemo(() => cleanupRows(Object.values(rowsSeen), seen), [rowsSeen, seen])
  const live = (w: WorktreeInfo) => current.has(w.path) && results[w.path]?.state !== 'done'
  const selected = rows.filter((w) => live(w) && removable(w) && choices[w.path]?.remove)
  const busy = phase === 'running'

  function setChoice(path: string, patch: Partial<CleanupChoice>) {
    setChoices((c) => ({ ...c, [path]: { remove: false, deleteBranch: false, ...c[path], ...patch } }))
  }

  async function removeOne(w: WorktreeInfo, force: boolean): Promise<void> {
    const deleteBranch = branchDeletable(w, protectedSet) && !!choices[w.path]?.deleteBranch
    setResults((r) => ({ ...r, [w.path]: { state: 'running' } }))
    try {
      const res = await call('worktrees.remove', { root, path: w.path, delete_branch: deleteBranch, force })
      setResults((r) => ({ ...r, [w.path]: { state: 'done', text: removedText(res, w.branch) } }))
    } catch (e) {
      const dirty = e instanceof CallError && e.failure.code === ErrorCode.WorktreeDirty
      const result: RowResult = dirty
        ? { state: 'dirty', files: dirtyFiles((e as CallError).failure.data) }
        : outcomeUncertain(errorCode(e))
          ? { state: 'uncertain' }
          : { state: 'error', message: errorText(e) }
      setResults((r) => ({ ...r, [w.path]: result }))
    }
  }

  async function run(): Promise<void> {
    setPhase('running')
    // Une par une : chaque ligne a son résultat, un échec n'arrête pas les suivantes.
    for (const w of selected) await removeOne(w, false)
    setPhase('select')
    onRefresh()
  }

  async function force(w: WorktreeInfo): Promise<void> {
    setForcing(null)
    setPhase('running')
    await removeOne(w, true)
    setPhase('select')
    onRefresh()
  }

  function resultText(w: WorktreeInfo, r: RowResult | undefined): string | null {
    if (!r) return null
    switch (r.state) {
      case 'running':
        return t('sessions.cleanup.removing')
      case 'done':
        return r.text
      case 'uncertain':
        return t('sessions.cleanup.uncertain', { text: uncertainText() })
      case 'error':
        return `✗ ${r.message}`
      case 'dirty':
        return t('sessions.cleanup.refusedDirty')
    }
  }

  return (
    <Modal title={t('sessions.cleanup.title', { name })} onClose={onClose} width={820} busy={busy}>
      <div className="mb">
        <p className="hint">
          {t('sessions.cleanup.hint', { root: tildify(root, home) })}
        </p>
        {!list && <p className="hint">{t('sessions.cleanup.loading')}</p>}
        {list && rows.length === 0 && <p className="empty-note">{t('sessions.cleanup.empty')}</p>}
        {rows.length > 0 && (
          <ul className="wt-list" role="list">
            {rows.map((w, i) => {
              const statesId = `${uid}-st-${i}` // i18n-exempt: identifiant DOM
              const r = results[w.path]
              const gone = !live(w)
              const can = !gone && removable(w) && !busy
              const c = choices[w.path]
              const text = resultText(w, r)
              return (
                <li key={w.path} className={`wt-item${gone ? ' gone-row' : ''}`}>
                  <label className="wt-main">
                    <input
                      type="checkbox"
                      checked={!gone && removable(w) && !!c?.remove}
                      disabled={!can || phase === 'confirm'}
                      onChange={(e) => setChoice(w.path, { remove: e.target.checked })}
                      aria-describedby={statesId}
                    />
                    <span className="wt-names">
                      <b className="mono">{branchLabel(w, t)}</b>
                      <span className="hint mono" title={w.path}>
                        {tildify(w.path, home)}
                      </span>
                    </span>
                  </label>
                  <span className="wt-states" id={statesId}>
                    {worktreeStates(w).map((st) => (
                      <span key={st.kind} className={`chip ${st.tone === 'muted' ? '' : st.tone}`}>
                        <span aria-hidden="true">{st.icon}</span> {st.label}
                      </span>
                    ))}
                    {!removable(w) && !gone && <span className="hint">{t('sessions.cleanup.stopFirst')}</span>}
                  </span>
                  {w.branch && !gone && branchDeletable(w, protectedSet) && (
                    <label className="optrow wt-branch">
                      <input
                        type="checkbox"
                        checked={!!c?.deleteBranch}
                        disabled={!can || phase === 'confirm'}
                        onChange={(e) => setChoice(w.path, { deleteBranch: e.target.checked })}
                      />
                      <span>{t('sessions.cleanup.deleteBranch')}</span>
                    </label>
                  )}
                  {text && (
                    <span className={`wt-result${r?.state === 'done' ? ' ok' : r?.state === 'running' || r?.state === 'uncertain' ? '' : ' bad'}`} role="status">
                      {text}
                    </span>
                  )}
                  {r?.state === 'dirty' && (
                    <div className="forget wt-force" role="group" aria-label={t('sessions.cleanup.forceLabel', { branch: branchLabel(w, t) })}>
                      <span>
                        {r.files.length > 0 ? (
                          <>
                            {t('sessions.cleanup.dirtyFiles')} <span className="mono">{r.files.join(', ')}</span>
                          </>
                        ) : (
                          t('sessions.cleanup.dirtyNoList')
                        )}
                      </span>
                      {forcing === w.path ? (
                        <span className="row">
                          <span>
                            {t('sessions.cleanup.forceQuestion', { branch: branchLabel(w, t) })} <b>{t('sessions.cleanup.forceLost')}</b>
                            {lossesFor(w, !!c?.deleteBranch, true)
                              .filter((l) => l !== t('sessions.worktree.lossDirtyForce'))
                              .map((l) => ` ${l}.`)}
                          </span>
                          <button type="button" className="btn sm danger" disabled={busy} onClick={() => void force(w)}>
                            {t('sessions.cleanup.force')}
                          </button>
                          <button type="button" className="btn sm ghost" onClick={() => setForcing(null)}>
                            {t('sessions.confirm.cancel')}
                          </button>
                        </span>
                      ) : (
                        <span className="row">
                          <button type="button" className="btn sm" disabled={busy} onClick={() => setForcing(w.path)}>
                            {t('sessions.cleanup.forceAsk')}
                          </button>
                        </span>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        {phase === 'confirm' && (
          <div className="forget wt-confirm" role="group" aria-label={t('sessions.confirm.label')}>
            <span>
              {t('sessions.cleanup.confirmQuestion', { count: selected.length })}{' '}
              <span className="muted">{t('sessions.cleanup.confirmDetail')}</span>
            </span>
            <ul>
              {selected.map((w) => {
                const losses = lossesFor(w, !!choices[w.path]?.deleteBranch)
                return (
                  <li key={w.path}>
                    <b className="mono">{branchLabel(w, t)}</b>
                    {choices[w.path]?.deleteBranch && branchDeletable(w, protectedSet) ? t('sessions.cleanup.andBranch') : ''}
                    {losses.length === 0
                      ? t('sessions.cleanup.nothingLost')
                      : t('sessions.cleanup.losses', { losses: losses.join(t('sessions.cleanup.lossSeparator')) })}
                  </li>
                )
              })}
            </ul>
          </div>
        )}
      </div>
      <div className="mf">
        <span className="hint" style={{ marginRight: 'auto' }}>
          {selected.length === 0 ? t('sessions.cleanup.noneChecked') : t('sessions.cleanup.checked', { count: selected.length })}
        </span>
        {phase === 'confirm' ? (
          <>
            <button type="button" className="btn ghost" onClick={() => setPhase('select')} autoFocus>
              {t('sessions.cleanup.back')}
            </button>
            <button type="button" className="btn danger" onClick={() => void run()}>
              {t('sessions.cleanup.delete')}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
              {t('sessions.cleanup.close')}
            </button>
            <button type="button" className="btn pri" disabled={busy || selected.length === 0} onClick={() => setPhase('confirm')}>
              {busy ? t('sessions.cleanup.removing') : t('sessions.cleanup.deleteSelection')}
            </button>
          </>
        )}
      </div>
    </Modal>
  )
}
