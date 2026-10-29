// Serviço do agente por usuário, sem admin: tarefa agendada (Windows),
// LaunchAgent (macOS) e unit de usuário do systemd (Linux). Este módulo só
// GERA arquivos e comandos; quem executa é o `Runner` injetado.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { planWindows, parseWindowsStatus } from './windows.js';
import { planMacos, parseMacosStatus } from './macos.js';
import { planLinux, parseLinuxStatus } from './linux.js';

export interface ServiceFile {
  path: string;
  content: string;
  mode?: number;
  /** `utf16le-bom`: o `schtasks /create /xml` espera UTF-16 LE com BOM. */
  encoding?: 'utf8' | 'utf16le-bom';
}

export type Command = [cmd: string, args: string[]];

export interface ServicePlan {
  platform: NodeJS.Platform;
  files: ServiceFile[];
  installCommands: Command[];
  uninstallCommands: Command[];
  statusCommand: Command;
  /** Índices de `installCommands` cuja falha não interrompe a instalação. */
  tolerantInstall?: number[];
  /** Texto para mostrar à pessoa depois de instalar (ex.: linger no Linux). */
  hints: string[];
}

export interface PlanInput {
  platform: NodeJS.Platform;
  /** `process.execPath`, absoluto. */
  nodePath: string;
  /** `dist/src/cli.js`, absoluto. */
  cliPath: string;
  stateDir: string;
  home: string;
  username: string;
  uid?: number;
  /** Windows: `USERDOMAIN`. */
  userDomain?: string;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Runner {
  run(cmd: string, args: string[]): Promise<RunResult>;
}

export interface ServiceFs {
  mkdir(dir: string): Promise<void>;
  writeFile(path: string, data: Buffer, mode?: number): Promise<void>;
  rm(path: string): Promise<void>;
}

export interface ServiceStatus {
  exists: boolean;
  /** `null` quando o SO não informa. */
  enabled: boolean | null;
  running: boolean | null;
  lastResult: string | null;
}

export interface InstallResult {
  ok: boolean;
  /** Sem gerenciador de serviço: instrução manual, não é erro fatal. */
  manual?: string;
  notes: string[];
}

export function planService(input: PlanInput): ServicePlan {
  switch (input.platform) {
    case 'win32':
      return planWindows(input);
    case 'darwin':
      return planMacos(input);
    case 'linux':
      return planLinux(input);
    default:
      throw new Error(`Plataforma sem suporte a serviço: ${input.platform}`);
  }
}

function encode(file: ServiceFile): Buffer {
  if (file.encoding === 'utf16le-bom') {
    return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(file.content, 'utf16le')]);
  }
  return Buffer.from(file.content, 'utf8');
}

async function safeRun(runner: Runner, [cmd, args]: Command): Promise<RunResult> {
  try {
    return await runner.run(cmd, args);
  } catch (e) {
    return { code: 127, stdout: '', stderr: e instanceof Error ? e.message : String(e) };
  }
}

export const LINUX_MANUAL =
  'Sem systemd de usuário nesta sessão. Rode `andromeda-agent run` num terminal, ou crie uma entrada de autostart XDG ' +
  '(~/.config/autostart/andromeda-agent.desktop) que execute `andromeda-agent run`.';

export async function installService(plan: ServicePlan, runner: Runner, fs: ServiceFs): Promise<InstallResult> {
  for (const f of plan.files) {
    await fs.mkdir(dirname(f.path));
    await fs.writeFile(f.path, encode(f), f.mode);
  }
  const tolerant = new Set(plan.tolerantInstall ?? []);
  for (const [i, c] of plan.installCommands.entries()) {
    const r = await safeRun(runner, c);
    if (r.code === 0 || tolerant.has(i)) continue;
    if (plan.platform === 'linux' && c[1].includes('--user')) {
      return { ok: false, manual: LINUX_MANUAL, notes: [] };
    }
    return { ok: false, notes: [`Falhou: ${c[0]} ${c[1].join(' ')} (código ${r.code}) ${r.stderr.trim()}`.trim()] };
  }
  return { ok: true, notes: plan.hints };
}

export async function uninstallService(plan: ServicePlan, runner: Runner, fs: ServiceFs): Promise<void> {
  for (const c of plan.uninstallCommands) await safeRun(runner, c);
  for (const f of plan.files) await fs.rm(f.path);
}

export async function serviceStatus(plan: ServicePlan, runner: Runner): Promise<ServiceStatus> {
  const r = await safeRun(runner, plan.statusCommand);
  if (plan.platform === 'win32') return parseWindowsStatus(r);
  if (plan.platform === 'darwin') return parseMacosStatus(r);
  return parseLinuxStatus(r);
}

export const nodeServiceFs: ServiceFs = {
  mkdir: async (d) => void (await mkdir(d, { recursive: true })),
  writeFile: (p, data, mode) => writeFile(p, data, mode === undefined ? {} : { mode }),
  rm: (p) => rm(p, { force: true }),
};

export const nodeRunner: Runner = {
  run(cmd, args) {
    return new Promise((resolve, reject) => {
      const p = spawn(cmd, args, { windowsHide: true });
      let stdout = '';
      let stderr = '';
      p.stdout.on('data', (d) => (stdout += String(d)));
      p.stderr.on('data', (d) => (stderr += String(d)));
      p.on('error', reject);
      p.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
  },
};
