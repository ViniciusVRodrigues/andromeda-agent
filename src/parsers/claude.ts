import { join } from 'node:path';
import type { LogParser, ParseResult, ParserEnv, UsageEvent } from '../types.js';
import { num, obj, parseObject, readLinesFrom, str, walkFiles } from './incremental.js';

export function claudeRoot(env: ParserEnv): string {
  const dir = env.env.CLAUDE_CONFIG_DIR;
  return join(dir && dir.length > 0 ? dir : join(env.home, '.claude'), 'projects');
}

function tokensOf(usage: Record<string, unknown>): UsageEvent['tokens'] {
  return {
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    cacheRead: num(usage.cache_read_input_tokens),
    cacheWrite: num(usage.cache_creation_input_tokens),
    thinking: num(obj(usage.output_tokens_details)?.thinking_tokens),
  };
}

/**
 * Converte uma linha do log em eventos, lendo só os campos da lista de permissão.
 * A chamada principal vira um evento. Cada `usage.iterations[]` do tipo
 * `advisor_message` (o modelo conselheiro, ex. Fable) vira outro, com o modelo
 * dele: esses tokens não estão no total de cima da `usage`.
 */
export function parseClaudeLine(line: string): UsageEvent[] {
  if (!line.includes('"usage"')) return [];
  const rec = parseObject(line);
  if (!rec || rec.type !== 'assistant') return [];
  const message = obj(rec.message);
  const usage = obj(message?.usage);
  if (!message || !usage) return [];
  const id = str(message.id);
  const model = str(message.model);
  if (!id || !model || model === '<synthetic>') return [];
  const ts = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN;
  if (!Number.isFinite(ts)) return [];
  const rawBranch = str(rec.gitBranch);
  const branch = rawBranch && rawBranch !== 'HEAD' ? rawBranch : null;
  const base = {
    tool: 'claude-code' as const,
    sessionId: str(rec.sessionId) ?? '',
    timestamp: ts,
    cwd: str(rec.cwd),
    branch,
    branchSource: branch ? ('log' as const) : ('none' as const),
  };
  const out: UsageEvent[] = [{ ...base, eventKey: id, model, tokens: tokensOf(usage) }];
  const iterations = Array.isArray(usage.iterations) ? usage.iterations : [];
  let n = 0;
  for (const it of iterations) {
    const u = obj(it);
    if (!u || u.type !== 'advisor_message') continue;
    const advisorModel = str(u.model);
    if (advisorModel && advisorModel !== '<synthetic>') {
      out.push({ ...base, eventKey: `${id}:advisor:${n}`, model: advisorModel, tokens: tokensOf(u) });
    }
    n++;
  }
  return out;
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
      events.push(...parseClaudeLine(l));
    }
    return { events, nextOffset };
  },
};
