import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli, type CliContext } from '../../src/agent/commands.js';
import { hookCommand, isAgentHook, AGENTS_LINE } from '../../src/ai/integrations.js';
import { FileCredentialStore } from '../../src/auth/tokens.js';
import { fakeCreds, fakeRunner, makeCtx, makeSandbox, type Sandbox } from '../agent/helpers.js';

const CLI = '/opt/andromeda/dist/src/cli.js';
const NODE = '/usr/bin/node';
const serviceFs = { mkdir: async () => {}, writeFile: async () => {}, rm: async () => {} };

async function run(sb: Sandbox, args: string[], over: Partial<CliContext> = {}): Promise<{ code: number; text: string; err: string }> {
  await new FileCredentialStore(sb.state, () => {}).save(fakeCreds());
  const { ctx, cap } = makeCtx(sb, { cliPath: CLI, nodePath: NODE, platform: 'linux', uid: 1000, runner: fakeRunner(), serviceFs, ...over });
  return runCli(args, ctx).then((code) => ({ code, text: cap.out.join(''), err: cap.err.join('') }));
}

const claudeDir = (sb: Sandbox): string => join(sb.home, '.claude');
const codexDir = (sb: Sandbox): string => join(sb.home, '.codex');
const readJson = (f: string): any => JSON.parse(readFileSync(f, 'utf8'));
const mcpFile = (sb: Sandbox): string => join(claudeDir(sb), '.claude.json');

