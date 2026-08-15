import type { TenantRow } from '../../api/admin';
import { EmptyState } from '../../components/EmptyState';

export function TenantList({ tenants }: { tenants: TenantRow[] }) {
  if (tenants.length === 0) {
    return (
      <EmptyState
        icon="tenants"
        title="No tenants visible"
        description="Tenants appear here once they are created. Your API key may be scoped to a single tenant; switch to a platform-staff key to see all tenants."
        hint="Tenants are the top-level isolation boundary for principals, policies, and edge nodes."
      />
    );
  }
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Slug</th>
          <th>Plan</th>
          <th>Status</th>
          <th>Created</th>
        </tr>
      </thead>
      <tbody>
        {tenants.map((t) => (
          <tr key={t.id}>
            <td>{t.name}</td>
            <td><code>{t.slug}</code></td>
            <td><span className="badge badge--allow">{t.plan}</span></td>
            <td>{t.status}</td>
            <td>{new Date(t.created_at).toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
