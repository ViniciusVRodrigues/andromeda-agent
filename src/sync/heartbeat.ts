import type { HeartbeatRequest } from '../types.js';
import type { Store } from '../store/db.js';

export const HEARTBEAT_INTERVAL_MS = 3_600_000;

export function buildHeartbeat(store: Store, agentVersion: string, timezone: string): HeartbeatRequest {
  const s = store.stats();
  return { agentVersion, timezone, pendingRows: s.pending, oldestPendingDay: s.oldestPendingDay };
}

export function heartbeatDue(lastMs: number | null | undefined, nowMs: number): boolean {
  return lastMs === null || lastMs === undefined || nowMs - lastMs >= HEARTBEAT_INTERVAL_MS;
}
