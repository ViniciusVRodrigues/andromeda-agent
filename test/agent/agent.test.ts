import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collect } from '../../src/agent/collect.js';
import { acquireLock, cycle, getState, guardedApi, newMemory, versionLess, LOCK_STALE_MS, type AgentDeps } from '../../src/agent/loop.js';
import { runCli } from '../../src/agent/commands.js';
import { createLogger, MAX_LOG_BYTES } from '../../src/log.js';
import { Store } from '../../src/store/db.js';
import { parsers } from '../../src/parsers/index.js';
import { FileCredentialStore } from '../../src/auth/tokens.js';
import { createGit } from '../../src/task/git.js';
import { ApiError } from '../../src/types.js';
import type { LogParser } from '../../src/types.js';
import { FakeServer, mkRow } from '../sync/fake-server.js';
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

test('collect: arquivo que encolhe recomeça do zero; leitura incremental só pega o novo', async () => {
  const sb = makeSandbox();
  const store = Store.open(sb.state);
  try {
    const file = join(sb.home, '.claude', 'projects', 'p', 's.jsonl');
    writeText(file, claudeLine({ id: 'a', ts: BASE, cwd: sb.repo, branch: 'f/x', input: 1, output: 10 }) + claudeLine({ id: 'b', ts: BASE + 1, cwd: sb.repo, branch: 'f/x', input: 2, output: 20 }));
    const env = { home: sb.home, env: sb.env };
    const r1 = await collect(store, parsers, createGit(), env, 'UTC');
    assert.equal(r1.events, 2);
    assert.equal(r1.rows, 1);
    const r2 = await collect(store, parsers, createGit(), env, 'UTC');
    assert.equal(r2.events, 0);
    appendFileSync(file, claudeLine({ id: 'c', ts: BASE + 2, cwd: sb.repo, branch: 'f/x', input: 4, output: 40 }));
    const r3 = await collect(store, parsers, createGit(), env, 'UTC');
    assert.equal(r3.events, 1);
    assert.equal(store.eventCount(), 3);
    // truncado e reescrito com outro evento: lido do zero
    writeFileSync(file, claudeLine({ id: 'd', ts: BASE + 3, cwd: sb.repo, branch: 'f/x', input: 8, output: 80 }));
    truncateSync(file, statSync(file).size);
    const r4 = await collect(store, parsers, createGit(), env, 'UTC');
    assert.equal(r4.events, 1);
    assert.equal(store.eventCount(), 4);
  } finally {
    store.close();
    sb.cleanup();
  }
});

test('collect: erro num arquivo não para os outros e o log não guarda conteúdo', async () => {
  const sb = makeSandbox();
  const store = Store.open(sb.state);
  try {
    const good = join(sb.home, '.claude', 'projects', 'p', 'good.jsonl');
    writeText(good, claudeLine({ id: 'a', ts: BASE, cwd: sb.repo, input: 1, output: 1 }));
    const bad = join(sb.home, '.claude', 'projects', 'p', 'bad.jsonl');
    writeText(bad, 'x');
    const real = parsers[0]!;
    const flaky: LogParser = {
      ...real,
      parse: (f, o, s) => (f === bad ? Promise.reject(new Error('SEGREDO no erro')) : real.parse(f, o, s)),
    };
    const lines: string[] = [];
    const log = { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m), error: (m: string) => lines.push(m) };
    const r = await collect(store, [flaky], createGit(), { home: sb.home, env: sb.env }, 'UTC', { log });
    assert.equal(r.errors, 1);
    assert.equal(r.events, 1);
    assert.ok(!lines.join('\n').includes('SEGREDO'));
  } finally {
    store.close();
    sb.cleanup();
  }
});

test('collect: sem logs, nada a fazer', async () => {
  const sb = makeSandbox();
  const store = Store.open(sb.state);
  try {
    const r = await collect(store, parsers, createGit(), { home: sb.home, env: sb.env }, 'UTC');
    assert.deepEqual(r, { files: 0, read: 0, events: 0, rows: 0, errors: 0 });
  } finally {
    store.close();
    sb.cleanup();
  }
});

