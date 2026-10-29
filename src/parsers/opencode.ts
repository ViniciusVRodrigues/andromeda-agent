import { DatabaseSync } from 'node:sqlite';
import { readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { LogParser, ParseResult, ParserEnv, ToolId, UsageEvent } from '../types.js';
import { num, obj, parseObject, str } from './incremental.js';

/**
 * opencode 1.x e Kilo 7.x (fork do opencode) gravam o uso em SQLite: cada parte
 * `step-finish` e uma chamada ao modelo. A linha 2.x (`session_v2`) fica de fora.
 */

function dataDir(env: ParserEnv, app: string, dirVar?: string): string {
  const own = dirVar ? env.env[dirVar] : undefined;
  if (own && own.length > 0) return own;
  const xdg = env.env.XDG_DATA_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(env.home, '.local', 'share');
  return join(base, app);
}

/** Pasta de dados do opencode (`OPENCODE_DATA_DIR`, `XDG_DATA_HOME/opencode` ou `~/.local/share/opencode`). */
export function opencodeDir(env: ParserEnv): string {
  return dataDir(env, 'opencode', 'OPENCODE_DATA_DIR');
}

/** Caminho padrao da base do opencode; `OPENCODE_DB` (absoluto ou relativo a pasta) tem prioridade. */
export function opencodeDbPath(env: ParserEnv): string {
  const db = env.env.OPENCODE_DB;
  if (db && db.length > 0 && db !== ':memory:') return isAbsolute(db) ? db : join(opencodeDir(env), db);
  return join(opencodeDir(env), 'opencode.db');
}

export function kiloDir(env: ParserEnv): string {
  return dataDir(env, 'kilo');
}

/** Caminho padrao da base do Kilo; `KILO_DB` tem prioridade. */
export function kiloDbPath(env: ParserEnv): string {
  const db = env.env.KILO_DB;
  if (db && db.length > 0 && db !== ':memory:') return isAbsolute(db) ? db : join(kiloDir(env), db);
  return join(kiloDir(env), 'kilo.db');
}

interface Cursor {
  /** Maior `part.time_updated` ja lido. */
  t: number;
  /** Ids lidos com exatamente `t` (para nao reemitir nem perder linhas do mesmo ms). */
  ids: string[];
}

function loadCursor(s: string | undefined): Cursor | null {
  if (!s) return null;
  const o = parseObject(s);
  const t = o?.t;
  if (typeof t !== 'number' || !Number.isFinite(t) || !Array.isArray(o?.ids)) return null;
  return { t, ids: (o.ids as unknown[]).filter((x): x is string => typeof x === 'string') };
}

const SQL = `SELECT p.id AS id, p.session_id AS session_id, p.time_created AS tc, p.time_updated AS tu,
  p.data AS pdata, m.data AS mdata, s.directory AS dir
  FROM part p
  LEFT JOIN message m ON m.id = p.message_id
  LEFT JOIN session s ON s.id = p.session_id
  WHERE json_extract(p.data, '$.type') = 'step-finish' AND p.time_updated >= ?
  ORDER BY p.time_updated, p.id`;

function readDb(tool: ToolId, file: string, state: string | undefined): ParseResult {
  const cur = loadCursor(state);
  const since = cur ? cur.t : 0;
  const seen = new Set(cur ? cur.ids : []);
  const events: UsageEvent[] = [];
  let maxT = since;
  let maxIds: string[] = cur ? [...cur.ids] : [];
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const rows = db.prepare(SQL).all(since) as Record<string, unknown>[];
    for (const r of rows) {
      const id = str(r.id);
      const tu = typeof r.tu === 'number' ? r.tu : Number(r.tu);
      if (!id || !Number.isFinite(tu)) continue;
      if (tu === since && seen.has(id)) continue;
      if (tu > maxT) {
        maxT = tu;
        maxIds = [];
      }
      if (tu === maxT) maxIds.push(id);
      const p = parseObject(typeof r.pdata === 'string' ? r.pdata : '');
      const tk = obj(p?.tokens);
      if (!tk) continue;
      const cache = obj(tk.cache);
      const reasoning = num(tk.reasoning);
      const tokens = {
        input: num(tk.input),
        output: num(tk.output) + reasoning,
        cacheRead: num(cache?.read),
        cacheWrite: num(cache?.write),
        thinking: reasoning,
      };
      if (tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite === 0) continue;
      const m = parseObject(typeof r.mdata === 'string' ? r.mdata : '');
      const ts = Number(r.tc);
      events.push({
        tool,
        eventKey: id,
        sessionId: str(r.session_id) ?? '',
        timestamp: Number.isFinite(ts) ? ts : tu,
        model: str(m?.modelID) ?? 'unknown',
        cwd: str(obj(m?.path)?.cwd) ?? str(r.dir),
        branch: null,
        branchSource: 'none',
        tokens,
      });
    }
  } catch {
    // Base travada, schema diferente ou tabela ausente: nada novo e o cursor fica como estava.
    return { events: [], nextOffset: 0, state };
  } finally {
    try {
      db?.close();
    } catch {
      /* ignora */
    }
  }
  return { events, nextOffset: 0, state: JSON.stringify({ t: maxT, ids: maxIds } satisfies Cursor) };
}

async function listDbs(dir: string, prefix: string): Promise<string[]> {
  try {
    const names = await readdir(dir);
    return names
      .filter((n) => n.startsWith(prefix) && n.endsWith('.db'))
      .sort()
      .map((n) => join(dir, n));
  } catch {
    return [];
  }
}

function makeParser(tool: ToolId, prefix: string, dir: (e: ParserEnv) => string, dbPath: (e: ParserEnv) => string, dbVar: string): LogParser {
  return {
    tool,
    async discover(env) {
      const set = new Set(await listDbs(dir(env), prefix));
      const explicit = env.env[dbVar];
      if (explicit && explicit.length > 0 && explicit !== ':memory:') set.add(dbPath(env));
      return [...set].sort();
    },
    async parse(file, _offset, state): Promise<ParseResult> {
      return readDb(tool, file, state);
    },
  };
}

export const opencodeParser: LogParser = makeParser('opencode', 'opencode', opencodeDir, opencodeDbPath, 'OPENCODE_DB');
export const kiloParser: LogParser = makeParser('kilo', 'kilo', kiloDir, kiloDbPath, 'KILO_DB');
