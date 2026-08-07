// control-plane/src/domains/billing/tiers.ts

export interface Tier {
  id: string;
  name: string;
  /** Stripe Price id; null for the free tier or when no price is configured. */
  priceId: string | null;
}

/**
 * Fixed-tier subscriptions only (Plan 9 Decision 7). Paid-tier Stripe Price
 * ids are wired through env so the binary is environment-portable; the free
 * tier never bills. Missing price ids make a paid tier un-checkoutable
 * (the route returns a clear 400) rather than failing against a live API.
 */
export const TIERS: readonly Tier[] = [
  { id: 'free', name: 'Free', priceId: null },
  { id: 'pro', name: 'Pro', priceId: process.env.STRIPE_PRICE_PRO ?? null },
  { id: 'enterprise', name: 'Enterprise', priceId: process.env.STRIPE_PRICE_ENTERPRISE ?? null },
];

export function getTier(id: string): Tier | undefined {
  return TIERS.find((t) => t.id === id);
}

/** Reverse-lookup a tier from a Stripe Price id (for webhook plan resolution). */
export function getTierByPriceId(priceId: string): Tier | undefined {
  return TIERS.find((t) => t.priceId === priceId);
}

export function isPaidTier(tier: Tier): boolean {
  return tier.priceId !== null;
}
