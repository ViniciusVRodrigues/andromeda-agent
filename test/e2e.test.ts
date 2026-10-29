import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from '../src/agent/commands.js';
import { Store } from '../src/store/db.js';
import type { PayloadRow, TokenCounts } from '../src/types.js';
import { claudeLine, codexCount, codexMeta, HOUR, makeCtx, makeSandbox, writeText, writeZst } from './agent/helpers.js';
import { startE2eServer } from './e2e-server.js';

const ALLOWED = ['key', 'tool', 'sessionHash', 'model', 'hour', 'day', 'tokens', 'interactions', 'origin', 'repo', 'branch', 'taskRef', 'attributionMethod'];

function sum(rows: PayloadRow[]): TokenCounts & { interactions: number } {
  const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0, interactions: 0 };
  for (const r of rows) {
    t.input += r.tokens.input;
    t.output += r.tokens.output;
    t.cacheRead += r.tokens.cacheRead;
    t.cacheWrite += r.tokens.cacheWrite;
    t.thinking += r.tokens.thinking;
    t.interactions += r.interactions;
  }
  return t;
}

function snapshot(dir: string): string {
  if (!existsSync(dir)) return 'ausente';
  return readdirSync(dir)
    .sort()
    .map((n) => `${n}:${statSync(join(dir, n)).size}:${statSync(join(dir, n)).mtimeMs}`)
    .join('|');
}

