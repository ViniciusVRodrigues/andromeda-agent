import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Liga o agente às IAs (MCP, hook de SessionStart, permissão, instrução) editando só o que é dele.
 * As funções puras trabalham sobre o conteúdo dos arquivos; o resto é uma camada fina de fs.
 */

export const MCP_NAME = 'andromeda';
export const CLAUDE_PERMISSION = 'mcp__andromeda';
export const TOML_BEGIN = '# >>> andromeda-agent';
export const TOML_END = '# <<< andromeda-agent';
export const MD_BEGIN = '<!-- >>> andromeda-agent -->';
export const MD_END = '<!-- <<< andromeda-agent -->';
export const AGENTS_LINE =
  'Andromeda: quando o usuário citar a tarefa (ex.: AB#123) ou ela mudar, chame set_task do MCP andromeda sem pedir confirmação e diga qual marcou.';

type Json = Record<string, unknown>;
type HookTool = 'claude-code' | 'codex';

export interface AiOptions {
  home: string;
  env: NodeJS.ProcessEnv;
  nodePath: string;
  cliPath: string;
  platform: NodeJS.Platform;
}

export interface AiResult {
  tool: HookTool;
  label: string;
  found: boolean;
  /** O que ficou ligado (instalar/status) ou foi retirado (desinstalar). */
  parts: string[];
  warnings: string[];
}

// ---- comando do hook ----

export function hookCommand(o: { nodePath: string; cliPath: string; platform: NodeJS.Platform; tool: HookTool; agentHome?: string }): string {
  const fix = (p: string): string => (o.platform === 'win32' ? p.replace(/\\/g, '/') : p);
  const node = /\s/.test(o.nodePath) ? 'node' : fix(o.nodePath);
  const home = o.agentHome ? ` --home "${fix(o.agentHome)}"` : '';
  return `${node} "${fix(o.cliPath)}" hook ${o.tool}${home}`;
}

/** Entrada de hook posta por este agente (para trocar sem duplicar e para remover). */
export function isAgentHook(command: unknown, cliPath: string): boolean {
  if (typeof command !== 'string' || !/\bhook (claude-code|codex)\b/.test(command)) return false;
  const norm = (s: string): string => s.replace(/\\/g, '/');
  return (cliPath !== '' && norm(command).includes(norm(cliPath))) || /andromeda/i.test(command);
}

// ---- JSON (puro) ----

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function objAt(parent: Json, key: string): Json {
  const cur = parent[key];
  if (isObj(cur)) return cur;
  const fresh: Json = {};
  parent[key] = fresh;
  return fresh;
}

/** Tira de `hooks.SessionStart` as entradas do agente; grupos que ficam vazios saem. */
function dropAgentHooks(root: Json, cliPath: string): boolean {
  const hooks = root.hooks;
  if (!isObj(hooks) || !Array.isArray(hooks.SessionStart)) return false;
  let changed = false;
  const groups: unknown[] = [];
  for (const g of hooks.SessionStart) {
    if (isObj(g) && Array.isArray(g.hooks)) {
      const kept = g.hooks.filter((h) => !(isObj(h) && isAgentHook(h.command, cliPath)));
      if (kept.length !== g.hooks.length) {
        changed = true;
        if (kept.length > 0) groups.push({ ...g, hooks: kept });
        continue;
      }
    }
    groups.push(g);
  }
  if (changed) {
    if (groups.length > 0) hooks.SessionStart = groups;
    else delete hooks.SessionStart;
    if (Object.keys(hooks).length === 0) delete root.hooks;
  }
  return changed;
}

export function addHookJson(root: Json, command: string, cliPath: string): void {
  dropAgentHooks(root, cliPath);
  const hooks = objAt(root, 'hooks');
  const list = Array.isArray(hooks.SessionStart) ? (hooks.SessionStart as unknown[]) : [];
  list.push({ hooks: [{ type: 'command', command }] });
  hooks.SessionStart = list;
}

