// control-plane/src/routes/webhookStripe.ts
import { Router } from 'express';
import { ok } from '../shared/http/responses.js';
import { AppError, CODES } from '../shared/errors/AppError.js';
import * as billingService from '../domains/billing/billingService.js';

const router = Router();

/**
 * POST /webhooks/stripe — must be mounted with express.raw (before the json
 * parser) so the signature covers the exact bytes. Signature verification is
 * mandatory when STRIPE_WEBHOOK_SECRET is set; unsigned webhooks are refused
 * in production config (Decision 7).
 */
router.post('/', async (req, res) => {
  const rawBody = req.body;
  if (!Buffer.isBuffer(rawBody)) {
    return res
      .status(400)
      .json({ ok: false, error: { code: CODES.BAD_REQUEST, message: 'Webhook requires a raw body' } });
  }
  const signature = req.get('stripe-signature') ?? undefined;
  try {
    const result = await billingService.handleWebhookEvent(rawBody, signature);
    ok(res, result);
  } catch (err) {
    const appErr = AppError.from(err);
    return res.status(appErr.status).json(appErr.toResponse());
  }
});

export default router;
