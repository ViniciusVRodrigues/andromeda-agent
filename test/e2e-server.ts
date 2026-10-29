import type { PayloadRow } from '../src/types.js';
import { keysDigest } from '../src/sync/reconcile.js';
import { json, startServer, type FakeServer, type Seen } from './client/fake-server.js';

const ALLOWED = ['key', 'tool', 'sessionHash', 'model', 'hour', 'day', 'tokens', 'interactions', 'origin', 'repo', 'branch', 'taskRef', 'attributionMethod'];

export interface E2eServer extends FakeServer {
  rows: Map<string, PayloadRow>;
  usageCalls: Array<{ batchId: string; rows: PayloadRow[] }>;
  rawKeys: Set<string>;
  activeTaskBodies: unknown[];
  heartbeats: number;
}

function maxRow(a: PayloadRow, b: PayloadRow): PayloadRow {
  return {
    ...b,
    interactions: Math.max(a.interactions, b.interactions),
    tokens: {
      input: Math.max(a.tokens.input, b.tokens.input),
      output: Math.max(a.tokens.output, b.tokens.output),
      cacheRead: Math.max(a.tokens.cacheRead, b.tokens.cacheRead),
      cacheWrite: Math.max(a.tokens.cacheWrite, b.tokens.cacheWrite),
      thinking: Math.max(a.tokens.thinking, b.tokens.thinking),
    },
  };
}

/** Servidor falso do contrato do agente: idempotente por chave, máximo por campo. */
export async function startE2eServer(): Promise<E2eServer> {
  const rows = new Map<string, PayloadRow>();
  const usageCalls: E2eServer['usageCalls'] = [];
  const rawKeys = new Set<string>();
  const activeTaskBodies: unknown[] = [];
  const state = { heartbeats: 0 };

  const srv = await startServer((req: Seen, res) => {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    const body = req.body ? (JSON.parse(req.body) as Record<string, unknown>) : {};
    const auth = req.headers.authorization ?? '';

    if (req.method === 'POST' && path === '/agent/v1/device/code') {
      return json(res, 200, {
        device_code: 'DEV-CODE',
        user_code: 'ABCD-1234',
        verification_uri: 'http://127.0.0.1/pair',
        verification_uri_complete: 'http://127.0.0.1/pair?code=ABCD-1234',
        expires_in: 600,
        interval: 1,
      });
    }
    if (req.method === 'POST' && path === '/agent/v1/device/token') {
      const grant = body.grant_type;
      if (grant === 'refresh_token' && body.refresh_token !== 'REF1') return json(res, 400, { error: 'invalid_grant' });
      return json(res, 200, {
        access_token: 'ACC1',
        token_type: 'Bearer',
        expires_in: 900,
        refresh_token: 'REF1',
        device_id: 'dev-1',
        organization_slug: 'acme',
      });
    }
    if (auth !== 'Bearer ACC1') return json(res, 401, { code: 'AGENT_TOKEN_INVALID' });

    if (req.method === 'POST' && path === '/agent/v1/usage') {
      const batch = body.rows as PayloadRow[];
      usageCalls.push({ batchId: String(body.batchId), rows: batch });
      const results = batch.map((r) => {
        for (const k of Object.keys(r)) if (!ALLOWED.includes(k)) return { key: r.key, status: 'rejected', reason: 'field', retryable: false, field: k };
        const cur = rows.get(r.key);
        if (!cur) {
          rows.set(r.key, r);
          return { key: r.key, status: 'accepted', allocation: 'ALLOCATED' };
        }
        const merged = maxRow(cur, r);
        const grew = JSON.stringify(merged) !== JSON.stringify(cur);
        rows.set(r.key, merged);
        return { key: r.key, status: grew ? 'accepted' : 'duplicate' };
      });
      for (const r of batch) rawKeys.add(r.key);
      return json(res, 200, {
        batchId: body.batchId,
        accepted: results.filter((r) => r.status === 'accepted').length,
        duplicate: results.filter((r) => r.status === 'duplicate').length,
        rejected: 0,
        results,
      });
    }
    if (req.method === 'POST' && path === '/agent/v1/heartbeat') {
      state.heartbeats++;
      return json(res, 200, { serverTime: new Date().toISOString(), minVersion: '0.1.0', activeTask: null });
    }
    if (req.method === 'GET' && path === '/agent/v1/usage/reconcile') {
      const from = url.searchParams.get('from') ?? '';
      const to = url.searchParams.get('to') ?? '';
      const days = new Map<string, PayloadRow[]>();
      for (const r of rows.values()) if (r.day >= from && r.day <= to) days.set(r.day, [...(days.get(r.day) ?? []), r]);
      return json(res, 200, {
        days: [...days.entries()].map(([day, rs]) => ({
          day,
          rows: rs.length,
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 },
          keysDigest: keysDigest(rs.map((r) => r.key).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))),
        })),
      });
    }
    if (req.method === 'GET' && path === '/agent/v1/usage/keys') {
      const day = url.searchParams.get('day');
      return json(res, 200, { keys: [...rows.values()].filter((r) => r.day === day).map((r) => r.key) });
    }
    if (req.method === 'PUT' && path === '/agent/v1/active-task') {
      activeTaskBodies.push(body);
      return json(res, 200, { workItemId: 'w-9', ref: String(body.taskRef), title: 'Corrigir login', retroactiveRows: 2 });
    }
    if (req.method === 'DELETE' && path === '/agent/v1/active-task') {
      res.writeHead(204);
      return void res.end();
    }
    if (req.method === 'GET' && path === '/agent/v1/tasks') {
      return json(res, 200, { items: [{ workItemId: 'w-9', ref: 'AB#9', externalId: '9', title: 'Corrigir login', type: 'Task', sprintName: 'Sprint 1' }] });
    }
    return json(res, 404, { code: 'NOT_FOUND' });
  });

  return Object.assign(srv, {
    rows,
    usageCalls,
    rawKeys,
    activeTaskBodies,
    get heartbeats() {
      return state.heartbeats;
    },
  }) as E2eServer;
}
