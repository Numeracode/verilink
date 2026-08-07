import type { AgentRow } from '../../api/provider';

function shortId(id: string): string {
  // vrl:p:<uuid> -> trailing 8 chars keeps tables readable
  const parts = id.split(':');
  const tail = parts[parts.length - 1] ?? id;
  return tail.length > 8 ? `...${tail.slice(-8)}` : tail;
}

export function AgentList({ agents }: { agents: AgentRow[] }) {
  if (agents.length === 0) {
    return <p className="muted">No agents observed in the last 24 hours.</p>;
  }
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Agent</th>
          <th>Name</th>
          <th className="num">Decisions</th>
          <th className="num">Score</th>
          <th>Status</th>
          <th>Last decision</th>
        </tr>
      </thead>
      <tbody>
        {agents.map((a) => (
          <tr key={a.principal_id}>
            <td>
              <code title={a.principal_id}>{shortId(a.principal_id)}</code>
            </td>
            <td>{a.name ?? <span className="muted">-</span>}</td>
            <td className="num">{a.decisions}</td>
            <td className="num">{a.score ?? <span className="muted">-</span>}</td>
            <td>
              {/* blacklisted comes from network_scores only - never inferred from score */}
              {a.blacklisted ? (
                <span className="badge badge--deny">blacklisted</span>
              ) : a.score === null ? (
                <span className="muted">unscored</span>
              ) : (
                <span className="badge badge--allow">{a.score_reason ?? 'scored'}</span>
              )}
            </td>
            <td>{new Date(a.last_decided_at).toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
