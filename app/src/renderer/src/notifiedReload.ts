/**
 * Ossature commune des listes relues sur notification du démon (diff du
 * worktree, commits) : relecture avec anti-rebond quand `seq` change (une
 * `session.diff_changed` de plus), seulement si la liste est suivie
 * (`active`). Le compteur au montage ne déclenche rien : la première lecture
 * est faite par l'appelant.
 */
import { useCallback, useEffect, useRef } from 'react'

export const RELOAD_DEBOUNCE_MS = 400

export function useNotifiedReload(load: () => unknown, seq: number, active: boolean, ms = RELOAD_DEBOUNCE_MS): () => void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loadRef = useRef(load)
  loadRef.current = load
  const reload = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      void loadRef.current()
    }, ms)
  }, [ms])
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )
  const activeRef = useRef(active)
  activeRef.current = active
  const seenSeq = useRef(seq)
  useEffect(() => {
    if (seq === seenSeq.current) return
    seenSeq.current = seq
    if (activeRef.current) reload()
  }, [seq, reload])
  return reload
}
