// control-plane/src/domains/decision/decisionReadRepository.ts
import { pool } from '../../db/client.js';

export type DecisionDimension = 'all' | 'principal' | 'fingerprint';

export interface AggregateRow {
  bucket_minute: Date;
  dimension_kind: string;
  dimension_value: string;
  action: string;
  count: number;
}

/** Per-minute rollups for a tenant, summed across edge nodes. */
export async function getAggregates(opts: {
  tenantId: string;
  from: Date;
  to: Date;
  dimension: DecisionDimension;
}): Promise<AggregateRow[]> {
  const { rows } = await pool.query(
    `SELECT bucket_minute, dimension_kind, dimension_value, action,
            SUM(count)::int AS count
     FROM decision_aggregates
     WHERE tenant_id = $1
       AND bucket_minute >= $2
       AND bucket_minute <= $3
       AND dimension_kind = $4
     GROUP BY bucket_minute, dimension_kind, dimension_value, action
     ORDER BY bucket_minute ASC, dimension_value, action`,
    [opts.tenantId, opts.from, opts.to, opts.dimension]
  );
  return rows as AggregateRow[];
}

export interface SampleRow {
  id: string;
  edge_node_id: string;
  wal_seq: string;
  fingerprint: string;
  principal_id: string | null;
  score: number | null;
  blacklisted: boolean | null;
  score_reason: string | null;
  action: string;
  decided_at: Date;
}

/** Sampled decision feed for a tenant, newest first. */
export async function getSamples(opts: {
  tenantId: string;
  from: Date;
  to: Date;
  limit: number;
}): Promise<SampleRow[]> {
  const { rows } = await pool.query(
    `SELECT id::text AS id, edge_node_id, wal_seq::text AS wal_seq, fingerprint,
            principal_id, score, blacklisted, score_reason, action, decided_at
     FROM decision_samples
     WHERE tenant_id = $1
       AND decided_at >= $2
       AND decided_at <= $3
     ORDER BY decided_at DESC, id DESC
     LIMIT $4`,
    [opts.tenantId, opts.from, opts.to, opts.limit]
  );
  return rows as SampleRow[];
}

export interface AgentRow {
  principal_id: string;
  name: string | null;
  entity_kind: string | null;
  decisions: number;
  last_decided_at: Date;
  score: number | null;
  blacklisted: boolean | null;
  score_reason: string | null;
  score_computed_at: Date | null;
}

/**
 * Provider agent list: distinct principals seen in the tenant's sampled
 * decisions within the window, joined to the CURRENT network score.
 * `blacklisted` comes from network_scores only — never inferred from score.
 */
export async function listAgents(opts: {
  tenantId: string;
  from: Date;
  to: Date;
  limit: number;
}): Promise<AgentRow[]> {
  const { rows } = await pool.query(
    `SELECT s.principal_id, p.name, p.entity_kind,
            COUNT(*)::int AS decisions,
            MAX(s.decided_at) AS last_decided_at,
            ns.score, ns.blacklisted, ns.score_reason,
            ns.computed_at AS score_computed_at
     FROM decision_samples s
     LEFT JOIN principals p ON p.id = s.principal_id
     LEFT JOIN network_scores ns ON ns.principal_id = s.principal_id
     WHERE s.tenant_id = $1
       AND s.principal_id IS NOT NULL
       AND s.decided_at >= $2
       AND s.decided_at <= $3
     GROUP BY s.principal_id, p.name, p.entity_kind,
              ns.score, ns.blacklisted, ns.score_reason, ns.computed_at
     ORDER BY decisions DESC, s.principal_id
     LIMIT $4`,
    [opts.tenantId, opts.from, opts.to, opts.limit]
  );
  return rows as AgentRow[];
}
