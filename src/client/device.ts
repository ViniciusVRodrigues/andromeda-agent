import { hostname, release } from 'node:os';
import { AGENT_VERSION, ApiError, type DeviceCredentials } from '../types.js';

export type FetchLike = typeof fetch;

export interface MachineInfo {
  machineName: string;
  os: 'windows' | 'macos' | 'linux';
  osVersion: string;
  timezone: string;
}

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope?: string;
  device_id: string;
  organization_slug: string;
}

/** Pareamento terminou sem credenciais (negado, expirado). */
export class PairingError extends Error {
  constructor(
    message: string,
    readonly code: 'access_denied' | 'expired_token' | 'invalid_grant',
  ) {
    super(message);
    this.name = 'PairingError';
  }
}

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

/** Só https, exceto http em 127.0.0.1/localhost; sem usuário/senha. Devolve a base sem barra final. */
export function validateServerUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('URL do servidor inválida');
  }
  if (u.username || u.password) throw new Error('URL do servidor não pode ter usuário ou senha');
  const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
    throw new Error('URL do servidor precisa ser https:// (http só em 127.0.0.1 ou localhost)');
  }
  return u.toString().replace(/\/+$/, '');
}

export function defaultMachineInfo(): MachineInfo {
  const p = process.platform;
  return {
    machineName: hostname().slice(0, 64),
    os: p === 'win32' ? 'windows' : p === 'darwin' ? 'macos' : 'linux',
    osVersion: release(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

export function baseHeaders(): Record<string, string> {
  return { 'X-Andromeda-Agent-Version': AGENT_VERSION, Accept: 'application/json' };
}

export function parseRetryAfter(v: string | null): number | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const v: unknown = await res.json();
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function postJson(
  f: FetchLike,
  url: string,
  body: unknown,
  timeoutMs = 30000,
): Promise<{ res: Response; json: Record<string, unknown> }> {
  let res: Response;
  try {
    res = await f(url, {
      method: 'POST',
      headers: { ...baseHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new ApiError('falha de rede ao falar com o servidor', 0, null, null);
  }
  return { res, json: await readJson(res) };
}

export function toCredentials(serverUrl: string, t: TokenResponse, now: number): DeviceCredentials {
  return {
    serverUrl,
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    accessExpiresAt: now + t.expires_in * 1000,
    deviceId: t.device_id,
    organizationSlug: t.organization_slug,
  };
}

export async function startPairing(
  serverUrl: string,
  opts: { fetch?: FetchLike; machineInfo?: MachineInfo } = {},
): Promise<DeviceCodeResponse> {
  const base = validateServerUrl(serverUrl);
  const m = opts.machineInfo ?? defaultMachineInfo();
  const { res, json } = await postJson(opts.fetch ?? fetch, `${base}/agent/v1/device/code`, {
    agentVersion: AGENT_VERSION,
    machineName: m.machineName.slice(0, 64),
    os: m.os,
    osVersion: m.osVersion,
    timezone: m.timezone,
  });
  if (!res.ok) {
    throw new ApiError(
      `pareamento recusado (${res.status})`,
      res.status,
      typeof json.code === 'string' ? json.code : typeof json.error === 'string' ? json.error : null,
      parseRetryAfter(res.headers.get('retry-after')),
    );
  }
  return json as unknown as DeviceCodeResponse;
}

export async function pollForToken(
  serverUrl: string,
  deviceCode: string,
  interval: number,
  expiresIn: number,
  opts: {
    fetch?: FetchLike;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<DeviceCredentials> {
  const base = validateServerUrl(serverUrl);
  const f = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const deadline = now() + expiresIn * 1000;
  let waitSec = Math.max(1, interval);
  for (;;) {
    await sleep(waitSec * 1000);
    if (now() >= deadline) throw new PairingError('o código de pareamento expirou', 'expired_token');
    const { res, json } = await postJson(f, `${base}/agent/v1/device/token`, {
      grant_type: DEVICE_GRANT,
      device_code: deviceCode,
    });
    if (res.ok) return toCredentials(base, json as unknown as TokenResponse, now());
    const err = typeof json.error === 'string' ? json.error : null;
    if (res.status === 400 && err === 'authorization_pending') continue;
    if (res.status === 400 && err === 'slow_down') {
      waitSec += 5;
      continue;
    }
    if (res.status === 400 && err === 'access_denied') {
      throw new PairingError('o pareamento foi negado', 'access_denied');
    }
    if (res.status === 400 && err === 'expired_token') {
      throw new PairingError('o código de pareamento expirou', 'expired_token');
    }
    if (res.status === 400 && err === 'invalid_grant') {
      throw new PairingError('código de dispositivo inválido', 'invalid_grant');
    }
    throw new ApiError(
      `resposta inesperada no pareamento (${res.status})`,
      res.status,
      err,
      parseRetryAfter(res.headers.get('retry-after')),
    );
  }
}
