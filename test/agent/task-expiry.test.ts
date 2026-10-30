import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { cycle, newMemory, type AgentDeps } from '../../src/agent/loop.js';
import { runCli } from '../../src/agent/commands.js';
import { Store, localDayOf } from '../../src/store/db.js';
import { parsers } from '../../src/parsers/index.js';
import { FileCredentialStore } from '../../src/auth/tokens.js';
import { createGit } from '../../src/task/git.js';
import { getLastTaskEnd, getPendingEnd } from '../../src/task/task-state.js';
import type { LocalActiveTask } from '../../src/types.js';
import { FakeServer } from '../sync/fake-server.js';
import { claudeLine, fakeCreds, fakeRunner, HOUR, makeCtx, makeSandbox, writeText, type Sandbox } from './helpers.js';

// 30/10/2026 12:00 UTC: fixo, longe da virada do dia.
const T = Date.UTC(2026, 9, 30, 12, 0, 0);
const DAY = '2026-10-30';

async function setup(): Promise<{ sb: Sandbox; store: Store; api: FakeServer; mk: (now: number) => AgentDeps }> {
  const sb = makeSandbox();
  const store = Store.open(sb.state);
  const creds = new FileCredentialStore(sb.state, () => {});
  await creds.save(fakeCreds());
  const api = new FakeServer();
  const mk = (now: number): AgentDeps => ({
    store,
    api,
    creds,
    parsers,
    git: createGit(),
    env: { home: sb.home, env: sb.env },
    timezone: 'UTC',
    now: () => now,
  });
  return { sb, store, api, mk };
}

const mkTask = (o: Partial<LocalActiveTask> = {}): LocalActiveTask => ({
  taskRef: 'AB#1',
  since: T - 600_000,
  repo: null,
  title: 'Primeira',
  branch: 'main',
  cwd: '',
  day: DAY,
  ...o,
});
const checkout = (sb: Sandbox, b: string): void => void execFileSync('git', ['-C', sb.repo, 'symbolic-ref', 'HEAD', `refs/heads/${b}`], { stdio: 'ignore' });
/** O servidor ainda tem a tarefa (como tem de verdade depois de `task <ref>`): o heartbeat a devolve. */
const serverHas = (api: FakeServer, t: LocalActiveTask): void => {
  api.heartbeatExtra = { ...api.heartbeatExtra, activeTask: { workItemId: 'w', ref: t.taskRef, title: t.title ?? '', since: new Date(t.since).toISOString(), repository: t.repo, branch: t.branch ?? null, day: t.day } };
};
const put = (store: Store, api: FakeServer, t: LocalActiveTask): void => {
  store.setLocalActiveTask(t);
  serverHas(api, t);
};
const writeLog = (sb: Sandbox, o: { id: string; ts: number; branch?: string }): void =>
  writeText(join(sb.home, '.claude', 'projects', 'p', `${o.id}.jsonl`), claudeLine({ id: o.id, ts: o.ts, cwd: sb.repo, branch: o.branch, input: 1, output: 1 }));

test('laço: trocar de branch expira a tarefa, grava o fim e manda o DELETE com o motivo', async () => {
  const { sb, store, api, mk } = await setup();
  try {
    put(store, api, mkTask({ cwd: sb.repo }));
    checkout(sb, 'feature/4812-custo');
    await cycle(mk(T), newMemory());
    assert.equal(store.getLocalActiveTask(), null);
    assert.deepEqual(api.clearCalls, [{ reason: 'BRANCH_CHANGED', newBranch: 'feature/4812-custo' }]);
    const end = getLastTaskEnd(store);
    assert.equal(end?.taskRef, 'AB#1');
    assert.equal(end?.reason, 'BRANCH_CHANGED');
    assert.equal(end?.newBranch, 'feature/4812-custo');
    assert.equal(getPendingEnd(store), null);
  } finally {
    store.close();
    sb.cleanup();
  }
});

test('laço: virar o dia local expira com DAY_ENDED', async () => {
  const { sb, store, api, mk } = await setup();
  try {
    put(store, api, mkTask({ cwd: sb.repo }));
    await cycle(mk(T + 6 * HOUR), newMemory()); // ainda 30/10 (18:00)
    assert.equal(store.getLocalActiveTask()?.taskRef, 'AB#1');
    assert.equal(api.clearCalls.length, 0);
    await cycle(mk(Date.UTC(2026, 9, 31, 0, 1, 0)), newMemory());
    assert.equal(store.getLocalActiveTask(), null);
    assert.deepEqual(api.clearCalls, [{ reason: 'DAY_ENDED' }]);
    assert.equal(getLastTaskEnd(store)?.reason, 'DAY_ENDED');
  } finally {
    store.close();
    sb.cleanup();
  }
});

