import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpAgentApi, ReauthRequired, refreshCredentials } from '../../src/client/http.js';
import type { CredentialStore } from '../../src/auth/tokens.js';
import { AGENT_VERSION, ApiError, type DeviceCredentials, type PayloadRow } from '../../src/types.js';
import { json, startServer, TOKEN_OK, type Seen } from './fake-server.js';

const NOW = 5_000_000;

class MemStore implements CredentialStore {
  saves: DeviceCredentials[] = [];
  events: string[] = [];
  constructor(public c: DeviceCredentials | null) {}
  async load() {
    return this.c;
  }
  async save(c: DeviceCredentials) {
    this.events.push('save:' + c.accessToken);
    this.saves.push(c);
    this.c = c;
  }
  async clear() {
    this.c = null;
  }
}

function creds(url: string, over: Partial<DeviceCredentials> = {}): DeviceCredentials {
  return {
    serverUrl: url,
    accessToken: 'OLDACC',
    refreshToken: 'OLDREF',
    accessExpiresAt: NOW + 600_000,
    deviceId: 'dev-1',
    organizationSlug: 'acme',
    ...over,
  };
}

const row = { key: 'k' } as unknown as PayloadRow;

test('cada endpoint usa método, rota e headers certos e devolve o campo certo', async () => {
  const srv = await startServer((r: Seen, res) => {
    if (r.url.startsWith('/agent/v1/usage/reconcile')) return json(res, 200, { deviceId: 'd', days: [{ day: '2026-10-01' }] });
    if (r.url.startsWith('/agent/v1/usage/keys')) return json(res, 200, { day: '2026-10-01', keys: ['a', 'b'] });
    if (r.url === '/agent/v1/usage') return json(res, 200, { batchId: 'b1', accepted: 1, duplicate: 0, rejected: 0, results: [] });
    if (r.url === '/agent/v1/heartbeat') return json(res, 200, { serverTime: 't', minVersion: '0.1.0', activeTask: null });
    if (r.url === '/agent/v1/active-task' && r.method === 'PUT') return json(res, 200, { workItemId: 'w', ref: 'R', title: 'T', retroactiveRows: 3 });
    if (r.url === '/agent/v1/active-task') {
      res.writeHead(204);
      return void res.end();
    }
    if (r.url === '/agent/v1/tasks') return json(res, 200, { items: [{ ref: 'R' }] });
    json(res, 404, {});
  });
  const logs: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  try {
    const api = new HttpAgentApi(new MemStore(creds(srv.url + '/')), { now: () => NOW });
    // captura o que o cliente escreve no console durante as chamadas
    const grab = (c: string | Uint8Array) => (logs.push(String(c)), true);
    process.stdout.write = grab as typeof process.stdout.write;
    process.stderr.write = grab as typeof process.stderr.write;
    const up = await api.uploadUsage('b1', 'America/Sao_Paulo', [row]);
    await api.heartbeat({ agentVersion: AGENT_VERSION, timezone: 'UTC', pendingRows: 0, oldestPendingDay: null });
    const days = await api.reconcile('2026-10-01', '2026-10-02');
    const keys = await api.usageKeys('2026-10-01');
    const set = await api.setActiveTask({ taskRef: 'R', since: 's', day: '2026-10-01' });
    await api.clearActiveTask();
    const tasks = await api.listTasks();
    process.stdout.write = origOut;
    process.stderr.write = origErr;

    assert.equal(up.accepted, 1);
    assert.equal(days.length, 1);
    assert.deepEqual(keys, ['a', 'b']);
    assert.equal(set.retroactiveRows, 3);
    assert.equal(tasks.length, 1);
    assert.deepEqual(
      srv.seen.map((s) => `${s.method} ${s.url}`),
      [
        'POST /agent/v1/usage',
        'POST /agent/v1/heartbeat',
        'GET /agent/v1/usage/reconcile?from=2026-10-01&to=2026-10-02',
        'GET /agent/v1/usage/keys?day=2026-10-01',
        'PUT /agent/v1/active-task',
        'DELETE /agent/v1/active-task',
        'GET /agent/v1/tasks',
      ],
    );
    for (const s of srv.seen) {
      assert.equal(s.headers.authorization, 'Bearer OLDACC');
      assert.equal(s.headers['x-andromeda-agent-version'], AGENT_VERSION);
      assert.equal(s.headers.accept, 'application/json');
    }
    assert.deepEqual(JSON.parse(srv.seen[0]!.body), {
      batchId: 'b1',
      agentVersion: AGENT_VERSION,
      timezone: 'America/Sao_Paulo',
      rows: [row],
    });
    assert.equal(logs.join('').includes('OLDACC'), false);
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    await srv.close();
  }
});

