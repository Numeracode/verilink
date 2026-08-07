/**
 * Query-key namespaces. The active tenant id is embedded so switching tenants
 * (X-Tenant-Id) partitions the cache and triggers refetch instead of
 * returning the previous tenant's data.
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

/** Agent-builder keys are scoped by tenant + the selected principal id. */
export function agentBuilderQueryKeys(tenantId: string | null, principalId: string | null) {
  const t = tenantId ?? 'none';
  const p = principalId ?? 'none';
  return {
    principals: ['agent-builder', 'principals', t] as const,
    detail: ['agent-builder', 'principal', t, p] as const,
    keys: ['agent-builder', 'keys', t, p] as const,
    scoreHistory: ['agent-builder', 'score-history', t, p] as const,
    attestationsIn: ['agent-builder', 'attestations-in', t, p] as const,
    attestationsOut: ['agent-builder', 'attestations-out', t, p] as const,
  };
}
