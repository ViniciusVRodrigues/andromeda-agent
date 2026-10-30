import type { LocalActiveTask, TaskEndReason } from '../types.js';
import { localDayOf } from '../store/db.js';
import type { GitInfo } from './git.js';
import { taskRefFromBranch, type CompiledPattern } from './patterns.js';

export type LocalExpiryReason = 'DAY_ENDED' | 'BRANCH_CHANGED' | 'REPO_CHANGED';

export interface Expiry {
  reason: LocalExpiryReason;
  newBranch?: string;
  newRepo?: string;
}

export interface ExpiryInput {
  nowMs: number;
  timezone: string;
  /** Branch atual da pasta onde a tarefa foi marcada; null = desconhecida ou HEAD destacado. */
  currentBranch: string | null;
  /** Repos dos buckets com hora a partir de `since` (podem ter null e repetições). */
  bucketRepos?: Array<string | null>;
}

/** Dia local da tarefa; a gravada pelo 0.4 não tinha `day`, então vale o dia de `since`. */
export function taskDay(t: LocalActiveTask, timezone: string): string {
  return t.day ?? localDayOf(t.since, timezone);
}

/** Pura: por que a tarefa marcada deixou de valer, ou null se segue valendo. A ordem é dia, branch, repo. */
export function taskExpiry(t: LocalActiveTask, i: ExpiryInput): Expiry | null {
  if (localDayOf(i.nowMs, i.timezone) !== taskDay(t, i.timezone)) return { reason: 'DAY_ENDED' };
  // Branch ou pasta desconhecida (tarefa antiga, fora de git, HEAD destacado): não há o que comparar.
  if (t.branch && i.currentBranch && i.currentBranch !== t.branch) {
    return { reason: 'BRANCH_CHANGED', newBranch: i.currentBranch };
  }
  if (t.repo) {
    const other = (i.bucketRepos ?? []).find((r) => r !== null && r !== t.repo);
    if (other) return { reason: 'REPO_CHANGED', newRepo: other };
  }
  return null;
}

/** AB#123, ab#123 e 123 são o mesmo item. */
export function normalizeRef(ref: string): string {
  return ref.trim().replace(/^ab#/i, '').toLowerCase();
}

export function sameRef(a: string, b: string): boolean {
  return normalizeRef(a) === normalizeRef(b);
}

/** Branch atual da pasta (HEAD destacado e erro viram null). */
export async function branchOf(git: GitInfo, cwd: string | null | undefined): Promise<string | null> {
  if (!cwd) return null;
  try {
    const b = await git.currentBranch(cwd);
    return !b || b === 'HEAD' ? null : b;
  } catch {
    return null;
  }
}

/** Tarefa que os padrões tiram da branch, se for outro item que o marcado. */
export function branchOverride(branch: string | null, taskRef: string, patterns: CompiledPattern[]): string | null {
  const ref = taskRefFromBranch(branch, patterns);
  return ref && !sameRef(ref, taskRef) ? ref : null;
}

export type { TaskEndReason };
