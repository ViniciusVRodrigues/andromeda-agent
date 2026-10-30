import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Bucket, LocalActiveTask, UsageEvent } from '../../src/types.js';
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
  day: '1970-01-01',
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
  // a branch aponta AB#7, outro item que PROJ-1: a branch ganha
  assert.equal(resolveTask(b, { activeTask: at, patterns }).attributionMethod, 'branch');
  assert.deepEqual(resolveTask(bucket({ branch: 'main' }), { activeTask: at, patterns }), { taskRef: 'PROJ-1', attributionMethod: 'explicit' });
  // Da branch o agente não manda taskRef (seria explícito para o servidor): só o método.
  assert.deepEqual(resolveTask(b, { activeTask: { ...at, since: since + 1 }, patterns }), {
    taskRef: null,
    attributionMethod: 'branch',
  });
  assert.equal(resolveTask(bucket({ branch: 'main' }), { activeTask: { ...at, repo: 'github.com/o/r' }, patterns }).attributionMethod, 'explicit');
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

const at = (o: Partial<LocalActiveTask> = {}): LocalActiveTask => ({
  taskRef: 'AB#7',
  since: 3_600_000 * 10,
  repo: 'github.com/o/r',
  branch: 'feature/AB#7-x',
  cwd: '/w',
  day: '1970-01-01',
  ...o,
});

test('resolveTask: a tarefa marcada vale quando hora, dia, repo e branch batem', () => {
  const b = bucket({ branch: 'feature/AB#7-x' });
  assert.deepEqual(resolveTask(b, { activeTask: at(), patterns }), { taskRef: 'AB#7', attributionMethod: 'explicit' });
  // branch do bucket sem padrão: segue explícita
  assert.equal(resolveTask(bucket({ branch: 'feature/AB#7-x' }), { activeTask: at({ taskRef: '7' }), patterns }).taskRef, '7');
});

test('resolveTask: a branch ganha quando aponta outro item (AB#123 e 123 são o mesmo)', () => {
  const b = bucket({ branch: 'feature/AB#4812-custo' });
  const r = resolveTask(b, { activeTask: at({ branch: null }), patterns });
  assert.deepEqual(r, {
    taskRef: null,
    attributionMethod: 'branch',
    conflict: { taskRef: 'AB#7', branch: 'feature/AB#4812-custo', branchRef: 'AB#4812' },
  });
  // mesmo item escrito sem o prefixo: sem conflito
  const same = resolveTask(bucket({ branch: 'feature/AB#7-x' }), { activeTask: at({ branch: null, taskRef: '7' }), patterns });
  assert.equal(same.conflict, undefined);
  assert.equal(same.attributionMethod, 'explicit');
});

test('resolveTask: outro dia, outra branch ou outro repo não usam a tarefa marcada e não geram conflito', () => {
  const b = bucket({ branch: 'feature/AB#7-x' });
  const dia = resolveTask(b, { activeTask: at({ day: '1969-12-31' }), patterns });
  assert.deepEqual([dia.taskRef, dia.attributionMethod, dia.conflict], [null, 'branch', undefined]);
  const branch = resolveTask(bucket({ branch: 'main' }), { activeTask: at(), patterns });
  assert.deepEqual([branch.taskRef, branch.attributionMethod, branch.conflict], [null, 'none', undefined]);
  const repo = resolveTask(b, { activeTask: at({ repo: 'github.com/o/outro' }), patterns });
  assert.deepEqual([repo.taskRef, repo.attributionMethod, repo.conflict], [null, 'branch', undefined]);
});

test('resolveTask: tarefa gravada pelo 0.4 (sem branch, cwd e day) vale no dia de since', () => {
  const old = { taskRef: 'AB#7', since: 3_600_000 * 10, repo: null } as LocalActiveTask;
  assert.equal(resolveTask(bucket({ branch: 'main' }), { activeTask: old, patterns }).taskRef, 'AB#7');
  assert.equal(resolveTask(bucket({ branch: 'main', day: '1970-01-02' }), { activeTask: old, patterns }).taskRef, null);
});
