import type { Policy } from '../../api/provider';

/** Read-only active policy summary. Editing lands in Plan 9 PR C. */
export function PolicyCard({ policy }: { policy: Policy | null }) {
  if (!policy) {
    return <p className="muted">No active policy for this tenant.</p>;
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
