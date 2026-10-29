import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Bucket, UsageEvent } from '../../src/types.js';
import type { GitInfo } from '../../src/task/git.js';
import { compileServerPatterns, DEFAULT_PATTERNS } from '../../src/task/patterns.js';
import { resolveEvent, resolveTask } from '../../src/task/resolve.js';

const tokens = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, thinking: 0 };
const ev = (o: Partial<UsageEvent> = {}): UsageEvent => ({
  tool: 'codex',
  eventKey: 'k',
  sessionId: 's',
  timestamp: 5000,
  model: 'm',
  cwd: '/w',
  branch: null,
  branchSource: 'none',
  tokens,
  ...o,
});
const fakeGit = (o: Partial<GitInfo> = {}): GitInfo => ({
  remoteOf: async () => 'github.com/o/r',
  currentBranch: async () => 'atual',
  reflogSwitches: async () => [{ ts: 1000, to: 'antiga' }, { ts: 9000, to: 'atual' }],
  ...o,
});

test('resolveEvent: branch do log tem prioridade; HEAD vira null', async () => {
  const r = await resolveEvent(ev({ branch: 'x', branchSource: 'log' }), fakeGit());
  assert.equal(r.resolvedBranch, 'x');
  assert.equal(r.branchApprox, false);
  assert.equal(r.repo, 'github.com/o/r');
  const h = await resolveEvent(ev({ branch: 'HEAD', branchSource: 'log' }), fakeGit());
  assert.equal(h.resolvedBranch, null);
});

test('resolveEvent: reflog no instante, depois branch atual aproximada, depois a inicial', async () => {
  assert.deepEqual(
    ((r) => [r.resolvedBranch, r.branchApprox])(await resolveEvent(ev(), fakeGit())),
    ['antiga', false],
  );
  const antes = await resolveEvent(ev({ timestamp: 10 }), fakeGit());
  assert.deepEqual([antes.resolvedBranch, antes.branchApprox], ['atual', true]);
  const ini = await resolveEvent(
    ev({ branch: 'inicial' }),
    fakeGit({ currentBranch: async () => null, reflogSwitches: async () => null }),
  );
  assert.deepEqual([ini.resolvedBranch, ini.branchApprox], ['inicial', true]);
  const sem = await resolveEvent(ev({ cwd: null }), fakeGit());
  assert.deepEqual([sem.repo, sem.resolvedBranch], [null, null]);
});

const bucket = (o: Partial<Bucket> = {}): Bucket => ({
  tool: 'claude-code',
  sessionId: 's',
  model: 'm',
  hourStart: 3_600_000 * 10,
  day: '2026-01-01',
  repo: 'github.com/o/r',
  branch: 'feature/AB#7-x',
  branchApprox: false,
  keyRepo: true,
  tokens,
  interactions: 1,
  ...o,
});
const patterns = compileServerPatterns(DEFAULT_PATTERNS);

test('resolveTask: explícita, branch, nenhuma', () => {
  const b = bucket();
  const since = b.hourStart + 3_599_999;
  const at = { taskRef: 'PROJ-1', since, repo: null };
  assert.deepEqual(resolveTask(b, { activeTask: at, patterns }), { taskRef: 'PROJ-1', attributionMethod: 'explicit' });
  // Da branch o agente não manda taskRef (seria explícito para o servidor): só o método.
  assert.deepEqual(resolveTask(b, { activeTask: { ...at, since: since + 1 }, patterns }), {
    taskRef: null,
    attributionMethod: 'branch',
  });
  assert.equal(resolveTask(b, { activeTask: { ...at, repo: 'github.com/o/r' }, patterns }).attributionMethod, 'explicit');
  assert.equal(resolveTask(b, { activeTask: { ...at, repo: 'github.com/o/outro' }, patterns }).attributionMethod, 'branch');
  assert.deepEqual(resolveTask(bucket({ branch: 'main' }), { activeTask: null, patterns }), {
    taskRef: null,
    attributionMethod: 'none',
  });
});

test('resolveTask: branch fix/123-foo não casa o default e não gera taskRef', () => {
  assert.deepEqual(resolveTask(bucket({ branch: 'fix/123-foo' }), { activeTask: null, patterns }), {
    taskRef: null,
    attributionMethod: 'none',
  });
});

test('resolveTask: padrões desligados nunca dão branch', () => {
  const off = compileServerPatterns({ ...DEFAULT_PATTERNS, enabled: false });
  assert.equal(resolveTask(bucket(), { activeTask: null, patterns: off }).attributionMethod, 'none');
});
