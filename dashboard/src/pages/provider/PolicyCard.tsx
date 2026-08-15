import type { Policy } from '../../api/provider';
import { EmptyState } from '../../components/EmptyState';

export function PolicyCard({ policy }: { policy: Policy | null }) {
  if (!policy) {
    return (
      <EmptyState
        icon="policy"
        title="No active policy set"
        description="An active policy defines the trust score threshold, below-threshold action, and unsigned request handling. Set one to start enforcing trust decisions at the edge."
        action={{
          label: 'Set active policy',
          href: 'https://github.com/Numeracode/verilink#policies',
        }}
        hint="The policy is per-tenant and synced to all edge nodes via SSE."
      />
    );
  }
  return (
    <dl className="kv">
      <div>
        <dt>Name</dt>
        <dd>{policy.name}</dd>
      </div>
      <div>
        <dt>Threshold</dt>
        <dd>{policy.threshold}</dd>
      </div>
      <div>
        <dt>Below threshold</dt>
        <dd>{policy.below_threshold_action}</dd>
      </div>
      <div>
        <dt>Unsigned requests</dt>
        <dd>{policy.unsigned_action}</dd>
      </div>
      <div>
        <dt>Allow sample rate</dt>
        <dd>{policy.allow_sample_rate}</dd>
      </div>
      <div>
        <dt>Max snapshot age</dt>
        <dd>{policy.max_snapshot_age_seconds}s</dd>
      </div>
    </dl>
  );
}
