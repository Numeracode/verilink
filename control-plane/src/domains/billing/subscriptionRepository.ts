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

/** Active subscriptions first, then newest — the portal wants a live one. */
export async function getSubscriptionByTenant(
  tenantId: string
): Promise<Subscription | null> {
  const { rows } = await pool.query(
    `SELECT * FROM subscriptions
     WHERE tenant_id = $1
     ORDER BY (status = 'active') DESC, created_at DESC
     LIMIT 1`,
    [tenantId]
  );
  return (rows[0] as Subscription | undefined) ?? null;
}

export async function getSubscriptionByStripeId(
  stripeSubscriptionId: string
): Promise<Subscription | null> {
  const { rows } = await pool.query(
    `SELECT * FROM subscriptions WHERE stripe_subscription_id = $1 LIMIT 1`,
    [stripeSubscriptionId]
  );
  return (rows[0] as Subscription | undefined) ?? null;
}

export interface UpsertSubscriptionOpts {
  tenantId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  plan: string;
  status: string;
  currentPeriodEnd: Date | null;
  /** When true (checkout path), a late event must not clobber a newer update's
   * status/period — leave those columns untouched on conflict. */
  preserveOnConflict?: boolean;
}

/** Idempotent upsert keyed on (tenant_id, stripe_subscription_id). */
export async function upsertSubscription(opts: UpsertSubscriptionOpts): Promise<Subscription> {
  const onConflict = opts.preserveOnConflict
    ? `DO UPDATE SET
         stripe_customer_id = EXCLUDED.stripe_customer_id,
         plan = EXCLUDED.plan`
    : `DO UPDATE SET
         stripe_customer_id = EXCLUDED.stripe_customer_id,
         plan = EXCLUDED.plan,
         status = EXCLUDED.status,
         current_period_end = EXCLUDED.current_period_end`;
  const { rows } = await pool.query(
    `INSERT INTO subscriptions
       (tenant_id, stripe_customer_id, stripe_subscription_id, plan, status, current_period_end)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (tenant_id, stripe_subscription_id)
     ${onConflict}
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
