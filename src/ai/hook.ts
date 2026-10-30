import type { Readable } from 'node:stream';
import type { Store } from '../store/db.js';

export const AI_TOOLS = ['claude-code', 'codex'] as const;
export type AiTool = (typeof AI_TOOLS)[number];

export const MAX_HOOK_STDIN = 64 * 1024;
export const HOOK_STDIN_TIMEOUT_MS = 2000;

export interface HookDeps {
  stdin: Readable;
  cwd: string;
  openStore(): Store;
  now(): number;
  timeoutMs?: number;
}

/** Lê o stdin (até 64 KB, no máximo 2 s). Terminal interativo: não espera nada. */
export function readLimited(input: Readable, timeoutMs = HOOK_STDIN_TIMEOUT_MS): Promise<string> {
  if ((input as { isTTY?: boolean }).isTTY) return Promise.resolve('');
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      input.removeListener('data', onData);
      input.removeListener('end', finish);
      input.removeListener('error', finish);
      input.removeListener('close', finish);
      try {
        input.pause();
      } catch {
        /* nada */
      }
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const onData = (c: Buffer | string): void => {
      const b = typeof c === 'string' ? Buffer.from(c) : c;
      chunks.push(b);
      size += b.length;
      if (size >= MAX_HOOK_STDIN) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    input.on('data', onData);
    input.on('end', finish);
    input.on('error', finish);
    input.on('close', finish);
  });
}

/**
 * Hook de SessionStart das IAs: anota (só local) qual IA abriu sessão, em que pasta e quando.
 * Nunca escreve na saída e nunca falha: devolve sempre 0.
 */
export async function runHook(tool: string, d: HookDeps): Promise<number> {
  try {
    if (!(AI_TOOLS as readonly string[]).includes(tool)) return 0;
    const raw = await readLimited(d.stdin, d.timeoutMs);
    let cwd = d.cwd;
    try {
      const j = JSON.parse(raw) as { cwd?: unknown };
      if (j && typeof j.cwd === 'string' && j.cwd) cwd = j.cwd;
    } catch {
      /* JSON ruim: usa o cwd do processo */
    }
    const store = d.openStore();
    try {
      store.setMeta('last_ai_session', JSON.stringify({ tool, cwd, at: new Date(d.now()).toISOString() }));
    } finally {
      store.close();
    }
  } catch {
    /* o hook nunca atrapalha a IA */
  }
  return 0;
}
