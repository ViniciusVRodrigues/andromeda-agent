import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LocalActiveTask } from '../../src/types.js';
import { branchOverride, sameRef, taskExpiry, type ExpiryInput } from '../../src/task/expiry.js';
import { compileServerPatterns, DEFAULT_PATTERNS } from '../../src/task/patterns.js';

const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 30, 12, 0, 0); // 30/10 12:00 UTC
const task = (o: Partial<LocalActiveTask> = {}): LocalActiveTask => ({
  taskRef: 'AB#4790',
  since: T0,
  repo: 'github.com/o/ui',
  branch: 'feature/4790-x',
  cwd: '/w',
  day: '2026-10-30',
  ...o,
});
const input = (o: Partial<ExpiryInput> = {}): ExpiryInput => ({ nowMs: T0 + H, timezone: 'UTC', currentBranch: 'feature/4790-x', ...o });

test('expiração: segue valendo no mesmo dia, branch e repo', () => {
  assert.equal(taskExpiry(task(), input({ bucketRepos: ['github.com/o/ui', null] })), null);
});

test('expiração: DAY_ENDED na virada do dia local (e respeita o fuso)', () => {
  assert.deepEqual(taskExpiry(task(), input({ nowMs: Date.UTC(2026, 9, 31, 0, 0, 1) })), { reason: 'DAY_ENDED' });
  // 31/10 02:00 UTC ainda é 30/10 em UTC-3
  assert.equal(taskExpiry(task(), input({ nowMs: Date.UTC(2026, 9, 31, 2, 0, 0), timezone: 'America/Sao_Paulo' })), null);
  assert.equal(taskExpiry(task(), input({ nowMs: Date.UTC(2026, 9, 31, 3, 0, 0), timezone: 'America/Sao_Paulo' }))?.reason, 'DAY_ENDED');
});

test('expiração: BRANCH_CHANGED com newBranch; branch desconhecida não expira', () => {
  assert.deepEqual(taskExpiry(task(), input({ currentBranch: 'feature/4812-custo' })), { reason: 'BRANCH_CHANGED', newBranch: 'feature/4812-custo' });
  assert.equal(taskExpiry(task(), input({ currentBranch: null })), null);
  assert.equal(taskExpiry(task({ branch: null }), input({ currentBranch: 'qualquer' })), null);
});

test('expiração: REPO_CHANGED com newRepo; repo nulo no bucket ou na tarefa não conta', () => {
  assert.deepEqual(taskExpiry(task(), input({ bucketRepos: [null, 'github.com/o/api'] })), { reason: 'REPO_CHANGED', newRepo: 'github.com/o/api' });
  assert.equal(taskExpiry(task(), input({ bucketRepos: [null] })), null);
  assert.equal(taskExpiry(task({ repo: null }), input({ bucketRepos: ['github.com/o/api'] })), null);
});

test('expiração: o dia vence a branch', () => {
  const r = taskExpiry(task(), input({ nowMs: T0 + 24 * H, currentBranch: 'outra' }));
  assert.equal(r?.reason, 'DAY_ENDED');
});

test('expiração: tarefa do 0.4 (sem branch, cwd e day) só expira pelo dia de since', () => {
  const old = { taskRef: 'AB#1', since: T0, repo: null } as LocalActiveTask;
  assert.equal(taskExpiry(old, input({ currentBranch: 'qualquer' })), null);
  assert.equal(taskExpiry(old, input({ nowMs: T0 + 13 * H }))?.reason, 'DAY_ENDED');
});

test('sameRef e branchOverride normalizam AB#123 e 123', () => {
  assert.ok(sameRef('AB#123', '123'));
  assert.ok(sameRef('ab#123', 'AB#123'));
  assert.ok(!sameRef('AB#123', 'AB#124'));
  const p = compileServerPatterns(DEFAULT_PATTERNS);
  assert.equal(branchOverride('feature/AB#9-x', 'AB#4790', p), 'AB#9');
  assert.equal(branchOverride('feature/AB#4790-x', '4790', p), null);
  assert.equal(branchOverride('main', 'AB#1', p), null);
});
