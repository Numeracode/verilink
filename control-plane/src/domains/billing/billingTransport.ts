// control-plane/src/domains/billing/billingTransport.ts
import Stripe from 'stripe';
import { config } from '../../config.js';

/** Stripe surface the control plane needs. Stubbed in tests; no live Stripe. */
export interface BillingTransport {
  createCheckoutSession(opts: {
    customerEmail?: string;
    priceId: string;
    successUrl: string;
    cancelUrl: string;
    metadata?: Record<string, string>;
  }): Promise<{ url: string; customerId: string }>;

  createPortalSession(opts: { customerId: string; returnUrl: string }): Promise<{ url: string }>;

  /** Verify + parse a webhook event from the raw body. */
  constructEvent(rawBody: Buffer, signature: string): Promise<Stripe.Event>;
}

class StripeBillingTransport implements BillingTransport {
  private client: Stripe;

  constructor(secretKey: string) {
    this.client = new Stripe(secretKey);
  }

  async createCheckoutSession(opts: {
    customerEmail?: string;
    priceId: string;
    successUrl: string;
    cancelUrl: string;
    metadata?: Record<string, string>;
  }): Promise<{ url: string; customerId: string }> {
    const session = await this.client.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: opts.priceId, quantity: 1 }],
      customer_email: opts.customerEmail,
      success_url: opts.successUrl,
      cancel_url: opts.cancelUrl,
      metadata: opts.metadata,
    });
    return { url: session.url!, customerId: (session.customer as string) ?? '' };
  }

  async createPortalSession(opts: { customerId: string; returnUrl: string }): Promise<{ url: string }> {
    const session = await this.client.billingPortal.sessions.create({
      customer: opts.customerId,
      return_url: opts.returnUrl,
    });
    return { url: session.url };
  }

  async constructEvent(rawBody: Buffer, signature: string): Promise<Stripe.Event> {
    return this.client.webhooks.constructEvent(
      rawBody,
      signature,
      config.stripe.webhookSecret || ''
    );
  }
}

/** Deterministic transport used in tests (and dev without a Stripe key). */
export class StubBillingTransport implements BillingTransport {
  private events: Stripe.Event[] = [];

  async createCheckoutSession(opts: {
    customerEmail?: string;
    priceId: string;
    metadata?: Record<string, string>;
  }): Promise<{ url: string; customerId: string }> {
    const customerId = `cus_stub_${Buffer.from(opts.priceId).toString('hex').slice(0, 12)}`;
    return { url: `https://stub.example/checkout?price=${encodeURIComponent(opts.priceId)}`, customerId };
  }

  async createPortalSession(opts: { customerId: string }): Promise<{ url: string }> {
    return { url: `https://stub.example/portal?customer=${encodeURIComponent(opts.customerId)}` };
  }

  async constructEvent(rawBody: Buffer, _signature: string): Promise<Stripe.Event> {
    // No signature verification in the stub — tests post signed-or-unsigned
    // events directly. The handler decides whether to require a signature.
    const json = JSON.parse(rawBody.toString('utf8')) as Stripe.Event;
    return json;
  }
}

export function createBillingTransport(): BillingTransport {
  if (config.stripe.secretKey) {
    return new StripeBillingTransport(config.stripe.secretKey);
  }
  return new StubBillingTransport();
}

export let billingTransport: BillingTransport = createBillingTransport();

/** Test hook: override the live transport (ESM live binding). */
export function setBillingTransport(t: BillingTransport): void {
  billingTransport = t;
}
