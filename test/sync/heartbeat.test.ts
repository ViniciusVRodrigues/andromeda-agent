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

test('heartbeat: vence a cada 1 h', () => {
  assert.equal(heartbeatDue(null, 1000), true);
  assert.equal(heartbeatDue(0, 3_599_999), false);
  assert.equal(heartbeatDue(0, 3_600_000), true);
});