test('guardedApi barra lote com caminho local ou credencial', async () => {
  const api = guardedApi(new FakeServer());
  await assert.rejects(() => api.uploadUsage('b', 'UTC', [mkRow('k', '2026-10-01', { repo: 'https://u:t@github.com/a/b' })]), /lista de permissão/);
  await assert.rejects(() => api.uploadUsage('b', 'UTC', [mkRow('k', '2026-10-01', { branch: 'C:\\Users\\x' })]), /lista de permissão/);
  const ok = await api.uploadUsage('b', 'UTC', [mkRow('k')]);
  assert.equal(ok.accepted, 1);
});

test('ciclo: sem credenciais coleta e fica em "precisa parear"', async () => {
  const sb = makeSandbox();
  const store = Store.open(sb.state);
  try {
    writeText(join(sb.home, '.claude', 'projects', 'p', 's.jsonl'), claudeLine({ id: 'a', ts: BASE, cwd: sb.repo, input: 1, output: 1 }));
    const api = new FakeServer();
    const s = await cycle(deps(sb, store, api), newMemory());
    assert.equal(s.state, 'needs_pair');
    assert.equal(getState(store), 'needs_pair');
    assert.equal(store.stats().pending, 1);
    assert.equal(api.calls.length, 0);
  } finally {
    store.close();
    sb.cleanup();
  }
});

test('ciclo: 401 vira "precisa parear" e não insiste com as mesmas credenciais; 426 para o envio', async () => {
  const sb = makeSandbox();
  const store = Store.open(sb.state);
  try {
    const creds = new FileCredentialStore(sb.state, () => {});
    await creds.save(fakeCreds());
    writeText(join(sb.home, '.claude', 'projects', 'p', 's.jsonl'), claudeLine({ id: 'a', ts: BASE, cwd: sb.repo, input: 1, output: 1 }));
    const api = new FakeServer();
    let status = 401;
    let hits = 0;
    api.uploadUsage = async () => {
      hits++;
      throw new ApiError('x', status, null, null);
    };
    const mem = newMemory();
    const s1 = await cycle(deps(sb, store, api, { creds }), mem);
    assert.equal(s1.state, 'needs_pair');
    assert.equal(getState(store), 'needs_pair');
    assert.equal(hits, 1);
    await cycle(deps(sb, store, api, { creds }), mem);
    assert.equal(hits, 1, 'mesmas credenciais: não tenta de novo');
    // pareou de novo: tenta, e agora o servidor pede atualização
    await creds.save(fakeCreds({ refreshToken: 'NOVO' }));
    status = 426;
    const s2 = await cycle(deps(sb, store, api, { creds }), mem);
    assert.equal(s2.state, 'upgrade');
    assert.equal(hits, 2);
    await cycle(deps(sb, store, api, { creds }), mem);
    assert.equal(hits, 2, 'em upgrade para de enviar');
    // a coleta continua
    appendFileSync(join(sb.home, '.claude', 'projects', 'p', 's.jsonl'), claudeLine({ id: 'b', ts: BASE + 5, cwd: sb.repo, input: 1, output: 1 }));
    const s3 = await cycle(deps(sb, store, api, { creds }), mem);
    assert.equal(s3.collect?.events, 1);
  } finally {
    store.close();
    sb.cleanup();
  }
});

test('ciclo: heartbeat traz a tarefa ativa do servidor; envio ok volta a "ok"', async () => {
  const sb = makeSandbox();
  const store = Store.open(sb.state);
  try {
    const creds = new FileCredentialStore(sb.state, () => {});
    await creds.save(fakeCreds());
    writeText(join(sb.home, '.claude', 'projects', 'p', 's.jsonl'), claudeLine({ id: 'a', ts: BASE, cwd: sb.repo, input: 1, output: 1 }));
    const api = new FakeServer();
    api.heartbeat = async () => ({ serverTime: '', minVersion: '0.0.1', activeTask: { workItemId: 'w', ref: 'PROJ-7', title: 't', since: '2026-10-29T10:00:00Z' } });
    store.setMeta('state', 'needs_pair');
    const s = await cycle(deps(sb, store, api, { creds }), newMemory());
    assert.equal(s.state, 'ok');
    assert.equal(s.sent, 1);
    assert.equal(store.getLocalActiveTask()?.taskRef, 'PROJ-7');
    assert.equal(store.stats().pending, 0);
  } finally {
    store.close();
    sb.cleanup();
  }
});

