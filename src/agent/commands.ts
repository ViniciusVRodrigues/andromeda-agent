import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import * as zlib from 'node:zlib';
import { AGENT_VERSION, ApiError } from '../types.js';
import type { AgentApi, LocalActiveTask, LogParser, ParserEnv, PayloadRow } from '../types.js';
import { Store, localDayOf } from '../store/db.js';
import { stateDir as resolveStateDir } from '../paths.js';
import { parsers as defaultParsers } from '../parsers/index.js';
import { claudeRoot } from '../parsers/claude.js';
import { codexRoot } from '../parsers/codex.js';
import { createGit, type GitInfo } from '../task/git.js';
import { FileCredentialStore, defaultCredentialStore, type CredentialStore } from '../auth/tokens.js';
import { pollForToken, startPairing, validateServerUrl, type FetchLike } from '../client/device.js';
import { HttpAgentApi, ReauthRequired } from '../client/http.js';
import { guardRows } from '../payload.js';
import { buildHeartbeat } from '../sync/heartbeat.js';
import {
  installService,
  nodeRunner,
  nodeServiceFs,
  planService,
  serviceStatus,
  uninstallService,
  type Runner,
  type ServiceFs,
  type ServiceStatus,
} from '../service/index.js';
import { createLogger } from '../log.js';
import { collect } from './collect.js';
import { acquireLock, getState, runLoop, type AgentDeps } from './loop.js';

/** Tudo o que o CLI toca no mundo; os testes trocam as peças. */
export interface CliContext {
  env: NodeJS.ProcessEnv;
  cwd: string;
  out(s: string): void;
  err(s: string): void;
  credStore?: CredentialStore;
  api?: AgentApi;
  fetch?: FetchLike;
  runner?: Runner;
  serviceFs?: ServiceFs;
  platform?: NodeJS.Platform;
  uid?: number;
  now?: () => number;
  timezone?: string;
  /** Caminho absoluto do `dist/src/cli.js`. */
  cliPath?: string;
  nodePath?: string;
  git?: GitInfo;
  parsers?: LogParser[];
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  /** Instala os tratadores de SIGINT/SIGTERM (o CLI real liga; testes não). */
  handleSignals?: boolean;
}

const MIN_NODE = [22, 15];

export const HELP = `andromeda-agent ${AGENT_VERSION}

Uso: andromeda-agent <comando>   (também instalado como "andromeda")

Comandos:
  pair <url-do-servidor>     Liga este computador à sua conta do Andromeda
  unpair                     Apaga as credenciais locais
  task <ref>                 Marca a tarefa ativa (AB#123, PROJ-45...)
  task --clear               Tira a tarefa ativa
  task --list                Lista as tarefas da sua sprint
  run                        Roda o agente em primeiro plano (é o que o serviço executa)
  run --once                 Faz um ciclo (coleta e envio) e sai
  --dry-run [--day AAAA-MM-DD]
                             Mostra o JSON exato que seria enviado, sem enviar nada
  install                    Registra o agente para iniciar sozinho no seu usuário
  uninstall [--purge]        Remove o serviço (--purge apaga também dados e credenciais)
  status                     Mostra pareamento, filas, estado e serviço
  doctor                     Confere requisitos, IAs encontradas e conexão
  --version                  Mostra a versão
  help                       Mostra esta ajuda

Detalhes do que é lido e enviado: PRIVACY.md.
`;

class UsageError extends Error {}

function stateDirOf(ctx: CliContext): string {
  return resolveStateDir(ctx.env, ctx.platform ?? process.platform);
}

function homeOf(ctx: CliContext): string {
  return ctx.env.HOME ?? ctx.env.USERPROFILE ?? homedir();
}

function parserEnv(ctx: CliContext): ParserEnv {
  return { home: homeOf(ctx), env: ctx.env };
}

