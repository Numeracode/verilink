// control-plane/src/domains/decision/decisionIngestService.ts
import { pool } from '../../db/client.js';
import { AppError, CODES } from '../../shared/errors/AppError.js';
import { resolveEdgeNodeForApiKey } from '../sync/syncCursorRepository.js';
import { shouldSample } from './decisionSample.js';

export interface DecisionWire {
  wal_seq: number;
  fingerprint: string;
  principal_id?: string | null;
  score?: number | null;
  blacklisted?: boolean | null;
  score_reason?: string | null;
  action: 'allow' | 'deny' | 'passthrough';
  decided_at: string;
}

export interface DecisionBatchWire {
  batch_id: string;
  first_wal_seq: number;
  last_wal_seq: number;
  payload_hash: string;
  decisions: DecisionWire[];
}

export interface IngestResult {
  duplicate: boolean;
  edge_node_id: string;
  accepted: number;
  sampled: number;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertBatchShape(body: DecisionBatchWire): void {
  if (!body || typeof body !== 'object') {
    throw new AppError(CODES.BAD_REQUEST, 'Missing batch body');
  }
  if (!body.batch_id || !UUID_RE.test(body.batch_id)) {
    throw new AppError(CODES.BAD_REQUEST, 'batch_id must be a UUID');
  }
  if (!body.payload_hash || typeof body.payload_hash !== 'string' || body.payload_hash.length < 16) {
    throw new AppError(CODES.BAD_REQUEST, 'payload_hash required');
  }
  if (!Number.isInteger(body.first_wal_seq) || !Number.isInteger(body.last_wal_seq)) {
    throw new AppError(CODES.BAD_REQUEST, 'first_wal_seq/last_wal_seq must be integers');
  }
  if (body.first_wal_seq > body.last_wal_seq) {
    throw new AppError(CODES.BAD_REQUEST, 'first_wal_seq must be <= last_wal_seq');
  }
  if (!Array.isArray(body.decisions) || body.decisions.length === 0) {
    throw new AppError(CODES.BAD_REQUEST, 'decisions must be a non-empty array');
  }
  if (body.decisions.length > 500) {
    throw new AppError(CODES.PAYLOAD_TOO_LARGE, 'decisions exceeds max batch size 500');
  }
  const first = body.decisions[0].wal_seq;
  const last = body.decisions[body.decisions.length - 1].wal_seq;
  if (first !== body.first_wal_seq || last !== body.last_wal_seq) {
    throw new AppError(CODES.BAD_REQUEST, 'wal_seq range must match first/last_wal_seq');
  }
  for (const d of body.decisions) {
    if (!['allow', 'deny', 'passthrough'].includes(d.action)) {
      throw new AppError(CODES.BAD_REQUEST, `invalid action ${d.action}`);
    }
    if (!d.fingerprint || typeof d.fingerprint !== 'string') {
      throw new AppError(CODES.BAD_REQUEST, 'fingerprint required');
    }
    if (!Number.isInteger(d.wal_seq) || d.wal_seq < 1) {
      throw new AppError(CODES.BAD_REQUEST, 'wal_seq must be a positive integer');
    }
    if (!d.decided_at || Number.isNaN(Date.parse(d.decided_at))) {
      throw new AppError(CODES.BAD_REQUEST, 'decided_at must be an ISO timestamp');
    }
  }
}

async function loadSampleRate(tenantId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT allow_sample_rate FROM policies WHERE tenant_id = $1 AND is_active = true LIMIT 1`,
    [tenantId]
  );
  if (rows.length === 0) return 0.01;
  const rate = Number(rows[0].allow_sample_rate);
  if (Number.isNaN(rate) || rate < 0) return 0.01;
  if (rate > 1) return 1;
  return rate;
}

function minuteBucket(iso: string): Date {
  const t = new Date(iso);
  t.setUTCSeconds(0, 0);
  return t;
}

/**
 * Idempotent decision batch ingest.
 * Duplicate (edge_node_id, batch_id) with same payload_hash → ok duplicate.
 * Same batch_id with different payload_hash → 409.
 */
export async function ingestDecisionBatch(opts: {
  tenantId: string;
  apiKeyId: string;
  body: DecisionBatchWire;
}): Promise<IngestResult> {
  assertBatchShape(opts.body);

  const edgeNodeId = await resolveEdgeNodeForApiKey(opts.tenantId, opts.apiKeyId);
  const existing = await pool.query(
    `SELECT payload_hash FROM decision_batches WHERE edge_node_id = $1 AND batch_id = $2`,
    [edgeNodeId, opts.body.batch_id]
  );
  if (existing.rows.length > 0) {
    if (existing.rows[0].payload_hash === opts.body.payload_hash) {
      return { duplicate: true, edge_node_id: edgeNodeId, accepted: 0, sampled: 0 };
    }
    throw new AppError(CODES.CONFLICT, 'batch_id reused with different payload_hash');
  }

  const sampleRate = await loadSampleRate(opts.tenantId);
  const client = await pool.connect();
  let sampled = 0;
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO decision_batches
         (edge_node_id, batch_id, tenant_id, first_wal_seq, last_wal_seq, payload_hash)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        edgeNodeId,
        opts.body.batch_id,
        opts.tenantId,
        opts.body.first_wal_seq,
        opts.body.last_wal_seq,
        opts.body.payload_hash,
      ]
    );

    for (const d of opts.body.decisions) {
      const bucket = minuteBucket(d.decided_at);
      // dimension_kind=all
      await client.query(
        `INSERT INTO decision_aggregates
           (tenant_id, edge_node_id, bucket_minute, dimension_kind, dimension_value, action, count)
         VALUES ($1, $2, $3, 'all', '', $4, 1)
         ON CONFLICT (tenant_id, edge_node_id, bucket_minute, dimension_kind, dimension_value, action)
         DO UPDATE SET count = decision_aggregates.count + 1`,
        [opts.tenantId, edgeNodeId, bucket.toISOString(), d.action]
      );
      if (d.principal_id) {
        await client.query(
          `INSERT INTO decision_aggregates
             (tenant_id, edge_node_id, bucket_minute, dimension_kind, dimension_value, action, count)
           VALUES ($1, $2, $3, 'principal', $4, $5, 1)
           ON CONFLICT (tenant_id, edge_node_id, bucket_minute, dimension_kind, dimension_value, action)
           DO UPDATE SET count = decision_aggregates.count + 1`,
          [opts.tenantId, edgeNodeId, bucket.toISOString(), d.principal_id, d.action]
        );
      }
      await client.query(
        `INSERT INTO decision_aggregates
           (tenant_id, edge_node_id, bucket_minute, dimension_kind, dimension_value, action, count)
         VALUES ($1, $2, $3, 'fingerprint', $4, $5, 1)
         ON CONFLICT (tenant_id, edge_node_id, bucket_minute, dimension_kind, dimension_value, action)
         DO UPDATE SET count = decision_aggregates.count + 1`,
        [opts.tenantId, edgeNodeId, bucket.toISOString(), d.fingerprint, d.action]
      );

      if (shouldSample(d.action, d.wal_seq, sampleRate)) {
        sampled += 1;
        await client.query(
          `INSERT INTO decision_samples
             (tenant_id, edge_node_id, wal_seq, fingerprint, principal_id, score, blacklisted,
              score_reason, action, decided_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (edge_node_id, wal_seq) DO NOTHING`,
          [
            opts.tenantId,
            edgeNodeId,
            d.wal_seq,
            d.fingerprint,
            d.principal_id ?? null,
            d.score ?? null,
            d.blacklisted ?? null,
            d.score_reason ?? null,
            d.action,
            d.decided_at,
          ]
        );
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    // Race: concurrent duplicate insert on batch_id
    if ((err as { code?: string }).code === '23505') {
      const again = await pool.query(
        `SELECT payload_hash FROM decision_batches WHERE edge_node_id = $1 AND batch_id = $2`,
        [edgeNodeId, opts.body.batch_id]
      );
      if (again.rows.length > 0 && again.rows[0].payload_hash === opts.body.payload_hash) {
        return { duplicate: true, edge_node_id: edgeNodeId, accepted: 0, sampled: 0 };
      }
      throw new AppError(CODES.CONFLICT, 'batch_id reused with different payload_hash');
    }
    throw err;
  } finally {
    client.release();
  }

  return {
    duplicate: false,
    edge_node_id: edgeNodeId,
    accepted: opts.body.decisions.length,
    sampled,
  };
}
