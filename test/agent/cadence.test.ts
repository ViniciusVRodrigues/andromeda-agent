import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cycle, newMemory, runLoop, SYNC_INTERVAL_MS, type AgentDeps, type CycleSummary } from '../../src/agent/loop.js';
import { runCli } from '../../src/agent/commands.js';
import { parsers } from '../../src/parsers/index.js';
import { FileCredentialStore } from '../../src/auth/tokens.js';
import { Store } from '../../src/store/db.js';
import { createGit } from '../../src/task/git.js';
import { FakeServer } from '../sync/fake-server.js';
import { fakeCreds, makeCtx, makeSandbox } from './helpers.js';

const MIN = 60_000;
const REQ = '2026-10-29T18:00:01.123Z';

async function setup(): Promise<{ api: FakeServer; deps: () => AgentDeps; at: (ms: number) => void; store: Store; done: () => void; sb: ReturnType<typeof makeSandbox> }> {
  const sb = makeSandbox();
  const store = Store.open(sb.state);
  const creds = new FileCredentialStore(sb.state, () => {});
  await creds.save(fakeCreds());
  const api = new FakeServer();
  let now = Date.UTC(2026, 9, 29, 12, 0, 0);
  const deps = (): AgentDeps => ({ store, api, creds, parsers, git: createGit(), env: { home: sb.home, env: sb.env }, timezone: 'UTC', now: () => now });
  return {
    api,
    deps,
    at: (ms) => void (now += ms),
    store,
    sb,
    done: () => {
      store.close();
      sb.cleanup();
    },
  };
}

test('cadência: o início sincroniza; 5 min depois só heartbeat; 15 min depois sincroniza', async () => {
  const t = await setup();
  try {
    const mem = newMemory();
    const s0 = await cycle(t.deps(), mem);
    assert.equal(s0.synced, true);
    assert.equal(s0.syncReason, 'start');
    assert.equal(s0.heartbeat, true);
    for (let i = 0; i < 5; i++) {
      t.at(MIN);
      const s = await cycle(t.deps(), mem);
      assert.equal(s.synced, false, `volta ${i + 1}: sem coleta`);
      assert.equal(s.collect, null);
      assert.equal(s.heartbeat, true, 'heartbeat em toda volta');
    }
    assert.equal(t.api.heartbeats.length, 6);
    t.at(5 * MIN); // 10 min desde o início
    assert.equal((await cycle(t.deps(), mem)).synced, false);
    t.at(5 * MIN);
    const s15 = await cycle(t.deps(), mem);
    assert.equal(s15.synced, true);
    assert.equal(s15.syncReason, 'interval');
    assert.equal(SYNC_INTERVAL_MS, 15 * MIN);
  } finally {
    t.done();
  }
});

test('cadência: devido com 14 min 30 s', async () => {
  const t = await setup();
  try {
    const mem = newMemory();
    await cycle(t.deps(), mem);
    t.at(14 * MIN + 29_000);
    assert.equal((await cycle(t.deps(), mem)).synced, false);
    t.at(1_000);
    assert.equal((await cycle(t.deps(), mem)).synced, true);
  } finally {
    t.done();
  }
});

test('pedido do servidor: sincroniza na mesma volta e confirma com syncServed na hora', async () => {
  const t = await setup();
  try {
    const mem = newMemory();
    await cycle(t.deps(), mem);
    t.at(MIN);
    t.api.syncRequestedAt = REQ;
    const before = t.api.heartbeats.length;
    const s = await cycle(t.deps(), mem);
    assert.equal(s.synced, true);
    assert.equal(s.syncReason, 'requested');
    const mine = t.api.heartbeats.slice(before);
    assert.equal(mine.length, 2, 'heartbeat da volta + confirmação');
    assert.ok(!('syncServed' in mine[0]!));
    assert.equal(mine[1]!.syncServed, REQ);
    assert.equal(t.api.syncRequestedAt, null, 'o servidor apagou o pedido');
    // volta seguinte: nada a fazer
    t.at(MIN);
    const next = await cycle(t.deps(), mem);
    assert.equal(next.synced, false);
    assert.ok(!('syncServed' in t.api.heartbeats.at(-1)!));
  } finally {
    t.done();
  }
});

