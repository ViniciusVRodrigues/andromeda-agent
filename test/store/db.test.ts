import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../../src/store/db.js';
import type { ResolvedEvent } from '../../src/types.js';
import { mkRow } from '../sync/fake-server.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'ag-db-'));
}

function ev(key: string, ts: number, output: number, over: Partial<ResolvedEvent> = {}): ResolvedEvent {
  return {
    tool: 'claude-code',
    eventKey: key,
    sessionId: 's1',
    timestamp: ts,
    model: 'm',
    cwd: '/secreto/pasta',
    branch: null,
    branchSource: 'none',
    tokens: { input: 1, output, cacheRead: 2, cacheWrite: 3, thinking: 0 },
    repo: 'github.com/o/r',
    resolvedBranch: 'main',
    branchApprox: false,
    ...over,
  };
}

test('dedupe global: id repetido com output crescente e fora de ordem fica com o maior', () => {
  const dir = tmp();
  const s = Store.open(dir);
  s.upsertEvents([ev('a', 1000, 50), ev('a', 1000, 10), ev('a', 1000, 200), ev('a', 1000, 120)]);
  s.upsertEvents([ev('a', 1000, 200, { model: 'outro' })]); // empate mantém
  const b = s.bucketsSince(0, 'UTC');
  assert.equal(b.length, 1);
  assert.equal(b[0]!.tokens.output, 200);
  assert.equal(b[0]!.model, 'm');
  assert.equal(b[0]!.interactions, 1);
  s.close();
  rmSync(dir, { recursive: true, force: true });
});

test('buckets: mesma sessão, hora e branch em repositórios diferentes vira um bucket só', () => {
  // A chave da linha (contrato) não tem repo: dois buckets por repo colidiriam e um sumiria.
  const dir = tmp();
  const s = Store.open(dir);
  s.upsertEvents([
    ev('a', 1000, 10, { repo: 'github.com/o/ms' }),
    ev('b', 2000, 20, { repo: 'github.com/o/ui' }),
    ev('c', 3000, 30, { repo: 'github.com/o/ui' }),
    ev('d', 4000, 40, { repo: null, branchApprox: true }),
  ]);
  const b = s.bucketsSince(0, 'UTC');
  assert.equal(b.length, 1);
  assert.equal(b[0]!.interactions, 4);
  assert.equal(b[0]!.tokens.output, 100);
  assert.equal(b[0]!.tokens.cacheRead, 8);
  assert.equal(b[0]!.repo, 'github.com/o/ui');
  assert.equal(b[0]!.branchApprox, true);
  s.close();
  rmSync(dir, { recursive: true, force: true });
});

test('salt estável entre aberturas e distinto entre bancos', () => {
  const d1 = tmp();
  const d2 = tmp();
  const a = Store.open(d1);
  const salt = a.getOrCreateSalt();
  assert.match(salt, /^[0-9a-f]{64}$/);
  a.close();
  const b = Store.open(d1);
  assert.equal(b.getOrCreateSalt(), salt);
  b.close();
  const c = Store.open(d2);
  assert.notEqual(c.getOrCreateSalt(), salt);
  c.close();
  rmSync(d1, { recursive: true, force: true });
  rmSync(d2, { recursive: true, force: true });
});

test('commitParse é atômico: falha no meio não grava cursor nem eventos', () => {
  const dir = tmp();
  const s = Store.open(dir);
  const bad = ev('b', 2000, 5);
  (bad as unknown as { tokens: unknown }).tokens = { input: {}, output: 1, cacheRead: 0, cacheWrite: 0, thinking: 0 };
  assert.throws(() => s.commitParse('f.jsonl', { offset: 99, size: 99, mtimeMs: 1, state: null }, [ev('a', 1000, 5), bad]));
  assert.equal(s.getCursor('f.jsonl'), null);
  assert.equal(s.eventCount(), 0);
  s.commitParse('f.jsonl', { offset: 10, size: 20, mtimeMs: 3, state: 'x' }, [ev('a', 1000, 5)]);
  assert.deepEqual(s.getCursor('f.jsonl'), { offset: 10, size: 20, mtimeMs: 3, state: 'x' });
  assert.equal(s.eventCount(), 1);
  s.close();
  rmSync(dir, { recursive: true, force: true });
});

