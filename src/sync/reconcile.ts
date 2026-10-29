import { createHash } from 'node:crypto';
import type { AgentApi } from '../types.js';
import type { Store } from '../store/db.js';

export function keysDigest(sortedKeys: string[]): string {
  return createHash('sha256').update(sortedKeys.join('\n'), 'utf8').digest('hex');
}

/** Compara o resumo do servidor com as chaves `sent` locais; re-enfileira o que o servidor perdeu. */
export async function reconcile(
  store: Store,
  api: AgentApi,
  opts: { days: string[]; now?: number },
): Promise<string[]> {
  const days = [...new Set(opts.days)].sort();
  if (days.length === 0) return [];
  const server = await api.reconcile(days[0]!, days[days.length - 1]!);
  const byDay = new Map(server.map((d) => [d.day, d]));
  const diverged: string[] = [];
  for (const day of days) {
    const local = store.localDay(day);
    const remote = byDay.get(day);
    const remoteDigest = remote?.keysDigest ?? keysDigest([]);
    if (keysDigest(local.keys) === remoteDigest) continue;
    diverged.push(day);
    const have = new Set(await api.usageKeys(day));
    const lost = local.keys.filter((k) => !have.has(k));
    if (lost.length > 0) store.requeue(lost, opts.now ?? Date.now());
  }
  return diverged;
}
