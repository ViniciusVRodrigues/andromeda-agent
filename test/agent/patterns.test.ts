import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { collect } from '../../src/agent/collect.js';
import { cycle, newMemory, type AgentDeps } from '../../src/agent/loop.js';
import { runCli } from '../../src/agent/commands.js';
import { Store } from '../../src/store/db.js';
import { parsers } from '../../src/parsers/index.js';
import { FileCredentialStore } from '../../src/auth/tokens.js';
import { createGit } from '../../src/task/git.js';
import { currentPatterns, loadStoredPatterns, refreshPatterns } from '../../src/task/server-patterns.js';
import { taskRefFromBranch } from '../../src/task/patterns.js';
import { ApiError } from '../../src/types.js';
import { FakeServer } from '../sync/fake-server.js';
import { claudeLine, fakeCreds, fakeRunner, HOUR, makeCtx, makeSandbox, writeText } from './helpers.js';

const BASE = Math.floor(Date.now() / HOUR) * HOUR - 5 * HOUR + 60_000;

function deps(sb: ReturnType<typeof makeSandbox>, store: Store, api: FakeServer, over: Partial<AgentDeps> = {}): AgentDeps {
  return {
    store,
    api,
    creds: new FileCredentialStore(sb.state, () => {}),
    parsers,
    git: createGit(),
    env: { home: sb.home, env: sb.env },
    timezone: 'UTC',
    ...over,
  };
}


test('collect: branch que casa o padrão sai com taskRef null e método branch; fora do padrão, none', async () => {
  const sb = makeSandbox();
  const store = Store.open(sb.state);
  try {
    writeText(
      join(sb.home, '.claude', 'projects', 'p', 's.jsonl'),
      claudeLine({ id: 'a', ts: BASE, cwd: sb.repo, branch: 'fix/123-foo', input: 1, output: 10 }) +
        claudeLine({ id: 'b', ts: BASE + 1, session: 'cs2', cwd: sb.repo, branch: 'feature/AB#77-x', input: 1, output: 10 }),
    );
    await collect(store, parsers, createGit(), { home: sb.home, env: sb.env }, 'UTC');
    const rows = store.takePending(10, Date.now()).map((i) => i.row);
    assert.equal(rows.length, 2);
    const by = (b: string) => rows.find((r) => r.branch === b)!;
    assert.deepEqual([by('fix/123-foo').taskRef, by('fix/123-foo').attributionMethod], [null, 'none']);
    assert.deepEqual([by('feature/AB#77-x').taskRef, by('feature/AB#77-x').attributionMethod], [null, 'branch']);
    assert.ok(rows.every((r) => r.branchApproximate === false));
  } finally {
    store.close();
    sb.cleanup();
  }
});

test('collect: tarefa ativa local continua indo como taskRef explícito', async () => {
  const sb = makeSandbox();
  const store = Store.open(sb.state);
  try {
    store.setLocalActiveTask({ taskRef: 'AB#9', since: BASE - HOUR, repo: null });
    writeText(join(sb.home, '.claude', 'projects', 'p', 's.jsonl'), claudeLine({ id: 'a', ts: BASE, cwd: sb.repo, branch: 'main', input: 1, output: 10 }));
    await collect(store, parsers, createGit(), { home: sb.home, env: sb.env }, 'UTC');
    const [row] = store.takePending(10, Date.now()).map((i) => i.row);
    assert.deepEqual([row!.taskRef, row!.attributionMethod], ['AB#9', 'explicit']);
  } finally {
    store.close();
    sb.cleanup();
  }
});

