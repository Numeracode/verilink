import type { TenantRow } from '../../api/admin';

export function TenantList({ tenants }: { tenants: TenantRow[] }) {
  if (tenants.length === 0) {
    return <p className="muted">No tenants visible to this account.</p>;
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
