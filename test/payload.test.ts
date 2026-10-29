import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Bucket } from '../src/types.js';
import {
  ALLOWED_ROW_FIELDS,
  ALLOWED_TOKEN_FIELDS,
  assertRowsSafe,
  buildRow,
  guardRows,
  rowKey,
  sessionHash,
} from '../src/payload.js';

const mk = (o: Partial<Bucket> = {}): Bucket => ({
  tool: 'claude-code',
  sessionId: 'sess-1',
  model: 'claude-opus-4 (x)',
  hourStart: Date.UTC(2026, 9, 29, 14),
  day: '2026-10-29',
  repo: 'github.com/o/r',
  branch: 'feature/AB#1-x',
  branchApprox: false,
  tokens: { input: 10, output: 20, cacheRead: 3, cacheWrite: 4, thinking: 5 },
  interactions: 2,
  ...o,
});
const ctx = { salt: 'salt', taskRef: 'AB#1', attributionMethod: 'branch' as const };

test('sessionHash: 32 hex determinístico e dependente do sal', () => {
  const h = sessionHash('s', 'codex', 'id');
  assert.match(h, /^[0-9a-f]{32}$/);
  assert.equal(h, sessionHash('s', 'codex', 'id'));
  assert.notEqual(h, sessionHash('t', 'codex', 'id'));
  assert.notEqual(h, sessionHash('s', 'claude-code', 'id'));
});

test('rowKey: caracteres seguros e limite de 200', () => {
  const k = rowKey('codex', 'a'.repeat(32), 'mod el$ç' + 'x'.repeat(500), 0, null);
  assert.ok(k.length <= 200);
  assert.match(k, /^[A-Za-z0-9:._@/#-]+$/);
  assert.ok(k.endsWith(':1970-01-01T00:00:00Z:-'));
  assert.match(rowKey('codex', 'h', 'm', 0, 'main'), /:[0-9a-f]{6}$/);
});

test('allowlist: a linha montada tem exatamente os campos permitidos', () => {
  const buckets = [mk(), mk({ repo: null, branch: null, tool: 'codex' }), mk({ model: 'a/b:c' })];
  for (const b of buckets) {
    const row = buildRow(b, ctx);
    assert.deepEqual(Object.keys(row).sort(), [...ALLOWED_ROW_FIELDS].sort());
    assert.deepEqual(Object.keys(row.tokens).sort(), [...ALLOWED_TOKEN_FIELDS].sort());
    assert.equal(row.origin, 'real');
    assert.match(row.hour, /^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/);
    assert.deepEqual(guardRows([row]), []);
  }
  assert.equal(buildRow(mk(), ctx).hour, '2026-10-29T14:00:00Z');
});

test('buildRow: não vaza campos extras do bucket e normaliza inteiros', () => {
  const b = { ...mk(), cwd: '/Users/x', prompt: 'segredo' } as Bucket;
  b.tokens = { input: -5, output: 1.9, cacheRead: NaN, cacheWrite: 0, thinking: 0 };
  const row = buildRow(b, ctx);
  assert.equal(JSON.stringify(row).includes('segredo'), false);
  assert.equal(JSON.stringify(row).includes('/Users/x'), false);
  assert.deepEqual(row.tokens, { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, thinking: 0 });
});

test('guardRows: acusa campo extra, caminho, credencial e tipo errado', () => {
  const good = buildRow(mk(), ctx);
  assert.ok(guardRows([{ ...good, cwd: 'x' }]).some((v) => v.includes('cwd')));
  assert.ok(guardRows([{ ...good, prompt: 'x' }]).some((v) => v.includes('prompt')));
  assert.ok(guardRows([{ ...good, tokens: { ...good.tokens, extra: 1 } }]).some((v) => v.includes('tokens.extra')));
  for (const bad of ['C:\\Users\\x\\proj', 'D:/code', '\\\\srv\\share', '/Users/bob/p', '/home/bob', '~/proj']) {
    assert.ok(guardRows([{ ...good, branch: bad }]).some((v) => v.includes('branch')), bad);
  }
  assert.ok(guardRows([{ ...good, repo: 'https://u:t@github.com/o/r' }]).some((v) => v.includes('credencial')));
  assert.ok(guardRows([{ ...good, interactions: 1.5 }]).length > 0);
  assert.ok(guardRows([{ ...good, tokens: { ...good.tokens, input: -1 } }]).length > 0);
  assert.ok(guardRows([{ ...good, key: 5 }]).length > 0);
  assert.deepEqual(guardRows([{ ...good, branch: 'feat/home/page' }]), []);
  assert.throws(() => assertRowsSafe([{ ...good, cwd: 'x' }]), /cwd/);
  assert.doesNotThrow(() => assertRowsSafe([good]));
});
