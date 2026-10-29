import { execFile } from 'node:child_process';

const GIT_TIMEOUT_MS = 5000;
const REFLOG_TTL_MS = 60_000;

/** Roda `git -C dir ...` sem shell; qualquer falha devolve null. */
function runGit(dir: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        'git',
        ['-C', dir, ...args],
        { timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout) => {
          if (err) resolve(null);
          else resolve(String(stdout));
        },
      );
    } catch {
      resolve(null);
    }
  });
}

/**
 * Normaliza o remoto para `host/caminho` em minúsculas, sem protocolo, sem
 * credencial, sem `.git`, sem query e sem fragmento. Azure DevOps vira
 * `dev.azure.com/org/projeto/repo`.
 */
export function normalizeRemote(url: string): string | null {
  let s = url.trim();
  // Pasta local (`C:\...`, `D:/...`, `\\servidor\...`) nunca é remoto de host.
  if (!s || s.includes('\\') || /^[A-Za-z]:/.test(s)) return null;

  let host: string;
  let path: string;

  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(s);
  if (scheme) {
    // `file://` e outros esquemas apontam para disco, não para um host.
    if (!/^(https?|ssh|git|git\+ssh|ssh\+git):\/\/$/i.test(scheme[0])) return null;
    s = s.slice(scheme[0].length);
    const slash = s.indexOf('/');
    let authority = slash === -1 ? s : s.slice(0, slash);
    path = slash === -1 ? '' : s.slice(slash);
    // Tudo até o último '@' é credencial (usuário, senha ou token).
    const at = authority.lastIndexOf('@');
    if (at !== -1) authority = authority.slice(at + 1);
    const colon = authority.indexOf(':');
    if (colon !== -1) {
      const rest = authority.slice(colon + 1);
      host = authority.slice(0, colon);
      // `ssh.dev.azure.com:v3/org/...`: o que vem depois do ':' não é porta.
      if (!/^\d*$/.test(rest)) path = '/' + rest + path;
    } else {
      host = authority;
    }
  } else {
    // scp-like: [usuario@]host:caminho. Sem usuário, o host precisa de ponto:
    // `servidor:repo` pode ser só uma pasta com ':' no nome.
    const m = /^(?:([^@/:]*)@)?([^:/]+):(.*)$/.exec(s);
    if (!m) return null;
    if (m[1] === undefined && !m[2]!.includes('.')) return null;
    host = m[2]!;
    path = '/' + m[3]!;
  }
  if (!/^[a-z0-9][a-z0-9.-]*$/i.test(host)) return null;

  path = path.split(/[?#]/)[0]!;
  host = host.toLowerCase();
  let segs = path
    .toLowerCase()
    .split('/')
    .filter((x) => x.length > 0);
  if (segs.length > 0) segs[segs.length - 1] = segs[segs.length - 1]!.replace(/\.git$/, '');
  segs = segs.filter((x) => x.length > 0);
  if (!host || segs.length === 0) return null;

  if (host === 'ssh.dev.azure.com' || host === 'vs-ssh.visualstudio.com') {
    // v3/org/projeto/repo
    if (segs[0] === 'v3') segs = segs.slice(1);
    return ['dev.azure.com', ...segs].join('/');
  }
  if (host === 'dev.azure.com') {
    return ['dev.azure.com', ...segs.filter((x) => x !== '_git')].join('/');
  }
  const vs = /^([^.]+)\.visualstudio\.com$/.exec(host);
  if (vs) {
    return ['dev.azure.com', vs[1]!, ...segs.filter((x) => x !== '_git')].join('/');
  }
  return [host, ...segs].join('/');
}

export async function remoteOf(dir: string): Promise<string | null> {
  const out = await runGit(dir, ['remote', 'get-url', 'origin']);
  return out === null ? null : normalizeRemote(out);
}

/** Branch atual; HEAD destacado devolve null. */
export async function currentBranch(dir: string): Promise<string | null> {
  const out = await runGit(dir, ['symbolic-ref', '--short', '-q', 'HEAD']);
  const b = out?.trim();
  return b ? b : null;
}

export async function gitTopLevel(dir: string): Promise<string | null> {
  const out = await runGit(dir, ['rev-parse', '--show-toplevel']);
  const t = out?.trim();
  return t ? t : null;
}

export interface BranchSwitch {
  /** Instante da troca, ms. */
  ts: number;
  to: string;
}

/** Trocas de branch registradas no reflog do HEAD, da mais antiga para a mais nova. */
export async function reflogSwitches(dir: string): Promise<BranchSwitch[] | null> {
  const out = await runGit(dir, ['reflog', 'show', 'HEAD', '--date=unix', '--format=%gd|%gs']);
  if (out === null) return null;
  const res: BranchSwitch[] = [];
  for (const line of out.split(/\r?\n/)) {
    const bar = line.indexOf('|');
    if (bar === -1) continue;
    const sel = /@\{(\d+)\}/.exec(line.slice(0, bar));
    const subj = /^(?:checkout|switch): moving from (\S+) to (\S+)$/.exec(line.slice(bar + 1).trim());
    if (!sel || !subj) continue;
    res.push({ ts: Number(sel[1]) * 1000, to: subj[2]! });
  }
  // O reflog vem do mais novo para o mais antigo; a ordem estável preserva a de gravação.
  return res.reverse().sort((a, b) => a.ts - b.ts);
}

/** Branch vigente em `tsMs`; null antes da primeira troca ou se estava destacado. */
export function branchAt(switches: BranchSwitch[], tsMs: number): string | null {
  let cur: string | null = null;
  for (const s of switches) {
    if (s.ts <= tsMs) cur = s.to;
    else break;
  }
  if (cur === null || cur === 'HEAD' || /^[0-9a-f]{7,40}$/.test(cur)) return null;
  return cur;
}

/** Superfície de git usada pelo resolvedor; injetável nos testes. */
export interface GitInfo {
  remoteOf(dir: string): Promise<string | null>;
  currentBranch(dir: string): Promise<string | null>;
  reflogSwitches(dir: string): Promise<BranchSwitch[] | null>;
}

/** Implementação real, com cache por pasta (TTL) para não rodar git por evento. */
export function createGit(ttlMs: number = REFLOG_TTL_MS, now: () => number = Date.now): GitInfo {
  function cached<T>(fn: (dir: string) => Promise<T>): (dir: string) => Promise<T> {
    const cache = new Map<string, { at: number; value: Promise<T> }>();
    return (dir) => {
      const hit = cache.get(dir);
      const t = now();
      if (hit && t - hit.at < ttlMs) return hit.value;
      const value = fn(dir);
      cache.set(dir, { at: t, value });
      return value;
    };
  }
  return {
    remoteOf: cached(remoteOf),
    currentBranch: cached(currentBranch),
    reflogSwitches: cached(reflogSwitches),
  };
}
