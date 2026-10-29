import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store/db.js';
import { sendPending } from '../../src/sync/sender.js';
import { ApiError } from '../../src/types.js';
import type { AgentApi, PayloadRow } from '../../src/types.js';
import { FakeServer, mkRow } from './fake-server.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'ag-send-'));
}

function makeRows(n: number): PayloadRow[] {
  return Array.from({ length: n }, (_, i) =>
    mkRow('k' + String(i).padStart(3, '0'), i % 2 ? '2026-10-01' : '2026-10-02', {
      tokens: { input: i + 1, output: 100 + i, cacheRead: 3, cacheWrite: 4, thinking: 1 },
      interactions: i + 1,
    }),
  );
}

test('sender: várias rodadas com 503, resposta perdida, rejeição e duplicate convergem', async () => {
  const dir = tmp();
  const store = Store.open(dir);
  const api = new FakeServer();
  const rows = makeRows(50);
  store.enqueue(rows);
  api.rejectKeys.add('k007');
  api.fault = (n) => (n % 4 === 0 ? 'fail503' : n % 5 === 0 ? 'lose' : undefined);

  let now = 1_000_000;
  let dup = 0;
  for (let round = 0; round < 60 && store.stats().pending > 0; round++) {
    const s = await sendPending(store, api, { timezone: 'America/Sao_Paulo', now, batchSize: 4, rand: () => 0.9 });
    dup += s.duplicate;
    now += 11 * 60_000;
  }
  const st = store.stats();
  assert.equal(st.pending, 0);
  assert.equal(st.rejected, 1);
  assert.equal(store.rejectedRows(10)[0]?.key, 'k007');
  assert.equal(st.sent, 49);
  assert.ok(dup > 0, 'a resposta perdida deve gerar duplicate no reenvio');

  const expected = rows.filter((r) => r.key !== 'k007').map((r) => r.key).sort();
  assert.deepEqual([...api.rows.keys()].sort(), expected);
  for (const k of expected) assert.deepEqual(api.rows.get(k), rows.find((r) => r.key === k));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('sender: lote com falha de rede reenvia o mesmo batchId e as mesmas chaves', async () => {
  const dir = tmp();
  const store = Store.open(dir);
  const api = new FakeServer();
  store.enqueue(makeRows(6));
  api.fault = (n) => (n === 1 ? 'lose' : undefined);
  const s1 = await sendPending(store, api, { timezone: 'UTC', now: 1000, rand: () => 0 });
  assert.equal(s1.deferred, 6);
  await sendPending(store, api, { timezone: 'UTC', now: 1000 + 60_000 });
  assert.equal(api.calls.length, 2);
  assert.equal(api.calls[1]!.batchId, api.calls[0]!.batchId);
  assert.deepEqual(api.calls[1]!.keys, api.calls[0]!.keys);
  assert.equal(store.stats().sent, 6);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('sender: morte no meio (fecha e reabre o Store) reusa o batchId', async () => {
  const dir = tmp();
  let store = Store.open(dir);
  const api = new FakeServer();
  store.enqueue(makeRows(8));
  api.fault = (n) => (n === 1 ? 'die' : undefined);
  await assert.rejects(sendPending(store, api, { timezone: 'UTC', now: 1000, batchSize: 5 }), /morreu/);
  store.close();

  store = Store.open(dir);
  assert.equal(store.stats().pending, 8);
  const s = await sendPending(store, api, { timezone: 'UTC', now: 2000, batchSize: 5 });
  assert.equal(api.calls[1]!.batchId, api.calls[0]!.batchId);
  assert.deepEqual(api.calls[1]!.keys, api.calls[0]!.keys);
  assert.equal(s.duplicate, 5);
  assert.equal(store.stats().pending, 0);
  assert.equal(api.rows.size, 8);
  assert.equal(store.getInflight(), null);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('sender: linha que cresceu depois da morte vai num batchId novo e chega inteira', async () => {
  const dir = tmp();
  let store = Store.open(dir);
  const api = new FakeServer();
  api.replayByBatch = true;
  const base = mkRow('k1', '2026-10-01', { tokens: { input: 1, output: 100, cacheRead: 0, cacheWrite: 0, thinking: 0 } });
  store.enqueue([base]);
  api.fault = (n) => (n === 1 ? 'die' : undefined);
  await assert.rejects(sendPending(store, api, { timezone: 'UTC', now: 1000 }), /morreu/);
  store.close();

  store = Store.open(dir);
  // A coleta seguinte sobe o bucket antes do reenvio.
  store.enqueue([{ ...base, tokens: { ...base.tokens, output: 250 } }]);
  await sendPending(store, api, { timezone: 'UTC', now: 2000 });
  assert.notEqual(api.calls[1]!.batchId, api.calls[0]!.batchId);
  assert.equal(api.rows.get('k1')!.tokens.output, 250);
  assert.equal(store.stats().pending, 0);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('sender: Retry-After vence o backoff e 413 divide o lote', async () => {
  const dir = tmp();
  const store = Store.open(dir);
  const api = new FakeServer();
  store.enqueue(makeRows(8));
  api.fault = (_n, rows) => (rows.length > 2 ? 'too-large' : undefined);
  const s = await sendPending(store, api, { timezone: 'UTC', now: 1000 });
  assert.equal(s.sent, 8);
  assert.ok(api.calls.every((c, i) => i === 0 || c.keys.length <= 4));
  store.close();

  const dir2 = tmp();
  const store2 = Store.open(dir2);
  store2.enqueue(makeRows(2));
  const limited: AgentApi = Object.assign(new FakeServer(), {
    uploadUsage: async () => {
      throw new ApiError('lento', 429, null, 120);
    },
  });
  await sendPending(store2, limited, { timezone: 'UTC', now: 5000 });
  assert.equal(store2.takePending(10, 5000 + 119_999).length, 0);
  assert.equal(store2.takePending(10, 5000 + 120_000).length, 2);
  store2.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(dir2, { recursive: true, force: true });
});

test('sender: 426 e 401 param sem mexer na fila', async () => {
  const dir = tmp();
  const store = Store.open(dir);
  store.enqueue(makeRows(3));
  const mk = (status: number): AgentApi =>
    Object.assign(new FakeServer(), {
      uploadUsage: async () => {
        throw new ApiError('x', status, null, null);
      },
    });
  const a = await sendPending(store, mk(426), { timezone: 'UTC', now: 1 });
  assert.equal(a.upgradeRequired, true);
  const b = await sendPending(store, mk(401), { timezone: 'UTC', now: 1 });
  assert.equal(b.authFailed, true);
  assert.equal(store.takePending(10, 1).length, 3);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
