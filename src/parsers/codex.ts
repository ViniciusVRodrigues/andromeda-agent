import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import type { LogParser, ParseResult, ParserEnv, TokenCounts, UsageEvent } from '../types.js';
import { num, obj, parseObject, readLinesFrom, splitCompleteLines, str, walkFiles } from './incremental.js';

export function codexRoot(env: ParserEnv): string {
  const dir = env.env.CODEX_HOME;
  return join(dir && dir.length > 0 ? dir : join(env.home, '.codex'), 'sessions');
}

interface Usage {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  total: number;
}

interface CodexState {
  last: Usage | null;
  sessionId: string;
  cwd: string | null;
  model: string | null;
  branch: string | null;
  useRecord: boolean;
  /**
   * Total acumulado já emitido por `token_count` antes de o arquivo passar a ter
   * `token_usage_record`; registros com `thread_token_usage` até esse total já
   * foram contados e são pulados.
   */
  recordFloor: number | null;
}

const EMPTY: CodexState = { last: null, sessionId: '', cwd: null, model: null, branch: null, useRecord: false, recordFloor: null };

function readUsage(v: unknown): Usage | null {
  const u = obj(v);
  if (!u) return null;
  return {
    input: num(u.input_tokens),
    cached: num(u.cached_input_tokens),
    cacheWrite: num(u.cache_write_input_tokens),
    output: num(u.output_tokens),
    reasoning: num(u.reasoning_output_tokens),
    total: num(u.total_tokens),
  };
}

function toTokens(u: Usage): TokenCounts {
  return {
    input: Math.max(0, u.input - u.cached),
    output: u.output,
    cacheRead: u.cached,
    cacheWrite: u.cacheWrite,
    thinking: u.reasoning,
  };
}

function diff(cur: Usage, prev: Usage): Usage {
  const d = (a: number, b: number) => Math.max(0, a - b);
  return {
    input: d(cur.input, prev.input),
    cached: d(cur.cached, prev.cached),
    cacheWrite: d(cur.cacheWrite, prev.cacheWrite),
    output: d(cur.output, prev.output),
    reasoning: d(cur.reasoning, prev.reasoning),
    total: d(cur.total, prev.total),
  };
}

function isEmptyUsage(u: Usage): boolean {
  return u.input === 0 && u.cached === 0 && u.cacheWrite === 0 && u.output === 0 && u.reasoning === 0;
}

function sameComponents(a: Usage, b: Usage): boolean {
  return a.input === b.input && a.cached === b.cached && a.cacheWrite === b.cacheWrite && a.output === b.output && a.reasoning === b.reasoning;
}

/** Algum componente menor que o anterior: o contador recomeçou. */
function anyComponentLess(a: Usage, b: Usage): boolean {
  return a.input < b.input || a.cached < b.cached || a.cacheWrite < b.cacheWrite || a.output < b.output || a.reasoning < b.reasoning;
}

function loadState(s: string | undefined): CodexState {
  if (!s) return { ...EMPTY };
  try {
    return { ...EMPTY, ...(JSON.parse(s) as Partial<CodexState>) };
  } catch {
    return { ...EMPTY };
  }
}

const KEYWORDS = ['token_count', 'token_usage_record', 'session_meta', 'turn_context'];

/** Processa linhas já separadas; função pura sobre o estado. */
export function parseCodexLines(
  lines: string[],
  fallbackId: string,
  prev: string | undefined,
): { events: UsageEvent[]; state: string } {
  const st = loadState(prev);
  const recs: Record<string, unknown>[] = [];
  for (const l of lines) {
    if (!KEYWORDS.some((k) => l.includes(k))) continue;
    const r = parseObject(l);
    if (r) recs.push(r);
  }
  if (!st.useRecord && recs.some((r) => r.type === 'token_usage_record')) {
    st.useRecord = true;
    st.recordFloor = st.last?.total ?? null;
  }
  const events: UsageEvent[] = [];

  const emit = (key: string, ts: number, model: string | null, tokens: TokenCounts) => {
    events.push({
      tool: 'codex',
      eventKey: key,
      sessionId: st.sessionId || fallbackId,
      timestamp: ts,
      model: model ?? st.model ?? 'unknown',
      cwd: st.cwd,
      branch: st.branch,
      branchSource: 'none',
      tokens,
    });
  };

  for (const r of recs) {
    const payload = obj(r.payload) ?? {};
    const ts = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN;
    switch (r.type) {
      case 'session_meta': {
        st.sessionId = str(payload.id) ?? st.sessionId;
        st.cwd = str(payload.cwd) ?? st.cwd;
        st.branch = str(obj(payload.git)?.branch) ?? st.branch;
        break;
      }
      case 'turn_context': {
        st.cwd = str(payload.cwd) ?? st.cwd;
        st.model = str(payload.model) ?? st.model;
        break;
      }
      case 'event_msg': {
        if (payload.type !== 'token_count' || st.useRecord || !Number.isFinite(ts)) break;
        const total = readUsage(obj(payload.info)?.total_token_usage);
        if (!total) break;
        // Compara pelos componentes, não pelo `total_tokens`: a extensão do VS Code grava
        // `token_count` de histórico restaurado (componentes zerados, só o total muda).
        if (isEmptyUsage(total)) break;
        let delta = total;
        if (st.last) {
          if (sameComponents(total, st.last)) break;
          delta = anyComponentLess(total, st.last) ? total : diff(total, st.last);
        }
        st.last = total;
        emit(`${st.sessionId || fallbackId}:${total.total}`, ts, null, toTokens(delta));
        break;
      }
      case 'token_usage_record': {
        const src = payload.response_id !== undefined || payload.usage !== undefined ? payload : r;
        const id = str(src.response_id);
        const u = readUsage(src.usage);
        if (!id || !u || !Number.isFinite(ts)) break;
        const thread = readUsage(src.thread_token_usage);
        if (st.recordFloor !== null && thread && thread.total <= st.recordFloor) break;
        emit(id, ts, str(src.model), toTokens(u));
        break;
      }
    }
  }
  return { events, state: JSON.stringify(st) };
}

function fallbackIdOf(file: string): string {
  return (
    file
      .replace(/\.zst$/, '')
      .replace(/\.jsonl$/, '')
      .split(/[\\/]/)
      .pop() ?? file
  );
}

export const codexParser: LogParser = {
  tool: 'codex',
  discover: (env) => walkFiles(codexRoot(env), (n) => /^rollout-.*\.jsonl(\.zst)?$/.test(n)),
  async parse(file, offset, state): Promise<ParseResult> {
    let lines: string[];
    let nextOffset: number;
    if (file.endsWith('.zst')) {
      const buf = zstdDecompressSync(await readFile(file));
      const start = offset > buf.length || offset < 0 ? 0 : offset;
      const { lines: got, consumed } = splitCompleteLines(buf.subarray(start));
      lines = got;
      nextOffset = start + consumed;
      if (start === 0 && offset !== 0) state = undefined;
    } else {
      const r = await readLinesFrom(file, offset);
      lines = r.lines;
      nextOffset = r.nextOffset;
      if (r.restarted) state = undefined;
    }
    const out = parseCodexLines(lines, fallbackIdOf(file), state);
    return { events: out.events, nextOffset, state: out.state };
  },
};