test('ponta a ponta: parear, coletar, enviar só o delta, nada vaza, dry-run e task', async () => {
  const sb = makeSandbox();
  const srv = await startE2eServer();
  let netCalls = 0;
  try {
    // todos os eventos dentro da mesma hora UTC, no passado próximo
    const nowHour = Math.floor(Date.now() / HOUR) * HOUR;
    const base = nowHour - 3 * HOUR + 10 * 60_000;
    const claudeFile = join(sb.home, '.claude', 'projects', 'repo', 'cs1.jsonl');
    const codexA = join(sb.home, '.codex', 'sessions', '2026', '10', '29', 'rollout-2026-10-29T10-00-00-a.jsonl');
    const codexZ = join(sb.home, '.codex', 'sessions', '2026', '10', '29', 'rollout-2026-10-29T11-00-00-z.jsonl.zst');

    writeText(
      claudeFile,
      claudeLine({ id: 'msg_1', ts: base + 1000, cwd: sb.repo, branch: 'feature/AB#123-x', input: 10, output: 5, cacheRead: 100, cacheWrite: 20, thinking: 3 }) +
        claudeLine({ id: 'msg_2', ts: base + 2000, cwd: sb.repo, branch: 'HEAD', input: 7, output: 9 }) +
        claudeLine({ id: 'msg_syn', ts: base + 3000, cwd: sb.repo, model: '<synthetic>', input: 99, output: 99 }) +
        // streaming: o mesmo id de novo, com a saída final maior
        claudeLine({ id: 'msg_1', ts: base + 4000, cwd: sb.repo, branch: 'feature/AB#123-x', input: 10, output: 50, cacheRead: 100, cacheWrite: 20, thinking: 3 }) +
        claudeLine({ id: 'msg_3', ts: base + 5000, cwd: sb.repo, branch: 'feature/AB#123-x', input: 4, output: 6 }),
    );
    writeText(
      codexA,
      codexMeta(base, 'cx1', sb.repo) +
        codexCount(base + 3000, { input: 1000, cached: 800, output: 50, reasoning: 20, total: 1050 }) +
        codexCount(base + 4000, { input: 2500, cached: 2000, cacheWrite: 10, output: 120, reasoning: 40, total: 2620 }),
    );
    writeZst(codexZ, codexMeta(base, 'cx2', sb.repo) + codexCount(base + 3000, { input: 500, cached: 100, output: 30, reasoning: 5, total: 535 }));

    // ---- pareia ----
    const pair = makeCtx(sb);
    assert.equal(await runCli(['pair', srv.url], pair.ctx), 0, pair.cap.text());
    assert.match(pair.cap.text(), /ABCD-1234/);
    assert.match(pair.cap.text(), /pair\?code=ABCD-1234/);
    assert.match(pair.cap.text(), /acme/);
    assert.ok(!pair.cap.text().includes('ACC1'), 'token não pode aparecer na tela');

    // ---- 1ª coleta ----
    const r1 = makeCtx(sb);
    assert.equal(await runCli(['run', '--once'], r1.ctx), 0, r1.cap.text());
    assert.equal(srv.usageCalls.length, 1);
    const sent = [...srv.rows.values()];
    assert.equal(sent.length, 4, JSON.stringify(sent.map((r) => [r.tool, r.branch])));
    assert.deepEqual(sum(sent), { input: 921, output: 215, cacheRead: 2200, cacheWrite: 30, thinking: 48, interactions: 6 });

    for (const r of sent) {
      assert.deepEqual(Object.keys(r).sort(), [...ALLOWED].sort());
      assert.equal(r.repo, 'github.com/acme/repo');
      assert.equal(r.origin, 'real');
    }
    const ab = sent.find((r) => r.branch === 'feature/AB#123-x');
    assert.ok(ab);
    assert.equal(ab.taskRef, 'AB#123');
    assert.equal(ab.attributionMethod, 'branch');
    assert.equal(ab.interactions, 2);
    assert.equal(ab.tokens.output, 56);
    for (const r of sent.filter((x) => x !== ab)) {
      assert.equal(r.taskRef, null);
      assert.equal(r.attributionMethod, 'none');
    }
    assert.equal(sent.filter((r) => r.tool === 'codex').length, 2);

    // ---- 2ª coleta: nada novo ----
    const r2 = makeCtx(sb);
    assert.equal(await runCli(['run', '--once'], r2.ctx), 0, r2.cap.text());
    assert.equal(srv.usageCalls.length, 1, 'a 2ª coleta não reenvia nada');

    // ---- cresce um log: só o delta ----
    appendFileSync(claudeFile, claudeLine({ id: 'msg_4', ts: base + 6000, cwd: sb.repo, branch: 'feature/AB#123-x', input: 1, output: 2 }));
    const r3 = makeCtx(sb);
    assert.equal(await runCli(['run', '--once'], r3.ctx), 0, r3.cap.text());
    assert.equal(srv.usageCalls.length, 2);
    assert.equal(srv.usageCalls[1]!.rows.length, 1, 'só a linha que mudou');
    assert.equal(srv.usageCalls[1]!.rows[0]!.key, ab.key);
    assert.deepEqual(sum([...srv.rows.values()]), { input: 922, output: 217, cacheRead: 2200, cacheWrite: 30, thinking: 48, interactions: 7 });

    // ---- status ----
    const st = makeCtx(sb);
    assert.equal(await runCli(['status'], st.ctx), 0);
    assert.match(st.cap.text(), /Pareado: sim, organização acme/);
    assert.match(st.cap.text(), /Pendentes: 0/);
    assert.match(st.cap.text(), /Estado: ok/);
    assert.ok(!st.cap.text().includes('ACC1') && !st.cap.text().includes('REF1'));

    // ---- dry-run: nada gravado, nada de rede ----
    const before = snapshot(sb.state);
    const dr = makeCtx(sb, {
      fetch: (() => {
        netCalls++;
        throw new Error('rede proibida no dry-run');
      }) as typeof fetch,
    });
    assert.equal(await runCli(['--dry-run'], dr.ctx), 0, dr.cap.text());
    assert.equal(snapshot(sb.state), before, 'dry-run não toca o stateDir');
    const dryRows = JSON.parse(dr.cap.out.join('')) as PayloadRow[];
    assert.equal(dryRows.length, 4);
    assert.deepEqual(dryRows.map((r) => r.key).sort(), [...srv.rows.keys()].sort(), 'mesmo sal: mesmas chaves');
    assert.match(dr.cap.err.join(''), /Lista de permissão: OK/);
    const day = dryRows[0]!.day;
    const drDay = makeCtx(sb);
    assert.equal(await runCli(['run', '--dry-run', '--day', day], drDay.ctx), 0);
    assert.equal((JSON.parse(drDay.cap.out.join('')) as PayloadRow[]).length, 4);
    const drNone = makeCtx(sb);
    assert.equal(await runCli(['--dry-run', '--day', '1999-01-01'], drNone.ctx), 0);
    assert.deepEqual(JSON.parse(drNone.cap.out.join('')), []);
    assert.equal(netCalls, 0);
    assert.equal(srv.usageCalls.length, 2);

    // dry-run sem stateDir: não cria nada
    const fresh = makeSandbox();
    try {
      writeText(join(fresh.home, '.claude', 'projects', 'p', 's.jsonl'), claudeLine({ id: 'm1', ts: base, cwd: fresh.repo, input: 1, output: 1 }));
      const f = makeCtx(fresh);
      assert.equal(await runCli(['--dry-run'], f.ctx), 0, f.cap.text());
      assert.equal(existsSync(fresh.state), false, 'dry-run não cria o stateDir');
    } finally {
      fresh.cleanup();
    }

    // ---- task ----
    const tk = makeCtx(sb);
    assert.equal(await runCli(['task', 'AB#9'], tk.ctx), 0, tk.cap.text());
    assert.match(tk.cap.text(), /AB#9 - Corrigir login/);
    assert.match(tk.cap.text(), /reatribuídas: 2/);
    const body = srv.activeTaskBodies[0] as { taskRef: string; since: string; day: string; repo: string };
    assert.equal(body.taskRef, 'AB#9');
    assert.equal(body.repo, 'github.com/acme/repo');
    assert.match(body.since, /^\d{4}-\d\d-\d\dT/);
    assert.match(body.day, /^\d{4}-\d\d-\d\d$/);
    const lst = makeCtx(sb);
    assert.equal(await runCli(['task', '--list'], lst.ctx), 0);
    assert.match(lst.cap.text(), /AB#9\tTask\tCorrigir login/);

    // evento novo depois da tarefa: atribuição explícita
    appendFileSync(claudeFile, claudeLine({ id: 'msg_5', ts: nowHour + 1000, cwd: sb.repo, branch: 'feature/outra', input: 3, output: 4 }));
    const r4 = makeCtx(sb);
    assert.equal(await runCli(['run', '--once'], r4.ctx), 0, r4.cap.text());
    const last = srv.usageCalls[srv.usageCalls.length - 1]!.rows;
    assert.equal(last.length, 1);
    assert.equal(last[0]!.taskRef, 'AB#9');
    assert.equal(last[0]!.attributionMethod, 'explicit');

    const clr = makeCtx(sb);
    assert.equal(await runCli(['task', '--clear'], clr.ctx), 0);
    const store = Store.open(sb.state);
    try {
      assert.equal(store.getLocalActiveTask(), null);
    } finally {
      store.close();
    }

    // ---- privacidade: nenhum corpo ou URL com caminho local ou credencial ----
    const needles = [basename(sb.root), 'user:tok', 'tok@', 'SEGREDO', 'ACC1'];
    for (const s of srv.seen) {
      const hay = `${s.url}\n${s.body}`;
      for (const n of needles) {
        if (n === 'ACC1') continue; // o token vai só no cabeçalho
        assert.ok(!hay.includes(n), `"${n}" apareceu em ${s.method} ${s.url}`);
      }
      assert.ok(!/[A-Za-z]:\\\\/.test(hay) && !hay.includes('/home/') && !hay.includes('/Users/'), `caminho local em ${s.url}`);
    }
    assert.ok(srv.seen.some((s) => s.url.includes('/usage')));
  } finally {
    await srv.close();
    sb.cleanup();
  }
});

test('CLI como processo: --version, help e doctor rodam', () => {
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const sb = makeSandbox();
  const emptyBin = mkdtempSync(join(tmpdir(), 'andromeda-nobin-'));
  try {
    const env = { ...sb.env, PATH: emptyBin, SystemRoot: process.env.SystemRoot ?? '' };
    const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' });
    const v = run('--version');
    assert.equal(v.status, 0);
    assert.match(v.stdout, /^\d+\.\d+\.\d+/);
    const h = run('help');
    assert.equal(h.status, 0);
    assert.match(h.stdout, /pair <url-do-servidor>/);
    const d = run('doctor');
    assert.equal(d.status, 0, d.stdout + d.stderr);
    assert.match(d.stdout, /\[OK\] Node /);
    assert.match(d.stdout, /\[AVISO\] Não pareado/);
    assert.ok(!/ExperimentalWarning/.test(d.stderr));
    assert.equal(run('nao-existe').status, 2);
    // o dry-run como processo, sem rede e sem criar o estado
    writeText(join(sb.home, '.claude', 'projects', 'p', 's.jsonl'), claudeLine({ id: 'm1', ts: Date.now() - HOUR, cwd: sb.repo, input: 1, output: 1 }));
    const dr = spawnSync(process.execPath, [cli, '--dry-run'], { env, encoding: 'utf8' });
    assert.equal(dr.status, 0, dr.stderr);
    assert.equal((JSON.parse(dr.stdout) as unknown[]).length, 1);
    assert.ok(!/ExperimentalWarning/.test(dr.stderr));
    assert.equal(existsSync(sb.state), false);
  } finally {
    rmSync(emptyBin, { recursive: true, force: true });
    sb.cleanup();
  }
});

// usados só para silenciar importações que variam por plataforma
void execFileSync;
void mkdirSync;
void readFileSync;
