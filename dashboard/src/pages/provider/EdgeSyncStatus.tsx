import type { EdgeNodeRow } from '../../api/provider';
import { EmptyState } from '../../components/EmptyState';

export function EdgeSyncStatus({ edges }: { edges: EdgeNodeRow[] }) {
  if (edges.length === 0) {
    return (
      <EmptyState
        icon="edge"
        title="No edge nodes registered"
        description="Register an edge verifier node to start receiving trust decisions. The edge verifier sits in front of your API and enforces allow/deny based on VeriLink trust scores."
        action={{
          label: 'View setup guide',
          href: 'https://github.com/Numeracode/verilink/blob/main/docs/superpowers/specs/2026-07-25-verilink-productization-design.md',
        }}
        hint="The edge verifier connects to the control plane via SSE sync and enforces your active policy."
      />
    );
  }
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Edge</th>
          <th>Status</th>
          <th className="num">Cursor</th>
          <th className="num">Lag</th>
          <th>Last sync</th>
        </tr>
      </thead>
      <tbody>
        {edges.map((e) => {
          const lag = BigInt(e.lag);
          const lagging = lag > 0n;
          return (
            <tr key={e.id}>
              <td>{e.name}</td>
              <td>
                <span className={`badge ${lagging ? 'badge--passthrough' : 'badge--allow'}`}>
                  {e.status}
                </span>
              </td>
              <td className="num">{e.last_cursor ?? '0'}</td>
              <td className="num">{lagging ? e.lag : '0'}</td>
              <td>{e.last_sync_at ? new Date(e.last_sync_at).toLocaleString() : 'never'}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
