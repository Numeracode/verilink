import { AppShell } from '../layouts/AppShell';

export function AdminHomePage() {
  return (
    <AppShell title="Admin">
      <section className="panel">
        <h2>Platform</h2>
        <p className="muted">
          Tenant list, graph health, and bootstrap registry land in Plan 9 PR D (staff only).
        </p>
      </section>
    </AppShell>
  );
}
