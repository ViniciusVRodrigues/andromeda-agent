import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planService, installService, uninstallService, serviceStatus, type Runner, type ServiceFs, type RunResult } from '../../src/service/index.js';

function fakeRunner(results: Record<string, RunResult> = {}) {
  const calls: string[] = [];
  const runner: Runner = {
    async run(cmd, args) {
      const line = [cmd, ...args].join(' ');
      calls.push(line);
      for (const [k, v] of Object.entries(results)) if (line.includes(k)) return v;
      return { code: 0, stdout: '', stderr: '' };
    },
  };
  return { runner, calls };
}
function fakeFs() {
  const written = new Map<string, Buffer>();
  const removed: string[] = [];
  const fs: ServiceFs = {
    async mkdir() {},
    async writeFile(p, d) { written.set(p, d); },
    async rm(p) { removed.push(p); },
  };
  return { fs, written, removed };
}

const win = planService({
  platform: 'win32', nodePath: 'C:\\Program Files\\nodejs\\node.exe', cliPath: 'C:\\Users\\Zé & Cia\\lib\\dist\\src\\cli.js',
  stateDir: 'C:\\Users\\Zé & Cia\\AppData\\Local\\andromeda-agent', home: 'C:\\Users\\Zé & Cia', username: 'Zé & Cia', userDomain: 'PC<1>',
});

test('windows: XML da tarefa', () => {
  const xml = win.files[0]!.content;
  for (const s of ['<LogonTrigger>', '<StateChange>SessionUnlock</StateChange>', '<LogonType>InteractiveToken</LogonType>',
    '<RunLevel>LeastPrivilege</RunLevel>', '<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '<StartWhenAvailable>true</StartWhenAvailable>', '<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>', '<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '<Interval>PT1M</Interval>', '<Count>999</Count>', '<Hidden>true</Hidden>', '<Command>wscript.exe</Command>']) {
    assert.ok(xml.includes(s), s);
  }
  assert.ok(xml.includes('<UserId>PC&lt;1&gt;\\Zé &amp; Cia</UserId>'));
  assert.ok(xml.includes('//B //Nologo &quot;C:\\Users\\Zé &amp; Cia\\AppData\\Local\\andromeda-agent\\launch.vbs&quot;'));
  assert.equal(win.files[0]!.encoding, 'utf16le-bom');
});

test('windows: launch.vbs com aspas escapadas e fallback para node', () => {
  const vbs = win.files[1]!.content;
  assert.ok(vbs.includes('node = "C:\\Program Files\\nodejs\\node.exe"'));
  assert.ok(vbs.includes('FileExists(node)'));
  assert.ok(vbs.includes('node = "node"'));
  assert.ok(vbs.includes('""C:\\Users\\Zé & Cia\\lib\\dist\\src\\cli.js"" run", 0, False'));
});

test('windows: instalação grava UTF-16 LE com BOM e roda schtasks falso', async () => {
  const { runner, calls } = fakeRunner();
  const { fs, written } = fakeFs();
  const r = await installService(win, runner, fs);
  assert.equal(r.ok, true);
  const buf = written.get(win.files[0]!.path)!;
  assert.deepEqual([...buf.subarray(0, 2)], [0xff, 0xfe]);
  assert.ok(buf.subarray(2).toString('utf16le').includes('<Task'));
  assert.equal(calls.length, 2);
  assert.ok(calls[0]!.startsWith('schtasks /create /tn andromeda-agent /xml '));
  assert.ok(calls[0]!.endsWith(' /f'));
  assert.equal(calls[1], 'schtasks /run /tn andromeda-agent');
});

test('windows: desinstalar e status', async () => {
  const { runner, calls } = fakeRunner();
  const { fs, removed } = fakeFs();
  await uninstallService(win, runner, fs);
  assert.deepEqual(calls, ['schtasks /delete /tn andromeda-agent /f']);
  assert.equal(removed.length, 2);
  const s = await serviceStatus(win, fakeRunner({ '/query': { code: 0, stdout: '<Settings><Enabled>false</Enabled></Settings>', stderr: '' } }).runner);
  assert.deepEqual(s, { exists: true, enabled: false, running: null, lastResult: null });
  const n = await serviceStatus(win, fakeRunner({ '/query': { code: 1, stdout: '', stderr: 'x' } }).runner);
  assert.equal(n.exists, false);
});

