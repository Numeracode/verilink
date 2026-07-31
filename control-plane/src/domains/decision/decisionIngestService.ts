// control-plane/src/domains/decision/decisionIngestService.ts
import type pg from 'pg';
import { pool } from '../../db/client.js';
import { AppError, CODES } from '../../shared/errors/AppError.js';
import { resolveEdgeNodeForApiKey } from '../sync/syncCursorRepository.js';
import {
  assertRFC3339,
  batchIDFromPayloadHash,
  canonicalizeDecisionsJSON,
  sha256Hex,
  shouldSample,
  type DecisionWire,
} from './decisionSample.js';

export type { DecisionWire };

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
const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;

function assertBatchShape(body: DecisionBatchWire): void {
  if (!body || typeof body !== 'object') {
    throw new AppError(CODES.BAD_REQUEST, 'Missing batch body');
  }
  if (!body.batch_id || !UUID_RE.test(body.batch_id)) {
    throw new AppError(CODES.BAD_REQUEST, 'batch_id must be a UUID');
  }
  if (!body.payload_hash || !SHA256_HEX_RE.test(body.payload_hash)) {
    throw new AppError(CODES.BAD_REQUEST, 'payload_hash must be a 64-char sha256 hex digest');
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
    try {
      assertRFC3339(d.decided_at);
    } catch {
      throw new AppError(CODES.BAD_REQUEST, 'decided_at must be RFC3339 with timezone');
    }
  }

  const computedHash = sha256Hex(canonicalizeDecisionsJSON(body.decisions));
  if (computedHash !== body.payload_hash.toLowerCase()) {
    throw new AppError(CODES.BAD_REQUEST, 'payload_hash does not match decisions');
  }
  const expectedBatchID = batchIDFromPayloadHash(computedHash);
  if (body.batch_id.toLowerCase() !== expectedBatchID) {
    throw new AppError(CODES.BAD_REQUEST, 'batch_id does not match payload_hash');
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

type AggRow = {
  bucket: string;
  kind: string;
  value: string;
  action: string;
  count: number;
};

function bumpAgg(
  map: Map<string, AggRow>,
  bucket: Date,
  kind: string,
  value: string,
  action: string
): void {
  const b = bucket.toISOString();
  const key = `${b}\0${kind}\0${value}\0${action}`;
  const cur = map.get(key);
  if (cur) {
    cur.count += 1;
    return;
  }
  map.set(key, { bucket: b, kind, value, action, count: 1 });
}

async function insertAggregates(
  client: pg.PoolClient,
  tenantId: string,
  edgeNodeId: string,
  rows: AggRow[]
): Promise<void> {
  if (rows.length === 0) return;
  await client.query(
    `INSERT INTO decision_aggregates
       (tenant_id, edge_node_id, bucket_minute, dimension_kind, dimension_value, action, count)
     SELECT $1, $2, x.bucket_minute::timestamptz, x.dimension_kind, x.dimension_value, x.action, x.cnt
     FROM UNNEST($3::text[], $4::text[], $5::text[], $6::text[], $7::int[])
       AS x(bucket_minute, dimension_kind, dimension_value, action, cnt)
     ON CONFLICT (tenant_id, edge_node_id, bucket_minute, dimension_kind, dimension_value, action)
     DO UPDATE SET count = decision_aggregates.count + EXCLUDED.count`,
    [
      tenantId,
      edgeNodeId,
      rows.map((r) => r.bucket),
      rows.map((r) => r.kind),
      rows.map((r) => r.value),
      rows.map((r) => r.action),
      rows.map((r) => r.count),
    ]
  );
}

async function insertSamples(
  client: pg.PoolClient,
  tenantId: string,
  edgeNodeId: string,
  samples: DecisionWire[]
): Promise<void> {
  if (samples.length === 0) return;
  await client.query(
    `INSERT INTO decision_samples
       (tenant_id, edge_node_id, wal_seq, fingerprint, principal_id, score, blacklisted,
        score_reason, action, decided_at)
     SELECT $1, $2, x.wal_seq, x.fingerprint, NULLIF(x.principal_id, ''), x.score, x.blacklisted,
            NULLIF(x.score_reason, ''), x.action, x.decided_at::timestamptz
     FROM UNNEST(
       $3::bigint[], $4::text[], $5::text[], $6::int[], $7::boolean[], $8::text[], $9::text[], $10::text[]
     ) AS x(wal_seq, fingerprint, principal_id, score, blacklisted, score_reason, action, decided_at)
     ON CONFLICT (edge_node_id, wal_seq) DO NOTHING`,
    [
      tenantId,
      edgeNodeId,
      samples.map((d) => d.wal_seq),
      samples.map((d) => d.fingerprint),
      samples.map((d) => d.principal_id ?? ''),
      samples.map((d) => d.score ?? 0),
      samples.map((d) => d.blacklisted ?? false),
      samples.map((d) => d.score_reason ?? ''),
      samples.map((d) => d.action),
      samples.map((d) => d.decided_at),
    ]
  );
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
  const payloadHash = opts.body.payload_hash.toLowerCase();

  const edgeNodeId = await resolveEdgeNodeForApiKey(opts.tenantId, opts.apiKeyId);
  const existing = await pool.query(
    `SELECT payload_hash FROM decision_batches WHERE edge_node_id = $1 AND batch_id = $2`,
    [edgeNodeId, opts.body.batch_id]
  );
  if (existing.rows.length > 0) {
    if (String(existing.rows[0].payload_hash).toLowerCase() === payloadHash) {
      return { duplicate: true, edge_node_id: edgeNodeId, accepted: 0, sampled: 0 };
    }
    throw new AppError(CODES.CONFLICT, 'batch_id reused with different payload_hash');
  }

  const sampleRate = await loadSampleRate(opts.tenantId);
  const aggMap = new Map<string, AggRow>();
  const samples: DecisionWire[] = [];
  for (const d of opts.body.decisions) {
    const bucket = minuteBucket(d.decided_at);
    bumpAgg(aggMap, bucket, 'all', '', d.action);
    bumpAgg(aggMap, bucket, 'fingerprint', d.fingerprint, d.action);
    if (d.principal_id) {
      bumpAgg(aggMap, bucket, 'principal', d.principal_id, d.action);
    }
    if (shouldSample(d.action, d.decided_at, sampleRate)) {
      samples.push(d);
    }
  }

  const client = await pool.connect();
  let began = false;
  try {
    await client.query('BEGIN');
    began = true;
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
        payloadHash,
      ]
    );
    await insertAggregates(client, opts.tenantId, edgeNodeId, [...aggMap.values()]);
    await insertSamples(client, opts.tenantId, edgeNodeId, samples);
    await client.query('COMMIT');
  } catch (err) {
    if (began) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback errors; connection will be discarded by release
      }
    }
    if ((err as { code?: string }).code === '23505') {
      const again = await pool.query(
        `SELECT payload_hash FROM decision_batches WHERE edge_node_id = $1 AND batch_id = $2`,
        [edgeNodeId, opts.body.batch_id]
      );
      if (
        again.rows.length > 0 &&
        String(again.rows[0].payload_hash).toLowerCase() === payloadHash
      ) {
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
    sampled: samples.length,
  };
}
