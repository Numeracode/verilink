import type { OwnedPrincipal } from '../../api/agentBuilder';

export interface PrincipalListProps {
  principals: OwnedPrincipal[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function PrincipalList({ principals, selectedId, onSelect }: PrincipalListProps) {
  if (principals.length === 0) {
    return <p className="muted">No owned principals yet. Create one to start building.</p>;
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
              {' · '}
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
