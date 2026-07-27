// control-plane/src/domains/sync/syncService.ts
import * as syncRepo from './syncRepository.js';
import { pool } from '../../db/transaction.js';

export interface Snapshot {
  highWaterVersion: number;
  scores: Array<{
    principal_id: string;
    entity_kind: string;
    score: number;
    blacklisted: boolean;
    score_reason: string;
  }>;
  keys: Array<{
    principal_id: string;
    key_id: string;
    public_key_raw: string; // base64
    valid_from: Date;
    valid_until: Date | null;
  }>;
  policy?: Record<string, unknown>;
}

export async function getSnapshot(tenantId: string): Promise<Snapshot> {
  const client = await pool.connect();
  try {
    // Repeatable read for consistent snapshot
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ');

    const hwResult = await client.query('SELECT COALESCE(MAX(sync_version), 0) as hw FROM sync_events');
    const highWaterVersion = parseInt(hwResult.rows[0].hw, 10);

    const scoresResult = await client.query(
      'SELECT principal_id, entity_kind, score, blacklisted, score_reason FROM network_scores'
    );

    const keysResult = await client.query(
      `SELECT principal_id, key_id, encode(public_key_raw, 'base64') as public_key_raw,
              valid_from, valid_until
       FROM principal_keys
       WHERE revoked_at IS NULL AND (valid_until IS NULL OR valid_until > now())`
    );

    const policyResult = await client.query(
      'SELECT * FROM policies WHERE tenant_id = $1 AND is_active = true LIMIT 1',
      [tenantId]
    );

    await client.query('COMMIT');

    return {
      highWaterVersion,
      scores: scoresResult.rows,
      keys: keysResult.rows,
      policy: policyResult.rows[0] || undefined,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getEventsSince(sinceVersion: number, tenantId?: string) {
  return syncRepo.getEventsSince(sinceVersion, tenantId);
}
