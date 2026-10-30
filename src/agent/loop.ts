import { readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_VERSION, ApiError } from '../types.js';
import type { ActiveTask, ActiveTaskEnded, AgentApi, HeartbeatResponse, LogParser, ParserEnv, PayloadRow, UsageBatchResponse } from '../types.js';
import { localDayOf, type Store } from '../store/db.js';
import type { GitInfo } from '../task/git.js';
import type { CredentialStore } from '../auth/tokens.js';
import { ReauthRequired } from '../client/http.js';
import { assertRowsSafe } from '../payload.js';
import { sendPending } from '../sync/sender.js';
import { refreshPatterns, PATTERNS_TTL_MS } from '../task/server-patterns.js';
import { buildHeartbeat, heartbeatDue } from '../sync/heartbeat.js';
import { reconcile } from '../sync/reconcile.js';
import { nullLogger, type Logger } from '../log.js';
import { collect, type CollectResult } from './collect.js';
import { enforceExpiry, flushPendingEnd, getPendingEnd, setLastTaskEnd, setTaskConflict } from '../task/task-state.js';

export const CYCLE_MS = 60_000;
/** Coleta e envio a cada 15 min; devido com folga de 30 s (a volta do laço não é exata). */
export const SYNC_INTERVAL_MS = 15 * 60_000;
export const SYNC_DUE_MS = SYNC_INTERVAL_MS - 30_000;
export const RECONCILE_INTERVAL_MS = 24 * 3_600_000;
export const RECONCILE_DAYS = 7;
export const RETENTION_MS = 90 * 24 * 3_600_000;
export const LOCK_STALE_MS = 10 * 60_000;

export function syncDue(lastMs: number | null, nowMs: number): boolean {
  return lastMs === null || !Number.isFinite(lastMs) || nowMs - lastMs >= SYNC_DUE_MS;
}

export type AgentState = 'ok' | 'needs_pair' | 'upgrade';

export interface AgentDeps {
  store: Store;
  api: AgentApi;
  creds: CredentialStore;
  parsers: LogParser[];
  git: GitInfo;
  env: ParserEnv;
  timezone: string;
  log?: Logger;
  now?: () => number;
}

/** Envolve o cliente para garantir a lista de permissão em todo lote que sai. */
export function guardedApi(api: AgentApi): AgentApi {
  return {
    async uploadUsage(batchId: string, timezone: string, rows: PayloadRow[]): Promise<UsageBatchResponse> {
      assertRowsSafe(rows);
      return await api.uploadUsage(batchId, timezone, rows);
    },
    heartbeat: (r) => api.heartbeat(r),
    reconcile: (a, b) => api.reconcile(a, b),
    usageKeys: (d) => api.usageKeys(d),
    setActiveTask: (r) => api.setActiveTask(r),
    clearActiveTask: (r) => api.clearActiveTask(r),
    listTasks: () => api.listTasks(),
    workItemPatterns: () => api.workItemPatterns(),
  };
}

export function getState(store: Store): AgentState {
  const v = store.getMeta('state');
  return v === 'needs_pair' || v === 'upgrade' ? v : 'ok';
}

function setState(store: Store, s: AgentState): void {
  if (getState(store) !== s) store.setMeta('state', s);
}

/** Compara `a.b.c`; true se `a` é mais velho que `b`. */
export function versionLess(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0);
  }
  return false;
}

export type SyncReason = 'start' | 'interval' | 'requested';

export interface CycleSummary {
  collect: CollectResult | null;
  sent: number;
  heartbeat: boolean;
  reconciled: boolean;
  /** Esta volta coletou e enviou (a volta só de heartbeat devolve false). */
  synced: boolean;
  syncReason?: SyncReason;
  state: AgentState;
}

/** Estado em memória do laço: o que não deve ser repetido a cada ciclo. */
export interface LoopMemory {
  upgrade: boolean;
  failedRefreshToken: string | null;
  /** Sincroniza na próxima volta, venha ou não o prazo (início do laço e `run --once`). */
  forceSync: boolean;
  /** Último pedido de sincronização do servidor que o agente atendeu (nunca atende o mesmo duas vezes). */
  servedSync: string | null;
  /** Pedido atendido cuja confirmação (`syncServed`) o servidor ainda não aceitou. */
  servedToConfirm: string | null;
  /** Instante da última tentativa de buscar os padrões de branch (no máximo uma por hora). */
  patternsTriedAt: number | null;
}

export function newMemory(): LoopMemory {
  return { upgrade: false, failedRefreshToken: null, forceSync: true, servedSync: null, servedToConfirm: null, patternsTriedAt: null };
}

