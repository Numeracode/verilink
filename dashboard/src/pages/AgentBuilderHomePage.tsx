import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AppShell } from '../layouts/AppShell';
import { useAuth } from '../auth/AuthProvider';
import { agentBuilderQueryKeys } from '../lib/queryKeys';
import { scoreSeries } from '../lib/scoreSeries';
import {
  fetchAttestations,
  fetchOwnedPrincipals,
  fetchPrincipalDetail,
  fetchPrincipalKeys,
  safeScoreHistory,
} from '../api/agentBuilder';
import { PrincipalList } from './agent-builder/PrincipalList';
import { KeyList } from './agent-builder/KeyList';
import { AttestationFeed } from './agent-builder/AttestationFeed';
import { ScoreHistoryChart } from './agent-builder/ScoreHistoryChart';
import { IssuerCard } from './agent-builder/IssuerCard';

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

export function AgentBuilderHomePage() {
  const auth = useAuth();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const principalsQuery = useQuery({
    queryKey: agentBuilderQueryKeys(auth.tenantId, selectedId).principals,
    queryFn: fetchOwnedPrincipals,
  });

  // Default-select the first owned principal once the list loads.
  useEffect(() => {
    if (!selectedId && principalsQuery.data && principalsQuery.data.length > 0) {
      setSelectedId(principalsQuery.data[0].id);
    }
  }, [selectedId, principalsQuery.data]);

  const keys = agentBuilderQueryKeys(auth.tenantId, selectedId);
  const enabled = Boolean(selectedId);

  const detailQuery = useQuery({
    queryKey: keys.detail,
    queryFn: () => fetchPrincipalDetail(selectedId!),
    enabled,
  });
  const keyListQuery = useQuery({
    queryKey: keys.keys,
    queryFn: () => fetchPrincipalKeys(selectedId!),
    enabled,
  });
  const scoreQuery = useQuery({
    queryKey: keys.scoreHistory,
    queryFn: () => safeScoreHistory(selectedId!),
    enabled,
  });
  const attestationsInQuery = useQuery({
    queryKey: keys.attestationsIn,
    queryFn: () => fetchAttestations(selectedId!, 'in'),
    enabled,
  });
  const attestationsOutQuery = useQuery({
    queryKey: keys.attestationsOut,
    queryFn: () => fetchAttestations(selectedId!, 'out'),
    enabled,
  });

  const series = scoreSeries(scoreQuery.data?.items ?? []);

  return (
    <AppShell title="Agent builder">
      <section className="panel">
        <h2>Owned principals</h2>
        <PanelState {...principalsQuery} />
        {principalsQuery.isSuccess && (
          <PrincipalList
            principals={principalsQuery.data}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        )}
      </section>

      {selectedId && (
        <>
          <section className="panel">
            <h2>Keys & assurance</h2>
            <PanelState {...keyListQuery} />
            {keyListQuery.isSuccess && <KeyList keys={keyListQuery.data} />}
          </section>

          <section className="panel">
            <h2>Network score history</h2>
            <PanelState {...scoreQuery} />
            {scoreQuery.isSuccess && <ScoreHistoryChart points={series} />}
          </section>

          <section className="panel">
            <h2>Attestations</h2>
            <h3 className="panel__subtitle">Incoming (about this principal)</h3>
            <PanelState {...attestationsInQuery} />
            {attestationsInQuery.isSuccess && (
              <AttestationFeed direction="in" items={attestationsInQuery.data} />
            )}
            <h3 className="panel__subtitle">Outgoing (signed by this principal)</h3>
            <PanelState {...attestationsOutQuery} />
            {attestationsOutQuery.isSuccess && (
              <AttestationFeed direction="out" items={attestationsOutQuery.data} />
            )}
          </section>

          <section className="panel">
            <h2>Issuer relationship</h2>
            <PanelState {...detailQuery} />
            {detailQuery.isSuccess && <IssuerCard issuer={detailQuery.data.issuer} />}
          </section>
        </>
      )}
    </AppShell>
  );
}