test('laço: DELETE que falha fica pendente, a tarefa do servidor não volta, e vai na volta seguinte', async () => {
  const { sb, store, api, mk } = await setup();
  try {
    // o servidor ainda acha que a tarefa existe
    put(store, api, mkTask({ cwd: sb.repo }));
    checkout(sb, 'outra');
    api.clearFails = 2; // a volta tenta antes do heartbeat e de novo depois da coleta
    await cycle(mk(T), newMemory());
    assert.equal(api.clearCalls.length, 2);
    assert.deepEqual(getPendingEnd(store), { reason: 'BRANCH_CHANGED', newBranch: 'outra' });
    assert.equal(store.getLocalActiveTask(), null, 'a tarefa local já não vale, nem com o servidor ainda a devolvendo');
    await cycle(mk(T + 60_000), newMemory());
    assert.equal(api.clearCalls.length, 3);
    assert.deepEqual(api.clearCalls[2], { reason: 'BRANCH_CHANGED', newBranch: 'outra' });
    assert.equal(getPendingEnd(store), null);
  } finally {
    store.close();
    sb.cleanup();
  }
});

test('laço: activeTaskEnded do heartbeat encerra a tarefa local uma vez só', async () => {
  const { sb, store, api, mk } = await setup();
  try {
    store.setLocalActiveTask(mkTask({ cwd: sb.repo }));
    const endedAt = new Date(T).toISOString();
    api.heartbeatExtra = { activeTaskEnded: { ref: 'AB#1', title: 'Primeira', reason: 'ITEM_CLOSED', endedAt, newBranch: null, newRepo: null } };
    await cycle(mk(T), newMemory());
    assert.equal(store.getLocalActiveTask(), null);
    assert.deepEqual(getLastTaskEnd(store), { taskRef: 'AB#1', title: 'Primeira', reason: 'ITEM_CLOSED', at: endedAt });
    assert.equal(api.clearCalls.length, 0, 'o fim veio do servidor: nada de DELETE');
    // mesmo endedAt de novo: ignorado, não regrava o fim
    store.deleteMeta('last_task_end');
    await cycle(mk(T + 60_000), newMemory());
    assert.equal(getLastTaskEnd(store), null);
  } finally {
    store.close();
    sb.cleanup();
  }
});

test('laço: activeTaskEnded CLEARED não vira "expirou"', async () => {
  const { sb, store, api, mk } = await setup();
  try {
    store.setLocalActiveTask(mkTask({ cwd: sb.repo }));
    api.heartbeatExtra = { activeTaskEnded: { ref: 'AB#1', reason: 'CLEARED', endedAt: new Date(T).toISOString() } };
    await cycle(mk(T), newMemory());
    assert.equal(getLastTaskEnd(store), null);
  } finally {
    store.close();
    sb.cleanup();
  }
});

test('coleta: a branch ganha da tarefa marcada, guarda o conflito e o heartbeat o leva; sem conflito, limpa', async () => {
  const { sb, store, api, mk } = await setup();
  try {
    put(store, api, mkTask({ taskRef: 'AB#4790', branch: null, cwd: sb.repo, since: T - 3600_000 }));
    writeLog(sb, { id: 'a', ts: T - 1000, branch: 'feature/AB#4812-custo' });
    await cycle(mk(T), newMemory());
    const c = JSON.parse(store.getMeta('task_conflict') ?? 'null');
    assert.equal(c.taskRef, 'AB#4790');
    assert.equal(c.branch, 'feature/AB#4812-custo');
    assert.equal(c.branchRef, 'AB#4812');
    assert.equal(c.repo, 'github.com/acme/repo');
    const rows = [...api.rows.values()];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.taskRef ?? null, null);
    assert.equal(rows[0]!.attributionMethod, 'branch');
    // o heartbeat que vem depois da coleta leva o conflito
    await cycle(mk(T + 60_000), newMemory());
    const last = api.heartbeats[api.heartbeats.length - 1]!;
    assert.equal(last.taskConflict?.taskRef, 'AB#4790');
    // coleta de hoje sem conflito (a branch agora é a da tarefa) limpa: o heartbeat manda null
    writeLog(sb, { id: 'b', ts: T + 30_000, branch: 'feature/AB#4790-x' });
    await cycle(mk(T + 900_000), newMemory());
    await cycle(mk(T + 960_000), newMemory());
    assert.equal(api.heartbeats[api.heartbeats.length - 1]!.taskConflict, null);
  } finally {
    store.close();
    sb.cleanup();
  }
});

