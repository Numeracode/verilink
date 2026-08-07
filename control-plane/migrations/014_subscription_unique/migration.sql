-- control-plane/migrations/014_subscription_unique/migration.sql

-- Plan 9 PR D: a tenant's Stripe subscription must converge to one row
-- across webhook events (checkout.session.completed + customer.subscription.*).
-- The stripe_subscription_id is globally unique per Stripe subscription, and
-- a tenant holds one subscription at a time, so (tenant_id, stripe_subscription_id)
-- is the natural idempotency key for upserts.
CREATE UNIQUE INDEX subscription_tenant_stripe_unique
  ON subscriptions (tenant_id, stripe_subscription_id);
