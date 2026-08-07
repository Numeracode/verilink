// control-plane/src/domains/edgenode/edgeNodeRepository.ts
import { pool } from '../../db/client.js';

export interface EdgeNodeRow {
  id: string;
  name: string;
  status: string;
  last_seen_at: Date | null;
  last_sync_version: string | null;
  created_at: Date;
  last_cursor: string | null;
  last_sync_at: Date | null;
  high_water_version: string;
  lag: string;
}

/**
 * Tenant-scoped edge fleet with sync lag against the global sync_events high
 * water mark. Edges that never synced report lag against cursor 0.
 */
export async function listEdgeNodesForTenant(tenantId: string): Promise<EdgeNodeRow[]> {
  const { rows } = await pool.query(
    `WITH hw AS (
       SELECT COALESCE(MAX(sync_version), 0) AS high_water_version FROM sync_events
     )
     SELECT en.id, en.name, en.status, en.last_seen_at,
            en.last_sync_version::text AS last_sync_version, en.created_at,
            sc.last_cursor::text AS last_cursor, sc.last_sync_at,
            hw.high_water_version::text AS high_water_version,
            (hw.high_water_version - COALESCE(sc.last_cursor, 0))::text AS lag
     FROM edge_nodes en
     LEFT JOIN sync_cursors sc
       ON sc.tenant_id = en.tenant_id AND sc.edge_node_id = en.id
     CROSS JOIN hw
     WHERE en.tenant_id = $1
     ORDER BY en.created_at ASC, en.id`,
    [tenantId]
  );
  return rows as EdgeNodeRow[];
}
