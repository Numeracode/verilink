// control-plane/src/routes/policies.ts
import { Router } from 'express';
import { ok } from '../shared/http/responses.js';
import { defineHandler } from '../shared/http/defineHandler.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireScope } from '../middleware/requireScope.js';
import { AppError, CODES } from '../shared/errors/AppError.js';
import * as policyRepo from '../domains/policy/policyRepository.js';
import { parsePolicyUpdate } from '../domains/policy/policyValidation.js';

const router = Router();
router.use(authMiddleware);

function requireTenant(req: { user?: { tenantId?: string | null } }): string {
  const tenantId = req.user?.tenantId;
  if (!tenantId) throw new AppError(CODES.FORBIDDEN, 'Tenant required');
  return tenantId;
}

/** GET /v1/policies/active — active policy for the caller's tenant. */
router.get(
  '/active',
  defineHandler({
    async handler(req, res) {
      const tenantId = requireTenant(req);
      const policy = await policyRepo.getActivePolicy(tenantId);
      if (!policy) {
        throw new AppError(CODES.NOT_FOUND, 'No active policy for tenant');
      }
      ok(res, { policy });
    },
  })
);

/**
 * PUT /v1/policies/active — create-or-replace the active policy (policy:admin /
 * tenant admin role). Emits a `policy.replace` sync event so edges pull the
 * new policy over SSE instead of serving a stale snapshot.
 */
router.put(
  '/active',
  requireScope('policy:admin'),
  defineHandler({
    async handler(req, res) {
      const tenantId = requireTenant(req);
      const update = parsePolicyUpdate(req.body);
      const { policy, syncVersion } = await policyRepo.replaceActivePolicy(tenantId, update);
      ok(res, { policy, sync_version: syncVersion });
    },
  })
);

export default router;
