// control-plane/src/domains/sync/syncCursorRepository.ts
import { pool } from '../../db/client.js';
import { logger } from '../../shared/logger.js';

/**
 * Resolve edge_node_id from authenticated API key — never from client input.
 * Creates an edge_nodes row for the key if missing.
 */
export async function resolveEdgeNodeForApiKey(
  tenantId: string,
  apiKeyId: string
): Promise<string> {
  const existing = await pool.query(
    `SELECT id FROM edge_nodes WHERE tenant_id = $1 AND api_key_id = $2 LIMIT 1`,
    [tenantId, apiKeyId]
  );
  if (existing.rows[0]) {
    return existing.rows[0].id as string;
  }
  const inserted = await pool.query(
    `INSERT INTO edge_nodes (tenant_id, name, api_key_id, status, last_seen_at)
     VALUES ($1, $2, $3, 'online', now())
     RETURNING id`,
    [tenantId, `edge-${apiKeyId.slice(0, 8)}`, apiKeyId]
  );
  return inserted.rows[0].id as string;
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

export async function listSyncLag(): Promise<SyncLagRow[]> {
  const { rows } = await pool.query(
    `SELECT
       sc.tenant_id,
       sc.edge_node_id,
       en.name AS edge_name,
       sc.last_cursor::text AS last_cursor,
       COALESCE((SELECT MAX(sync_version) FROM sync_events), 0)::text AS high_water_version,
       (COALESCE((SELECT MAX(sync_version) FROM sync_events), 0) - sc.last_cursor)::text AS lag,
       sc.last_sync_at
     FROM sync_cursors sc
     JOIN edge_nodes en ON en.id = sc.edge_node_id AND en.tenant_id = sc.tenant_id
     ORDER BY lag DESC, sc.tenant_id, sc.edge_node_id`
  );
  return rows;
}
