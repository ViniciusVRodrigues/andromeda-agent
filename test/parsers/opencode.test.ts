import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { kiloDbPath, kiloParser, opencodeDbPath, opencodeParser } from '../../src/parsers/opencode.js';
import { collect } from '../../src/agent/collect.js';
import { Store } from '../../src/store/db.js';
import { createGit } from '../../src/task/git.js';
import type { LogParser } from '../../src/types.js';

function tmp(): { dir: string; done(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'andromeda-oc-'));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

function mkDb(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec(
    'CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, time_created INTEGER, time_updated INTEGER);' +
      'CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);' +
      'CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);',
  );
  db.prepare('INSERT INTO session VALUES (?,?,?,?)').run('s1', 'C:/fallback', 1, 1);
  db.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run(
    'm1',
    's1',
    1,
    1,
    JSON.stringify({ role: 'assistant', modelID: 'claude-sonnet-4-5', providerID: 'anthropic', path: { cwd: 'C:/work/app' } }),
  );
  return db;
}

function addStep(db: DatabaseSync, id: string, t: number, tokens: unknown, type = 'step-finish'): void {
  db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run(id, 'm1', 's1', t, t, JSON.stringify({ type, tokens }));
}

const T = { input: 300, output: 40, reasoning: 10, cache: { read: 2000, write: 200 } };

test('opencode: step-finish vira evento, reasoning soma na saida, ignora outras partes', async () => {
  const t = tmp();
  try {
    const f = join(t.dir, 'opencode.db');
    const db = mkDb(f);
    addStep(db, 'p1', 1760000000000, T);
    addStep(db, 'p2', 1760000001000, T, 'text');
    addStep(db, 'p3', 1760000002000, { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });
    db.close();
    const r = await opencodeParser.parse(f, 0, undefined);
    assert.equal(r.nextOffset, 0);
    assert.equal(r.events.length, 1);
    const e = r.events[0]!;
    assert.equal(e.tool, 'opencode');
    assert.equal(e.eventKey, 'p1');
    assert.equal(e.sessionId, 's1');
    assert.equal(e.timestamp, 1760000000000);
    assert.equal(e.model, 'claude-sonnet-4-5');
    assert.equal(e.cwd, 'C:/work/app');
    assert.equal(e.branch, null);
    assert.equal(e.branchSource, 'none');
    assert.deepEqual(e.tokens, { input: 300, output: 50, cacheRead: 2000, cacheWrite: 200, thinking: 10 });
  } finally {
    t.done();
  }
});

test('opencode: cursor evita reemitir; linha nova (inclusive no mesmo ms) vem sozinha', async () => {
  const t = tmp();
  try {
    const f = join(t.dir, 'opencode.db');
    const db = mkDb(f);
    addStep(db, 'p1', 1000, T);
    const r1 = await opencodeParser.parse(f, 0, undefined);
    assert.equal(r1.events.length, 1);
    const r2 = await opencodeParser.parse(f, 0, r1.state);
    assert.equal(r2.events.length, 0);
    addStep(db, 'p2', 1000, T);
    addStep(db, 'p3', 2000, T);
    const r3 = await opencodeParser.parse(f, 0, r2.state);
    assert.deepEqual(
      r3.events.map((e) => e.eventKey),
      ['p2', 'p3'],
    );
    const r4 = await opencodeParser.parse(f, 0, r3.state);
    assert.equal(r4.events.length, 0);
    const r5 = await opencodeParser.parse(f, 0, 'lixo');
    assert.equal(r5.events.length, 3);
    db.close();
  } finally {
    t.done();
  }
});

test('opencode: base ausente, corrompida ou sem tabelas = zero eventos e state preservado', async () => {
  const t = tmp();
  try {
    const st = JSON.stringify({ t: 5, ids: ['x'] });
    const r0 = await opencodeParser.parse(join(t.dir, 'nao-existe.db'), 0, st);
    assert.equal(r0.events.length, 0);
    assert.equal(r0.state, st);
    const bad = join(t.dir, 'bad.db');
    writeFileSync(bad, 'isto nao e sqlite, de jeito nenhum '.repeat(50));
    const r1 = await opencodeParser.parse(bad, 0, st);
    assert.equal(r1.events.length, 0);
    assert.equal(r1.state, st);
    const empty = join(t.dir, 'empty.db');
    new DatabaseSync(empty).close();
    const r2 = await opencodeParser.parse(empty, 0, st);
    assert.equal(r2.events.length, 0);
    assert.equal(r2.state, st);
  } finally {
    t.done();
  }
});

test('kilo: KILO_DB aponta a base e o evento sai com tool kilo; caminhos padrao', async () => {
  const t = tmp();
  try {
    const f = join(t.dir, 'custom.db');
    const db = mkDb(f);
    addStep(db, 'k1', 1000, T);
    db.close();
    const env = { home: t.dir, env: { KILO_DB: f } };
    assert.deepEqual(await kiloParser.discover(env), [f]);
    const r = await kiloParser.parse(f, 0, undefined);
    assert.equal(r.events[0]?.tool, 'kilo');
    assert.equal(kiloDbPath({ home: '/h', env: {} }), join('/h', '.local', 'share', 'kilo', 'kilo.db'));
    assert.equal(opencodeDbPath({ home: '/h', env: {} }), join('/h', '.local', 'share', 'opencode', 'opencode.db'));
    assert.equal(opencodeDbPath({ home: '/h', env: { OPENCODE_DATA_DIR: '/d' } }), join('/d', 'opencode.db'));
    assert.equal(opencodeDbPath({ home: '/h', env: { XDG_DATA_HOME: '/x' } }), join('/x', 'opencode', 'opencode.db'));
  } finally {
    t.done();
  }
});

test('opencode: discover acha opencode*.db e ignora -wal/-shm', async () => {
  const t = tmp();
  try {
    const d = join(t.dir, 'opencode');
    mkdirSync(d, { recursive: true });
    for (const n of ['opencode.db', 'opencode-beta.db', 'opencode.db-wal', 'opencode.db-shm', 'outro.db']) writeFileSync(join(d, n), '');
    const files = await opencodeParser.discover({ home: t.dir, env: { XDG_DATA_HOME: t.dir } });
    assert.deepEqual(files, [join(d, 'opencode-beta.db'), join(d, 'opencode.db')]);
  } finally {
    t.done();
  }
});

test('collect: mudanca so no -wal conta como novidade', async () => {
  const t = tmp();
  const store = Store.open(join(t.dir, 'state'));
  try {
    const f = join(t.dir, 'x.db');
    writeFileSync(f, 'a');
    let calls = 0;
    const p: LogParser = {
      tool: 'opencode',
      discover: async () => [f],
      parse: async () => {
        calls++;
        return { events: [], nextOffset: 0 };
      },
    };
    const env = { home: t.dir, env: {} };
    await collect(store, [p], createGit(), env, 'UTC');
    await collect(store, [p], createGit(), env, 'UTC');
    assert.equal(calls, 1);
    writeFileSync(`${f}-wal`, 'w');
    await collect(store, [p], createGit(), env, 'UTC');
    assert.equal(calls, 2);
    await collect(store, [p], createGit(), env, 'UTC');
    assert.equal(calls, 2);
    appendFileSync(`${f}-wal`, 'mais');
    await collect(store, [p], createGit(), env, 'UTC');
    assert.equal(calls, 3);
  } finally {
    store.close();
    t.done();
  }
});
