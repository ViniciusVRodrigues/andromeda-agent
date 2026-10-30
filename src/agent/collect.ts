import { stat } from 'node:fs/promises';
import type { LogParser, ParserEnv, PayloadRow, ResolvedEvent } from '../types.js';
import type { Store } from '../store/db.js';
import type { GitInfo } from '../task/git.js';
import { resolveEvent, resolveTask } from '../task/resolve.js';
import type { CompiledPattern } from '../task/patterns.js';
import { currentPatterns } from '../task/server-patterns.js';
import { assertRowsSafe, buildRow, guardRows } from '../payload.js';
import { nullLogger, type Logger } from '../log.js';
import { localDayOf } from '../store/db.js';
import { enforceExpiry, setTaskConflict } from '../task/task-state.js';
import type { TaskConflict } from '../types.js';

export interface CollectOptions {
  log?: Logger;
  patterns?: CompiledPattern[];
  now?: () => number;
}

export interface CollectResult {
  /** Arquivos de log encontrados. */
  files: number;
  /** Arquivos que tinham algo novo para ler. */
  read: number;
  /** Eventos lidos nesta coleta (antes do dedupe do store). */
  events: number;
  /** Linhas montadas e enfileiradas. */
  rows: number;
  /** Arquivos que falharam (os outros seguem). */
  errors: number;
}

/**
 * Lê só o que cresceu nos logs das IAs, guarda os eventos e enfileira as linhas
 * dos buckets afetados. Erro num arquivo não para os outros e o log local não
 * guarda conteúdo, só o caminho do arquivo e o tipo do erro.
 */
export async function collect(
  store: Store,
  parsers: LogParser[],
  git: GitInfo,
  env: ParserEnv,
  timezone: string,
  opts: CollectOptions = {},
): Promise<CollectResult> {
  const log = opts.log ?? nullLogger;
  const res: CollectResult = { files: 0, read: 0, events: 0, rows: 0, errors: 0 };
  let oldest: number | null = null;

  for (const parser of parsers) {
    let files: string[];
    try {
      files = await parser.discover(env);
    } catch (e) {
      res.errors++;
      log.warn(`${parser.tool}: falha ao listar logs (${errName(e)})`);
      continue;
    }
    res.files += files.length;
    for (const file of files) {
      try {
        const st = await statWithWal(file);
        const cur = store.getCursor(file);
        const zst = file.endsWith('.zst');
        // `.zst` guarda offset descomprimido, então só o tamanho do arquivo diz se ele encolheu.
        const shrunk = cur !== null && (st.size < cur.size || (!zst && st.size < cur.offset));
        if (cur && !shrunk && st.size === cur.size && Math.trunc(st.mtimeMs) === cur.mtimeMs) continue;
        const offset = cur && !shrunk ? cur.offset : 0;
        const state = cur && !shrunk ? (cur.state ?? undefined) : undefined;
        const parsed = await parser.parse(file, offset, state);
        const resolved: ResolvedEvent[] = [];
        for (const ev of parsed.events) resolved.push(await resolveEvent(ev, git));
        store.commitParse(
          file,
          { offset: parsed.nextOffset, size: st.size, mtimeMs: Math.trunc(st.mtimeMs), state: parsed.state ?? null },
          resolved,
        );
        res.read++;
        res.events += resolved.length;
        for (const ev of resolved) if (oldest === null || ev.timestamp < oldest) oldest = ev.timestamp;
      } catch (e) {
        res.errors++;
        log.warn(`${parser.tool}: falha ao ler ${file} (${errName(e)})`);
      }
    }
  }

  if (oldest !== null) {
    const hourStart = Math.floor(oldest / 3_600_000) * 3_600_000;
    const patterns = opts.patterns ?? currentPatterns(store);
    const clock = opts.now ?? Date.now;
    const nowMs = clock();
    const today = localDayOf(nowMs, timezone);
    const salt = store.getOrCreateSalt();
    const safe: PayloadRow[] = [];
    const buckets = store.bucketsSince(hourStart, timezone);
    // A tarefa marcada expira antes de atribuir: virada do dia, outra branch ou outro repo.
    const start = store.getLocalActiveTask();
    const repos = start ? buckets.filter((b) => b.hourStart >= start.since).map((b) => b.repo) : [];
    await enforceExpiry(store, git, nowMs, timezone, repos);
    const stillActive = store.getLocalActiveTask() !== null;
    // Os buckets são conferidos um a um (hora, dia, repo, branch), então mesmo a tarefa que acabou de
    // expirar atribui o que ainda era dela (uso coletado com atraso).
    const activeTask = start;
    let conflict: TaskConflict | null = null;
    let sawToday = false;
    for (const bucket of buckets) {
      const r = resolveTask(bucket, { activeTask, patterns, timezone });
      if (bucket.day === today) sawToday = true;
      if (r.conflict && bucket.day === today) {
        conflict = { ...r.conflict, repo: bucket.repo, at: new Date(nowMs).toISOString() };
      }
      const row = buildRow(bucket, { salt, taskRef: r.taskRef, attributionMethod: r.attributionMethod });
      const problems = guardRows([row]);
      if (problems.length > 0) {
        log.warn(`linha ${row.key} descartada pela lista de permissão`);
        continue;
      }
      safe.push(row);
    }
    // O último conflito de hoje fica; coleta de hoje sem conflito limpa; conflito de outro dia some.
    if (conflict && stillActive) setTaskConflict(store, conflict);
    else if (sawToday || !stillActive) setTaskConflict(store, null);
    assertRowsSafe(safe);
    store.enqueue(safe);
    res.rows = safe.length;
  }
  return res;
}

/** Bases SQLite gravam no `-wal`: o `.db` pode nao mudar, entao tamanho e mtime somam o `-wal` quando existe. */
async function statWithWal(file: string): Promise<{ size: number; mtimeMs: number }> {
  const st = await stat(file);
  if (!file.endsWith('.db')) return st;
  try {
    const w = await stat(`${file}-wal`);
    return { size: st.size + w.size, mtimeMs: Math.max(st.mtimeMs, w.mtimeMs) };
  } catch {
    return st;
  }
}

function errName(e: unknown): string {
  return e instanceof Error ? e.name : 'erro';
}
