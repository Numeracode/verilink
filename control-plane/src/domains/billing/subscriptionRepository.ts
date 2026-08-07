// control-plane/src/domains/billing/subscriptionRepository.ts
import { pool } from '../../db/client.js';

export interface Subscription {
  id: string;
  tenant_id: string;
  stripe_customer_id: string;
  stripe_subscription_id: string;
  plan: string;
  status: string;
  current_period_end: Date | null;
  created_at: Date;
}

export async function getSubscriptionByTenant(
  tenantId: string
): Promise<Subscription | null> {
  const { rows } = await pool.query(
    `SELECT * FROM subscriptions WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [tenantId]
  );
  return (rows[0] as Subscription | undefined) ?? null;
}

/** Idempotent upsert keyed on (tenant_id, stripe_subscription_id). */
export async function upsertSubscription(opts: {
  tenantId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  plan: string;
  status: string;
  currentPeriodEnd: Date | null;
}): Promise<Subscription> {
  const { rows } = await pool.query(
    `INSERT INTO subscriptions
       (tenant_id, stripe_customer_id, stripe_subscription_id, plan, status, current_period_end)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (tenant_id, stripe_subscription_id)
     DO UPDATE SET
       stripe_customer_id = EXCLUDED.stripe_customer_id,
       plan = EXCLUDED.plan,
       status = EXCLUDED.status,
       current_period_end = EXCLUDED.current_period_end
     RETURNING *`,
    [
      opts.tenantId,
      opts.stripeCustomerId,
      opts.stripeSubscriptionId,
      opts.plan,
      opts.status,
      opts.currentPeriodEnd,
    ]
  );
  return rows[0] as Subscription;
}
