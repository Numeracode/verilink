import type { PrincipalKey } from '../../api/agentBuilder';

export function KeyList({ keys }: { keys: PrincipalKey[] }) {
  if (keys.length === 0) {
    return <p className="muted">No keys registered for this principal.</p>;
  }
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Key id</th>
          <th>Hash</th>
          <th>Assurance</th>
          <th>Valid from</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {keys.map((k) => {
          const revoked = k.revoked_at !== null;
          const verified = k.control_verified_at !== null;
          return (
            <tr key={k.key_id}>
              <td><code>{k.key_id}</code></td>
              <td><code>{k.key_hash.slice(0, 12)}...</code></td>
              <td>
                {revoked ? (
                  <span className="badge badge--deny">revoked</span>
                ) : verified ? (
                  <span className="badge badge--allow">verified</span>
                ) : (
                  <span className="badge badge--passthrough">control unverified</span>
                )}
              </td>
              <td>{new Date(k.valid_from).toLocaleString()}</td>
              <td>{revoked ? 'revoked' : k.valid_until ? 'expiring' : 'active'}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
