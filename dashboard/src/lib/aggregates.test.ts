import { describe, it, expect } from 'vitest';
import { pivotAggregates, formatBucketLabel, type AggregateItem } from './aggregates';

function item(bucket: string, action: string, count: number): AggregateItem {
  return {
    bucket_minute: bucket,
    dimension_kind: 'all',
    dimension_value: '',
    action,
    count,
  };
}

describe('pivotAggregates', () => {
  it('pivots rows into one stacked point per bucket', () => {
    const points = pivotAggregates([
      item('2026-08-07T10:00:00Z', 'allow', 5),
      item('2026-08-07T10:00:00Z', 'deny', 2),
      item('2026-08-07T10:01:00Z', 'allow', 1),
      item('2026-08-07T10:01:00Z', 'passthrough', 4),
    ]);
    expect(points).toHaveLength(2);
    expect(points[0].bucket).toBe('2026-08-07T10:00:00Z');
    expect(points[0].allow).toBe(5);
    expect(points[0].deny).toBe(2);
    expect(points[0].passthrough).toBe(0);
    expect(points[1].allow).toBe(1);
    expect(points[1].passthrough).toBe(4);
  });

  it('sorts buckets chronologically regardless of input order', () => {
    const points = pivotAggregates([
      item('2026-08-07T10:02:00Z', 'allow', 1),
      item('2026-08-07T10:01:00Z', 'allow', 1),
    ]);
    expect(points.map((p) => p.bucket)).toEqual([
      '2026-08-07T10:01:00Z',
      '2026-08-07T10:02:00Z',
    ]);
  });

  it('sums duplicate bucket+action rows (multi-edge rollups)', () => {
    const points = pivotAggregates([
      item('2026-08-07T10:00:00Z', 'allow', 3),
      item('2026-08-07T10:00:00Z', 'allow', 4),
    ]);
    expect(points[0].allow).toBe(7);
  });

  it('ignores unknown actions without dropping the bucket', () => {
    const points = pivotAggregates([
      item('2026-08-07T10:00:00Z', 'allow', 1),
      item('2026-08-07T10:00:00Z', 'mystery', 9),
    ]);
    expect(points).toHaveLength(1);
    expect(points[0].allow).toBe(1);
  });

  it('returns an empty series for no rows', () => {
    expect(pivotAggregates([])).toEqual([]);
  });
});

describe('formatBucketLabel', () => {
  it('formats as HH:MM local time', () => {
    expect(formatBucketLabel('2026-08-07T10:05:00Z')).toMatch(/^\d{2}:\d{2}$/);
  });

  it('passes through unparseable input', () => {
    expect(formatBucketLabel('nope')).toBe('nope');
  });
});
