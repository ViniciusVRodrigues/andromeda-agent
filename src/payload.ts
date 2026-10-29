import { createHash } from 'node:crypto';
import type { AttributionMethod, Bucket, PayloadRow, TokenCounts } from './types.js';

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function sessionHash(salt: string, tool: string, sessionId: string): string {
  return sha256Hex(`${salt}\0${tool}\0${sessionId}`).slice(0, 32);
}

export function hourIso(hourStart: number): string {
  return `${new Date(hourStart).toISOString().slice(0, 13)}:00:00Z`;
}

const MAX_KEY = 200;

export function rowKey(tool: string, hash: string, model: string, hourStart: number, branch: string | null): string {
  const modelSafe = model.replace(/[^A-Za-z0-9:._@/#-]/g, '_');
  const br = branch ? sha256Hex(branch).slice(0, 6) : '-';
  const head = `${tool}:${hash}:`;
  const tail = `:${hourIso(hourStart)}:${br}`;
  const room = Math.max(0, MAX_KEY - head.length - tail.length);
  return `${head}${modelSafe.slice(0, room)}${tail}`;
}

function nat(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

export interface RowContext {
  salt: string;
  taskRef: string | null;
  attributionMethod: AttributionMethod;
}

/** Monta a linha só pelos campos nomeados; nunca espalha o bucket. */
export function buildRow(bucket: Bucket, ctx: RowContext): PayloadRow {
  const hash = sessionHash(ctx.salt, bucket.tool, bucket.sessionId);
  return {
    key: rowKey(bucket.tool, hash, bucket.model, bucket.hourStart, bucket.branch),
    tool: bucket.tool,
    sessionHash: hash,
    model: bucket.model,
    hour: hourIso(bucket.hourStart),
    day: bucket.day,
    tokens: {
      input: nat(bucket.tokens.input),
      output: nat(bucket.tokens.output),
      cacheRead: nat(bucket.tokens.cacheRead),
      cacheWrite: nat(bucket.tokens.cacheWrite),
      thinking: nat(bucket.tokens.thinking),
    },
    interactions: nat(bucket.interactions),
    origin: 'real',
    repo: bucket.repo,
    branch: bucket.branch,
    taskRef: ctx.taskRef,
    attributionMethod: ctx.attributionMethod,
  };
}

export const ALLOWED_ROW_FIELDS: readonly string[] = [
  'key', 'tool', 'sessionHash', 'model', 'hour', 'day', 'tokens', 'interactions',
  'origin', 'repo', 'branch', 'taskRef', 'attributionMethod',
];
export const ALLOWED_TOKEN_FIELDS: readonly (keyof TokenCounts)[] = [
  'input', 'output', 'cacheRead', 'cacheWrite', 'thinking',
];

const LOCAL_PATH = [/^[A-Za-z]:[\\/]/, /^\\\\/, /^\/(Users|home)\//, /^~\//, /[A-Za-z]:\\/];
const CRED_URL = /:\/\/[^/]*@/;
/** Host com pelo menos dois caracteres e um ou mais segmentos, sem `:`, `@` nem `\`. */
const REPO_SHAPE = /^[a-z0-9][a-z0-9.-]+(\/[^/\s\\:@]+)+$/;

function checkString(where: string, v: string, out: string[]): void {
  if (LOCAL_PATH.some((r) => r.test(v))) out.push(`${where}: valor parece caminho local`);
  else if (CRED_URL.test(v)) out.push(`${where}: valor parece URL com credencial`);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const STR_FIELDS = ['key', 'tool', 'sessionHash', 'model', 'hour', 'day', 'origin', 'attributionMethod'];
const NULLABLE_STR_FIELDS = ['repo', 'branch', 'taskRef'];

export function guardRows(rows: readonly unknown[]): string[] {
  const out: string[] = [];
  rows.forEach((row, i) => {
    const w = `row[${i}]`;
    if (!isObj(row)) {
      out.push(`${w}: não é objeto`);
      return;
    }
    for (const k of Object.keys(row)) {
      if (!ALLOWED_ROW_FIELDS.includes(k)) out.push(`${w}.${k}: campo fora da lista`);
    }
    for (const k of STR_FIELDS) {
      const v = row[k];
      if (typeof v !== 'string') out.push(`${w}.${k}: deve ser texto`);
      else checkString(`${w}.${k}`, v, out);
    }
    for (const k of NULLABLE_STR_FIELDS) {
      const v = row[k];
      if (v === null) continue;
      if (typeof v !== 'string') out.push(`${w}.${k}: deve ser texto ou nulo`);
      else checkString(`${w}.${k}`, v, out);
    }
    // `repo` só sai na forma que o normalizeRemote produz: host e caminho, nada de disco.
    if (typeof row.repo === 'string' && !REPO_SHAPE.test(row.repo)) {
      out.push(`${w}.repo: não tem a forma host/caminho`);
    }
    if (!Number.isInteger(row.interactions) || (row.interactions as number) < 0) {
      out.push(`${w}.interactions: deve ser inteiro >= 0`);
    }
    const t = row.tokens;
    if (!isObj(t)) {
      out.push(`${w}.tokens: deve ser objeto`);
    } else {
      for (const k of Object.keys(t)) {
        if (!(ALLOWED_TOKEN_FIELDS as readonly string[]).includes(k)) out.push(`${w}.tokens.${k}: campo fora da lista`);
      }
      for (const k of ALLOWED_TOKEN_FIELDS) {
        const v = t[k];
        if (!Number.isInteger(v) || (v as number) < 0) out.push(`${w}.tokens.${k}: deve ser inteiro >= 0`);
      }
    }
  });
  return out;
}

/** Lança se alguma linha violar a lista de permissão. Chame antes de todo lote. */
export function assertRowsSafe(rows: readonly unknown[]): void {
  const v = guardRows(rows);
  if (v.length > 0) throw new Error(`Lote bloqueado pela lista de permissão:\n${v.slice(0, 20).join('\n')}`);
}