test('versionLess compara numericamente', () => {
  assert.equal(versionLess('0.1.0', '0.2.0'), true);
  assert.equal(versionLess('0.10.0', '0.9.0'), false);
  assert.equal(versionLess('1.0.0', '1.0.0'), false);
});

test('trava: instância viva barra; trava velha ou de pid morto é retomada', () => {
  const sb = makeSandbox();
  try {
    mkdirSync(sb.state, { recursive: true });
    const a = acquireLock(sb.state, { pid: 111, alive: () => true });
    assert.ok(a);
    assert.equal(acquireLock(sb.state, { pid: 222, alive: (p) => p === 111 }), null);
    // pid morto
    assert.ok(acquireLock(sb.state, { pid: 222, alive: () => false }));
    // pid vivo mas trava velha (pid reaproveitado)
    const later = Date.now() + LOCK_STALE_MS + 1000;
    const b = acquireLock(sb.state, { pid: 333, alive: () => true, now: () => later });
    assert.ok(b);
    b.release();
    assert.equal(existsSync(join(sb.state, 'agent.lock')), false);
  } finally {
    sb.cleanup();
  }
});

test('run --once: segunda instância sai com código 0 e mensagem', async () => {
  const sb = makeSandbox();
  try {
    mkdirSync(sb.state, { recursive: true });
    writeFileSync(join(sb.state, 'agent.lock'), String(process.pid + 0));
    // o próprio pid conta como "nós mesmos": usa o pai, que está vivo
    writeFileSync(join(sb.state, 'agent.lock'), String(process.ppid));
    const { ctx, cap } = makeCtx(sb);
    assert.equal(await runCli(['run', '--once'], ctx), 0);
    assert.match(cap.text(), /já está rodando/);
  } finally {
    sb.cleanup();
  }
});

test('log: rotaciona acima de 1 MB e escreve só linhas operacionais', () => {
  const sb = makeSandbox();
  try {
    const log = createLogger(sb.state);
    log.info('olá');
    writeFileSync(join(sb.state, 'agent.log'), 'x'.repeat(MAX_LOG_BYTES + 10));
    log.warn('depois\nda quebra');
    assert.ok(existsSync(join(sb.state, 'agent.log.1')));
    const t = readFileSync(join(sb.state, 'agent.log'), 'utf8');
    assert.match(t, /WARN depois da quebra\n$/);
  } finally {
    sb.cleanup();
  }
});

test('install: recusa cache do npx; usa o uid real e grava o node; nada é executado de verdade', async () => {
  const sb = makeSandbox();
  try {
    const npx = makeCtx(sb, { cliPath: '/home/a/.npm/_npx/abc/node_modules/andromeda-agent/dist/src/cli.js', platform: 'linux' });
    assert.equal(await runCli(['install'], npx.ctx), 1);
    assert.match(npx.cap.text(), /npm i -g andromeda-agent/);

    const runner = fakeRunner();
    const written: string[] = [];
    const serviceFs = {
      mkdir: async () => {},
      writeFile: async (p: string) => void written.push(p),
      rm: async () => {},
    };
    const mac = makeCtx(sb, { cliPath: '/usr/local/lib/andromeda-agent/dist/src/cli.js', platform: 'darwin', uid: 777, runner, serviceFs, nodePath: '/usr/local/bin/node' });
    assert.equal(await runCli(['install'], mac.ctx), 0, mac.cap.text());
    assert.ok(runner.calls.some(([c, a]) => c === 'launchctl' && a.join(' ').includes('gui/777')));
    assert.ok(written.some((p) => p.endsWith('dev.andromeda.agent.plist')));
    const store = Store.open(sb.state);
    try {
      assert.equal(store.getMeta('node_path'), '/usr/local/bin/node');
    } finally {
      store.close();
    }
    // macOS sem uid: erro claro, sem chutar 501
    const noUid = makeCtx(sb, { cliPath: '/x/cli.js', platform: 'darwin', runner, serviceFs });
    noUid.ctx.uid = undefined;
    const orig = process.getuid;
    // process.getuid existe fora do Windows; o teste só vale se o contexto não o fornecer
    if (!orig) {
      assert.equal(await runCli(['install'], noUid.ctx), 1);
      assert.match(noUid.cap.text(), /uid/);
    }
  } finally {
    sb.cleanup();
  }
});

