import { useQuery } from '@tanstack/react-query';
import { AppShell } from '../layouts/AppShell';
import { useAuth } from '../auth/AuthProvider';
import { providerQueryKeys } from '../lib/queryKeys';
import {
  fetchActivePolicy,
  fetchAgents,
  fetchAggregates,
  fetchEdgeNodes,
  fetchGraphSummary,
  fetchSamples,
} from '../api/provider';
import { pivotAggregates } from '../lib/aggregates';
import { isScoreStale } from '../lib/staleness';
import { StalenessBanner } from './provider/StalenessBanner';
import { TrustSummaryChart } from './provider/TrustSummaryChart';
import { AgentList } from './provider/AgentList';
import { DecisionFeed } from './provider/DecisionFeed';
import { EdgeSyncStatus } from './provider/EdgeSyncStatus';
import { PolicyCard } from './provider/PolicyCard';
import { BillingLink } from './BillingLink';

function PanelState({
  isLoading,
  isError,
  error,
}: {
  isLoading: boolean;
  isError: boolean;
  error: unknown;
}) {
  if (isLoading) return <p className="muted">Loading...</p>;
  if (isError) {
    return (
      <p className="panel__error">
        Failed to load: {error instanceof Error ? error.message : 'unknown error'}
      </p>
    );
  }
  return null;
}

export function ProviderHomePage() {
  const auth = useAuth();
  const keys = providerQueryKeys(auth.tenantId);
  const summaryQuery = useQuery({ queryKey: keys.graphSummary, queryFn: fetchGraphSummary });
  const aggregatesQuery = useQuery({
    queryKey: keys.aggregates,
    queryFn: () => fetchAggregates('all'),
  });
  const agentsQuery = useQuery({ queryKey: keys.agents, queryFn: () => fetchAgents() });
  const samplesQuery = useQuery({ queryKey: keys.samples, queryFn: () => fetchSamples() });
  const edgesQuery = useQuery({ queryKey: keys.edgeNodes, queryFn: fetchEdgeNodes });
  const policyQuery = useQuery({ queryKey: keys.policyActive, queryFn: fetchActivePolicy });

  const stale = isScoreStale(summaryQuery.data?.latest_score_computed_at ?? null);
  const points = pivotAggregates(aggregatesQuery.data ?? []);

  return (
    <AppShell title="Provider">
      <StalenessBanner show={summaryQuery.isSuccess && stale} />

      <section className="panel">
        <h2>Trust summary</h2>
        <p className="muted">Decisions per minute over the last 24 hours.</p>
        <PanelState {...aggregatesQuery} />
        {aggregatesQuery.isSuccess && <TrustSummaryChart points={points} />}
      </section>

      <section className="panel">
        <h2>Agents</h2>
        <p className="muted">
          Agents observed in sampled decisions, with current network scores.
        </p>
        <PanelState {...agentsQuery} />
        {agentsQuery.isSuccess && <AgentList agents={agentsQuery.data} />}
      </section>

      <section className="panel">
        <h2>Decision feed</h2>
        <p className="muted">Sampled allow/deny/passthrough decisions (all denies are kept).</p>
        <PanelState {...samplesQuery} />
        {samplesQuery.isSuccess && <DecisionFeed samples={samplesQuery.data} />}
      </section>

      <section className="panel">
        <h2>Edge sync status</h2>
        <PanelState {...edgesQuery} />
        {edgesQuery.isSuccess && <EdgeSyncStatus edges={edgesQuery.data} />}
      </section>

      <section className="panel">
        <h2>Active policy</h2>
        <PanelState {...policyQuery} />
        {policyQuery.isSuccess && <PolicyCard policy={policyQuery.data} />}
      </section>

      <section className="panel">
        <h2>Billing</h2>
        <BillingLink />
      </section>
    </AppShell>
  );
}
