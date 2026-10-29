import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { LogParser, ParseResult, ParserEnv, UsageEvent } from '../types.js';
import { num, obj, parseObject, str, walkFiles } from './incremental.js';

const EXTENSION_ID = 'saoudrizwan.claude-dev';
const EDITORS = ['Code', 'Code - Insiders', 'Cursor', 'VSCodium', 'Windsurf', 'Antigravity'];

/**
 * Pastas base (que contem `tasks/` e `state/`) do Cline classico: globalStorage
 * da extensao em cada editor (VS Code e forks) e `~/.cline/data` (versoes
 * posteriores; `CLINE_DATA_DIR` ou `CLINE_DIR`/data). Cursor, Windsurf e
 * VSCodium seguem a convencao do VS Code (nao verificada no codigo deles).
 */
export function clineRoots(env: ParserEnv, platform: NodeJS.Platform = process.platform): string[] {
  let editorBase: string;
  if (platform === 'win32') {
    const appData = env.env.APPDATA;
    editorBase = appData && appData.length > 0 ? appData : join(env.home, 'AppData', 'Roaming');
  } else if (platform === 'darwin') {
    editorBase = join(env.home, 'Library', 'Application Support');
  } else {
    const xdg = env.env.XDG_CONFIG_HOME;
    editorBase = xdg && xdg.length > 0 ? xdg : join(env.home, '.config');
  }
  const roots = EDITORS.map((e) => join(editorBase, e, 'User', 'globalStorage', EXTENSION_ID));
  const dataDir = env.env.CLINE_DATA_DIR;
  const clineDir = env.env.CLINE_DIR;
  if (dataDir && dataDir.length > 0) roots.push(dataDir);
  else if (clineDir && clineDir.length > 0) roots.push(join(clineDir, 'data'));
  else roots.push(join(env.home, '.cline', 'data'));
  return roots;
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

interface ModelUse {
  ts: number;
  model: string;
}

async function modelUsage(taskDir: string): Promise<ModelUse[]> {
  const meta = obj(await readJson(join(taskDir, 'task_metadata.json')));
  const list = Array.isArray(meta?.model_usage) ? meta.model_usage : [];
  const out: ModelUse[] = [];
  for (const it of list) {
    const o = obj(it);
    const model = str(o?.model_id);
    const ts = typeof o?.ts === 'number' ? o.ts : NaN;
    if (model && Number.isFinite(ts)) out.push({ ts, model });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

function modelAt(uses: ModelUse[], ts: number): string {
  let model = 'unknown';
  for (const u of uses) {
    if (u.ts <= ts) model = u.model;
    else break;
  }
  return model;
}

/** cwd da tarefa: `state/taskHistory.json[].cwdOnTaskInitialization` (ausente em tarefas antigas). */
async function cwdOf(base: string, taskId: string): Promise<string | null> {
  const hist = await readJson(join(base, 'state', 'taskHistory.json'));
  if (!Array.isArray(hist)) return null;
  for (const it of hist) {
    const o = obj(it);
    if (o && o.id === taskId) return str(o.cwdOnTaskInitialization);
  }
  return null;
}

/**
 * `ui_messages.json` e reescrito inteiro: le tudo a cada mudanca. Rewind e
 * checkpoint apagam mensagens antigas do arquivo, mas o consumo ja aconteceu:
 * nada e desfeito, pois o upsert por `<taskId>:<ts>` e idempotente.
 * Le so os campos numericos de `text` (`request` traz o prompt inteiro e e descartado).
 * `tokensIn` do Cline classico NAO inclui cache (ele soma os quatro como total).
 */
export const clineParser: LogParser = {
  tool: 'cline',
  async discover(env) {
    const out: string[] = [];
    for (const root of clineRoots(env)) {
      out.push(...(await walkFiles(join(root, 'tasks'), (n) => n === 'ui_messages.json')));
    }
    return out;
  },
  async parse(file): Promise<ParseResult> {
    const raw = await readJson(file);
    if (!Array.isArray(raw)) return { events: [], nextOffset: 0 };
    const taskDir = dirname(file);
    const taskId = basename(taskDir);
    const base = dirname(dirname(taskDir));
    const uses = await modelUsage(taskDir);
    let cwd: string | null | undefined;
    const events: UsageEvent[] = [];
    for (const m of raw) {
      const msg = obj(m);
      if (!msg || msg.type !== 'say' || msg.say !== 'api_req_started' || msg.partial === true) continue;
      const ts = typeof msg.ts === 'number' && Number.isFinite(msg.ts) ? msg.ts : NaN;
      if (!Number.isFinite(ts) || typeof msg.text !== 'string') continue;
      const info = parseObject(msg.text);
      if (!info || (typeof info.tokensIn !== 'number' && typeof info.tokensOut !== 'number')) continue;
      if (cwd === undefined) cwd = await cwdOf(base, taskId);
      events.push({
        tool: 'cline',
        eventKey: `${taskId}:${ts}`,
        sessionId: taskId,
        timestamp: ts,
        model: modelAt(uses, ts),
        cwd,
        branch: null,
        branchSource: 'none',
        tokens: {
          input: num(info.tokensIn),
          output: num(info.tokensOut),
          cacheRead: num(info.cacheReads),
          cacheWrite: num(info.cacheWrites),
          thinking: 0,
        },
      });
    }
    return { events, nextOffset: 0 };
  },
};
