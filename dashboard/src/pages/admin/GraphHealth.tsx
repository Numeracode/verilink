import type { GraphSummary } from '../../api/provider';

/** Read-only graph health (Plan 9 Decision 5: no path explorer). */
export function GraphHealth({ summary }: { summary: GraphSummary | undefined }) {
  if (!summary) return <p className="muted">Loading graph health...</p>;
  return (
    <dl className="kv">
      <div>
        <dt>Principals</dt>
        <dd>{summary.principals.total}</dd>
      </div>
      <div>
        <dt>Agents</dt>
        <dd>{summary.principals.agents}</dd>
      </div>
      <div>
        <dt>Issuers</dt>
        <dd>{summary.principals.issuers}</dd>
      </div>
      <div>
        <dt>Attestations</dt>
        <dd>{summary.attestations.total}</dd>
      </div>
      <div>
        <dt>Latest score write</dt>
        <dd>{summary.latest_score_computed_at ? new Date(summary.latest_score_computed_at).toLocaleString() : 'never'}</dd>
      </div>
    </dl>
  );
}
