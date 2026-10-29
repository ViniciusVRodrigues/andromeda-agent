import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store/db.js';
import { buildHeartbeat, heartbeatDue } from '../../src/sync/heartbeat.js';
import { mkRow } from './fake-server.js';

test('heartbeat: pendências e dia mais antigo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ag-hb-'));
  const s = Store.open(dir);
  s.enqueue([mkRow('a', '2026-10-03'), mkRow('b', '2026-10-01')]);
  assert.deepEqual(buildHeartbeat(s, '0.1.0', 'America/Sao_Paulo'), {
    agentVersion: '0.1.0',
    timezone: 'America/Sao_Paulo',
    pendingRows: 2,
    oldestPendingDay: '2026-10-01',
  });
  s.close();
  rmSync(dir, { recursive: true, force: true });
});

test('heartbeat: vence a cada volta (>= 50 s)', () => {
  assert.equal(heartbeatDue(null, 1000), true);
  assert.equal(heartbeatDue(0, 49_999), false);
  assert.equal(heartbeatDue(0, 50_000), true);
});

test('heartbeat: syncServed só entra no corpo quando há valor', () => {
  const s = Store.open(mkdtempSync(join(tmpdir(), 'hb-')));
  try {
    assert.ok(!('syncServed' in buildHeartbeat(s, '0.3.0', 'UTC')));
    assert.ok(!('syncServed' in buildHeartbeat(s, '0.3.0', 'UTC', null)));
    assert.equal(buildHeartbeat(s, '0.3.0', 'UTC', '2026-10-29T18:00:01.123Z').syncServed, '2026-10-29T18:00:01.123Z');
  } finally {
    s.close();
  }
});