test('pedido: o mesmo syncRequestedAt de novo não sincroniza outra vez', async () => {
  const t = await setup();
  try {
    const mem = newMemory();
    await cycle(t.deps(), mem);
    t.at(MIN);
    t.api.syncRequestedAt = REQ;
    // servidor que ignora a confirmação e segue devolvendo o mesmo pedido
    const orig = t.api.heartbeat.bind(t.api);
    t.api.heartbeat = async (r) => {
      const res = await orig({ ...r, syncServed: undefined });
      t.api.syncRequestedAt = REQ;
      return { ...res, syncRequestedAt: REQ };
    };
    assert.equal((await cycle(t.deps(), mem)).synced, true);
    for (let i = 0; i < 3; i++) {
      t.at(MIN);
      assert.equal((await cycle(t.deps(), mem)).synced, false, 'mesmo pedido: não repete');
    }
    // pedido novo (outro instante) é atendido
    t.at(MIN);
    t.api.syncRequestedAt = '2026-10-29T18:05:00.000Z';
    t.api.heartbeat = orig;
    const s = await cycle(t.deps(), mem);
    assert.equal(s.synced, true);
    assert.equal(s.syncReason, 'requested');
  } finally {
    t.done();
  }
});

test('pedido: confirmação que falha é reenviada na volta seguinte, sem sincronizar de novo', async () => {
  const t = await setup();
  try {
    const mem = newMemory();
    await cycle(t.deps(), mem);
    t.at(MIN);
    t.api.syncRequestedAt = REQ;
    const base = t.api.heartbeats.length;
    t.api.heartbeatFails = (n) => n === base + 2; // a confirmação
    const s = await cycle(t.deps(), mem);
    assert.equal(s.synced, true);
    assert.equal(t.api.syncRequestedAt, REQ, 'servidor não recebeu a confirmação');
    t.at(MIN);
    const s2 = await cycle(t.deps(), mem);
    assert.equal(s2.synced, false);
    assert.equal(t.api.heartbeats.at(-1)!.syncServed, REQ, 'reenviou syncServed');
    assert.equal(t.api.syncRequestedAt, null);
    t.at(MIN);
    await cycle(t.deps(), mem);
    assert.ok(!('syncServed' in t.api.heartbeats.at(-1)!), 'depois de aceito, para de enviar');
  } finally {
    t.done();
  }
});

test('servidor antigo sem syncRequestedAt: funciona e segue a regra dos 15 min', async () => {
  const t = await setup();
  try {
    assert.equal(t.api.syncRequestedAt, undefined);
    const mem = newMemory();
    assert.equal((await cycle(t.deps(), mem)).synced, true);
    t.at(MIN);
    const s = await cycle(t.deps(), mem);
    assert.equal(s.synced, false);
    assert.equal(s.heartbeat, true);
    t.at(15 * MIN);
    assert.equal((await cycle(t.deps(), mem)).synced, true);
  } finally {
    t.done();
  }
});

test('heartbeat com falha de rede não impede a sincronização devida', async () => {
  const t = await setup();
  try {
    const mem = newMemory();
    await cycle(t.deps(), mem);
    t.at(15 * MIN);
    t.api.heartbeatFails = () => true;
    const s = await cycle(t.deps(), mem);
    assert.equal(s.heartbeat, false);
    assert.equal(s.synced, true);
  } finally {
    t.done();
  }
});

test('run --once sincroniza mesmo logo depois de outra sincronização', async () => {
  const t = await setup();
  try {
    const mem = newMemory();
    await cycle(t.deps(), mem);
    t.at(MIN);
    const seen: CycleSummary[] = [];
    await runLoop(t.deps(), { release() {}, touch() {} }, { once: true, onCycle: (s) => void seen.push(s) });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.synced, true);
    assert.equal(seen[0]!.syncReason, 'start');
  } finally {
    t.done();
  }
});

test('status mostra o próximo envio', async () => {
  const sb = makeSandbox();
  try {
    const store = Store.open(sb.state);
    const now = Date.UTC(2026, 9, 29, 12, 0, 0);
    store.setMeta('last_sync', String(now - 5 * MIN));
    store.close();
    const a = makeCtx(sb, { now: () => now });
    await runCli(['status'], a.ctx);
    assert.match(a.cap.text(), /Próximo envio: em ~10 min/);
    const b = makeCtx(sb, { now: () => now + 20 * MIN });
    await runCli(['status'], b.ctx);
    assert.match(b.cap.text(), /Próximo envio: na próxima volta/);
  } finally {
    sb.cleanup();
  }
});
