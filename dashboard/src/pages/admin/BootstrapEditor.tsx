import { useState } from 'react';
import type { BootstrapIssuer } from '../../api/admin';

export interface BootstrapEditorProps {
  issuers: BootstrapIssuer[];
  onUpdate: (principalId: string, patch: { current_weight?: number; de_emphasis_reason?: string | null }) => Promise<void>;
}

const STEPS = [1.0, 0.5, 0.25, 0];

export function BootstrapEditor({ issuers, onUpdate }: BootstrapEditorProps) {
  if (issuers.length === 0) {
    return <p className="muted">No bootstrap issuers registered.</p>;
  }
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Issuer</th>
          <th className="num">Weight (Root)</th>
          <th>De-emphasis reason</th>
          <th>Verified</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {issuers.map((i) => (
          <BootstrapRow key={i.principal_id} issuer={i} onUpdate={onUpdate} />
        ))}
      </tbody>
    </table>
  );
}

function BootstrapRow({
  issuer,
  onUpdate,
}: {
  issuer: BootstrapIssuer;
  onUpdate: BootstrapEditorProps['onUpdate'];
}) {
  const [reason, setReason] = useState(issuer.de_emphasis_reason ?? '');
  const [busy, setBusy] = useState(false);

  async function apply(weight: number) {
    setBusy(true);
    try {
      await onUpdate(issuer.principal_id, { current_weight: weight, de_emphasis_reason: reason || null });
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr>
      <td>
        <div>{issuer.name}</div>
        <code className="muted">{issuer.principal_id}</code>
      </td>
      <td className="num">{issuer.current_weight}</td>
      <td>
        <input
          type="text"
          value={reason}
          placeholder="e.g. organic volume"
          onChange={(e) => setReason(e.target.value)}
          aria-label="De-emphasis reason"
        />
      </td>
      <td>{issuer.verified_at ? new Date(issuer.verified_at).toLocaleString() : <span className="badge badge--passthrough">unverified</span>}</td>
      <td>
        {STEPS.map((w) => (
          <button
            key={w}
            type="button"
            className="shell__signout step-btn"
            disabled={busy || w === issuer.current_weight}
            onClick={() => apply(w)}
          >
            {w}
          </button>
        ))}
      </td>
    </tr>
  );
}
