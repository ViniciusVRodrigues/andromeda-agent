import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { LogParser, ParseResult, ParserEnv, TokenCounts, UsageEvent } from '../types.js';
import { num, obj, parseObject, str, walkFiles } from './incremental.js';

/** `<GEMINI_CLI_HOME ou home>/.gemini/tmp`. */
export function geminiRoot(env: ParserEnv): string {
  const dir = env.env.GEMINI_CLI_HOME;
  return join(dir && dir.length > 0 ? dir : env.home, '.gemini', 'tmp');
}

interface Msg {
  id: string;
  timestamp: string | null;
  type: string;
  model: string | null;
  tokens: Record<string, unknown> | null;
}

function toMsg(r: Record<string, unknown>, prev?: Msg): Msg | null {
  const id = str(r.id) ?? prev?.id ?? null;
  if (!id) return null;
  return {
    id,
    timestamp: str(r.timestamp) ?? prev?.timestamp ?? null,
    type: str(r.type) ?? prev?.type ?? '',
    model: str(r.model) ?? prev?.model ?? null,
    tokens: r.tokens !== undefined ? obj(r.tokens) : (prev?.tokens ?? null),
  };
}

/**
 * Converte os tokens do Gemini para a normalização do agente.
 * API do Gemini: `input` inclui o cache; `output` normalmente EXCLUI `thoughts`
 * e `total = input + output + thoughts + tool`. Regra adaptativa pelo `total`:
 * se `total == input + output + tool` (e não bate a soma com thoughts), o `output`
 * já contém os thoughts e eles não são somados de novo.
 */
export function geminiTokens(t: Record<string, unknown>): TokenCounts {
  const input = num(t.input);
  const output = num(t.output);
  const cached = num(t.cached);
  const thoughts = num(t.thoughts);
  const tool = num(t.tool);
  const total = num(t.total);
  const exclusive = input + output + thoughts + tool === total;
  const inclusive = input + output + tool === total;
  const outputHasThoughts = thoughts > 0 && total > 0 && inclusive && !exclusive;
  return {
    input: Math.max(0, input - cached) + tool,
    output: outputHasThoughts ? output : output + thoughts,
    cacheRead: cached,
    cacheWrite: 0,
    thinking: thoughts,
  };
}

/**
 * Reconstrói as mensagens do arquivo inteiro (JSONL com `$set`/`$patch`/`$rewindTo`
 * ou `.json` legado) e devolve um evento por mensagem `gemini` com tokens.
 * `$rewindTo` tira mensagens do histórico, mas o consumo já aconteceu: os eventos
 * continuam saindo (a chave é idempotente no upsert). Por isso `all` nunca perde
 * uma mensagem; `live` (histórico atual) respeita rewind e `removeIds`.
 */
export function parseGeminiContent(text: string, fallbackId: string, cwd: string | null): UsageEvent[] {
  let sessionId: string | null = null;
  let kind: string | null = null;
  let startTime: string | null = null;
  const all = new Map<string, Msg>();
  const live: string[] = [];

  const put = (r: Record<string, unknown>) => {
    const m = toMsg(r, all.get(str(r.id) ?? ''));
    if (!m) return;
    all.set(m.id, m);
    if (!live.includes(m.id)) live.push(m.id);
  };
  const meta = (r: Record<string, unknown>) => {
    sessionId = str(r.sessionId) ?? sessionId;
    kind = str(r.kind) ?? kind;
    startTime = str(r.startTime) ?? startTime;
  };

  const whole = text.trimStart().startsWith('{') ? parseObject(text.trim()) : null;
  if (whole && Array.isArray(whole.messages)) {
    meta(whole);
    for (const m of whole.messages) {
      const o = obj(m);
      if (o) put(o);
    }
  } else {
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const r = parseObject(line.trim());
      if (!r) continue;
      if ('$set' in r) {
        const s = obj(r.$set);
        if (s) meta(s);
      } else if ('$patch' in r) {
        const p = obj(r.$patch);
        if (!p) continue;
        const id = str(p.id);
        if (id && all.has(id)) put(p);
        if (Array.isArray(p.removeIds)) {
          for (const x of p.removeIds) {
            const i = live.indexOf(x as string);
            if (i >= 0) live.splice(i, 1);
          }
        }
      } else if ('$rewindTo' in r) {
        const i = live.indexOf(r.$rewindTo as string);
        if (i >= 0) live.length = i;
      } else if (r.type === undefined && typeof r.sessionId === 'string') {
        meta(r);
      } else if (typeof r.id === 'string') {
        put(r);
      }
    }
  }
  if (kind === 'subagent') return [];

  const sid = sessionId ?? fallbackId;
  const events: UsageEvent[] = [];
  let lastModel: string | null = null;
  for (const m of all.values()) {
    if (m.model) lastModel = m.model;
    if (m.type !== 'gemini' || !m.tokens) continue;
    const tokens = geminiTokens(m.tokens);
    if (tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite === 0) continue;
    const ts = Date.parse(m.timestamp ?? startTime ?? '');
    if (!Number.isFinite(ts)) continue;
    events.push({
      tool: 'gemini-cli',
      eventKey: `${sid}:${m.id}`,
      sessionId: sid,
      timestamp: ts,
      model: m.model ?? lastModel ?? 'unknown',
      cwd,
      branch: null,
      branchSource: 'none',
      tokens,
    });
  }
  return events;
}

async function projectRoot(file: string): Promise<string | null> {
  // <raiz>/tmp/<slug>/chats/session-*.jsonl -> <raiz>/tmp/<slug>/.project_root
  try {
    const t = (await readFile(join(dirname(dirname(file)), '.project_root'), 'utf8')).trim();
    return t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

/** Só `chats/session-*` direto; subpastas (`chats/<idDoPai>/...`) são subagentes e ficam de fora. */
const SESSION = /^session-.*\.jsonl?$/;

export const geminiParser: LogParser = {
  tool: 'gemini-cli',
  async discover(env) {
    const files = await walkFiles(geminiRoot(env), (n) => SESSION.test(n));
    return files.filter((f) => basename(dirname(f)) === 'chats');
  },
  async parse(file): Promise<ParseResult> {
    // Sempre relê o arquivo inteiro (`$patch`/`$rewindTo` e a reescrita do legado
    // invalidam o que já foi lido); a idempotência por `eventKey` cobre o resto.
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      return { events: [], nextOffset: 0 };
    }
    const fallback = basename(file).replace(/\.jsonl?$/, '');
    return { events: parseGeminiContent(text, fallback, await projectRoot(file)), nextOffset: 0 };
  },
};
