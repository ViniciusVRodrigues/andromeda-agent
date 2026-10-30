import type { HeartbeatRequest } from '../types.js';
import type { Store } from '../store/db.js';
import { conflictForHeartbeat } from '../task/task-state.js';

/** Um heartbeat por volta do laço (60 s); devido com folga de 10 s. */
export const HEARTBEAT_INTERVAL_MS = 60_000;
export const HEARTBEAT_DUE_MS = 50_000;

export function buildHeartbeat(store: Store, agentVersion: string, timezone: string, syncServed?: string | null, nowMs: number = Date.now()): HeartbeatRequest {
  const s = store.stats();
  const req: HeartbeatRequest = { agentVersion, timezone, pendingRows: s.pending, oldestPendingDay: s.oldestPendingDay };
  if (syncServed) req.syncServed = syncServed;
  const conflict = conflictForHeartbeat(store, nowMs, timezone);
  if (conflict !== undefined) req.taskConflict = conflict;
  return req;
}

export function heartbeatDue(lastMs: number | null | undefined, nowMs: number): boolean {
  return lastMs === null || lastMs === undefined || !Number.isFinite(lastMs) || nowMs - lastMs >= HEARTBEAT_DUE_MS;
}
