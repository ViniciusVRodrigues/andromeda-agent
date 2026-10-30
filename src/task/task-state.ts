import { ApiError, type ClearActiveTaskRequest, type AgentApi, TaskConflict, TaskEndReason } from '../types.js';
import { localDayOf, type Store } from '../store/db.js';
import type { GitInfo } from './git.js';
import { branchOf, taskExpiry, type Expiry } from './expiry.js';

/** Última tarefa que acabou sem o dev pedir (meta `last_task_end`). */
export interface LastTaskEnd {
  taskRef: string;
  title?: string;
  reason: TaskEndReason | string;
  /** ISO. */
  at: string;
  newBranch?: string;
  newRepo?: string;
}

const readJson = <T>(store: Store, k: string): T | null => {
  const v = store.getMeta(k);
  if (!v) return null;
  try {
    return JSON.parse(v) as T;
  } catch {
    return null;
  }
};

export const getLastTaskEnd = (s: Store): LastTaskEnd | null => readJson<LastTaskEnd>(s, 'last_task_end');
export const setLastTaskEnd = (s: Store, e: LastTaskEnd): void => s.setMeta('last_task_end', JSON.stringify(e));
export const getPendingEnd = (s: Store): ClearActiveTaskRequest | null => readJson<ClearActiveTaskRequest>(s, 'task_end_pending');

/** Conflito de hoje; `null` guardado = já houve e foi limpo (o heartbeat manda null uma vez por volta). */
export function getTaskConflict(s: Store): TaskConflict | null {
  const c = readJson<TaskConflict>(s, 'task_conflict');
  return c && typeof c === 'object' ? c : null;
}

export function setTaskConflict(s: Store, c: TaskConflict | null): void {
  if (c) s.setMeta('task_conflict', JSON.stringify(c));
  else if (s.getMeta('task_conflict') !== null) s.setMeta('task_conflict', 'null');
}

/** Valor para o heartbeat: ausente (undefined) se nunca houve; null se não há (ou é de outro dia). */
export function conflictForHeartbeat(s: Store, nowMs: number, timezone: string): TaskConflict | null | undefined {
  if (s.getMeta('task_conflict') === null) return undefined;
  const c = getTaskConflict(s);
  if (!c) return null;
  const at = Date.parse(c.at);
  return Number.isFinite(at) && localDayOf(at, timezone) === localDayOf(nowMs, timezone) ? c : null;
}

/** A tarefa local deixa de valer: limpa, registra o fim e deixa o DELETE pendente. */
export function expireLocal(s: Store, why: Expiry, nowMs: number): void {
  const t = s.getLocalActiveTask();
  if (t) {
    const end: LastTaskEnd = { taskRef: t.taskRef, reason: why.reason, at: new Date(nowMs).toISOString() };
    if (t.title) end.title = t.title;
    if (why.newBranch) end.newBranch = why.newBranch;
    if (why.newRepo) end.newRepo = why.newRepo;
    setLastTaskEnd(s, end);
  }
  s.setLocalActiveTask(null);
  setTaskConflict(s, null);
  const req: ClearActiveTaskRequest = { reason: why.reason };
  if (why.newBranch) req.newBranch = why.newBranch;
  if (why.newRepo) req.newRepo = why.newRepo;
  s.setMeta('task_end_pending', JSON.stringify(req));
}

/**
 * Confere a tarefa marcada (dia, branch e, se vierem, repos dos buckets) e expira se preciso.
 * Devolve o motivo, ou null se segue valendo.
 */
export async function enforceExpiry(
  s: Store,
  git: GitInfo,
  nowMs: number,
  timezone: string,
  bucketRepos?: Array<string | null>,
): Promise<Expiry | null> {
  const t = s.getLocalActiveTask();
  if (!t) return null;
  const why = taskExpiry(t, { nowMs, timezone, currentBranch: await branchOf(git, t.cwd), bucketRepos });
  if (why) expireLocal(s, why, nowMs);
  return why;
}

/** Manda o DELETE pendente; se falhar, fica para a volta seguinte. */
export async function flushPendingEnd(s: Store, api: AgentApi): Promise<boolean> {
  const req = getPendingEnd(s);
  if (!req) return true;
  try {
    await api.clearActiveTask(req);
    s.deleteMeta('task_end_pending');
    return true;
  } catch (e) {
    // Recusa definitiva (a tarefa já nem existe lá): não adianta tentar de novo.
    if (e instanceof ApiError && e.status >= 400 && e.status < 500 && ![401, 408, 429].includes(e.status)) {
      s.deleteMeta('task_end_pending');
      return true;
    }
    return false;
  }
}