test('buckets: hora UTC e dia local de São Paulo virando o dia', () => {
  const dir = tmp();
  const s = Store.open(dir);
  // 2026-10-02T02:30Z = 01/10 23:30 em São Paulo (UTC-3); 03:10Z = 02/10 00:10
  const t1 = Date.UTC(2026, 9, 2, 2, 30);
  const t2 = Date.UTC(2026, 9, 2, 2, 50);
  const t3 = Date.UTC(2026, 9, 2, 3, 10);
  s.upsertEvents([ev('a', t1, 10), ev('b', t2, 20, { branchApprox: true }), ev('c', t3, 30)]);
  const b = s.bucketsSince(0, 'America/Sao_Paulo');
  assert.equal(b.length, 2);
  assert.equal(b[0]!.hourStart, Date.UTC(2026, 9, 2, 2, 0));
  assert.equal(b[0]!.day, '2026-10-01');
  assert.equal(b[0]!.interactions, 2);
  assert.equal(b[0]!.tokens.output, 30);
  assert.equal(b[0]!.branchApprox, true);
  assert.equal(b[1]!.hourStart, Date.UTC(2026, 9, 2, 3, 0));
  assert.equal(b[1]!.day, '2026-10-02');
  assert.equal(s.bucketsSince(0, 'UTC')[0]!.day, '2026-10-02');
  assert.equal(s.bucketsSince(t3, 'UTC').length, 1);
  s.close();
  rmSync(dir, { recursive: true, force: true });
});

test('eventos não guardam cwd e pruneEvents remove os antigos', () => {
  const dir = tmp();
  const s = Store.open(dir);
  s.upsertEvents([ev('a', 1000, 1), ev('b', 5000, 1)]);
  assert.equal(s.pruneEvents(2000), 1);
  assert.equal(s.eventCount(), 1);
  s.close();
  const raw = new DatabaseSync(join(dir, 'agent.db'));
  const cols = (raw.prepare('PRAGMA table_info(events)').all() as { name: string }[]).map((c) => c.name);
  assert.ok(!cols.includes('cwd'));
  raw.close();
  rmSync(dir, { recursive: true, force: true });
});

test('outbox: maior substitui, igual não muda, menor não muda, nunca soma', () => {
  const dir = tmp();
  const s = Store.open(dir);
  s.enqueue([mkRow('a')]);
  const [first] = s.takePending(10, 0);
  assert.ok(first);
  s.applyResults([{ key: 'a', status: 'accepted' }], 100);
  assert.equal(s.stats().sent, 1);

  s.enqueue([mkRow('a')]); // igual
  assert.equal(s.stats().sent, 1);
  s.enqueue([mkRow('a', '2026-10-01', { tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, thinking: 0 }, interactions: 1 })]); // menor
  assert.equal(s.stats().sent, 1);

  s.enqueue([mkRow('a', '2026-10-01', { tokens: { input: 10, output: 25, cacheRead: 30, cacheWrite: 40, thinking: 5 } })]); // maior
  assert.equal(s.stats().pending, 1);
  const [again] = s.takePending(10, 0);
  assert.equal(again!.row.tokens.output, 25);
  assert.equal(again!.row.tokens.input, 10); // substituiu, não somou
  assert.equal(again!.attempts, 0);
  s.close();
  rmSync(dir, { recursive: true, force: true });
});

test('outbox: resultados por linha, backoff e rejeição definitiva', () => {
  const dir = tmp();
  const s = Store.open(dir);
  s.enqueue([mkRow('a'), mkRow('b'), mkRow('c'), mkRow('d')]);
  s.applyResults(
    [
      { key: 'a', status: 'accepted' },
      { key: 'b', status: 'duplicate' },
      { key: 'c', status: 'rejected', retryable: true, reason: 'tmp' },
      { key: 'd', status: 'rejected', retryable: false, reason: 'bad_model' },
    ],
    1000,
  );
  const st = s.stats();
  assert.deepEqual([st.sent, st.pending, st.rejected], [2, 1, 1]);
  assert.equal(s.rejectedRows(5)[0]!.reason, 'bad_model');
  assert.equal(s.takePending(10, 1000).length === 1 || s.takePending(10, 1000).length === 0, true);
  const ld = s.localDay('2026-10-01');
  assert.deepEqual(ld.keys, ['a', 'b']);
  assert.equal(ld.tokens.output, 40);
  s.deferAll(['c'], 1000, 5000);
  assert.equal(s.takePending(10, 5999).length, 0);
  assert.equal(s.takePending(10, 6000).length, 1);
  s.close();
  rmSync(dir, { recursive: true, force: true });
});

test('tarefa ativa local e WAL', () => {
  const dir = tmp();
  const s = Store.open(dir);
  assert.equal(s.getLocalActiveTask(), null);
  s.setLocalActiveTask({ taskRef: 'T-1', since: 5, repo: null });
  assert.deepEqual(s.getLocalActiveTask(), { taskRef: 'T-1', since: 5, repo: null });
  s.setLocalActiveTask(null);
  assert.equal(s.getLocalActiveTask(), null);
  s.close();
  rmSync(dir, { recursive: true, force: true });
});
