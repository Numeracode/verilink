import type { OwnedPrincipal } from '../../api/agentBuilder';
import { EmptyState } from '../../components/EmptyState';

export interface PrincipalListProps {
  principals: OwnedPrincipal[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function PrincipalList({ principals, selectedId, onSelect }: PrincipalListProps) {
  if (principals.length === 0) {
    return (
      <EmptyState
        icon="keys"
        title="No owned principals yet"
        description="Principals are the identity layer for agents and issuers. Create one by submitting an attestation with a new vrl:p:<uuid> subject, or use the keygen tool to generate a keypair."
        action={{
          label: 'Generate keypair',
          href: 'https://github.com/Numeracode/verilink#keygen',
        }}
        hint="Each principal has an Ed25519 keypair. The private key stays with you; the public key is registered with VeriLink."
      />
    );
  }
  return (
    <ul className="select-list">
      {principals.map((p) => (
        <li key={p.id}>
          <button
            type="button"
            className={p.id === selectedId ? 'select-list__item is-selected' : 'select-list__item'}
            onClick={() => onSelect(p.id)}
          >
            <span className="select-list__title">{p.name ?? p.id}</span>
            <span className="select-list__meta">
              {p.entity_kind}
              {' \u00B7 '}
              {p.assurance_level === 'verified_key' ? (
                <span className="badge badge--allow">verified key</span>
              ) : (
                <span className="badge badge--passthrough">unverified</span>
              )}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
