// control-plane/src/domains/sync/syncRepository.ts
import type pg from 'pg';
import { pool, withTransaction } from '../../db/transaction.js';

export const SYNC_VERSION_LOCK_KEY = 8392018;

export interface SyncEvent {
  sync_version: number;
  event_type: string;
  principal_id: string | null;
  tenant_id: string | null;
  payload: Record<string, unknown>;
  created_at: Date;
}

/** Caller must already hold pg_advisory_xact_lock(SYNC_VERSION_LOCK_KEY). */
export async function appendEventWithClient(
  client: pg.PoolClient,
  eventType: string,
  payload: Record<string, unknown>,
  opts: { principalId?: string; tenantId?: string } = {}
): Promise<number> {
  const { rows } = await client.query(
    `INSERT INTO sync_events (sync_version, event_type, principal_id, tenant_id, payload)
     SELECT COALESCE(MAX(sync_version), 0) + 1, $1, $2, $3, $4
     FROM sync_events
     RETURNING sync_version`,
    [eventType, opts.principalId || null, opts.tenantId || null, JSON.stringify(payload)]
  );
  return parseInt(rows[0].sync_version, 10);
}

export async function appendEvent(
  eventType: string,
  payload: Record<string, unknown>,
  opts: { principalId?: string; tenantId?: string } = {}
): Promise<number> {
  return withTransaction(async (client) => {
    await client.query("SET lock_timeout = '5s'");
    await client.query('SELECT pg_advisory_xact_lock($1)', [SYNC_VERSION_LOCK_KEY]);
    return appendEventWithClient(client, eventType, payload, opts);
  });
}

export async function getEventsSince(
  sinceVersion: number | bigint,
  tenantId?: string,
  limit?: number
): Promise<SyncEvent[]> {
  let query = 'SELECT * FROM sync_events WHERE sync_version > $1';
  const params: unknown[] = [sinceVersion.toString()];

  if (tenantId) {
    query += ' AND (tenant_id IS NULL OR tenant_id = $2)';
    params.push(tenantId);
  } else {
    query += ' AND tenant_id IS NULL';
  }

  query += ' ORDER BY sync_version ASC';
  if (limit !== undefined) {
    query += ` LIMIT $${params.length + 1}`;
    params.push(limit);
  }

  const { rows } = await pool.query(query, params);
  return rows;
}

export async function getHighWaterVersion(): Promise<number> {
  const { rows } = await pool.query('SELECT COALESCE(MAX(sync_version), 0) as hw FROM sync_events');
  return parseInt(rows[0].hw, 10);
}

export interface InitialBatchResult {
  events: SyncEvent[];
  highWater: bigint;
  backlogExceeded: boolean;
}

/**
 * Decision 17: probe + first batch + high-water in one REPEATABLE READ snapshot.
 * Fetches up to maxBatch+1 rows; if more than maxBatch match, backlogExceeded.
 */
export async function getInitialBatchWithHighWater(
  sinceVersion: bigint,
  tenantId: string | undefined,
  maxBatch: number
): Promise<InitialBatchResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ');

    let eventsQuery = 'SELECT * FROM sync_events WHERE sync_version > $1';
    const params: unknown[] = [sinceVersion.toString()];
    if (tenantId) {
      eventsQuery += ' AND (tenant_id IS NULL OR tenant_id = $2)';
      params.push(tenantId);
    } else {
      eventsQuery += ' AND tenant_id IS NULL';
    }
    eventsQuery += ` ORDER BY sync_version ASC LIMIT $${params.length + 1}`;
    params.push(maxBatch + 1);

    const eventsResult = await client.query(eventsQuery, params);
    const hwResult = await client.query(
      'SELECT COALESCE(MAX(sync_version), 0) as hw FROM sync_events'
    );
    await client.query('COMMIT');

    const backlogExceeded = eventsResult.rows.length > maxBatch;
    const events = backlogExceeded
      ? eventsResult.rows.slice(0, maxBatch)
      : eventsResult.rows;

    return {
      events,
      highWater: BigInt(hwResult.rows[0].hw),
      backlogExceeded,
    };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Poll cycle: tenant-filtered events since cursor + global high-water in one snapshot.
 */
export async function getPollBatchWithHighWater(
  sinceVersion: bigint,
  tenantId: string | undefined,
  limit: number
): Promise<{ events: SyncEvent[]; highWater: bigint }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ');

    let eventsQuery = 'SELECT * FROM sync_events WHERE sync_version > $1';
    const params: unknown[] = [sinceVersion.toString()];
    if (tenantId) {
      eventsQuery += ' AND (tenant_id IS NULL OR tenant_id = $2)';
      params.push(tenantId);
    } else {
      eventsQuery += ' AND tenant_id IS NULL';
    }
    eventsQuery += ` ORDER BY sync_version ASC LIMIT $${params.length + 1}`;
    params.push(limit);

    const eventsResult = await client.query(eventsQuery, params);
    const hwResult = await client.query(
      'SELECT COALESCE(MAX(sync_version), 0) as hw FROM sync_events'
    );
    await client.query('COMMIT');

    return {
      events: eventsResult.rows,
      highWater: BigInt(hwResult.rows[0].hw),
    };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}
