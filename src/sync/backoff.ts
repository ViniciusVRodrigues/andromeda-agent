/** Backoff exponencial com full jitter: base 5 s, teto 10 min. */
export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_CAP_MS = 10 * 60_000;

/**
 * Atraso em ms antes da próxima tentativa. `attempts` é o número de tentativas
 * já feitas (>= 1 depois da primeira falha). Se o servidor mandou `Retry-After`
 * (segundos), ele vence.
 */
export function nextDelay(
  attempts: number,
  rand: () => number = Math.random,
  retryAfterSeconds?: number | null,
): number {
  if (retryAfterSeconds !== undefined && retryAfterSeconds !== null && retryAfterSeconds >= 0) {
    return Math.floor(retryAfterSeconds * 1000);
  }
  const exp = Math.max(0, Math.min(attempts, 30) - 1);
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** exp);
  return Math.floor(rand() * ceiling);
}
