import type { SampleRow } from '../../api/provider';
import { EmptyState } from '../../components/EmptyState';

function shortFingerprint(fp: string): string {
  return fp.length > 12 ? `${fp.slice(0, 12)}...` : fp;
}

export function DecisionFeed({ samples }: { samples: SampleRow[] }) {
  if (samples.length === 0) {
    return (
      <EmptyState
        icon="decisions"
        title="No decisions recorded yet"
        description="The decision feed populates once the edge verifier starts evaluating incoming API requests against your trust policy. All deny decisions are kept; allows are sampled."
        action={{
          label: 'Configure policy',
          href: 'https://github.com/Numeracode/verilink#policies',
        }}
        hint="Decisions are categorized as allow, deny, or passthrough based on your active policy threshold."
      />
    );
  }
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Time</th>
          <th>Fingerprint</th>
          <th>Action</th>
          <th className="num">Score</th>
          <th>Reason</th>
        </tr>
      </thead>
      <tbody>
        {samples.map((s) => (
          <tr key={s.id}>
            <td>{new Date(s.decided_at).toLocaleString()}</td>
            <td>
              <code title={s.fingerprint}>{shortFingerprint(s.fingerprint)}</code>
            </td>
            <td>
              <span className={`badge badge--${s.action}`}>{s.action}</span>
            </td>
            <td className="num">{s.score ?? <span className="muted">-</span>}</td>
            <td>{s.score_reason ?? <span className="muted">-</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
