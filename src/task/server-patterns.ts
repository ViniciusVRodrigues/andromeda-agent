import type { AgentApi, WorkItemPatternsResponse } from '../types.js';
import type { Store } from '../store/db.js';
import { nullLogger, type Logger } from '../log.js';
import { compileServerPatterns, DEFAULT_PATTERNS, type CompiledPattern } from './patterns.js';

export const PATTERNS_META = 'work_item_patterns';
export const PATTERNS_TTL_MS = 3_600_000;

export interface StoredPatterns {
  fetchedAt: number;
  response: WorkItemPatternsResponse;
}

/** Última resposta guardada no meta, mesmo vencida; null se nunca houve ou está ilegível. */
export function loadStoredPatterns(store: Store): StoredPatterns | null {
  const raw = store.getMeta(PATTERNS_META);
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as Partial<StoredPatterns>;
    if (typeof j.fetchedAt !== 'number' || !j.response || typeof j.response.enabled !== 'boolean') return null;
    return { fetchedAt: j.fetchedAt, response: j.response };
  } catch {
    return null;
  }
}

/** Padrões para o match local: o guardado, ou o default do servidor se nunca houve resposta. */
export function currentPatterns(store: Store): CompiledPattern[] {
  return compileServerPatterns(loadStoredPatterns(store)?.response ?? DEFAULT_PATTERNS);
}

/**
 * Busca de novo se passou mais de 1 hora (ou nunca buscou). Erro de rede, 404
 * ou 403 só viram aviso no log e o guardado continua valendo.
 */
export async function refreshPatterns(
  store: Store,
  api: Pick<AgentApi, 'workItemPatterns'>,
  nowMs: number,
  log: Logger = nullLogger,
): Promise<boolean> {
  const cur = loadStoredPatterns(store);
  if (cur && nowMs - cur.fetchedAt <= PATTERNS_TTL_MS && nowMs >= cur.fetchedAt) return false;
  try {
    const response = await api.workItemPatterns();
    store.setMeta(PATTERNS_META, JSON.stringify({ fetchedAt: nowMs, response } satisfies StoredPatterns));
    return true;
  } catch (e) {
    const status = (e as { status?: number }).status;
    log.warn(`padrões de branch: não atualizou (${e instanceof Error ? e.name : 'erro'}${status ? ` ${status}` : ''}); vale o guardado`);
    return false;
  }
}
