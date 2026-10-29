import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readLinesFrom } from '../../src/parsers/incremental.js';

test('retoma de linha cortada e soma igual a leitura unica', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'inc-'));
  try {
    const f = join(dir, 'a.jsonl');
    const full = '{"a":1}\r\n{"b":2}\n{"c":3}\n';
    const cut = full.indexOf('"c"') + 2;
    writeFileSync(f, full.slice(0, cut));
    const r1 = await readLinesFrom(f, 0);
    assert.deepEqual(r1.lines, ['{"a":1}', '{"b":2}']);
    assert.equal(r1.nextOffset, Buffer.byteLength('{"a":1}\r\n{"b":2}\n'));
    appendFileSync(f, full.slice(cut));
    const r2 = await readLinesFrom(f, r1.nextOffset);
    assert.deepEqual(r2.lines, ['{"c":3}']);
    const whole = await readLinesFrom(f, 0);
    assert.deepEqual([...r1.lines, ...r2.lines], whole.lines);
    const r3 = await readLinesFrom(f, r2.nextOffset);
    assert.deepEqual(r3.lines, []);
    assert.equal(r3.nextOffset, r2.nextOffset);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('arquivo encolhido recomeca do zero; arquivo grande em blocos', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'inc-'));
  try {
    const f = join(dir, 'b.jsonl');
    writeFileSync(f, 'x\ny\n');
    const r = await readLinesFrom(f, 9999);
    assert.deepEqual(r.lines, ['x', 'y']);
    assert.equal(r.restarted, true);
    const many = Array.from({ length: 30000 }, (_, i) => `{"n":${i},"p":"ção"}`);
    writeFileSync(f, many.join('\n') + '\n');
    const big = await readLinesFrom(f, 0);
    assert.equal(big.lines.length, 30000);
    assert.equal(big.lines[29999], many[29999]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
