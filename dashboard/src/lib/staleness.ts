/**
 * Plan 9 Decision 8: if the latest successful score write is older than 1h,
 * provider + agent-builder views show a non-blocking staleness banner.
 */
export const SCORE_STALENESS_THRESHOLD_MS = 60 * 60 * 1000; // 1h

export function isScoreStale(
  latestComputedAt: string | null | undefined,
  nowMs: number = Date.now()
): boolean {
  if (!latestComputedAt) return true; // no scores ever written → treat as stale
  const t = Date.parse(latestComputedAt);
  if (Number.isNaN(t)) return true;
  return nowMs - t > SCORE_STALENESS_THRESHOLD_MS;
}
