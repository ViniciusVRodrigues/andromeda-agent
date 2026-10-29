import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { geminiParser, geminiRoot, geminiTokens, parseGeminiContent } from '../../src/parsers/gemini.js';

const HOME = resolve(process.cwd(), 'test', 'fixtures', 'gemini');
const CHATS = join(HOME, '.gemini', 'tmp', 'proj-a', 'chats');
const JSONL = join(CHATS, 'session-2026-10-20T10-00-s0000001.jsonl');
const LEGACY = join(CHATS, 'session-2026-10-21T09-00-s0000002.json');

test('geminiRoot respeita GEMINI_CLI_HOME', () => {
  assert.equal(geminiRoot({ home: '/h', env: { GEMINI_CLI_HOME: '/g' } }), join('/g', '.gemini', 'tmp'));
  assert.equal(geminiRoot({ home: '/h', env: {} }), join('/h', '.gemini', 'tmp'));
});

test('discover acha jsonl e json legado e ignora subagentes', async () => {
  const files = await geminiParser.discover({ home: HOME, env: {} });
  assert.equal(files.length, 3);
  assert.ok(files.every((f) => !f.includes('s-parent')));
});

test('jsonl: id repetida colapsa, rewind nao desfaz, sem tokens/usuario nao vira evento', async () => {
  const r = await geminiParser.parse(JSONL, 0, undefined);
  assert.equal(r.nextOffset, 0);
  assert.equal(r.events.length, 2);
  const [a, b] = r.events;
  assert.deepEqual(a!.tokens, { input: 400, output: 450, cacheRead: 800, cacheWrite: 0, thinking: 150 });
  assert.equal(a!.eventKey, 's-0001:m-002');
  assert.equal(a!.model, 'gemini-3-pro');
  assert.equal(a!.cwd, '/work/proj-a');
  assert.equal(a!.branch, null);
  assert.equal(a!.branchSource, 'none');
  assert.equal(a!.tool, 'gemini-cli');
  assert.equal(a!.timestamp, Date.parse('2026-10-20T10:00:05.000Z'));
  // m-003 foi rebobinado ($rewindTo), mas o consumo ja aconteceu; modelo herdado; $patch preserva tokens
  assert.equal(b!.eventKey, 's-0001:m-003');
  assert.equal(b!.model, 'gemini-3-pro');
  assert.deepEqual(b!.tokens, { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, thinking: 0 });
});

test('reler o arquivo produz as mesmas chaves (idempotente)', async () => {
  const a = await geminiParser.parse(JSONL, 0, undefined);
  const b = await geminiParser.parse(JSONL, 123, 'x');
  assert.deepEqual(a.events, b.events);
});

test('ultima versao vence', () => {
  const t = (n: number) =>
    `{"id":"m","timestamp":"2026-10-20T10:00:05Z","type":"gemini","model":"g","tokens":{"input":${n},"output":1,"total":${n + 1}}}`;
  const ev = parseGeminiContent(`{"sessionId":"s"}\n${t(10)}\n${t(20)}\n`, 'f', null);
  assert.equal(ev.length, 1);
  assert.equal(ev[0]!.tokens.input, 20);
});

test('legado .json usa o mesmo modelo', async () => {
  const r = await geminiParser.parse(LEGACY, 0, undefined);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0]!.sessionId, 's-0002');
  assert.equal(r.events[0]!.model, 'gemini-2.5-flash');
  assert.deepEqual(r.events[0]!.tokens, { input: 500, output: 140, cacheRead: 0, cacheWrite: 0, thinking: 40 });
});

test('thoughts: total confirma soma separada, ou output ja os contem', () => {
  assert.deepEqual(geminiTokens({ input: 1200, output: 300, cached: 800, thoughts: 150, tool: 0, total: 1650 }), {
    input: 400,
    output: 450,
    cacheRead: 800,
    cacheWrite: 0,
    thinking: 150,
  });
  assert.deepEqual(geminiTokens({ input: 1000, output: 450, cached: 0, thoughts: 150, tool: 0, total: 1450 }), {
    input: 1000,
    output: 450,
    cacheRead: 0,
    cacheWrite: 0,
    thinking: 150,
  });
  assert.equal(geminiTokens({ input: 10, output: 5, thoughts: 3 }).output, 8);
  assert.equal(geminiTokens({ input: 100, output: 10, cached: 40, tool: 7, total: 117 }).input, 67);
});

test('evento com tudo zero nao e guardado', () => {
  const z = '{"id":"m","timestamp":"2026-10-20T10:00:05Z","type":"gemini","tokens":{"input":0,"output":0,"total":0}}';
  assert.equal(parseGeminiContent(z, 'f', null).length, 0);
});

test('arquivo invalido nao derruba', async () => {
  const bad = join(HOME, '.gemini', 'tmp', 'proj-b', 'chats', 'session-2026-10-22T00-00-bad.jsonl');
  const r = await geminiParser.parse(bad, 0, undefined);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0]!.cwd, null);
  assert.equal(r.events[0]!.sessionId, 'session-2026-10-22T00-00-bad');
  const dir = mkdtempSync(join(tmpdir(), 'gm-'));
  try {
    const f = join(dir, 'session-x.jsonl');
    writeFileSync(f, '\u0000\u0001 lixo\n[1,2]\n"s"\n');
    assert.equal((await geminiParser.parse(f, 0, undefined)).events.length, 0);
    assert.equal((await geminiParser.parse(join(dir, 'ausente.jsonl'), 0, undefined)).events.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
