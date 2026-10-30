import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PairingError, parseRetryAfter, pollForToken, startPairing, validateServerUrl } from '../../src/client/device.js';
import { AGENT_VERSION, ApiError } from '../../src/types.js';
import { json, startServer, TOKEN_OK } from './fake-server.js';

const machineInfo = { machineName: 'pc', os: 'linux' as const, osVersion: '6.1', timezone: 'America/Sao_Paulo' };

test('validateServerUrl', () => {
  assert.equal(validateServerUrl('https://a.example.com/'), 'https://a.example.com');
  assert.equal(validateServerUrl('http://127.0.0.1:9090'), 'http://127.0.0.1:9090');
  assert.equal(validateServerUrl('http://localhost:1'), 'http://localhost:1');
  assert.throws(() => validateServerUrl('http://a.example.com'));
  assert.throws(() => validateServerUrl('ftp://127.0.0.1'));
  assert.throws(() => validateServerUrl('https://u:p@a.example.com'));
  assert.throws(() => validateServerUrl('https://user@a.example.com'));
  assert.throws(() => validateServerUrl('nao é url'));
});

test('startPairing manda o corpo e os headers certos', async () => {
  const srv = await startServer((_r, res) =>
    json(res, 200, {
      device_code: 'DC',
      user_code: 'ABCD-1234',
      verification_uri: 'https://x/verify',
      verification_uri_complete: 'https://x/verify?c=ABCD-1234',
      expires_in: 600,
      interval: 5,
    }),
  );
  try {
    const r = await startPairing(srv.url, { machineInfo });
    assert.equal(r.user_code, 'ABCD-1234');
    const s = srv.seen[0]!;
    assert.equal(s.method, 'POST');
    assert.equal(s.url, '/agent/v1/device/code');
    assert.equal(s.headers['x-andromeda-agent-version'], AGENT_VERSION);
    assert.equal(s.headers.accept, 'application/json');
    assert.deepEqual(JSON.parse(s.body), { agentVersion: AGENT_VERSION, ...machineInfo });
  } finally {
    await srv.close();
  }
});

test('startPairing 429 traz Retry-After', async () => {
  const srv = await startServer((_r, res) => json(res, 429, { error: 'rate' }, { 'Retry-After': '42' }));
  try {
    await assert.rejects(
      startPairing(srv.url, { machineInfo }),
      (e: unknown) => e instanceof ApiError && e.status === 429 && e.retryAfter === 42,
    );
  } finally {
    await srv.close();
  }
});

test('startPairing recusa http remoto sem chamar a rede', async () => {
  let called = false;
  const f = (async () => {
    called = true;
    return new Response('{}');
  }) as typeof fetch;
  await assert.rejects(startPairing('http://evil.example.com', { fetch: f, machineInfo }));
  assert.equal(called, false);
});

function fakeClock() {
  let t = 1_000_000;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
  };
}

test('device flow: pending, slow_down, sucesso', async () => {
  const srv = await startServer((_r, res, n) => {
    if (n === 1) return json(res, 400, { error: 'authorization_pending' });
    if (n === 2) return json(res, 400, { error: 'slow_down' });
    if (n === 3) return json(res, 400, { error: 'authorization_pending' });
    json(res, 200, TOKEN_OK);
  });
  const c = fakeClock();
  try {
    const creds = await pollForToken(srv.url, 'DC', 5, 600, { sleep: c.sleep, now: c.now });
    assert.deepEqual(c.sleeps, [5000, 5000, 10000, 10000]);
    assert.equal(creds.accessToken, 'ACC1');
    assert.equal(creds.refreshToken, 'REF1');
    assert.equal(creds.deviceId, 'dev-1');
    assert.equal(creds.organizationSlug, 'acme');
    assert.equal(creds.serverUrl, srv.url);
    assert.equal(creds.accessExpiresAt, c.now() + 900_000);
    const s = srv.seen[0]!;
    assert.equal(s.url, '/agent/v1/device/token');
    assert.deepEqual(JSON.parse(s.body), {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: 'DC',
    });
  } finally {
    await srv.close();
  }
});

test('device flow: access_denied', async () => {
  const srv = await startServer((_r, res) => json(res, 400, { error: 'access_denied' }));
  const c = fakeClock();
  try {
    await assert.rejects(
      pollForToken(srv.url, 'DC', 1, 600, { sleep: c.sleep, now: c.now }),
      (e: unknown) => e instanceof PairingError && e.code === 'access_denied',
    );
  } finally {
    await srv.close();
  }
});

test('device flow: expired_token do servidor e expiração local', async () => {
  const srv = await startServer((_r, res) => json(res, 400, { error: 'expired_token' }));
  const c = fakeClock();
  try {
    await assert.rejects(
      pollForToken(srv.url, 'DC', 1, 600, { sleep: c.sleep, now: c.now }),
      (e: unknown) => e instanceof PairingError && e.code === 'expired_token',
    );
  } finally {
    await srv.close();
  }
  const srv2 = await startServer((_r, res) => json(res, 400, { error: 'authorization_pending' }));
  const c2 = fakeClock();
  try {
    await assert.rejects(
      pollForToken(srv2.url, 'DC', 5, 12, { sleep: c2.sleep, now: c2.now }),
      (e: unknown) => e instanceof PairingError && e.code === 'expired_token',
    );
    assert.equal(srv2.seen.length, 2);
  } finally {
    await srv2.close();
  }
});

