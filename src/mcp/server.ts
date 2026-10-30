import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { AGENT_VERSION } from '../types.js';
import { clearTask, currentTask, listTasks, setTask, type TaskOpsDeps } from '../agent/task-ops.js';
import { setTaskLines, taskStatusLines } from '../agent/task-text.js';

/**
 * Servidor MCP por stdio (JSON-RPC, uma mensagem por linha) com as três
 * operações do comando `task`. Sem SDK: o protocolo usado é pequeno e o
 * agente não ganha dependência. Descrições curtas de propósito: entram no
 * contexto de toda sessão das IAs (medição em docs/estudos/agt4-custo-mcp.md
 * do workspace).
 */

export const SERVER_NAME = 'andromeda';

/** Vai para o contexto da IA que mostra as instruções do servidor (Claude Code). */
export const INSTRUCTIONS =
  'O Andromeda atribui o uso de IA à tarefa ativa. Quando o usuário citar a tarefa (ex.: AB#123) ou o trabalho mudar de tarefa, chame set_task sem pedir confirmação e diga qual marcou.';

export const TOOLS = [
  {
    name: 'get_task',
    description: 'Tarefa ativa no Andromeda e a que a branch atual indica.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'set_task',
    description:
      'Marca a tarefa ativa no Andromeda (ex.: AB#123), que recebe o uso de IA. Use quando o usuário disser em que tarefa está ou ela mudar, sem pedir confirmação, e diga qual marcou. clear: true desmarca.',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string' }, clear: { type: 'boolean' } },
    },
  },
  {
    name: 'list_tasks',
    description: 'Lista as tarefas da sprint do usuário no Andromeda.',
    inputSchema: { type: 'object', properties: {} },
  },
] as const;

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export interface McpDeps {
  ops: TaskOpsDeps;
  cwd: string;
  describeError(e: unknown): string;
}

interface Request {
  jsonrpc?: string;
  id?: string | number | null;
  method?: unknown;
  params?: Record<string, unknown>;
}

class ToolInputError extends Error {}

async function callTool(d: McpDeps, name: unknown, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'get_task': {
      const c = await currentTask(d.ops, d.cwd);
      const view = { task: c.task, branch: c.branch, branchRef: c.branchRef, lastEnd: c.lastEnd, nowMs: d.ops.now(), timezone: d.ops.timezone };
      return taskStatusLines(view).map((l) => l.trim()).join('\n');
    }
    case 'set_task': {
      if (args.clear === true) {
        await clearTask(d.ops);
        return 'Tarefa ativa removida.';
      }
      const ref = typeof args.ref === 'string' ? args.ref.trim() : '';
      if (!ref) throw new ToolInputError('informe ref (ex.: AB#123) ou clear: true');
      const r = await setTask(d.ops, ref, d.cwd);
      const cur = await currentTask(d.ops, d.cwd);
      const [first, ...rest] = setTaskLines(r.task.taskRef, r.title, cur.branch, cur.branchRef);
      return [`${first} Linhas de uso de hoje reatribuídas: ${r.retroactiveRows}.`, ...rest].join('\n');
    }
    case 'list_tasks': {
      const items = await listTasks(d.ops);
      if (items.length === 0) return 'Nenhuma tarefa na sprint.';
      return items.map((t) => `${t.ref}\t${t.type}\t${t.title}\t${t.sprintName}`).join('\n');
    }
    default:
      throw new ToolInputError(`ferramenta desconhecida: ${String(name)}`);
  }
}

/** Responde a uma mensagem; null para notificações e respostas, que não têm volta. */
export async function handleMessage(d: McpDeps, msg: Request): Promise<object | null> {
  const id = msg.id;
  if (id === undefined || id === null || typeof msg.method !== 'string') return null;
  const ok = (result: object): object => ({ jsonrpc: '2.0', id, result });
  const fail = (code: number, message: string): object => ({ jsonrpc: '2.0', id, error: { code, message } });
  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion;
      const protocolVersion = typeof asked === 'string' && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0];
      return ok({
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: AGENT_VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: TOOLS });
    case 'tools/call': {
      const p = msg.params ?? {};
      const args = p.arguments && typeof p.arguments === 'object' ? (p.arguments as Record<string, unknown>) : {};
      if (!TOOLS.some((t) => t.name === p.name)) return fail(-32602, `ferramenta desconhecida: ${String(p.name)}`);
      try {
        return ok({ content: [{ type: 'text', text: await callTool(d, p.name, args) }] });
      } catch (e) {
        const text = e instanceof ToolInputError ? e.message : d.describeError(e);
        return ok({ content: [{ type: 'text', text }], isError: true });
      }
    }
    default:
      return fail(-32601, `método não suportado: ${msg.method}`);
  }
}

/** Lê do `input` até ele fechar; cada linha é uma mensagem. Nada além de JSON-RPC sai no `output`. */
export async function serveMcp(d: McpDeps, input: Readable, output: { write(s: string): unknown }): Promise<void> {
  const rl = createInterface({ input, crlfDelay: Infinity });
  const pending = new Set<Promise<void>>();
  const send = (o: object): void => void output.write(`${JSON.stringify(o)}\n`);
  for await (const raw of rl) {
    const text = raw.trim();
    if (!text) continue;
    let msg: Request;
    try {
      msg = JSON.parse(text) as Request;
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON inválido' } });
      continue;
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'requisição inválida' } });
      continue;
    }
    const job: Promise<void> = handleMessage(d, msg)
      .then((r) => {
        if (r) send(r);
      })
      .finally(() => pending.delete(job));
    pending.add(job);
  }
  await Promise.all(pending);
}
