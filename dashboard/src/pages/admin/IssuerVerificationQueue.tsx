import type { UnverifiedIssuer } from '../../api/admin';
import { EmptyState } from '../../components/EmptyState';

export function IssuerVerificationQueue({ issuers }: { issuers: UnverifiedIssuer[] }) {
  if (issuers.length === 0) {
    return (
      <EmptyState
        icon="issuer"
        title="No issuers awaiting verification"
        description="New issuers that have submitted a key-control proof but not yet been staff-verified appear here. The queue is empty when all known issuers are verified."
        hint="Verification is a manual staff action that sets issuers.verified_at."
      />
    );
  }
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Issuer</th>
          <th>Kind</th>
          <th className="num">Trust weight</th>
          <th>Bootstrap</th>
          <th>Created</th>
        </tr>
      </thead>
      <tbody>
        {issuers.map((i) => (
          <tr key={i.principal_id}>
            <td>{i.name ?? <code>{i.principal_id}</code>}</td>
            <td>{i.entity_kind}</td>
            <td className="num">{i.trust_weight}</td>
            <td>{i.is_bootstrap ? <span className="badge badge--allow">yes</span> : 'no'}</td>
            <td>{new Date(i.created_at).toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