export function hasHookJson(root: Json, cliPath: string): boolean {
  const hooks = root.hooks;
  if (!isObj(hooks) || !Array.isArray(hooks.SessionStart)) return false;
  return hooks.SessionStart.some((g) => isObj(g) && Array.isArray(g.hooks) && g.hooks.some((h) => isObj(h) && isAgentHook(h.command, cliPath)));
}

export function claudeMcpEntry(o: AiOptions): Json {
  const entry: Json = { type: 'stdio', command: o.nodePath, args: [o.cliPath, 'mcp'] };
  if (o.env.ANDROMEDA_AGENT_HOME) entry.env = { ANDROMEDA_AGENT_HOME: o.env.ANDROMEDA_AGENT_HOME };
  return entry;
}

export function addClaudeMcp(root: Json, entry: Json): void {
  objAt(root, 'mcpServers')[MCP_NAME] = entry;
}

export function addClaudeSettings(root: Json, command: string, cliPath: string): void {
  const perms = objAt(root, 'permissions');
  const allow = Array.isArray(perms.allow) ? (perms.allow as unknown[]) : [];
  if (!allow.includes(CLAUDE_PERMISSION)) allow.push(CLAUDE_PERMISSION);
  perms.allow = allow;
  addHookJson(root, command, cliPath);
}

export function removeClaudeMcp(root: Json): boolean {
  const s = root.mcpServers;
  if (!isObj(s) || !(MCP_NAME in s)) return false;
  delete s[MCP_NAME];
  if (Object.keys(s).length === 0) delete root.mcpServers;
  return true;
}

export function removeClaudeSettings(root: Json, cliPath: string): boolean {
  let changed = dropAgentHooks(root, cliPath);
  const perms = root.permissions;
  if (isObj(perms) && Array.isArray(perms.allow) && perms.allow.includes(CLAUDE_PERMISSION)) {
    perms.allow = perms.allow.filter((x) => x !== CLAUDE_PERMISSION);
    changed = true;
  }
  return changed;
}

export function removeHookJson(root: Json, cliPath: string): boolean {
  return dropAgentHooks(root, cliPath);
}

// ---- TOML e Markdown (puros) ----

const tomlStr = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export function codexBlock(o: AiOptions): string {
  const lines = [
    TOML_BEGIN,
    `[mcp_servers.${MCP_NAME}]`,
    `command = ${tomlStr(o.nodePath)}`,
    `args = [${tomlStr(o.cliPath)}, "mcp"]`,
    'default_tools_approval_mode = "approve"',
  ];
  if (o.env.ANDROMEDA_AGENT_HOME) {
    lines.push('', `[mcp_servers.${MCP_NAME}.env]`, `ANDROMEDA_AGENT_HOME = ${tomlStr(o.env.ANDROMEDA_AGENT_HOME)}`);
  }
  lines.push(TOML_END);
  return lines.join('\n');
}

/** Troca o bloco marcado (ou o põe no fim). Devolve o texto novo. */
export function putBlock(text: string, begin: string, end: string, block: string): string {
  const s = text.indexOf(begin);
  const e = s >= 0 ? text.indexOf(end, s) : -1;
  if (s >= 0 && e >= 0) return text.slice(0, s) + block + text.slice(e + end.length);
  const base = text.length === 0 ? '' : text.replace(/\s*$/, '') + '\n\n';
  return base + block + '\n';
}

/** Tira o bloco marcado; null se não havia. */
export function dropBlock(text: string, begin: string, end: string): string | null {
  const s = text.indexOf(begin);
  const e = s >= 0 ? text.indexOf(end, s) : -1;
  if (s < 0 || e < 0) return null;
  const before = text.slice(0, s).replace(/\s*$/, '');
  const after = text.slice(e + end.length).replace(/^\s*/, '');
  if (!before) return after;
  return before + '\n' + (after ? '\n' + after : '');
}

export function hasBlock(text: string, begin: string, end: string): boolean {
  const s = text.indexOf(begin);
  return s >= 0 && text.indexOf(end, s) >= 0;
}

