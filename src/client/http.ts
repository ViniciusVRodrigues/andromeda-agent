import {
  AGENT_VERSION,
  ApiError,
  type AgentApi,
  type DeviceCredentials,
  type HeartbeatRequest,
  type HeartbeatResponse,
  type PayloadRow,
  type ReconcileDay,
  type SetActiveTaskRequest,
  type SetActiveTaskResponse,
  type TaskItem,
  type UsageBatchResponse,
} from '../types.js';
import type { CredentialStore } from '../auth/tokens.js';
import {
  baseHeaders,
  parseRetryAfter,
  postJson,
  readJson,
  toCredentials,
  type FetchLike,
  type TokenResponse,
} from './device.js';

/** O refresh token não vale mais: o dev precisa parear de novo. */
export class ReauthRequired extends Error {
  constructor(message = 'sessão expirada; pareie o agente de novo') {
    super(message);
    this.name = 'ReauthRequired';
  }
}

const SKEW_MS = 60_000;

/** Troca o refresh token por um par novo. 400 invalid_grant vira ReauthRequired. */
export async function refreshCredentials(
  creds: DeviceCredentials,
  opts: { fetch?: FetchLike; now?: () => number; timeoutMs?: number } = {},
): Promise<DeviceCredentials> {
  const now = opts.now ?? Date.now;
  const { res, json } = await postJson(
    opts.fetch ?? fetch,
    `${creds.serverUrl.replace(/\/+$/, '')}/agent/v1/device/token`,
    { grant_type: 'refresh_token', refresh_token: creds.refreshToken },
    opts.timeoutMs,
  );
  if (res.ok) return toCredentials(creds.serverUrl, json as unknown as TokenResponse, now());
  if (res.status === 400 || res.status === 401) throw new ReauthRequired();
  throw new ApiError(
    `falha ao renovar a sessão (${res.status})`,
    res.status,
    typeof json.error === 'string' ? json.error : null,
    parseRetryAfter(res.headers.get('retry-after')),
  );
}

export class HttpAgentApi implements AgentApi {
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private refreshing: Promise<DeviceCredentials> | null = null;

  constructor(
    private readonly store: CredentialStore,
    opts: { fetch?: FetchLike; timeoutMs?: number; now?: () => number } = {},
  ) {
    this.fetchFn = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30000;
    this.now = opts.now ?? Date.now;
  }

  private refresh(creds: DeviceCredentials): Promise<DeviceCredentials> {
    this.refreshing ??= (async () => {
      try {
        const fresh = await refreshCredentials(creds, {
          fetch: this.fetchFn,
          now: this.now,
          timeoutMs: this.timeoutMs,
        });
        // grava o par novo ANTES de usar
        await this.store.save(fresh);
        return fresh;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  private async credentials(): Promise<DeviceCredentials> {
    const creds = await this.store.load();
    if (!creds) throw new ReauthRequired('agente não pareado');
    if (this.now() >= creds.accessExpiresAt - SKEW_MS) return this.refresh(creds);
    return creds;
  }

  private async send(
    creds: DeviceCredentials,
    method: string,
    path: string,
    body: unknown,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      ...baseHeaders(),
      Authorization: `Bearer ${creds.accessToken}`,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    try {
      return await this.fetchFn(`${creds.serverUrl.replace(/\/+$/, '')}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new ApiError('falha de rede ao falar com o servidor', 0, null, null);
    }
  }

  private async request(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    let creds = await this.credentials();
    let res = await this.send(creds, method, path, body);
    if (res.status === 401) {
      const j = await readJson(res.clone());
      if (j.code === 'AGENT_TOKEN_INVALID') {
        creds = await this.refresh(creds);
        res = await this.send(creds, method, path, body);
      }
    }
    if (res.ok) return res.status === 204 ? {} : await readJson(res);
    const j = await readJson(res);
    const code = typeof j.code === 'string' ? j.code : typeof j.error === 'string' ? j.error : null;
    const msg = typeof j.message === 'string' ? j.message : `erro ${res.status} do servidor`;
    throw new ApiError(msg, res.status, code, parseRetryAfter(res.headers.get('retry-after')));
  }

  async uploadUsage(batchId: string, timezone: string, rows: PayloadRow[]): Promise<UsageBatchResponse> {
    const j = await this.request('POST', '/agent/v1/usage', {
      batchId,
      agentVersion: AGENT_VERSION,
      timezone,
      rows,
    });
    return j as unknown as UsageBatchResponse;
  }

  async heartbeat(req: HeartbeatRequest): Promise<HeartbeatResponse> {
    return (await this.request('POST', '/agent/v1/heartbeat', req)) as unknown as HeartbeatResponse;
  }

  async reconcile(from: string, to: string): Promise<ReconcileDay[]> {
    const q = new URLSearchParams({ from, to });
    const j = await this.request('GET', `/agent/v1/usage/reconcile?${q.toString()}`);
    return (j.days ?? []) as ReconcileDay[];
  }

  async usageKeys(day: string): Promise<string[]> {
    const q = new URLSearchParams({ day });
    const j = await this.request('GET', `/agent/v1/usage/keys?${q.toString()}`);
    return (j.keys ?? []) as string[];
  }

  async setActiveTask(req: SetActiveTaskRequest): Promise<SetActiveTaskResponse> {
    return (await this.request('PUT', '/agent/v1/active-task', req)) as unknown as SetActiveTaskResponse;
  }

  async clearActiveTask(): Promise<void> {
    await this.request('DELETE', '/agent/v1/active-task');
  }

  async listTasks(): Promise<TaskItem[]> {
    const j = await this.request('GET', '/agent/v1/tasks');
    return (j.items ?? []) as TaskItem[];
  }
}