function timezoneOf(ctx: CliContext): string {
  return ctx.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function credStoreOf(ctx: CliContext): CredentialStore {
  if (ctx.credStore) return ctx.credStore;
  const dir = stateDirOf(ctx);
  ctx.credStore =
    ctx.env.ANDROMEDA_AGENT_CREDENTIAL_STORE === 'file'
      ? new FileCredentialStore(dir, (m) => ctx.err(`aviso: ${m}\n`))
      : defaultCredentialStore(dir, undefined, (m) => ctx.err(`aviso: ${m}\n`));
  return ctx.credStore;
}

function apiOf(ctx: CliContext): AgentApi {
  return ctx.api ?? new HttpAgentApi(credStoreOf(ctx), ctx.fetch ? { fetch: ctx.fetch } : {});
}

function gitOf(ctx: CliContext): GitInfo {
  return ctx.git ?? createGit();
}

function openStore(ctx: CliContext): Store {
  return Store.open(stateDirOf(ctx));
}

function openExistingStore(ctx: CliContext): Store | null {
  return existsSync(join(stateDirOf(ctx), 'agent.db')) ? openStore(ctx) : null;
}

const line = (ctx: CliContext, s = ''): void => ctx.out(`${s}\n`);

function fmtTime(ms: number | null): string {
  return ms === null || !Number.isFinite(ms) ? 'nunca' : new Date(ms).toISOString();
}

function metaNum(store: Store, k: string): number | null {
  const v = store.getMeta(k);
  return v === null ? null : Number(v);
}

function describeError(e: unknown): string {
  if (e instanceof ReauthRequired) return 'este agente não está pareado ou a sessão expirou. Rode: andromeda-agent pair <url-do-servidor>';
  if (e instanceof ApiError) {
    if (e.status === 0) return 'não foi possível falar com o servidor (rede)';
    if (e.status === 401) return 'o servidor recusou a sessão. Rode: andromeda-agent pair <url-do-servidor>';
    if (e.status === 426) return 'o servidor exige uma versão mais nova do agente (npm i -g andromeda-agent)';
    return `${e.message} (${e.status}${e.code ? ` ${e.code}` : ''})`;
  }
  return e instanceof Error ? e.message : String(e);
}

// ---- pair / unpair ----

async function cmdPair(ctx: CliContext, args: string[]): Promise<number> {
  const raw = args[0];
  if (!raw) throw new UsageError('uso: andromeda-agent pair <url-do-servidor>');
  const base = validateServerUrl(raw);
  const fetchOpt = ctx.fetch ? { fetch: ctx.fetch } : {};
  const dc = await startPairing(base, fetchOpt);
  line(ctx, `Abra no navegador: ${dc.verification_uri_complete}`);
  line(ctx, `Código de confirmação: ${dc.user_code}`);
  line(ctx, 'Esperando a confirmação...');
  const creds = await pollForToken(base, dc.device_code, dc.interval, dc.expires_in, {
    ...fetchOpt,
    ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
    ...(ctx.now ? { now: ctx.now } : {}),
  });
  await credStoreOf(ctx).save(creds);
  try {
    const store = openStore(ctx);
    try {
      store.setMeta('state', 'ok');
    } finally {
      store.close();
    }
  } catch {
    /* o estado local nasce no primeiro ciclo */
  }
  line(ctx, `Pareado com a organização ${creds.organizationSlug} (${creds.serverUrl}).`);
  line(ctx, 'Próximo passo: andromeda-agent install (para iniciar sozinho) ou andromeda-agent run.');
  return 0;
}

async function cmdUnpair(ctx: CliContext): Promise<number> {
  await credStoreOf(ctx).clear();
  line(ctx, 'Credenciais locais apagadas.');
  line(ctx, 'A revogação deste dispositivo no servidor é feita pelo app web do Andromeda (Perfil, Dispositivos).');
  return 0;
}

// ---- task ----

async function cmdTask(ctx: CliContext, args: string[]): Promise<number> {
  const now = (ctx.now ?? Date.now)();
  if (args.includes('--list')) {
    const items = await apiOf(ctx).listTasks();
    if (items.length === 0) line(ctx, 'Nenhuma tarefa na sua sprint.');
    for (const t of items) line(ctx, `${t.ref}\t${t.type}\t${t.title}\t${t.sprintName}`);
    return 0;
  }
  if (args.includes('--clear')) {
    await apiOf(ctx).clearActiveTask();
    const store = openStore(ctx);
    try {
      store.setLocalActiveTask(null);
    } finally {
      store.close();
    }
    line(ctx, 'Tarefa ativa removida.');
    return 0;
  }
  const ref = args.find((a) => !a.startsWith('--'));
  if (!ref) throw new UsageError('uso: andromeda-agent task <ref> | --clear | --list');
  const repo = await gitOf(ctx).remoteOf(ctx.cwd);
  const resp = await apiOf(ctx).setActiveTask({
    taskRef: ref,
    since: new Date(now).toISOString(),
    day: localDayOf(now, timezoneOf(ctx)),
    repo,
  });
  const task: LocalActiveTask = { taskRef: resp.ref || ref, since: now, repo };
  const store = openStore(ctx);
  try {
    store.setLocalActiveTask(task);
  } finally {
    store.close();
  }
  line(ctx, `Tarefa ativa: ${task.taskRef} - ${resp.title}`);
  line(ctx, `Linhas de uso já enviadas hoje e reatribuídas: ${resp.retroactiveRows}`);
  return 0;
}

// ---- run ----

async function cmdRun(ctx: CliContext, args: string[]): Promise<number> {
  if (args.includes('--dry-run')) return cmdDryRun(ctx, args);
  const once = args.includes('--once');
  const dir = stateDirOf(ctx);
  mkdirSync(dir, { recursive: true });
  const lock = acquireLock(dir);
  if (!lock) {
    line(ctx, 'O agente já está rodando neste usuário (agent.lock). Nada a fazer.');
    return 0;
  }
  const store = openStore(ctx);
  const log = createLogger(dir, ctx.now);
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  if (ctx.signal) {
    if (ctx.signal.aborted) stop();
    else ctx.signal.addEventListener('abort', stop, { once: true });
  }
  if (ctx.handleSignals) {
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }
  const deps: AgentDeps = {
    store,
    api: apiOf(ctx),
    creds: credStoreOf(ctx),
    parsers: ctx.parsers ?? defaultParsers,
    git: gitOf(ctx),
    env: parserEnv(ctx),
    timezone: timezoneOf(ctx),
    log,
    ...(ctx.now ? { now: ctx.now } : {}),
  };
  log.info(`agente ${AGENT_VERSION} iniciado (${once ? 'um ciclo' : 'laço'})`);
  try {
    await runLoop(deps, lock, {
      once,
      signal: controller.signal,
      onCycle: (s) => {
        if (once) {
          const c = s.collect;
          line(ctx, `Coleta: ${c?.events ?? 0} evento(s) novo(s), ${c?.rows ?? 0} linha(s). Enviadas: ${s.sent}. Estado: ${stateLabel(s.state)}.`);
        }
      },
    });
  } finally {
    log.info('agente encerrado');
    ctx.signal?.removeEventListener('abort', stop);
    if (ctx.handleSignals) {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
    store.close();
    lock.release();
  }
  return 0;
}

function stateLabel(s: string): string {
  return s === 'needs_pair' ? 'precisa parear' : s === 'upgrade' ? 'atualize o agente' : 'ok';
}

// ---- dry-run ----

/** Lê o sal e a tarefa ativa do store real numa CÓPIA, sem tocar o original. */
function readRealMeta(dir: string): { salt: string | null; task: LocalActiveTask | null } {
  const src = join(dir, 'agent.db');
  if (!existsSync(src)) return { salt: null, task: null };
  const tmp = mkdtempSync(join(tmpdir(), 'andromeda-dry-meta-'));
  try {
    for (const ext of ['', '-wal', '-shm']) {
      if (existsSync(src + ext)) copyFileSync(src + ext, join(tmp, `agent.db${ext}`));
    }
    const s = Store.open(tmp);
    try {
      return { salt: s.getMeta('salt'), task: s.getLocalActiveTask() };
    } finally {
      s.close();
    }
  } catch {
    return { salt: null, task: null };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function cmdDryRun(ctx: CliContext, args: string[]): Promise<number> {
  const di = args.indexOf('--day');
  const day = di >= 0 ? args[di + 1] : undefined;
  if (di >= 0 && !(day && /^\d{4}-\d{2}-\d{2}$/.test(day))) throw new UsageError('uso: --day AAAA-MM-DD');
  const real = readRealMeta(stateDirOf(ctx));
  const tmp = mkdtempSync(join(tmpdir(), 'andromeda-dry-'));
  const store = Store.open(tmp);
  try {
    if (real.salt) store.setMeta('salt', real.salt);
    store.setLocalActiveTask(real.task);
    await collect(store, ctx.parsers ?? defaultParsers, gitOf(ctx), parserEnv(ctx), timezoneOf(ctx));
    let rows: PayloadRow[] = store.takePending(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER).map((i) => i.row);
    if (day) rows = rows.filter((r) => r.day === day);
    line(ctx, JSON.stringify(rows, null, 2));
    const problems = guardRows(rows);
    if (problems.length === 0) {
      ctx.err(`Lista de permissão: OK (${rows.length} linha(s), nada enviado).\n`);
      return 0;
    }
    ctx.err(`Lista de permissão: ${problems.length} problema(s)\n${problems.slice(0, 20).join('\n')}\n`);
    return 1;
  } finally {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- install / uninstall ----

function planOf(ctx: CliContext): ReturnType<typeof planService> {
  const platform = ctx.platform ?? process.platform;
  const cliPath = ctx.cliPath;
  if (!cliPath) throw new Error('caminho do CLI desconhecido');
  const uid = ctx.uid ?? process.getuid?.();
  const username = ctx.env.USERNAME ?? ctx.env.USER ?? userInfo().username;
  return planService({
    platform,
    nodePath: ctx.nodePath ?? process.execPath,
    cliPath,
    stateDir: stateDirOf(ctx),
    home: homeOf(ctx),
    username,
    ...(uid !== undefined ? { uid } : {}),
    ...(ctx.env.USERDOMAIN ? { userDomain: ctx.env.USERDOMAIN } : {}),
  });
}

async function cmdInstall(ctx: CliContext): Promise<number> {
  if (ctx.cliPath && /[\\/]_npx[\\/]/.test(ctx.cliPath)) {
    ctx.err('Este agente está rodando de um cache temporário do npx; o serviço quebraria quando o cache for limpo.\n');
    ctx.err('Instale de verdade e rode de novo: npm i -g andromeda-agent && andromeda-agent install\n');
    return 1;
  }
  const plan = planOf(ctx);
  const dir = stateDirOf(ctx);
  mkdirSync(dir, { recursive: true });
  const store = openStore(ctx);
  try {
    store.setMeta('node_path', ctx.nodePath ?? process.execPath);
  } finally {
    store.close();
  }
  const r = await installService(plan, ctx.runner ?? nodeRunner, ctx.serviceFs ?? nodeServiceFs);
  if (r.manual) {
    line(ctx, r.manual);
    return 0;
  }
  for (const n of r.notes) line(ctx, n);
  if (!r.ok) return 1;
  line(ctx, 'Serviço instalado: o agente inicia sozinho no seu usuário.');
  return 0;
}

/** Tudo o que o agente grava na pasta de estado. */
const STATE_FILES = [
  'agent.db',
  'agent.db-wal',
  'agent.db-shm',
  'agent.lock',
  'agent.log',
  'agent.log.1',
  'credentials.json',
  'andromeda-agent-task.xml',
  'launch.vbs',
];

async function cmdUninstall(ctx: CliContext, args: string[]): Promise<number> {
  const plan = planOf(ctx);
  await uninstallService(plan, ctx.runner ?? nodeRunner, ctx.serviceFs ?? nodeServiceFs);
  line(ctx, 'Serviço removido.');
  if (args.includes('--purge')) {
    await credStoreOf(ctx).clear();
    // Só os arquivos do agente: ANDROMEDA_AGENT_HOME pode apontar para uma pasta com outras coisas.
    const dir = stateDirOf(ctx);
    for (const f of STATE_FILES) rmSync(join(dir, f), { force: true });
    try {
      rmdirSync(dir);
    } catch {
      // pasta com outros arquivos fica como está
    }
    line(ctx, 'Dados locais e credenciais apagados.');
  } else {
    line(ctx, 'Dados locais e credenciais mantidos. Use uninstall --purge para apagar tudo.');
  }
  return 0;
}

// ---- status ----

async function safeServiceStatus(ctx: CliContext): Promise<ServiceStatus | null> {
  try {
    return await serviceStatus(planOf(ctx), ctx.runner ?? nodeRunner);
  } catch {
    return null;
  }
}

async function cmdStatus(ctx: CliContext): Promise<number> {
  const creds = await credStoreOf(ctx).load().catch(() => null);
  line(ctx, creds ? `Pareado: sim, organização ${creds.organizationSlug}, servidor ${creds.serverUrl}` : 'Pareado: não');
  const store = openExistingStore(ctx);
  if (!store) {
    line(ctx, 'Dados locais: ainda não há (o agente nunca rodou)');
  } else {
    try {
      const st = store.stats();
      const state = getState(store);
      const task = store.getLocalActiveTask();
      line(ctx, `Estado: ${creds ? stateLabel(state) : 'precisa parear'}`);
      line(ctx, `Última coleta: ${fmtTime(metaNum(store, 'last_collect'))}`);
      line(ctx, `Último envio: ${fmtTime(metaNum(store, 'last_send'))}`);
      line(ctx, `Pendentes: ${st.pending}`);
      line(ctx, `Rejeitadas: ${st.rejected}`);
      line(ctx, `Dia mais antigo pendente: ${st.oldestPendingDay ?? 'nenhum'}`);
      line(ctx, `Tarefa ativa: ${task ? `${task.taskRef} desde ${fmtTime(task.since)}${task.repo ? ` (${task.repo})` : ''}` : 'nenhuma'}`);
    } finally {
      store.close();
    }
  }
  const svc = await safeServiceStatus(ctx);
  if (!svc) line(ctx, 'Serviço: não foi possível consultar');
  else if (!svc.exists) line(ctx, 'Serviço: não instalado (rode andromeda-agent install)');
  else {
    const parts = [svc.enabled === null ? 'habilitado: ?' : svc.enabled ? 'habilitado' : 'desabilitado'];
    if (svc.running !== null) parts.push(svc.running ? 'rodando' : 'parado');
    if (svc.lastResult) parts.push(`último resultado ${svc.lastResult}`);
    line(ctx, `Serviço: instalado, ${parts.join(', ')}`);
  }
  return 0;
}

// ---- doctor ----

type Level = 'OK' | 'AVISO' | 'ERRO';

function nodeOk(version: string): boolean {
  const [maj = 0, min = 0] = version.split('.').map(Number);
  return maj > MIN_NODE[0]! || (maj === MIN_NODE[0] && min >= MIN_NODE[1]!);
}

async function cmdDoctor(ctx: CliContext): Promise<number> {
  const items: Array<[Level, string]> = [];
  const add = (l: Level, t: string): void => void items.push([l, t]);

  add('OK', `Agente ${AGENT_VERSION}`);
  const nv = process.versions.node;
  add(nodeOk(nv) ? 'OK' : 'ERRO', nodeOk(nv) ? `Node ${nv}` : `Node ${nv}: é preciso 22.15 ou mais novo`);
  try {
    await import('node:sqlite');
    add('OK', 'node:sqlite disponível');
  } catch {
    add('ERRO', 'node:sqlite indisponível (atualize o Node)');
  }
  add(
    typeof (zlib as { zstdDecompressSync?: unknown }).zstdDecompressSync === 'function' ? 'OK' : 'ERRO',
    typeof (zlib as { zstdDecompressSync?: unknown }).zstdDecompressSync === 'function'
      ? 'zlib.zstdDecompressSync disponível (logs .zst do Codex)'
      : 'zlib.zstdDecompressSync indisponível (atualize o Node)',
  );

  const store = openExistingStore(ctx);
  const nodeSaved = store?.getMeta('node_path') ?? null;
  if (nodeSaved === null) add('AVISO', 'Caminho do node gravado: nenhum (o serviço não foi instalado por este agente)');
  else if (existsSync(nodeSaved)) add('OK', `Caminho do node gravado existe: ${nodeSaved}`);
  else add('ERRO', `Caminho do node gravado não existe mais: ${nodeSaved} (rode install de novo)`);

  const svc = await safeServiceStatus(ctx);
  if (!svc) add('AVISO', 'Serviço: não foi possível consultar');
  else if (!svc.exists) add('AVISO', 'Serviço: não instalado (rode andromeda-agent install)');
  else if (svc.enabled === false) add('AVISO', 'Serviço: instalado, mas desabilitado');
  else add('OK', 'Serviço: instalado e habilitado');

  const penv = parserEnv(ctx);
  for (const p of ctx.parsers ?? defaultParsers) {
    const base = p.tool === 'claude-code' ? claudeRoot(penv) : p.tool === 'codex' ? codexRoot(penv) : p.tool;
    let n = 0;
    try {
      n = (await p.discover(penv)).length;
    } catch {
      n = 0;
    }
    add(n > 0 ? 'OK' : 'AVISO', `Logs de ${p.tool}: ${n} arquivo(s) em ${base}`);
  }

  let creds = null;
  try {
    const cs = credStoreOf(ctx);
    creds = await cs.load();
    add('OK', `Cofre acessível (${cs instanceof FileCredentialStore ? 'arquivo restrito' : 'cofre do sistema'})`);
  } catch {
    add('ERRO', 'Cofre de credenciais inacessível');
  }
  add(creds ? 'OK' : 'AVISO', creds ? `Pareado com ${creds.organizationSlug} (${creds.serverUrl})` : 'Não pareado (rode andromeda-agent pair <url>)');

  if (store) {
    try {
      const st = store.stats();
      add('OK', `Fila: ${st.pending} pendente(s)`);
      add(st.rejected > 0 ? 'AVISO' : 'OK', `Rejeitadas: ${st.rejected}`);
      const lastSend = metaNum(store, 'last_send');
      const age = lastSend === null ? null : (ctx.now ?? Date.now)() - lastSend;
      if (age === null) add(st.pending > 0 ? 'AVISO' : 'OK', 'Último envio: nunca');
      else add(age > 24 * 3_600_000 && st.pending > 0 ? 'AVISO' : 'OK', `Último envio: há ${Math.round(age / 60_000)} min`);
      const state = getState(store);
      if (state !== 'ok') add('ERRO', `Estado: ${stateLabel(state)}`);
    } finally {
      store.close();
    }
  } else {
    add('AVISO', 'Dados locais: ainda não há (o agente nunca rodou)');
  }

  if (creds) {
    try {
      const probe = Store.open(mkdtempSync(join(tmpdir(), 'andromeda-doctor-')));
      try {
        await apiOf(ctx).heartbeat(buildHeartbeat(probe, AGENT_VERSION, timezoneOf(ctx)));
        add('OK', 'Conectividade: o servidor respondeu ao heartbeat');
      } finally {
        probe.close();
      }
    } catch (e) {
      const fatal = e instanceof ReauthRequired || (e instanceof ApiError && (e.status === 401 || e.status === 426));
      add(fatal ? 'ERRO' : 'AVISO', `Conectividade: ${describeError(e)}`);
    }
  }

  for (const [l, t] of items) line(ctx, `[${l}] ${t}`);
  return items.some(([l]) => l === 'ERRO') ? 1 : 0;
}

// ---- entrada ----

export async function runCli(argv: string[], ctx: CliContext): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        line(ctx, HELP.trimEnd());
        return 0;
      case '--version':
      case '-v':
      case 'version':
        line(ctx, AGENT_VERSION);
        return 0;
      case 'pair':
        return await cmdPair(ctx, rest);
      case 'unpair':
        return await cmdUnpair(ctx);
      case 'task':
        return await cmdTask(ctx, rest);
      case 'run':
        return await cmdRun(ctx, rest);
      case '--dry-run':
      case 'dry-run':
        return await cmdDryRun(ctx, argv);
      case 'install':
        return await cmdInstall(ctx);
      case 'uninstall':
        return await cmdUninstall(ctx, rest);
      case 'status':
        return await cmdStatus(ctx);
      case 'doctor':
        return await cmdDoctor(ctx);
      default:
        ctx.err(`Comando desconhecido: ${cmd}\n\n${HELP}`);
        return 2;
    }
  } catch (e) {
    if (e instanceof UsageError) {
      ctx.err(`${e.message}\n`);
      return 2;
    }
    ctx.err(`erro: ${describeError(e)}\n`);
    return 1;
  }
}
