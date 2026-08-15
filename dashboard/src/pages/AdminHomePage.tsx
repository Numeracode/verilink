import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AppShell } from '../layouts/AppShell';
import { useAuth } from '../auth/AuthProvider';
import { fetchBootstrapIssuers, fetchTenants, fetchUnverifiedIssuers, updateBootstrapIssuer } from '../api/admin';
import { fetchGraphSummary } from '../api/provider';
import { providerQueryKeys } from '../lib/queryKeys';
import { TenantList } from './admin/TenantList';
import { GraphHealth } from './admin/GraphHealth';
import { BootstrapEditor } from './admin/BootstrapEditor';
import { IssuerVerificationQueue } from './admin/IssuerVerificationQueue';
import { DeEmphasisPanel } from './admin/DeEmphasisPanel';
import { fetchDeEmphasis } from '../api/admin';

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

export function AdminHomePage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const adminKeys = providerQueryKeys(auth.tenantId);

  const tenantsQuery = useQuery({ queryKey: ['admin', 'tenants', auth.tenantId ?? 'none'], queryFn: fetchTenants });
  const bootstrapQuery = useQuery({ queryKey: ['admin', 'bootstrap', auth.tenantId ?? 'none'], queryFn: fetchBootstrapIssuers });
  const unverifiedQuery = useQuery({ queryKey: ['admin', 'unverified', auth.tenantId ?? 'none'], queryFn: fetchUnverifiedIssuers });
  const summaryQuery = useQuery({ queryKey: adminKeys.graphSummary, queryFn: fetchGraphSummary });
  const deEmphasisQuery = useQuery({ queryKey: ['admin', 'de-emphasis', auth.tenantId ?? 'none'], queryFn: fetchDeEmphasis, staleTime: 60_000 });

  const updateMutation = useMutation({
    mutationFn: ({ principalId, patch }: { principalId: string; patch: { current_weight?: number; de_emphasis_reason?: string | null } }) =>
      updateBootstrapIssuer(principalId, patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'bootstrap'] }),
  });

  return (
    <AppShell title="Admin">
      <section className="panel">
        <h2>Graph health</h2>
        <PanelState {...summaryQuery} />
        {summaryQuery.isSuccess && <GraphHealth summary={summaryQuery.data} />}
      </section>

      <section className="panel">
        <h2>Tenants</h2>
        <PanelState {...tenantsQuery} />
        {tenantsQuery.isSuccess && <TenantList tenants={tenantsQuery.data} />}
      </section>

      <section className="panel">
        <h2>Bootstrap registry</h2>
        <p className="muted">Edit Root.weight to de-emphasize a bootstrap issuer (issuers.trust_weight is untouched).</p>
        <PanelState {...bootstrapQuery} />
        {bootstrapQuery.isSuccess && (
          <BootstrapEditor
            issuers={bootstrapQuery.data}
            onUpdate={async (principalId, patch) => { await updateMutation.mutateAsync({ principalId, patch }); }}
          />
        )}
        {updateMutation.isError && (
          <p className="panel__error">Update failed: {updateMutation.error instanceof Error ? updateMutation.error.message : 'unknown'}</p>
        )}
      </section>

      <section className="panel">
        <h2>De-emphasis readiness</h2>
        <p className="muted">Bootstrap vs organic contribution over 30 days. Ready when {">=3"} independent organic issuers, {">=80%"} organic, continuous 30-day window, and no principal drops below threshold.</p>
        <PanelState {...deEmphasisQuery} />
        {deEmphasisQuery.isSuccess && <DeEmphasisPanel data={deEmphasisQuery.data} />}
      </section>

      <section className="panel">
        <h2>Issuer verification queue</h2>
        <PanelState {...unverifiedQuery} />
        {unverifiedQuery.isSuccess && <IssuerVerificationQueue issuers={unverifiedQuery.data} />}
      </section>
    </AppShell>
  );
}
