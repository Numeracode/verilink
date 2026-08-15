import type { DeEmphasisResult, DeEmphasisCandidate } from '../../api/admin';

export interface DeEmphasisPanelProps {
  data: DeEmphasisResult;
}

export function DeEmphasisPanel({ data }: DeEmphasisPanelProps) {
  const { contribution, candidates, generated_at } = data;

  return (
    <div>
      <div className="de-emphasis-overview">
        <div className="stat-grid">
          <StatCard
            label="Organic contribution"
            value={contribution.organic_pct + '%'}
            highlight={contribution.organic_pct >= 80}
          />
          <StatCard
            label="Independent organic issuers"
            value={String(contribution.independent_organic_issuers)}
            highlight={contribution.independent_organic_issuers >= 3}
          />
          <StatCard
            label="Window"
            value={contribution.window_continuous
              ? contribution.window_days + ' days (continuous)'
              : 'NOT continuous'}
            highlight={contribution.window_continuous}
          />
          <StatCard
            label="Bootstrap weighted"
            value={String(contribution.bootstrap_weighted)}
          />
        </div>
        <p className="muted">Generated: {new Date(generated_at).toLocaleString()}</p>
      </div>

      <h3>Candidates</h3>
      {candidates.length === 0 && <p className="muted">No active bootstrap issuers.</p>}
      {candidates.map((c) => (
        <CandidateCard key={c.principal_id} candidate={c} />
      ))}
    </div>
  );
}

function StatCard({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className={'stat-card' + (highlight ? ' stat-card--ok' : '')}>
      <div className="stat-card__value">{value}</div>
      <div className="stat-card__label">{label}</div>
    </div>
  );
}

function CandidateCard({ candidate }: { candidate: DeEmphasisCandidate }) {
  const { ready, not_ready_reasons, counterfactual } = candidate;

  return (
    <div className={'candidate-card' + (ready ? ' candidate-card--ready' : '')}>
      <div className="candidate-card__header">
        <div>
          <strong>{candidate.name}</strong>
          <code className="muted"> {candidate.principal_id}</code>
        </div>
        <div>
          <span className={'badge ' + (ready ? 'badge--allow' : 'badge--deny')}>
            {ready ? 'READY' : 'NOT READY'}
          </span>
          <span className="muted"> Weight: {candidate.current_weight}</span>
        </div>
      </div>

      {!ready && not_ready_reasons.length > 0 && (
        <ul className="candidate-card__reasons">
          {not_ready_reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}

      {counterfactual && (
        <div className="candidate-card__counterfactual">
          <h4>Counterfactual removal report (target weight: {counterfactual.target_weight})</h4>
          <p className="muted">
            Graph version: {counterfactual.graph_version} |
            Worst-case drop: {counterfactual.worst_case_drop} points
          </p>
          {counterfactual.drops.filter((d) => d.drops_below_threshold).length > 0 && (
            <div className="panel__error">
              {counterfactual.drops.filter((d) => d.drops_below_threshold).length} principal(s) would drop below their serving tenant threshold:
              <ul>
                {counterfactual.drops
                  .filter((d) => d.drops_below_threshold)
                  .map((d) => (
                    <li key={d.principal_id}>
                      <code>{d.principal_id}</code>: {d.current_score} {"->"} {d.counterfactual_score} (threshold: {d.tenant_threshold})
                    </li>
                  ))}
              </ul>
            </div>
          )}
          {counterfactual.drops.filter((d) => d.drops_below_threshold).length === 0 && (
            <p className="muted">No principals would drop below threshold.</p>
          )}
        </div>
      )}
    </div>
  );
}
