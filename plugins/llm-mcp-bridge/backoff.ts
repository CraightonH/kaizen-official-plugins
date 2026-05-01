export const MAX_BACKOFF_MS = 60_000;
export const RETRY_BUDGET = 5;

export function computeBackoffMs(attempt: number): number {
  if (attempt < 1) return 0;
  // 1s, 2s, 4s, 8s, 16s, ...; attempts beyond the budget cap at MAX.
  if (attempt > RETRY_BUDGET) return MAX_BACKOFF_MS;
  const exp = Math.pow(2, attempt - 1) * 1000;
  return Math.min(exp, MAX_BACKOFF_MS);
}
