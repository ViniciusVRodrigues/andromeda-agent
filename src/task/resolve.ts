import type { AttributionMethod, Bucket, LocalActiveTask, ResolvedEvent, UsageEvent } from '../types.js';
import { branchAt, type GitInfo } from './git.js';
import { taskRefFromBranch, type CompiledPattern } from './patterns.js';
import { sameRef, taskDay } from './expiry.js';

const HOUR_LAST_MS = 3_599_999;

function cleanBranch(b: string | null | undefined): string | null {
  return !b || b === 'HEAD' ? null : b;
}

export async function resolveEvent(e: UsageEvent, git: GitInfo): Promise<ResolvedEvent> {
  const repo = e.cwd ? await git.remoteOf(e.cwd) : null;
  let branch: string | null = null;
  let approx = false;

  if (e.branchSource === 'log') {
    branch = cleanBranch(e.branch);
  } else {
    if (e.cwd) {
      const sw = await git.reflogSwitches(e.cwd);
      if (sw) branch = cleanBranch(branchAt(sw, e.timestamp));
      if (branch === null) {
        branch = cleanBranch(await git.currentBranch(e.cwd));
        if (branch !== null) approx = true;
      }
    }
    if (branch === null) {
      branch = cleanBranch(e.branch);
      if (branch !== null) approx = true;
    }
  }
  return { ...e, repo, resolvedBranch: branch, branchApprox: approx };
}

export interface TaskContext {
  activeTask: LocalActiveTask | null;
  patterns: CompiledPattern[];
  /** Fuso do agente; só serve para a tarefa gravada pelo 0.4, sem `day`. */
  timezone?: string;
}

export interface TaskConflictFound {
  taskRef: string;
  branch: string;
  branchRef: string;
}

export interface ResolvedTask {
  taskRef: string | null;
  attributionMethod: AttributionMethod;
  /** A branch do bucket indica outro item que o marcado: a branch ganhou. */
  conflict?: TaskConflictFound;
}

/** A tarefa marcada vale para o bucket: hora, mesmo dia local, mesmo repo e mesma branch (quando há). */
export function taskAppliesTo(t: LocalActiveTask, bucket: Bucket, timezone = 'UTC'): boolean {
  if (bucket.hourStart + HOUR_LAST_MS < t.since) return false;
  if (bucket.day !== taskDay(t, timezone)) return false;
  if (t.repo !== null && t.repo !== bucket.repo) return false;
  if (t.branch && bucket.branch && t.branch !== bucket.branch) return false;
  return true;
}

export function resolveTask(bucket: Bucket, ctx: TaskContext): ResolvedTask {
  const t = ctx.activeTask;
  const branchRef = taskRefFromBranch(bucket.branch, ctx.patterns);
  if (t && taskAppliesTo(t, bucket, ctx.timezone)) {
    // A branch ganha da tarefa marcada quando aponta outro item.
    if (branchRef && bucket.branch && !sameRef(branchRef, t.taskRef)) {
      return {
        taskRef: null,
        attributionMethod: 'branch',
        conflict: { taskRef: t.taskRef, branch: bucket.branch, branchRef },
      };
    }
    return { taskRef: t.taskRef, attributionMethod: 'explicit' };
  }
  // O taskRef da linha é sempre explícito para o servidor (sem a checagem da sprint).
  // Da branch o agente só informa o método; quem resolve é o servidor.
  if (branchRef) return { taskRef: null, attributionMethod: 'branch' };
  return { taskRef: null, attributionMethod: 'none' };
}
