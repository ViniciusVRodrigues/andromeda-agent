import type { AttributionMethod, Bucket, LocalActiveTask, ResolvedEvent, UsageEvent } from '../types.js';
import { branchAt, type GitInfo } from './git.js';
import { taskRefFromBranch, type CompiledPattern } from './patterns.js';

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
}

export function resolveTask(
  bucket: Bucket,
  ctx: TaskContext,
): { taskRef: string | null; attributionMethod: AttributionMethod } {
  const t = ctx.activeTask;
  if (t && bucket.hourStart + HOUR_LAST_MS >= t.since && (t.repo === null || t.repo === bucket.repo)) {
    return { taskRef: t.taskRef, attributionMethod: 'explicit' };
  }
  const ref = taskRefFromBranch(bucket.branch, ctx.patterns);
  if (ref) return { taskRef: ref, attributionMethod: 'branch' };
  return { taskRef: null, attributionMethod: 'none' };
}
