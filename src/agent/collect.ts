import { stat } from 'node:fs/promises';
import type { LogParser, ParserEnv, PayloadRow, ResolvedEvent } from '../types.js';
import type { Store } from '../store/db.js';
import type { GitInfo } from '../task/git.js';
import { resolveEvent, resolveTask } from '../task/resolve.js';
import type { CompiledPattern } from '../task/patterns.js';
import { currentPatterns } from '../task/server-patterns.js';
import { assertRowsSafe, buildRow, guardRows } from '../payload.js';
import { nullLogger, type Logger } from '../log.js';

export interface CollectOptions {
  log?: Logger;
  patterns?: CompiledPattern[];
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
        const st = await stat(file);
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
    const activeTask = store.getLocalActiveTask();
    const salt = store.getOrCreateSalt();
    const safe: PayloadRow[] = [];
    for (const bucket of store.bucketsSince(hourStart, timezone)) {
      const { taskRef, attributionMethod } = resolveTask(bucket, { activeTask, patterns });
      const row = buildRow(bucket, { salt, taskRef, attributionMethod });
      const problems = guardRows([row]);
      if (problems.length > 0) {
        log.warn(`linha ${row.key} descartada pela lista de permissão`);
        continue;
      }
      safe.push(row);
    }
    assertRowsSafe(safe);
    store.enqueue(safe);
    res.rows = safe.length;
  }
  return res;
}

function errName(e: unknown): string {
  return e instanceof Error ? e.name : 'erro';
}
