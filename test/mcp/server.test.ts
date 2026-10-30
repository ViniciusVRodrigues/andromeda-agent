import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { runCli } from '../../src/agent/commands.js';
import { handleMessage, INSTRUCTIONS, TOOLS, type McpDeps } from '../../src/mcp/server.js';
import { nullLogger } from '../../src/log.js';
import { Store, localDayOf } from '../../src/store/db.js';
import { createGit } from '../../src/task/git.js';
import { ApiError } from '../../src/types.js';
import type { SetActiveTaskRequest } from '../../src/types.js';
import { FakeServer } from '../sync/fake-server.js';
import { makeCtx, makeSandbox, type Sandbox } from '../agent/helpers.js';

function mkDeps(sb: Sandbox, api: FakeServer): McpDeps {
  return {
    ops: { api: () => api, openStore: () => Store.open(sb.state), git: createGit(), now: () => Date.now(), timezone: 'UTC', log: nullLogger },
    cwd: sb.repo,
    describeError: (e) => (e instanceof Error ? e.message : String(e)),
  };
}

type Res = { result?: any; error?: { code: number; message: string } };
const call = async (d: McpDeps, method: string, params?: object, id: number | string = 1): Promise<Res> =>
  (await handleMessage(d, { jsonrpc: '2.0', id, method, ...(params ? { params: params as Record<string, unknown> } : {}) })) as Res;
const tool = (d: McpDeps, name: string, args: object = {}): Promise<Res> => call(d, 'tools/call', { name, arguments: args });

test('mcp: initialize devolve a versão pedida se conhecida, senão a mais nova, com instruções', async () => {
  const sb = makeSandbox();
  try {
    const d = mkDeps(sb, new FakeServer());
    const a = await call(d, 'initialize', { protocolVersion: '2024-11-05' });
    assert.equal(a.result.protocolVersion, '2024-11-05');
    assert.equal(a.result.instructions, INSTRUCTIONS);
    assert.equal(a.result.serverInfo.name, 'andromeda');
    assert.deepEqual(a.result.capabilities, { tools: {} });
    const b = await call(d, 'initialize', { protocolVersion: '1999-01-01' });
    assert.equal(b.result.protocolVersion, '2025-11-25');
    const c = await call(d, 'initialize', {});
    assert.equal(c.result.protocolVersion, '2025-11-25');
  } finally {
    sb.cleanup();
  }
});

test('mcp: tools/list, ping, notificação sem resposta, método desconhecido', async () => {
  const sb = makeSandbox();
  try {
    const d = mkDeps(sb, new FakeServer());
    const l = await call(d, 'tools/list');
    assert.deepEqual(
      l.result.tools.map((t: { name: string }) => t.name),
      ['get_task', 'set_task', 'list_tasks'],
    );
    assert.equal(l.result.tools.length, TOOLS.length);
    assert.deepEqual((await call(d, 'ping')).result, {});
    assert.equal(await handleMessage(d, { jsonrpc: '2.0', method: 'notifications/initialized' }), null);
    const u = await call(d, 'resources/list');
    assert.equal(u.error?.code, -32601);
    const bad = await tool(d, 'nao_existe');
    assert.equal(bad.error?.code, -32602);
  } finally {
    sb.cleanup();
  }
});