test('heartbeat: sem conflito nunca visto, o campo taskConflict nem vai', async () => {
  const { sb, store, api, mk } = await setup();
  try {
    await cycle(mk(T), newMemory());
    assert.equal('taskConflict' in api.heartbeats[0]!, false);
  } finally {
    store.close();
    sb.cleanup();
  }
});

test('coleta: bucket de outro repo depois de since expira com REPO_CHANGED', async () => {
  const { sb, store, api, mk } = await setup();
  try {
    put(store, api, mkTask({ branch: null, cwd: sb.repo, repo: 'github.com/outro/repo' }));
    writeLog(sb, { id: 'c', ts: T + HOUR + 1000, branch: 'main' }); // hora seguinte à marcação
    await cycle(mk(T + 2 * HOUR), newMemory());
    assert.equal(store.getLocalActiveTask(), null);
    assert.deepEqual(api.clearCalls, [{ reason: 'REPO_CHANGED', newRepo: 'github.com/acme/repo' }]);
    assert.equal(getLastTaskEnd(store)?.newRepo, 'github.com/acme/repo');
  } finally {
    store.close();
    sb.cleanup();
  }
});

test('coleta: tarefa gravada pelo 0.4 (sem branch, cwd e day) segue valendo no mesmo dia', async () => {
  const { sb, store, api, mk } = await setup();
  try {
    put(store, api, { taskRef: 'AB#1', since: T - 600_000, repo: null, day: DAY } as LocalActiveTask);
    store.setLocalActiveTask({ taskRef: 'AB#1', since: T - 600_000, repo: null } as LocalActiveTask); // como o 0.4 gravava
    writeLog(sb, { id: 'd', ts: T - 1000, branch: 'main' });
    await cycle(mk(T), newMemory());
    assert.equal(store.getLocalActiveTask()?.taskRef, 'AB#1');
    assert.equal(api.clearCalls.length, 0);
    assert.equal([...api.rows.values()][0]!.taskRef, 'AB#1');
  } finally {
    store.close();
    sb.cleanup();
  }
});

// ---- textos do CLI ----

const mkCli = (sb: Sandbox, now: number, api?: FakeServer) =>
  makeCtx(sb, { runner: fakeRunner(1), platform: 'linux', cliPath: '/x/cli.js', uid: 1, now: () => now, ...(api ? { api } : {}) });
const taskBlock = (text: string): string => {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.startsWith('  Tarefa ativa:'));
  return lines.slice(i, lines.findIndex((l) => l.includes('Todo uso chega')) + 1).join('\n');
};