test('uninstall --purge apaga o estado e as credenciais; sem --purge mantém', async () => {
  const sb = makeSandbox();
  try {
    const creds = new FileCredentialStore(sb.state, () => {});
    await creds.save(fakeCreds());
    const runner = fakeRunner();
    const serviceFs = { mkdir: async () => {}, writeFile: async () => {}, rm: async () => {} };
    const a = makeCtx(sb, { cliPath: '/x/cli.js', platform: 'linux', uid: 1000, runner, serviceFs, credStore: creds });
    assert.equal(await runCli(['uninstall'], a.ctx), 0);
    assert.ok(existsSync(sb.state));
    assert.ok((await creds.load()) !== null);
    assert.equal(await runCli(['uninstall', '--purge'], a.ctx), 0);
    assert.equal(existsSync(sb.state), false);
    assert.equal(await creds.load(), null);
    assert.ok(runner.calls.length >= 2);
  } finally {
    sb.cleanup();
  }
});

test('unpair apaga as credenciais e explica a revogação; status sem pareamento', async () => {
  const sb = makeSandbox();
  try {
    const creds = new FileCredentialStore(sb.state, () => {});
    await creds.save(fakeCreds());
    const u = makeCtx(sb, { credStore: creds });
    assert.equal(await runCli(['unpair'], u.ctx), 0);
    assert.equal(await creds.load(), null);
    assert.match(u.cap.text(), /app web/);
    const s = makeCtx(sb, { credStore: creds, runner: fakeRunner(1), platform: 'linux', cliPath: '/x/cli.js', uid: 1 });
    assert.equal(await runCli(['status'], s.ctx), 0);
    assert.match(s.cap.text(), /Pareado: não/);
    assert.match(s.cap.text(), /Serviço: não instalado/);
  } finally {
    sb.cleanup();
  }
});

test('pair rejeita URL insegura; comando desconhecido devolve 2', async () => {
  const sb = makeSandbox();
  try {
    const p = makeCtx(sb);
    assert.equal(await runCli(['pair', 'http://example.com'], p.ctx), 1);
    assert.match(p.cap.text(), /https/);
    assert.equal(await runCli(['pair'], p.ctx), 2);
    assert.equal(await runCli(['xpto'], p.ctx), 2);
    assert.equal(await runCli(['--version'], p.ctx), 0);
  } finally {
    sb.cleanup();
  }
});

test('doctor: ERRO (código 1) quando o node gravado sumiu; nunca imprime segredo', async () => {
  const sb = makeSandbox();
  try {
    const creds = new FileCredentialStore(sb.state, () => {});
    await creds.save(fakeCreds({ accessToken: 'SEGREDO-TOKEN', refreshToken: 'SEGREDO-REF' }));
    const store = Store.open(sb.state);
    store.setMeta('node_path', join(sb.root, 'nao-existe', 'node'));
    store.close();
    const api = new FakeServer();
    const d = makeCtx(sb, { credStore: creds, api, runner: fakeRunner(1), platform: 'linux', cliPath: '/x/cli.js', uid: 1 });
    assert.equal(await runCli(['doctor'], d.ctx), 1);
    assert.match(d.cap.text(), /\[ERRO\] Caminho do node gravado não existe/);
    assert.match(d.cap.text(), /\[OK\] Conectividade/);
    assert.match(d.cap.text(), /\[AVISO\] Logs de claude-code: 0/);
    assert.ok(!d.cap.text().includes('SEGREDO'));
  } finally {
    sb.cleanup();
  }
});