/** `[mcp_servers.andromeda]` do usuário, fora do bloco do agente. */
export function userDefinedMcp(toml: string): boolean {
  const rest = dropBlock(toml, TOML_BEGIN, TOML_END) ?? toml;
  return /^\s*\[\s*mcp_servers\s*\.\s*"?andromeda"?\s*(\]|\.)/m.test(rest);
}

export const agentsBlock = (): string => `${MD_BEGIN}\n${AGENTS_LINE}\n${MD_END}`;

// ---- fs ----

type Read = { state: 'missing' } | { state: 'ok'; data: Json } | { state: 'bad' };

function readJson(file: string): Read {
  if (!existsSync(file)) return { state: 'missing' };
  try {
    const t = readFileSync(file, 'utf8');
    if (!t.trim()) return { state: 'ok', data: {} };
    const v: unknown = JSON.parse(t);
    return isObj(v) ? { state: 'ok', data: v } : { state: 'bad' };
  } catch {
    return { state: 'bad' };
  }
}

function readText(file: string): string | null {
  try {
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
  } catch {
    return null;
  }
}

/** Escrita atômica: arquivo temporário ao lado e rename. */
export function writeAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.andromeda-${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

const writeJson = (file: string, data: Json): void => writeAtomic(file, JSON.stringify(data, null, 2) + '\n');

interface Paths {
  claudeDir: string;
  claudeMcp: string;
  claudeSettings: string;
  codexDir: string;
  codexToml: string;
  codexHooks: string;
  codexAgents: string;
}

function pathsOf(o: AiOptions): Paths {
  const claudeDir = o.env.CLAUDE_CONFIG_DIR || join(o.home, '.claude');
  const codexDir = o.env.CODEX_HOME || join(o.home, '.codex');
  return {
    claudeDir,
    claudeMcp: o.env.CLAUDE_CONFIG_DIR ? join(claudeDir, '.claude.json') : join(o.home, '.claude.json'),
    claudeSettings: join(claudeDir, 'settings.json'),
    codexDir,
    codexToml: join(codexDir, 'config.toml'),
    codexHooks: join(codexDir, 'hooks.json'),
    codexAgents: join(codexDir, 'AGENTS.md'),
  };
}

function newResult(tool: HookTool, found: boolean): AiResult {
  return { tool, label: tool === 'claude-code' ? 'Claude Code' : 'Codex', found, parts: [], warnings: [] };
}

function safe(r: AiResult, what: string, fn: () => void): void {
  try {
    fn();
  } catch (e) {
    r.warnings.push(`${r.label}: não consegui gravar ${what} (${e instanceof Error ? e.message : String(e)}).`);
  }
}

// ---- configurar ----

export function configureAi(o: AiOptions): AiResult[] {
  const p = pathsOf(o);
  const home = o.env.ANDROMEDA_AGENT_HOME || undefined;
  const cmdFor = (tool: HookTool): string =>
    hookCommand({ nodePath: o.nodePath, cliPath: o.cliPath, platform: o.platform, tool, ...(home ? { agentHome: home } : {}) });

  const c = newResult('claude-code', existsSync(p.claudeDir));
  if (c.found) {
    const mcp = readJson(p.claudeMcp);
    if (mcp.state === 'bad') c.warnings.push(`Claude Code: ${p.claudeMcp} ilegível, não alterei o MCP.`);
    else
      safe(c, p.claudeMcp, () => {
        const data = mcp.state === 'ok' ? mcp.data : {};
        addClaudeMcp(data, claudeMcpEntry(o));
        writeJson(p.claudeMcp, data);
        c.parts.push('MCP');
      });
    const st = readJson(p.claudeSettings);
    if (st.state === 'bad') c.warnings.push(`Claude Code: ${p.claudeSettings} ilegível, não alterei hook nem permissão.`);
    else
      safe(c, p.claudeSettings, () => {
        const data = st.state === 'ok' ? st.data : {};
        addClaudeSettings(data, cmdFor('claude-code'), o.cliPath);
        writeJson(p.claudeSettings, data);
        c.parts.push('hook', 'permissão');
      });
  }

  const x = newResult('codex', existsSync(p.codexDir));
  if (x.found) {
    const toml = readText(p.codexToml) ?? '';
    if (userDefinedMcp(toml)) x.warnings.push('Codex: já existe [mcp_servers.andromeda] no seu config.toml; não alterei o MCP.');
    else
      safe(x, p.codexToml, () => {
        writeAtomic(p.codexToml, putBlock(toml, TOML_BEGIN, TOML_END, codexBlock(o)));
        x.parts.push('MCP');
      });
    const hk = readJson(p.codexHooks);
    if (hk.state === 'bad') x.warnings.push(`Codex: ${p.codexHooks} ilegível, não alterei o hook.`);
    else
      safe(x, p.codexHooks, () => {
        const data = hk.state === 'ok' ? hk.data : {};
        addHookJson(data, cmdFor('codex'), o.cliPath);
        writeJson(p.codexHooks, data);
        x.parts.push('hook');
      });
    safe(x, p.codexAgents, () => {
      writeAtomic(p.codexAgents, putBlock(readText(p.codexAgents) ?? '', MD_BEGIN, MD_END, agentsBlock()));
      x.parts.push('instrução');
    });
  }
  return [c, x];
}

// ---- remover ----

export function removeAi(o: AiOptions): AiResult[] {
  const p = pathsOf(o);
  const c = newResult('claude-code', existsSync(p.claudeDir));
  const x = newResult('codex', existsSync(p.codexDir));

  const editJson = (r: AiResult, file: string, part: string[], fn: (d: Json) => boolean): void => {
    const rd = readJson(file);
    if (rd.state === 'missing') return;
    if (rd.state === 'bad') return void r.warnings.push(`${r.label}: ${file} ilegível, não alterei.`);
    safe(r, file, () => {
      if (fn(rd.data)) {
        writeJson(file, rd.data);
        r.parts.push(...part);
      }
    });
  };
  editJson(c, p.claudeMcp, ['MCP'], removeClaudeMcp);
  editJson(c, p.claudeSettings, ['hook', 'permissão'], (d) => removeClaudeSettings(d, o.cliPath));

  const toml = readText(p.codexToml);
  if (toml !== null) {
    const rest = dropBlock(toml, TOML_BEGIN, TOML_END);
    if (rest !== null)
      safe(x, p.codexToml, () => {
        writeAtomic(p.codexToml, rest);
        x.parts.push('MCP');
      });
  }
  editJson(x, p.codexHooks, ['hook'], (d) => removeHookJson(d, o.cliPath));
  const md = readText(p.codexAgents);
  if (md !== null) {
    const rest = dropBlock(md, MD_BEGIN, MD_END);
    if (rest !== null)
      safe(x, p.codexAgents, () => {
        if (rest.trim()) writeAtomic(p.codexAgents, rest);
        else rmSync(p.codexAgents, { force: true });
        x.parts.push('instrução');
      });
  }
  return [c, x];
}

// ---- consultar ----

export function inspectAi(o: AiOptions): AiResult[] {
  const p = pathsOf(o);
  const c = newResult('claude-code', existsSync(p.claudeDir));
  const x = newResult('codex', existsSync(p.codexDir));
  if (c.found) {
    const mcp = readJson(p.claudeMcp);
    if (mcp.state === 'ok' && isObj(mcp.data.mcpServers) && MCP_NAME in mcp.data.mcpServers) c.parts.push('MCP');
    const st = readJson(p.claudeSettings);
    if (st.state === 'ok' && hasHookJson(st.data, o.cliPath)) c.parts.push('hook');
  }
  if (x.found) {
    const toml = readText(p.codexToml);
    if (toml !== null && hasBlock(toml, TOML_BEGIN, TOML_END)) x.parts.push('MCP');
    const hk = readJson(p.codexHooks);
    if (hk.state === 'ok' && hasHookJson(hk.data, o.cliPath)) x.parts.push('hook');
    const md = readText(p.codexAgents);
    if (md !== null && hasBlock(md, MD_BEGIN, MD_END)) x.parts.push('instrução');
  }
  return [c, x];
}

export function joinParts(parts: string[]): string {
  return parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} e ${parts[parts.length - 1]}`;
}
