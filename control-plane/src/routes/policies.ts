// control-plane/src/routes/policies.ts
import { Router } from 'express';
import { ok } from '../shared/http/responses.js';
import { defineHandler } from '../shared/http/defineHandler.js';
import { authMiddleware } from '../middleware/auth.js';
import { AppError, CODES } from '../shared/errors/AppError.js';
import * as policyRepo from '../domains/policy/policyRepository.js';

const router = Router();
router.use(authMiddleware);

/**
 * GET /v1/policies/active — active policy for the caller's tenant.
 * (PUT lands in Plan 9 PR C with policy.replace sync events.)
 */
router.get(
  '/active',
  defineHandler({
    async handler(req, res) {
      const tenantId = req.user?.tenantId;
      if (!tenantId) {
        throw new AppError(CODES.FORBIDDEN, 'Tenant required');
      }
      const policy = await policyRepo.getActivePolicy(tenantId);
      if (!policy) {
        throw new AppError(CODES.NOT_FOUND, 'No active policy for tenant');
      }
      ok(res, { policy });
    },
  })
);

export default router;
