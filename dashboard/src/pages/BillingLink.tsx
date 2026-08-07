import { useState } from 'react';
import { createPortalSession } from '../api/admin';

/**
 * "Manage billing" link — opens the Stripe customer portal for the caller
 * tenant. Rendered in the provider + agent-builder views (Plan 9 Decision 5).
 */
export function BillingLink() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function open() {
    setBusy(true);
    setMsg(null);
    try {
      const url = await createPortalSession();
      if (url) {
        window.location.assign(url);
      } else {
        setMsg('No subscription yet — upgrade via checkout to manage billing.');
      }
    } catch {
      setMsg('Could not open the billing portal.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="billing-link">
      <button type="button" className="shell__signout" onClick={open} disabled={busy}>
        {busy ? 'Opening...' : 'Manage billing'}
      </button>
      {msg && <span className="muted billing-link__msg">{msg}</span>}
    </div>
  );
}
