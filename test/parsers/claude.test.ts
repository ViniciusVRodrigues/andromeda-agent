import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { claudeParser, dedupeByMaxOutput } from '../../src/parsers/claude.js';
import type { UsageEvent } from '../../src/types.js';

const FIX = resolve(process.cwd(), 'test', 'fixtures', 'claude');

function ev(id: string, output: number, session = 's'): UsageEvent {
  return {
    tool: 'claude-code',
    eventKey: id,
    sessionId: session,
    timestamp: 0,
    model: 'm',
    cwd: null,
    branch: null,
    branchSource: 'none',
    tokens: { input: 0, output, cacheRead: 0, cacheWrite: 0, thinking: 0 },
  };
}

test('discover usa CLAUDE_CONFIG_DIR e inclui subpastas', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cl-'));
  try {
    const root = join(dir, 'projects', 'p', 'sub');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'x.jsonl'), '');
    writeFileSync(join(root, 'x.txt'), '');
    const viaEnv = await claudeParser.discover({ home: '/nao-existe', env: { CLAUDE_CONFIG_DIR: dir } });
    assert.equal(viaEnv.length, 1);
    mkdirSync(join(dir, '.claude', 'projects'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'projects', 'y.jsonl'), '');
    const viaHome = await claudeParser.discover({ home: dir, env: {} });
    assert.equal(viaHome.length, 1);
    assert.deepEqual(await claudeParser.discover({ home: join(dir, 'vazio'), env: {} }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discover acha a fixture, inclusive a subpasta de subagente', async () => {
  const files = await claudeParser.discover({ home: '/x', env: { CLAUDE_CONFIG_DIR: resolve(FIX, '..', 'claude-root') } });
  assert.deepEqual(files, []);
  const direct = await claudeParser.parse(join(FIX, 'proj-a', 'sub', 'agent.jsonl'), 0, undefined);
  assert.equal(direct.events[0]!.branch, 'main');
});

test('parse extrai campos, descarta sintetico, sem id e json invalido', async () => {
  const r = await claudeParser.parse(join(FIX, 'proj-a', 's1.jsonl'), 0, undefined);
  assert.deepEqual(
    r.events.map((e) => [e.eventKey, e.tokens.output]),
    [
      ['msg_1', 5],
      ['msg_2', 9],
      ['msg_1', 50],
    ],
  );
  const [a, b, c] = r.events;
  assert.deepEqual(a!.tokens, { input: 10, output: 5, cacheRead: 100, cacheWrite: 20, thinking: 3 });
  assert.equal(a!.branch, 'feature/x');
  assert.equal(a!.branchSource, 'log');
  assert.equal(a!.cwd, '/work/a');
  assert.equal(a!.sessionId, 's1');
  assert.equal(a!.timestamp, Date.parse('2026-10-29T10:00:01.000Z'));
  assert.equal(b!.branch, null);
  assert.equal(b!.branchSource, 'none');
  assert.equal(c!.branch, null);
  assert.equal(b!.tokens.cacheRead, 0);
  assert.ok(!JSON.stringify(r.events).includes('SEGREDO'));
});

test('parse incremental igual a leitura unica', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cl-'));
  try {
    const f = join(dir, 'a.jsonl');
    copyFileSync(join(FIX, 'proj-a', 's1.jsonl'), f);
    const whole = await claudeParser.parse(f, 0, undefined);
    const part = join(dir, 'p.jsonl');
    const text = readFileSync(f, 'utf8');
    writeFileSync(part, text.slice(0, text.indexOf('msg_2') + 5));
    const p1 = await claudeParser.parse(part, 0, undefined);
    writeFileSync(part, text);
    const p2 = await claudeParser.parse(part, p1.nextOffset, p1.state);
    assert.deepEqual([...p1.events, ...p2.events], whole.events);
    assert.equal(p2.nextOffset, whole.nextOffset);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dedupeByMaxOutput: id repetido, streaming, ultimo nao e o maior, outros arquivos', () => {
  const out = dedupeByMaxOutput([ev('a', 2), ev('a', 8), ev('a', 5), ev('b', 1), ev('b', 1), ev('c', 3, 'outro')]);
  const m = new Map(out.map((e) => [e.eventKey, e.tokens.output]));
  assert.equal(out.length, 3);
  assert.equal(m.get('a'), 8);
  assert.equal(m.get('b'), 1);
  assert.equal(m.get('c'), 3);
});
