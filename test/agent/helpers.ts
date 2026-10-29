import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import type { CliContext } from '../../src/agent/commands.js';
import { FileCredentialStore } from '../../src/auth/tokens.js';
import type { Runner } from '../../src/service/index.js';
import type { DeviceCredentials } from '../../src/types.js';

export const HOUR = 3_600_000;

/** Pasta temporária com tudo que um teste do agente precisa. Nada aponta para a máquina real. */
export interface Sandbox {
  root: string;
  home: string;
  state: string;
  repo: string;
  env: NodeJS.ProcessEnv;
  cleanup(): void;
}

export function makeSandbox(remote = 'https://user:tok@github.com/Acme/Repo.git'): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'andromeda-e2e-'));
  const home = join(root, 'home');
  const state = join(root, 'state');
  const repo = join(root, 'work', 'repo');
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]): void => void execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', remote);
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    CODEX_HOME: join(home, '.codex'),
    ANDROMEDA_AGENT_HOME: state,
    ANDROMEDA_AGENT_CREDENTIAL_STORE: 'file',
    USERNAME: 'tester',
    USER: 'tester',
  };
  return { root, home, state, repo, env, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export interface Captured {
  out: string[];
  err: string[];
  text(): string;
}

export function makeCtx(sb: Sandbox, over: Partial<CliContext> = {}): { ctx: CliContext; cap: Captured } {
  const cap: Captured = { out: [], err: [], text: () => cap.out.join('') + cap.err.join('') };
  const ctx: CliContext = {
    env: sb.env,
    cwd: sb.repo,
    out: (s) => void cap.out.push(s),
    err: (s) => void cap.err.push(s),
    credStore: new FileCredentialStore(sb.state, () => {}),
    timezone: 'UTC',
    sleep: async () => {},
    ...over,
  };
  return { ctx, cap };
}

export function fakeCreds(over: Partial<DeviceCredentials> = {}): DeviceCredentials {
  return {
    serverUrl: 'http://127.0.0.1:9',
    accessToken: 'ACC',
    refreshToken: 'REF',
    accessExpiresAt: Date.now() + 3_600_000,
    deviceId: 'dev-1',
    organizationSlug: 'acme',
    ...over,
  };
}

export function writeText(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

export function writeZst(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, zstdCompressSync(Buffer.from(text)));
}

export interface ClaudeLine {
  id: string;
  ts: number;
  session?: string;
  cwd: string;
  branch?: string;
  model?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  thinking?: number;
}

export function claudeLine(l: ClaudeLine): string {
  return (
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date(l.ts).toISOString(),
      sessionId: l.session ?? 'cs1',
      cwd: l.cwd,
      gitBranch: l.branch ?? '',
      message: {
        id: l.id,
        model: l.model ?? 'claude-opus-4',
        content: [{ type: 'text', text: 'SEGREDO resposta' }],
        usage: {
          input_tokens: l.input ?? 0,
          output_tokens: l.output ?? 0,
          cache_read_input_tokens: l.cacheRead ?? 0,
          cache_creation_input_tokens: l.cacheWrite ?? 0,
          output_tokens_details: { thinking_tokens: l.thinking ?? 0 },
        },
      },
    }) + '\n'
  );
}

export function codexMeta(ts: number, id: string, cwd: string): string {
  return (
    JSON.stringify({ timestamp: new Date(ts).toISOString(), type: 'session_meta', payload: { id, cwd, git: { branch: 'feature/y' }, instructions: 'SEGREDO' } }) +
    '\n' +
    JSON.stringify({ timestamp: new Date(ts + 1).toISOString(), type: 'turn_context', payload: { cwd, model: 'gpt-5-codex' } }) +
    '\n'
  );
}

export function codexCount(
  ts: number,
  u: { input: number; cached: number; output: number; reasoning: number; total: number; cacheWrite?: number },
): string {
  return (
    JSON.stringify({
      timestamp: new Date(ts).toISOString(),
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: u.input,
            cached_input_tokens: u.cached,
            ...(u.cacheWrite ? { cache_write_input_tokens: u.cacheWrite } : {}),
            output_tokens: u.output,
            reasoning_output_tokens: u.reasoning,
            total_tokens: u.total,
          },
        },
      },
    }) + '\n'
  );
}

/** Runner que só anota os comandos; nunca executa nada. */
export function fakeRunner(code = 0, stdout = ''): Runner & { calls: Array<[string, string[]]> } {
  const calls: Array<[string, string[]]> = [];
  return {
    calls,
    async run(cmd, args) {
      calls.push([cmd, args]);
      return { code, stdout, stderr: '' };
    },
  };
}
