import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { BucketPoint } from '../../lib/aggregates';

const ACTION_COLORS: Record<string, string> = {
  allow: '#0f6b4c',
  deny: '#9b2c2c',
  passthrough: '#8a7a3f',
};

export function TrustSummaryChart({ points }: { points: BucketPoint[] }) {
  if (points.length === 0) {
    return <p className="muted">No decisions in the last 24 hours.</p>;
  }
  return (
    <div className="chart" aria-label="Decisions per minute by action">
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={points} margin={{ top: 8, right: 16, bottom: 0, left: -16 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#d5d0c6" />
          <XAxis dataKey="label" tick={{ fontSize: 12 }} />
          <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
          <Tooltip />
          <Legend />
          <Bar dataKey="allow" stackId="a" fill={ACTION_COLORS.allow} />
          <Bar dataKey="deny" stackId="a" fill={ACTION_COLORS.deny} />
          <Bar dataKey="passthrough" stackId="a" fill={ACTION_COLORS.passthrough} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
