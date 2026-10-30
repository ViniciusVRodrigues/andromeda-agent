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

/** Retry-After em segundos ou data HTTP. Devolve segundos (>= 0) ou null se ausente/inválido. */
export function parseRetryAfter(v: string | null, now: () => number = Date.now): number | null {
  if (v === null) return null;
  const t = v.trim();
  if (t === '') return null;
  const n = Number(t);
  if (Number.isFinite(n)) return n >= 0 ? n : null;
  const ms = Date.parse(t);
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.ceil((ms - now()) / 1000));
}

const RATE_LIMIT_MAX_BACKOFF_SEC = 60;
const TRANSIENT_MAX_BACKOFF_SEC = 30;
const RETRY_NOTICE = 'Sem resposta do servidor; tentando de novo até o código expirar...';
const UNREACHABLE_MSG =
  'não foi possível falar com o servidor antes de o código expirar. Verifique a rede e rode `andromeda-agent pair` de novo';
const RATE_LIMIT_EXPIRED_MSG =
  'o código de pareamento expirou enquanto o servidor limitava as tentativas (HTTP 429); rode o pareamento de novo em alguns minutos';

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
    /** Chamado uma vez, na primeira falha transitória (rede, timeout, 5xx). */
    onRetry?: (msg: string) => void;
  } = {},
): Promise<DeviceCredentials> {
  const base = validateServerUrl(serverUrl);
  const f = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const deadline = now() + expiresIn * 1000;
  let waitSec = Math.max(1, interval);
  let nextSec = waitSec;
  let rateLimited = 0;
  let sawRateLimit = false;
  let transient = 0;
  let sawTransient = false;
  // Falha transitória: espera em dobro a cada tentativa, até 30 s, e avisa uma vez.
  const transientBackoff = (): number => {
    if (!sawTransient) opts.onRetry?.(RETRY_NOTICE);
    sawTransient = true;
    transient += 1;
    return Math.min(waitSec * 2 ** (transient - 1), TRANSIENT_MAX_BACKOFF_SEC);
  };
  for (;;) {
    await sleep(nextSec * 1000);
    nextSec = waitSec;
    if (now() >= deadline) {
      throw new PairingError(
        sawTransient ? UNREACHABLE_MSG : sawRateLimit ? RATE_LIMIT_EXPIRED_MSG : 'o código de pareamento expirou',
        'expired_token',
      );
    }
    let res: Response;
    let json: Record<string, unknown>;
    try {
      ({ res, json } = await postJson(f, `${base}/agent/v1/device/token`, {
        grant_type: DEVICE_GRANT,
        device_code: deviceCode,
      }));
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 0) throw e;
      nextSec = transientBackoff();
      continue;
    }
    if (res.status >= 500) {
      nextSec = transientBackoff();
      continue;
    }
    transient = 0;
    if (res.ok) return toCredentials(base, json as unknown as TokenResponse, now());
    if (res.status === 429) {
      sawRateLimit = true;
      rateLimited += 1;
      const ra = parseRetryAfter(res.headers.get('retry-after'), now);
      const sec =
        ra !== null ? Math.max(ra, waitSec) : Math.min(waitSec * 2 ** rateLimited, RATE_LIMIT_MAX_BACKOFF_SEC);
      if (now() + sec * 1000 >= deadline) throw new PairingError(RATE_LIMIT_EXPIRED_MSG, 'expired_token');
      nextSec = sec;
      continue;
    }
    rateLimited = 0;
    const err = typeof json.error === 'string' ? json.error : null;
    if (res.status === 400 && err === 'authorization_pending') continue;
    if (res.status === 400 && err === 'slow_down') {
      waitSec += 5;
      nextSec = waitSec;
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
