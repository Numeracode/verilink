import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { ScoreSeriesPoint } from '../../lib/scoreSeries';
import { EmptyState } from '../../components/EmptyState';

export function ScoreHistoryChart({ points }: { points: ScoreSeriesPoint[] }) {
  if (points.length === 0) {
    return (
      <EmptyState
        icon="score"
        title="No score history yet"
        description="This principal\'s network score will appear here once the trust engine computes a score. Scores are recomputed periodically (hourly) and on every new attestation."
        hint="The score is derived from the transitive trust graph using the VeriRank algorithm with time decay and distance decay."
      />
    );
  }
  return (
    <div className="chart" aria-label="Network score history">
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={points} margin={{ top: 8, right: 16, bottom: 0, left: -16 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#d5d0c6" />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} />
          <YAxis domain={[0, 100]} allowDecimals={false} tick={{ fontSize: 12 }} />
          <Tooltip />
          <Line
            type="monotone"
            dataKey="score"
            stroke="#0f6b4c"
            strokeWidth={2}
            dot={{ r: 3 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