const mac = planService({ platform: 'darwin', nodePath: '/opt/homebrew/bin/node', cliPath: '/Users/a b/&x/cli.js', stateDir: '/Users/a b/Library/Application Support/andromeda-agent', home: '/Users/a b', username: 'a', uid: 502 });

test('macos: plist, comandos e status', async () => {
  const p = mac.files[0]!;
  assert.equal(p.path, '/Users/a b/Library/LaunchAgents/dev.andromeda.agent.plist');
  for (const s of ['<string>/opt/homebrew/bin/node</string>', '<string>/Users/a b/&amp;x/cli.js</string>', '<string>run</string>',
    '<key>RunAtLoad</key>\n  <true/>', '<key>SuccessfulExit</key>\n    <false/>', '<integer>30</integer>', '<string>Background</string>',
    '/Users/a b/Library/Application Support/andromeda-agent/agent.out.log']) assert.ok(p.content.includes(s), s);
  const { runner, calls } = fakeRunner({ bootout: { code: 3, stdout: '', stderr: '' } });
  const r = await installService(mac, runner, fakeFs().fs);
  assert.equal(r.ok, true);
  assert.deepEqual(calls, ['launchctl bootout gui/502/dev.andromeda.agent', `launchctl bootstrap gui/502 ${p.path}`]);
  const s = await serviceStatus(mac, fakeRunner({ print: { code: 0, stdout: '\tstate = running\n\tlast exit code = 0\n', stderr: '' } }).runner);
  assert.deepEqual(s, { exists: true, enabled: true, running: true, lastResult: '0' });
  assert.deepEqual(mac.statusCommand, ['launchctl', ['print', 'gui/502/dev.andromeda.agent']]);
});

const lin = planService({ platform: 'linux', nodePath: '/usr/bin/node', cliPath: '/home/a b/50%/$x/cli.js', stateDir: '/home/a b/.local/state/andromeda-agent', home: '/home/a b', username: 'ana' });

test('linux: unit e comandos', async () => {
  const u = lin.files[0]!;
  assert.equal(u.path, '/home/a b/.config/systemd/user/andromeda-agent.service');
  assert.ok(u.content.includes('ExecStart="/usr/bin/node" "/home/a b/50%%/$$x/cli.js" run'));
  for (const s of ['Restart=on-failure', 'RestartSec=30', 'WantedBy=default.target']) assert.ok(u.content.includes(s));
  const { runner, calls } = fakeRunner();
  const r = await installService(lin, runner, fakeFs().fs);
  assert.deepEqual(calls, ['systemctl --user daemon-reload', 'systemctl --user enable --now andromeda-agent.service']);
  assert.ok(r.notes[0]!.includes('enable-linger'));
  assert.ok(!calls.some((c) => c.includes('loginctl')));
  const un = fakeRunner();
  await uninstallService(lin, un.runner, fakeFs().fs);
  assert.equal(un.calls[0], 'systemctl --user disable --now andromeda-agent.service');
  const s = await serviceStatus(lin, fakeRunner({ 'is-active': { code: 0, stdout: 'active\n', stderr: '' } }).runner);
  assert.equal(s.running, true);
});

test('linux: sem systemd devolve instrução, sem erro fatal', async () => {
  const { runner } = fakeRunner({ systemctl: { code: 1, stdout: '', stderr: 'Failed to connect to bus' } });
  const r = await installService(lin, runner, fakeFs().fs);
  assert.equal(r.ok, false);
  assert.ok(r.manual!.includes('andromeda-agent run'));
  assert.ok(r.manual!.includes('autostart'));
  const throwing: Runner = { async run() { throw new Error('ENOENT'); } };
  assert.ok((await installService(lin, throwing, fakeFs().fs)).manual);
});
