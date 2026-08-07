// control-plane/src/domains/billing/billingService.ts
import type Stripe from 'stripe';
import { AppError, CODES } from '../../shared/errors/AppError.js';
import { config } from '../../config.js';
import { billingTransport } from './billingTransport.js';
import { getTier, getTierByPriceId, isPaidTier } from './tiers.js';
import * as subRepo from './subscriptionRepository.js';
import { claimWebhookEvent, markWebhookProcessed } from './webhookDedup.js';

/** Absolute base URL for Stripe redirects (Stripe rejects relative URLs). */
function webAppUrl(): string {
  const base = process.env.WEB_APP_URL;
  if (!base) {
    throw new AppError(
      CODES.SERVICE_UNAVAILABLE,
      'WEB_APP_URL is not configured (required for Stripe redirects)'
    );
  }
  return base.replace(/\/$/, '');
}

export async function createCheckoutSession(opts: {
  tenantId: string;
  tierId: string;
  customerEmail?: string;
}): Promise<{ url: string }> {
  const tier = getTier(opts.tierId);
  if (!tier) {
    throw new AppError(CODES.BAD_REQUEST, `Unknown tier: ${opts.tierId}`);
  }
  if (!isPaidTier(tier) || !tier.priceId) {
    throw new AppError(CODES.BAD_REQUEST, `Tier "${tier.id}" has no Stripe price configured`);
  }
  const base = webAppUrl();
  const { url } = await billingTransport.createCheckoutSession({
    customerEmail: opts.customerEmail,
    priceId: tier.priceId,
    successUrl: `${base}/provider?billing=success`,
    cancelUrl: `${base}/provider?billing=cancelled`,
    metadata: { tenant_id: opts.tenantId, plan: tier.id },
  });
  return { url };
}

export async function createPortalSession(opts: {
  tenantId: string;
}): Promise<{ url: string }> {
  const subscription = await subRepo.getSubscriptionByTenant(opts.tenantId);
  if (!subscription) {
    throw new AppError(CODES.NOT_FOUND, 'No subscription for tenant');
  }
  const base = webAppUrl();
  const { url } = await billingTransport.createPortalSession({
    customerId: subscription.stripe_customer_id,
    returnUrl: `${base}/provider`,
  });
  return { url };
}

/**
 * Verify (when a webhook secret is configured), dedup by event id, and persist
 * subscription state. Returns the event id and whether it was newly processed.
 */
export async function handleWebhookEvent(
  rawBody: Buffer,
  signature: string | undefined
): Promise<{ eventId: string; processed: boolean }> {
  if (config.stripe.webhookSecret) {
    if (!signature) {
      throw new AppError(CODES.UNAUTHORIZED, 'Missing Stripe signature');
    }
  } else if (config.server.nodeEnv === 'production') {
    // Decision 7: refuse unsigned webhooks in production config.
    throw new AppError(CODES.UNAUTHORIZED, 'Stripe webhook secret not configured');
  }

  const event = await billingTransport.constructEvent(rawBody, signature || '');

  // Idempotent dedup — an already-processed event is a no-op; an event that
  // failed before being marked processed is reclaimable.
  const claimed = await claimWebhookEvent(event.id, event as unknown as Record<string, unknown>);
  if (!claimed) {
    return { eventId: event.id, processed: false };
  }

  await applyEvent(event);
  await markWebhookProcessed(event.id);

  return { eventId: event.id, processed: true };
}

/** Resolve a tier id from a Stripe Price id, falling back to "unknown". */
function resolvePlan(priceId: string | undefined, metadataPlan: string | undefined): string {
  if (metadataPlan) return metadataPlan;
  if (priceId) {
    const tier = getTierByPriceId(priceId);
    if (tier) return tier.id;
  }
  return 'unknown';
}

async function applyEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const tenantId = (session.metadata?.tenant_id as string | undefined) ?? null;
      const subscriptionId = (session.subscription as string | null) ?? null;
      if (!tenantId || !subscriptionId || !session.customer) {
        break;
      }
      await subRepo.upsertSubscription({
        tenantId,
        stripeCustomerId:
          typeof session.customer === 'string' ? session.customer : session.customer.id,
        stripeSubscriptionId: subscriptionId,
        plan: resolvePlan(undefined, session.metadata?.plan),
        status: 'active',
        currentPeriodEnd: null,
        preserveOnConflict: true, // a late checkout event must not clobber a newer update
      });
      break;
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      // Prefer metadata; fall back to the stored subscription row by sub id so
      // metadata-free events (e.g. deletions created outside our checkout) still resolve.
      let tenantId = (sub.metadata?.tenant_id as string | undefined) ?? null;
      if (!tenantId) {
        const existing = await subRepo.getSubscriptionByStripeId(sub.id);
        tenantId = existing?.tenant_id ?? null;
      }
      if (!tenantId) break;
      const periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000) : null;
      await subRepo.upsertSubscription({
        tenantId,
        stripeCustomerId:
          typeof sub.customer === 'string' ? sub.customer : sub.customer.id,
        stripeSubscriptionId: sub.id,
        plan: resolvePlan(undefined, sub.metadata?.plan),
        status: event.type === 'customer.subscription.deleted' ? 'canceled' : sub.status,
        currentPeriodEnd: periodEnd,
      });
      break;
    }
    default:
      break;
  }
}
