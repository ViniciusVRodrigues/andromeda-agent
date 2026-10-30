import type { AgentApi, LocalActiveTask, TaskItem } from '../types.js';
import { Store, localDayOf } from '../store/db.js';
import type { GitInfo } from '../task/git.js';
import type { Logger } from '../log.js';
import { currentPatterns, refreshPatterns } from '../task/server-patterns.js';
import { taskRefFromBranch } from '../task/patterns.js';

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
}

export async function setTask(d: TaskOpsDeps, ref: string, cwd: string): Promise<SetTaskResult> {
  const now = d.now();
  const repo = await d.git.remoteOf(cwd);
  const resp = await d.api().setActiveTask({
    taskRef: ref,
    since: new Date(now).toISOString(),
    day: localDayOf(now, d.timezone),
    repo,
  });
  const task: LocalActiveTask = { taskRef: resp.ref || ref, since: now, repo };
  const store = d.openStore();
  try {
    store.setLocalActiveTask(task);
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
  } finally {
    store.close();
  }
}

export function listTasks(d: TaskOpsDeps): Promise<TaskItem[]> {
  return d.api().listTasks();
}

/** Só local: a tarefa marcada e o que a branch da pasta indica. Não fala com o servidor. */
export async function currentTask(d: TaskOpsDeps, cwd: string): Promise<CurrentTask> {
  const store = d.openStore();
  try {
    let branch: string | null = null;
    try {
      branch = await d.git.currentBranch(cwd);
    } catch {
      branch = null;
    }
    if (branch === 'HEAD') branch = null;
    return { task: store.getLocalActiveTask(), branch, branchRef: taskRefFromBranch(branch, currentPatterns(store)) };
  } finally {
    store.close();
  }
}
