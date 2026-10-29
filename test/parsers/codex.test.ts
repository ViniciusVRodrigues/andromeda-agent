import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { zstdCompressSync } from 'node:zlib';
import { codexParser, parseCodexLines } from '../../src/parsers/codex.js';
import { parsers } from '../../src/parsers/index.js';

const FIX = resolve(process.cwd(), 'test', 'fixtures', 'codex', '2026', '10', '29');
const TC = join(FIX, 'rollout-2026-10-29T10-00-00-abc.jsonl');
const REC = join(FIX, 'rollout-2026-10-29T12-00-00-rec.jsonl');

test('index exporta os dois parsers', () => {
  assert.deepEqual(
    parsers.map((p) => p.tool),
    ['claude-code', 'codex'],
  );
});

test('discover acha .jsonl e .zst via CODEX_HOME', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cx-'));
  try {
    const d = join(dir, 'sessions', '2026', '10', '29');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'rollout-a.jsonl'), '');
    writeFileSync(join(d, 'rollout-b.jsonl.zst'), '');
    writeFileSync(join(d, 'outro.jsonl'), '');
    const files = await codexParser.discover({ home: '/x', env: { CODEX_HOME: dir } });
    assert.equal(files.length, 2);
    mkdirSync(join(dir, '.codex', 'sessions'), { recursive: true });
    writeFileSync(join(dir, '.codex', 'sessions', 'rollout-c.jsonl'), '');
    assert.equal((await codexParser.discover({ home: dir, env: {} })).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('token_count: diferenca do acumulado, repetido ignorado, regressao = reinicio', async () => {
  const r = await codexParser.parse(TC, 0, undefined);
  assert.equal(r.events.length, 3);
  const [a, b, c] = r.events;
  assert.deepEqual(a!.tokens, { input: 200, output: 50, cacheRead: 800, cacheWrite: 0, thinking: 20 });
  assert.deepEqual(b!.tokens, { input: 300, output: 70, cacheRead: 1200, cacheWrite: 10, thinking: 20 });
  assert.deepEqual(c!.tokens, { input: 200, output: 10, cacheRead: 100, cacheWrite: 0, thinking: 0 });
  assert.equal(a!.eventKey, 'sess-1:1050');
  assert.equal(b!.eventKey, 'sess-1:2620');
  assert.equal(a!.sessionId, 'sess-1');
  assert.equal(a!.model, 'gpt-5-codex');
  assert.equal(a!.cwd, '/work/a/sub');
  assert.equal(a!.branch, 'feature/y');
  assert.equal(a!.branchSource, 'none');
  assert.equal(a!.timestamp, Date.parse('2026-10-29T10:00:03.000Z'));
  assert.ok(!JSON.stringify(r.events).includes('SEGREDO'));
});

test('token_usage_record e a fonte quando existe; token_count ignorado', async () => {
  const r = await codexParser.parse(REC, 0, undefined);
  assert.deepEqual(
    r.events.map((e) => e.eventKey),
    ['resp_1', 'resp_2'],
  );
  assert.deepEqual(r.events[0]!.tokens, { input: 40, output: 5, cacheRead: 10, cacheWrite: 0, thinking: 2 });
  assert.equal(r.events[1]!.tokens.input, 0);
  assert.equal(r.events[1]!.tokens.cacheWrite, 3);
  assert.equal(r.events[0]!.model, 'unknown');
  assert.equal(r.events[0]!.branch, null);
});

for (const [nome, file] of [
  ['token_count', TC],
  ['token_usage_record', REC],
] as const) {
  test(`leitura em duas partes = leitura unica (${nome})`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cx-'));
    try {
      const text = readFileSync(file, 'utf8');
      const whole = await codexParser.parse(file, 0, undefined);
      const part = join(dir, 'rollout-p.jsonl');
      const cut = text.split('\n').slice(0, 4).join('\n').length + 8;
      writeFileSync(part, text.slice(0, cut));
      const p1 = await codexParser.parse(part, 0, undefined);
      writeFileSync(part, text);
      const p2 = await codexParser.parse(part, p1.nextOffset, p1.state);
      const pick = (es: typeof whole.events) => es.map((e) => [e.eventKey, e.tokens]);
      assert.deepEqual(pick([...p1.events, ...p2.events]), pick(whole.events));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('.zst: descomprime inteiro e offset e em bytes descomprimidos', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cx-'));
  try {
    const raw = readFileSync(TC);
    const z = join(dir, 'rollout-z.jsonl.zst');
    writeFileSync(z, zstdCompressSync(raw));
    const plain = join(dir, 'rollout-z.jsonl');
    copyFileSync(TC, plain);
    const a = await codexParser.parse(z, 0, undefined);
    const b = await codexParser.parse(plain, 0, undefined);
    assert.equal(a.nextOffset, raw.length);
    assert.deepEqual(
      a.events.map((e) => e.tokens),
      b.events.map((e) => e.tokens),
    );
    const again = await codexParser.parse(z, a.nextOffset, a.state);
    assert.deepEqual(again.events, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('token_count lido antes do primeiro token_usage_record nao conta duas vezes', async () => {
  const { parseCodexLines } = await import('../../src/parsers/codex.js');
  const u = (i: number, o: number, t: number) => ({ input_tokens: i, cached_input_tokens: 0, output_tokens: o, reasoning_output_tokens: 0, total_tokens: t });
  const meta = JSON.stringify({ timestamp: '2026-10-29T10:00:00Z', type: 'session_meta', payload: { id: 's1', cwd: '/tmp/x' } });
  const tc1 = JSON.stringify({ timestamp: '2026-10-29T10:01:00Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: u(100, 10, 110), last_token_usage: u(100, 10, 110) } } });
  const rec1 = JSON.stringify({ timestamp: '2026-10-29T10:01:01Z', type: 'token_usage_record', payload: { response_id: 'r1', usage: u(100, 10, 110), thread_token_usage: u(100, 10, 110) } });
  const tc2 = JSON.stringify({ timestamp: '2026-10-29T10:02:00Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: u(150, 30, 180), last_token_usage: u(50, 20, 70) } } });
  const rec2 = JSON.stringify({ timestamp: '2026-10-29T10:02:01Z', type: 'token_usage_record', payload: { response_id: 'r2', usage: u(50, 20, 70), thread_token_usage: u(150, 30, 180) } });
  // A primeira leitura parou entre o token_count e o primeiro record.
  const a = parseCodexLines([meta, tc1], 'f', undefined);
  const b = parseCodexLines([rec1, tc2, rec2], 'f', a.state);
  const out = [...a.events, ...b.events].reduce((s, e) => s + e.tokens.output, 0);
  assert.equal(out, 30);
  assert.deepEqual(b.events.map((e) => e.eventKey), ['r2']);
});

const tc = (ts: string, u: Record<string, number>): string =>
  JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: u } } });
const META = JSON.stringify({ timestamp: '2026-10-29T10:00:00.000Z', type: 'session_meta', payload: { id: 'vs-1', cwd: '/w' } });

test('token_count de histórico restaurado (componentes zerados, só total_tokens) não gera evento', () => {
  const zero = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 183977 };
  const real = { input_tokens: 500, cached_input_tokens: 100, output_tokens: 30, reasoning_output_tokens: 5, total_tokens: 530 };
  const r = parseCodexLines([META, tc('2026-10-29T10:00:01.000Z', zero), tc('2026-10-29T10:00:02.000Z', real)], 'fb', undefined);
  assert.equal(r.events.length, 1);
  assert.deepEqual(r.events[0]!.tokens, { input: 400, output: 30, cacheRead: 100, cacheWrite: 0, thinking: 5 });
});

test('token_count em que só o total_tokens muda não gera evento', () => {
  const a = { input_tokens: 500, cached_input_tokens: 100, output_tokens: 30, reasoning_output_tokens: 5, total_tokens: 530 };
  const r1 = parseCodexLines([META, tc('2026-10-29T10:00:01.000Z', a)], 'fb', undefined);
  assert.equal(r1.events.length, 1);
  const r2 = parseCodexLines([tc('2026-10-29T10:00:02.000Z', { ...a, total_tokens: 90000 })], 'fb', r1.state);
  assert.equal(r2.events.length, 0);
  // Zerado no meio não perde a base: o próximo real é diferença do anterior real.
  const zero = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 183977 };
  const more = { ...a, input_tokens: 700, output_tokens: 40, total_tokens: 740 };
  const r3 = parseCodexLines([tc('2026-10-29T10:00:03.000Z', zero), tc('2026-10-29T10:00:04.000Z', more)], 'fb', r2.state);
  assert.equal(r3.events.length, 1);
  assert.deepEqual(r3.events[0]!.tokens, { input: 200, output: 10, cacheRead: 0, cacheWrite: 0, thinking: 0 });
});

test('componente menor que o anterior é recomeço: o delta é o total atual', () => {
  const a = { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 0, total_tokens: 1100 };
  const b = { input_tokens: 50, cached_input_tokens: 0, output_tokens: 200, reasoning_output_tokens: 0, total_tokens: 250 };
  const r = parseCodexLines([META, tc('2026-10-29T10:00:01.000Z', a), tc('2026-10-29T10:00:02.000Z', b)], 'fb', undefined);
  assert.equal(r.events.length, 2);
  assert.deepEqual(r.events[1]!.tokens, { input: 50, output: 200, cacheRead: 0, cacheWrite: 0, thinking: 0 });
});
