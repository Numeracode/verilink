import { AppShell } from '../layouts/AppShell';

export function AgentBuilderHomePage() {
  return (
    <AppShell title="Agent builder">
      <section className="panel">
        <h2>Principals</h2>
        <p className="muted">Owned principals, keys, and attestation feed land in Plan 9 PR C.</p>
      </section>
    </AppShell>
  );
}