test('collect: sessão em dois repositórios na mesma hora vira duas linhas com chaves diferentes', async () => {
  const sb = makeSandbox();
  const store = Store.open(sb.state);
  try {
    const sb2 = makeSandbox('https://github.com/Acme/Outro.git');
    try {
      writeText(
        join(sb.home, '.claude', 'projects', 'p', 's.jsonl'),
        claudeLine({ id: 'a', ts: BASE, cwd: sb.repo, branch: 'main', input: 1, output: 10 }) +
          claudeLine({ id: 'b', ts: BASE + 1, cwd: sb2.repo, branch: 'main', input: 1, output: 10 }),
      );
      await collect(store, parsers, createGit(), { home: sb.home, env: sb.env }, 'UTC');
      const rows = store.takePending(10, Date.now()).map((i) => i.row);
      assert.equal(rows.length, 2);
      assert.notEqual(rows[0]!.key, rows[1]!.key);
      assert.deepEqual(rows.map((r) => r.repo).sort(), ['github.com/acme/outro', 'github.com/acme/repo']);
    } finally {
      sb2.cleanup();
    }
  } finally {
    store.close();
    sb.cleanup();
  }
});

test('padrões do servidor: busca, cache de 1 h, erro mantém o guardado', async () => {
  const sb = makeSandbox();
  const store = Store.open(sb.state);
  try {
    const api = new FakeServer();
    api.patterns = {
      enabled: true,
      updatedAt: '2026-10-29T00:00:00Z',
      patterns: [{ regex: 'x', preset: 'JIRA_KEY', portable: { source: '([A-Z]+-\\d+)', flags: '' } }],
    };
    const t0 = 1_000_000;
    assert.equal(await refreshPatterns(store, api, t0), true);
    assert.equal(loadStoredPatterns(store)?.fetchedAt, t0);
    assert.equal(taskRefFromBranch('feat/PROJ-3', currentPatterns(store)), 'PROJ-3');
    // dentro de 1 h não busca
    assert.equal(await refreshPatterns(store, api, t0 + HOUR), false);
    assert.equal(api.patternsCalls, 1);
    // passou de 1 h, o servidor responde 404: mantém o guardado
    api.patternsError = new ApiError('x', 404, null, null);
    assert.equal(await refreshPatterns(store, api, t0 + HOUR + 1), false);
    assert.equal(api.patternsCalls, 2);
    assert.equal(loadStoredPatterns(store)?.fetchedAt, t0);
    assert.equal(taskRefFromBranch('feat/PROJ-3', currentPatterns(store)), 'PROJ-3');
    api.patternsError = new ApiError('x', 403, null, null);
    assert.equal(await refreshPatterns(store, api, t0 + 2 * HOUR), false);
    // volta: renova
    api.patternsError = null;
    assert.equal(await refreshPatterns(store, api, t0 + 2 * HOUR), true);
    assert.equal(loadStoredPatterns(store)?.fetchedAt, t0 + 2 * HOUR);
  } finally {
    store.close();
    sb.cleanup();
  }
});

test('padrões: sem resposta guardada vale o default (AB#)', () => {
  const sb = makeSandbox();
  const store = Store.open(sb.state);
  try {
    assert.equal(taskRefFromBranch('feature/AB#8-a', currentPatterns(store)), 'AB#8');
    assert.equal(taskRefFromBranch('fix/123-foo', currentPatterns(store)), null);
  } finally {
    store.close();
    sb.cleanup();
  }
});

test('ciclo: busca os padrões uma vez por hora e não cai se o servidor falhar', async () => {
  const sb = makeSandbox();
  const store = Store.open(sb.state);
  try {
    const creds = new FileCredentialStore(sb.state, () => {});
    await creds.save(fakeCreds());
    const api = new FakeServer();
    api.patternsError = new ApiError('x', 404, null, null);
    let now = Date.now();
    const mem = newMemory();
    const d = deps(sb, store, api, { creds, now: () => now });
    await cycle(d, mem);
    await cycle(d, mem);
    assert.equal(api.patternsCalls, 1); // falhou, mas só tenta de novo daqui a 1 h
    now += HOUR + 1000;
    api.patternsError = null;
    await cycle(d, mem);
    assert.equal(api.patternsCalls, 2);
    assert.ok(loadStoredPatterns(store));
  } finally {
    store.close();
    sb.cleanup();
  }
});

