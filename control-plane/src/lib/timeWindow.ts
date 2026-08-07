// control-plane/src/lib/timeWindow.ts
import { AppError, CODES } from '../shared/errors/AppError.js';

export const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
export const MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1000; // 31d

function parseOptional(raw: unknown): Date | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const d = new Date(String(raw));
  if (Number.isNaN(d.getTime())) {
    throw new AppError(CODES.BAD_REQUEST, 'from/to must be valid ISO 8601 timestamps');
  }
  return d;
}

/**
 * Bounded [from, to] query window for the decision read APIs.
 * Plan 9 risk note: default last 24h, max 31d.
 */
export function resolveTimeWindow(fromRaw: unknown, toRaw: unknown): { from: Date; to: Date } {
  const to = parseOptional(toRaw) ?? new Date();
  const from = parseOptional(fromRaw) ?? new Date(to.getTime() - DEFAULT_WINDOW_MS);
  if (from.getTime() > to.getTime()) {
    throw new AppError(CODES.BAD_REQUEST, 'from must be before or equal to to');
  }
  if (to.getTime() - from.getTime() > MAX_WINDOW_MS) {
    throw new AppError(CODES.BAD_REQUEST, 'from/to range exceeds the 31 day maximum');
  }
  return { from, to };
}
