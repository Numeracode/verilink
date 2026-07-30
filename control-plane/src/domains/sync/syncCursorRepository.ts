// control-plane/src/domains/sync/syncCursorRepository.ts
import { pool } from '../../db/client.js';
import { logger } from '../../shared/logger.js';

/**
 * Resolve edge_node_id from authenticated API key — never from client input.
 * Creates an edge_nodes row for the key if missing (unique per tenant+api_key).
 */
export async function resolveEdgeNodeForApiKey(
  tenantId: string,
  apiKeyId: string
): Promise<string> {
  const name = `edge-${apiKeyId.slice(0, 8)}`;
  const upserted = await pool.query(
    `INSERT INTO edge_nodes (tenant_id, name, api_key_id, status, last_seen_at)
     VALUES ($1, $2, $3, 'online', now())
     ON CONFLICT (tenant_id, api_key_id) WHERE api_key_id IS NOT NULL
     DO UPDATE SET
       last_seen_at = now(),
       status = 'online'
     RETURNING id`,
    [tenantId, name, apiKeyId]
  );
  return upserted.rows[0].id as string;
}

/** Monotonic upsert — EXCLUDED.last_cursor cannot regress stored last_cursor. */
export async function upsertSyncCursor(opts: {
  tenantId: string;
  edgeNodeId: string;
  lastCursor: bigint;
}): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO sync_cursors (tenant_id, edge_node_id, last_cursor, last_sync_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (tenant_id, edge_node_id) DO UPDATE SET
         last_cursor = GREATEST(sync_cursors.last_cursor, EXCLUDED.last_cursor),
         last_sync_at = now()`,
      [opts.tenantId, opts.edgeNodeId, opts.lastCursor.toString()]
    );
  } catch (err) {
    logger.warn({ err, edgeNodeId: opts.edgeNodeId }, 'sync_cursors upsert failed');
  }
}

export interface SyncLagRow {
  tenant_id: string;
  edge_node_id: string;
  edge_name: string;
  last_cursor: string;
  high_water_version: string;
  lag: string;
  last_sync_at: Date | null;
}

/**
 * List per-edge sync lag. When tenantId is set, results are scoped to that tenant.
 * Platform staff callers omit tenantId for a global view.
 */
export async function listSyncLag(tenantId?: string): Promise<SyncLagRow[]> {
  const { rows } = await pool.query(
    `WITH hw AS (
       SELECT COALESCE(MAX(sync_version), 0) AS high_water_version FROM sync_events
     )
     SELECT
       sc.tenant_id,
       sc.edge_node_id,
       en.name AS edge_name,
       sc.last_cursor::text AS last_cursor,
       hw.high_water_version::text AS high_water_version,
       (hw.high_water_version - sc.last_cursor)::text AS lag,
       sc.last_sync_at
     FROM sync_cursors sc
     JOIN edge_nodes en ON en.id = sc.edge_node_id AND en.tenant_id = sc.tenant_id
     CROSS JOIN hw
     WHERE ($1::uuid IS NULL OR sc.tenant_id = $1)
     ORDER BY (hw.high_water_version - sc.last_cursor) DESC, sc.tenant_id, sc.edge_node_id`,
    [tenantId ?? null]
  );
  return rows;
}