test('install: liga Claude Code e Codex, e rodar de novo não duplica nada', async () => {
  const sb = makeSandbox();
  try {
    mkdirSync(claudeDir(sb), { recursive: true });
    mkdirSync(codexDir(sb), { recursive: true });
    const a = await run(sb, ['install']);
    assert.equal(a.code, 0, a.text + a.err);
    assert.match(a.text, /Claude Code: MCP, hook e permissão ligados\./);
    assert.match(a.text, /Codex: MCP, hook e instrução ligados\./);
    const snap = (): string[] =>
      [mcpFile(sb), join(claudeDir(sb), 'settings.json'), join(codexDir(sb), 'config.toml'), join(codexDir(sb), 'hooks.json'), join(codexDir(sb), 'AGENTS.md')].map((f) => readFileSync(f, 'utf8'));
    const first = snap();
    await run(sb, ['install']);
    assert.deepEqual(snap(), first);

    const mcp = readJson(mcpFile(sb));
    assert.deepEqual(mcp.mcpServers.andromeda, {
      type: 'stdio',
      command: NODE,
      args: [CLI, 'mcp'],
      env: { ANDROMEDA_AGENT_HOME: sb.state },
    });
    const st = readJson(join(claudeDir(sb), 'settings.json'));
    assert.deepEqual(st.permissions.allow, ['mcp__andromeda']);
    assert.equal(st.hooks.SessionStart.length, 1);
    assert.equal(st.hooks.SessionStart[0].hooks[0].type, 'command');
    assert.equal(st.hooks.SessionStart[0].hooks[0].command, `${NODE} "${CLI}" hook claude-code --home "${sb.state}"`);

    const toml = first[2]!;
    assert.match(toml, /^# >>> andromeda-agent\n\[mcp_servers\.andromeda\]\ncommand = "\/usr\/bin\/node"\nargs = \["\/opt\/andromeda\/dist\/src\/cli\.js", "mcp"\]\ndefault_tools_approval_mode = "approve"\n/);
    assert.match(toml, /\[mcp_servers\.andromeda\.env\]\nANDROMEDA_AGENT_HOME = /);
    assert.ok(toml.trimEnd().endsWith('# <<< andromeda-agent'));
    assert.match(readJson(join(codexDir(sb), 'hooks.json')).hooks.SessionStart[0].hooks[0].command, /hook codex --home /);
    assert.ok(first[4]!.includes(AGENTS_LINE));

    const status = await run(sb, ['status']);
    assert.match(status.text, /IAs: Claude Code \(MCP, hook\), Codex \(MCP, hook, instrução\)/);
    const doc = await run(sb, ['doctor']);
    assert.match(doc.text, /\[OK\] Claude Code: MCP, hook/);
    assert.match(doc.text, /\[OK\] Codex: MCP, hook, instrução/);
  } finally {
    sb.cleanup();
  }
});

test('install --no-ai não cria nada; IA sem pasta vira "não encontrado"', async () => {
  const sb = makeSandbox();
  try {
    mkdirSync(claudeDir(sb), { recursive: true });
    const before = readdirSync(claudeDir(sb));
    const a = await run(sb, ['install', '--no-ai']);
    assert.equal(a.code, 0);
    assert.doesNotMatch(a.text, /Claude Code|Codex/);
    assert.deepEqual(readdirSync(claudeDir(sb)), before);
    assert.equal(existsSync(mcpFile(sb)), false);

    const b = await run(sb, ['install']);
    assert.match(b.text, /Codex: não encontrado\./);
    assert.equal(existsSync(codexDir(sb)), false, 'não cria a pasta da IA');
    assert.match(b.text, /Claude Code: MCP, hook e permissão ligados\./);

  } finally {
    sb.cleanup();
  }
  const empty = makeSandbox();
  try {
    const st = await run(empty, ['status']);
    assert.match(st.text, /IAs: nenhuma ligada \(andromeda-agent install\)/);
  } finally {
    empty.cleanup();
  }
});

test('install: preserva as outras chaves do usuário e troca a entrada antiga do agente', async () => {
  const sb = makeSandbox();
  try {
    mkdirSync(claudeDir(sb), { recursive: true });
    mkdirSync(codexDir(sb), { recursive: true });
    writeFileSync(
      mcpFile(sb),
      JSON.stringify({ numStartups: 4, mcpServers: { outro: { type: 'stdio', command: 'x' } } }, null, 2),
    );
    const oldHook = `${NODE} "/old/place/andromeda-agent/dist/src/cli.js" hook claude-code`;
    writeFileSync(
      join(claudeDir(sb), 'settings.json'),
      JSON.stringify(
        {
          model: 'opus',
          permissions: { allow: ['Bash(ls)'], deny: ['Bash(rm)'] },
          hooks: {
            SessionStart: [
              { hooks: [{ type: 'command', command: 'echo meu' }] },
              { hooks: [{ type: 'command', command: oldHook }] },
            ],
            Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }] }],
          },
        },
        null,
        2,
      ),
    );
    writeFileSync(join(codexDir(sb), 'config.toml'), 'model = "gpt-5"\n\n[mcp_servers.outro]\ncommand = "y"\n');
    writeFileSync(join(codexDir(sb), 'AGENTS.md'), '# Minhas regras\n\nSeja breve.\n');
    await run(sb, ['install']);
    await run(sb, ['install']);

    const mcp = readJson(mcpFile(sb));
    assert.equal(mcp.numStartups, 4);
    assert.ok(mcp.mcpServers.outro && mcp.mcpServers.andromeda);
    const st = readJson(join(claudeDir(sb), 'settings.json'));
    assert.equal(st.model, 'opus');
    assert.deepEqual(st.permissions.allow, ['Bash(ls)', 'mcp__andromeda']);
    assert.deepEqual(st.permissions.deny, ['Bash(rm)']);
    assert.equal(st.hooks.Stop.length, 1);
    assert.equal(st.hooks.SessionStart.length, 2);
    assert.equal(st.hooks.SessionStart[0].hooks[0].command, 'echo meu');
    assert.ok(!JSON.stringify(st).includes('/old/place'));
    assert.match(readFileSync(join(claudeDir(sb), 'settings.json'), 'utf8'), /^\{\n  "model"/);

    const toml = readFileSync(join(codexDir(sb), 'config.toml'), 'utf8');
    assert.ok(toml.startsWith('model = "gpt-5"\n\n[mcp_servers.outro]\ncommand = "y"\n\n# >>> andromeda-agent'));
    const md = readFileSync(join(codexDir(sb), 'AGENTS.md'), 'utf8');
    assert.ok(md.startsWith('# Minhas regras\n\nSeja breve.\n\n<!-- >>> andromeda-agent -->'));

    const un = await run(sb, ['uninstall']);
    assert.match(un.text, /Claude Code: MCP, hook e permissão removidos\./);
    assert.match(un.text, /Codex: MCP, hook e instrução removidos\./);
    const mcp2 = readJson(mcpFile(sb));
    assert.deepEqual(Object.keys(mcp2.mcpServers), ['outro']);
    const st2 = readJson(join(claudeDir(sb), 'settings.json'));
    assert.deepEqual(st2.permissions.allow, ['Bash(ls)']);
    assert.equal(st2.hooks.SessionStart.length, 1);
    assert.equal(st2.hooks.SessionStart[0].hooks[0].command, 'echo meu');
    assert.equal(readFileSync(join(codexDir(sb), 'config.toml'), 'utf8'), 'model = "gpt-5"\n\n[mcp_servers.outro]\ncommand = "y"\n');
    assert.equal(readFileSync(join(codexDir(sb), 'AGENTS.md'), 'utf8'), '# Minhas regras\n\nSeja breve.\n');
    assert.deepEqual(readJson(join(codexDir(sb), 'hooks.json')), {});
  } finally {
    sb.cleanup();
  }
});

