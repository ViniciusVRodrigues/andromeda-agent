import type { AgentApi, LocalActiveTask, TaskItem } from '../types.js';
import { Store, localDayOf } from '../store/db.js';
import type { GitInfo } from '../task/git.js';
import type { Logger } from '../log.js';
import { currentPatterns, refreshPatterns } from '../task/server-patterns.js';
import { taskRefFromBranch } from '../task/patterns.js';
import { branchOf } from '../task/expiry.js';
import { enforceExpiry, getLastTaskEnd, setTaskConflict, type LastTaskEnd } from '../task/task-state.js';

/** O que as operações da tarefa ativa usam; o comando `task` e o MCP montam o mesmo. */
export interface TaskOpsDeps {
  api(): AgentApi;
  openStore(): Store;
  git: GitInfo;
  now(): number;
  timezone: string;
  log: Logger;
}

export interface SetTaskResult {
  task: LocalActiveTask;
  title: string;
  retroactiveRows: number;
}

export interface CurrentTask {
  task: LocalActiveTask | null;
  branch: string | null;
  /** Tarefa que os padrões de branch tiram da branch atual. */
  branchRef: string | null;
  /** Fim recente da tarefa anterior (expirou ou o servidor encerrou), se não há tarefa agora. */
  lastEnd: LastTaskEnd | null;
}

export async function setTask(d: TaskOpsDeps, ref: string, cwd: string): Promise<SetTaskResult> {
  const now = d.now();
  const repo = await d.git.remoteOf(cwd);
  const branch = await branchOf(d.git, cwd);
  const day = localDayOf(now, d.timezone);
  const resp = await d.api().setActiveTask({
    taskRef: ref,
    since: new Date(now).toISOString(),
    day,
    repo,
    branch,
  });
  const task: LocalActiveTask = { taskRef: resp.ref || ref, since: now, repo, title: resp.title, branch, cwd, day };
  const store = d.openStore();
  try {
    store.setLocalActiveTask(task);
    store.deleteMeta('last_task_end');
    store.deleteMeta('task_end_pending');
    setTaskConflict(store, null);
    // Aproveita para renovar os padrões de branch (no máximo uma busca por hora).
    await refreshPatterns(store, d.api(), now, d.log);
  } finally {
    store.close();
  }
  return { task, title: resp.title, retroactiveRows: resp.retroactiveRows };
}

export async function clearTask(d: TaskOpsDeps): Promise<void> {
  await d.api().clearActiveTask();
  const store = d.openStore();
  try {
    store.setLocalActiveTask(null);
    store.deleteMeta('last_task_end');
    store.deleteMeta('task_end_pending');
    setTaskConflict(store, null);
  } finally {
    store.close();
  }
}

export function listTasks(d: TaskOpsDeps): Promise<TaskItem[]> {
  return d.api().listTasks();
}

/**
 * Só local: a tarefa marcada e o que a branch da pasta indica. Não fala com o servidor. Se a tarefa
 * já venceu (virou o dia, outra branch) e o laço ainda não viu, expira aqui; o laço manda o DELETE.
 */
export async function currentTask(d: TaskOpsDeps, cwd: string): Promise<CurrentTask> {
  const store = d.openStore();
  try {
    const branch = await branchOf(d.git, cwd);
    try {
      await enforceExpiry(store, d.git, d.now(), d.timezone);
    } catch {
      /* conferir não derruba o status */
    }
    const task = store.getLocalActiveTask();
    const branchRef = taskRefFromBranch(branch, currentPatterns(store));
    return { task, branch, branchRef, lastEnd: task ? null : getLastTaskEnd(store) };
  } finally {
    store.close();
  }
}
