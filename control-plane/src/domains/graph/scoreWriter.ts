// control-plane/src/domains/graph/scoreWriter.ts
import type pg from 'pg';
import { withTransaction } from '../../db/transaction.js';
import {
  SYNC_VERSION_LOCK_KEY,
  appendEventWithClient,
} from '../sync/syncRepository.js';
import { scoreChanged, type EngineScore, type ExistingScore } from './scoreDiff.js';

export interface ApplyScoresResult {
  upserts: number;
  deletes: number;
}

async function loadExistingScores(client: pg.PoolClient): Promise<Map<string, ExistingScore>> {
  const { rows } = await client.query<ExistingScore>(
    `SELECT principal_id, entity_kind, score, blacklisted, score_reason
     FROM network_scores`
  );
  const map = new Map<string, ExistingScore>();
  for (const row of rows) map.set(row.principal_id, row);
  return map;
}

async function upsertScore(
  client: pg.PoolClient,
  row: EngineScore,
  syncVersion: number,
  computedAt: Date
): Promise<void> {
  await client.query(
    `INSERT INTO network_scores (
       principal_id, entity_kind, score, blacklisted, score_reason, computed_at, sync_version
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (principal_id) DO UPDATE SET
       entity_kind = EXCLUDED.entity_kind,
       score = EXCLUDED.score,
       blacklisted = EXCLUDED.blacklisted,
       score_reason = EXCLUDED.score_reason,
       computed_at = EXCLUDED.computed_at,
       sync_version = EXCLUDED.sync_version`,
    [
      row.principal_id,
      row.entity_kind,
      row.score,
      row.blacklisted,
      row.score_reason,
      computedAt,
      syncVersion,
    ]
  );
}

async function insertHistory(
  client: pg.PoolClient,
  row: EngineScore,
  syncVersion: number,
  computedAt: Date
): Promise<void> {
  await client.query(
    `INSERT INTO network_score_history (
       principal_id, entity_kind, score, blacklisted, score_reason, computed_at, sync_version
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      row.principal_id,
      row.entity_kind,
      row.score,
      row.blacklisted,
      row.score_reason,
      computedAt,
      syncVersion,
    ]
  );
}

/**
 * Apply engine scores (or empty = delete all) inside one TX with xact advisory lock.
 */
export async function applyScoreTable(
  engineRows: EngineScore[],
  computedAt: Date = new Date()
): Promise<ApplyScoresResult> {
  return withTransaction(async (client) => {
    await client.query("SET lock_timeout = '5s'");
    await client.query('SELECT pg_advisory_xact_lock($1)', [SYNC_VERSION_LOCK_KEY]);

    const existing = await loadExistingScores(client);
    const nextIds = new Set(engineRows.map((r) => r.principal_id));
    let upserts = 0;
    let deletes = 0;

    for (const row of engineRows) {
      const prev = existing.get(row.principal_id);
      const changed = !prev || scoreChanged(prev, row);
      if (!changed) continue;

      const syncVersion = await appendEventWithClient(
        client,
        'score.upsert',
        {
          principal_id: row.principal_id,
          entity_kind: row.entity_kind,
          score: row.score,
          blacklisted: row.blacklisted,
          score_reason: row.score_reason,
        },
        { principalId: row.principal_id }
      );
      await upsertScore(client, row, syncVersion, computedAt);
      await insertHistory(client, row, syncVersion, computedAt);
      upserts += 1;
    }

    for (const [principalId] of existing) {
      if (nextIds.has(principalId)) continue;
      const syncVersion = await appendEventWithClient(
        client,
        'score.delete',
        { principal_id: principalId },
        { principalId }
      );
      await client.query('DELETE FROM network_scores WHERE principal_id = $1', [principalId]);
      // stamp unused — version allocated for ordering; delete has no history row
      void syncVersion;
      deletes += 1;
    }

    return { upserts, deletes };
  });
}

/** Delete every network_scores row and emit score.delete (empty-roots stale clear). */
export async function clearAllScores(): Promise<number> {
  const result = await applyScoreTable([], new Date());
  return result.deletes;
}
