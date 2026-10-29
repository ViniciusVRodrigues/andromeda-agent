import { createHash, randomUUID } from 'node:crypto';
import { ApiError } from '../types.js';
import type { AgentApi, PayloadRow } from '../types.js';
import type { OutboxItem, Store } from '../store/db.js';
import { nextDelay } from './backoff.js';

export interface SendOptions {
  timezone: string;
  /** Relógio em ms (número fixo ou função). */
  now: number | (() => number);
  batchSize?: number;
  maxBatches?: number;
  uuid?: () => string;
  rand?: () => number;
}

export interface SendSummary {
  sent: number;
  duplicate: number;
  rejected: number;
  deferred: number;
  upgradeRequired?: true;
  authFailed?: true;
}

type Flow = 'ok' | 'stop';

function rowsDigest(rows: PayloadRow[]): string {
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

export async function sendPending(store: Store, api: AgentApi, opts: SendOptions): Promise<SendSummary> {
  const batchSize = Math.min(opts.batchSize ?? 500, 500);
  const maxBatches = opts.maxBatches ?? Number.POSITIVE_INFINITY;
  const uuid = opts.uuid ?? randomUUID;
  const rand = opts.rand ?? Math.random;
  const clock = (): number => (typeof opts.now === 'function' ? opts.now() : opts.now);
  const summary: SendSummary = { sent: 0, duplicate: 0, rejected: 0, deferred: 0 };
  const touched = new Set<string>();

  const sendChunk = async (items: OutboxItem[], batchId: string): Promise<Flow> => {
    const keys = items.map((i) => i.key);
    const rows = items.map((i) => i.row);
    for (const k of keys) touched.add(k);
    store.setInflight(batchId, keys, rowsDigest(rows));
    let resp;
    try {
      resp = await api.uploadUsage(batchId, opts.timezone, rows);
    } catch (e) {
      if (!(e instanceof ApiError)) throw e; // processo "morreu": o lote em curso fica em meta
      if (e.status === 413) {
        store.clearInflight();
        if (items.length === 1) {
          store.applyResults([{ key: keys[0]!, status: 'rejected', reason: 'payload_too_large', retryable: false }], clock());
          summary.rejected += 1;
          return 'ok';
        }
        const mid = Math.ceil(items.length / 2);
        for (const half of [items.slice(0, mid), items.slice(mid)]) {
          if ((await sendChunk(half, uuid())) === 'stop') return 'stop';
        }
        return 'ok';
      }
      if (e.status === 426) {
        summary.upgradeRequired = true;
        return 'stop';
      }
      if (e.status === 401) {
        summary.authFailed = true;
        return 'stop';
      }
      // rede, 429, 5xx e qualquer outro erro de lote: adia com backoff e para
      const attempts = Math.max(...items.map((i) => i.attempts)) + 1;
      store.deferAll(keys, clock(), nextDelay(attempts, rand, e.retryAfter));
      summary.deferred += keys.length;
      return 'stop';
    }
    const sentRows = new Map<string, PayloadRow>(rows.map((r) => [r.key, r]));
    const seen = new Set<string>();
    for (const r of resp.results) {
      seen.add(r.key);
      if (r.status === 'accepted') summary.sent += 1;
      else if (r.status === 'duplicate') summary.duplicate += 1;
      else if (!r.retryable) summary.rejected += 1;
      else summary.deferred += 1;
    }
    store.applyResults(resp.results, clock(), sentRows);
    const missing = keys.filter((k) => !seen.has(k));
    if (missing.length > 0) {
      const attempts = Math.max(...items.map((i) => i.attempts)) + 1;
      store.deferAll(missing, clock(), nextDelay(attempts, rand));
      summary.deferred += missing.length;
    }
    store.clearInflight();
    return 'ok';
  };

  for (let b = 0; b < maxBatches; b++) {
    const inflight = store.getInflight();
    if (inflight) {
      const items = store.pendingByKeys(inflight.keys, clock());
      if (items.length > 0) {
        // O servidor responde um batchId repetido com a resposta guardada, sem ler
        // o corpo (contrato 4.2). Se as linhas mudaram desde a queda, o lote é outro.
        const same = inflight.digest === rowsDigest(items.map((i) => i.row));
        if ((await sendChunk(items, same ? inflight.batchId : uuid())) === 'stop') break;
        continue;
      }
      store.clearInflight();
    }
    const items = store.takePending(batchSize, clock(), touched);
    if (items.length === 0) break;
    if ((await sendChunk(items, uuid())) === 'stop') break;
  }
  return summary;
}