test('mcp: get_task é só local (não chama a API) com e sem tarefa', async () => {
  const sb = makeSandbox();
  try {
    const api = new FakeServer();
    const boom = async (): Promise<never> => {
      throw new Error('API não deveria ser chamada');
    };
    api.setActiveTask = boom;
    api.clearActiveTask = boom;
    api.listTasks = boom;
    const d = mkDeps(sb, api);
    const none = await tool(d, 'get_task');
    assert.equal(none.result.isError, undefined);
    assert.match(none.result.content[0].text, /^Tarefa ativa: nenhuma\nBranch main: não indica tarefa\. O uso vai para revisão em Uso de IA\.\nTodo uso chega como sugestão: confirme em Uso de IA\.$/);
    const s = Store.open(sb.state);
    s.setLocalActiveTask({ taskRef: 'AB#7', since: Date.now() - 60_000, repo: 'github.com/acme/repo', title: 'Fazer sete', day: localDayOf(Date.now(), 'UTC') });
    s.close();
    const some = await tool(d, 'get_task');
    assert.match(some.result.content[0].text, /^Tarefa ativa: AB#7 Fazer sete \(repo\), marcada às \d\d:\d\d\nVale até a meia-noite ou até você trocar de branch\.\nTodo uso chega como sugestão: confirme em Uso de IA\.$/);
  } finally {
    sb.cleanup();
  }
});

test('mcp: set_task com ref chama a API com o repo do cwd e grava local; clear desmarca; sem ref é erro', async () => {
  const sb = makeSandbox();
  try {
    const api = new FakeServer();
    const reqs: SetActiveTaskRequest[] = [];
    let cleared = 0;
    api.setActiveTask = async (r: unknown) => {
      const req = r as SetActiveTaskRequest;
      reqs.push(req);
      return { workItemId: 'w', ref: 'AB#5', title: 'Fazer X', retroactiveRows: 2 };
    };
    api.clearActiveTask = async () => void cleared++;
    const d = mkDeps(sb, api);
    const r = await tool(d, 'set_task', { ref: ' AB#5 ' });
    assert.equal(r.result.isError, undefined);
    assert.match(r.result.content[0].text, /^Tarefa ativa: AB#5 Fazer X\. Vale até a meia-noite ou até você trocar de branch\. Linhas de uso de hoje reatribuídas: 2\.$/);
    assert.equal(reqs.length, 1);
    assert.equal(reqs[0]!.taskRef, 'AB#5');
    assert.equal(reqs[0]!.repo, 'github.com/acme/repo');
    let s = Store.open(sb.state);
    assert.equal(s.getLocalActiveTask()?.taskRef, 'AB#5');
    s.close();

    const c = await tool(d, 'set_task', { clear: true });
    assert.equal(c.result.content[0].text, 'Tarefa ativa removida.');
    assert.equal(cleared, 1);
    s = Store.open(sb.state);
    assert.equal(s.getLocalActiveTask(), null);
    s.close();

    const e = await tool(d, 'set_task', {});
    assert.equal(e.result.isError, true);
    assert.match(e.result.content[0].text, /informe ref/);
    assert.equal(reqs.length, 1);
  } finally {
    sb.cleanup();
  }
});

test('mcp: list_tasks e erro da API virando isError', async () => {
  const sb = makeSandbox();
  try {
    const api = new FakeServer();
    const d = mkDeps(sb, api);
    assert.equal((await tool(d, 'list_tasks')).result.content[0].text, 'Nenhuma tarefa na sprint.');
    api.listTasks = async () => [{ workItemId: 'w', ref: 'AB#1', externalId: '1', title: 'Um', type: 'Task', sprintName: 'S1' }];
    assert.equal((await tool(d, 'list_tasks')).result.content[0].text, 'AB#1\tTask\tUm\tS1');
    api.listTasks = async () => {
      throw new ApiError('x', 0, null, null);
    };
    const e = await tool(d, 'list_tasks');
    assert.equal(e.result.isError, true);
    assert.equal(e.result.content[0].text, 'x');
  } finally {
    sb.cleanup();
  }
});

test('mcp: runCli mcp só escreve JSON-RPC no out; erros e não pareado viram isError com a mensagem do CLI', async () => {
  const sb = makeSandbox();
  try {
    const lines = [
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}',
      '{"jsonrpc":"2.0","method":"notifications/initialized"}',
      '{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
      'isto não é json',
      '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_tasks","arguments":{}}}',
      '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"get_task"}}',
      '',
    ].map((l) => l + '\n');
    const { ctx, cap } = makeCtx(sb, { stdin: Readable.from(lines) });
    assert.equal(await runCli(['mcp'], ctx), 0);
    assert.equal(cap.err.join(''), '');
    const msgs = cap.out.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(msgs.length, 5, 'a notificação não tem resposta');
    for (const m of msgs) assert.equal(m.jsonrpc, '2.0');
    const byId = (id: number | null) => msgs.find((m) => m.id === id);
    assert.equal(byId(1).result.protocolVersion, '2025-06-18');
    assert.equal(byId(2).result.tools.length, 3);
    assert.equal(byId(null).error.code, -32700);
    assert.equal(byId(3).result.isError, true);
    assert.match(byId(3).result.content[0].text, /não está pareado/);
    assert.match(byId(4).result.content[0].text, /Tarefa ativa: nenhuma/);
  } finally {
    sb.cleanup();
  }
});

test('mcp: set_task com a branch apontando outro item devolve o aviso; get_task mostra a branch ganhando', async () => {
  const sb = makeSandbox();
  try {
    execFileSync('git', ['-C', sb.repo, 'symbolic-ref', 'HEAD', 'refs/heads/feature/AB#4812-custo'], { stdio: 'ignore' });
    const api = new FakeServer();
    api.setActiveTask = async () => ({ workItemId: 'w', ref: 'AB#4790', title: 'Tela', retroactiveRows: 0 });
    const d = mkDeps(sb, api);
    const r = await tool(d, 'set_task', { ref: 'AB#4790' });
    assert.equal(
      r.result.content[0].text,
      'Tarefa ativa: AB#4790 Tela. Vale até a meia-noite ou até você trocar de branch. Linhas de uso de hoje reatribuídas: 0.\n' +
        'Aviso: a branch feature/AB#4812-custo aponta AB#4812, e a branch ganha. Para o uso ir para AB#4790, troque de branch.',
    );
    const g = await tool(d, 'get_task');
    assert.match(
      g.result.content[0].text,
      /^Tarefa ativa: AB#4790 Tela \(repo\), marcada às \d\d:\d\d\nAviso: a branch feature\/AB#4812-custo aponta AB#4812\. O uso vai para AB#4812\.\nPara usar AB#4790, troque de branch\.\nTodo uso/,
    );
  } finally {
    sb.cleanup();
  }
});
