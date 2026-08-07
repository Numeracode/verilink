import { describe, it, expect } from 'vitest';
import { isScoreStale, SCORE_STALENESS_THRESHOLD_MS } from './staleness';

describe('isScoreStale', () => {
  const now = Date.parse('2026-08-07T12:00:00Z');

  it('is fresh when the last score write is within the threshold', () => {
    const recent = new Date(now - 30 * 60 * 1000).toISOString(); // 30min ago
    expect(isScoreStale(recent, now)).toBe(false);
  });

  it('is stale when the last score write is older than 1h', () => {
    const old = new Date(now - SCORE_STALENESS_THRESHOLD_MS - 1000).toISOString();
    expect(isScoreStale(old, now)).toBe(true);
  });

  it('is not stale exactly at the threshold boundary', () => {
    const edge = new Date(now - SCORE_STALENESS_THRESHOLD_MS).toISOString();
    expect(isScoreStale(edge, now)).toBe(false);
  });

  it('is stale when no score has ever been written', () => {
    expect(isScoreStale(null, now)).toBe(true);
    expect(isScoreStale(undefined, now)).toBe(true);
  });

  it('is stale on unparseable input', () => {
    expect(isScoreStale('not-a-date', now)).toBe(true);
  });
});