test('401 AGENT_TOKEN_INVALID: refresh uma vez, grava a rotação antes de usar e repete', async () => {
  const store = new MemStore(null);
  const srv = await startServer((r, res) => {
    if (r.url === '/agent/v1/device/token') {
      assert.deepEqual(JSON.parse(r.body), { grant_type: 'refresh_token', refresh_token: 'OLDREF' });
      return json(res, 200, { ...TOKEN_OK, access_token: 'NEWACC', refresh_token: 'NEWREF' });
    }
    if (r.headers.authorization === 'Bearer OLDACC') return json(res, 401, { code: 'AGENT_TOKEN_INVALID' });
    // no segundo uso o par novo já precisa estar no cofre
    assert.deepEqual(store.events, ['save:NEWACC']);
    json(res, 200, { items: [] });
  });
  store.c = creds(srv.url);
  try {
    const api = new HttpAgentApi(store, { now: () => NOW });
    assert.deepEqual(await api.listTasks(), []);
    assert.equal(store.saves.length, 1);
    assert.equal(store.c?.refreshToken, 'NEWREF');
    assert.equal(srv.seen.length, 3);
    assert.equal(srv.seen[2]!.headers.authorization, 'Bearer NEWACC');
  } finally {
    await srv.close();
  }
});

test('renova antes de expirar (margem de 60 s)', async () => {
  const store = new MemStore(null);
  const srv = await startServer((r, res) => {
    if (r.url === '/agent/v1/device/token') return json(res, 200, { ...TOKEN_OK, access_token: 'NEWACC' });
    json(res, 200, { items: [] });
  });
  store.c = creds(srv.url, { accessExpiresAt: NOW + 30_000 });
  try {
    await new HttpAgentApi(store, { now: () => NOW }).listTasks();
    assert.deepEqual(
      srv.seen.map((s) => s.url),
      ['/agent/v1/device/token', '/agent/v1/tasks'],
    );
    assert.equal(srv.seen[1]!.headers.authorization, 'Bearer NEWACC');
  } finally {
    await srv.close();
  }
});

test('refresh com invalid_grant vira ReauthRequired; sem credenciais também', async () => {
  const srv = await startServer((r, res) => {
    if (r.url === '/agent/v1/device/token') return json(res, 400, { error: 'invalid_grant' });
    json(res, 401, { code: 'AGENT_TOKEN_INVALID' });
  });
  try {
    const api = new HttpAgentApi(new MemStore(creds(srv.url)), { now: () => NOW });
    await assert.rejects(api.listTasks(), ReauthRequired);
    await assert.rejects(new HttpAgentApi(new MemStore(null)).listTasks(), ReauthRequired);
    await assert.rejects(refreshCredentials(creds(srv.url), { now: () => NOW }), ReauthRequired);
  } finally {
    await srv.close();
  }
});

test('426 e 429 viram ApiError com código e Retry-After', async () => {
  const srv = await startServer((r, res) => {
    if (r.url === '/agent/v1/usage') return json(res, 426, { code: 'AGENT_VERSION_UNSUPPORTED', minVersion: '9.0.0' });
    json(res, 429, { code: 'RATE_LIMITED' }, { 'Retry-After': '17' });
  });
  try {
    const api = new HttpAgentApi(new MemStore(creds(srv.url)), { now: () => NOW });
    await assert.rejects(
      api.uploadUsage('b', 'UTC', []),
      (e: unknown) => e instanceof ApiError && e.status === 426 && e.code === 'AGENT_VERSION_UNSUPPORTED' && !e.retryable,
    );
    await assert.rejects(
      api.listTasks(),
      (e: unknown) => e instanceof ApiError && e.status === 429 && e.retryAfter === 17 && e.retryable,
    );
  } finally {
    await srv.close();
  }
});

test('422 AGENT_TASK_NOT_FOUND vira ApiError', async () => {
  const srv = await startServer((_r, res) => json(res, 422, { code: 'AGENT_TASK_NOT_FOUND' }));
  try {
    const api = new HttpAgentApi(new MemStore(creds(srv.url)), { now: () => NOW });
    await assert.rejects(
      api.setActiveTask({ taskRef: 'X', since: 's', day: 'd' }),
      (e: unknown) => e instanceof ApiError && e.status === 422 && e.code === 'AGENT_TASK_NOT_FOUND',
    );
  } finally {
    await srv.close();
  }
});

test('conexão recusada e timeout viram ApiError status 0', async () => {
  const dead = await startServer(() => undefined);
  const url = dead.url;
  await dead.close();
  const api = new HttpAgentApi(new MemStore(creds(url)), { now: () => NOW });
  await assert.rejects(api.heartbeat({ agentVersion: 'x', timezone: 'UTC', pendingRows: 0, oldestPendingDay: null }), (e: unknown) => e instanceof ApiError && e.status === 0 && e.retryable);

  const hang = await startServer(() => undefined);
  try {
    const api2 = new HttpAgentApi(new MemStore(creds(hang.url)), { now: () => NOW, timeoutMs: 100 });
    await assert.rejects(api2.listTasks(), (e: unknown) => e instanceof ApiError && e.status === 0);
  } finally {
    await hang.close();
  }
});
