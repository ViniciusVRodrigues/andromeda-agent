import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { clineParser, clineRoots } from '../../src/parsers/cline.js';

const req = (ts: number, o: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  ts,
  type: 'say',
  say: 'api_req_started',
  text: JSON.stringify(o),
  ...extra,
});

function setup(): { dir: string; base: string; task: string; ui: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cl-'));
  const base = join(dir, 'gs');
  const task = join(base, 'tasks', 't1');
  mkdirSync(task, { recursive: true });
  return { dir, base, task, ui: join(task, 'ui_messages.json') };
}

test('eventos, partial pulado, modelo por ts, cwd, prompt descartado', async () => {
  const { dir, base, task, ui } = setup();
  try {
    writeFileSync(
      ui,
      JSON.stringify([
        { ts: 1760000000000, type: 'say', say: 'text', text: 'x' },
        req(1760000001000, { request: 'PROMPT SECRETO', tokensIn: 6500, tokensOut: 420, cacheWrites: 300, cacheReads: 5000 }),
        req(1760000020000, { apiProtocol: 'anthropic' }),
        req(1760000030000, { tokensIn: 10, tokensOut: 1 }, { partial: true }),
        req(1760000040000, { tokensIn: 7, tokensOut: 2 }),
      ]),
    );
    writeFileSync(
      join(task, 'task_metadata.json'),
      JSON.stringify({
        model_usage: [
          { ts: 1760000035000, model_id: 'm-b', model_provider_id: 'p', mode: 'act' },
          { ts: 1760000000500, model_id: 'm-a', model_provider_id: 'p', mode: 'act' },
        ],
      }),
    );
    mkdirSync(join(base, 'state'), { recursive: true });
    writeFileSync(join(base, 'state', 'taskHistory.json'), JSON.stringify([{ id: 't1', cwdOnTaskInitialization: '/w/p' }]));
    const r = await clineParser.parse(ui, 0, undefined);
    assert.equal(r.nextOffset, 0);
    assert.equal(r.events.length, 2);
    const a = r.events[0]!;
    const b = r.events[1]!;
    assert.deepEqual(a.tokens, { input: 6500, output: 420, cacheRead: 5000, cacheWrite: 300, thinking: 0 });
    assert.equal(a.eventKey, 't1:1760000001000');
    assert.equal(a.model, 'm-a');
    assert.equal(b.model, 'm-b');
    assert.equal(a.sessionId, 't1');
    assert.equal(a.cwd, '/w/p');
    assert.equal(a.tool, 'cline');
    assert.equal(a.branch, null);
    assert.equal(a.branchSource, 'none');
    assert.ok(!JSON.stringify(r).includes('SECRETO'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sem task_metadata: unknown; sem taskHistory: cwd null', async () => {
  const { dir, ui } = setup();
  try {
    writeFileSync(ui, JSON.stringify([req(5, { tokensIn: 1, tokensOut: 2 })]));
    const r = await clineParser.parse(ui, 0, undefined);
    assert.equal(r.events[0]!.model, 'unknown');
    assert.equal(r.events[0]!.cwd, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('requisicao anterior ao primeiro registro de modelo e unknown', async () => {
  const { dir, task, ui } = setup();
  try {
    writeFileSync(ui, JSON.stringify([req(5, { tokensIn: 1, tokensOut: 2 })]));
    writeFileSync(join(task, 'task_metadata.json'), JSON.stringify({ model_usage: [{ ts: 10, model_id: 'm' }] }));
    assert.equal((await clineParser.parse(ui, 0, undefined)).events[0]!.model, 'unknown');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('JSON invalido nao derruba', async () => {
  const { dir, task, ui } = setup();
  try {
    writeFileSync(ui, '{nao e json');
    assert.deepEqual((await clineParser.parse(ui, 0, undefined)).events, []);
    writeFileSync(ui, JSON.stringify([req(5, { tokensIn: 1 }), { ts: 6, type: 'say', say: 'api_req_started', text: '{x' }, null, 3]));
    writeFileSync(join(task, 'task_metadata.json'), 'lixo');
    assert.equal((await clineParser.parse(ui, 0, undefined)).events.length, 1);
    assert.deepEqual((await clineParser.parse(join(dir, 'nao-existe.json'), 0, undefined)).events, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('raizes por SO', () => {
  const win = clineRoots({ home: 'C:/h', env: { APPDATA: 'C:/h/AppData/Roaming' } }, 'win32');
  assert.ok(win.includes(join('C:/h/AppData/Roaming', 'Cursor', 'User', 'globalStorage', 'saoudrizwan.claude-dev')));
  assert.ok(win.includes(join('C:/h', '.cline', 'data')));
  const mac = clineRoots({ home: '/h', env: {} }, 'darwin');
  assert.ok(mac.includes(join('/h', 'Library', 'Application Support', 'Code - Insiders', 'User', 'globalStorage', 'saoudrizwan.claude-dev')));
  const lin = clineRoots({ home: '/h', env: { CLINE_DIR: '/c' } }, 'linux');
  assert.ok(lin.includes(join('/h', '.config', 'Windsurf', 'User', 'globalStorage', 'saoudrizwan.claude-dev')));
  assert.ok(lin.includes(join('/c', 'data')));
  assert.ok(clineRoots({ home: '/h', env: { CLINE_DATA_DIR: '/d' } }, 'linux').includes('/d'));
});

test('discover com home falsa', async () => {
  const home = mkdtempSync(join(tmpdir(), 'clh-'));
  try {
    const t = join(home, '.cline', 'data', 'tasks', 'x');
    mkdirSync(t, { recursive: true });
    writeFileSync(join(t, 'ui_messages.json'), '[]');
    writeFileSync(join(t, 'outro.json'), '[]');
    const files = await clineParser.discover({ home, env: { APPDATA: join(home, 'nada') } });
    assert.deepEqual(files, [join(t, 'ui_messages.json')]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
