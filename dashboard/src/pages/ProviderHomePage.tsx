import { AppShell } from '../layouts/AppShell';

export function ProviderHomePage() {
  return (
    <AppShell title="Provider">
      <section className="panel">
        <h2>Trust summary</h2>
        <p className="muted">
          Aggregated allow/deny/passthrough charts and sampled decision feed land in Plan 9 PR B.
        </p>
      </section>
    </AppShell>
  );
}
