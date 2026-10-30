import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Readable } from 'node:stream';
import { runCli } from '../../src/agent/commands.js';
import { readLimited, runHook } from '../../src/ai/hook.js';
import { Store } from '../../src/store/db.js';
import { makeCtx, makeSandbox } from '../agent/helpers.js';

const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);

function last(sb: ReturnType<typeof makeSandbox>): { tool: string; cwd: string; at: string } | null {
  const s = Store.open(sb.state);
  try {
    const v = s.getMeta('last_ai_session');
    return v ? JSON.parse(v) : null;
  } finally {
    s.close();
  }
}

test('hook: grava last_ai_session com a pasta do JSON, sem escrever no out, sempre 0', async () => {
  const sb = makeSandbox();
  try {
    const { ctx, cap } = makeCtx(sb, { stdin: Readable.from([JSON.stringify({ cwd: '/work/x', session_id: 's' })]), now: () => NOW });
    assert.equal(await runCli(['hook', 'claude-code'], ctx), 0);
    assert.equal(cap.text(), '');
    assert.deepEqual(last(sb), { tool: 'claude-code', cwd: '/work/x', at: new Date(NOW).toISOString() });
  } finally {
    sb.cleanup();
  }
});

test('hook: JSON ruim usa o cwd do processo; tool desconhecido não grava; --home troca a pasta de estado', async () => {
  const sb = makeSandbox();
  try {
    const a = makeCtx(sb, { stdin: Readable.from(['não é json']), now: () => NOW });
    assert.equal(await runCli(['hook', 'codex'], a.ctx), 0);
    assert.equal(last(sb)?.cwd, sb.repo);
    assert.equal(last(sb)?.tool, 'codex');

    const other = makeSandbox();
    try {
      const b = makeCtx(sb, { stdin: Readable.from(['{}']), now: () => NOW });
      assert.equal(await runCli(['hook', 'codex', '--home', other.state], b.ctx), 0);
      assert.equal(last(other)?.tool, 'codex');
    } finally {
      other.cleanup();
    }

    const fresh = makeSandbox();
    try {
      const c = makeCtx(fresh, { stdin: Readable.from(['{}']) });
      assert.equal(await runCli(['hook', 'vscode'], c.ctx), 0);
      assert.equal(c.cap.text(), '');
      assert.equal(last(fresh), null);
    } finally {
      fresh.cleanup();
    }
  } finally {
    sb.cleanup();
  }
});

test('hook: erro de store é engolido (retorna 0, sem saída)', async () => {
  const sb = makeSandbox();
  try {
    const out: string[] = [];
    const code = await runHook('claude-code', {
      stdin: Readable.from(['{}']),
      cwd: sb.repo,
      openStore: () => {
        throw new Error('disco cheio');
      },
      now: () => NOW,
    });
    assert.equal(code, 0);
    assert.deepEqual(out, []);
  } finally {
    sb.cleanup();
  }
});

test('hook: stdin parado termina em 2 s (aqui encurtado), terminal não é lido, e o limite é 64 KB', async () => {
  const idle = new PassThrough();
  const t0 = Date.now();
  assert.equal(await readLimited(idle, 50), '');
  assert.ok(Date.now() - t0 < 1500);
  const tty = Object.assign(new PassThrough(), { isTTY: true });
  tty.write('abc');
  assert.equal(await readLimited(tty, 5000), '');
  const big = new PassThrough();
  big.write(Buffer.alloc(200 * 1024, 97));
  const got = await readLimited(big, 5000);
  assert.ok(got.length >= 64 * 1024 && got.length <= 200 * 1024);
});
