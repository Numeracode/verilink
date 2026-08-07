// control-plane/src/domains/policy/policyRepository.ts
import { pool, withTransaction } from '../../db/transaction.js';
import { appendEventWithClient } from '../sync/syncRepository.js';
import type pg from 'pg';

export interface Policy {
  id: string;
  tenant_id: string;
  name: string;
  threshold: number;
  below_threshold_action: string;
  unsigned_action: string;
  allow_fingerprints: string[];
  deny_fingerprints: string[];
  fail_open_expired: boolean;
  no_drop_decisions: boolean;
  max_snapshot_age_seconds: number;
  allow_sample_rate: number;
  is_active: boolean;
  created_at: Date;
}

const POLICY_COLS = `id, tenant_id, name, threshold, below_threshold_action, unsigned_action,
            allow_fingerprints, deny_fingerprints, fail_open_expired, no_drop_decisions,
            max_snapshot_age_seconds, allow_sample_rate::float AS allow_sample_rate,
            is_active, created_at`;

/** Active policy for a tenant (at most one row via partial unique index). */
export async function getActivePolicy(tenantId: string): Promise<Policy | null> {
  const { rows } = await pool.query(
    `SELECT ${POLICY_COLS} FROM policies WHERE tenant_id = $1 AND is_active = true`,
    [tenantId]
  );
  return (rows[0] as Policy | undefined) ?? null;
}

export interface PolicyUpdate {
  threshold: number;
  below_threshold_action: string;
  unsigned_action: string;
  allow_fingerprints: string[];
  deny_fingerprints: string[];
  fail_open_expired: boolean;
  no_drop_decisions: boolean;
  max_snapshot_age_seconds: number;
  allow_sample_rate: number;
}

/**
 * Create-or-replace the tenant's active policy and emit a `policy.replace`
 * sync event in one transaction so edges pull the new policy over SSE.
 * The active policy is always named `default` (one active policy per tenant
 * via the partial unique index `active_policy_per_tenant`).
 */
export async function replaceActivePolicy(
  tenantId: string,
  update: PolicyUpdate
): Promise<{ policy: Policy; syncVersion: number }> {
  return withTransaction(async (client: pg.PoolClient) => {
    const { rows } = await client.query(
      `INSERT INTO policies
         (tenant_id, name, threshold, below_threshold_action, unsigned_action,
          allow_fingerprints, deny_fingerprints, fail_open_expired, no_drop_decisions,
          max_snapshot_age_seconds, allow_sample_rate, is_active)
       VALUES ($1, 'default', $2, $3, $4, $5, $6, $7, $8, $9, $10, true)
       ON CONFLICT (tenant_id) WHERE is_active
       DO UPDATE SET
         threshold = EXCLUDED.threshold,
         below_threshold_action = EXCLUDED.below_threshold_action,
         unsigned_action = EXCLUDED.unsigned_action,
         allow_fingerprints = EXCLUDED.allow_fingerprints,
         deny_fingerprints = EXCLUDED.deny_fingerprints,
         fail_open_expired = EXCLUDED.fail_open_expired,
         no_drop_decisions = EXCLUDED.no_drop_decisions,
         max_snapshot_age_seconds = EXCLUDED.max_snapshot_age_seconds,
         allow_sample_rate = EXCLUDED.allow_sample_rate
       RETURNING ${POLICY_COLS}`,
      [
        tenantId,
        update.threshold,
        update.below_threshold_action,
        update.unsigned_action,
        update.allow_fingerprints,
        update.deny_fingerprints,
        update.fail_open_expired,
        update.no_drop_decisions,
        update.max_snapshot_age_seconds,
        update.allow_sample_rate,
      ]
    );
    const policy = rows[0] as Policy;

    // Edges must not serve a stale policy — emit within the same transaction.
    const syncVersion = await appendEventWithClient(
      client,
      'policy.replace',
      {
        tenant_id: tenantId,
        policy: {
          threshold: policy.threshold,
          below_threshold_action: policy.below_threshold_action,
          unsigned_action: policy.unsigned_action,
          allow_fingerprints: policy.allow_fingerprints,
          deny_fingerprints: policy.deny_fingerprints,
          fail_open_expired: policy.fail_open_expired,
          no_drop_decisions: policy.no_drop_decisions,
          max_snapshot_age_seconds: policy.max_snapshot_age_seconds,
          allow_sample_rate: policy.allow_sample_rate,
        },
      },
      { tenantId }
    );

    return { policy, syncVersion };
  });
}
