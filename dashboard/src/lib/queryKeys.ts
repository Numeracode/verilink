/**
 * Query-key namespaces for the provider view. The active tenant id is embedded
 * so switching tenants (X-Tenant-Id) partitions the cache and triggers refetch
 * instead of returning the previous tenant's data.
 */
export function providerQueryKeys(tenantId: string | null) {
  const t = tenantId ?? 'none';
  return {
    graphSummary: ['graph-summary', t] as const,
    aggregates: ['decision-aggregates', t] as const,
    agents: ['decision-agents', t] as const,
    samples: ['decision-samples', t] as const,
    edgeNodes: ['edge-nodes', t] as const,
    policyActive: ['policy-active', t] as const,
  };
}
