import { createHash } from 'node:crypto';
import { ApiError } from '../../src/types.js';
import type {
  ClearActiveTaskRequest,
  AgentApi,
  HeartbeatRequest,
  HeartbeatResponse,
  PayloadRow,
  ReconcileDay,
  RowResult,
  SetActiveTaskResponse,
  TaskItem,
  WorkItemPatternsResponse,
  UsageBatchResponse,
} from '../../src/types.js';

export function mkRow(key: string, day = '2026-10-01', over: Partial<PayloadRow> = {}): PayloadRow {
  return {
    key,
    tool: 'claude-code',
    sessionHash: 'h-' + key,
    model: 'claude-sonnet',
    hour: day + 'T10:00:00Z',
    day,
    tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, thinking: 5 },
    interactions: 2,
    origin: 'real',
    repo: null,
    branch: null,
    taskRef: null,
    attributionMethod: 'none',
    branchApproximate: false,
    ...over,
  };
}

export type Fault = 'fail503' | 'lose' | 'die' | 'too-large' | undefined;

export interface BatchCall {
  batchId: string;
  keys: string[];
}

/** Servidor em memória: idempotente por chave, guarda o máximo por campo. */
export class FakeServer implements AgentApi {
  rows = new Map<string, PayloadRow>();
  calls: BatchCall[] = [];
  /** Decide a falha de cada chamada (número da chamada começando em 1). */
  fault: (n: number, rows: PayloadRow[]) => Fault = () => undefined;
  /** Chaves que o servidor rejeita sem retry. */
  rejectKeys = new Set<string>();
  /** Contrato 4.2: `batchId` já processado devolve a resposta guardada, sem ler o corpo. */
  replayByBatch = false;
  private processed = new Map<string, UsageBatchResponse>();

  async uploadUsage(batchId: string, _tz: string, rows: PayloadRow[]): Promise<UsageBatchResponse> {
    this.calls.push({ batchId, keys: rows.map((r) => r.key) });
    const f = this.fault(this.calls.length, rows);
    const replay = this.replayByBatch ? this.processed.get(batchId) : undefined;
    if (replay && !f) return structuredClone(replay);
    if (f === 'fail503') throw new ApiError('indisponível', 503, null, null);
    if (f === 'too-large') throw new ApiError('grande', 413, null, null);
    const results: RowResult[] = rows.map((r) => {
      if (this.rejectKeys.has(r.key)) return { key: r.key, status: 'rejected', reason: 'invalid', retryable: false };
      const cur = this.rows.get(r.key);
      if (!cur) {
        this.rows.set(r.key, structuredClone(r));
        return { key: r.key, status: 'accepted' };
      }
      const merged = structuredClone(cur);
      merged.interactions = Math.max(cur.interactions, r.interactions);
      for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'thinking'] as const) {
        merged.tokens[k] = Math.max(cur.tokens[k], r.tokens[k]);
      }
      const changed = JSON.stringify(merged) !== JSON.stringify(cur);
      this.rows.set(r.key, merged);
      return { key: r.key, status: changed ? 'accepted' : 'duplicate' };
    });
    const rejectedN = results.filter((x) => x.status === 'rejected').length;
    const duplicateN = results.filter((x) => x.status === 'duplicate').length;
    this.processed.set(batchId, { batchId, accepted: results.length - rejectedN - duplicateN, duplicate: duplicateN, rejected: rejectedN, results });
    if (f === 'die') throw new Error('processo morreu');
    if (f === 'lose') throw new ApiError('resposta perdida', 0, null, null);
    const rejected = results.filter((x) => x.status === 'rejected').length;
    const duplicate = results.filter((x) => x.status === 'duplicate').length;
    return { batchId, accepted: results.length - rejected - duplicate, duplicate, rejected, results };
  }

  keysOfDay(day: string): string[] {
    return [...this.rows.values()].filter((r) => r.day === day).map((r) => r.key);
  }

  async reconcile(from: string, to: string): Promise<ReconcileDay[]> {
    const days = new Set([...this.rows.values()].map((r) => r.day).filter((d) => d >= from && d <= to));
    return [...days].sort().map((day) => {
      const keys = this.keysOfDay(day).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
      return {
        day,
        rows: keys.length,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 },
        keysDigest: createHash('sha256').update(keys.join('\n'), 'utf8').digest('hex'),
      };
    });
  }

  async usageKeys(day: string): Promise<string[]> {
    return this.keysOfDay(day);
  }

  /** Pedido de "sincronizar agora"; `undefined` imita servidor antigo (campo ausente). O `syncServed` igual o apaga. */
  syncRequestedAt: string | null | undefined = undefined;
  heartbeats: HeartbeatRequest[] = [];
  /** Campos a mais na resposta do heartbeat (activeTask, activeTaskEnded). */
  heartbeatExtra: Partial<HeartbeatResponse> = {};
  /** Faz o heartbeat de número n (começando em 1) falhar com erro de rede. */
  heartbeatFails: (n: number, req: HeartbeatRequest) => boolean = () => false;
  async heartbeat(req: HeartbeatRequest): Promise<HeartbeatResponse> {
    this.heartbeats.push(structuredClone(req));
    if (this.heartbeatFails(this.heartbeats.length, req)) throw new ApiError('rede', 0, null, null);
    if (req.syncServed !== undefined && req.syncServed === this.syncRequestedAt) this.syncRequestedAt = null;
    const res: HeartbeatResponse = { serverTime: new Date().toISOString(), minVersion: '0.0.0', activeTask: null, ...this.heartbeatExtra };
    if (this.syncRequestedAt !== undefined) res.syncRequestedAt = this.syncRequestedAt;
    return res;
  }
  async setActiveTask(_req?: unknown): Promise<SetActiveTaskResponse> {
    throw new Error('não usado');
  }
  clearCalls: Array<ClearActiveTaskRequest | undefined> = [];
  /** Quantos DELETE ainda falham com erro de rede. */
  clearFails = 0;
  async clearActiveTask(req?: ClearActiveTaskRequest): Promise<void> {
    this.clearCalls.push(req === undefined ? undefined : structuredClone(req));
    if (this.clearFails > 0) {
      this.clearFails--;
      throw new ApiError('rede', 0, null, null);
    }
    this.heartbeatExtra = { ...this.heartbeatExtra, activeTask: null };
  }
  async listTasks(): Promise<TaskItem[]> {
    return [];
  }
  /** Resposta da rota de padrões; `patternsError` simula 404/403/rede. */
  patterns: WorkItemPatternsResponse = {
    enabled: true,
    updatedAt: null,
    patterns: [{ regex: '(?i)\\QAB#\\E(\\d+)(?!\\d)', preset: 'AB_HASH', portable: { source: 'AB#(\\d+)(?!\\d)', flags: 'i' } }],
  };
  patternsError: ApiError | null = null;
  patternsCalls = 0;
  async workItemPatterns(): Promise<WorkItemPatternsResponse> {
    this.patternsCalls++;
    if (this.patternsError) throw this.patternsError;
    return structuredClone(this.patterns);
  }
}