function applyServerTask(deps: AgentDeps, t: ActiveTask): void {
  const taskRef = t.taskRef ?? t.ref;
  if (!taskRef) return;
  // O fim da tarefa ainda não chegou ao servidor: a tarefa local já não vale, não a traga de volta.
  if (getPendingEnd(deps.store)) return;
  const cur = deps.store.getLocalActiveTask();
  if (cur && cur.taskRef === taskRef) return;
  const since = Date.parse(t.since);
  const sinceMs = Number.isFinite(since) ? since : (deps.now ?? Date.now)();
  deps.store.setLocalActiveTask({
    taskRef,
    since: sinceMs,
    repo: t.repository ?? null,
    title: t.title,
    branch: t.branch ?? null,
    cwd: null,
    day: t.day ?? localDayOf(sinceMs, deps.timezone),
  });
}

/** O servidor encerrou a tarefa (item fechado, saiu da sprint, virou o dia): grava o fim e limpa a local, uma vez por `endedAt`. */
function applyServerEnd(deps: AgentDeps, e: ActiveTaskEnded): void {
  const { store } = deps;
  if (!e.endedAt || store.getMeta('last_task_end_seen') === e.endedAt) return;
  store.setMeta('last_task_end_seen', e.endedAt);
  const endedMs = Date.parse(e.endedAt);
  const cur = store.getLocalActiveTask();
  // Tarefa marcada depois do fim é outra; o eco do nosso próprio DELETE e o CLEARED não são "expirou".
  if (cur && Number.isFinite(endedMs) && cur.since > endedMs) return;
  const ref = e.ref ?? cur?.taskRef;
  if (e.reason !== 'CLEARED' && ref) {
    const title = e.title || cur?.title;
    setLastTaskEnd(store, {
      taskRef: ref,
      ...(title ? { title } : {}),
      reason: e.reason,
      at: e.endedAt,
      ...(e.newBranch ? { newBranch: e.newBranch } : {}),
      ...(e.newRepo ? { newRepo: e.newRepo } : {}),
    });
  }
  if (cur) store.setLocalActiveTask(null);
  setTaskConflict(store, null);
}

/** Coleta, envio e reconciliação diária. Sem `api`, só coleta. Devolve se a sessão foi recusada. */
async function syncNow(
  deps: AgentDeps,
  mem: LoopMemory,
  api: AgentApi | null,
  sum: CycleSummary,
  onError: (what: string, e: unknown) => void,
): Promise<boolean> {
  const log = deps.log ?? nullLogger;
  const clock = deps.now ?? Date.now;
  const { store } = deps;
  let authFailed = false;

  try {
    sum.collect = await collect(store, deps.parsers, deps.git, deps.env, deps.timezone, { log, now: clock });
    store.setMeta('last_collect', String(clock()));
    if (sum.collect.rows > 0 || sum.collect.read > 0) {
      log.info(`coleta: ${sum.collect.read} arquivo(s), ${sum.collect.events} evento(s), ${sum.collect.rows} linha(s)`);
    }
  } catch (e) {
    log.error(`coleta falhou (${e instanceof Error ? e.name : 'erro'})`);
  }
  if (!api) return false;

  // envio
  if (!mem.upgrade) {
    try {
      const s = await sendPending(store, api, { timezone: deps.timezone, now: clock });
      sum.sent = s.sent + s.duplicate;
      if (s.authFailed) authFailed = true;
      if (s.upgradeRequired) mem.upgrade = true;
      if (s.sent + s.duplicate + s.rejected > 0) {
        store.setMeta('last_send', String(clock()));
        log.info(`envio: ${s.sent} aceita(s), ${s.duplicate} repetida(s), ${s.rejected} rejeitada(s), ${s.deferred} adiada(s)`);
      }
    } catch (e) {
      onError('envio', e);
    }
  }

  // reconciliação diária
  const lastRec = Number(store.getMeta('last_reconcile') ?? 0);
  if (!authFailed && !mem.upgrade && clock() - lastRec >= RECONCILE_INTERVAL_MS) {
    try {
      const days: string[] = [];
      for (let i = 0; i < RECONCILE_DAYS; i++) days.push(localDayOf(clock() - i * 86_400_000, deps.timezone));
      const diverged = await reconcile(store, api, { days, now: clock() });
      store.setMeta('last_reconcile', String(clock()));
      sum.reconciled = true;
      if (diverged.length > 0) log.info(`reconciliação: ${diverged.length} dia(s) divergente(s)`);
    } catch (e) {
      onError('reconciliação', e);
    }
  }
  return authFailed;
}

