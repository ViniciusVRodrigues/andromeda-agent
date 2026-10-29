import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Bucket,
  LocalActiveTask,
  PayloadRow,
  ResolvedEvent,
  RowResult,
  TokenCounts,
  ToolId,
} from '../types.js';
import { nextDelay } from '../sync/backoff.js';

export interface Cursor {
  offset: number;
  size: number;
  mtimeMs: number;
  state: string | null;
}

export type OutboxStatus = 'pending' | 'sent' | 'rejected';

export interface OutboxItem {
  key: string;
  day: string;
  attempts: number;
  row: PayloadRow;
}

export interface OutboxStats {
  pending: number;
  rejected: number;
  sent: number;
  oldestPendingDay: string | null;
}

export interface LocalDay {
  day: string;
  /** Chaves `sent` do dia, em ordem binária UTF-8. */
  keys: string[];
  rows: number;
  tokens: TokenCounts;
}

export interface RejectedRow {
  key: string;
  day: string;
  reason: string | null;
  row: PayloadRow;
}

type Row = Record<string, unknown>;

const SCHEMA_V1 = `
CREATE TABLE cursors (
  file TEXT PRIMARY KEY,
  offset INTEGER NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  state TEXT
);
CREATE TABLE events (
  tool TEXT NOT NULL,
  event_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  model TEXT NOT NULL,
  repo TEXT,
  branch TEXT,
  branch_approx INTEGER NOT NULL DEFAULT 0,
  input INTEGER NOT NULL,
  output INTEGER NOT NULL,
  cache_read INTEGER NOT NULL,
  cache_write INTEGER NOT NULL,
  thinking INTEGER NOT NULL,
  PRIMARY KEY (tool, event_key)
);
CREATE INDEX events_ts ON events(ts);
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE outbox (
  key TEXT PRIMARY KEY,
  row_json TEXT NOT NULL,
  day TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  sent_json TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX outbox_status_day ON outbox(status, day, key);
`;

const HOUR_MS = 3_600_000;
const dayFormatters = new Map<string, Intl.DateTimeFormat>();

/** Dia local (`AAAA-MM-DD`) de um instante no fuso IANA dado. */
export function localDayOf(ms: number, timezone: string): string {
  let f = dayFormatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
    dayFormatters.set(timezone, f);
  }
  let y = '';
  let m = '';
  let d = '';
  for (const p of f.formatToParts(new Date(ms))) {
    if (p.type === 'year') y = p.value;
    else if (p.type === 'month') m = p.value;
    else if (p.type === 'day') d = p.value;
  }
  return `${y}-${m}-${d}`;
}

/** true se algum contador de `a` é maior que o de `b`. */
export function rowGreater(a: PayloadRow, b: PayloadRow): boolean {
  return (
    a.interactions > b.interactions ||
    a.tokens.input > b.tokens.input ||
    a.tokens.output > b.tokens.output ||
    a.tokens.cacheRead > b.tokens.cacheRead ||
    a.tokens.cacheWrite > b.tokens.cacheWrite ||
    a.tokens.thinking > b.tokens.thinking
  );
}

export class Store {
  private constructor(private readonly db: DatabaseSync) {}

