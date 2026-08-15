import type { GraphSummary } from '../../api/provider';
import { EmptyState } from '../../components/EmptyState';

export function GraphHealth({ summary }: { summary: GraphSummary | undefined }) {
  if (!summary) return <p className="muted">Loading graph health...</p>;

  if (summary.principals.total === 0) {
    return (
      <EmptyState
        icon="graph"
        title="Trust graph is empty"
        description="The graph will populate once principals (agents and issuers) are registered and attestations start flowing. Run the bootstrap seed to initialize the root-of-trust registry."
        action={{
          label: 'Open bootstrap runbook',
          href: 'https://github.com/Numeracode/verilink/blob/main/docs/superpowers/plans/2026-08-11-plan-10-bootstrap-cold-start.md',
        }}
        hint="The seed creates the VeriLink bootstrap issuer and initial attestations for a non-empty cold-start graph."
      />
    );
  }

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
