import type { LocalActiveTask } from '../types.js';
import { sameRef } from '../task/expiry.js';
import type { LastTaskEnd } from '../task/task-state.js';

/** Os textos da tarefa ativa (CLI e MCP dizem as mesmas frases). Só ASCII nos símbolos; nada depende de cor. */

export const SUGGESTION_LINE = 'Todo uso chega como sugestão: confirme em Uso de IA.';
export const VALID_UNTIL = 'Vale até a meia-noite ou até você trocar de branch.';
const END_SHOWN_MS = 24 * 3_600_000;

export interface TaskView {
  task: LocalActiveTask | null;
  branch: string | null;
  branchRef: string | null;
  lastEnd: LastTaskEnd | null;
  nowMs: number;
  timezone: string;
}

/** HH:MM no fuso do agente. */
export function clockTime(ms: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('hour')}:${get('minute')}`;
}

/** `github.com/org/ui` vira `ui`. */
export function shortRepo(repo: string): string {
  const seg = repo.split('/').filter(Boolean);
  return seg[seg.length - 1] ?? repo;
}

/** Aviso de quando a branch aponta outro item que o marcado (a branch ganha). */
export function conflictWarning(taskRef: string, branch: string | null, branchRef: string | null): string | null {
  if (!branch || !branchRef || sameRef(branchRef, taskRef)) return null;
  return `Aviso: a branch ${branch} aponta ${branchRef}, e a branch ganha. Para o uso ir para ${taskRef}, troque de branch.`;
}

/** Frase do `task <ref>` (e do set_task do MCP). */
export function setTaskLines(taskRef: string, title: string, branch: string | null, branchRef: string | null): string[] {
  const lines = [`Tarefa ativa: ${taskRef}${title ? ` ${title}` : ''}. ${VALID_UNTIL}`];
  const w = conflictWarning(taskRef, branch, branchRef);
  if (w) lines.push(w);
  return lines;
}

function endReason(e: LastTaskEnd): string {
  switch (e.reason) {
    case 'BRANCH_CHANGED':
      return e.newBranch ? `você trocou para a branch ${e.newBranch}.` : 'você trocou de branch.';
    case 'REPO_CHANGED':
      return e.newRepo ? `você passou a usar o repositório ${shortRepo(e.newRepo)}.` : 'você trocou de repositório.';
    case 'DAY_ENDED':
      return 'o dia acabou.';
    case 'ITEM_CLOSED':
      return 'o item foi fechado.';
    case 'LEFT_SPRINT':
      return 'o item saiu da sprint.';
    default:
      return 'a tarefa foi encerrada.';
  }
}

/**
 * O bloco da tarefa ativa, nos 5 estados. Linhas sem o recuo geral; as de detalhe levam 2 espaços.
 * A última é sempre a de sugestão.
 */
export function taskStatusLines(v: TaskView): string[] {
  const out: string[] = [];
  const t = v.task;
  if (t) {
    const repo = t.repo ? ` (${shortRepo(t.repo)})` : '';
    out.push(`Tarefa ativa: ${t.taskRef}${t.title ? ` ${t.title}` : ''}${repo}, marcada às ${clockTime(t.since, v.timezone)}`);
    const w = conflictWarning(t.taskRef, v.branch, v.branchRef);
    if (w) {
      out.push(`  Aviso: a branch ${v.branch} aponta ${v.branchRef}. O uso vai para ${v.branchRef}.`);
      out.push(`  Para usar ${t.taskRef}, troque de branch.`);
    } else {
      out.push(`  ${VALID_UNTIL}`);
    }
  } else {
    const e = v.lastEnd;
    const recent = e !== null && v.nowMs - Date.parse(e.at) < END_SHOWN_MS && Date.parse(e.at) <= v.nowMs + 60_000;
    if (e && recent) {
      out.push('Tarefa ativa: nenhuma');
      out.push(`  ${e.taskRef} expirou às ${clockTime(Date.parse(e.at), v.timezone)}: ${endReason(e)}`);
      if (v.branchRef && (e.reason === 'BRANCH_CHANGED' || e.reason === 'REPO_CHANGED' || e.reason === 'DAY_ENDED')) {
        out.push(`  Agora o uso vai pela branch: ${v.branchRef}.`);
      }
      if (e.reason !== 'ITEM_CLOSED' && e.reason !== 'LEFT_SPRINT') out.push(`  Para marcar de novo: andromeda-agent task ${e.taskRef}`);
    } else if (v.branchRef) {
      out.push('Tarefa ativa: nenhuma (o uso vai pela branch)');
      out.push(`Branch ${v.branch}: ${v.branchRef}`);
    } else {
      out.push('Tarefa ativa: nenhuma');
      out.push(
        v.branch
          ? `Branch ${v.branch}: não indica tarefa. O uso vai para revisão em Uso de IA.`
          : 'Sem branch para indicar tarefa. O uso vai para revisão em Uso de IA.',
      );
    }
  }
  out.push(SUGGESTION_LINE);
  return out;
}
