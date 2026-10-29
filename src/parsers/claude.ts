import { join } from 'node:path';
import type { LogParser, ParseResult, ParserEnv, UsageEvent } from '../types.js';
import { num, obj, parseObject, readLinesFrom, str, walkFiles } from './incremental.js';

export function claudeRoot(env: ParserEnv): string {
  const dir = env.env.CLAUDE_CONFIG_DIR;
  return join(dir && dir.length > 0 ? dir : join(env.home, '.claude'), 'projects');
}

/** Converte uma linha do log em evento, lendo só os campos da lista de permissão. */
export function parseClaudeLine(line: string): UsageEvent | null {
  if (!line.includes('"usage"')) return null;
  const rec = parseObject(line);
  if (!rec || rec.type !== 'assistant') return null;
  const message = obj(rec.message);
  const usage = obj(message?.usage);
  if (!message || !usage) return null;
  const id = str(message.id);
  const model = str(message.model);
  if (!id || !model || model === '<synthetic>') return null;
  const ts = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN;
  if (!Number.isFinite(ts)) return null;
  const rawBranch = str(rec.gitBranch);
  const branch = rawBranch && rawBranch !== 'HEAD' ? rawBranch : null;
  return {
    tool: 'claude-code',
    eventKey: id,
    sessionId: str(rec.sessionId) ?? '',
    timestamp: ts,
    model,
    cwd: str(rec.cwd),
    branch,
    branchSource: branch ? 'log' : 'none',
    tokens: {
      input: num(usage.input_tokens),
      output: num(usage.output_tokens),
      cacheRead: num(usage.cache_read_input_tokens),
      cacheWrite: num(usage.cache_creation_input_tokens),
      thinking: num(obj(usage.output_tokens_details)?.thinking_tokens),
    },
  };
}

/** Dedupe por eventKey; vence o de maior output (empate: o primeiro visto). */
export function dedupeByMaxOutput(events: UsageEvent[]): UsageEvent[] {
  const best = new Map<string, UsageEvent>();
  for (const e of events) {
    const cur = best.get(e.eventKey);
    if (!cur || e.tokens.output > cur.tokens.output) best.set(e.eventKey, e);
  }
  return [...best.values()];
}

export const claudeParser: LogParser = {
  tool: 'claude-code',
  discover: (env) => walkFiles(claudeRoot(env), (n) => n.endsWith('.jsonl')),
  async parse(file, offset): Promise<ParseResult> {
    const { lines, nextOffset } = await readLinesFrom(file, offset);
    const events: UsageEvent[] = [];
    for (const l of lines) {
      const e = parseClaudeLine(l);
      if (e) events.push(e);
    }
    return { events, nextOffset };
  },
};