test('install: [mcp_servers.andromeda] do usuário e JSON ilegível ficam intactos, com aviso', async () => {
  const sb = makeSandbox();
  try {
    mkdirSync(claudeDir(sb), { recursive: true });
    mkdirSync(codexDir(sb), { recursive: true });
    const mine = '[mcp_servers.andromeda]\ncommand = "meu"\n';
    writeFileSync(join(codexDir(sb), 'config.toml'), mine);
    writeFileSync(mcpFile(sb), '{ quebrado');
    const r = await run(sb, ['install']);
    assert.equal(r.code, 0);
    assert.equal(readFileSync(join(codexDir(sb), 'config.toml'), 'utf8'), mine);
    assert.equal(readFileSync(mcpFile(sb), 'utf8'), '{ quebrado');
    assert.match(r.err, /aviso: Codex: já existe \[mcp_servers\.andromeda\]/);
    assert.match(r.err, /aviso: Claude Code: .*\.claude\.json ilegível/);
    // o resto segue
    assert.match(r.text, /Claude Code: hook e permissão ligados\./);
    assert.match(r.text, /Codex: hook e instrução ligados\./);

    const un = await run(sb, ['uninstall']);
    assert.equal(readFileSync(join(codexDir(sb), 'config.toml'), 'utf8'), mine, 'bloco do usuário não é do agente');
    assert.equal(readFileSync(mcpFile(sb), 'utf8'), '{ quebrado');
    assert.match(un.err, /ilegível/);
  } finally {
    sb.cleanup();
  }
});

test('uninstall não cria arquivos', async () => {
  const sb = makeSandbox();
  try {
    mkdirSync(claudeDir(sb), { recursive: true });
    mkdirSync(codexDir(sb), { recursive: true });
    const un = await run(sb, ['uninstall']);
    assert.equal(un.code, 0);
    assert.deepEqual(readdirSync(claudeDir(sb)), []);
    assert.deepEqual(readdirSync(codexDir(sb)), []);
    assert.match(un.text, /Claude Code: nada do agente para remover\./);
  } finally {
    sb.cleanup();
  }
});

test('install: sem ANDROMEDA_AGENT_HOME o servidor e o hook não levam env nem --home', async () => {
  const sb = makeSandbox();
  try {
    delete sb.env.ANDROMEDA_AGENT_HOME;
    mkdirSync(claudeDir(sb), { recursive: true });
    mkdirSync(codexDir(sb), { recursive: true });
    await new FileCredentialStore(sb.state, () => {}).save(fakeCreds());
    const { ctx } = makeCtx(sb, { cliPath: CLI, nodePath: NODE, platform: 'linux', uid: 1000, runner: fakeRunner(), serviceFs, env: { ...sb.env, XDG_STATE_HOME: join(sb.root, 'xdg') } });
    assert.equal(await runCli(['install'], ctx), 0);
    assert.equal(readJson(mcpFile(sb)).mcpServers.andromeda.env, undefined);
    assert.equal(readJson(join(claudeDir(sb), 'settings.json')).hooks.SessionStart[0].hooks[0].command, `${NODE} "${CLI}" hook claude-code`);
    assert.doesNotMatch(readFileSync(join(codexDir(sb), 'config.toml'), 'utf8'), /\.env\]/);
  } finally {
    sb.cleanup();
  }
});

test('hookCommand: node sem espaço, com espaço e win32', () => {
  assert.equal(hookCommand({ nodePath: '/usr/bin/node', cliPath: '/a/cli.js', platform: 'linux', tool: 'codex' }), '/usr/bin/node "/a/cli.js" hook codex');
  assert.equal(hookCommand({ nodePath: '/Program Files/node/node', cliPath: '/a b/cli.js', platform: 'linux', tool: 'claude-code' }), 'node "/a b/cli.js" hook claude-code');
  assert.equal(
    hookCommand({ nodePath: 'C:\\nodejs\\node.exe', cliPath: 'C:\\Users\\a\\cli.js', platform: 'win32', tool: 'claude-code' }),
    'C:/nodejs/node.exe "C:/Users/a/cli.js" hook claude-code',
  );
  assert.equal(
    hookCommand({ nodePath: 'C:\\Program Files\\nodejs\\node.exe', cliPath: 'C:\\Users\\a\\cli.js', platform: 'win32', tool: 'codex', agentHome: 'C:\\s\\st' }),
    'node "C:/Users/a/cli.js" hook codex --home "C:/s/st"',
  );
  assert.equal(isAgentHook('node "/x/andromeda-agent/cli.js" hook codex', ''), true);
  assert.equal(isAgentHook('echo hook codex', '/a/cli.js'), false);
});
