import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store/db.js';
import { sendPending } from '../../src/sync/sender.js';
import { reconcile } from '../../src/sync/reconcile.js';
import { FakeServer, mkRow } from './fake-server.js';

test('reconcile: re-enfileira chave que o servidor perdeu e converge', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ag-rec-'));
  const store = Store.open(dir);
  const api = new FakeServer();
  store.enqueue([mkRow('a'), mkRow('b'), mkRow('c'), mkRow('d', '2026-10-02')]);
  await sendPending(store, api, { timezone: 'UTC', now: 1000 });
  assert.equal(store.stats().sent, 4);

  // sem divergência
  assert.deepEqual(await reconcile(store, api, { days: ['2026-10-01', '2026-10-02'] }), []);

  // servidor perde 'b' e 'd'
  api.rows.delete('b');
  api.rows.delete('d');
  const diverged = await reconcile(store, api, { days: ['2026-10-01', '2026-10-02'], now: 2000 });
  assert.deepEqual(diverged, ['2026-10-01', '2026-10-02']);
  assert.equal(store.stats().pending, 2);

  await sendPending(store, api, { timezone: 'UTC', now: 3000 });
  assert.deepEqual([...api.rows.keys()].sort(), ['a', 'b', 'c', 'd']);
  assert.deepEqual(await reconcile(store, api, { days: ['2026-10-01', '2026-10-02'] }), []);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('reconcile: dia que o servidor não conhece mas o local enviou diverge', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ag-rec-'));
  const store = Store.open(dir);
  const api = new FakeServer();
  store.enqueue([mkRow('a')]);
  await sendPending(store, api, { timezone: 'UTC', now: 1000 });
  api.rows.clear();
  assert.deepEqual(await reconcile(store, api, { days: ['2026-10-01'] }), ['2026-10-01']);
  assert.equal(store.stats().pending, 1);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
