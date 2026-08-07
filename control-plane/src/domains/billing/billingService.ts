// control-plane/src/domains/billing/billingService.ts
import type Stripe from 'stripe';
import { AppError, CODES } from '../../shared/errors/AppError.js';
import { config } from '../../config.js';
import { billingTransport } from './billingTransport.js';
import { getTier, isPaidTier } from './tiers.js';
import * as subRepo from './subscriptionRepository.js';
import { claimWebhookEvent, markWebhookProcessed } from './webhookDedup.js';

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
  const successUrl = process.env.WEB_APP_URL
    ? `${process.env.WEB_APP_URL}/provider?billing=success`
    : `/provider?billing=success`;
  const cancelUrl = process.env.WEB_APP_URL
    ? `${process.env.WEB_APP_URL}/provider?billing=cancelled`
    : `/provider?billing=cancelled`;

  const { url } = await billingTransport.createCheckoutSession({
    customerEmail: opts.customerEmail,
    priceId: tier.priceId,
    successUrl,
    cancelUrl,
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
  const returnUrl = process.env.WEB_APP_URL
    ? `${process.env.WEB_APP_URL}/provider`
    : '/provider';
  const { url } = await billingTransport.createPortalSession({
    customerId: subscription.stripe_customer_id,
    returnUrl,
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

  // Idempotent dedup — a replay of the same event id is a no-op.
  const claimed = await claimWebhookEvent(event.id, event as unknown as Record<string, unknown>);
  if (!claimed) {
    return { eventId: event.id, processed: false };
  }

  try {
    await applyEvent(event);
    await markWebhookProcessed(event.id);
  } catch (err) {
    // Leave the event un-processed so a retry can re-attempt; do not swallow.
    throw err;
  }

  return { eventId: event.id, processed: true };
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
        stripeCustomerId: typeof session.customer === 'string' ? session.customer : session.customer.id,
        stripeSubscriptionId: subscriptionId,
        plan: session.metadata?.plan ?? 'pro',
        status: 'active',
        currentPeriodEnd: null,
      });
      break;
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      const tenantId = (sub.metadata?.tenant_id as string | undefined) ?? null;
      if (!tenantId) break;
      const periodEnd = sub.current_period_end
        ? new Date(sub.current_period_end * 1000)
        : null;
      await subRepo.upsertSubscription({
        tenantId,
        stripeCustomerId: typeof sub.customer === 'string' ? sub.customer : sub.customer.id,
        stripeSubscriptionId: sub.id,
        plan: sub.metadata?.plan ?? 'pro',
        status: event.type === 'customer.subscription.deleted' ? 'canceled' : sub.status,
        currentPeriodEnd: periodEnd,
      });
      break;
    }
    default:
      break;
  }
}
