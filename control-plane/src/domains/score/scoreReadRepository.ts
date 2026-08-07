// control-plane/src/domains/score/scoreReadRepository.ts
import { pool } from '../../db/client.js';

export interface CurrentScore {
  principal_id: string;
  entity_kind: string;
  score: number;
  blacklisted: boolean;
  score_reason: string;
  computed_at: Date;
  sync_version: string;
}

export interface ScoreHistoryItem {
  score: number;
  blacklisted: boolean;
  score_reason: string;
  computed_at: Date;
  sync_version: string;
}

/** Current materialized VeriRank score for a principal, if any. */
export async function getCurrentScore(principalId: string): Promise<CurrentScore | null> {
  const { rows } = await pool.query(
    `SELECT principal_id, entity_kind, score, blacklisted, score_reason,
            computed_at, sync_version::text AS sync_version
     FROM network_scores
     WHERE principal_id = $1`,
    [principalId]
  );
  return (rows[0] as CurrentScore | undefined) ?? null;
}

/** Score change history for a principal, newest first (sync_version is monotonic). */
export async function getScoreHistory(
  principalId: string,
  limit: number
): Promise<ScoreHistoryItem[]> {
  const { rows } = await pool.query(
    `SELECT score, blacklisted, score_reason, computed_at,
            sync_version::text AS sync_version
     FROM network_score_history
     WHERE principal_id = $1
     ORDER BY sync_version DESC
     LIMIT $2`,
    [principalId, limit]
  );
  return rows as ScoreHistoryItem[];
}

export interface GraphSummary {
  principals: { total: number; agents: number; issuers: number; both: number };
  attestations: { total: number };
  top_issuers: Array<{
    issuer_id: string;
    name: string | null;
    trust_weight: number;
    verified_at: Date | null;
    outgoing: number;
  }>;
  latest_score_computed_at: Date | null;
}

/**
 * Global graph health summary. The trust graph is shared (Plan 9 Decision 5):
 * any authenticated caller may read this. Read-only; no path explorer.
 */
export async function getGraphSummary(): Promise<GraphSummary> {
  const [principalsRes, attestationsRes, topRes, latestRes] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE entity_kind = 'agent')::int AS agents,
              COUNT(*) FILTER (WHERE entity_kind = 'issuer')::int AS issuers,
              COUNT(*) FILTER (WHERE entity_kind = 'both')::int AS both
       FROM principals`
    ),
    pool.query(`SELECT COUNT(*)::int AS total FROM attestations`),
    pool.query(
      `SELECT a.issuer_id, p.name, i.trust_weight::float AS trust_weight,
              i.verified_at, COUNT(*)::int AS outgoing
       FROM attestations a
       JOIN issuers i ON i.principal_id = a.issuer_id
       LEFT JOIN principals p ON p.id = a.issuer_id
       GROUP BY a.issuer_id, p.name, i.trust_weight, i.verified_at
       ORDER BY outgoing DESC, a.issuer_id
       LIMIT 10`
    ),
    pool.query(`SELECT MAX(computed_at) AS latest FROM network_scores`),
  ]);

  const p = principalsRes.rows[0] as {
    total: number;
    agents: number;
    issuers: number;
    both: number;
  };
  const a = attestationsRes.rows[0] as { total: number };

  return {
    principals: { total: p.total, agents: p.agents, issuers: p.issuers, both: p.both },
    attestations: { total: a.total },
    top_issuers: topRes.rows as GraphSummary['top_issuers'],
    latest_score_computed_at:
      (latestRes.rows[0] as { latest: Date | null } | undefined)?.latest ?? null,
  };
}