  static open(dir: string): Store {
    mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(join(dir, 'agent.db'));
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA synchronous=NORMAL');
    const store = new Store(db);
    store.migrate();
    return store;
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    const v = Number((this.db.prepare('PRAGMA user_version').get() as Row).user_version);
    if (v < 1) {
      this.tx(() => {
        this.db.exec(SCHEMA_V1);
        this.db.exec('PRAGMA user_version=1');
      });
    }
    if (v < 2) {
      // v2: o repo entra na chave. Horas já no outbox (qualquer status) ficam com a chave
      // antiga; só a partir da hora seguinte à maior delas vale a nova. Base nova: 0.
      this.tx(() => {
        const r = this.db.prepare(`SELECT MAX(json_extract(row_json, '$.hour')) AS h FROM outbox`).get() as Row;
        const h = typeof r.h === 'string' ? Date.parse(r.h) : NaN;
        const from = Number.isFinite(h) ? (Math.floor(h / HOUR_MS) + 1) * HOUR_MS : 0;
        this.setMeta('key_repo_from', String(from));
        this.db.exec('PRAGMA user_version=2');
      });
    }
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* já desfeito */
      }
      throw e;
    }
  }

  // ---- cursors ----

  getCursor(file: string): Cursor | null {
    const r = this.db.prepare('SELECT offset, size, mtime_ms, state FROM cursors WHERE file=?').get(file) as Row | undefined;
    if (!r) return null;
    return { offset: Number(r.offset), size: Number(r.size), mtimeMs: Number(r.mtime_ms), state: (r.state as string | null) ?? null };
  }

  setCursor(file: string, c: Cursor): void {
    this.db
      .prepare(
        `INSERT INTO cursors(file, offset, size, mtime_ms, state) VALUES (?,?,?,?,?)
         ON CONFLICT(file) DO UPDATE SET offset=excluded.offset, size=excluded.size, mtime_ms=excluded.mtime_ms, state=excluded.state`,
      )
      .run(file, c.offset, c.size, c.mtimeMs, c.state);
  }

  // ---- events ----

  /**
   * Dedupe global: a mesma (tool, eventKey) fica com o maior `output`; empate mantém.
   * O `ts` é sempre o menor visto, para a mensagem ficar na hora em que começou.
   * Evento sem token nenhum (entrada, saída e cache zerados) não é guardado.
   */
  upsertEvents(events: ResolvedEvent[]): void {
    const st = this.db.prepare(
      `INSERT INTO events(tool, event_key, session_id, ts, model, repo, branch, branch_approx, input, output, cache_read, cache_write, thinking)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(tool, event_key) DO UPDATE SET
         ts=MIN(events.ts, excluded.ts),
         session_id=CASE WHEN excluded.output > events.output THEN excluded.session_id ELSE events.session_id END,
         model=CASE WHEN excluded.output > events.output THEN excluded.model ELSE events.model END,
         repo=CASE WHEN excluded.output > events.output THEN excluded.repo ELSE events.repo END,
         branch=CASE WHEN excluded.output > events.output THEN excluded.branch ELSE events.branch END,
         branch_approx=CASE WHEN excluded.output > events.output THEN excluded.branch_approx ELSE events.branch_approx END,
         input=CASE WHEN excluded.output > events.output THEN excluded.input ELSE events.input END,
         output=CASE WHEN excluded.output > events.output THEN excluded.output ELSE events.output END,
         cache_read=CASE WHEN excluded.output > events.output THEN excluded.cache_read ELSE events.cache_read END,
         cache_write=CASE WHEN excluded.output > events.output THEN excluded.cache_write ELSE events.cache_write END,
         thinking=CASE WHEN excluded.output > events.output THEN excluded.thinking ELSE events.thinking END`,
    );
    for (const e of events) {
      const t = e.tokens;
      if (t.input + t.output + t.cacheRead + t.cacheWrite === 0) continue;
      st.run(
        e.tool,
        e.eventKey,
        e.sessionId,
        e.timestamp,
        e.model,
        e.repo,
        e.resolvedBranch,
        e.branchApprox ? 1 : 0,
        e.tokens.input,
        e.tokens.output,
        e.tokens.cacheRead,
        e.tokens.cacheWrite,
        e.tokens.thinking,
      );
    }
  }

  /** Cursor e eventos da mesma leitura, numa transação só. */
  commitParse(file: string, cursor: Cursor, events: ResolvedEvent[]): void {
    this.tx(() => {
      this.setCursor(file, cursor);
      this.upsertEvents(events);
    });
  }

  eventCount(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM events').get() as Row).n);
  }

  pruneEvents(olderThanMs: number): number {
    return Number(this.db.prepare('DELETE FROM events WHERE ts < ?').run(olderThanMs).changes);
  }

  /**
   * Um bucket por (ferramenta, sessão, modelo, hora, branch, repo). As horas
   * anteriores a `key_repo_from` seguem o formato antigo (sem repo na chave, uma
   * linha por hora com o repo de mais chamadas) para a chave já enviada não mudar.
   */
  bucketsSince(tsMs: number, timezone: string): Bucket[] {
    const keyRepoFrom = Number(this.getMeta('key_repo_from') ?? 0);
    const rows = this.db
      .prepare(
        `SELECT tool, session_id, model, (ts / ${HOUR_MS}) * ${HOUR_MS} AS hour_start, repo, branch,
                MAX(branch_approx) AS approx, SUM(input) AS input, SUM(output) AS output,
                SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write, SUM(thinking) AS thinking,
                COUNT(*) AS n
         FROM events WHERE ts >= ?
         GROUP BY tool, session_id, model, hour_start, repo, branch
         ORDER BY hour_start, tool, session_id, model, branch, repo IS NULL, repo`,
      )
      .all(tsMs) as Row[];
    const out = new Map<string, Bucket & { repoN: number }>();
    for (const r of rows) {
      const hourStart = Number(r.hour_start);
      const keyRepo = hourStart >= keyRepoFrom;
      const branch = (r.branch as string | null) ?? null;
      const repo = (r.repo as string | null) ?? null;
      const id = JSON.stringify([r.tool, r.session_id, r.model, hourStart, branch, keyRepo ? repo : 0]);
      const n = Number(r.n);
      const cur = out.get(id);
      if (!cur) {
        out.set(id, {
          tool: r.tool as ToolId,
          sessionId: r.session_id as string,
          model: r.model as string,
          hourStart,
          day: localDayOf(hourStart, timezone),
          repo,
          repoN: n,
          branch,
          branchApprox: Number(r.approx) === 1,
          keyRepo,
          tokens: {
            input: Number(r.input),
            output: Number(r.output),
            cacheRead: Number(r.cache_read),
            cacheWrite: Number(r.cache_write),
            thinking: Number(r.thinking),
          },
          interactions: n,
        });
        continue;
      }
      if (n > cur.repoN) {
        cur.repo = repo;
        cur.repoN = n;
      }
      cur.branchApprox ||= Number(r.approx) === 1;
      cur.tokens.input += Number(r.input);
      cur.tokens.output += Number(r.output);
      cur.tokens.cacheRead += Number(r.cache_read);
      cur.tokens.cacheWrite += Number(r.cache_write);
      cur.tokens.thinking += Number(r.thinking);
      cur.interactions += n;
    }
    return [...out.values()].map(({ repoN: _repoN, ...b }) => b);
  }

  // ---- meta ----

  getMeta(k: string): string | null {
    const r = this.db.prepare('SELECT v FROM meta WHERE k=?').get(k) as Row | undefined;
    return r ? (r.v as string) : null;
  }

  setMeta(k: string, v: string): void {
    this.db.prepare('INSERT INTO meta(k, v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, v);
  }

  deleteMeta(k: string): void {
    this.db.prepare('DELETE FROM meta WHERE k=?').run(k);
  }

  getOrCreateSalt(): string {
    const cur = this.getMeta('salt');
    if (cur) return cur;
    const salt = randomBytes(32).toString('hex');
    this.setMeta('salt', salt);
    return salt;
  }

  setLocalActiveTask(t: LocalActiveTask | null): void {
    if (t) this.setMeta('active_task', JSON.stringify(t));
    else this.deleteMeta('active_task');
  }

  getLocalActiveTask(): LocalActiveTask | null {
    const v = this.getMeta('active_task');
    return v ? (JSON.parse(v) as LocalActiveTask) : null;
  }

  // ---- outbox ----

  /** Linha nova entra pending; chave existente só muda se algum contador cresceu (substitui, nunca soma). */
  enqueue(rows: PayloadRow[], nowMs: number = Date.now()): void {
    const sel = this.db.prepare('SELECT row_json, status, sent_json FROM outbox WHERE key=?');
    const ins = this.db.prepare(
      `INSERT INTO outbox(key, row_json, day, status, attempts, next_at, updated_at) VALUES (?,?,?,'pending',0,0,?)`,
    );
    const upd = this.db.prepare(
      `UPDATE outbox SET row_json=?, day=?, status='pending', attempts=0, next_at=0, last_error=NULL, updated_at=? WHERE key=?`,
    );
    this.tx(() => {
      for (const row of rows) {
        const cur = sel.get(row.key) as Row | undefined;
        if (!cur) {
          ins.run(row.key, JSON.stringify(row), row.day, nowMs);
          continue;
        }
        const ref = JSON.parse((cur.status === 'sent' && cur.sent_json ? cur.sent_json : cur.row_json) as string) as PayloadRow;
        if (rowGreater(row, ref)) upd.run(JSON.stringify(row), row.day, nowMs, row.key);
      }
    });
  }

  takePending(limit: number, nowMs: number, exclude?: ReadonlySet<string>): OutboxItem[] {
    const rows = this.db
      .prepare(`SELECT key, day, attempts, row_json FROM outbox WHERE status='pending' AND next_at <= ? ORDER BY day, key`)
      .all(nowMs) as Row[];
    const out: OutboxItem[] = [];
    for (const r of rows) {
      if (exclude?.has(r.key as string)) continue;
      out.push(toItem(r));
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Das chaves dadas, as que seguem pending e já podem ser enviadas. */
  pendingByKeys(keys: string[], nowMs: number): OutboxItem[] {
    const st = this.db.prepare(`SELECT key, day, attempts, row_json FROM outbox WHERE key=? AND status='pending' AND next_at <= ?`);
    const out: OutboxItem[] = [];
    for (const k of keys) {
      const r = st.get(k, nowMs) as Row | undefined;
      if (r) out.push(toItem(r));
    }
    return out;
  }

  /** `sentRows`: o que de fato foi enviado (se a linha cresceu durante o envio, volta a pending). */
  applyResults(results: RowResult[], nowMs: number, sentRows?: ReadonlyMap<string, PayloadRow>): void {
    const sel = this.db.prepare('SELECT row_json, attempts FROM outbox WHERE key=?');
    const toSent = this.db.prepare(`UPDATE outbox SET status='sent', sent_json=?, last_error=NULL, attempts=0, updated_at=? WHERE key=?`);
    const toPending = this.db.prepare(
      `UPDATE outbox SET status='pending', sent_json=?, attempts=0, next_at=0, last_error=NULL, updated_at=? WHERE key=?`,
    );
    const retry = this.db.prepare(
      `UPDATE outbox SET status='pending', attempts=?, next_at=?, last_error=?, updated_at=? WHERE key=?`,
    );
    const reject = this.db.prepare(`UPDATE outbox SET status='rejected', last_error=?, updated_at=? WHERE key=?`);
    this.tx(() => {
      for (const res of results) {
        const cur = sel.get(res.key) as Row | undefined;
        if (!cur) continue;
        if (res.status === 'accepted' || res.status === 'duplicate') {
          const current = JSON.parse(cur.row_json as string) as PayloadRow;
          const sent = sentRows?.get(res.key) ?? current;
          if (rowGreater(current, sent)) toPending.run(JSON.stringify(sent), nowMs, res.key);
          else toSent.run(JSON.stringify(sent), nowMs, res.key);
        } else if (res.retryable) {
          const attempts = Number(cur.attempts) + 1;
          retry.run(attempts, nowMs + nextDelay(attempts), res.reason ?? res.field ?? 'rejected', nowMs, res.key);
        } else {
          reject.run(res.reason ?? res.field ?? 'rejected', nowMs, res.key);
        }
      }
    });
  }

  /** Falha de lote inteiro: adia as chaves e conta a tentativa. */
  deferAll(keys: string[], nowMs: number, delayMs: number): void {
    const st = this.db.prepare(`UPDATE outbox SET attempts=attempts+1, next_at=?, updated_at=? WHERE key=? AND status='pending'`);
    this.tx(() => {
      for (const k of keys) st.run(nowMs + delayMs, nowMs, k);
    });
  }

  /** Devolve chaves `sent` para a fila (reconciliação). */
  requeue(keys: string[], nowMs: number): number {
    const st = this.db.prepare(
      `UPDATE outbox SET status='pending', attempts=0, next_at=0, last_error=NULL, updated_at=? WHERE key=? AND status='sent'`,
    );
    return this.tx(() => {
      let n = 0;
      for (const k of keys) n += Number(st.run(nowMs, k).changes);
      return n;
    });
  }

  stats(): OutboxStats {
    const counts = this.db.prepare('SELECT status, COUNT(*) AS n FROM outbox GROUP BY status').all() as Row[];
    const by = (s: string): number => Number(counts.find((c) => c.status === s)?.n ?? 0);
    const old = this.db.prepare(`SELECT MIN(day) AS d FROM outbox WHERE status='pending'`).get() as Row;
    return { pending: by('pending'), rejected: by('rejected'), sent: by('sent'), oldestPendingDay: (old.d as string | null) ?? null };
  }

  rejectedRows(limit: number): RejectedRow[] {
    const rows = this.db
      .prepare(`SELECT key, day, last_error, row_json FROM outbox WHERE status='rejected' ORDER BY day, key LIMIT ?`)
      .all(limit) as Row[];
    return rows.map((r) => ({
      key: r.key as string,
      day: r.day as string,
      reason: (r.last_error as string | null) ?? null,
      row: JSON.parse(r.row_json as string) as PayloadRow,
    }));
  }

  /** Chaves `sent` do dia (ordem binária UTF-8) e somas, para reconciliar. */
  localDay(day: string): LocalDay {
    const rows = this.db.prepare(`SELECT key, sent_json FROM outbox WHERE status='sent' AND day=?`).all(day) as Row[];
    const tokens: TokenCounts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 };
    const keys: string[] = [];
    for (const r of rows) {
      keys.push(r.key as string);
      const p = JSON.parse(r.sent_json as string) as PayloadRow;
      tokens.input += p.tokens.input;
      tokens.output += p.tokens.output;
      tokens.cacheRead += p.tokens.cacheRead;
      tokens.cacheWrite += p.tokens.cacheWrite;
      tokens.thinking += p.tokens.thinking;
    }
    keys.sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
    return { day, keys, rows: keys.length, tokens };
  }

  // ---- lote em curso (sender) ----

  /** `digest` é o SHA-256 das linhas enviadas; ausente em lotes gravados por versão antiga. */
  getInflight(): { batchId: string; keys: string[]; digest?: string } | null {
    const v = this.getMeta('inflight');
    return v ? (JSON.parse(v) as { batchId: string; keys: string[]; digest?: string }) : null;
  }

  setInflight(batchId: string, keys: string[], digest: string): void {
    this.setMeta('inflight', JSON.stringify({ batchId, keys, digest }));
  }

  clearInflight(): void {
    this.deleteMeta('inflight');
  }
}

function toItem(r: Row): OutboxItem {
  return { key: r.key as string, day: r.day as string, attempts: Number(r.attempts), row: JSON.parse(r.row_json as string) as PayloadRow };
}
