import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  branchAt,
  createGit,
  currentBranch,
  gitTopLevel,
  normalizeRemote,
  reflogSwitches,
  remoteOf,
} from '../../src/task/git.js';

test('normalizeRemote: formas suportadas', () => {
  const cases: Array<[string, string]> = [
    ['https://github.com/Owner/Repo.git', 'github.com/owner/repo'],
    ['https://github.com/owner/repo/', 'github.com/owner/repo'],
    ['git@github.com:Owner/Repo.git', 'github.com/owner/repo'],
    ['ssh://git@github.com/owner/repo.git', 'github.com/owner/repo'],
    ['https://user:ghp_SECRET123@github.com/owner/repo.git', 'github.com/owner/repo'],
    ['https://ghp_SECRET123@github.com/owner/repo?x=1#frag', 'github.com/owner/repo'],
    ['ssh://git@ssh.dev.azure.com:v3/Org/Proj/Repo', 'dev.azure.com/org/proj/repo'],
    ['git@ssh.dev.azure.com:v3/org/proj/repo', 'dev.azure.com/org/proj/repo'],
    ['https://org@dev.azure.com/org/proj/_git/repo', 'dev.azure.com/org/proj/repo'],
    ['https://org:PATSECRET@dev.azure.com/org/proj/_git/repo', 'dev.azure.com/org/proj/repo'],
    ['https://org.visualstudio.com/proj/_git/repo', 'dev.azure.com/org/proj/repo'],
    ['https://gitlab.example.com:8443/grupo/sub/repo.git', 'gitlab.example.com/grupo/sub/repo'],
  ];
  for (const [input, expected] of cases) assert.equal(normalizeRemote(input), expected, input);
  assert.equal(normalizeRemote(''), null);
  assert.equal(normalizeRemote('nada'), null);
});

test('normalizeRemote: token nunca sobra no resultado', () => {
  for (const u of [
    'https://user:tok_abc@github.com/o/r.git',
    'https://tok_abc@github.com/o/r',
    'https://x-access-token:tok_abc@dev.azure.com/o/p/_git/r',
  ]) {
    const r = normalizeRemote(u);
    assert.ok(r && !r.includes('tok_abc') && !r.includes('@') && !r.includes(':'), r ?? 'null');
  }
});

test('branchAt: vigente no instante', () => {
  const sw = [
    { ts: 1000, to: 'a' },
    { ts: 2000, to: 'b' },
    { ts: 3000, to: 'abcdef1234567' },
  ];
  assert.equal(branchAt(sw, 999), null);
  assert.equal(branchAt(sw, 1000), 'a');
  assert.equal(branchAt(sw, 2500), 'b');
  assert.equal(branchAt(sw, 9000), null);
});

test('createGit: cache por pasta com TTL', async () => {
  let t = 0;
  const g = createGit(100, () => t);
  const a = g.currentBranch('/nao/existe/xyz');
  assert.strictEqual(g.currentBranch('/nao/existe/xyz'), a);
  t = 200;
  assert.notStrictEqual(g.currentBranch('/nao/existe/xyz'), a);
  assert.equal(await a, null);
});

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('git real: remoto, branch, toplevel e reflog', async (t) => {
  if (!hasGit()) return t.skip('git ausente');
  const dir = mkdtempSync(join(tmpdir(), 'agent-git-'));
  const run = (date: string | null, ...args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], {
      stdio: 'ignore',
      env: { ...process.env, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) },
    });
  try {
    run(null, 'init', '-q');
    run(null, 'config', 'user.name', 'T');
    run(null, 'config', 'user.email', 't@example.com');
    run(null, 'config', 'commit.gpgsign', 'false');
    run(null, 'remote', 'add', 'origin', 'https://user:tok@github.com/Own/Rep.git');
    const t1 = 1_700_000_000;
    writeFileSync(join(dir, 'f.txt'), '1');
    run(null, 'add', '.');
    run(`${t1} +0000`, 'commit', '-q', '-m', 'um');
    run(`${t1 + 100} +0000`, 'checkout', '-q', '-b', 'feature/AB#12-x');
    run(`${t1 + 200} +0000`, 'checkout', '-q', '-b', 'fix/99-y');

    assert.equal(await remoteOf(dir), 'github.com/own/rep');
    assert.equal(await currentBranch(dir), 'fix/99-y');
    assert.ok(await gitTopLevel(dir));
    assert.equal(await remoteOf(join(tmpdir(), 'nao-existe-agent-xyz')), null);

    const sw = await reflogSwitches(dir);
    assert.ok(sw);
    assert.equal(sw.length >= 2, true);
    // O reflog usa o relógio real (GIT_COMMITTER_DATE só vale p/ commit); confere a ordem e o fim.
    assert.deepEqual(
      sw.map((s) => s.to).slice(-2),
      ['feature/AB#12-x', 'fix/99-y'],
    );
    const last = sw[sw.length - 1]!;
    assert.equal(branchAt(sw, last.ts + 1000), 'fix/99-y');
    assert.equal(branchAt(sw, sw[0]!.ts - 1), null);

    // Detached HEAD
    execFileSync('git', ['-C', dir, 'checkout', '-q', '--detach'], { stdio: 'ignore' });
    assert.equal(await currentBranch(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