/**
 * Uma volta: padrões (se devidos), heartbeat, e, se devido, forçado ou pedido pelo servidor,
 * coleta + envio + reconciliação. Depois de atender um pedido, heartbeat de confirmação na hora.
 * Erro de rede nunca derruba.
 */
export async function cycle(deps: AgentDeps, mem: LoopMemory): Promise<CycleSummary> {
  const log = deps.log ?? nullLogger;
  const clock = deps.now ?? Date.now;
  const { store } = deps;
  const sum: CycleSummary = { collect: null, sent: 0, heartbeat: false, reconciled: false, synced: false, state: getState(store) };

  // A tarefa marcada expira sozinha (dia, branch); o DELETE vai quando houver sessão.
  try {
    await enforceExpiry(store, deps.git, clock(), deps.timezone);
  } catch {
    /* conferir a tarefa nunca derruba a volta */
  }

  const creds = await deps.creds.load();
  if (!creds) {
    // sem credencial: só coleta, como antes (não grava last_sync, então segue devido)
    await syncNow(deps, mem, null, sum, () => {});
    setState(store, 'needs_pair');
    sum.state = 'needs_pair';
    return sum;
  }
  if (mem.failedRefreshToken !== null && mem.failedRefreshToken === creds.refreshToken) {
    await syncNow(deps, mem, null, sum, () => {});
    sum.state = 'needs_pair';
    return sum;
  }
  mem.failedRefreshToken = null;
  if (getState(store) === 'needs_pair') setState(store, 'ok');

  const api = guardedApi(deps.api);
  let authFailed = false;
  const onError = (what: string, e: unknown): void => {
    if (e instanceof ReauthRequired || (e instanceof ApiError && e.status === 401)) {
      authFailed = true;
      log.warn(`${what}: sessão recusada; é preciso parear de novo`);
    } else if (e instanceof ApiError && e.status === 426) {
      mem.upgrade = true;
      log.warn(`${what}: o servidor exige uma versão mais nova do agente`);
    } else {
      log.warn(`${what} falhou (${e instanceof Error ? e.name : 'erro'}${e instanceof ApiError ? ` ${e.status}` : ''})`);
    }
  };

  // padrões de branch do servidor: uma busca por hora, erro só vira aviso
  if (!mem.upgrade && (mem.patternsTriedAt === null || clock() - mem.patternsTriedAt > PATTERNS_TTL_MS)) {
    mem.patternsTriedAt = clock();
    await refreshPatterns(store, api, clock(), log);
  }

  // fim da tarefa que ainda não chegou ao servidor: antes do heartbeat, para ele não devolver a tarefa
  if (!mem.upgrade) await flushPendingEnd(store, api);

  /** Um heartbeat; leva `syncServed` enquanto houver confirmação pendente. Devolve a resposta ou null. */
  const beat = async (): Promise<HeartbeatResponse | null> => {
    try {
      const confirming = mem.servedToConfirm;
      const res = await api.heartbeat(buildHeartbeat(store, AGENT_VERSION, deps.timezone, confirming, clock()));
      store.setMeta('last_heartbeat', String(clock()));
      sum.heartbeat = true;
      if (confirming !== null && res.syncRequestedAt !== confirming) mem.servedToConfirm = null;
      if (res.activeTaskEnded) applyServerEnd(deps, res.activeTaskEnded);
      if (res.activeTask) applyServerTask(deps, res.activeTask);
      else store.setLocalActiveTask(null);
      if (res.minVersion && versionLess(AGENT_VERSION, res.minVersion)) mem.upgrade = true;
      return res;
    } catch (e) {
      onError('heartbeat', e);
      return null;
    }
  };

  // heartbeat: toda volta
  let hb: HeartbeatResponse | null = null;
  const lastHb = store.getMeta('last_heartbeat');
  if (!mem.upgrade && (mem.forceSync || mem.servedToConfirm !== null || heartbeatDue(lastHb === null ? null : Number(lastHb), clock()))) {
    hb = await beat();
  }

  // decide se sincroniza
  const lastSyncMeta = store.getMeta('last_sync');
  const requested = hb?.syncRequestedAt ?? null;
  const isRequested = requested !== null && requested !== mem.servedSync;
  let reason: SyncReason | null = null;
  if (mem.forceSync) reason = 'start';
  else if (syncDue(lastSyncMeta === null ? null : Number(lastSyncMeta), clock())) reason = 'interval';
  else if (isRequested) reason = 'requested';

  if (reason !== null && !authFailed) {
    if (isRequested) log.info('sincronização pedida pelo Andromeda');
    sum.syncReason = reason;
    authFailed = await syncNow(deps, mem, api, sum, onError);
    mem.forceSync = false;
    if (!authFailed && !mem.upgrade) await flushPendingEnd(store, api);
    if (!authFailed && !mem.upgrade) {
      sum.synced = true;
      store.setMeta('last_sync', String(clock()));
      if (isRequested && requested !== null) {
        mem.servedSync = requested;
        mem.servedToConfirm = requested;
        await beat();
      }
    }
  }

  if (authFailed) {
    mem.failedRefreshToken = creds.refreshToken;
    setState(store, 'needs_pair');
  } else if (mem.upgrade) {
    setState(store, 'upgrade');
  } else {
    setState(store, 'ok');
  }
  sum.state = getState(store);

  try {
    store.pruneEvents(clock() - RETENTION_MS);
  } catch {
    /* poda é só higiene */
  }
  return sum;
}

