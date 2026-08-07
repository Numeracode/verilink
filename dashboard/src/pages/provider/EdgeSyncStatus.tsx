import type { EdgeNodeRow } from '../../api/provider';

export function EdgeSyncStatus({ edges }: { edges: EdgeNodeRow[] }) {
  if (edges.length === 0) {
    return <p className="muted">No edge nodes registered for this tenant yet.</p>;
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
