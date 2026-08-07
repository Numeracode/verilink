import type { UnverifiedIssuer } from '../../api/admin';

export function IssuerVerificationQueue({ issuers }: { issuers: UnverifiedIssuer[] }) {
  if (issuers.length === 0) {
    return <p className="muted">No issuers awaiting verification.</p>;
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
