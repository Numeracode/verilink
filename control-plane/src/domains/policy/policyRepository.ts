// control-plane/src/domains/policy/policyRepository.ts
import { pool } from '../../db/client.js';

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

/** Active policy for a tenant (at most one row via partial unique index). */
export async function getActivePolicy(tenantId: string): Promise<Policy | null> {
  const { rows } = await pool.query(
    `SELECT id, tenant_id, name, threshold, below_threshold_action, unsigned_action,
            allow_fingerprints, deny_fingerprints, fail_open_expired, no_drop_decisions,
            max_snapshot_age_seconds, allow_sample_rate::float AS allow_sample_rate,
            is_active, created_at
     FROM policies
     WHERE tenant_id = $1 AND is_active = true`,
    [tenantId]
  );
  return (rows[0] as Policy | undefined) ?? null;
}