test('ciclo: heartbeat com activeTask null apaga a tarefa local', async () => {
  const sb = makeSandbox();
  const store = Store.open(sb.state);
  try {
    const creds = new FileCredentialStore(sb.state, () => {});
    await creds.save(fakeCreds());
    store.setLocalActiveTask({ taskRef: 'AB#1', since: BASE, repo: null });
    await cycle(deps(sb, store, new FakeServer(), { creds }), newMemory());
    assert.equal(store.getLocalActiveTask(), null);
  } finally {
    store.close();
    sb.cleanup();
  }
});

test('status: tarefa antiga avisa, mostra a fonte dos padrões e o que o servidor conclui da branch', async () => {
  const sb = makeSandbox();
  try {
    execFileSync('git', ['-C', sb.repo, 'checkout', '-q', '-b', 'feature/AB#42-x'], { stdio: 'ignore' });
    const creds = new FileCredentialStore(sb.state, () => {});
    await creds.save(fakeCreds());
    const now = Date.now();
    const mk = () => makeCtx(sb, { credStore: creds, runner: fakeRunner(1), platform: 'linux', cliPath: '/x/cli.js', uid: 1, now: () => now });
    const store = Store.open(sb.state);
    store.setLocalActiveTask({ taskRef: 'AB#1', since: now - 30 * HOUR, repo: null });
    const u0 = mk();
    assert.equal(await runCli(['status'], u0.ctx), 0);
    assert.match(u0.cap.text(), /Marcada há: 30 h/);
    assert.match(u0.cap.text(), /Aviso: a tarefa ativa não expira sozinha \(marcada há 30 h\)\. Quando terminar, rode: andromeda-agent task --clear/);
    assert.match(u0.cap.text(), /Padrões de branch: padrão default \(AB#\), o servidor ainda não respondeu/);
    assert.match(u0.cap.text(), /Branch atual: feature\/AB#42-x → o servidor deve concluir AB#42/);

    store.setLocalActiveTask({ taskRef: 'AB#1', since: now - 2 * HOUR, repo: null });
    await refreshPatterns(store, new FakeServer(), now - 5 * 60_000);
    const u1 = mk();
    assert.equal(await runCli(['status'], u1.ctx), 0);
    assert.doesNotMatch(u1.cap.text(), /Aviso: a tarefa ativa/);
    assert.match(u1.cap.text(), /Padrões de branch: 1 do servidor \(atualizados há 5 min\)/);

    execFileSync('git', ['-C', sb.repo, 'checkout', '-q', '-b', 'fix/123-foo'], { stdio: 'ignore' });
    const u2 = mk();
    await runCli(['status'], u2.ctx);
    assert.match(u2.cap.text(), /Branch atual: fix\/123-foo → nenhum padrão casa/);

    store.setMeta('work_item_patterns', JSON.stringify({ fetchedAt: now, response: { enabled: false, updatedAt: null, patterns: [] } }));
    store.close();
    const u3 = mk();
    await runCli(['status'], u3.ctx);
    assert.match(u3.cap.text(), /Padrões de branch: desligados pela organização/);
  } finally {
    sb.cleanup();
  }
});

test('task: marca a tarefa e renova os padrões do servidor', async () => {
  const sb = makeSandbox();
  try {
    const api = new FakeServer();
    api.setActiveTask = async () => ({ workItemId: 'w', ref: 'AB#5', title: 't', retroactiveRows: 0 });
    const u = makeCtx(sb, { api });
    assert.equal(await runCli(['task', 'AB#5'], u.ctx), 0);
    assert.equal(api.patternsCalls, 1);
    const store = Store.open(sb.state);
    assert.ok(loadStoredPatterns(store));
    store.close();
  } finally {
    sb.cleanup();
  }
});