// ---- trava de instância única ----

export interface Lock {
  release(): void;
  touch(): void;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function mtimeOf(p: string): number | null {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

/** Devolve a trava, ou null se outra instância viva a tem. Trava velha é retomada. */
export function acquireLock(
  dir: string,
  opts: { pid?: number; alive?: (pid: number) => boolean; now?: () => number } = {},
): Lock | null {
  const path = join(dir, 'agent.lock');
  const pid = opts.pid ?? process.pid;
  const alive = opts.alive ?? pidAlive;
  const now = opts.now ?? Date.now;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, String(pid), { flag: 'wx', mode: 0o600 });
      return {
        release: () => {
          try {
            if (readFileSync(path, 'utf8').trim() === String(pid)) rmSync(path, { force: true });
          } catch {
            /* já removida */
          }
        },
        touch: () => {
          try {
            const t = new Date(now());
            utimesSync(path, t, t);
          } catch {
            /* sem trava para renovar */
          }
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    let holder = NaN;
    let ageMs = Number.POSITIVE_INFINITY;
    try {
      holder = Number(readFileSync(path, 'utf8').trim());
      ageMs = now() - (mtimeOf(path) ?? 0);
    } catch {
      /* sumiu entre as chamadas: tenta de novo */
    }
    if (Number.isInteger(holder) && holder > 0 && holder !== pid && alive(holder) && ageMs < LOCK_STALE_MS) return null;
    rmSync(path, { force: true });
  }
  return null;
}

/** Lê o agent.lock sem tocar nele: o agente roda se o pid está vivo e a trava foi renovada há menos de LOCK_STALE_MS. */
export function agentLockStatus(
  dir: string,
  opts: { alive?: (pid: number) => boolean; now?: () => number } = {},
): { running: boolean; pid: number | null } {
  const path = join(dir, 'agent.lock');
  const alive = opts.alive ?? pidAlive;
  const now = opts.now ?? Date.now;
  try {
    const holder = Number(readFileSync(path, 'utf8').trim());
    const ageMs = now() - (mtimeOf(path) ?? 0);
    if (Number.isInteger(holder) && holder > 0 && alive(holder) && ageMs < LOCK_STALE_MS) {
      return { running: true, pid: holder };
    }
  } catch {
    /* sem trava */
  }
  return { running: false, pid: null };
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const t = setTimeout(done, ms);
    function done(): void {
      signal.removeEventListener('abort', done);
      clearTimeout(t);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

export interface RunOptions {
  once: boolean;
  signal?: AbortSignal;
  /** Ao fim de cada ciclo (testes). */
  onCycle?: (s: CycleSummary) => void;
  intervalMs?: number;
}

/**
 * O laço do agente: acorda a cada 60 s (relógio lido de novo a cada volta) e a cada volta fala com o
 * servidor (heartbeat). Coleta e envio rodam a cada 15 min, ao iniciar, em `--once` e quando o
 * heartbeat traz um pedido de sincronização.
 */
export async function runLoop(deps: AgentDeps, lock: Lock, opts: RunOptions): Promise<void> {
  const mem = newMemory();
  const signal = opts.signal ?? new AbortController().signal;
  const clock = deps.now ?? Date.now;
  if (getState(deps.store) === 'upgrade') deps.store.setMeta('state', 'ok');
  for (;;) {
    const started = clock();
    lock.touch();
    const s = await cycle(deps, mem);
    opts.onCycle?.(s);
    if (opts.once || signal.aborted) return;
    const wait = Math.max(1_000, (opts.intervalMs ?? CYCLE_MS) - (clock() - started));
    await sleepAbortable(wait, signal);
    if (signal.aborted) return;
  }
}
