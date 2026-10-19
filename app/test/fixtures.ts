import type { Session } from '../src/shared/protocol'

let n = 0
export function session(over: Partial<Session> = {}): Session {
  n++
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    claude_session_id: `c-${n}`,
    profile: 'default',
    cwd: '/home/u/code/projet',
    project_root: '/home/u/code/projet',
    branch: 'main',
    model: null,
    mode: 'default',
    status: { state: 'running' },
    pending: [],
    possibly_stale: false,
    metrics: null,
    last_activity: '2026-10-19T10:00:00Z',
    created_at: '2026-10-19T09:00:00Z',
    updated_at: '2026-10-19T10:00:00Z',
    alive: true,
    pid: 1234,
    last_exit: null,
    size: { cols: 80, rows: 24 },
    ...over,
  }
}
