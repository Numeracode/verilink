import type { PrincipalDetail } from '../../api/agentBuilder';

/** Read-only issuer relationship for a principal that is (also) an issuer. */
export function IssuerCard({ issuer }: { issuer: PrincipalDetail['issuer'] }) {
  if (!issuer) {
    return <p className="muted">This principal is not an issuer.</p>;
  }
  return (
    <dl className="kv">
      <div>
        <dt>Trust weight</dt>
        <dd>{issuer.trust_weight}</dd>
      </div>
      <div>
        <dt>Verified</dt>
        <dd>{issuer.verified_at ? new Date(issuer.verified_at).toLocaleString() : 'not verified'}</dd>
      </div>
      <div>
        <dt>Bootstrap root</dt>
        <dd>{issuer.is_bootstrap ? 'yes' : 'no'}</dd>
      </div>
    </dl>
  );
}
