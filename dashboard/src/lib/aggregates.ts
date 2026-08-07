/** Per-minute decision rollup row from GET /v1/decisions/aggregates. */
export interface AggregateItem {
  bucket_minute: string;
  dimension_kind: string;
  dimension_value: string;
  action: string;
  count: number;
}

export interface BucketPoint {
  bucket: string;
  label: string;
  allow: number;
  deny: number;
  passthrough: number;
}

export function formatBucketLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** Pivot aggregate rows into one stacked-bar point per minute bucket. */
export function pivotAggregates(items: AggregateItem[]): BucketPoint[] {
  const byBucket = new Map<string, BucketPoint>();
  for (const item of items) {
    let point = byBucket.get(item.bucket_minute);
    if (!point) {
      point = {
        bucket: item.bucket_minute,
        label: formatBucketLabel(item.bucket_minute),
        allow: 0,
        deny: 0,
        passthrough: 0,
      };
      byBucket.set(item.bucket_minute, point);
    }
    if (item.action === 'allow' || item.action === 'deny' || item.action === 'passthrough') {
      point[item.action] += item.count;
    }
  }
  return [...byBucket.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));
}
