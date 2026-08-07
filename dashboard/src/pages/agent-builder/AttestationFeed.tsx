import type { AttestationRow } from '../../api/agentBuilder';

function shortId(id: string): string {
  const parts = id.split(':');
  const tail = parts[parts.length - 1] ?? id;
  return tail.length > 8 ? `...${tail.slice(-8)}` : tail;
}

export function AttestationFeed({
  direction,
  items,
}: {
  direction: 'in' | 'out';
  items: AttestationRow[];
}) {
  if (items.length === 0) {
    return (
      <p className="muted">
        No {direction === 'in' ? 'incoming' : 'outgoing'} attestations visible.
      </p>
    );
  }
  return (
    <table className="table">
      <thead>
        <tr>
          <th>{direction === 'in' ? 'From' : 'To'}</th>
          <th>Type</th>
          <th className="num">Delta</th>
          <th>Visibility</th>
          <th>Issued</th>
        </tr>
      </thead>
      <tbody>
        {items.map((a) => {
          const other = direction === 'in' ? a.issuer_id : a.subject_id;
          return (
            <tr key={a.id}>
              <td><code title={other}>{shortId(other)}</code></td>
              <td>{a.attestation_type}</td>
              <td className="num">{a.trust_delta > 0 ? `+${a.trust_delta}` : a.trust_delta}</td>
              <td>
                <span className={`badge badge--${a.visibility === 'public' ? 'allow' : 'passthrough'}`}>
                  {a.visibility}
                </span>
              </td>
              <td>{new Date(a.issued_at).toLocaleString()}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
