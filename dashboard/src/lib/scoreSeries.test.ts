import { describe, it, expect } from 'vitest';
import { scoreSeries } from './scoreSeries';
import type { ScoreHistoryPoint } from '../api/agentBuilder';

describe('scoreSeries', () => {
  const items: ScoreHistoryPoint[] = [
    { score: 80, blacklisted: false, score_reason: 'propagated', computed_at: '2026-08-07T02:00:00Z', sync_version: '3' },
    { score: 70, blacklisted: false, score_reason: 'propagated', computed_at: '2026-08-07T01:00:00Z', sync_version: '2' },
    { score: 0, blacklisted: true, score_reason: 'blacklisted', computed_at: '2026-08-07T03:00:00Z', sync_version: '4' },
  ];

  it('sorts oldest-first', () => {
    const series = scoreSeries(items);
    expect(series[0].score).toBe(70);
    expect(series[2].score).toBe(0);
  });

  it('preserves blacklisted flags', () => {
    const series = scoreSeries(items);
    expect(series[2].blacklisted).toBe(true);
    expect(series[0].blacklisted).toBe(false);
  });

  it('returns an empty series for no history', () => {
    expect(scoreSeries([])).toEqual([]);
  });
});