test('status: os 5 estados da tarefa ativa', async () => {
  const { sb, store } = await setup();
  try {
    const now = Date.now();
    const day = localDayOf(now, 'UTC');
    const since = now - 120_000;
    const hhmm = new Date(since).toISOString().slice(11, 16);
    const LAST = '  Todo uso chega como sugestão: confirme em Uso de IA.';

    // 1) sem tarefa, a branch aponta
    checkout(sb, 'feature/AB#4812-custo');
    let c = mkCli(sb, now);
    assert.equal(await runCli(['status'], c.ctx), 0);
    assert.equal(taskBlock(c.cap.text()), ['  Tarefa ativa: nenhuma (o uso vai pela branch)', '  Branch feature/AB#4812-custo: AB#4812', LAST].join('\n'));

    // 2) sem tarefa, a branch não aponta
    checkout(sb, 'main');
    c = mkCli(sb, now);
    await runCli(['status'], c.ctx);
    assert.equal(
      taskBlock(c.cap.text()),
      ['  Tarefa ativa: nenhuma', '  Branch main: não indica tarefa. O uso vai para revisão em Uso de IA.', LAST].join('\n'),
    );

    // 3) marcada e valendo
    store.setLocalActiveTask(mkTask({ taskRef: 'AB#4790', title: 'Tela do Conector de IA', repo: 'github.com/org/andromeda-ui', since, day, cwd: sb.repo }));
    c = mkCli(sb, now);
    await runCli(['status'], c.ctx);
    assert.equal(
      taskBlock(c.cap.text()),
      [`  Tarefa ativa: AB#4790 Tela do Conector de IA (andromeda-ui), marcada às ${hhmm}`, '    Vale até a meia-noite ou até você trocar de branch.', LAST].join('\n'),
    );

    // 4) a branch ganhando (tarefa gravada sem branch, como se marcada fora do git)
    store.setLocalActiveTask(mkTask({ taskRef: 'AB#4790', title: 'Tela do Conector de IA', repo: 'github.com/org/andromeda-ui', since, day, cwd: sb.repo, branch: null }));
    checkout(sb, 'feature/AB#4812-custo-2');
    c = mkCli(sb, now);
    await runCli(['status'], c.ctx);
    assert.equal(
      taskBlock(c.cap.text()),
      [
        `  Tarefa ativa: AB#4790 Tela do Conector de IA (andromeda-ui), marcada às ${hhmm}`,
        '    Aviso: a branch feature/AB#4812-custo-2 aponta AB#4812. O uso vai para AB#4812.',
        '    Para usar AB#4790, troque de branch.',
        LAST,
      ].join('\n'),
    );

    // 5) expirada, com e sem "Para marcar de novo"
    store.setLocalActiveTask(null);
    const endAt = new Date(now - 60_000).toISOString();
    const hh = endAt.slice(11, 16);
    store.setMeta('last_task_end', JSON.stringify({ taskRef: 'AB#4790', reason: 'BRANCH_CHANGED', at: endAt, newBranch: 'feature/AB#4812-custo-2' }));
    c = mkCli(sb, now);
    await runCli(['status'], c.ctx);
    assert.equal(
      taskBlock(c.cap.text()),
      [
        '  Tarefa ativa: nenhuma',
        `    AB#4790 expirou às ${hh}: você trocou para a branch feature/AB#4812-custo-2.`,
        '    Agora o uso vai pela branch: AB#4812.',
        '    Para marcar de novo: andromeda-agent task AB#4790',
        LAST,
      ].join('\n'),
    );
    store.setMeta('last_task_end', JSON.stringify({ taskRef: 'AB#4790', reason: 'ITEM_CLOSED', at: endAt }));
    c = mkCli(sb, now);
    await runCli(['status'], c.ctx);
    assert.equal(taskBlock(c.cap.text()), ['  Tarefa ativa: nenhuma', `    AB#4790 expirou às ${hh}: o item foi fechado.`, LAST].join('\n'));
    assert.doesNotMatch(c.cap.text(), /não expira sozinha|Marcada há/);
  } finally {
    store.close();
    sb.cleanup();
  }
});

test('task <ref>: imprime a validade e, se a branch aponta outro item, o aviso', async () => {
  const { sb, store, api } = await setup();
  try {
    const sent: unknown[] = [];
    api.setActiveTask = async (r?: unknown) => (sent.push(r), { workItemId: 'w', ref: 'AB#4790', title: 'Tela do Conector de IA', retroactiveRows: 0 });
    let c = mkCli(sb, Date.now(), api);
    assert.equal(await runCli(['task', 'AB#4790'], c.ctx), 0, c.cap.text());
    assert.equal(
      c.cap.text(),
      'Tarefa ativa: AB#4790 Tela do Conector de IA. Vale até a meia-noite ou até você trocar de branch.\nLinhas de uso já enviadas hoje e reatribuídas: 0\n',
    );
    // a tarefa marcada em "main" guarda a branch; agora com a branch apontando outro item
    checkout(sb, 'feature/AB#4812-custo');
    c = mkCli(sb, Date.now(), api);
    assert.equal(await runCli(['task', 'AB#4790'], c.ctx), 0, c.cap.text());
    assert.match(
      c.cap.text(),
      /Aviso: a branch feature\/AB#4812-custo aponta AB#4812, e a branch ganha\. Para o uso ir para AB#4790, troque de branch\.\n$/,
    );
    const t = store.getLocalActiveTask();
    assert.equal(t?.branch, 'feature/AB#4812-custo');
    assert.equal(t?.cwd, sb.repo);
    assert.equal(t?.day, localDayOf(Date.now(), 'UTC'));
    assert.equal((sent[0] as { branch: string }).branch, 'main', 'o PUT leva a branch da pasta');
  } finally {
    store.close();
    sb.cleanup();
  }
});
