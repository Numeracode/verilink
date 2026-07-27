// control-plane/src/domains/sync/syncRepository.ts
import { pool } from '../../db/transaction.js';

export interface SyncEvent {
  sync_version: number;
  event_type: string;
  principal_id: string | null;
  tenant_id: string | null;
  payload: Record<string, unknown>;
  created_at: Date;
}

export async function appendEvent(
  eventType: string,
  payload: Record<string, unknown>,
  opts: { principalId?: string; tenantId?: string } = {}
): Promise<number> {
  // Allocate sync_version via locked allocator
  const { rows } = await pool.query(
    `INSERT INTO sync_events (sync_version, event_type, principal_id, tenant_id, payload)
     SELECT COALESCE(MAX(sync_version), 0) + 1, $1, $2, $3, $4
     FROM sync_events
     RETURNING sync_version`,
    [eventType, opts.principalId || null, opts.tenantId || null, JSON.stringify(payload)]
  );
  return rows[0].sync_version;
}

export async function getEventsSince(
  sinceVersion: number,
  tenantId?: string
): Promise<SyncEvent[]> {
  let query = 'SELECT * FROM sync_events WHERE sync_version > $1';
  const params: unknown[] = [sinceVersion];

  if (tenantId) {
    // Global events + tenant-specific events
    query += ' AND (tenant_id IS NULL OR tenant_id = $2)';
    params.push(tenantId);
  } else {
    // Only global events
    query += ' AND tenant_id IS NULL';
  }

  query += ' ORDER BY sync_version ASC';

  const { rows } = await pool.query(query, params);
  return rows;
}

export async function getHighWaterVersion(): Promise<number> {
  const { rows } = await pool.query('SELECT COALESCE(MAX(sync_version), 0) as hw FROM sync_events');
  return parseInt(rows[0].hw, 10);
}
