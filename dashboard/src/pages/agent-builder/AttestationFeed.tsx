import type { AttestationRow } from '../../api/agentBuilder';
import { EmptyState } from '../../components/EmptyState';

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
    const isIn = direction === 'in';
    return (
      <EmptyState
        icon="attest"
        title={isIn ? 'No incoming attestations' : 'No outgoing attestations'}
        description={
          isIn
            ? 'Other issuers can attest to this principal\'s behaviour. Incoming attestations appear here once a counterparty submits a signed JWS attestation naming this principal as the subject.'
            : 'Submit a signed attestation about another principal to start building a trust relationship. Use the Go or Node client to sign and submit a JWS token to the control plane.'
        }
        action={
          isIn
            ? undefined
            : {
                label: 'View client docs',
                href: 'https://github.com/Numeracode/verilink/tree/main/client',
              }
        }
        hint={
          isIn
            ? 'Attestations are cryptographically signed JWS tokens with RFC 8785 canonicalized facts.'
            : 'The client signs with your Ed25519 private key; the control plane verifies and stores the attestation.'
        }
      />
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
