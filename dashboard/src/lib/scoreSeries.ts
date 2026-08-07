import type { ScoreHistoryPoint } from '../api/agentBuilder';

export interface ScoreSeriesPoint {
  t: string;
  label: string;
  score: number;
  blacklisted: boolean;
}

/** Chronological score-history series for the line chart (oldest first). */
export function scoreSeries(items: ScoreHistoryPoint[]): ScoreSeriesPoint[] {
  return [...items]
    .sort((a, b) => Date.parse(a.computed_at) - Date.parse(b.computed_at))
    .map((p) => ({
      t: p.computed_at,
      label: new Date(p.computed_at).toLocaleString(),
      score: p.score,
      blacklisted: p.blacklisted,
    }));
}
