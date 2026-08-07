// control-plane/src/routes/billing.ts
import { Router } from 'express';
import { ok } from '../shared/http/responses.js';
import { defineHandler } from '../shared/http/defineHandler.js';
import { authMiddleware } from '../middleware/auth.js';
import { AppError, CODES } from '../shared/errors/AppError.js';
import * as billingService from '../domains/billing/billingService.js';

const router = Router();
router.use(authMiddleware);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function requireTenant(req: { user?: { tenantId?: string | null } }): string {
  const tenantId = req.user?.tenantId;
  if (!tenantId) throw new AppError(CODES.FORBIDDEN, 'Tenant required');
  return tenantId;
}

/** POST /v1/billing/checkout-session — start a Stripe checkout for a paid tier. */
router.post(
  '/checkout-session',
  defineHandler({
    async handler(req, res) {
      const tenantId = requireTenant(req);
      const { tier, customer_email } = req.body as { tier?: string; customer_email?: unknown };
      if (!tier || typeof tier !== 'string') {
        throw new AppError(CODES.BAD_REQUEST, 'tier is required');
      }
      if (customer_email !== undefined && customer_email !== null) {
        if (typeof customer_email !== 'string' || !EMAIL_RE.test(customer_email)) {
          throw new AppError(CODES.BAD_REQUEST, 'customer_email must be a valid email address');
        }
      }
      const { url } = await billingService.createCheckoutSession({
        tenantId,
        tierId: tier,
        customerEmail: customer_email ?? undefined,
      });
      ok(res, { url });
    },
  })
);

/** POST /v1/billing/portal-session — open the Stripe customer portal. */
router.post(
  '/portal-session',
  defineHandler({
    async handler(req, res) {
      const tenantId = requireTenant(req);
      const { url } = await billingService.createPortalSession({ tenantId });
      ok(res, { url });
    },
  })
);

export default router;