test('parseRetryAfter: segundos, data HTTP, lixo, null, data passada', () => {
  const now = () => Date.parse('2026-01-01T00:00:00Z');
  assert.equal(parseRetryAfter('30', now), 30);
  assert.equal(parseRetryAfter('0', now), 0);
  assert.equal(parseRetryAfter('Thu, 01 Jan 2026 00:00:30 GMT', now), 30);
  assert.equal(parseRetryAfter('Thu, 01 Jan 2026 00:00:30 GMT', () => now() + 500), 30);
  assert.equal(parseRetryAfter('Wed, 31 Dec 2025 23:00:00 GMT', now), 0);
  assert.equal(parseRetryAfter('abc', now), null);
  assert.equal(parseRetryAfter('', now), null);
  assert.equal(parseRetryAfter('-5', now), null);
  assert.equal(parseRetryAfter(null, now), null);
  assert.equal(parseRetryAfter('7'), 7);
});

test('device flow 429: Retry-After em segundos espera e tenta de novo', async () => {
  const srv = await startServer((_r, res, n) =>
    n === 1 ? json(res, 429, { code: 'AGENT_RATE_LIMITED' }, { 'Retry-After': '30' }) : json(res, 200, TOKEN_OK),
  );
  const c = fakeClock();
  try {
    const creds = await pollForToken(srv.url, 'DC', 5, 600, { sleep: c.sleep, now: c.now });
    assert.deepEqual(c.sleeps, [5000, 30000]);
    assert.equal(creds.accessToken, 'ACC1');
  } finally {
    await srv.close();
  }
});

test('device flow 429: Retry-After em data HTTP', async () => {
  const c = fakeClock();
  const srv = await startServer((_r, res, n) =>
    n === 1
      ? json(res, 429, {}, { 'Retry-After': new Date(c.now() + 20_000).toUTCString() })
      : json(res, 200, TOKEN_OK),
  );
  try {
    await pollForToken(srv.url, 'DC', 5, 600, { sleep: c.sleep, now: c.now });
    assert.deepEqual(c.sleeps, [5000, 20000]);
  } finally {
    await srv.close();
  }
});

test('device flow 429: Retry-After menor que o intervalo usa o intervalo', async () => {
  const srv = await startServer((_r, res, n) =>
    n === 1 ? json(res, 429, {}, { 'Retry-After': '1' }) : json(res, 200, TOKEN_OK),
  );
  const c = fakeClock();
  try {
    await pollForToken(srv.url, 'DC', 5, 600, { sleep: c.sleep, now: c.now });
    assert.deepEqual(c.sleeps, [5000, 5000]);
  } finally {
    await srv.close();
  }
});

test('device flow 429: sem cabeçalho recua exponencial com teto e zera após não-429', async () => {
  const srv = await startServer((_r, res, n) => {
    if (n <= 5) return json(res, 429, { code: 'AGENT_RATE_LIMITED' });
    if (n === 6) return json(res, 400, { error: 'authorization_pending' });
    if (n === 7) return json(res, 429, {});
    json(res, 200, TOKEN_OK);
  });
  const c = fakeClock();
  try {
    await pollForToken(srv.url, 'DC', 5, 6000, { sleep: c.sleep, now: c.now });
    assert.deepEqual(c.sleeps, [5000, 10000, 20000, 40000, 60000, 60000, 5000, 10000]);
  } finally {
    await srv.close();
  }
});

test('device flow 429: repetido até o deadline vira expired_token com a mensagem do 429', async () => {
  const srv = await startServer((_r, res) => json(res, 429, {}));
  const c = fakeClock();
  try {
    await assert.rejects(
      pollForToken(srv.url, 'DC', 5, 100, { sleep: c.sleep, now: c.now }),
      (e: unknown) => e instanceof PairingError && e.code === 'expired_token' && /HTTP 429/.test(e.message),
    );
  } finally {
    await srv.close();
  }
});

test('device flow 429: Retry-After além do deadline desiste sem dormir', async () => {
  const srv = await startServer((_r, res) => json(res, 429, {}, { 'Retry-After': '500' }));
  const c = fakeClock();
  try {
    await assert.rejects(
      pollForToken(srv.url, 'DC', 5, 100, { sleep: c.sleep, now: c.now }),
      (e: unknown) => e instanceof PairingError && e.code === 'expired_token' && /HTTP 429/.test(e.message),
    );
    assert.deepEqual(c.sleeps, [5000]);
    assert.equal(srv.seen.length, 1);
  } finally {
    await srv.close();
  }
});
